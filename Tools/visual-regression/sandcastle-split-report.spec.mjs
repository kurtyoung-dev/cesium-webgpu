// @purpose Verifies that separate Sandcastle sweep legs retain their own report files.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import test from "node:test";
import { withLaneTmp } from "../lib/lane-tmp.mjs";

const source = fs.readFileSync(
  new URL("./sandcastle-smoke.mjs", import.meta.url),
  "utf8",
);

function loadSweep(directory, mutate = (text) => text) {
  const between = (first, last) => {
    const start = source.indexOf(first);
    const end = source.indexOf(last, start);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end);
  };
  const declarations =
    between("function parseSweepArgs(", "// The bucket runs the demo") +
    between("async function writeSweepReport(", "const sweepArgv =");
  return vm.runInNewContext(mutate(declarations) + "\nrunSandcastle2Sweep;", {
    fs: fs.promises,
    path,
    createHash,
    SWEEP_OUTPUT_DIR: directory,
    SWEEPABLE_RENDERERS: ["webgl", "webgpu"],
    GALLERY_DIR: directory,
    BASE: "http://localhost:8096",
    enumerateGalleryIds: () => ["all-one", "all-two"],
    checkSandcastle2Typings: async () => ({ ok: true, reason: "fixture" }),
    chromium: { launch: async () => ({ close: async () => {} }) },
    runSweepDemo: async (browser, id) => ({
      id,
      ok: true,
      outcome: "PASS",
      rendererGate: { ok: true, reason: "fixture" },
      frameGate: { ok: true, reason: "fixture" },
      errors: [],
    }),
    OriginRewriteRefusal: class extends Error {},
    console: { log() {} },
  });
}

async function assertSplitReports(runSweep, directory) {
  assert.equal(await runSweep(["--renderer=webgpu", "--ids=alpha,beta"]), 0);
  assert.equal(await runSweep(["--renderer=webgpu", "--ids=gamma,delta"]), 0);
  const names = fs.readdirSync(directory);
  assert.equal(names.length, 2, "both split-leg reports survive");
  for (const name of names) {
    const report = JSON.parse(fs.readFileSync(path.join(directory, name)));
    assert.equal(report.total, 2);
    assert.equal(report.passed, 2);
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.timeouts, []);
  }
}

test("two split legs write distinct complete reports into the same directory", () =>
  withLaneTmp("sandcastle-split-reports-", (directory) =>
    assertSplitReports(loadSweep(directory), directory),
  ));

test("an explicit leg label is safe and separates otherwise identical selections", () =>
  withLaneTmp("sandcastle-label-reports-", async (directory) => {
    const sweep = loadSweep(directory);
    await sweep(["--ids=alpha", "--leg-label=../../first"]);
    await sweep(["--ids=alpha", "--leg-label=second"]);
    const names = fs.readdirSync(directory);
    assert.equal(names.length, 2);
    assert.ok(names.some((name) => name.includes("first")));
    assert.ok(names.some((name) => name.includes("second")));
    assert.ok(
      names.every((name) => !name.includes("/") && !name.includes("\\")),
    );
  }));

test("an unsplit full sweep preserves the existing consumer report path", () =>
  withLaneTmp("sandcastle-full-report-", async (directory) => {
    await loadSweep(directory)(["--renderer=webgpu"]);
    assert.deepEqual(fs.readdirSync(directory), ["report-webgpu.json"]);
  }));

test("the split-report assertion rejects an unreachable leg suffix", () =>
  withLaneTmp("sandcastle-inert-report-", async (directory) => {
    const inert = loadSweep(directory, (text) => {
      const anchor = "if (split) {";
      assert.equal(text.split(anchor).length - 1, 1);
      return text.replace(anchor, "if (false && split) {");
    });
    await assert.rejects(
      assertSplitReports(inert, directory),
      /both split-leg reports survive/,
    );
  }));
