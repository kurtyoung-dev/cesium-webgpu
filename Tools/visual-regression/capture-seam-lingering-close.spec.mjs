// capture-seam-lingering-close.spec.mjs — the capture seam publishes a complete capture whose browser close lingers.
// @purpose Pins that capture() applies the same complete-work exemption as runProbe (lib/probe-close-exemption.mjs): a capture whose cells all returned is published, with the close in the receipt's browserCloses, when its browser close outlives the deadline or never settles, while an incomplete capture fails exactly as before.
// @status ACTIVE
//
// WHAT THIS PINS. Batch 1638 let `runProbe` publish a run whose cells and
// verdicts were complete when only the browser close lingered. The capture seam
// has its own close deadline (`DEFAULT_CLOSE_DEADLINE_MS`) and its own
// lifecycle path, and used to lose such a capture: an incident file instead of
// a manifest. The assertions are on what a capture does - what it returns,
// rejects with, writes through its writer seam, which exit codes the lifecycle
// is handed - through the REAL lifecycle with its timer, exit and diagnostic
// seams injected and a fake clock the fake browser advances, so nothing waits
// in real time on a deadline.
//
// THE MUTANTS. Each INERTNESS case imports `lib/capture.mjs` from a copy with
// one clause made unreachable and replays the scenario the clause serves; the
// last one swaps the SHARED piece for a mutated copy underneath the real
// capture seam, so a defect in the one rule both callers use is caught here and
// not only in the runtime's spec.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { importMutated } from "./lib/import-mutated.mjs";
import { capture } from "./lib/capture.mjs";
import * as shared from "./lib/probe-close-exemption.mjs";
import * as lifecycleRun from "./lib/probe-lifecycle-run.mjs";
import { PROBE_EXIT_CODES } from "./lib/probe-runtime.mjs";

const HERE = new URL("./", import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE_PATH = path.join(here, "lib", "capture.mjs");
const SHARED_PATH = path.join(here, "lib", "probe-close-exemption.mjs");

const { ORIGINS, splitScreenRig } = await import(
  new URL("fixtures/capture-seam/rigs.mjs", HERE).href
);
const fixturePng = (name) =>
  readFileSync(fileURLToPath(new URL(`fixtures/capture-seam/${name}`, HERE)));
const BEFORE_PNG = fixturePng("before.png");
const AFTER_PNG = fixturePng("after.png");

const FIXED_NOW = Date.UTC(2026, 9, 31, 12, 0, 0);
const CLOSE_DEADLINE_MS = 5_000;
const HARD_GRACE_MS = 7_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fixture bytes for every cell; `throwOn` models a cell that fails. */
function cellWorkWith({ throwOn } = {}) {
  return async (cell) => {
    if (cell.key === throwOn) {
      throw new Error(`injected cell failure at ${cell.key}`);
    }
    return {
      buffer: cell.slot === "BEFORE" ? BEFORE_PNG : AFTER_PNG,
      url: cell.url,
      capturedAt: new Date(FIXED_NOW).toISOString(),
    };
  };
}

/**
 * Run `capture()` with every impure seam injected and the lifecycle's real
 * state machine in the middle.
 *
 * @param {object} setup Setup.
 * @param {Function} [setup.captureImpl] The capture seam under test.
 * @param {object} [setup.browser] `closeAdvancesMs`, `settleAfterMs`, `hang`, `rejectWith`.
 * @param {Function} [setup.cellWork] The per-cell body.
 * @param {number} [setup.graceRealMs] Real delay for the hard-stop grace.
 * @param {boolean} [setup.expireClose] Fire the close deadline at once (the default), or let it run its real length.
 * @returns {Promise<object>} What the run did.
 */
async function drive({
  captureImpl = capture,
  browser: behaviour = {},
  cellWork = cellWorkWith(),
  graceRealMs = 3_000,
  expireClose = true,
} = {}) {
  const clock = { value: FIXED_NOW };
  const written = new Map();
  const exits = [];
  const diagnostics = [];
  let launches = 0;
  const outcome = captureImpl(
    splitScreenRig,
    ORIGINS,
    {
      captureId: "lingering-close",
      repositoryRoot: fileURLToPath(new URL("../../", HERE)),
      closeDeadlineMs: CLOSE_DEADLINE_MS,
      hardStopGraceMs: HARD_GRACE_MS,
      cellWork,
    },
    {
      launch: async () => {
        launches++;
        let connected = true;
        return {
          isConnected: () => connected,
          close: () => {
            clock.value += behaviour.closeAdvancesMs ?? 0;
            if (behaviour.hang === true) {
              return new Promise(() => {});
            }
            return sleep(behaviour.settleAfterMs ?? 0).then(() => {
              connected = false;
              if (behaviour.rejectWith !== undefined) {
                throw behaviour.rejectWith;
              }
            });
          },
        };
      },
      preflight: async ({ origin, artifacts }) => ({
        ok: true,
        origin,
        artifacts: artifacts.map((artifact) => ({
          path: artifact,
          match: true,
        })),
      }),
      acquireSlot: async (options, body) => {
        let settleClosed;
        let settleRelease;
        const whenClosed = new Promise((resolve) => (settleClosed = resolve));
        const releaseOutcome = new Promise(
          (resolve) => (settleRelease = resolve),
        );
        options.onLeaseObservation?.({ whenClosed, releaseOutcome });
        try {
          return await body({
            owner: options.owner,
            pid: 4242,
            acquiredAt: options.now,
            reclaimed: null,
            loss: new Promise(() => {}),
            assertHeld: () => {},
          });
        } finally {
          settleClosed(undefined);
          settleRelease({ succeeded: true });
        }
      },
      writeFile: (file, body) => written.set(file, body),
      mkdir: () => {},
      now: () => clock.value,
      lifecycleDependencies: {
        setTimeout: (callback, delay) =>
          setTimeout(
            callback,
            expireClose && delay === CLOSE_DEADLINE_MS
              ? 0
              : delay === HARD_GRACE_MS
                ? graceRealMs
                : delay,
          ),
        clearTimeout,
        exit: (code) => exits.push(code),
        writeDiagnostic: (text) => diagnostics.push(text.trim()),
      },
    },
  ).then(
    (value) => ({ status: "resolved", value }),
    (error) => ({ status: "rejected", error }),
  );
  // A hard stop exits from inside the lifecycle, so `capture` may never
  // return: wait for whichever happens first.
  const settled = await Promise.race([
    outcome,
    (async () => {
      for (let waited = 0; waited < 4_000 && exits.length === 0; waited += 25) {
        await sleep(25);
      }
      return exits.length > 0 ? { status: "hard-stopped" } : null;
    })(),
  ]);
  assert.ok(settled !== null, "the capture neither returned nor hard-stopped");
  const files = [...written.keys()].map((file) => path.basename(file));
  const read = (name) => {
    const key = [...written.keys()].find(
      (file) => path.basename(file) === name,
    );
    assert.ok(key, `${name} was written (wrote: ${files.join(", ")})`);
    return JSON.parse(written.get(key));
  };
  return { ...settled, exits, diagnostics, written, files, read, launches };
}

const MANIFEST = "capture-manifest.json";
const hasIncident = (run) => run.files.some((name) => /incident/u.test(name));

test("a healthy capture records its quick close and publishes as before", async () => {
  const run = await drive({
    browser: { closeAdvancesMs: 800 },
    expireClose: false,
  });
  assert.equal(run.status, "resolved");
  assert.deepEqual(run.exits, []);
  assert.equal(run.value.receipt.cells.measured, 4);
  const [close, ...rest] = run.value.receipt.browserCloses;
  assert.equal(rest.length, 0);
  assert.equal(close.run, 0);
  assert.equal(close.settled, true);
  assert.equal(close.closeMs, 800);
  assert.equal(close.deadlineMs, CLOSE_DEADLINE_MS);
  assert.equal(close.expired, false);
  assert.equal(close.exceededLegacy, false);
});

test("complete cells + a close that expires and settles late: manifest and receipt are written, the close is recorded, no error", async () => {
  const run = await drive({
    browser: { closeAdvancesMs: 40_000, settleAfterMs: 60 },
  });
  assert.equal(run.status, "resolved", "the capture is not lost");
  assert.deepEqual(run.exits, [], "no hard stop");
  assert.ok(run.files.includes(MANIFEST));
  assert.ok(run.written.has(run.value.receiptPath));
  assert.equal(run.value.manifest.rigs[0].cells.webgl.BEFORE.state, "MEASURED");
  assert.equal(
    hasIncident(run),
    false,
    "a published capture leaves no incident",
  );
  const [close] = run.value.receipt.browserCloses;
  assert.equal(close.expired, true, "the lifecycle reported the deadline");
  assert.equal(close.settled, true);
  assert.equal(close.closeMs, 40_000);
  assert.equal(close.exceededLegacy, true);
  const onDisk = JSON.parse(run.written.get(run.value.receiptPath));
  assert.equal(onDisk.browserCloses[0].expired, true);
  assert.ok(
    run.diagnostics.some((line) => line.includes("outlived its deadline")),
    "the published close is said aloud",
  );
});

test("complete cells + a close that never settles: the hard stop publishes the manifest and receipt and exits 0, never 2", async () => {
  const run = await drive({ browser: { hang: true }, graceRealMs: 150 });
  assert.equal(run.status, "hard-stopped");
  assert.deepEqual(run.exits, [PROBE_EXIT_CODES.OK]);
  assert.ok(run.files.includes(MANIFEST), `wrote ${run.files.join(", ")}`);
  const receiptName = run.files.find((name) => /receipt|report/u.test(name));
  assert.ok(receiptName, "a receipt was written");
  const [close] = run.read(receiptName).browserCloses;
  assert.equal(close.settled, false);
  assert.equal(close.closeMs, null);
  assert.equal(close.expired, true);
  assert.equal(
    hasIncident(run),
    false,
    "the published capture banks no incident",
  );
  assert.ok(
    run.diagnostics.some((line) =>
      line.includes("did not reach quiescence before hard-stop grace"),
    ),
    "the lifecycle still says it hard-stopped",
  );
});

test("an incomplete capture with a lingering close still rejects with the cell failure and publishes nothing", async () => {
  const run = await drive({
    browser: { closeAdvancesMs: 40_000, settleAfterMs: 60 },
    cellWork: cellWorkWith({ throwOn: "seam-split-screen|webgpu|BEFORE" }),
  });
  assert.equal(run.status, "rejected");
  assert.match(
    [run.error.message, run.error.primaryCause?.message ?? ""].join("\n"),
    /injected cell failure at seam-split-screen\|webgpu\|BEFORE/u,
  );
  assert.equal(run.files.includes(MANIFEST), false);
  assert.equal(run.written.size, 0, "nothing was written");
});

test("an incomplete capture whose close never settles hard-stops with exit 2, an incident and no manifest", async () => {
  const run = await drive({
    browser: { hang: true },
    graceRealMs: 150,
    cellWork: cellWorkWith({ throwOn: "seam-split-screen|webgpu|BEFORE" }),
  });
  assert.equal(run.status, "hard-stopped");
  assert.deepEqual(run.exits, [PROBE_EXIT_CODES.ERROR]);
  assert.equal(hasIncident(run), true, "the incident is banked");
  assert.equal(run.files.includes(MANIFEST), false);
});

test("a close that FAILS (not a deadline) after complete cells is not exempt", async () => {
  const run = await drive({
    browser: {
      rejectWith: new Error("Target page, context or browser has been closed"),
    },
    expireClose: false,
  });
  assert.equal(run.status, "rejected");
  assert.equal(run.files.includes(MANIFEST), false);
});

// ---------------------------------------------------------------------------
// The shared piece, driven directly.
// ---------------------------------------------------------------------------

const closeDeadline = (resource = "probe browser") => ({
  details: { kind: "close-deadline", resource },
});
const orderly = () => ({ details: { kind: "orderly-deadline" } });

test("onlyLingeringClose: complete work + close deadlines (+ orderly) only", () => {
  const complete = { complete: true, closes: [] };
  assert.equal(shared.onlyLingeringClose([closeDeadline()], complete), true);
  assert.equal(
    shared.onlyLingeringClose([closeDeadline(), orderly()], complete),
    true,
  );
  assert.equal(shared.onlyLingeringClose([orderly()], complete), false);
  assert.equal(shared.onlyLingeringClose([], complete), false);
  assert.equal(
    shared.onlyLingeringClose([closeDeadline(), new Error("cell")], complete),
    false,
  );
  assert.equal(
    shared.onlyLingeringClose([closeDeadline()], {
      complete: false,
      closes: [],
    }),
    false,
  );
  assert.equal(
    shared.onlyLingeringClose([closeDeadline()], {
      complete: true,
      closes: [{ expired: true, drained: false }],
    }),
    false,
    "an expired close that had not drained its work is not lingering",
  );
});

test("assessLifecycleFailure marks the expired close and reads the primary cause", () => {
  const state = {
    complete: true,
    closes: [
      shared.createCloseRecord({
        run: 0,
        label: "probe browser",
        deadlineMs: 5_000,
        startedAt: 0,
      }),
    ],
  };
  state.closes[0].drained = true;
  const error = {
    failureOccurrences: [{ raw: closeDeadline("probe browser") }],
    primaryCause: closeDeadline("probe browser"),
  };
  assert.equal(shared.assessLifecycleFailure(error, state), true);
  assert.equal(state.closes[0].expired, true);
  assert.equal(
    shared.assessLifecycleFailure(
      { ...error, primaryCause: new Error("a cell failed first") },
      state,
    ),
    false,
  );
  assert.equal(shared.assessLifecycleFailure(new Error("plain"), state), false);
});

test("describeBrowserCloses measures an unsettled close to now and reports the legacy bar", () => {
  const record = shared.createCloseRecord({
    run: 1,
    label: "b",
    deadlineMs: 5_000,
    startedAt: 100,
  });
  const [hung] = shared.describeBrowserCloses(
    { closes: [record] },
    () => 20_100,
  );
  assert.deepEqual(
    {
      settled: hung.settled,
      closeMs: hung.closeMs,
      elapsedMs: hung.elapsedMs,
      expired: hung.expired,
      exceededLegacy: hung.exceededLegacy,
    },
    {
      settled: false,
      closeMs: null,
      elapsedMs: 20_000,
      expired: true,
      exceededLegacy: true,
    },
  );
  record.closeMs = 300;
  const [quick] = shared.describeBrowserCloses(
    { closes: [record] },
    () => 20_100,
  );
  assert.equal(quick.expired, false);
  assert.equal(quick.exceededLegacy, false);
});

test("runProbe's lifecycle module and the capture seam apply ONE implementation", () => {
  for (const name of [
    "assessLifecycleFailure",
    "describeBrowserCloses",
    "onlyLingeringClose",
    "recordCloseExpiries",
    "LEGACY_CLOSE_DEADLINE_MS",
  ]) {
    assert.equal(lifecycleRun[name], shared[name], name);
  }
});

// ---------------------------------------------------------------------------
// INERTNESS: each clause made unreachable turns the cases above red.
// ---------------------------------------------------------------------------

const lateClose = { closeAdvancesMs: 40_000, settleAfterMs: 60 };

test("INERTNESS: with the capture seam's exemption call unreachable, a late close loses the capture again", async () => {
  const mutated = await importMutated(CAPTURE_PATH, [
    [
      "const lingering = assessLifecycleFailure(error, closeState);",
      "const lingering = false && assessLifecycleFailure(error, closeState);",
    ],
  ]);
  const run = await drive({ captureImpl: mutated.capture, browser: lateClose });
  assert.equal(run.status, "rejected");
  assert.equal(run.files.includes(MANIFEST), false);
});

test("INERTNESS: with the capture seam's completeness mark unreachable, a late close is an error again", async () => {
  const mutated = await importMutated(CAPTURE_PATH, [
    ["closeState.complete = true;", "closeState.complete = false;"],
  ]);
  const run = await drive({ captureImpl: mutated.capture, browser: lateClose });
  assert.equal(run.status, "rejected");
});

test("INERTNESS: with the capture seam's hard-stop hook unreachable, a hung close exits 2 and publishes nothing", async () => {
  const mutated = await importMutated(CAPTURE_PATH, [
    [
      "if (!onlyLingeringClose(raws, closeState)) {",
      "if (true || !onlyLingeringClose(raws, closeState)) {",
    ],
  ]);
  const run = await drive({
    captureImpl: mutated.capture,
    browser: { hang: true },
    graceRealMs: 150,
  });
  assert.deepEqual(run.exits, [PROBE_EXIT_CODES.ERROR]);
  assert.equal(run.files.includes(MANIFEST), false);
});

test("INERTNESS: with the close record never written, the receipt carries no browserCloses", async () => {
  const mutated = await importMutated(CAPTURE_PATH, [
    [
      "closeState.closes.push(record);",
      "false && closeState.closes.push(record);",
    ],
  ]);
  const run = await drive({
    captureImpl: mutated.capture,
    browser: { closeAdvancesMs: 800 },
    expireClose: false,
  });
  assert.equal(run.status, "resolved");
  assert.equal(run.value.receipt.browserCloses, undefined);
});

/** The capture seam, built over a mutated copy of the SHARED piece. */
async function captureOverMutatedShared(replacements) {
  let source = readFileSync(SHARED_PATH, "utf8").replace(/\r\n/gu, "\n");
  for (const [anchor, replacement] of replacements) {
    assert.equal(source.split(anchor).length - 1, 1, `anchor once: ${anchor}`);
    source = source.replace(anchor, () => replacement);
  }
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const sharedHref = new URL(
    "./probe-close-exemption.mjs",
    pathToFileURL(CAPTURE_PATH),
  ).href;
  return importMutated(CAPTURE_PATH, [
    [`from "${sharedHref}"`, `from "${dataUrl}"`],
  ]);
}

test("INERTNESS: the shared rule's completeness clause made unreachable loses the capture, through the real capture seam", async () => {
  const mutated = await captureOverMutatedShared([
    [
      "if (state.complete !== true || raws.length === 0) {",
      "if (true || state.complete !== true || raws.length === 0) {",
    ],
  ]);
  const run = await drive({ captureImpl: mutated.capture, browser: lateClose });
  assert.equal(run.status, "rejected");
  const hung = await drive({
    captureImpl: mutated.capture,
    browser: { hang: true },
    graceRealMs: 150,
  });
  assert.deepEqual(hung.exits, [PROBE_EXIT_CODES.ERROR]);
});

test("INERTNESS: the shared rule's drained clause made unreachable lets an undrained expired close through", async () => {
  const mutated = await importMutated(SHARED_PATH, [
    [
      "(record) => record.expired !== true || record.drained === true,",
      "(record) => true || record.expired !== true || record.drained === true,",
    ],
  ]);
  const undrained = {
    complete: true,
    closes: [{ expired: true, drained: false }],
  };
  assert.equal(shared.onlyLingeringClose([closeDeadline()], undrained), false);
  assert.equal(
    mutated.onlyLingeringClose([closeDeadline()], undrained),
    true,
    "the mutant differs from the real rule on exactly this input",
  );
});
