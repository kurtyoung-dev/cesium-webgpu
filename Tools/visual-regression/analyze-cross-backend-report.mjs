#!/usr/bin/env node
/**
 * Post-process the cross-backend sandcastle sweep report into a
 * categorized summary suitable for a PR description.
 *
 * Usage:
 *   node Tools/visual-regression/analyze-cross-backend-report.mjs
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.join(__dirname, "output", "cross-backend", "report.json");

const HIGH_DIFF_THRESHOLD = 50; // diff% above which we flag for inspection

async function main() {
  const raw = await fs.readFile(REPORT_PATH, "utf8");
  const data = JSON.parse(raw);

  const buckets = {
    bothFail: [],
    webglOnly: [],
    webgpuOnly: [],
    bothOkLowDiff: [],   // diff < 5%
    bothOkMediumDiff: [],// 5% <= diff < 50%
    bothOkHighDiff: [],  // diff >= 50%
    webgpuPinned: [],    // both ran as webgpu (demo hardcodes it)
    webglPinned: [],
  };

  // Issue tracking — orthogonal to the diff buckets above. A demo can
  // be "both backends OK" for canvas-render purposes and STILL spew
  // page errors or console errors that indicate broken rendering.
  const issueBuckets = {
    webglPageErrors: [],
    webgpuPageErrors: [],
    webglConsoleErrors: [],
    webgpuConsoleErrors: [],
    webgpuOnlyIssues: [],   // demos where webgpu has issues but webgl is clean
  };

  for (const r of data.results) {
    const wglOk = r.webgl?.ok;
    const wgpuOk = r.webgpu?.ok;
    const wglR = r.webgl?.actualRenderer;
    const wgpuR = r.webgpu?.actualRenderer;
    const diffPct = r.diff?.diffPercent;

    // Issue tracking — these are orthogonal to the diff buckets.
    const wglPageErrs = r.webgl?.pageErrors || [];
    const wgpuPageErrs = r.webgpu?.pageErrors || [];
    const wglConsoleErrCnt = r.webgl?.consoleErrorCount || 0;
    const wgpuConsoleErrCnt = r.webgpu?.consoleErrorCount || 0;

    if (wglPageErrs.length > 0) {
      issueBuckets.webglPageErrors.push({
        demo: r.demo,
        errors: wglPageErrs,
      });
    }
    if (wgpuPageErrs.length > 0) {
      issueBuckets.webgpuPageErrors.push({
        demo: r.demo,
        errors: wgpuPageErrs,
      });
    }
    if (wglConsoleErrCnt > 0) {
      issueBuckets.webglConsoleErrors.push({
        demo: r.demo,
        count: wglConsoleErrCnt,
      });
    }
    if (wgpuConsoleErrCnt > 0) {
      issueBuckets.webgpuConsoleErrors.push({
        demo: r.demo,
        count: wgpuConsoleErrCnt,
        messages: r.webgpu?.consoleMessages || [],
      });
    }
    // Demos where ONLY WebGPU has issues — most actionable bugs
    if (
      (wgpuPageErrs.length > 0 || wgpuConsoleErrCnt > 0) &&
      wglPageErrs.length === 0 &&
      wglConsoleErrCnt === 0
    ) {
      issueBuckets.webgpuOnlyIssues.push({
        demo: r.demo,
        wgpuPageErrors: wgpuPageErrs,
        wgpuConsoleCount: wgpuConsoleErrCnt,
        wgpuConsoleMessages: r.webgpu?.consoleMessages || [],
      });
    }

    if (!wglOk && !wgpuOk) {
      buckets.bothFail.push({ demo: r.demo, wglErr: r.webgl?.navError, wgpuErr: r.webgpu?.navError });
      continue;
    }
    if (wglOk && !wgpuOk) {
      buckets.webglOnly.push({ demo: r.demo, wgpuErr: r.webgpu?.navError });
      continue;
    }
    if (!wglOk && wgpuOk) {
      buckets.webgpuOnly.push({ demo: r.demo, wglErr: r.webgl?.navError });
      continue;
    }
    // both ok
    if (wglR === "webgpu" && wgpuR === "webgpu") {
      buckets.webgpuPinned.push({ demo: r.demo, diffPct });
      continue;
    }
    if (wglR === "webgl" && wgpuR === "webgl") {
      buckets.webglPinned.push({ demo: r.demo, diffPct });
      continue;
    }
    // Different renderers — the typical case.
    if (diffPct === undefined || diffPct === null) {
      buckets.bothOkLowDiff.push({ demo: r.demo, diffPct: "?" });
    } else if (diffPct < 5) {
      buckets.bothOkLowDiff.push({ demo: r.demo, diffPct });
    } else if (diffPct < HIGH_DIFF_THRESHOLD) {
      buckets.bothOkMediumDiff.push({ demo: r.demo, diffPct });
    } else {
      buckets.bothOkHighDiff.push({ demo: r.demo, diffPct });
    }
  }

  const allDiffs = data.results
    .map((r) => r.diff?.diffPercent)
    .filter((d) => typeof d === "number");
  const meanDiff = allDiffs.length
    ? allDiffs.reduce((a, b) => a + b, 0) / allDiffs.length
    : 0;
  const sortedDiffs = [...allDiffs].sort((a, b) => a - b);
  const p50 = sortedDiffs[Math.floor(sortedDiffs.length / 2)] ?? 0;
  const p90 =
    sortedDiffs[Math.floor(sortedDiffs.length * 0.9)] ?? 0;

  console.log(`# Cross-Backend Sandcastle Sweep Report`);
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log(`Source: ${REPORT_PATH}`);
  console.log(``);
  console.log(`## Canvas-render totals (does the demo render anything at all?)`);
  console.log(`- Total demos: ${data.results.length}${data.demoCount ? ` of ${data.demoCount} expected` : ""}`);
  console.log(`- Both backends OK: ${buckets.bothOkLowDiff.length + buckets.bothOkMediumDiff.length + buckets.bothOkHighDiff.length + buckets.webgpuPinned.length + buckets.webglPinned.length}`);
  console.log(`- WebGL only OK (WebGPU failed): ${buckets.webglOnly.length}`);
  console.log(`- WebGPU only OK (WebGL failed): ${buckets.webgpuOnly.length}`);
  console.log(`- Both failed: ${buckets.bothFail.length}`);
  console.log(``);
  console.log(`## Issue totals (does the demo render CLEANLY?)`);
  console.log(`- Demos with WebGL pageErrors: ${issueBuckets.webglPageErrors.length}`);
  console.log(`- Demos with WebGPU pageErrors: ${issueBuckets.webgpuPageErrors.length}`);
  console.log(`- Demos with WebGL console errors/warnings: ${issueBuckets.webglConsoleErrors.length}`);
  console.log(`- Demos with WebGPU console errors/warnings: ${issueBuckets.webgpuConsoleErrors.length}`);
  console.log(`- **Demos where ONLY WebGPU has issues** (regressions): ${issueBuckets.webgpuOnlyIssues.length}`);
  console.log(``);
  console.log(`## Diff statistics (over comparable runs)`);
  console.log(`- Mean diff: ${meanDiff.toFixed(2)}%`);
  console.log(`- Median (p50) diff: ${p50.toFixed(2)}%`);
  console.log(`- p90 diff: ${p90.toFixed(2)}%`);
  console.log(``);

  function listBucket(name, items, includeDiff = true, max = 30) {
    console.log(`## ${name} (${items.length})`);
    if (items.length === 0) {
      console.log(`(none)`);
      console.log(``);
      return;
    }
    const sorted = includeDiff
      ? items.sort((a, b) => (b.diffPct ?? 0) - (a.diffPct ?? 0))
      : items;
    for (const item of sorted.slice(0, max)) {
      const diff = includeDiff && item.diffPct !== undefined
        ? ` — diff=${typeof item.diffPct === "number" ? item.diffPct.toFixed(1) + "%" : item.diffPct}`
        : "";
      const err = item.wgpuErr || item.wglErr;
      const errStr = err ? ` — ${err.substring(0, 80)}` : "";
      console.log(`- ${item.demo}${diff}${errStr}`);
    }
    if (sorted.length > max) {
      console.log(`- ...and ${sorted.length - max} more`);
    }
    console.log(``);
  }

  // ISSUES FIRST — these are most actionable
  console.log(`# ISSUES — actual bugs to fix\n`);
  console.log(`## WebGPU-only issues (regressions vs WebGL — highest priority) (${issueBuckets.webgpuOnlyIssues.length})`);
  if (issueBuckets.webgpuOnlyIssues.length === 0) {
    console.log(`(none)\n`);
  } else {
    for (const item of issueBuckets.webgpuOnlyIssues.slice(0, 50)) {
      const errs = (item.wgpuPageErrors || []).slice(0, 2).map((e) => e.substring(0, 200));
      const msgs = (item.wgpuConsoleMessages || []).slice(0, 3).map((m) => m.substring(0, 200));
      console.log(`- ${item.demo} — console=${item.wgpuConsoleCount} pageErrors=${item.wgpuPageErrors.length}`);
      for (const e of errs) console.log(`    [pageError] ${e}`);
      for (const m of msgs) console.log(`    [console]   ${m}`);
    }
    if (issueBuckets.webgpuOnlyIssues.length > 50) {
      console.log(`- ...and ${issueBuckets.webgpuOnlyIssues.length - 50} more`);
    }
    console.log(``);
  }

  console.log(`## WebGPU pageErrors (${issueBuckets.webgpuPageErrors.length})`);
  for (const item of issueBuckets.webgpuPageErrors.slice(0, 30)) {
    const errs = item.errors.slice(0, 2).map((e) => e.substring(0, 120));
    console.log(`- ${item.demo}`);
    for (const e of errs) console.log(`    > ${e}`);
  }
  if (issueBuckets.webgpuPageErrors.length > 30) {
    console.log(`- ...and ${issueBuckets.webgpuPageErrors.length - 30} more`);
  }
  console.log(``);

  console.log(`## WebGL pageErrors (${issueBuckets.webglPageErrors.length})`);
  for (const item of issueBuckets.webglPageErrors.slice(0, 30)) {
    const errs = item.errors.slice(0, 2).map((e) => e.substring(0, 120));
    console.log(`- ${item.demo}`);
    for (const e of errs) console.log(`    > ${e}`);
  }
  if (issueBuckets.webglPageErrors.length > 30) {
    console.log(`- ...and ${issueBuckets.webglPageErrors.length - 30} more`);
  }
  console.log(``);

  // DIFF BUCKETS SECOND
  console.log(`# DIFF BUCKETS\n`);
  listBucket("Both failed", buckets.bothFail, false);
  listBucket("WebGL only OK (WebGPU failed)", buckets.webglOnly, false);
  listBucket("WebGPU only OK (WebGL failed)", buckets.webgpuOnly, false);
  listBucket("High diff (≥ 50%) — visual divergence", buckets.bothOkHighDiff);
  listBucket("Medium diff (5%-50%)", buckets.bothOkMediumDiff);
  listBucket("Low diff (< 5%) — backends agree", buckets.bothOkLowDiff);
  listBucket("WebGPU-pinned demos (both runs WebGPU)", buckets.webgpuPinned);
  listBucket("WebGL-pinned demos (both runs WebGL — sync constructor only)", buckets.webglPinned);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
