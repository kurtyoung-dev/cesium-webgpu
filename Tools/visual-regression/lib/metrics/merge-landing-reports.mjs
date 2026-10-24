/**
 * Landing-cells reports grouped into arms, and several single-run reports of
 * one arm merged into the N-run report the PF metrics and `--base-report`
 * read, so an executor can interleave arms (B0 A0 B1 A1) and contention lands
 * on both alike.
 * @purpose Node-only reader of probe-landing-cells reports: armKey and groupArms (page records -> per-arm PF inputs, captures, per-run machine CPU and device-loss terminals), the tree identity a report was served from (preflight disk md5s, or the same read from a tree on disk), and mergeLandingReports, which refuses reports of different trees, windows, perf settings or pending-pipeline waits and otherwise renumbers their runs in order and regroups them, so merging two --runs 1 reports equals one --runs 2 report; plus the probe's --merge-reports glue (read and check the named reports against the invocation's own tree, and fold their runs before its pages).
 * @status ACTIVE
 *
 * WHY THIS EXISTS (round 4, F4; Calenhad N5). The 2026-10-22 water E11 run
 * measured BEFORE then AFTER; the AFTER launch waited 510 s for the machine to
 * quieten and BEFORE 3 s, so contention that came and went landed on one arm.
 * Interleaving the arms one run at a time (B0 A0 B1 A1, each `--runs 1`)
 * spreads it over both. The PF metrics need every run of an arm in one report;
 * this piece builds that report from the single-run ones.
 *
 * HOW THE PROBE USES IT. `probe-landing-cells.mjs --merge-reports <a,b,...>`
 * folds earlier single-arm reports into the invocation's own pages before it
 * groups them: B1 with `--merge-reports <B0>` writes the two-run base report,
 * and A1 with `--merge-reports <A0> --base-report <B1's report>` compares two
 * tip runs with two base runs. The merged runs keep their order: the earlier
 * reports' runs first, in the order given, then the invocation's own.
 *
 * WHAT IS REFUSED. Reports served from different trees (the preflight's disk
 * md5s differ), measured over different windows (`windows`), with and without
 * `--perf`, or with and without `--wait-pipelines` (round 5), are not one
 * arm and are never merged; the refusal names the report and the field.
 *
 * @module Tools/visual-regression/lib/metrics/merge-landing-reports
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ProbeRefusal } from "../probe-refusal.mjs";

/** The key one arm's results are grouped under, across runs. */
export function armKey(record) {
  return `${record.cell}|${record.renderer}|${record.page}`;
}

/**
 * Group a run set's page records into arms: one per (cell, renderer, page),
 * holding each run's raw PF inputs, its machine CPU and its capture. Pure.
 *
 * `inputs.cpu` holds one mean machine CPU (%) per scene-page run, the same
 * runs PF-1..PF-3 read, null where the run carried no `cpu` reading;
 * `inputs.cpuSamples` the same runs' 1 Hz samples (%), in time order, for the
 * contention guard's sample clause (round 5, K5-6), null where absent.
 *
 * @param {object[]} records Every page record of every run.
 * @returns {Record<string, object>}
 */
export function groupArms(records) {
  const arms = {};
  for (const record of records) {
    const key = armKey(record);
    if (!arms[key]) {
      arms[key] = {
        cell: record.cell,
        rig: record.rig,
        renderer: record.renderer,
        page: record.page,
        runs: 0,
        notRun: [],
        captures: [],
        inputs: {
          pf1: [],
          pf2: [],
          pf3: [],
          pf4: [],
          cpu: [],
          cpuSamples: [],
        },
        deviceLoss: [],
      };
    }
    const arm = arms[key];
    arm.runs++;
    if (record.notRun) {
      arm.notRun.push(record.notRun);
      continue;
    }
    if (record.capture) {
      arm.captures.push(record.capture);
    }
    // PF-3 reads scene pages only: an E-T page's startup is the same scene's,
    // already read by its capture cell, and its teardown is not a startup.
    if (record.startup && record.page === "scene") {
      arm.inputs.pf3.push({
        startup: record.startup,
        compile: record.compileAtStartup ?? {},
      });
    }
    if (record.perf) {
      arm.inputs.pf1.push(record.perf.frameTimes?.frameMs ?? []);
      arm.inputs.pf2.push(record.perf.passCost ?? null);
      arm.inputs.pf4.push(record.perf.census ?? null);
    }
    if (record.page === "scene") {
      const mean = record.cpu?.mean;
      arm.inputs.cpu.push(Number.isFinite(mean) ? mean : null);
      const samples = record.cpu?.samples;
      arm.inputs.cpuSamples.push(
        Array.isArray(samples) ? samples.map((sample) => sample?.pct) : null,
      );
    }
    if (record.deviceLoss) {
      arm.deviceLoss.push({
        terminal: record.deviceLoss.terminal,
        consoleErrors: record.deviceLoss.consoleErrors,
        deviceLost: record.deviceLoss.deviceLost,
      });
    }
  }
  return arms;
}

/**
 * The tree a report was served from: its `treeIdentity` when it states one,
 * else its preflight's disk md5 per artifact, as one sorted string. Pure.
 *
 * @param {object} report A landing-cells report.
 * @returns {string|null} null when the report carries no artifact md5.
 */
export function reportTreeIdentity(report) {
  // A merged report, or a probe's own pages handed in for merging, states it.
  if (typeof report?.treeIdentity === "string") {
    return report.treeIdentity;
  }
  const artifacts = report?.preflight?.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return null;
  }
  return artifacts
    .map((artifact) => `${artifact.path}=${artifact.disk?.md5 ?? "absent"}`)
    .sort()
    .join(";");
}

// A probe reads its own tree's identity once per run and again for its
// receipt and verdicts; the build files are tens of MB, so the md5 is kept
// per (path, size, mtime) and re-read when any of them moves.
const md5Memo = new Map();

function md5OfFile(file) {
  const stat = fs.statSync(file);
  const key = `${file}|${stat.size}|${stat.mtimeMs}`;
  if (!md5Memo.has(key)) {
    md5Memo.set(
      key,
      createHash("md5").update(fs.readFileSync(file)).digest("hex"),
    );
  }
  return md5Memo.get(key);
}

/**
 * The same identity read from a tree on disk. Node only.
 *
 * @param {string} repositoryRoot
 * @param {string[]} artifacts Repo-relative artifact paths.
 * @returns {string|null} null when none of the artifacts exists.
 */
export function diskTreeIdentity(repositoryRoot, artifacts) {
  let found = 0;
  const parts = (artifacts ?? []).map((relativePath) => {
    const file = path.join(repositoryRoot, relativePath);
    if (!fs.existsSync(file)) {
      return `${relativePath}=absent`;
    }
    found++;
    return `${relativePath}=${md5OfFile(file)}`;
  });
  return found === 0 ? null : parts.sort().join(";");
}

/**
 * The runs a report holds: the larger of its `options.runs` and one past its
 * largest page `run`. A report that `--merge-reports` wrote says
 * `options.runs: 1` but holds every merged run, so its pages decide
 * (Ettenmoors pass 4, N-1: merging it again numbered the runs 0, 1, 1).
 */
function runsOf(report) {
  const declared =
    Number.isInteger(report?.options?.runs) && report.options.runs > 0
      ? report.options.runs
      : 0;
  const runs = (report?.pages ?? []).map((page) => page.run ?? 0);
  return Math.max(declared, runs.length === 0 ? 0 : Math.max(...runs) + 1);
}

/**
 * Merge single-arm landing-cells reports into one N-run report. Pure.
 *
 * @param {object[]} reports Parsed `landing-cells-report.json` objects of ONE
 *   arm (one tree), in run order.
 * @param {{labels?: string[]}} [options] `labels` names each report in
 *   refusals and in `mergedFrom` (e.g. its path).
 * @returns {{probe: "landing-cells", merged: true, mergedFrom: object[],
 *   windows: object|null, perf: boolean, waitForPendingPipelines: boolean,
 *   treeIdentity: string|null, pages: object[],
 *   arms: Record<string, object>}}
 * @throws {TypeError} For an empty list, a report that is not a landing-cells
 *   report, or reports of different trees, windows, perf settings or
 *   pending-pipeline waits.
 */
export function mergeLandingReports(reports, { labels = [] } = {}) {
  if (!Array.isArray(reports) || reports.length === 0) {
    throw new TypeError("mergeLandingReports needs at least one report");
  }
  const name = (index) => labels[index] ?? `report ${index}`;
  reports.forEach((report, index) => {
    if (
      !report ||
      !Array.isArray(report.pages) ||
      (report.probe !== undefined && report.probe !== "landing-cells")
    ) {
      throw new TypeError(`${name(index)} is not a landing-cells report`);
    }
  });
  const first = reports[0];
  const identity = reportTreeIdentity(first);
  const windows = JSON.stringify(first.windows ?? null);
  const perf = first.perf === true;
  const waited = first.waitForPendingPipelines === true;
  reports.forEach((report, index) => {
    if (reportTreeIdentity(report) !== identity) {
      throw new TypeError(
        `${name(index)} was served from a different tree than ${name(0)} (preflight disk md5s differ); reports of different arms are never merged`,
      );
    }
    if (JSON.stringify(report.windows ?? null) !== windows) {
      throw new TypeError(
        `${name(index)} measured windows ${JSON.stringify(report.windows ?? null)}, ${name(0)} ${windows}`,
      );
    }
    if ((report.perf === true) !== perf) {
      throw new TypeError(
        `${name(index)} has perf ${report.perf === true}, ${name(0)} ${perf}`,
      );
    }
    // Round 5, K5-2: a run that waited for pending pipelines renders before
    // its startup timeline; it is never merged with one that did not.
    if ((report.waitForPendingPipelines === true) !== waited) {
      throw new TypeError(
        `${name(index)} has waitForPendingPipelines ${report.waitForPendingPipelines === true}, ${name(0)} ${waited}`,
      );
    }
  });
  const pages = [];
  const mergedFrom = [];
  let offset = 0;
  reports.forEach((report, index) => {
    const runs = runsOf(report);
    for (const page of report.pages) {
      pages.push({ ...page, run: offset + (page.run ?? 0) });
    }
    mergedFrom.push({
      label: name(index),
      generatedAt: report.generatedAt ?? null,
      runs,
      firstRun: offset,
    });
    offset += runs;
  });
  return {
    probe: "landing-cells",
    merged: true,
    mergedFrom,
    windows: first.windows ?? null,
    perf,
    waitForPendingPipelines: waited,
    treeIdentity: identity,
    pages,
    arms: groupArms(pages),
  };
}

// The probe-side glue of `--merge-reports` (moved here from
// probe-landing-cells.mjs in round 5 to keep the probe under 1000 lines;
// unchanged apart from taking the served artifacts as a parameter).

/**
 * An invocation's pages in the shape {@link mergeLandingReports} reads, its
 * tree read from disk over `servedArtifacts`. Node only.
 *
 * @param {object[]} pages
 * @param {object} options The probe options.
 * @param {string[]} servedArtifacts The probe's served artifacts.
 * @returns {object}
 */
export function invocationReport(pages, options, servedArtifacts) {
  return {
    probe: "landing-cells",
    treeIdentity:
      diskTreeIdentity(
        options?.repositoryRoot ?? process.cwd(),
        servedArtifacts,
      ) ?? undefined,
    windows: {
      frames: options?.frames,
      warmup: options?.warmup,
      passFrames: options?.passFrames,
    },
    perf: options?.perf === true,
    waitForPendingPipelines: options?.waitPipelines === true,
    options: { runs: options?.runs },
    pages,
  };
}

/**
 * The earlier single-arm reports `--merge-reports` names, read and checked
 * against each other and against this invocation's tree, windows and perf
 * setting. Node only.
 *
 * @param {object} options The probe options.
 * @param {string[]} servedArtifacts The probe's served artifacts.
 * @returns {Array<{path: string, sha256: string, report: object}>}
 * @throws {ProbeRefusal} `merge-report-invalid`.
 */
export function readMergeReports(options, servedArtifacts) {
  const paths = String(options?.mergeReports ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (paths.length === 0) {
    return [];
  }
  const priors = paths.map((file) => {
    let bytes;
    let report;
    try {
      bytes = fs.readFileSync(file);
      report = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new ProbeRefusal(
        "merge-report-invalid",
        `${file}: ${String(error?.message ?? error)}`,
        { mergeReport: file },
      );
    }
    return {
      path: path.resolve(file),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      report,
    };
  });
  try {
    mergeLandingReports(
      [
        ...priors.map((prior) => prior.report),
        invocationReport([], options, servedArtifacts),
      ],
      { labels: [...priors.map((prior) => prior.path), "this invocation"] },
    );
  } catch (error) {
    throw new ProbeRefusal("merge-report-invalid", String(error.message), {
      mergeReports: priors.map((prior) => prior.path),
    });
  }
  return priors;
}

/**
 * This invocation's pages with the `--merge-reports` runs before them,
 * renumbered in order (F4). Without priors, the pages unchanged.
 *
 * @param {object[]} cells This invocation's page records.
 * @param {object} options
 * @param {Array<{path: string, report: object}>} priors
 * @param {string[]} servedArtifacts The probe's served artifacts.
 * @returns {object[]}
 */
export function pagesWithMergedRuns(cells, options, priors, servedArtifacts) {
  if (priors.length === 0) {
    return cells;
  }
  return mergeLandingReports(
    [
      ...priors.map((prior) => prior.report),
      invocationReport(cells, options, servedArtifacts),
    ],
    { labels: [...priors.map((prior) => prior.path), "this invocation"] },
  ).pages;
}
