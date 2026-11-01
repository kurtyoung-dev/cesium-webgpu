// probe-runtime-help.spec.mjs - what a caller sees from a probe asked for its options, or given a command line it cannot parse.
// @purpose Executes runProbe against a fake descriptor with recording launch, preflight, chromium and writeFile stubs and asserts that --help and -h print the option table (core flags, the descriptor's flags, kinds and defaults, the title) to stdout and exit 2 before anything is preflighted, launched or written, that an unknown or malformed argument prints one stderr usage line with the --help hint and no stack, exits 2 and writes no receipt, and that buildRuntimeReceipt names the missing options instead of reading a property of null; each clause is shown dead by an inertness mutant of the runtime or the receipt builder.
// @status ACTIVE
//
// No browser is reachable from this spec: every seam that could open or touch one is a stub that records the call,
// and the assertion is that none was made. The landing probe's own descriptor is read for its table only.
//
// RUN: CESIUM_LANE=<lane> node --test Tools/visual-regression/probe-runtime-help.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { liveSamplerReads } from "./lib/cpu-warm-up.mjs";
import { PROBE_EXIT_CODES } from "./lib/probe-refusal.mjs";
import { buildHelpText } from "./lib/probe-runtime-args.mjs";
import { buildRuntimeReceipt } from "./lib/probe-runtime-receipts.mjs";
import { runProbe } from "./lib/probe-runtime.mjs";
import { descriptor as landingDescriptor } from "./probe-landing-cells.mjs";

/** A descriptor whose cells would record a call if a run ever reached them. */
function fakeDescriptor(calls) {
  return {
    name: "fake-help-probe",
    title: "Fake help probe",
    args: {
      defaults: { runs: 3 },
      extraOptions: [
        { flag: "--cells", key: "cells", kind: "string", default: "all" },
        { flag: "--clock", key: "clock", kind: "iso-instant" },
        { flag: "--settle", key: "settle", kind: "non-negative-number" },
      ],
    },
    cells: async () => {
      calls.push("cells");
      return [];
    },
    receipt: () => ({}),
    verdicts: () => [],
  };
}

/** Run the probe with every seam recording, and the process streams captured for the duration. */
async function drive(argv) {
  return withLaneTmp("probe-runtime-help-", async (root) => {
    const calls = [];
    const written = [];
    let stdout = "";
    let stderr = "";
    const realOut = process.stdout.write;
    const realErr = process.stderr.write;
    const samplerBefore = liveSamplerReads();
    let code;
    process.stdout.write = (chunk) => {
      stdout += String(chunk);
      return true;
    };
    process.stderr.write = (chunk) => {
      stderr += String(chunk);
      return true;
    };
    try {
      code = await runProbe(fakeDescriptor(calls), {
        argv,
        repositoryRoot: root,
        chromium: new Proxy(
          {},
          {
            get: (_target, name) => {
              calls.push(`chromium.${String(name)}`);
              return () => {};
            },
          },
        ),
        preflight: async () => {
          calls.push("preflight");
          return { ok: true, artifacts: [] };
        },
        launch: async () => {
          calls.push("launch");
          return { close: async () => {} };
        },
        writeFile: (file) => {
          written.push(file);
        },
      });
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }
    return {
      code,
      calls,
      written,
      stdout,
      stderr,
      onDisk: fs.readdirSync(root),
      samplerMoved: liveSamplerReads() !== samplerBefore,
    };
  });
}

test("H1: --help prints the option table and exits 2 before a preflight, a browser or a receipt", async () => {
  for (const spelling of ["--help", "-h"]) {
    const ran = await drive([spelling]);
    assert.equal(ran.code, PROBE_EXIT_CODES.ERROR, spelling);
    assert.equal(PROBE_EXIT_CODES.ERROR, 2);
    assert.deepEqual(ran.calls, [], `${spelling}: no seam was touched`);
    assert.deepEqual(ran.written, [], `${spelling}: nothing was written`);
    assert.deepEqual(ran.onDisk, [], `${spelling}: no file appeared on disk`);
    assert.equal(ran.samplerMoved, false, "no live sampler was read");
    assert.equal(ran.stderr, "", `${spelling}: help is stdout, not an error`);
    assert.ok(ran.stdout.startsWith("Fake help probe\n"), "the title heads it");
    assert.match(ran.stdout, /--port <positive-integer> +default 8094/);
    assert.match(
      ran.stdout,
      /--renderer <renderer-list> +default webgl,webgpu/,
    );
    assert.match(ran.stdout, /--reverse +default false/);
    assert.match(ran.stdout, /--no-serve-built +sets servedBuild to false/);
    assert.match(ran.stdout, /--cells <string> +default all/);
    assert.match(
      ran.stdout,
      /--clock <iso-instant>\s*$/m,
      "no default is invented",
    );
    assert.match(ran.stdout, /--settle <non-negative-number>\s*$/m);
    assert.match(
      ran.stdout,
      /--runs <positive-integer> +default 3/,
      "the descriptor's own default replaces the core one",
    );
    assert.match(ran.stdout, /--help, -h +print this table and exit 2/);
  }
});

test("H2: --help anywhere on the line wins over the flags around it", async () => {
  const ran = await drive(["--runs", "2", "--help", "--port", "8094"]);
  assert.equal(ran.code, PROBE_EXIT_CODES.ERROR);
  assert.deepEqual(ran.calls, []);
  assert.match(ran.stdout, /--port <positive-integer>/);
});

test("H3: the landing probe's table lists its own flags with their kinds", () => {
  const text = buildHelpText(landingDescriptor);
  assert.ok(text.length > 0);
  for (const spec of landingDescriptor.args.extraOptions) {
    assert.ok(text.includes(spec.flag), `${spec.flag} is in the table`);
  }
  assert.match(text, /--port <positive-integer>/);
});

test("U1: an unknown argument is one stderr line with the hint, exit 2, no receipt and no stack", async () => {
  const ran = await drive(["--bogus"]);
  assert.equal(ran.code, PROBE_EXIT_CODES.ERROR);
  assert.deepEqual(ran.calls, []);
  assert.deepEqual(ran.written, []);
  assert.deepEqual(ran.onDisk, []);
  assert.equal(ran.stdout, "");
  assert.equal(
    ran.stderr,
    "fake-help-probe: unknown argument: --bogus; run with --help for the options\n",
  );
  assert.equal(ran.stderr.trimEnd().split("\n").length, 1);
  assert.doesNotMatch(ran.stderr, /\n\s+at |TypeError/);
});

test("U2: a flag missing its value or given a malformed one is the same single line", async () => {
  for (const [argv, said] of [
    [["--port"], "--port requires a value"],
    [["--runs", "zero"], "--runs must be a positive integer"],
    [["--port", "70000"], "--port must be at most 65535"],
  ]) {
    const ran = await drive(argv);
    assert.equal(ran.code, PROBE_EXIT_CODES.ERROR, argv.join(" "));
    assert.deepEqual(ran.written, []);
    assert.equal(
      ran.stderr,
      `fake-help-probe: ${said}; run with --help for the options\n`,
    );
  }
});

test("U3: a refused port still refuses (exit 3) and builds no receipt from options that never parsed", async () => {
  const ran = await drive(["--port", "8080"]);
  assert.equal(ran.code, PROBE_EXIT_CODES.REFUSAL);
  assert.deepEqual(ran.written, []);
  assert.deepEqual(ran.calls, []);
  assert.match(ran.stderr, /REFUSED \(port-8080-forbidden\)/);
  assert.doesNotMatch(ran.stderr, /Cannot read properties/);
});

test("R1: buildRuntimeReceipt with no options names the missing options", () => {
  const base = {
    probe: "p",
    generatedAt: "2026-01-01T00:00:00.000Z",
    origin: "http://localhost:8094",
    preflight: null,
    edgeSlot: null,
    captures: [],
    verdicts: [],
    exitCode: 2,
  };
  for (const missing of [null, undefined]) {
    assert.throws(
      () => buildRuntimeReceipt({ ...base, options: missing }),
      (error) =>
        error instanceof TypeError &&
        /buildRuntimeReceipt requires the parsed options/.test(error.message) &&
        !/Cannot read properties/.test(error.message),
    );
  }
  const receipt = buildRuntimeReceipt({
    ...base,
    options: { servedBuild: false },
  });
  assert.equal(receipt.servedBuildAssertion, "waived");
});
