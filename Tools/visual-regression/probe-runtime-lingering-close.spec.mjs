// probe-runtime-lingering-close.spec.mjs — a browser that lingers after the work is done.
// @purpose Pins the runtime's browser-close contract: the close deadline is a descriptor option with a loaded-machine default, a run whose cells and verdicts completed is published (receipt written, close recorded, exit by verdicts) when its browser close outlives the deadline or never settles, and a close that expires while work is incomplete stays an error.
// @status ACTIVE
//
// WHAT THIS PINS. `DX-KIT-INGEST-HARNESS-READINESS-BUDGET` part 2: at 74-100 %
// machine load `probe-landing-cells.mjs` exited 2 at teardown in 6 of 14 runs
// AFTER every capture was written, the hard stop fired about 30 s after the
// last capture, no report was written and a dead-owner lock was left. The
// assertions are on what a run does and publishes - exit code, files, the
// `browserCloses` records, which delays the lifecycle armed - through the real
// lifecycle with its timer, exit and diagnostic seams injected and a fake
// clock the fake browser advances, so nothing here waits in real time on a
// deadline.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import {
  deriveLifecycleDeadline,
  HARD_STOP_GRACE_MS,
  HARD_STOP_MARGIN_MS,
  LEGACY_CLOSE_DEADLINE_MS,
  RESOURCE_CLOSE_DEADLINE_MS,
  RUN_SETTLEMENT_MARGIN_MS,
  resolveCloseDeadlines,
} from "./lib/probe-lifecycle-run.mjs";
import { PROBE_EXIT_CODES, runProbe } from "./lib/probe-runtime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_PATH = path.join(here, "lib", "probe-runtime.mjs");
const LIFECYCLE_RUN_PATH = path.join(here, "lib", "probe-lifecycle-run.mjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A descriptor that completes its cells and computes a passing verdict. */
function descriptorFor(name, overrides = {}) {
  return {
    name,
    workBudgetMs: () => 5_000,
    async cells({ run }) {
      return [{ run, measured: true }];
    },
    receipt: (cells) => ({ cells }),
    verdicts: () => [{ id: "measured", pass: true }],
    ...overrides,
  };
}

/**
 * A browser whose close advances the fake clock, settles late, or never
 * settles.
 *
 * @param {{value: number}} clock The fake clock.
 * @param {object} [behaviour] `closeAdvancesMs`, `settleAfterMs`, `hang`.
 * @returns {object} The fake browser.
 */
function browserWith(clock, { closeAdvancesMs = 0, settleAfterMs = 0, hang }) {
  let connected = true;
  return {
    isConnected: () => connected,
    close: () => {
      clock.value += closeAdvancesMs;
      if (hang === true) {
        return new Promise(() => {});
      }
      return sleep(settleAfterMs).then(() => {
        connected = false;
      });
    },
  };
}

/**
 * Run a descriptor through `runProbe` with the lifecycle's seams injected.
 *
 * @param {string} root Repository root for the run.
 * @param {object} descriptor The probe descriptor.
 * @param {object} setup Run setup.
 * @param {Array<object>} setup.browsers One fake browser per run.
 * @param {number} [setup.runs] Runs to ask for.
 * @param {{value: number}} setup.clock The fake clock.
 * @param {(delay: number) => number} [setup.remap] Real delay to use for a lifecycle timer of this requested delay.
 * @param {Function} [setup.runProbeImpl] Runtime under test.
 * @returns {Promise<object>} What the run did.
 */
async function run(
  root,
  descriptor,
  {
    browsers,
    runs = 1,
    clock,
    remap = (delay) => delay,
    runProbeImpl = runProbe,
  },
) {
  const delays = [];
  const exits = [];
  const diagnostics = [];
  let launched = 0;
  const outcome = runProbeImpl(descriptor, {
    argv: ["--no-serve-built", "--repository-root", root, "--runs", `${runs}`],
    now: () => clock.value,
    launch: async () => browsers[launched++],
    lifecycleDependencies: {
      setTimeout(callback, delay) {
        delays.push(delay);
        return setTimeout(callback, remap(delay));
      },
      clearTimeout,
      exit: (code) => exits.push(code),
      writeDiagnostic: (text) => diagnostics.push(text.trim()),
    },
  });
  // The hard stop exits from inside the lifecycle, so `runProbe` may never
  // return: wait for whichever happens first.
  const settled = await Promise.race([
    outcome.then((exitCode) => ({ returned: true, exitCode })),
    (async () => {
      for (let waited = 0; waited < 3_000 && exits.length === 0; waited += 25) {
        await sleep(25);
      }
      return exits.length > 0 ? { returned: false, exitCode: exits[0] } : null;
    })(),
  ]);
  assert.ok(settled !== null, "the run neither returned nor hard-stopped");
  const directory = path.join(
    root,
    "Tools",
    "visual-regression",
    "output",
    descriptor.name,
  );
  const files = fs.existsSync(directory)
    ? fs.readdirSync(directory).sort()
    : [];
  const read = (file) =>
    JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
  return { ...settled, exits, delays, diagnostics, files, read };
}

const PUBLISHED = [
  "linger-report.json",
  "linger-runtime.json",
  "linger-summary.md",
];
const shortenCloseDeadline = (delay) =>
  delay === RESOURCE_CLOSE_DEADLINE_MS
    ? 0
    : delay === HARD_STOP_GRACE_MS
      ? 150
      : delay;
const shortenBoth = (delay) =>
  delay === RESOURCE_CLOSE_DEADLINE_MS
    ? 0
    : delay === HARD_STOP_GRACE_MS
      ? 3_000
      : delay;

test("the default close deadline covers a loaded machine and the hard stop sits above it", () => {
  const defaults = resolveCloseDeadlines({ name: "x" });
  assert.ok(
    defaults.closeDeadlineMs >= 60_000,
    "6 of 14 loaded-machine runs outlasted the old 10 s; 60 s failed once under foreign load",
  );
  assert.ok(defaults.closeDeadlineMs > LEGACY_CLOSE_DEADLINE_MS);
  assert.equal(defaults.closeDeadlineMs, RESOURCE_CLOSE_DEADLINE_MS);
  assert.equal(
    defaults.hardStopGraceMs,
    defaults.closeDeadlineMs + HARD_STOP_MARGIN_MS,
  );
  assert.equal(HARD_STOP_GRACE_MS, defaults.hardStopGraceMs);
  assert.ok(
    RUN_SETTLEMENT_MARGIN_MS > defaults.closeDeadlineMs,
    "the orderly deadline must not fire inside a bounded close",
  );
});

test("a descriptor closeDeadlineMs is honoured, keeps the margin above it and raises the settlement slack", () => {
  const raised = resolveCloseDeadlines({ name: "x", closeDeadlineMs: 120_000 });
  assert.deepEqual(raised, {
    closeDeadlineMs: 120_000,
    hardStopGraceMs: 120_000 + HARD_STOP_MARGIN_MS,
  });
  const base = deriveLifecycleDeadline(
    { runs: 1, timeoutMs: 1 },
    descriptorFor("x"),
  );
  const longer = deriveLifecycleDeadline(
    { runs: 1, timeoutMs: 1 },
    descriptorFor("x", { closeDeadlineMs: 200_000 }),
  );
  assert.equal(longer - base, 200_001 - RUN_SETTLEMENT_MARGIN_MS);
  for (const bad of [0, -1, 1.5, Number.NaN, "10", Infinity, 2_147_000_000]) {
    assert.throws(
      () => resolveCloseDeadlines({ name: "x", closeDeadlineMs: bad }),
      /closeDeadlineMs must be a positive safe integer/u,
      String(bad),
    );
  }
});

test("a runProbe descriptor's closeDeadlineMs reaches the lifecycle timers", () =>
  withLaneTmp("lingering-override-", async (root) => {
    const clock = { value: 1_000_000 };
    const result = await run(
      root,
      descriptorFor("linger", { closeDeadlineMs: 120_000 }),
      { clock, browsers: [browserWith(clock, {})] },
    );
    assert.equal(result.exitCode, PROBE_EXIT_CODES.OK);
    assert.ok(result.delays.includes(120_000));
    assert.ok(result.delays.includes(120_000 + HARD_STOP_MARGIN_MS));
    assert.ok(!result.delays.includes(RESOURCE_CLOSE_DEADLINE_MS));
    assert.equal(
      result.read("linger-runtime.json").browserCloses[0].deadlineMs,
      120_000,
    );
  }));

test("a close slower than the old 10 s but inside the new deadline publishes, exits 0 and records the close", () =>
  withLaneTmp("lingering-slow-", async (root) => {
    const clock = { value: 1_000_000 };
    const result = await run(root, descriptorFor("linger"), {
      clock,
      browsers: [browserWith(clock, { closeAdvancesMs: 25_000 })],
    });

    assert.equal(result.exitCode, PROBE_EXIT_CODES.OK);
    assert.deepEqual(result.exits, []);
    assert.deepEqual(result.files, PUBLISHED);
    assert.ok(result.delays.includes(RESOURCE_CLOSE_DEADLINE_MS));
    assert.ok(result.delays.includes(HARD_STOP_GRACE_MS));
    const [close, ...rest] = result.read("linger-runtime.json").browserCloses;
    assert.equal(rest.length, 0);
    assert.equal(close.run, 0);
    assert.equal(close.settled, true);
    assert.equal(close.closeMs, 25_000);
    assert.equal(close.deadlineMs, RESOURCE_CLOSE_DEADLINE_MS);
    assert.equal(close.legacyDeadlineMs, LEGACY_CLOSE_DEADLINE_MS);
    assert.equal(close.exceededLegacy, true);
    assert.equal(close.expired, false);
  }));

test("a quick close records exceededLegacy false and leaves the receipt shape alone", () =>
  withLaneTmp("lingering-quick-", async (root) => {
    const clock = { value: 1_000_000 };
    const result = await run(root, descriptorFor("linger"), {
      clock,
      browsers: [browserWith(clock, { closeAdvancesMs: 800 })],
    });
    assert.equal(result.exitCode, PROBE_EXIT_CODES.OK);
    const [close] = result.read("linger-runtime.json").browserCloses;
    assert.equal(close.exceededLegacy, false);
    assert.equal(close.expired, false);
    assert.equal(close.closeMs, 800);
  }));

test("a close that expires and then settles after complete work still publishes, exit by verdicts", () =>
  withLaneTmp("lingering-late-", async (root) => {
    const clock = { value: 1_000_000 };
    const result = await run(root, descriptorFor("linger"), {
      clock,
      remap: shortenBoth,
      browsers: [
        browserWith(clock, { closeAdvancesMs: 40_000, settleAfterMs: 60 }),
      ],
    });

    assert.equal(result.returned, true);
    assert.equal(result.exitCode, PROBE_EXIT_CODES.OK);
    assert.deepEqual(result.files, PUBLISHED);
    const [close] = result.read("linger-runtime.json").browserCloses;
    assert.equal(close.expired, true, "the lifecycle reported the deadline");
    assert.equal(close.settled, true);
    assert.equal(close.exceededLegacy, true);
  }));

test("a failing verdict still exits by the verdicts when the close lingered", () =>
  withLaneTmp("lingering-verdict-", async (root) => {
    const clock = { value: 1_000_000 };
    const result = await run(
      root,
      descriptorFor("linger", {
        verdicts: () => [{ id: "measured", pass: false }],
      }),
      {
        clock,
        remap: shortenBoth,
        browsers: [browserWith(clock, { settleAfterMs: 60 })],
      },
    );
    assert.deepEqual(result.files, PUBLISHED);
    assert.equal(result.exitCode, PROBE_EXIT_CODES.FAILURE);
  }));

test("a close that never settles after complete work: the hard stop banks the receipt and exits by verdicts, never 2", () =>
  withLaneTmp("lingering-hang-", async (root) => {
    const clock = { value: 1_000_000 };
    const result = await run(root, descriptorFor("linger"), {
      clock,
      remap: shortenCloseDeadline,
      browsers: [browserWith(clock, { hang: true })],
    });

    assert.equal(result.returned, false, "the hard stop exits from inside");
    assert.deepEqual(result.exits, [PROBE_EXIT_CODES.OK]);
    assert.notEqual(result.exits[0], PROBE_EXIT_CODES.ERROR);
    assert.deepEqual(result.files, PUBLISHED);
    const [close] = result.read("linger-runtime.json").browserCloses;
    assert.equal(close.settled, false);
    assert.equal(close.closeMs, null);
    assert.equal(close.expired, true);
    assert.deepEqual(result.read("linger-report.json").cells, [
      { run: 0, measured: true },
    ]);
    assert.ok(
      result.diagnostics.some((line) =>
        line.includes("did not reach quiescence before hard-stop grace"),
      ),
    );
  }));

test("a close that never settles after complete work exits by a failing verdict, not 2", () =>
  withLaneTmp("lingering-hang-verdict-", async (root) => {
    const clock = { value: 1_000_000 };
    const result = await run(
      root,
      descriptorFor("linger", {
        verdicts: () => [{ id: "measured", pass: false }],
      }),
      {
        clock,
        remap: shortenCloseDeadline,
        browsers: [browserWith(clock, { hang: true })],
      },
    );
    assert.deepEqual(result.exits, [PROBE_EXIT_CODES.FAILURE]);
    assert.deepEqual(result.files, PUBLISHED);
  }));

test("a close that never settles while a run's cells are incomplete exits 2 and publishes nothing, as before", () =>
  withLaneTmp("lingering-incomplete-hang-", async (root) => {
    const clock = { value: 1_000_000 };
    const result = await run(root, descriptorFor("linger"), {
      clock,
      runs: 2,
      remap: shortenCloseDeadline,
      browsers: [browserWith(clock, { hang: true }), browserWith(clock, {})],
    });

    assert.equal(result.returned, false);
    assert.deepEqual(result.exits, [PROBE_EXIT_CODES.ERROR]);
    assert.deepEqual(result.files, []);
  }));

test("a close that expires and settles while a run's cells are incomplete is an error with an incident", () =>
  withLaneTmp("lingering-incomplete-late-", async (root) => {
    const clock = { value: 1_000_000 };
    const result = await run(root, descriptorFor("linger"), {
      clock,
      runs: 2,
      remap: shortenBoth,
      browsers: [
        browserWith(clock, { settleAfterMs: 60 }),
        browserWith(clock, {}),
      ],
    });

    assert.equal(result.returned, true);
    assert.equal(result.exitCode, PROBE_EXIT_CODES.ERROR);
    assert.deepEqual(result.files, ["linger-error.json"]);
    const incident = result.read("linger-error.json");
    assert.equal(incident.outcome, "errored");
    assert.equal(incident.browserCloses[0].expired, true);
  }));

test("lingering work the descriptor left running is not a lingering browser", () =>
  withLaneTmp("lingering-undrained-", async (root) => {
    const clock = { value: 1_000_000 };
    const result = await run(
      root,
      descriptorFor("linger", {
        async cells({ run: index, scope }) {
          // Registered and never settling: the registry cannot drain.
          scope.run("unawaited work", () => new Promise(() => {}));
          return [{ run: index, measured: true }];
        },
      }),
      {
        clock,
        remap: shortenCloseDeadline,
        browsers: [browserWith(clock, { hang: true })],
      },
    );
    assert.deepEqual(result.exits, [PROBE_EXIT_CODES.ERROR]);
    assert.deepEqual(result.files, []);
  }));

// ---------------------------------------------------------------------------
// INERTNESS: each clause made unreachable turns the cases above red.
// ---------------------------------------------------------------------------

test("INERTNESS: with the complete-work exemption unreachable, a late close is an error again", () =>
  withLaneTmp("lingering-inert-late-", async (root) => {
    const mutated = await importMutated(RUNTIME_PATH, [
      [
        "lifecycleAdopted && assessLifecycleFailure(error, lifecycleState);",
        "false && lifecycleAdopted && assessLifecycleFailure(error, lifecycleState);",
      ],
    ]);
    const clock = { value: 1_000_000 };
    const result = await run(root, descriptorFor("linger"), {
      clock,
      remap: shortenBoth,
      runProbeImpl: mutated.runProbe,
      browsers: [browserWith(clock, { settleAfterMs: 60 })],
    });
    assert.equal(result.exitCode, PROBE_EXIT_CODES.ERROR);
    assert.deepEqual(result.files, ["linger-error.json"]);
  }));

/**
 * Drive the lifecycle body directly with a browser whose close never settles
 * after complete work, and report what the hard stop did.
 *
 * @param {object} lifecycleRun The `probe-lifecycle-run.mjs` namespace under test.
 * @param {string} root Repository root for the lock file.
 * @returns {Promise<{exits: number[], finalized: number}>} The hard stop's effects.
 */
async function driveHungClose(lifecycleRun, root) {
  const exits = [];
  let finalized = 0;
  const clock = { value: 1_000_000 };
  await Promise.race([
    lifecycleRun
      .runDescriptorUnderLifecycle({
        descriptor: descriptorFor("linger"),
        options: { runs: 1, timeoutMs: 120_000, headed: false, port: 8080 },
        origin: "http://localhost:8080",
        outputDirectory: root,
        repositoryRoot: root,
        captures: [],
        cells: [],
        launchArgs: [],
        edgeSlotLockPath: path.join(root, `.edge-slot-${Math.random()}.lock`),
        preflight: async () => {},
        launch: async () => browserWith(clock, { hang: true }),
        now: () => clock.value,
        finalizeOnHardStop: () => {
          finalized++;
          return PROBE_EXIT_CODES.OK;
        },
        lifecycleDependencies: {
          setTimeout: (callback, delay) =>
            setTimeout(callback, shortenCloseDeadline(delay)),
          clearTimeout,
          exit: (code) => exits.push(code),
          writeDiagnostic: () => {},
        },
        state: { slot: null, verdicts: [] },
      })
      .catch(() => undefined),
    sleep(1_000),
  ]);
  return { exits, finalized };
}

test("the hard stop calls the finalizer for a complete run and exits with what it returns", () =>
  withLaneTmp("lingering-hook-", async (root) => {
    const real = await import("./lib/probe-lifecycle-run.mjs");
    assert.deepEqual(await driveHungClose(real, root), {
      exits: [PROBE_EXIT_CODES.OK],
      finalized: 1,
    });
  }));

test("INERTNESS: with the hard-stop hook unreachable, a hung close exits 2 with no finalizer call", () =>
  withLaneTmp("lingering-inert-hang-", async (root) => {
    const mutated = await importMutated(LIFECYCLE_RUN_PATH, [
      [
        "return onlyLingeringClose(raws, state)",
        "return false && onlyLingeringClose(raws, state)",
      ],
    ]);
    assert.deepEqual(await driveHungClose(mutated, root), {
      exits: [PROBE_EXIT_CODES.ERROR],
      finalized: 0,
    });
  }));

test("INERTNESS: the default close deadline reverted to 10 s fails the loaded-machine bar", async () => {
  const mutated = await importMutated(LIFECYCLE_RUN_PATH, [
    [
      "export const RESOURCE_CLOSE_DEADLINE_MS = 90_000;",
      "export const RESOURCE_CLOSE_DEADLINE_MS = 10_000;",
    ],
  ]);
  const { closeDeadlineMs } = mutated.resolveCloseDeadlines({ name: "x" });
  assert.equal(closeDeadlineMs, LEGACY_CLOSE_DEADLINE_MS);
  assert.ok(
    closeDeadlineMs < 60_000,
    "the mutant carries the old value, which the default test above refuses",
  );
});
