#!/usr/bin/env node
// @purpose Reads one or more banked E-1 residency receipts and prints where each leg's settle-window stall was waiting - main thread blocked, off the main thread, or undetermined - with the evidence each verdict rests on.
// @status ACTIVE
//
// Offline post-processing of evidence that already exists. No browser, no
// server, no GPU, no build: it reads `dm09-e1-receipt.json` files and nothing
// else, so it can be run against a bank long after the machine that produced
// it is gone.
//
// Why it is separate from the probe: the probe's job is to MEASURE and it must
// stay frozen around its pre-registered predictions. This reads a finished
// measurement and asks one further question of it, so re-asking never requires
// re-running a 100-second settle window on a machine with a GPU.
//
// Examples:
//   node Tools/visual-regression/aec-residency-stall-locus.mjs \
//     Tools/visual-regression/output/aec-residency-e1-2026-09-02/leg-a/dm09-e1-receipt.json
//   node Tools/visual-regression/aec-residency-stall-locus.mjs --json out/*/dm09-e1-receipt.json
//
// Exit codes:
//   0 every receipt was read and classified
//   2 a receipt was missing or unreadable

import { readFileSync } from "node:fs";

import {
  analyzeReceipt,
  buildStallLocusReport,
} from "./lib/aec-residency-stall-locus.mjs";

/**
 * Splits argv into the receipt paths and the flags.
 *
 * @param {ReadonlyArray<string>} argv Arguments after the script name.
 * @returns {{paths: string[], json: boolean}} The parsed arguments.
 */
export function parseStallLocusArgs(argv) {
  const paths = [];
  let json = false;
  for (const argument of argv) {
    if (argument === "--json") {
      json = true;
      continue;
    }
    paths.push(argument);
  }
  return { paths, json };
}

const { paths, json } = parseStallLocusArgs(process.argv.slice(2));

if (paths.length === 0) {
  process.stderr.write(
    "usage: aec-residency-stall-locus.mjs [--json] <dm09-e1-receipt.json>...\n",
  );
  process.exit(2);
}

const results = [];
for (const path of paths) {
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    process.stderr.write(`cannot read receipt ${path}: ${String(error)}\n`);
    process.exit(2);
  }
  results.push({ path, rows: analyzeReceipt(receipt) });
}

if (json) {
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} else {
  for (const result of results) {
    process.stdout.write(`\n## ${result.path}\n\n`);
    process.stdout.write(buildStallLocusReport(result.rows));
  }
}
