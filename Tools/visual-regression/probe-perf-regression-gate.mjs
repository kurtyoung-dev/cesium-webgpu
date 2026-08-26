#!/usr/bin/env node
// C11-170 — acquire and adjudicate the re-upload/churn regression signals.
// @purpose Runs the four performance diagnostics sequentially and detects the measured resource-write/churn regression class without making a certification claim.
// @status ACTIVE
//
// A missing report or required scalar is blindness. The sole exception is the
// backend probe's `contexts.byKind` sparse tally: that producer creates a bucket
// only after the first call of that kind and explicitly publishes a missing
// `webgl` bucket as zero calls. The exception is fenced below by a live WebGPU
// census and by agreement with the producer's own Q1 verdict; it applies to no
// other field in this gate.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import {
  S5_STATUS_EXIT_CODES as EXIT_CODE,
  exitCodeForS5Status,
  exitCodeForS5StatusOrStructural,
} from "./lib/verdict-exit-gate.mjs";
import {
  assertEvidenceReadableOrAbsent,
  fingerprintEvidenceFile,
  preserveFirstRedEvidence,
  safeGitHead,
} from "./lib/build-source-identity.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPOSITORY_ROOT = path.resolve(__dirname, "../..");
const BASE = "http://localhost:8080";
const PREFLIGHT_URL = `${BASE}/Apps/CesiumViewer/index.html`;
const PREFLIGHT_BUDGET_MS = 15_000;
const PROBE_CHILD_BUDGET_MS = 420_000;
const CHILD_KILL_GRACE_MS = 5_000;
const GATE_WATCHDOG_MS = 1_800_000;

const OUTPUT_DIRECTORY = path.join(__dirname, "output", "performance");
const OUTPUT_PATH = path.join(
  OUTPUT_DIRECTORY,
  "c11-170-perf-regression-gate.json",
);
const FIRST_RED_OUTPUT_PATH = path.join(
  OUTPUT_DIRECTORY,
  "c11-170-perf-regression-gate.first-red.json",
);

// The derivation baseline is CHECKED IN and read-only. It deliberately does not
// live under `output/`: that tree is gitignored, is rewritten by every run, and
// on 2026-08-25 an acquire run overwrote the four banked reports the frozen bars
// were derived from, re-basing the gate's own negative controls. Baseline inputs
// and live outputs are now separate trees, and `assertBaselineIsolation` below
// refuses to let them become the same one again.
const BASELINE_DIRECTORY = path.join(__dirname, "fixtures", "c11-170");
const BASELINE_FIXTURE_PATH = path.join(
  BASELINE_DIRECTORY,
  "perf-gate-derivation-baseline.json",
);

const CLAIM_NOTE =
  "The C11-169 inputs are explicitly noncausal, noncertifying, and make no FPS, GPU, or uninstrumented performance claim. This gate detects the re-upload/churn class; it certifies nothing. A PASS is not evidence that WebGPU is fast, that GPU time is unchanged, or that any uninstrumented workload improved.";

const REPORT_DEFINITIONS = Object.freeze({
  backend: Object.freeze({
    key: "backend",
    path: path.join(
      REPOSITORY_ROOT,
      "Tools/visual-regression/output/backend-isolation-report.json",
    ),
    relativePath:
      "Tools/visual-regression/output/backend-isolation-report.json",
    timestampField: "date",
  }),
  request: Object.freeze({
    key: "request",
    path: path.join(
      REPOSITORY_ROOT,
      "Tools/visual-regression/output/request-render-asymmetry-report.json",
    ),
    relativePath:
      "Tools/visual-regression/output/request-render-asymmetry-report.json",
    timestampField: "date",
  }),
  cpu: Object.freeze({
    key: "cpu",
    path: path.join(
      REPOSITORY_ROOT,
      "Tools/visual-regression/output/cpu-sampling-profile.json",
    ),
    relativePath: "Tools/visual-regression/output/cpu-sampling-profile.json",
    timestampField: "date",
  }),
  frame: Object.freeze({
    key: "frame",
    path: path.join(
      REPOSITORY_ROOT,
      "Tools/visual-regression/output/performance/c11-169-whole-frame-phase-attribution.json",
    ),
    relativePath:
      "Tools/visual-regression/output/performance/c11-169-whole-frame-phase-attribution.json",
    timestampField: "generatedAt",
  }),
});

// Three of the four children boot Apps/CesiumViewer against Ion World Terrain,
// so their tile count -- and therefore the `writeBuffer` volume Signal A reads
// as a share of self time -- moves with the network. That is a live confound on
// a frozen bar, so the gate pins those three to the viewer's deterministic
// offline scene. The fourth already pins `offline=true` in its own URL. Unset,
// the environment key changes nothing for any other consumer of these probes.
const OFFLINE_ENV_KEY = "PROBE_VIEWER_OFFLINE";

const ACQUISITION_DEFINITIONS = Object.freeze([
  Object.freeze({
    probe: "probe-backend-isolation.mjs",
    reportKey: "backend",
    argv: Object.freeze([]),
    legacyDiagnosticExit: true,
    offlinePin: "gate-env",
    offlinePinNote:
      "both CesiumViewer solo lanes are pinned; the split-screen lane has no offline mode and is not adjudicated by this gate",
  }),
  Object.freeze({
    probe: "probe-request-render-asymmetry.mjs",
    reportKey: "request",
    argv: Object.freeze([]),
    legacyDiagnosticExit: true,
    offlinePin: "gate-env",
  }),
  Object.freeze({
    probe: "probe-cpu-sampling-profile.mjs",
    reportKey: "cpu",
    // The banked visibility floor came from a 120-frame profile. The probe's
    // 150-frame default would silently change the instrument that supplies A.
    argv: Object.freeze(["--frames", "120"]),
    legacyDiagnosticExit: true,
    offlinePin: "gate-env",
  }),
  Object.freeze({
    probe: "probe-webgpu-frame-breakdown.mjs",
    reportKey: "frame",
    argv: Object.freeze([]),
    legacyDiagnosticExit: false,
    offlinePin: "self",
    offlinePinNote:
      "this probe already requests offline=true in its own scene URL, so the gate adds nothing",
  }),
]);

const ACQUISITION_ORDER = Object.freeze(
  ACQUISITION_DEFINITIONS.map((entry) => entry.probe),
);

// Every path this gate is allowed to write, and every path its children are
// expected to rewrite. Anything not on this list is somebody else's evidence.
export const LIVE_WRITE_PATHS = Object.freeze([
  OUTPUT_PATH,
  FIRST_RED_OUTPUT_PATH,
  ...Object.values(REPORT_DEFINITIONS).map((definition) => definition.path),
]);

function isInside(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

/**
 * Enumerate every way a live-run path and the read-only baseline could be the
 * same file or nest inside one another. Returns an empty array when the two
 * trees are disjoint.
 *
 * @returns {string[]} One sentence per collision, empty when isolated.
 */
export function baselineCollisions() {
  const baselineDirectory = path.resolve(BASELINE_DIRECTORY);
  const baselineFixture = path.resolve(BASELINE_FIXTURE_PATH);
  const outputDirectory = path.resolve(OUTPUT_DIRECTORY);
  const collisions = [];
  if (outputDirectory === baselineDirectory) {
    collisions.push(
      `the live output directory and the baseline directory are the same path ${outputDirectory}`,
    );
  }
  if (isInside(outputDirectory, baselineDirectory)) {
    collisions.push(
      `the baseline directory ${baselineDirectory} is inside the live output directory ${outputDirectory}`,
    );
  }
  if (isInside(baselineDirectory, outputDirectory)) {
    collisions.push(
      `the live output directory ${outputDirectory} is inside the baseline directory ${baselineDirectory}`,
    );
  }
  for (const livePath of LIVE_WRITE_PATHS) {
    const resolved = path.resolve(livePath);
    if (resolved === baselineFixture) {
      collisions.push(`live write target ${resolved} IS the baseline fixture`);
    }
    if (isInside(baselineDirectory, resolved)) {
      collisions.push(
        `live write target ${resolved} resolves inside the baseline directory ${baselineDirectory}`,
      );
    }
    if (isInside(path.resolve(path.dirname(resolved)), baselineFixture)) {
      collisions.push(
        `the baseline fixture resolves inside the live write directory ${path.dirname(resolved)}`,
      );
    }
  }
  return collisions;
}

/**
 * Refuse to run at all when a live-run path and a baseline path can collide.
 * This is the structural half of the 2026-08-25 repair: the convention that
 * baselines were not to be overwritten is what failed, so the gate now cannot
 * start unless the two trees are provably disjoint.
 */
export function assertBaselineIsolation() {
  const collisions = baselineCollisions();
  if (collisions.length > 0) {
    throw new RangeError(
      `baseline/live path collision: ${collisions.join("; ")}`,
    );
  }
}

/**
 * Refuse to write anywhere the gate has not declared as a live-run output.
 *
 * @param {string} target Absolute path the caller intends to write.
 */
export function assertLiveWriteTarget(target) {
  const resolved = path.resolve(target);
  const permitted = LIVE_WRITE_PATHS.some(
    (livePath) => path.resolve(livePath) === resolved,
  );
  if (!permitted) {
    throw new RangeError(
      `refusing to write ${resolved}: not a declared live-run output of this gate`,
    );
  }
}

export const RESOURCE_WRITE_FAMILY = Object.freeze([
  "copyExternalImageToTexture",
  "writeTexture",
  "writeBuffer",
  "copyBufferToTexture",
  "copyTextureToTexture",
  "createTexture",
  "createBuffer",
  "texImage2D",
  "texSubImage2D",
  "texImage3D",
  "texSubImage3D",
  "compressedTexImage2D",
  "compressedTexSubImage2D",
  "texStorage2D",
  "bufferData",
  "bufferSubData",
  "uploadImageSource",
]);

const SIGNAL_E_OBSERVATIONS = Object.freeze([
  Object.freeze({
    source: "backend-isolation.verdicts.webgpu_over_webgl_render_ms_ratio",
    value: 1.857,
    subject: true,
  }),
  Object.freeze({
    source: "request-render-asymmetry.verdict.honest_render_ms.ratio",
    value: 1.5,
    subject: true,
  }),
  // The V8 sampler perturbs absolute timing on both legs. Its ratio is useful
  // only to derive the frozen backstop; it is never a live subject. The two
  // judged ratios remain admissible because same-run machine and scene cost
  // largely cancel, and they still claim CPU wall-clock—not GPU time or FPS.
  Object.freeze({
    source: "cpu-sampling-profile.webgpu.medianRenderMs / webgl.medianRenderMs",
    value: 1.2,
    subject: false,
    note: "derivation-only because the V8 sampler perturbs both absolute timings; their ratio is the least-perturbed statistic available from that run",
  }),
]);

export const PERF_GATE_BARS = Object.freeze({
  signalA: Object.freeze({
    maxPctExclusive: 0.193,
    comparator: "<",
    derivation:
      "0.193 is the smallest published pct in the banked WebGPU top-20 list: _createWaterOceanMaterialBindGroupInner (index 18) and the final cutoff row (garbage collector, index 19) are tied. A family member at or above that visibility floor has entered the published fleet.",
    sourceRows: Object.freeze([
      "webgpuTopSelfTime[18]._createWaterOceanMaterialBindGroupInner = 0.193",
      "webgpuTopSelfTime[19].(garbage collector) = 0.193",
    ]),
  }),
  ruleOfThree: Object.freeze({
    numerator: 3,
    comparator: "<",
    derivation:
      "The banked event count was 0 in n trials; the 95% Rule-of-Three upper bound is 3/n, with n read from each report.",
  }),
  signalD: Object.freeze({
    requiredWebglNonNull: 0,
    comparator: "===",
    derivation:
      "The banked WebGPU-solo census observed zero live WebGL contexts. No statistical margin applies because addInitScript instruments getContext before page code, making this a census rather than a sample.",
  }),
  signalE: Object.freeze({
    maxRatioInclusive: 2.8737075,
    comparator: "<=",
    observations: SIGNAL_E_OBSERVATIONS,
    spread: 1.5475,
    derivation:
      "max(1.857, 1.5, 1.2) * (max/min) = 1.857 * (1.857 / 1.2) = 2.8737075. Both judged ratios compare same-machine, same-run, same-scene CPU wall-clock around scene.render(); this is neither GPU time nor FPS.",
  }),
  signalF: Object.freeze({
    comparator: "canonical-status-passthrough",
    derivation:
      "The C11-169 report is already an exact per-frame conservation gate; its published status is mapped only through the frozen verdict helper.",
  }),
});

const KNOWN_BLIND_SPOTS = Object.freeze([
  Object.freeze({
    signal: "G",
    reasons: Object.freeze([
      "probe-webgpu-frame-breakdown.mjs collects console text through attachConsoleErrorGate, whose filter is /validation|not compatible|incompatible|GPUValidationError|out of memory|device(?: was)? lost|popErrorScope|createRenderPipeline|createBindGroup|Attachment state/i; the sentinel text matches none of it.",
      "probe-backend-isolation.mjs retains consoleErrors.slice(0, 6), and both banked solo lanes already contain six unrelated RequestErrorEvent / net::ERR_NETWORK_ACCESS_DENIED entries, so later sentinel text can be truncated.",
      "probe-cpu-sampling-profile.mjs and probe-request-render-asymmetry.mjs attach no page-console listener at all.",
    ]),
  }),
]);

/**
 * Re-derive every frozen bar from the reports it claims to have been derived
 * from, and name each disagreement. This is the runner's own statement of what
 * each constant MEANS, so the check can be mutated the way any other predicate
 * can; the spec supplies the immutable baseline fixture as `reports`.
 *
 * It is deliberately a pure function of (reports, bars, family): it reads no
 * file, so it can never be satisfied by whatever a run happened to leave on
 * disk.
 *
 * @param {object} reports The four banked producer reports.
 * @param {object} [bars] Bar table to check, defaulting to the frozen one.
 * @param {string[]} [family] Resource-write family, defaulting to the frozen one.
 * @returns {string[]} One sentence per disagreement, empty when every bar holds.
 */
export function derivationViolations(
  reports,
  bars = PERF_GATE_BARS,
  family = RESOURCE_WRITE_FAMILY,
) {
  const violations = [];

  // A: the bar is the smallest pct the profile publishes -- its visibility floor.
  const publishedPcts = reports.cpu.webgpuTopSelfTime.map((row) => row.pct);
  const minPublished = Math.min(...publishedPcts);
  if (bars.signalA.maxPctExclusive !== minPublished) {
    violations.push(
      `A: bar ${bars.signalA.maxPctExclusive} is not the profile's smallest published pct ${minPublished}`,
    );
  }
  // A: the Batch-717 culprit must remain a family member by name.
  if (!family.includes("copyExternalImageToTexture")) {
    violations.push(
      "A: copyExternalImageToTexture left the resource-write family",
    );
  }

  // B/C: at the banked trial count the bound must reject the third event and
  // tolerate the second -- the Rule-of-Three shape, checked behaviourally.
  const n = reports.request.webgpu.laneA.pendingForegroundSeries.length;
  const bound = bars.ruleOfThree.numerator / n;
  if (!(2 / n < bound)) {
    violations.push(
      `B/C: the bound ${bound} at n=${n} does not tolerate the second event`,
    );
  }
  if (3 / n < bound) {
    violations.push(
      `B/C: the bound ${bound} at n=${n} does not reject the third event`,
    );
  }

  // E: the frozen observations must still be the banked measurements, and the
  // bar must still be max(subjects) scaled by the observed spread.
  const observed = bars.signalE.observations.map((entry) => entry.value);
  const banked = [
    reports.backend.verdicts.webgpu_over_webgl_render_ms_ratio,
    reports.request.verdict.honest_render_ms.ratio,
    reports.cpu.webgpu.medianRenderMs / reports.cpu.webgl.medianRenderMs,
  ];
  if (
    observed.length !== banked.length ||
    observed.some((value, index) => value !== banked[index])
  ) {
    violations.push(
      `E: frozen observations ${JSON.stringify(observed)} are not the banked measurements ${JSON.stringify(banked)}`,
    );
  }
  const subjects = bars.signalE.observations
    .filter((entry) => entry.subject)
    .map((entry) => entry.value);
  const derived =
    Math.max(...subjects) * (Math.max(...observed) / Math.min(...observed));
  if (bars.signalE.maxRatioInclusive !== derived) {
    violations.push(
      `E: bar ${bars.signalE.maxRatioInclusive} is not max(subjects) scaled by the observed spread ${derived}`,
    );
  }

  // D: the census bar is zero because the instrument is a census, not a sample.
  if (bars.signalD.requiredWebglNonNull !== 0) {
    violations.push(
      `D: the census bar is ${bars.signalD.requiredWebglNonNull}, not zero`,
    );
  }

  return violations;
}

export function ruleOfThreeBound(n) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new RangeError(
      `ruleOfThreeBound requires a positive integer n, got ${n}`,
    );
  }
  return PERF_GATE_BARS.ruleOfThree.numerator / n;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFiniteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function signalResult({
  id,
  probe,
  fieldPaths,
  observed = null,
  bar = null,
  comparator = null,
  verdict,
  reason,
  structuralSubreasons = [],
}) {
  return {
    id,
    probe,
    fieldPaths,
    observed,
    bar,
    comparator,
    verdict,
    reason,
    ...(structuralSubreasons.length > 0 ? { structuralSubreasons } : {}),
  };
}

function structuralSignal(id, probe, fieldPaths, reason) {
  return signalResult({
    id,
    probe,
    fieldPaths,
    verdict: "STRUCTURAL",
    reason,
  });
}

function reportProblem(input, key) {
  const explicit = input?.reportProblems?.[key];
  if (Array.isArray(explicit) && explicit.length > 0) {
    return explicit.map(String).join("; ");
  }
  const report = input?.reports?.[key];
  if (!isPlainObject(report) || Object.keys(report).length === 0) {
    return `${key} report is missing, unreadable, or empty`;
  }
  if (input?.mode === "acquire" && input?.freshness?.[key]?.fresh !== true) {
    const reasons = input?.freshness?.[key]?.reasons;
    return `${key} report freshness was not proved${
      Array.isArray(reasons) && reasons.length > 0
        ? `: ${reasons.join("; ")}`
        : ""
    }`;
  }
  return null;
}

function functionNameComponent(fn) {
  return fn.split(" @ ", 1)[0];
}

function adjudicateSignalA(input, backend) {
  const id = `A-${backend}`;
  const listField = `${backend}TopSelfTime`;
  const fieldPaths = [`${listField}[]{fn,pct}`, `${backend}.error`];
  const problem = reportProblem(input, "cpu");
  if (problem) {
    return structuralSignal(
      id,
      "probe-cpu-sampling-profile.mjs",
      fieldPaths,
      problem,
    );
  }

  const report = input.reports.cpu;
  const lane = report[backend];
  if (!isPlainObject(lane)) {
    return structuralSignal(
      id,
      "probe-cpu-sampling-profile.mjs",
      fieldPaths,
      `${backend} profile summary is absent`,
    );
  }
  if (Object.hasOwn(lane, "error")) {
    return structuralSignal(
      id,
      "probe-cpu-sampling-profile.mjs",
      fieldPaths,
      `${backend} profile carries an error field: ${String(lane.error)}`,
    );
  }
  const rows = report[listField];
  if (!Array.isArray(rows) || rows.length === 0) {
    return structuralSignal(
      id,
      "probe-cpu-sampling-profile.mjs",
      fieldPaths,
      `${listField} is absent or empty; a profile with no published rows saw nothing`,
    );
  }
  for (const [index, row] of rows.entries()) {
    if (
      !isPlainObject(row) ||
      typeof row.fn !== "string" ||
      !isFiniteNonNegative(row.pct)
    ) {
      return structuralSignal(
        id,
        "probe-cpu-sampling-profile.mjs",
        fieldPaths,
        `${listField}[${index}] lacks a string fn or finite non-negative pct`,
      );
    }
  }

  const family = new Set(RESOURCE_WRITE_FAMILY);
  const matches = rows.filter((row) =>
    family.has(functionNameComponent(row.fn)),
  );
  const observed = matches.reduce((sum, row) => sum + row.pct, 0);
  const pass = observed < PERF_GATE_BARS.signalA.maxPctExclusive;
  return signalResult({
    id,
    probe: "probe-cpu-sampling-profile.mjs",
    fieldPaths,
    observed,
    bar: PERF_GATE_BARS.signalA.maxPctExclusive,
    comparator: PERF_GATE_BARS.signalA.comparator,
    verdict: pass ? "PASS" : "FAIL",
    reason: pass
      ? `${backend} resource-write family share ${observed} is below the ${PERF_GATE_BARS.signalA.maxPctExclusive} visibility floor`
      : `${backend} resource-write family share ${observed} reached the ${PERF_GATE_BARS.signalA.maxPctExclusive} visibility floor`,
  });
}

function validRequestLane(report, backend) {
  const lane = report?.[backend];
  if (!isPlainObject(lane)) {
    return { reason: `${backend} lane is absent` };
  }
  // Lane A is assigned before Lane B. A later Lane-B exception leaves these
  // counters complete even though the sibling lane summary carries `error`;
  // E-2 independently rejects the resulting null honest-render ratio.
  if (!isPlainObject(lane.laneA)) {
    return { reason: `${backend}.laneA is absent` };
  }
  return { lane: lane.laneA };
}

function adjudicateSignalB(input) {
  const fieldPaths = [
    "webgpu.laneA.pendingForegroundNonZeroFrames",
    "webgpu.laneA.pendingForegroundSeries.length",
    "webgpu.laneA.asyncResourcesPresent",
  ];
  const problem = reportProblem(input, "request");
  if (problem) {
    return structuralSignal(
      "B",
      "probe-request-render-asymmetry.mjs",
      fieldPaths,
      problem,
    );
  }
  const checked = validRequestLane(input.reports.request, "webgpu");
  if (!checked.lane) {
    return structuralSignal(
      "B",
      "probe-request-render-asymmetry.mjs",
      fieldPaths,
      checked.reason,
    );
  }
  const lane = checked.lane;
  if (lane.asyncResourcesPresent !== true) {
    return structuralSignal(
      "B",
      "probe-request-render-asymmetry.mjs",
      fieldPaths,
      "asyncResourcesPresent is not true, so the producer calls the hypothesis N/A",
    );
  }
  const series = lane.pendingForegroundSeries;
  const nonZero = lane.pendingForegroundNonZeroFrames;
  if (
    !Array.isArray(series) ||
    series.length === 0 ||
    !Number.isInteger(nonZero) ||
    nonZero < 0 ||
    nonZero > series.length
  ) {
    return structuralSignal(
      "B",
      "probe-request-render-asymmetry.mjs",
      fieldPaths,
      "pendingForegroundSeries or its computed non-zero count is malformed",
    );
  }
  const n = series.length;
  const rate = nonZero / n;
  const bound = ruleOfThreeBound(n);
  const pass = rate < bound;
  return signalResult({
    id: "B",
    probe: "probe-request-render-asymmetry.mjs",
    fieldPaths,
    observed: { nonZero, n, rate },
    bar: bound,
    comparator: PERF_GATE_BARS.ruleOfThree.comparator,
    verdict: pass ? "PASS" : "FAIL",
    reason: `${nonZero}/${n} = ${rate}; Rule-of-Three bound is ${PERF_GATE_BARS.ruleOfThree.numerator}/${n} = ${bound}`,
  });
}

function adjudicateSignalC(input) {
  const fieldPaths = [
    "webgpu.laneA.renderRequestedFrames",
    "webgl.laneA.renderRequestedFrames",
    "webgpu.laneA.pendingForegroundSeries.length",
    "webgl.laneA.pendingForegroundSeries.length",
  ];
  const problem = reportProblem(input, "request");
  if (problem) {
    return structuralSignal(
      "C",
      "probe-request-render-asymmetry.mjs",
      fieldPaths,
      problem,
    );
  }
  const observed = {};
  const bars = {};
  const structuralSubreasons = [];
  for (const backend of ["webgpu", "webgl"]) {
    const checked = validRequestLane(input.reports.request, backend);
    if (!checked.lane) {
      structuralSubreasons.push(checked.reason);
      continue;
    }
    const series = checked.lane.pendingForegroundSeries;
    if (!Array.isArray(series) || series.length === 0) {
      structuralSubreasons.push(
        `${backend}.laneA.pendingForegroundSeries is absent or empty`,
      );
      continue;
    }
    const n = series.length;
    const count = checked.lane.renderRequestedFrames;
    if (!Number.isInteger(count) || count < 0 || count > n) {
      structuralSubreasons.push(
        `${backend}.laneA.renderRequestedFrames is malformed`,
      );
      continue;
    }
    const bound = ruleOfThreeBound(n);
    observed[backend] = { count, n, rate: count / n };
    bars[backend] = bound;
  }
  if (
    observed.webgpu &&
    observed.webgl &&
    observed.webgpu.n !== observed.webgl.n
  ) {
    structuralSubreasons.push(
      "webgpu and webgl laneA series have different trial counts",
    );
  }
  const failed = Object.entries(observed).filter(
    ([backend, value]) => !(value.rate < bars[backend]),
  );
  const measured = signalResult({
    id: "C",
    probe: "probe-request-render-asymmetry.mjs",
    fieldPaths,
    observed,
    bar: bars,
    comparator: "each rate < 3/n",
    verdict: failed.length === 0 ? "PASS" : "FAIL",
    reason:
      failed.length === 0
        ? "every readable render-request rate is below its Rule-of-Three bound"
        : `${failed.map(([name]) => name).join(" and ")} render-request churn reached its Rule-of-Three bound`,
    structuralSubreasons,
  });
  if (failed.length > 0) {
    return measured;
  }
  if (structuralSubreasons.length > 0) {
    return {
      ...measured,
      verdict: "STRUCTURAL",
      reason: structuralSubreasons.join("; "),
    };
  }
  return measured;
}

function adjudicateSignalD(input) {
  const fieldPaths = [
    "lanes[name=webgpu-solo].ok",
    "lanes[name=webgpu-solo].contexts.totalGetContextCalls",
    "lanes[name=webgpu-solo].contexts.byKind.webgpu.nonNull",
    "lanes[name=webgpu-solo].contexts.byKind.webgl.{count,nonNull}",
    "verdicts.Q1_webgl_running_in_webgpu_mode",
  ];
  const problem = reportProblem(input, "backend");
  if (problem) {
    return structuralSignal(
      "D",
      "probe-backend-isolation.mjs",
      fieldPaths,
      problem,
    );
  }
  const report = input.reports.backend;
  if (!Array.isArray(report.lanes)) {
    return structuralSignal(
      "D",
      "probe-backend-isolation.mjs",
      fieldPaths,
      "lanes container is absent",
    );
  }
  const lane = report.lanes.find((entry) => entry?.name === "webgpu-solo");
  if (!isPlainObject(lane) || lane.ok !== true) {
    return structuralSignal(
      "D",
      "probe-backend-isolation.mjs",
      fieldPaths,
      "a live ok:true webgpu-solo lane is absent",
    );
  }
  const contexts = lane.contexts;
  if (
    !isPlainObject(contexts) ||
    !Number.isInteger(contexts.totalGetContextCalls) ||
    contexts.totalGetContextCalls < 1 ||
    !isPlainObject(contexts.byKind)
  ) {
    return structuralSignal(
      "D",
      "probe-backend-isolation.mjs",
      fieldPaths,
      "the getContext census container is absent or did not observe any calls",
    );
  }
  const webgpu = contexts.byKind.webgpu;
  if (
    !isPlainObject(webgpu) ||
    !Number.isInteger(webgpu.nonNull) ||
    webgpu.nonNull < 1
  ) {
    return structuralSignal(
      "D",
      "probe-backend-isolation.mjs",
      fieldPaths,
      "the webgpu-solo census did not observe a live WebGPU context",
    );
  }

  const webgl = contexts.byKind.webgl;
  if (webgl !== undefined && !isPlainObject(webgl)) {
    return structuralSignal(
      "D",
      "probe-backend-isolation.mjs",
      fieldPaths,
      "the sparse WebGL census bucket is malformed",
    );
  }
  if (
    webgl !== undefined &&
    (!Number.isInteger(webgl.count) ||
      webgl.count < 0 ||
      !Number.isInteger(webgl.nonNull) ||
      webgl.nonNull < 0 ||
      webgl.nonNull > webgl.count)
  ) {
    return structuralSignal(
      "D",
      "probe-backend-isolation.mjs",
      fieldPaths,
      "the sparse WebGL census scalars are absent or inconsistent",
    );
  }

  // The producer creates sparse buckets on first observation and explicitly
  // publishes `!gl` as zero calls (probe-backend-isolation.mjs:160-167,
  // 271-273), so these `?? 0` reads are positive census measurements.
  const webglNonNull = webgl?.nonNull ?? 0;
  const webglCount = webgl?.count ?? 0;
  const q1 = report.verdicts?.Q1_webgl_running_in_webgpu_mode;
  if (typeof q1 !== "string") {
    return structuralSignal(
      "D",
      "probe-backend-isolation.mjs",
      fieldPaths,
      "the producer's Q1 census verdict is absent",
    );
  }
  const requiredPrefix =
    webglCount === 0
      ? "NO — "
      : webglNonNull === 0
        ? "ATTEMPTED-BUT-NULL — "
        : "YES — ";
  if (!q1.startsWith(requiredPrefix)) {
    return structuralSignal(
      "D",
      "probe-backend-isolation.mjs",
      fieldPaths,
      `numeric census requires Q1 prefix ${JSON.stringify(requiredPrefix)}, got ${JSON.stringify(q1)}`,
    );
  }

  // addInitScript wraps getContext before page code executes, so this is a
  // census rather than a sample; unlike B/C, D therefore has no margin.
  const pass = webglNonNull === PERF_GATE_BARS.signalD.requiredWebglNonNull;
  return signalResult({
    id: "D",
    probe: "probe-backend-isolation.mjs",
    fieldPaths,
    observed: {
      totalGetContextCalls: contexts.totalGetContextCalls,
      webgpuNonNull: webgpu.nonNull,
      webglCount,
      webglNonNull,
      sparseWebglBucketAbsent: webgl === undefined,
      attemptedButNull: webglCount > 0 && webglNonNull === 0,
      producerQ1: q1,
    },
    bar: PERF_GATE_BARS.signalD.requiredWebglNonNull,
    comparator: PERF_GATE_BARS.signalD.comparator,
    verdict: pass ? "PASS" : "FAIL",
    reason: pass
      ? "the live WebGPU census observed no live WebGL context"
      : `the live WebGPU census observed ${webglNonNull} live WebGL context(s)`,
  });
}

function adjudicateSignalE(input, subject) {
  const backendSubject = subject === "backend";
  const id = backendSubject ? "E-1" : "E-2";
  const reportKey = backendSubject ? "backend" : "request";
  const probe = backendSubject
    ? "probe-backend-isolation.mjs"
    : "probe-request-render-asymmetry.mjs";
  const fieldPath = backendSubject
    ? "verdicts.webgpu_over_webgl_render_ms_ratio"
    : "verdict.honest_render_ms.ratio";
  const problem = reportProblem(input, reportKey);
  if (problem) {
    return structuralSignal(id, probe, [fieldPath], problem);
  }
  const report = input.reports[reportKey];
  const ratio = backendSubject
    ? report.verdicts?.webgpu_over_webgl_render_ms_ratio
    : report.verdict?.honest_render_ms?.ratio;
  if (!isFiniteNonNegative(ratio)) {
    return structuralSignal(
      id,
      probe,
      [fieldPath],
      `${fieldPath} is null, absent, or non-numeric`,
    );
  }
  const pass = ratio <= PERF_GATE_BARS.signalE.maxRatioInclusive;
  return signalResult({
    id,
    probe,
    fieldPaths: [fieldPath],
    observed: ratio,
    bar: PERF_GATE_BARS.signalE.maxRatioInclusive,
    comparator: PERF_GATE_BARS.signalE.comparator,
    verdict: pass ? "PASS" : "FAIL",
    reason: `${ratio} ${pass ? "is within" : "exceeds"} the same-run CPU wall-clock ratio backstop`,
  });
}

function coverageRatioMaximum(report) {
  const records = report?.route?.frameRecords;
  if (!Array.isArray(records) || records.length === 0) {
    return { reason: "route.frameRecords is absent or empty" };
  }
  const ratios = [];
  for (const [index, record] of records.entries()) {
    if (!isPlainObject(record) || !isFiniteNonNegative(record.coverageRatio)) {
      return {
        reason: `route.frameRecords[${index}].coverageRatio is absent or non-numeric`,
      };
    }
    ratios.push(record.coverageRatio);
  }
  return { value: Math.max(...ratios) };
}

function adjudicateSignalF(input) {
  const fieldPaths = [
    "status",
    "exitCode",
    "pass",
    "incomplete",
    "failures",
    "setup.profiler.available",
  ];
  const problem = reportProblem(input, "frame");
  if (problem) {
    return structuralSignal(
      "F",
      "probe-webgpu-frame-breakdown.mjs",
      fieldPaths,
      problem,
    );
  }
  const report = input.reports.frame;
  if (typeof report.status !== "string") {
    return structuralSignal(
      "F",
      "probe-webgpu-frame-breakdown.mjs",
      fieldPaths,
      "the frame gate's published status is absent",
    );
  }
  // RUNNING receives no local exception: it is absent from the frozen table,
  // so the canonical untrusted-artifact reader maps the placeholder to 3.
  const mapped = exitCodeForS5StatusOrStructural(report.status);
  if (mapped === EXIT_CODE.ERROR) {
    return signalResult({
      id: "F",
      probe: "probe-webgpu-frame-breakdown.mjs",
      fieldPaths,
      observed: { status: report.status },
      bar: PERF_GATE_BARS.signalF.comparator,
      comparator: PERF_GATE_BARS.signalF.comparator,
      verdict: "ERROR",
      reason: `published status ${JSON.stringify(report.status)} maps canonically to harness ERROR`,
    });
  }
  if (mapped === EXIT_CODE.STRUCTURAL) {
    return signalResult({
      id: "F",
      probe: "probe-webgpu-frame-breakdown.mjs",
      fieldPaths,
      observed: { status: report.status },
      bar: PERF_GATE_BARS.signalF.comparator,
      comparator: PERF_GATE_BARS.signalF.comparator,
      verdict: "STRUCTURAL",
      reason: `published status ${JSON.stringify(report.status)} maps canonically to STRUCTURAL`,
    });
  }

  let schemaProblem = null;
  if (
    !Number.isInteger(report.exitCode) ||
    typeof report.pass !== "boolean" ||
    typeof report.incomplete !== "boolean" ||
    !Array.isArray(report.failures) ||
    typeof report.setup?.profiler?.available !== "boolean"
  ) {
    schemaProblem =
      "the frame gate's required published verdict fields are absent or malformed";
  }
  if (!schemaProblem && report.exitCode !== mapped) {
    schemaProblem = `published exitCode ${report.exitCode} disagrees with canonical status exit ${mapped}`;
  }
  if (!schemaProblem && report.pass !== (mapped === EXIT_CODE.PASS)) {
    schemaProblem = `published pass ${report.pass} disagrees with status ${report.status}`;
  }
  if (!schemaProblem && report.incomplete !== false) {
    schemaProblem =
      "a final PASS/FAIL frame verdict is still marked incomplete";
  }
  if (schemaProblem) {
    return structuralSignal(
      "F",
      "probe-webgpu-frame-breakdown.mjs",
      fieldPaths,
      schemaProblem,
    );
  }

  const verdict = mapped === EXIT_CODE.PASS ? "PASS" : "FAIL";
  return signalResult({
    id: "F",
    probe: "probe-webgpu-frame-breakdown.mjs",
    fieldPaths,
    observed: {
      status: report.status,
      exitCode: report.exitCode,
      pass: report.pass,
      incomplete: report.incomplete,
      failureCount: Array.isArray(report.failures)
        ? report.failures.length
        : null,
      profilerAvailable: report.setup?.profiler?.available ?? null,
    },
    bar: PERF_GATE_BARS.signalF.comparator,
    comparator: PERF_GATE_BARS.signalF.comparator,
    verdict,
    reason: `published status ${JSON.stringify(report.status)} maps canonically to exit ${mapped}`,
  });
}

function consoleEvidence(input, source) {
  const messages = [];
  const problems = [];
  if (source === "backend") {
    const backendLanes = input?.reports?.backend?.lanes;
    if (!Array.isArray(backendLanes)) {
      problems.push("backend-isolation.lanes is absent or malformed");
    } else {
      for (const [index, lane] of backendLanes.entries()) {
        if (!Array.isArray(lane?.consoleErrors)) {
          problems.push(
            `backend-isolation.lanes[${index}].consoleErrors is absent or malformed`,
          );
          continue;
        }
        if (lane.consoleErrors.some((value) => typeof value !== "string")) {
          problems.push(
            `backend-isolation.lanes[${index}].consoleErrors contains a non-string entry`,
          );
        }
        messages.push(
          ...lane.consoleErrors.filter((value) => typeof value === "string"),
        );
      }
    }
  } else {
    const frameErrors = input?.reports?.frame?.errors;
    for (const key of ["console", "page"]) {
      if (!Array.isArray(frameErrors?.[key])) {
        problems.push(`whole-frame.errors.${key} is absent or malformed`);
        continue;
      }
      if (frameErrors[key].some((value) => typeof value !== "string")) {
        problems.push(`whole-frame.errors.${key} contains a non-string entry`);
      }
      messages.push(
        ...frameErrors[key].filter((value) => typeof value === "string"),
      );
    }
  }
  return { messages, problems };
}

function adjudicateSignalG(input) {
  const entries = [];
  const problems = [];
  const trustedSources = new Set();
  for (const source of ["backend", "frame"]) {
    const evidence = consoleEvidence(input, source);
    entries.push(...evidence.messages.map((message) => ({ source, message })));
    problems.push(
      ...evidence.problems.map((problem) => `${source}: ${problem}`),
    );
    const sourceProblem = reportProblem(input, source);
    if (sourceProblem) {
      problems.push(`${source}: ${sourceProblem}`);
    } else {
      trustedSources.add(source);
    }
  }
  // Every present array is scanned, but acquire-mode freshness controls which
  // positive has standing; a fresh hit still outranks blindness in its sibling.
  const allMatches = entries.filter(({ message }) =>
    message.includes("RE-UPLOAD STORM"),
  );
  const matches = allMatches
    .filter(({ source }) => trustedSources.has(source))
    .map(({ message }) => message);
  const untrustedMatches = allMatches
    .filter(({ source }) => !trustedSources.has(source))
    .map(({ message }) => message);
  const fieldPaths = [
    "backend-isolation.lanes[].consoleErrors",
    "whole-frame.errors.console",
    "whole-frame.errors.page",
  ];
  if (matches.length === 0 && problems.length > 0) {
    return signalResult({
      id: "G",
      probe: "probe-backend-isolation.mjs + probe-webgpu-frame-breakdown.mjs",
      fieldPaths,
      observed: {
        scannedMessages: entries.length,
        matches,
        untrustedMatches,
      },
      verdict: "STRUCTURAL",
      reason: problems.join("; "),
    });
  }
  return signalResult({
    id: "G",
    probe: "probe-backend-isolation.mjs + probe-webgpu-frame-breakdown.mjs",
    fieldPaths,
    observed: { scannedMessages: entries.length, matches, untrustedMatches },
    verdict: matches.length > 0 ? "FAIL" : "NOT-PROVEN",
    reason:
      matches.length > 0
        ? "the permanent in-engine re-upload sentinel fired"
        : "no retained console array contains the sentinel; the declared collection blind spots make absence non-probative",
    structuralSubreasons: problems,
  });
}

function recordedContext(input, signals) {
  const backend = input?.reports?.backend;
  // Coverage restates the C11-169 instrumentation gap; it is recorded even
  // when the frame verdict envelope is incomplete and is never adjudicated.
  const frameCoverage = coverageRatioMaximum(input?.reports?.frame);
  const dSignal = signals.find((signal) => signal.id === "D");
  const webglSolo = Array.isArray(backend?.lanes)
    ? backend.lanes.find((lane) => lane?.name === "webgl-solo")
    : undefined;
  return {
    splitLaneAdjudicated: false,
    consoleErrorsAdjudicated: false,
    coverageRatioMax: frameCoverage.value ?? null,
    q2SplitVsSolo: backend?.verdicts?.Q2_split_vs_solo ?? null,
    laneNotAdjudicated: {
      name: "split",
      reason:
        "the banked split lane is ok:false with Q2_split_vs_solo UNKNOWN; C11-170 judges only the solo subjects",
    },
    webglSolo: webglSolo
      ? {
          ok: webglSolo.ok ?? null,
          webglCount: webglSolo.contexts?.byKind?.webgl?.count ?? null,
          webglNonNull: webglSolo.contexts?.byKind?.webgl?.nonNull ?? null,
        }
      : null,
    backendAttemptedButNull: dSignal?.observed?.attemptedButNull ?? null,
  };
}

export function adjudicatePerfRegressionGate(input) {
  if (input?.mode !== "acquire" && input?.mode !== "adjudicate-only") {
    throw new RangeError(
      `unknown performance-gate mode ${String(input?.mode)}`,
    );
  }

  const signals = [
    adjudicateSignalA(input, "webgpu"),
    adjudicateSignalA(input, "webgl"),
    adjudicateSignalB(input),
    adjudicateSignalC(input),
    adjudicateSignalD(input),
    adjudicateSignalE(input, "backend"),
    adjudicateSignalE(input, "request"),
    adjudicateSignalF(input),
    adjudicateSignalG(input),
  ];

  const harnessErrors = Array.isArray(input.harnessErrors)
    ? input.harnessErrors.map(String)
    : [];
  const structuralReasons = Array.isArray(input.structuralReasons)
    ? input.structuralReasons.map(String)
    : [];
  for (const signal of signals) {
    if (signal.verdict === "STRUCTURAL") {
      structuralReasons.push(`${signal.id}: ${signal.reason}`);
    }
    if (Array.isArray(signal.structuralSubreasons)) {
      structuralReasons.push(
        ...signal.structuralSubreasons.map(
          (reason) => `${signal.id}: ${String(reason)}`,
        ),
      );
    }
  }

  const failed = signals.filter((signal) => signal.verdict === "FAIL");
  const errored = signals.filter((signal) => signal.verdict === "ERROR");
  let status;
  if (harnessErrors.length > 0 || errored.length > 0) {
    status = "ERROR";
  } else if (failed.length > 0) {
    status = "FAIL";
  } else if (structuralReasons.length > 0 || input.mode === "adjudicate-only") {
    status = "STRUCTURAL";
    if (input.mode === "adjudicate-only") {
      structuralReasons.push(
        "adjudicate-only did not acquire its own evidence and therefore cannot produce PASS",
      );
    }
  } else {
    status = "PASS";
  }

  return {
    status,
    exitCode: exitCodeForS5Status(status),
    signals,
    failures: failed.map((signal) => `${signal.id}: ${signal.reason}`),
    structuralReasons,
    harnessErrors,
    knownBlindSpots: KNOWN_BLIND_SPOTS,
    recorded: recordedContext(input, signals),
    bars: PERF_GATE_BARS,
  };
}

function sourceDirty() {
  try {
    return (
      execFileSync("git", ["status", "--porcelain"], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim().length > 0
    );
  } catch {
    return true;
  }
}

function provenance() {
  return {
    head: safeGitHead(REPOSITORY_ROOT) ?? null,
    sourceDirty: sourceDirty(),
    base: BASE,
    baselineFixture: path
      .relative(REPOSITORY_ROOT, BASELINE_FIXTURE_PATH)
      .split(path.sep)
      .join("/"),
    note: "source identity is HEAD plus any unlanded working-tree changes; a dirty tree may not be reported as identity = tip",
  };
}

function claims() {
  return {
    detects:
      "the CPU-visible GPU-resource-write, async non-drain, render-request churn, backend contamination, coarse same-run CPU-ratio, frame-accounting, and retained sentinel signatures of the re-upload/churn defect class",
    certifies: null,
    note: CLAIM_NOTE,
  };
}

function serializeArtifact(artifact) {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

function writeArtifact(artifact, preserveRed) {
  assertLiveWriteTarget(OUTPUT_PATH);
  fs.mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
  const serialized = serializeArtifact(artifact);
  fs.writeFileSync(OUTPUT_PATH, serialized);
  if (preserveRed && artifact.status !== "PASS") {
    assertLiveWriteTarget(FIRST_RED_OUTPUT_PATH);
    preserveFirstRedEvidence(FIRST_RED_OUTPUT_PATH, serialized);
  }
  return serialized;
}

function baseArtifact(context, status, exitCode, incomplete) {
  return {
    probe: "c11-170-perf-regression-gate",
    schemaVersion: 1,
    runId: context.runId,
    generatedAt: new Date().toISOString(),
    mode: context.mode,
    status,
    exitCode,
    incomplete,
    claims: claims(),
    provenance: context.provenance,
    acquisition: context.acquisition,
    signals: [],
    bars: PERF_GATE_BARS,
    knownBlindSpots: KNOWN_BLIND_SPOTS,
    recorded: {
      splitLaneAdjudicated: false,
      consoleErrorsAdjudicated: false,
      coverageRatioMax: null,
      q2SplitVsSolo: null,
    },
    failures: [],
    structuralReasons: [],
  };
}

function finalArtifact(context, adjudication) {
  return {
    ...baseArtifact(context, adjudication.status, adjudication.exitCode, false),
    generatedAt: new Date().toISOString(),
    signals: adjudication.signals,
    bars: adjudication.bars,
    knownBlindSpots: adjudication.knownBlindSpots,
    recorded: adjudication.recorded,
    failures: adjudication.failures,
    structuralReasons: adjudication.structuralReasons,
    ...(adjudication.harnessErrors.length > 0
      ? { errors: adjudication.harnessErrors }
      : {}),
  };
}

function fatalArtifact(context, fatalError) {
  const message = String(fatalError?.stack ?? fatalError);
  return {
    ...baseArtifact(context, "ERROR", exitCodeForS5Status("ERROR"), false),
    failures: [],
    structuralReasons: [],
    errors: [message],
  };
}

async function preflightServer(record, active) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  Object.assign(record, {
    attempted: true,
    url: PREFLIGHT_URL,
    startedAt,
    durationMs: 0,
    ok: null,
    status: null,
    incomplete: true,
  });
  active.preflightRecord = record;
  active.preflightStartMs = start;
  const finish = (result) => {
    Object.assign(record, result, {
      durationMs: Date.now() - start,
      incomplete: false,
    });
    active.preflightRecord = null;
    active.preflightStartMs = null;
    return record;
  };
  try {
    const response = await fetch(PREFLIGHT_URL, {
      signal: AbortSignal.timeout(PREFLIGHT_BUDGET_MS),
    });
    await response.body?.cancel();
    return finish({
      ok: response.ok,
      status: response.status,
      ...(response.ok
        ? {}
        : { error: `preflight returned HTTP ${response.status}` }),
    });
  } catch (error) {
    return finish({
      ok: false,
      status: null,
      error: String(error?.message ?? error),
    });
  }
}

function interruptActiveOperations(active, reason) {
  if (active.preflightRecord) {
    active.preflightRecord.durationMs = Date.now() - active.preflightStartMs;
    active.preflightRecord.error ??= reason;
  }
  if (active.child && active.child.exitCode === null) {
    if (active.childRecord) {
      active.childRecord.killed = true;
      active.childRecord.durationMs = Date.now() - active.childStartMs;
      active.childRecord.error ??= reason;
    }
    active.child.kill();
    active.child.kill("SIGKILL");
  }
}

function spawnProbe(definition, active, acquisition, reportRecord) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const record = {
    probe: definition.probe,
    argv: [definition.probe, ...definition.argv],
    offlinePin: definition.offlinePin,
    ...(definition.offlinePinNote
      ? { offlinePinNote: definition.offlinePinNote }
      : {}),
    startedAt,
    exitCode: null,
    signal: null,
    killed: false,
    durationMs: 0,
    report: reportRecord,
  };
  // The live record is evidence even if the outer watchdog interrupts the
  // await; deferring this push until close would erase the wedged child.
  acquisition.children.push(record);
  return new Promise((resolve) => {
    const probePath = path.join(__dirname, definition.probe);
    const argv = [probePath, ...definition.argv];
    const child = spawn(process.execPath, argv, {
      cwd: REPOSITORY_ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        PROBE_BASE: BASE,
        ...(definition.offlinePin === "gate-env"
          ? { [OFFLINE_ENV_KEY]: "1" }
          : {}),
      },
    });
    active.child = child;
    active.childRecord = record;
    active.childStartMs = start;
    let settled = false;
    let escalationTimer;

    const budgetTimer = setTimeout(() => {
      record.killed = true;
      record.durationMs = Date.now() - start;
      child.kill();
      escalationTimer = setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, CHILD_KILL_GRACE_MS);
    }, PROBE_CHILD_BUDGET_MS);

    const finish = (exitCode, signal, error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(budgetTimer);
      clearTimeout(escalationTimer);
      if (active.child === child) {
        active.child = null;
        active.childRecord = null;
        active.childStartMs = null;
      }
      Object.assign(record, {
        exitCode,
        signal: signal ?? null,
        durationMs: Date.now() - start,
      });
      if (error) {
        record.error = String(error?.message ?? error);
      }
      resolve(record);
    };

    child.once("error", (error) => finish(null, null, error));
    child.once("close", (exitCode, signal) => finish(exitCode, signal, null));
  });
}

function childHarnessError(definition, child) {
  if (child.killed) {
    return `${definition.probe} exceeded ${PROBE_CHILD_BUDGET_MS}ms and was killed`;
  }
  if (child.error) {
    return `${definition.probe} failed to spawn: ${child.error}`;
  }
  if (child.exitCode === null) {
    return `${definition.probe} exited without an exit code`;
  }
  if (definition.legacyDiagnosticExit && child.exitCode !== 0) {
    return `${definition.probe} legacy harness exited ${child.exitCode}`;
  }
  if (child.exitCode === EXIT_CODE.ERROR) {
    return `${definition.probe} reported harness ERROR`;
  }
  if (
    ![EXIT_CODE.PASS, EXIT_CODE.FAIL, EXIT_CODE.STRUCTURAL].includes(
      child.exitCode,
    )
  ) {
    return `${definition.probe} returned unknown exit ${child.exitCode}`;
  }
  return null;
}

function readReport(definition) {
  try {
    const text = fs.readFileSync(definition.path, "utf8");
    return { report: JSON.parse(text), problems: [] };
  } catch (error) {
    return {
      report: undefined,
      problems: [
        `${definition.relativePath}: ${String(error?.message ?? error)}`,
      ],
    };
  }
}

export function evaluateEvidenceFreshness(
  definition,
  before,
  after,
  report,
  gateStartMs,
) {
  const reasons = [];
  // A readable zero-byte *prior* file may be repaired by acquisition, but an
  // unreadable snapshot is not equivalent to ENOENT and cannot prove creation.
  if (before?.exists === false && before.error !== "ENOENT") {
    reasons.push(
      `${definition.relativePath} before integrity is unverifiable: ${String(before.error ?? "invalid fingerprint")}`,
    );
  } else if (before?.exists !== true && before?.exists !== false) {
    reasons.push(`${definition.relativePath} before fingerprint is malformed`);
  }
  try {
    assertEvidenceReadableOrAbsent(after, `${definition.relativePath} after`);
  } catch (error) {
    reasons.push(String(error?.message ?? error));
  }
  const changed =
    before.exists === false && after.exists === true
      ? true
      : before.exists === true &&
        after.exists === true &&
        before.sha256 !== after.sha256;
  if (!changed) {
    reasons.push("sha256 did not change and the file was not newly created");
  }
  const timestamp = report?.[definition.timestampField];
  const timestampMs =
    typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(timestampMs)) {
    reasons.push(
      `in-file ${definition.timestampField} timestamp is absent or invalid`,
    );
  } else if (timestampMs < gateStartMs) {
    reasons.push(
      `in-file ${definition.timestampField} ${timestamp} predates gate start`,
    );
  }
  if (after.exists !== true) {
    reasons.push("report does not exist after the child returned");
  }
  return {
    fresh: reasons.length === 0,
    changed,
    timestamp: typeof timestamp === "string" ? timestamp : null,
    atOrAfterGateStart:
      Number.isFinite(timestampMs) && timestampMs >= gateStartMs,
    reasons,
  };
}

function printSignalTable(artifact) {
  console.log("=== C11-170 performance-regression gate signals ===");
  for (const signal of artifact.signals) {
    console.log(
      `${signal.id}\t${signal.verdict}\tobserved=${JSON.stringify(signal.observed)}\tbar=${JSON.stringify(signal.bar)}\t${signal.reason}`,
    );
  }
  console.log(`FINAL\t${artifact.status}\texit=${artifact.exitCode}`);
  console.log(`[c11-170-perf-gate] CLAIMS ${artifact.claims.note}`);
  if (artifact.status === "PASS") {
    console.log("[c11-170-perf-gate] GATE PASS");
  } else if (artifact.status === "FAIL") {
    console.error("[c11-170-perf-gate] GATE FAIL");
  } else {
    console.error(`[c11-170-perf-gate] GATE ${artifact.status}`);
  }
}

function parseMode(argv) {
  if (argv.length === 0) {
    return "acquire";
  }
  if (argv.length === 1 && argv[0] === "--adjudicate-only") {
    return "adjudicate-only";
  }
  throw new RangeError(`unsupported arguments: ${argv.join(" ")}`);
}

export async function main(argv = process.argv.slice(2)) {
  // Before anything is written: a run that could reach the baseline must not
  // start. Ordering matters -- the first thing acquire mode does is write a
  // RUNNING artifact.
  assertBaselineIsolation();
  const provisionalMode = argv.includes("--adjudicate-only")
    ? "adjudicate-only"
    : "acquire";
  const gateStartMs = Date.now();
  const context = {
    runId: randomUUID(),
    mode: provisionalMode,
    provenance: provenance(),
    acquisition: {
      order: ACQUISITION_ORDER,
      offlinePin: {
        envKey: OFFLINE_ENV_KEY,
        pinned: ACQUISITION_DEFINITIONS.filter(
          (entry) => entry.offlinePin === "gate-env",
        ).map((entry) => entry.probe),
        selfPinned: ACQUISITION_DEFINITIONS.filter(
          (entry) => entry.offlinePin === "self",
        ).map((entry) => entry.probe),
        why: "tile count varies with the network, and Signal A reads a resource-write share of self time against a frozen bar",
      },
      preflight: { attempted: false },
      children: [],
    },
  };
  fs.mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
  writeArtifact(baseArtifact(context, "RUNNING", EXIT_CODE.ERROR, true), false);

  const active = {
    child: null,
    childRecord: null,
    childStartMs: null,
    preflightRecord: null,
    preflightStartMs: null,
  };
  const watchdog = setTimeout(() => {
    const watchdogError = new Error(
      `gate watchdog fired after ${GATE_WATCHDOG_MS}ms`,
    );
    interruptActiveOperations(active, watchdogError.message);
    try {
      writeArtifact(fatalArtifact(context, watchdogError), true);
    } catch (error) {
      console.error("[c11-170-perf-gate] watchdog artifact error", error);
    }
    console.error("[c11-170-perf-gate] watchdog forced termination");
    process.exit(EXIT_CODE.ERROR);
  }, GATE_WATCHDOG_MS);
  watchdog.unref?.();

  try {
    context.mode = parseMode(argv);
    const reports = {};
    const reportProblems = {};
    const freshness = {};
    const harnessErrors = [];
    const structuralReasons = [];

    if (context.mode === "adjudicate-only") {
      context.acquisition.preflight = {
        attempted: false,
        reason: "adjudicate-only mode performs no network or acquisition",
      };
      for (const definition of Object.values(REPORT_DEFINITIONS)) {
        const read = readReport(definition);
        reports[definition.key] = read.report;
        reportProblems[definition.key] = read.problems;
      }
    } else {
      context.acquisition.preflight = {};
      await preflightServer(context.acquisition.preflight, active);
      if (context.acquisition.preflight.ok !== true) {
        structuralReasons.push(
          `dev-server preflight failed: ${String(context.acquisition.preflight.error ?? context.acquisition.preflight.status)}`,
        );
        for (const definition of Object.values(REPORT_DEFINITIONS)) {
          reportProblems[definition.key] = [
            "acquisition was not attempted because dev-server preflight failed",
          ];
        }
      } else {
        for (const definition of ACQUISITION_DEFINITIONS) {
          const reportDefinition = REPORT_DEFINITIONS[definition.reportKey];
          const before = fingerprintEvidenceFile(reportDefinition.path);
          const reportRecord = {
            path: reportDefinition.relativePath,
            before,
            after: null,
            fresh: false,
            changed: false,
            timestamp: null,
            atOrAfterGateStart: false,
            reasons: ["child acquisition has not completed"],
          };
          const child = await spawnProbe(
            definition,
            active,
            context.acquisition,
            reportRecord,
          );
          const after = fingerprintEvidenceFile(reportDefinition.path);
          const read = readReport(reportDefinition);
          reports[reportDefinition.key] = read.report;
          reportProblems[reportDefinition.key] = read.problems;
          freshness[reportDefinition.key] = evaluateEvidenceFreshness(
            reportDefinition,
            before,
            after,
            read.report,
            gateStartMs,
          );
          Object.assign(child.report, {
            after,
            ...freshness[reportDefinition.key],
          });
          const harnessError = childHarnessError(definition, child);
          if (harnessError) {
            harnessErrors.push(harnessError);
          }
        }
      }
    }

    const adjudication = adjudicatePerfRegressionGate({
      mode: context.mode,
      reports,
      reportProblems,
      freshness,
      harnessErrors,
      structuralReasons,
    });
    const artifact = finalArtifact(context, adjudication);
    writeArtifact(artifact, true);
    printSignalTable(artifact);
    process.exitCode = artifact.exitCode;
    return artifact;
  } catch (fatalError) {
    interruptActiveOperations(
      active,
      "fatal gate cleanup interrupted acquisition",
    );
    writeArtifact(fatalArtifact(context, fatalError), true);
    throw fatalError;
  } finally {
    clearTimeout(watchdog);
    interruptActiveOperations(active, "gate cleanup interrupted acquisition");
  }
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(__filename)) {
  try {
    const artifact = await main();
    if (artifact.status === "ERROR") {
      throw new Error("completed gate run reported a harness ERROR");
    }
    process.exitCode = artifact.exitCode;
    process.exit(artifact.exitCode);
  } catch (fatalError) {
    console.error("[c11-170-perf-gate] fatal error", fatalError);
    process.exit(EXIT_CODE.ERROR);
  }
}
