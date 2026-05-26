#!/usr/bin/env node
// Run-regression-sweep — Batch 146.
//
// Runs every probe added during Batches 134-145 sequentially. For each
// probe, parses the tail of its stdout for the conventional status
// markers ("PASS", "device errors: 0", "Total device errors: 0",
// "Total failures: 0", "OK", etc.) and reports an overall PASS/FAIL.
//
// This is a "did the arc break anything?" check, not exhaustive
// re-verification. Probes that fail get their tail output printed for
// manual triage.

import { spawn } from "child_process";

const PROBES = [
  "probe-collections-msaa.mjs", // Batch 134
  "probe-normalmap-gbuffer.mjs", // Batch 135
  "probe-contact-shadows.mjs", // Batch 133 (pre-arc, regression-prone)
  "probe-channel-materials.mjs", // Batch 139
  "probe-all-materials.mjs", // Batch 140
  "probe-model-pbr-audit.mjs", // Batch 141
  "probe-normalmap-ub-diag.mjs", // Batch 138 (diagnostic, used to fail)
  "probe-khr-lights-punctual.mjs", // Batch 142
  "probe-model-taa-msaa.mjs", // Batch 143
  "probe-cesium-man-race.mjs", // Batch 144
  "probe-khr-extensions.mjs", // Batch 145
  "probe-ssr-water.mjs", // Batch 136 (tuning baseline)
  "probe-ssr-tuned.mjs", // Batch 136
];

const TIMEOUT_MS = 900_000; // 15 minutes per probe — probe-model-pbr-audit
// loads 5 sample models sequentially in fresh browser instances, ~120s each.

function runProbe(probe) {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let killed = false;
    const proc = spawn(
      "node",
      [`Tools/visual-regression/${probe}`],
      { shell: false },
    );
    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGKILL");
    }, TIMEOUT_MS);
    proc.stdout.on("data", (b) => (stdout += b.toString()));
    proc.stderr.on("data", (b) => (stderr += b.toString()));
    proc.on("close", (code) => {
      clearTimeout(timer);
      const tail = (stdout + stderr).slice(-1500);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      // Heuristics for pass/fail.
      let status;
      if (killed) {
        status = "TIMEOUT";
      } else if (code !== 0) {
        status = "FAIL (exit≠0)";
      } else if (
        /Total device errors:\s*[1-9]/.test(tail) ||
        /Total failures:\s*[1-9]/.test(tail) ||
        /\b(\d+)\s*DEV-ERRS\b/.test(tail) ||
        /\bDevice errors:\s*[1-9]/.test(tail) ||
        /\bFAIL\b/i.test(tail) ||
        /\berrors=([1-9]\d*)\b/.test(tail)
      ) {
        // Look closer — distinguish "0 errors" vs "N errors"
        const m = tail.match(
          /(?:Total device errors|Device errors|Total failures|errors)[:\s=]+(\d+)/g,
        );
        let anyNonZero = false;
        if (m) {
          for (const hit of m) {
            const num = parseInt(hit.match(/(\d+)/)[1], 10);
            if (num > 0) {
              anyNonZero = true;
              break;
            }
          }
        }
        status = anyNonZero ? "FAIL (errors)" : "PASS";
      } else {
        status = "PASS";
      }
      resolve({ probe, status, code, killed, elapsed, tail });
    });
  });
}

(async () => {
  console.log(`[run-regression-sweep] running ${PROBES.length} probes...\n`);
  const results = [];
  for (const probe of PROBES) {
    process.stdout.write(`  ${probe.padEnd(40)} `);
    const r = await runProbe(probe);
    results.push(r);
    process.stdout.write(`${r.status.padEnd(15)} (${r.elapsed}s)\n`);
  }

  console.log("\n[run-regression-sweep] summary:");
  let passCount = 0;
  let failCount = 0;
  for (const r of results) {
    if (r.status === "PASS") passCount++;
    else failCount++;
  }
  console.log(`  ${passCount} PASS / ${failCount} FAIL of ${results.length}`);

  if (failCount > 0) {
    console.log("\n[run-regression-sweep] FAILED probes — tail output:");
    for (const r of results) {
      if (r.status === "PASS") continue;
      console.log(`\n=== ${r.probe} (${r.status}) ===`);
      console.log(r.tail);
    }
  }
  process.exit(failCount > 0 ? 1 : 0);
})();
