// cpu-profile-step.spec.mjs - Pure Node contract spec for lib/cpu-profile-step.mjs (no browser).
// @purpose Asserts lib/cpu-profile-step.mjs profiles a page from before its navigation to the return of the named stop step, runs the calibration mark after that step, writes the profile and its meta file, and that the clause which stops at the step is live (inertness mutant).
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import * as step from "./lib/cpu-profile-step.mjs";
import { importMutated } from "./lib/import-mutated.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function fakeBrowser(log) {
  const context = {};
  const page = {
    currentUrl: "about:blank",
    url() {
      return this.currentUrl;
    },
    async goto(url) {
      log.push(`goto ${url}`);
      this.currentUrl = url;
    },
    async evaluate(fn) {
      if (typeof fn === "string") {
        log.push("evaluate mark");
        return { startMs: 100, endMs: 106 };
      }
      log.push(`evaluate ${fn.name}`);
      return { firstFrameAtMs: 42 };
    },
    context() {
      return context;
    },
  };
  context.newPage = async () => page;
  context.newCDPSession = async () => ({
    async send(method) {
      log.push(`cdp ${method}`);
      return method === "Profiler.stop"
        ? { profile: { nodes: [], samples: [1], timeDeltas: [1] } }
        : {};
    },
    async detach() {},
  });
  return {
    async newContext() {
      return context;
    },
  };
}

async function exercise(mod, directory) {
  const log = [];
  const browser = fakeBrowser(log);
  function pageMeasureStartup() {}
  function other() {}
  const installed = mod.installStartupCpuProfiles({
    browser,
    isStopStep: (fn) => fn === pageMeasureStartup,
    destination: ({ index }) => ({ directory, name: `x-run${index}` }),
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("http://localhost/x?renderer=webgl");
  await page.evaluate(other);
  await page.evaluate(pageMeasureStartup);
  await page.evaluate(pageMeasureStartup);
  installed.restore();
  return { log, records: installed.records };
}

test("the profiler starts before the navigation and stops once, after the stop step, with the mark between", () =>
  withLaneTmp("cpu-profile-step-", async (dir) => {
    const { log, records } = await exercise(step, dir);
    const started = log.indexOf("cdp Profiler.start");
    const navigated = log.findIndex((line) => line.startsWith("goto"));
    const stepAt = log.indexOf("evaluate pageMeasureStartup");
    const markAt = log.indexOf("evaluate mark");
    const stoppedAt = log.indexOf("cdp Profiler.stop");
    assert.ok(started >= 0 && started < navigated, log.join("\n"));
    assert.ok(stepAt < markAt && markAt < stoppedAt, log.join("\n"));
    assert.equal(log.filter((line) => line === "cdp Profiler.stop").length, 1);
    assert.equal(records.length, 1);
    assert.ok(fs.existsSync(path.join(dir, "x-run0.cpuprofile")));
    const meta = JSON.parse(
      fs.readFileSync(path.join(dir, "x-run0.cpuprofile.meta.json"), "utf8"),
    );
    assert.deepEqual(meta.calibration, {
      functionName: step.CALIBRATION_MARK_FUNCTION,
      pageStartMs: 100,
      pageEndMs: 106,
    });
    assert.deepEqual(meta.stepResult, { firstFrameAtMs: 42 });
  }));

test("the mark source names the calibration function", () => {
  assert.match(
    step.calibrationMarkSource(3),
    /function __cpuProfileClockMark\(/,
  );
});

test("INERTNESS: with the stop clause unreachable no profile is written, so the first test would go red", () =>
  withLaneTmp("cpu-profile-step-m-", async (dir) => {
    const mutated = await importMutated(
      path.join(here, "lib/cpu-profile-step.mjs"),
      [
        [
          "if (!stopped && isStopStep(fn)) {",
          "if (false && !stopped && isStopStep(fn)) {",
        ],
      ],
    );
    const { log, records } = await exercise(mutated, dir);
    assert.equal(records.length, 0);
    assert.equal(log.indexOf("cdp Profiler.stop"), -1);
  }));
