// Browser-free contract for backend-isolation lane startup.
// @purpose Pin the backend-isolation split lane to the page's explicit launch and readiness contract.
// @status ACTIVE

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { launchLaneIfGated } from "./lib/backend-isolation-launch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const read = (relative) => readFileSync(resolve(ROOT, relative), "utf8");

function laneDescriptor(probeSource, name) {
  const descriptors = probeSource.matchAll(
    /await runLane\(browser,\s*\{([\s\S]*?)\}\),/g,
  );
  for (const match of descriptors) {
    if (new RegExp(`\\bname:\\s*"${name}"`).test(match[1])) {
      return match[1];
    }
  }
  assert.fail(`missing ${name} lane descriptor`);
}

function stringProperty(source, property) {
  const match = new RegExp(`\\b${property}:\\s*"([^"]+)"`).exec(source);
  assert.ok(match, `${property} is missing from the lane descriptor`);
  return match[1];
}

function stringArrayProperty(source, property) {
  const match = new RegExp(`\\b${property}:\\s*\\[([^\\]]*)\\]`).exec(source);
  assert.ok(match, `${property} is missing from the lane descriptor`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function recordingPage() {
  const calls = [];
  return {
    calls,
    page: {
      async waitForSelector(...args) {
        calls.push(["waitForSelector", ...args]);
      },
      async click(...args) {
        calls.push(["click", ...args]);
      },
    },
  };
}

test("the gated launch step waits with a bound before clicking", async () => {
  const gated = recordingPage();
  await launchLaneIfGated(gated.page, "#btnLaunch");
  assert.deepEqual(gated.calls, [
    ["waitForSelector", "#btnLaunch", { timeout: 10_000 }],
    ["click", "#btnLaunch"],
  ]);

  const ungated = recordingPage();
  await launchLaneIfGated(ungated.page);
  assert.deepEqual(ungated.calls, []);
});

test("a gated launch propagates selector timeouts without clicking", async () => {
  const timeout = new Error("timeout");
  const calls = [];
  const fakePage = {
    async waitForSelector(...args) {
      calls.push(["waitForSelector", ...args]);
      throw timeout;
    },
    async click(...args) {
      calls.push(["click", ...args]);
    },
  };

  await assert.rejects(launchLaneIfGated(fakePage, "#btnLaunch"), (error) => {
    assert.equal(error, timeout);
    return true;
  });
  assert.equal(
    calls.some(([method]) => method === "click"),
    false,
  );
});

test("the probe consumes the launch helper between navigation and readiness", () => {
  const probeSource = read(
    "Tools/visual-regression/probe-backend-isolation.mjs",
  );
  assert.match(
    probeSource,
    /import\s*\{\s*launchLaneIfGated\s*\}\s*from\s*["']\.\/lib\/backend-isolation-launch\.mjs["'];?/,
  );

  const runLane =
    /async function runLane\b[\s\S]*?(?=\n\s*\(async\s*\(\)\s*=>)/.exec(
      probeSource,
    );
  assert.ok(runLane, "the probe has no runLane implementation");
  assert.match(
    runLane[0],
    /await\s+page\.goto\(\s*url\s*,\s*\{[\s\S]*?\}\s*\)\s*;\s*await\s+launchLaneIfGated\(\s*page\s*,\s*launchSelector\s*\)\s*;\s*for\s*\(\s*const\s+g\s+of\s+globals\s*\)\s*await\s+waitForViewer\(\s*page\s*,\s*g\s*\)\s*;/,
    "runLane must consume the launch helper after navigation and before viewer readiness",
  );
});

test("only the split lane declares the launch gate and two readiness globals", () => {
  const probeSource = read(
    "Tools/visual-regression/probe-backend-isolation.mjs",
  );
  const split = laneDescriptor(probeSource, "split");
  assert.equal(stringProperty(split, "launchSelector"), "#btnLaunch");
  assert.deepEqual(stringArrayProperty(split, "globals"), [
    "webglViewer",
    "webgpuViewer",
  ]);

  for (const name of ["webgpu-solo", "webgl-solo"]) {
    const descriptor = laneDescriptor(probeSource, name);
    assert.doesNotMatch(descriptor, /\blaunchSelector\s*:/);
    assert.deepEqual(stringArrayProperty(descriptor, "globals"), ["viewer"]);
  }
});

test("the split page assigns both readiness globals inside its launch handler", () => {
  const pageSource = read("Apps/WebGPUTest/split-screen-comparison.html");
  assert.match(pageSource, /id\s*=\s*"btnLaunch"/);

  const listenerPattern =
    /\.getElementById\(\s*"([^"]+)"\s*\)\s*\.addEventListener\(/g;
  let launchRegistration;
  for (const match of pageSource.matchAll(listenerPattern)) {
    if (
      match[1] === "btnLaunch" &&
      /^\s*"click"\s*,\s*async function\b/.test(
        pageSource.slice(match.index + match[0].length),
      )
    ) {
      launchRegistration = match;
      break;
    }
  }
  assert.ok(
    launchRegistration,
    "#btnLaunch has no chained async click listener",
  );

  listenerPattern.lastIndex =
    launchRegistration.index + launchRegistration[0].length;
  const nextRegistration = listenerPattern.exec(pageSource);
  assert.ok(
    nextRegistration,
    "#btnLaunch listener has no following listener boundary",
  );
  const handler = pageSource.slice(
    launchRegistration.index,
    nextRegistration.index,
  );

  for (const name of ["webglViewer", "webgpuViewer"]) {
    assert.match(
      handler,
      new RegExp(`window\\.${name}\\s*=`),
      `window.${name} is not assigned inside #btnLaunch's click handler`,
    );
  }
});
