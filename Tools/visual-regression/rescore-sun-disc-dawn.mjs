#!/usr/bin/env node
// rescore-sun-disc-dawn.mjs — second pass of the C12-38 acceptance procedure.
// @purpose Re-score an already-acquired sun-disc-dawn artifact against a FAIL bar derived from that same artifact's own WebGL leg, never from WebGPU.
// @status ACTIVE
//
// WHAT THIS IS. `probe-sun-disc-dawn.mjs` scores its own run against
// `SUN_DISC_DAWN_BAR`, whose every bound is null (DERIVED-PENDING) until a
// real WebGL sweep exists to derive them from — so a first acquisition always
// folds STRUCTURAL by design, never PASS or FAIL. This script is the second
// pass: it reads that acquisition's own JSON artifact, derives a bar from its
// WebGL leg (`deriveSunDiscDawnBarFromWebGLSweep`), and re-scores the SAME
// paired evidence — WebGL as parity control, WebGPU as subject — against the
// result. It never reads the WebGPU leg to derive the bar.
//
// WHAT THIS IS NOT. It starts no server, launches no browser, and runs no
// probe. It is a pure read of one JSON file plus the two exported gate
// functions the logic actually lives in; those are what
// `sun-disc-dawn-gate.spec.mjs` pins, not this file. This wrapper carries no
// logic of its own worth a separate spec.
//
// USAGE.
//   node Tools/visual-regression/rescore-sun-disc-dawn.mjs <artifact.json>
//
// EXIT CODE. The re-scored verdict's own exit code (PASS 0 / FAIL 1 /
// STRUCTURAL 3) when a bar could be derived; STRUCTURAL (3) when the
// artifact's WebGL leg did not carry enough readable samples to derive one;
// ERROR (2) when the file cannot be read or parsed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { rescoreSunDiscDawnArtifact } from "./lib/sun-disc-dawn-gate.mjs";
import { exitCodeForS5Status } from "./lib/verdict-exit-gate.mjs";

function usage() {
  console.log(
    "Usage: node Tools/visual-regression/rescore-sun-disc-dawn.mjs <artifact.json>\n\n" +
      "Reads an already-acquired probe-sun-disc-dawn.mjs artifact, derives the\n" +
      "FAIL bar from its own WebGL leg, and re-scores the paired evidence\n" +
      "against it. Starts no server, launches no browser.",
  );
}

async function main() {
  const file = process.argv[2];
  if (!file || file === "--help") {
    usage();
    process.exitCode = file === "--help" ? 0 : exitCodeForS5Status("ERROR");
    return;
  }
  let artifact;
  try {
    const resolved = path.resolve(file);
    artifact = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    console.error(
      `[rescore-sun-disc-dawn] could not read/parse ${file}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = exitCodeForS5Status("ERROR");
    return;
  }

  const result = rescoreSunDiscDawnArtifact(artifact);
  console.log(JSON.stringify(result, null, 2));

  if (!result.rescored) {
    process.exitCode = exitCodeForS5Status("STRUCTURAL");
    return;
  }
  process.exitCode = exitCodeForS5Status(result.evaluation.status);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
