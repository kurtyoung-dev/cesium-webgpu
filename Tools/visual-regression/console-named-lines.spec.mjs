// console-named-lines.spec.mjs - named console lines are counted over every line of a page, not over the sample the record keeps.
// @purpose Node spec for lib/console-named-lines.mjs and its probe wiring: on the forced-loss shape (92 error lines and page errors) a named pattern is counted in full wherever it sits (past the ten lines record.console keeps), over every line type, over the whole text (never a 300-character slice) and case-sensitively; a malformed spec list is a violation list and the counter throws a TypeError; every text of CLOUD_PIPELINE_CONSOLE_LINES occurs in the engine source that logs it and every table cell with consoleLines carries a valid list; the real probe on the fake browser writes record.consoleLines only for a cell that declares the field; with inertness mutants for the scan limit, the line types, the text slice and the probe's field write.
// @status ACTIVE
//
// The fake page never answers the quantity under test: the lines a case counts
// are the ones the case hands to the fake browser's console emission.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import {
  landingRunners,
  p14Log,
} from "./fixtures/probe-landing-cells-support.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import {
  CLOUD_PIPELINE_CONSOLE_LINES,
  LANDING_CELLS,
} from "./lib/landing-cell-table.mjs";
import * as counter from "./lib/console-named-lines.mjs";
import * as probe from "./probe-landing-cells.mjs";
import { runProbe } from "./lib/probe-runtime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const COUNTER_FILE = path.join(here, "lib/console-named-lines.mjs");
const PROBE_FILE = path.join(here, "probe-landing-cells.mjs");
const FAKE_BROWSER_FILE = path.join(here, "lib/landing-fake-browser.mjs");
const ENGINE = path.join(
  here,
  "..",
  "..",
  "packages",
  "engine",
  "Source",
  "Renderer",
  "WebGPU",
);

let tempRoot;
before(() => {
  tempRoot = mkLaneTmp("console-named-");
});
after(() => {
  removeLaneTmp(tempRoot);
});
const { p14Run } = landingRunners(() => tempRoot);

const CLOUD_FAILED = "Cloud march pipeline creation failed";
const SPECS = [{ name: "cloud-march-pipeline-failed", text: CLOUD_FAILED }];

/** The forced-loss page's shape: 92 error lines, one the sentinel, then page errors and a warning. */
function forcedLossLines() {
  const lines = [
    { type: "error", text: "[WebGPU] Device lost (reason: destroyed): forced" },
  ];
  for (let i = 1; i <= 91; i++) {
    lines.push({ type: "error", text: `Failed to load resource ${i}` });
  }
  for (let i = 1; i <= 9; i++) {
    lines.push({ type: "pageerror", text: `Uncaught ${i}` });
  }
  lines.push({ type: "warning", text: "not an error" });
  return lines.map((line, index) => ({ seq: index + 1, ...line }));
}

/** The forced-loss lines with the named line written over positions (1-based). */
function withNamedLines(positions, text = `${CLOUD_FAILED} (rgba16float:16).`) {
  const lines = forcedLossLines();
  for (const position of positions) {
    lines[position - 1] = { seq: position, type: "error", text };
  }
  return lines;
}

/** Case 1: a pattern past the ten lines the record keeps is counted in full. */
function assertCountedInFull(mod) {
  const result = mod.countNamedConsoleLines(
    withNamedLines([40, 70, 95]),
    SPECS,
  );
  assert.equal(result.totalLines, 102);
  const [pattern] = result.patterns;
  assert.equal(pattern.count, 3);
  assert.equal(pattern.byType.error, 3);
  assert.equal(pattern.firstSeq, 40, "the first match is the line at 40");
  assert.match(pattern.first, /^Cloud march pipeline creation failed/);
  const none = mod.countNamedConsoleLines(forcedLossLines(), SPECS);
  assert.equal(none.patterns[0].count, 0);
  assert.equal(none.patterns[0].first, null);
  assert.equal(none.patterns[0].firstSeq, null);
}

/** Case 2: every line type counts under its own type. */
function assertEveryTypeCounts(mod) {
  const lines = [
    { seq: 1, type: "warning", text: `warn ${CLOUD_FAILED}` },
    { seq: 2, type: "log", text: `log ${CLOUD_FAILED}` },
    { seq: 3, type: "pageerror", text: `thrown ${CLOUD_FAILED}` },
    { seq: 4, type: "error", text: `error ${CLOUD_FAILED}` },
  ];
  const [pattern] = mod.countNamedConsoleLines(lines, SPECS).patterns;
  assert.equal(pattern.count, 4);
  assert.deepEqual(pattern.byType, {
    warning: 1,
    log: 1,
    pageerror: 1,
    error: 1,
  });
}

/** Case 3: the whole text is searched, not its first 300 characters. */
function assertWholeText(mod) {
  const text = `${"x".repeat(320)}${CLOUD_FAILED} (rgba16float:16).`;
  assert.ok(text.length > 340);
  const [pattern] = mod.countNamedConsoleLines(
    [{ seq: 1, type: "error", text }],
    SPECS,
  ).patterns;
  assert.equal(pattern.count, 1);
  assert.equal(pattern.first.length, 300, "the kept sample is the first 300");
}

test("a named line past the ten kept by record.console is counted in full, with its first sequence number", () => {
  assertCountedInFull(counter);
});

test("a warning, a log, a page error and an error each count under their own type", () => {
  assertEveryTypeCounts(counter);
});

test("a line whose named text starts past character 320 counts", () => {
  assertWholeText(counter);
});

test("the match is a case-sensitive substring: a lower-case spelling does not count", () => {
  const lines = [
    { seq: 1, type: "error", text: CLOUD_FAILED.toLowerCase() },
    { seq: 2, type: "error", text: CLOUD_FAILED.toUpperCase() },
  ];
  assert.equal(
    counter.countNamedConsoleLines(lines, SPECS).patterns[0].count,
    0,
  );
});

test("a malformed spec list is a violation list and the counter throws a TypeError", () => {
  const duplicate = [
    { name: "a", text: "x" },
    { name: "a", text: "y" },
  ];
  assert.ok(
    counter
      .consoleLineSpecViolations(duplicate)
      .some((v) => /repeats the name a/.test(v)),
  );
  assert.ok(
    counter
      .consoleLineSpecViolations([{ name: "a", text: "" }])
      .some((v) => /no text/.test(v)),
  );
  assert.ok(
    counter
      .consoleLineSpecViolations([{ name: "a", text: "x", re: /x/ }])
      .some((v) => /"re"/.test(v)),
  );
  assert.ok(
    counter
      .consoleLineSpecViolations([{ text: "x" }])
      .some((v) => /no name/.test(v)),
  );
  assert.deepEqual(counter.consoleLineSpecViolations(SPECS), []);
  for (const bad of [
    duplicate,
    [{ name: "a", text: "" }],
    [{ name: "a", text: "x", re: /x/ }],
  ]) {
    assert.throws(
      () => counter.countNamedConsoleLines(forcedLossLines(), bad),
      TypeError,
    );
  }
});

test("every text of CLOUD_PIPELINE_CONSOLE_LINES is logged by the engine file it is read from, and every declaring cell's list is valid", () => {
  const sources = {
    "cloud-march-pipeline-failed": "WebGPUProceduralCloudRenderer.ts",
    "pipeline-creation-failed": "WebGPURenderPipelineCache.ts",
    "lost-device-pipeline-refusal": "WebGPURenderPipelineCache.ts",
  };
  assert.deepEqual(
    counter.consoleLineSpecViolations(CLOUD_PIPELINE_CONSOLE_LINES),
    [],
  );
  assert.deepEqual(
    CLOUD_PIPELINE_CONSOLE_LINES.map((spec) => spec.name),
    Object.keys(sources),
  );
  for (const spec of CLOUD_PIPELINE_CONSOLE_LINES) {
    const source = fs.readFileSync(
      path.join(ENGINE, sources[spec.name]),
      "utf8",
    );
    assert.ok(
      source.includes(spec.text),
      `${spec.name}: ${JSON.stringify(spec.text)} is in ${sources[spec.name]}`,
    );
  }
  const declaring = Object.entries(LANDING_CELLS).filter(
    ([, cell]) => cell.consoleLines !== undefined,
  );
  assert.ok(
    declaring.length >= 6,
    "E-T-flight and the five new cells declare it",
  );
  for (const [name, cell] of declaring) {
    assert.deepEqual(
      counter.consoleLineSpecViolations(cell.consoleLines),
      [],
      name,
    );
  }
  assert.ok(declaring.some(([name]) => name === "E-T-flight"));
});

// ---------------------------------------------------------------------------
// Wiring: the real probe on the fake browser
// ---------------------------------------------------------------------------

/** The forced-loss page's console as the fake emits it, plus one named line. */
function forcedLossMessages() {
  return withNamedLines([40], `${CLOUD_FAILED} (rgba16float:16).`).map(
    ({ type, text }) => ({ type, text }),
  );
}

/** The probe puts the full count on the page of a cell that declares the field. */
async function assertWiring(probe) {
  const flight = await p14Run(
    "wiring-flight",
    ["--cells", "E-T-flight"],
    { consoleMessages: forcedLossMessages() },
    probe.descriptor,
  );
  // The page errors of the forced-loss shape make verdicts fail (exit 1): the count is read from the report.
  assert.ok(flight.report, "the probe wrote its report");
  const page = flight.report.pages.find((p) => p.page === "forced-loss");
  assert.ok(page.consoleLines, "the page carries consoleLines");
  const [pattern] = page.consoleLines.patterns;
  assert.equal(pattern.name, "cloud-march-pipeline-failed");
  assert.equal(pattern.count, 1);
  assert.equal(page.consoleLines.totalLines, 102);
  assert.equal(page.console.first.length, 10, "record.console keeps ten lines");
  const plain = await p14Run(
    "wiring-plain",
    ["--cells", "E-G"],
    { consoleMessages: forcedLossMessages() },
    probe.descriptor,
  );
  assert.equal(plain.report.pages[0].consoleLines, undefined);
}

test("the probe counts the named line on E-T-flight's forced-loss page while record.console keeps ten, and a cell without the field has no consoleLines", async () => {
  await assertWiring(probe);
});

// ---------------------------------------------------------------------------
// Inertness
// ---------------------------------------------------------------------------

/** Each mutant runs the behaviour that passes on the real module and must fail it with an AssertionError. */
async function assertRed(behaviour, file, mutation) {
  const mutated = await importMutated(file, [mutation]);
  await assert.rejects(
    async () => behaviour(mutated),
    (error) => {
      const at = String(error.stack)
        .split(String.fromCharCode(10))
        .find((line) => line.includes(".spec.mjs"));
      console.log(
        `[mutant red] ${String(error.message).slice(0, 100)} ${String(at).trim()}`,
      );
      return error instanceof assert.AssertionError;
    },
  );
}

test("inertness: lines after the first ten not scanned turns the full count red", async () => {
  assertCountedInFull(counter);
  await assertRed(assertCountedInFull, COUNTER_FILE, [
    "for (const line of all) {",
    "for (const line of all.slice(0, 10)) {",
  ]);
});

test("inertness: scanning error lines only turns the line-type count red", async () => {
  assertEveryTypeCounts(counter);
  await assertRed(assertEveryTypeCounts, COUNTER_FILE, [
    '    const text = String(line?.text ?? "");',
    '    if (type !== "error") {\n      continue;\n    }\n    const text = String(line?.text ?? "");',
  ]);
});

test("inertness: slicing the text to 300 characters before matching turns the whole-text count red", async () => {
  assertWholeText(counter);
  await assertRed(assertWholeText, COUNTER_FILE, [
    '    const text = String(line?.text ?? "");',
    '    const text = String(line?.text ?? "").slice(0, 300);',
  ]);
});

test("inertness: the probe's field write made unreachable turns the wiring red", async () => {
  await assertWiring(probe);
  const mutated = await importMutated(PROBE_FILE, [
    [
      "if (Array.isArray(cell.consoleLines)) {",
      "if (false && Array.isArray(cell.consoleLines)) {",
    ],
  ]);
  await assert.rejects(
    async () => assertWiring(mutated),
    (error) => {
      const at = String(error.stack)
        .split(String.fromCharCode(10))
        .find((line) => line.includes(".spec.mjs"));
      console.log(
        `[mutant red] ${String(error.message).slice(0, 100)} ${String(at).trim()}`,
      );
      return error instanceof assert.AssertionError;
    },
  );
});

/** One E-T-flight run of the real probe over the given fake browser factory. */
async function flightReport(name, makeFake) {
  const dir = path.join(tempRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, "out");
  await runProbe(probe.descriptor, {
    argv: [
      "--repository-root",
      dir,
      "--output",
      out,
      "--runs",
      "1",
      "--no-serve-built",
      "--cells",
      "E-T-flight",
    ],
    launch: async () =>
      makeFake(p14Log(), { consoleMessages: forcedLossMessages() }),
    preflight: async () => ({ ok: true, records: [] }),
  });
  return JSON.parse(
    fs.readFileSync(path.join(out, "landing-cells-report.json"), "utf8"),
  );
}

/** The fake browser emits the lines it is given, so the probe has lines to count. */
async function assertFakeEmits(fake) {
  const report = await flightReport("fake-emits", fake.makeFakeBrowser);
  const page = report.pages.find((p) => p.page === "forced-loss");
  assert.equal(page.consoleLines.totalLines, 102);
  assert.equal(page.consoleLines.patterns[0].count, 1);
}

test("inertness: the fake browser's console emission made unreachable turns the wiring red", async () => {
  const fake = await import("./lib/landing-fake-browser.mjs");
  await assertFakeEmits(fake);
  const mutated = await importMutated(FAKE_BROWSER_FILE, [
    ["emitConsoleMessages(url);", "if (false) emitConsoleMessages(url);"],
  ]);
  await assert.rejects(
    async () => assertFakeEmits(mutated),
    (error) => {
      const at = String(error.stack)
        .split(String.fromCharCode(10))
        .find((line) => line.includes(".spec.mjs"));
      console.log(
        `[mutant red] ${String(error.message).slice(0, 100)} ${String(at).trim()}`,
      );
      return error instanceof assert.AssertionError;
    },
  );
});
