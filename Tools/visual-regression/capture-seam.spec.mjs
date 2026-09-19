// Behaviour spec for lib/capture.mjs (DX-104) — drives the real capture seam
// and asserts only OUTPUTS: a returned value, a thrown refusal's reason, the
// bytes handed to the writer, and how many times a browser double was opened
// and closed.
//
// @purpose Pin DX-104's capture seam: origins are required and never defaulted, a rig's declared origin is re-based onto the caller's, exactly one browser is opened and closed even on the throw path, and the manifest carries no verdict.
// @status ACTIVE
//
// NO BROWSER, NO GIT, NO NETWORK. Every impure seam is injected: the launcher,
// the Edge slot, the served-build preflight, the clock and the two filesystem
// calls. The PNG bytes come from checked-in fixtures under
// `fixtures/capture-seam/`, decoded by the real `Tools/lib/png-decode.mjs`, so
// the metric assertions run over real image bytes rather than over a stub that
// agrees with the code by construction. A spec that shelled out to `git` would
// have died the instant its own batch landed (KIT-A's review caught exactly
// that), so nothing here reads anything but files that ship beside it.
//
// THE ONE REWRITABLE LINE. `HERE` below is the only place this file names its
// own location, and the `capture.mjs` import specifier is the only place it
// names the module under test. The inertness-mutant harness copies this file
// to a temp directory and rewrites exactly those two, so a mutated copy of
// `lib/capture.mjs` can be driven by this same spec without the spec's
// fixtures or its sibling imports moving.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CAPTURE_SLOTS,
  CELL_METRIC_PROVENANCE,
  CELL_STATES,
  DEFAULT_CLOSE_DEADLINE_MS,
  DEFAULT_PAIR_TOLERANCE,
  DEFAULT_READINESS_POLL_INTERVAL_MS,
  MAX_READINESS_POLLS,
  MAX_TIMING_OPTION_MS,
  READINESS_PREDICATES,
  TIMING_OPTION_REFUSAL,
  buildCaptureDescriptor,
  buildCaptureIncident,
  capture,
  captureUrlFor,
  cellMetrics,
  decideCaptureRefusal,
  decideCellReadinessRefusal,
  deriveCaptureDeadline,
  describeReadiness,
  pairMetrics,
  pollReadiness,
  summariseCellReadiness,
  waitForCellReadiness,
  resolveCaptureOrigins,
  resolveRigPage,
  validateManifest,
} from "./lib/capture.mjs";
import { decodePng } from "../lib/png-decode.mjs";
import {
  LAUNCH_BUDGET_MS,
  PREFLIGHT_BUDGET_MS,
  RUN_SETTLEMENT_MARGIN_MS,
} from "./lib/probe-lifecycle-run.mjs";
import { ProbeRefusal } from "./lib/probe-refusal.mjs";
import { loadRigs, rigById } from "./lib/rig-registry.mjs";
import {
  findVerdictTokens,
  renderSheetHtml,
  sheetModel,
  validateManifest as validateManifestForTheSheet,
} from "./lib/contact-sheet-page.mjs";

const HERE = new URL("./", import.meta.url);

const FIXTURE_RIGS = await import(
  new URL("fixtures/capture-seam/rigs.mjs", HERE).href
);
const { ORIGINS, seedRig, splitScreenRig, viewerRig } = FIXTURE_RIGS;

function fixturePng(name) {
  return readFileSync(
    fileURLToPath(new URL(`fixtures/capture-seam/${name}`, HERE)),
  );
}

const BEFORE_PNG = fixturePng("before.png");
const AFTER_PNG = fixturePng("after.png");
const BLACK_PNG = fixturePng("black-4x4.png");

// Rec. 709, written out here rather than imported, so the expected values
// below are derived from the standard and not from the code under test.
const rec709 = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const FIXED_NOW = Date.UTC(2026, 8, 19, 1, 23, 45, 678);

/** The real rig registry, loaded once: the census case below reads the DATA. */
const REGISTRY_RIGS = await loadRigs();

/**
 * Every impure seam, with counters. The browser double records its own opens
 * and closes, so "exactly one browser was launched and closed" is an assertion
 * about the double's observed lifecycle rather than about the source text.
 */
function makeSeams({ cellWork, preflightOk = true, closeRejectsWith } = {}) {
  const seams = {
    launches: [],
    closes: 0,
    slots: [],
    slotReleases: 0,
    preflights: [],
    written: new Map(),
    directories: [],
    cellCalls: [],
  };
  seams.dependencies = {
    launch: async (options) => {
      seams.launches.push(options);
      let connected = true;
      return {
        close: async () => {
          // The browser really does go away; `closeRejectsWith` models the
          // shape playwright actually produces — a close that TEARS DOWN and
          // then reports "Target page, context or browser has been closed".
          connected = false;
          seams.closes++;
          if (closeRejectsWith !== undefined) {
            throw closeRejectsWith;
          }
        },
        // The lifecycle proves closure by OBSERVING it, so the double reports
        // what it actually did rather than agreeing that close was called.
        isConnected: () => connected,
      };
    },
    // The slot reaches the lifecycle as its own `edgeSlot` dependency, so the
    // double owes the lease observations the lifecycle reads: a `loss` that
    // does not settle while the run is healthy, and a release that reports
    // success. An absent `loss` resolves immediately and would put every run
    // into draining before its first cell.
    acquireSlot: async (options, body) => {
      seams.slots.push(options);
      let settleClosed;
      let settleRelease;
      const whenClosed = new Promise((resolve) => {
        settleClosed = resolve;
      });
      const releaseOutcome = new Promise((resolve) => {
        settleRelease = resolve;
      });
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
        seams.slotReleases++;
        settleClosed(undefined);
        settleRelease({ succeeded: true });
      }
    },
    preflight: async ({ origin, artifacts }) => {
      seams.preflights.push(origin);
      return {
        ok: preflightOk,
        origin,
        artifacts: artifacts.map((path) => ({ path, match: preflightOk })),
      };
    },
    writeFile: (file, body) => seams.written.set(file, body),
    mkdir: (directory) => seams.directories.push(directory),
    now: () => FIXED_NOW,
  };
  if (cellWork !== undefined) {
    seams.cellWork = cellWork;
  }
  return seams;
}

/** A cell body that returns fixture bytes and records which cells ran. */
function fixtureCellWork(seams, { throwOn } = {}) {
  return async (cell) => {
    seams.cellCalls.push(cell.key);
    if (throwOn !== undefined && cell.key === throwOn) {
      throw new Error(`injected cell failure at ${cell.key}`);
    }
    return {
      buffer: cell.slot === "BEFORE" ? BEFORE_PNG : AFTER_PNG,
      url: cell.url,
      capturedAt: new Date(FIXED_NOW).toISOString(),
    };
  };
}

const baseOptions = {
  captureId: "kit-b-seam",
  repositoryRoot: fileURLToPath(new URL("../../", HERE)),
};

// ---------------------------------------------------------------------------
// A. A rig's declared origin is stripped, and the caller's is what gets fetched
// ---------------------------------------------------------------------------

test("A. resolveRigPage normalises both declared forms and page: null", () => {
  assert.deepEqual(resolveRigPage(viewerRig), {
    kind: "relative",
    path: "Apps/CesiumViewer/index.html",
  });

  assert.deepEqual(resolveRigPage(splitScreenRig), {
    kind: "absolute",
    path: "Apps/WebGPUTest/split-screen-comparison.html",
    declaredOrigin: "http://localhost:8080",
  });

  assert.deepEqual(resolveRigPage(seedRig), {
    kind: "none",
    reason: "rig declares page: null — no page exists for this rig yet",
  });
});

test("A. an absolute rig url is RE-BASED onto the caller's origin, not passed through", () => {
  const url = captureUrlFor({
    rig: splitScreenRig,
    origin: "http://localhost:8095",
  });
  assert.equal(
    url,
    "http://localhost:8095/Apps/WebGPUTest/split-screen-comparison.html",
  );
  assert.equal(
    url.includes("8080"),
    false,
    "the rig's own 8080 must not survive into the fetched url",
  );
  assert.equal(
    new URL(url).origin,
    "http://localhost:8095",
    "the caller's origin is what is fetched",
  );
});

test("A. the same re-basing holds for a rig loaded from the real registry", async () => {
  const globeDefault = rigById(await loadRigs(), "globe-default");
  assert.ok(globeDefault, "the registry still carries globe-default");
  const page = resolveRigPage(globeDefault);
  assert.equal(page.kind, "absolute");
  assert.equal(page.declaredOrigin, "http://localhost:8080");
  assert.equal(
    captureUrlFor({ rig: globeDefault, origin: "http://127.0.0.1:8099" }),
    "http://127.0.0.1:8099/Apps/WebGPUTest/split-screen-comparison.html",
  );
});

test("A. a rig with no page refuses by name rather than guessing a url", () => {
  assert.throws(
    () => captureUrlFor({ rig: seedRig, origin: ORIGINS.BEFORE }),
    (error) => {
      assert.equal(error.name, "ProbeRefusal");
      assert.equal(error.reason, "capture-rig-has-no-page");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// B. Origins are required. There is no default, and absence is a refusal.
// ---------------------------------------------------------------------------

test("B. a missing origin is the refusal capture-origin-absent, never a default", () => {
  const noneAtAll = resolveCaptureOrigins({});
  assert.equal(noneAtAll.ok, false);
  assert.equal(noneAtAll.reason, "capture-origin-absent");
  assert.deepEqual(noneAtAll.details.missing, [...CAPTURE_SLOTS]);

  const halfDeclared = resolveCaptureOrigins({
    origins: { BEFORE: "http://localhost:8094" },
  });
  assert.equal(halfDeclared.ok, false);
  assert.equal(halfDeclared.reason, "capture-origin-absent");
  assert.deepEqual(halfDeclared.details.missing, ["AFTER"]);

  const blank = resolveCaptureOrigins({
    origins: { BEFORE: "http://localhost:8094", AFTER: "   " },
  });
  assert.equal(blank.ok, false);
  assert.equal(blank.reason, "capture-origin-absent");
  assert.deepEqual(blank.details.missing, ["AFTER"]);
});

test("B. an unusable origin is capture-origin-invalid and names the slot", () => {
  const refused = resolveCaptureOrigins({
    origins: { BEFORE: "http://localhost:8094", AFTER: "ftp://elsewhere/" },
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "capture-origin-invalid");
  assert.deepEqual(
    refused.details.invalid.map((entry) => entry.slot),
    ["AFTER"],
  );
});

test("B. an accepted pair is recorded VERBATIM, not normalised", () => {
  const accepted = resolveCaptureOrigins({
    origins: {
      BEFORE: "http://localhost:8094",
      AFTER: "http://localhost:8095",
    },
  });
  assert.equal(accepted.ok, true);
  assert.deepEqual(
    { ...accepted.origins },
    {
      BEFORE: "http://localhost:8094",
      AFTER: "http://localhost:8095",
    },
  );
});

test("B. decideCaptureRefusal refuses an absent origin before anything else", () => {
  const decision = decideCaptureRefusal({
    rig: splitScreenRig,
    origins: undefined,
  });
  assert.equal(decision.refuse, true);
  assert.equal(decision.reason, "capture-origin-absent");
});

test("B. capture() refuses an absent origin WITHOUT opening a browser", async () => {
  const seams = makeSeams();
  await assert.rejects(
    () => capture(splitScreenRig, undefined, baseOptions, seams.dependencies),
    (error) => {
      assert.equal(error.name, "ProbeRefusal");
      assert.equal(error.reason, "capture-origin-absent");
      assert.equal(
        /localhost:8080/.test(error.message),
        false,
        "the refusal must not name a default origin",
      );
      return true;
    },
  );
  assert.equal(seams.launches.length, 0);
  assert.equal(seams.preflights.length, 0);
  assert.equal(seams.written.size, 0);
});

// ---------------------------------------------------------------------------
// C. One browser per run, closed in a finally — including on the throw path
// ---------------------------------------------------------------------------

test("C. THROW PATH: exactly one browser is launched and exactly one is closed", async () => {
  const seams = makeSeams();
  const options = {
    ...baseOptions,
    cellWork: fixtureCellWork(seams, {
      throwOn: "seam-split-screen|webgl|AFTER",
    }),
  };

  await assert.rejects(
    () => capture(splitScreenRig, ORIGINS, options, seams.dependencies),
    /injected cell failure at seam-split-screen\|webgl\|AFTER/,
  );

  assert.equal(seams.launches.length, 1, "one browser was opened");
  assert.equal(seams.closes, 1, "and it was closed on the way out");
  assert.deepEqual(
    seams.cellCalls,
    ["seam-split-screen|webgl|BEFORE", "seam-split-screen|webgl|AFTER"],
    "the run stopped at the throwing cell",
  );
});

test("C. HAPPY PATH: four cells over two origins still open exactly one browser", async () => {
  const seams = makeSeams();
  const result = await capture(
    splitScreenRig,
    ORIGINS,
    { ...baseOptions, cellWork: fixtureCellWork(seams) },
    seams.dependencies,
  );

  assert.equal(seams.launches.length, 1);
  assert.equal(seams.closes, 1);
  assert.deepEqual(seams.cellCalls, [
    "seam-split-screen|webgl|BEFORE",
    "seam-split-screen|webgl|AFTER",
    "seam-split-screen|webgpu|BEFORE",
    "seam-split-screen|webgpu|AFTER",
  ]);
  assert.equal(result.manifest.rigs[0].cells.webgl.BEFORE.state, "MEASURED");
});

test("C. a rig set with nothing measurable opens no browser at all", async () => {
  const seams = makeSeams();
  const result = await capture(
    seedRig,
    ORIGINS,
    { ...baseOptions, cellWork: fixtureCellWork(seams) },
    seams.dependencies,
  );
  assert.equal(seams.launches.length, 0);
  assert.equal(seams.closes, 0);
  assert.deepEqual(validateManifest(result.manifest), []);
});

test("C. WATCHDOG PATH: the deadline closes the browser BEFORE the hard stop exits", async () => {
  // The path a `finally` cannot reach. A cell that never settles means the
  // `finally` is never entered, so the only thing that can close the browser
  // is the lifecycle — and it can only do that if the browser was acquired
  // through `scope.withResource`. The real `withProbeLifecycle` runs here;
  // only its timers, its `exit` and its diagnostic sink are injected.
  const seams = makeSeams();
  const wedgedOptions = {
    ...baseOptions,
    cellWork: () => new Promise(() => {}),
  };
  const timers = [];
  const exitCalls = [];
  const diagnostics = [];
  let closesWhenExitWasCalled = null;
  let identity = 0;

  const fireFirstTimer = () => {
    const next = timers.shift();
    assert.ok(next, "the lifecycle armed a timer to fire");
    next.fn();
    return next;
  };
  const settle = async (rounds = 40) => {
    for (let round = 0; round < rounds; round += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  let settled = "pending";
  const run = capture(splitScreenRig, ORIGINS, wedgedOptions, {
    ...seams.dependencies,
    lifecycleDependencies: {
      setTimeout: (fn, ms) => {
        const id = ++identity;
        timers.push({ id, fn, ms });
        return id;
      },
      clearTimeout: (id) => {
        const index = timers.findIndex((timer) => timer.id === id);
        if (index >= 0) {
          timers.splice(index, 1);
        }
      },
      exit: (code) => {
        closesWhenExitWasCalled = seams.closes;
        exitCalls.push(code);
      },
      writeDiagnostic: (text) => diagnostics.push(text),
    },
  }).then(
    () => {
      settled = "fulfilled";
    },
    () => {
      settled = "rejected";
    },
  );

  await settle();
  assert.equal(seams.launches.length, 1, "the browser is open");
  assert.equal(seams.closes, 0, "and the wedged cell has not released it");

  // The orderly deadline.
  fireFirstTimer();
  await settle();

  assert.equal(
    seams.closes,
    1,
    "the orderly deadline closed the browser although the cell never settled",
  );
  assert.deepEqual(exitCalls, [], "and it did so before any hard stop");

  // The hard-stop grace, which the wedged cell keeps the run from clearing.
  const remaining = timers.slice();
  for (const timer of remaining) {
    timer.fn();
  }
  await settle();

  assert.deepEqual(exitCalls, [2], "the hard stop is still the last resort");
  assert.equal(
    closesWhenExitWasCalled,
    1,
    "but the browser was already closed when it fired",
  );
  assert.equal(diagnostics.join("").includes("did not reach quiescence"), true);
  assert.equal(settled, "pending", "a hard-exited run never reports a result");
  // `run` is deliberately NOT awaited: a hard-exited lifecycle returns a
  // promise that never settles, which is the behaviour being asserted. Its
  // rejection is already handled by the recorder above.
  assert.ok(run instanceof Promise);
});

test("C. a close that fails does not ERASE the cell failure it happened after", async () => {
  // A rejecting `browser.close()` used to replace "injected cell failure" with
  // "Target page, context or browser has been closed", sending the next reader
  // to the wrong defect. Both must survive.
  const seams = makeSeams({
    closeRejectsWith: new Error(
      "Target page, context or browser has been closed",
    ),
  });
  const error = await capture(
    splitScreenRig,
    ORIGINS,
    {
      ...baseOptions,
      cellWork: fixtureCellWork(seams, {
        throwOn: "seam-split-screen|webgl|BEFORE",
      }),
    },
    seams.dependencies,
  ).then(
    () => null,
    (raw) => raw,
  );

  assert.ok(error, "the run rejected");
  const reported = [
    error.message,
    error.primaryCause?.message ?? "",
    ...(error.causes ?? []).map((cause) => cause?.message ?? String(cause)),
    ...(error.primaryCause?.causes ?? []).map(
      (cause) => cause?.message ?? String(cause),
    ),
  ].join("\n");
  assert.match(
    reported,
    /injected cell failure at seam-split-screen\|webgl\|BEFORE/,
    "the cell's own diagnosis survived the failing close",
  );
  assert.match(
    reported,
    /Target page, context or browser has been closed/,
    "and the close failure is reported beside it, not instead of it",
  );
});

// ---------------------------------------------------------------------------
// D. The receipt and the manifest
// ---------------------------------------------------------------------------

test("D. the receipt records servedBuildAssertion enforced, and both origins", async () => {
  const seams = makeSeams();
  const result = await capture(
    splitScreenRig,
    ORIGINS,
    { ...baseOptions, cellWork: fixtureCellWork(seams) },
    seams.dependencies,
  );

  assert.equal(result.receipt.servedBuildAssertion, "enforced");
  assert.equal(result.manifest.servedBuildAssertion, "enforced");
  assert.deepEqual(result.receipt.origins, { ...ORIGINS });
  assert.deepEqual(seams.preflights, [ORIGINS.BEFORE, ORIGINS.AFTER]);
  assert.equal(result.receipt.browsersLaunched, 1);
  assert.deepEqual(result.receipt.cells, { measured: 4, unmeasured: 0 });

  // The bytes actually handed to the writer are what a reader will read.
  const receiptText = seams.written.get(result.receiptPath);
  assert.match(receiptText, /"servedBuildAssertion": "enforced"/);
});

test("D. --no-serve-built records waived and runs no preflight", async () => {
  const seams = makeSeams();
  const result = await capture(
    splitScreenRig,
    ORIGINS,
    { ...baseOptions, servedBuild: false, cellWork: fixtureCellWork(seams) },
    seams.dependencies,
  );
  assert.equal(result.receipt.servedBuildAssertion, "waived");
  assert.equal(result.manifest.servedBuildAssertion, "waived");
  assert.deepEqual(seams.preflights, []);
});

test("D. a failing served-build preflight refuses before a browser is opened", async () => {
  const seams = makeSeams({ preflightOk: false });
  await assert.rejects(
    () =>
      capture(
        splitScreenRig,
        ORIGINS,
        { ...baseOptions, cellWork: fixtureCellWork(seams) },
        seams.dependencies,
      ),
    (error) => {
      assert.equal(error.name, "ProbeRefusal");
      assert.equal(error.reason, "served-build-preflight-failed");
      assert.equal(error.details.slot, "BEFORE");
      return true;
    },
  );
  assert.equal(seams.launches.length, 0);
});

test("D. the manifest carries no verdict vocabulary, even from a rig that has some", async () => {
  const seams = makeSeams();
  const result = await capture(
    splitScreenRig,
    ORIGINS,
    { ...baseOptions, cellWork: fixtureCellWork(seams) },
    seams.dependencies,
  );

  assert.deepEqual(validateManifest(result.manifest), []);
  const text = JSON.stringify(result.manifest);
  for (const token of [
    "gate",
    "expectedMismatch",
    "thresholds",
    '"PASS"',
    '"FAIL"',
  ]) {
    assert.equal(
      text.includes(token),
      false,
      `${token} leaked into the capture manifest`,
    );
  }
  // …while the rig genuinely declares two of them.
  assert.ok(splitScreenRig.gate && splitScreenRig.expectedMismatch);
});

test("D. every manifest image path is relative, POSIX, and beside the manifest", async () => {
  const seams = makeSeams();
  const result = await capture(
    [splitScreenRig, viewerRig],
    ORIGINS,
    { ...baseOptions, cellWork: fixtureCellWork(seams) },
    seams.dependencies,
  );
  const paths = [];
  for (const rig of result.manifest.rigs) {
    for (const renderer of Object.keys(rig.cells)) {
      for (const slot of CAPTURE_SLOTS) {
        paths.push(rig.cells[renderer][slot].image);
      }
      paths.push(rig.pairs[renderer].diffImage);
    }
  }
  assert.equal(paths.length, 9);
  for (const value of paths) {
    assert.equal(typeof value, "string");
    assert.equal(value.includes("\\"), false, `${value} is not POSIX`);
    assert.equal(value.startsWith("/"), false, `${value} is absolute`);
    assert.equal(value.includes("://"), false, `${value} carries an origin`);
  }
  assert.equal(
    result.manifest.rigs.find((rig) => rig.id === "seam-viewer").cells.webgpu
      .BEFORE.image,
    "seam-viewer/webgpu/BEFORE.png",
  );
});

test("D. an UNMEASURED rig and a MEASURED one coexist in one manifest", async () => {
  const seams = makeSeams();
  const result = await capture(
    [seedRig, splitScreenRig],
    ORIGINS,
    { ...baseOptions, cellWork: fixtureCellWork(seams) },
    seams.dependencies,
  );
  assert.deepEqual(validateManifest(result.manifest), []);

  const seed = result.manifest.rigs.find((rig) => rig.id === "seam-seed");
  assert.deepEqual(seed.cells.webgl.BEFORE, {
    state: CELL_STATES.UNMEASURED,
    image: null,
    reason: "rig declares page: null — no page exists for this rig yet",
    trackedBy: "KIT-B-SEED",
    metrics: null,
  });
  assert.equal(seed.pairs.webgpu.state, CELL_STATES.UNMEASURED);
  assert.equal(seed.pairs.webgpu.reason, "BEFORE is UNMEASURED");
  assert.equal(seed.pairs.webgpu.mismatchPct, null);

  const split = result.manifest.rigs.find(
    (rig) => rig.id === "seam-split-screen",
  );
  assert.equal(split.pairs.webgl.state, CELL_STATES.MEASURED);
  assert.deepEqual(result.receipt.cells, { measured: 4, unmeasured: 4 });
});

test("D. a pair whose two legs differ in size is UNMEASURED, not a crash", async () => {
  const seams = makeSeams();
  const result = await capture(
    splitScreenRig,
    ORIGINS,
    {
      ...baseOptions,
      cellWork: async (cell) => ({
        buffer: cell.slot === "BEFORE" ? BEFORE_PNG : BLACK_PNG,
        url: cell.url,
        capturedAt: new Date(FIXED_NOW).toISOString(),
      }),
    },
    seams.dependencies,
  );
  const pair = result.manifest.rigs[0].pairs.webgl;
  assert.equal(pair.state, CELL_STATES.UNMEASURED);
  assert.match(pair.reason, /8x8 and AFTER is 4x4/);
  assert.deepEqual(validateManifest(result.manifest), []);
});

// ---------------------------------------------------------------------------
// E. The measurements, taken in Node from the PNG bytes
// ---------------------------------------------------------------------------

test("E. cellMetrics returns hand-derivable values over the fixture bytes", () => {
  const before = decodePng(BEFORE_PNG);
  const flat = cellMetrics(before, before);
  assert.equal(flat.rawByteLumaMean, rec709(100, 100, 100));
  assert.equal(flat.nonBlackFraction, 1);
  assert.equal(flat.provenance, CELL_METRIC_PROVENANCE);

  const after = decodePng(AFTER_PNG);
  const moved = cellMetrics(after, after);
  const expected =
    (61 * rec709(100, 100, 100) + 3 * rec709(140, 100, 100)) / 64;
  assert.ok(
    Math.abs(moved.rawByteLumaMean - expected) < 1e-9,
    `${moved.rawByteLumaMean} != ${expected}`,
  );

  const black = decodePng(BLACK_PNG);
  const dark = cellMetrics(black, black);
  assert.equal(dark.rawByteLumaMean, 0);
  assert.equal(dark.nonBlackFraction, 0);
});

test("E. pairMetrics reports a PERCENT in [0,100], not the 0-1 ratio", () => {
  const before = decodePng(BEFORE_PNG);
  const after = decodePng(AFTER_PNG);
  const pair = pairMetrics(before, after);
  assert.equal(pair.changedPx, 3);
  assert.equal(pair.mismatchPct, (100 * 3) / 64);
  assert.deepEqual(pair.bbox, { x0: 1, y0: 1, x1: 2, y1: 2 });
  assert.equal(pair.tolerance, DEFAULT_PAIR_TOLERANCE);
  assert.ok(pair.mssim <= 1 && pair.mssim > 0);
  assert.equal(pair.diffRgba.length, 8 * 8 * 4);
});

test("E. the manifest's pair numbers are the ones pairMetrics computed", async () => {
  const seams = makeSeams();
  const result = await capture(
    splitScreenRig,
    ORIGINS,
    { ...baseOptions, cellWork: fixtureCellWork(seams) },
    seams.dependencies,
  );
  const pair = result.manifest.rigs[0].pairs.webgl;
  assert.equal(pair.changedPx, 3);
  assert.equal(pair.mismatchPct, (100 * 3) / 64);
  assert.equal(pair.tolerance, DEFAULT_PAIR_TOLERANCE);
  assert.ok(pair.mismatchPct >= 0 && pair.mismatchPct <= 100);
  // One heat-map PNG per measured pair, written beside the images.
  const diffs = [...seams.written.keys()].filter((file) =>
    file.endsWith("DIFF.png"),
  );
  assert.equal(diffs.length, 2);
});

// ---------------------------------------------------------------------------
// F. The plan, and the deadline it derives
// ---------------------------------------------------------------------------

test("F. the descriptor plans rig x renderer x slot in order, with no 8080 anywhere", () => {
  const descriptor = buildCaptureDescriptor(
    [splitScreenRig, viewerRig],
    ORIGINS,
    baseOptions,
  );
  assert.deepEqual(
    descriptor.cells.map((cell) => cell.key),
    [
      "seam-split-screen|webgl|BEFORE",
      "seam-split-screen|webgl|AFTER",
      "seam-split-screen|webgpu|BEFORE",
      "seam-split-screen|webgpu|AFTER",
      "seam-viewer|webgpu|BEFORE",
      "seam-viewer|webgpu|AFTER",
    ],
  );
  for (const cell of descriptor.cells) {
    assert.equal(
      cell.url.includes("8080"),
      false,
      `${cell.key} still points at the rig's declared origin`,
    );
    assert.equal(new URL(cell.url).origin, ORIGINS[cell.slot]);
  }
  // The split-screen page needs a tagged canvas; a single-viewer page takes
  // the renderer in its query instead.
  assert.equal(descriptor.cells[0].selector, 'canvas[data-vr-tag="webgl"]');
  assert.equal(descriptor.cells[4].selector, "canvas");
  assert.equal(
    new URL(descriptor.cells[4].url).searchParams.get("renderer"),
    "webgpu",
  );
});

test("F. the deadline is composed from the runtime's own budgets", () => {
  const descriptor = buildCaptureDescriptor(splitScreenRig, ORIGINS, {
    ...baseOptions,
    cellBudgetMs: 1000,
  });
  assert.equal(
    deriveCaptureDeadline(descriptor, { cellBudgetMs: 1000 }),
    PREFLIGHT_BUDGET_MS * 2 +
      LAUNCH_BUDGET_MS +
      4 * 1000 +
      RUN_SETTLEMENT_MARGIN_MS,
  );
  assert.throws(
    () => deriveCaptureDeadline(descriptor, { cellBudgetMs: 0 }),
    /positive safe integer/,
  );
});

test("F. a capture root that names itself by accident is refused", () => {
  assert.throws(
    () => buildCaptureDescriptor(splitScreenRig, ORIGINS, {}),
    /captureId or options.captureRoot/,
  );
});

// ---------------------------------------------------------------------------
// G. validateManifest fails CLOSED
// ---------------------------------------------------------------------------

test("G. validateManifest reports an unrecognised shape rather than passing it", async () => {
  const seams = makeSeams();
  const { manifest } = await capture(
    splitScreenRig,
    ORIGINS,
    { ...baseOptions, cellWork: fixtureCellWork(seams) },
    seams.dependencies,
  );
  assert.deepEqual(validateManifest(manifest), []);

  const mutate = (fn) => {
    const copy = JSON.parse(JSON.stringify(manifest));
    fn(copy);
    return validateManifest(copy);
  };

  assert.match(
    mutate((m) => {
      m.schemaVersion = 2;
    }).join("|"),
    /schemaVersion must be 1/,
  );
  assert.match(
    mutate((m) => {
      m.rigs[0].gate = { maxChangedFraction: 0.02 };
    }).join("|"),
    /verdict vocabulary may not enter a capture manifest/,
  );
  assert.match(
    mutate((m) => {
      m.rigs[0].cells.webgl.BEFORE.image = "C:\\output\\BEFORE.png";
    }).join("|"),
    /image must be a relative POSIX path/,
  );
  assert.match(
    mutate((m) => {
      m.rigs[0].cells.webgl.BEFORE.url = "PASS";
    }).join("|"),
    /GateExpectation token/,
  );
  assert.match(
    mutate((m) => {
      delete m.origins.AFTER;
    }).join("|"),
    /origins.AFTER is required and is never defaulted/,
  );
  assert.match(
    mutate((m) => {
      m.somethingNew = 1;
    }).join("|"),
    /unknown top-level key somethingNew/,
  );
  assert.equal(validateManifest(null).length, 1);
});

// ---------------------------------------------------------------------------
// H. The cross-seam guard — the producer's manifest and the page that reads it
// ---------------------------------------------------------------------------
//
// The manifest is the only thing the contact sheet reads, and each side owns a
// fail-closed reader of it: this module validates what it writes, and
// `lib/contact-sheet-page.mjs` validates what it is handed. Two readers of one
// document can drift apart silently, so the drift is what these cases assert:
// each side's own artifact is run through the OTHER side's validator, and the
// page model is built from a manifest this module actually produced.

test("H. a manifest this seam produces is accepted by the page's own reader", async () => {
  const seams = makeSeams();
  const result = await capture(
    [seedRig, splitScreenRig],
    ORIGINS,
    { ...baseOptions, cellWork: fixtureCellWork(seams) },
    seams.dependencies,
  );

  assert.deepEqual(validateManifest(result.manifest), []);
  assert.deepEqual(validateManifestForTheSheet(result.manifest), []);

  const model = sheetModel(result.manifest, {
    sheetId: "kit-wave-b",
    generatedAt: result.manifest.generatedAt,
  });
  assert.deepEqual(model.counts, result.receipt.cells);
  assert.deepEqual(findVerdictTokens(renderSheetHtml(model)), []);
});

test("H. the page's worked example is accepted by this seam's reader", () => {
  const worked = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("fixtures/contact-sheet/manifest-worked-example.json", HERE),
      ),
      "utf8",
    ),
  );
  assert.deepEqual(validateManifest(worked), []);
  assert.deepEqual(validateManifestForTheSheet(worked), []);
});

test("H. both readers refuse the same manifests", () => {
  const worked = () =>
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("fixtures/contact-sheet/manifest-worked-example.json", HERE),
        ),
        "utf8",
      ),
    );
  const cases = [
    ["schemaVersion", (m) => (m.schemaVersion = 2)],
    ["kind", (m) => (m.kind = "something-else")],
    ["origins.AFTER", (m) => delete m.origins.AFTER],
    ["servedBuildAssertion", (m) => (m.servedBuildAssertion = "auto")],
    ["a rig gate", (m) => (m.rigs[1].gate = { maxChangedFraction: 0.02 })],
    [
      "an absolute image",
      (m) => (m.rigs[1].cells.webgl.BEFORE.image = "/x.png"),
    ],
    [
      "a backslash image",
      (m) =>
        (m.rigs[1].cells.webgl.BEFORE.image = String.raw`globe-default\webgl\BEFORE.png`),
    ],
    [
      "mismatchPct out of range",
      (m) => (m.rigs[1].pairs.webgl.mismatchPct = 150),
    ],
    [
      "an UNMEASURED cell with an image",
      (m) => (m.rigs[0].cells.webgl.BEFORE.image = "not-null.png"),
    ],
    // The tenth mutation, and the one that SPLIT the two readers in v2: this
    // seam's predicate required `://` before it called a path absolute, so a
    // Windows drive letter had no scheme to match and validated clean HERE
    // while the page's reader refused it. Both now read
    // `lib/relative-path.mjs`, so this group is a real cross-seam agreement
    // rather than nine hand-picked cases that happened to agree.
    [
      "a drive-absolute image",
      (m) => (m.rigs[1].cells.webgl.BEFORE.image = "C:/ESCAPED/x.png"),
    ],
    [
      "a drive-relative image",
      (m) => (m.rigs[1].cells.webgl.BEFORE.image = "c:x.png"),
    ],
    ["a url receipt", (m) => (m.receipt = "https://example.test/report.json")],
    // And the percent-encoded traversal: `node:fs` does not decode it, so it
    // escapes nothing on disk — but the sheet is opened in a BROWSER, which
    // does, and "self-contained and movable" is the property at stake.
    [
      "a percent-encoded traversing image",
      (m) => (m.rigs[1].cells.webgl.BEFORE.image = "%2e%2e/%2e%2e/outside.png"),
    ],
    [
      "a percent-encoded separator in a diff path",
      (m) => (m.rigs[1].pairs.webgl.diffImage = "images%2f..%2f../outside.png"),
    ],
    [
      "a dots-only segment",
      (m) => (m.rigs[1].cells.webgl.BEFORE.image = "images/.../x.png"),
    ],
  ];
  for (const [name, mutate] of cases) {
    const manifest = worked();
    mutate(manifest);
    assert.ok(
      validateManifest(manifest).length > 0,
      `the capture seam accepted ${name}`,
    );
    assert.ok(
      validateManifestForTheSheet(manifest).length > 0,
      `the page reader accepted ${name}`,
    );
  }
});

// ---------------------------------------------------------------------------
// I. v3 — READINESS IS A POLL, and a timeout is a refusal WITH A DIAGNOSIS
//
// The Edge leg of 2026-09-18 could not run §8 step 1 as written: the seed rig
// declares `settleFrames: 30` (~0.5 s) and readiness was read ONCE after it,
// so every WebGPU cell refused at ~4.8 s while reporting a 180 s budget it had
// never spent. Measured on a served built tree, one browser, one page:
// `renderReady` first true at 4,558 ms (webgl) and 6,985 ms (webgpu),
// `tilesLoaded` at 10,043 / 10,325 ms. The fix is in the seam, not the recipe.
// ---------------------------------------------------------------------------

/** A page double: only the four methods `waitForCellReadiness` actually calls. */
function makeReadinessPage() {
  const calls = [];
  return {
    calls,
    waitForSelector: async (selector) => {
      calls.push(`waitForSelector:${selector}`);
    },
    click: async (selector) => {
      calls.push(`click:${selector}`);
    },
    waitForFunction: async () => {
      calls.push("waitForFunction");
    },
    waitForTimeout: async (ms) => {
      calls.push(`waitForTimeout:${ms}`);
    },
    evaluate: async () => {
      calls.push("evaluate");
    },
    url: () => "http://localhost:9001/page.html",
  };
}

/** A clock that advances by `step` on every read, so elapsed time is exact. */
function steppingClock(step) {
  let value = 0;
  return () => {
    const reading = value;
    value += step;
    return reading;
  };
}

const READINESS_CELL = Object.freeze({
  key: "globe-default|webgpu|AFTER",
  renderer: "webgpu",
  pageKind: "single-viewer",
  readiness: { kind: "settleFrames", frames: 30 },
  readinessPredicates: ["renderReady", "tilesLoaded"],
  readinessTimeoutMs: 20_000,
  readinessPollIntervalMs: 250,
});

test("I. pollReadiness: a scene that becomes ready on the Nth poll IS captured, not refused", async () => {
  // The verifier's measured shape: not ready at 4.5 s, not ready at 8.4 s,
  // ready at 10.3 s. A single sample takes the first of those three.
  const observations = [
    { renderReady: false, tilesLoaded: false },
    { renderReady: true, tilesLoaded: false },
    { renderReady: true, tilesLoaded: true },
  ];
  const slept = [];
  let index = 0;
  const outcome = await pollReadiness({
    sample: async () => observations[Math.min(index++, 2)],
    now: steppingClock(1_000),
    sleep: async (ms) => slept.push(ms),
    timeoutMs: 20_000,
    pollIntervalMs: 250,
  });

  assert.equal(outcome.ready, true);
  assert.equal(outcome.polls, 3, "it polled until the predicates held");
  assert.deepEqual(outcome.unmet, []);
  assert.deepEqual(outcome.observed, { renderReady: true, tilesLoaded: true });
  assert.deepEqual(slept, [250, 250], "and waited the poll interval between");
  assert.deepEqual(decideCellReadinessRefusal(outcome), {
    refuse: false,
    exitCode: 0,
    reason: null,
  });
});

test("I. pollReadiness: a scene that never becomes ready NAMES the predicate, the last values and the elapsed budget", async () => {
  const outcome = await pollReadiness({
    sample: async () => ({ renderReady: true, tilesLoaded: false }),
    now: steppingClock(500),
    sleep: async () => {},
    timeoutMs: 2_000,
    pollIntervalMs: 250,
  });

  assert.equal(outcome.ready, false);
  assert.deepEqual(outcome.unmet, ["tilesLoaded"]);
  assert.ok(outcome.elapsedMs >= outcome.timeoutMs, "the budget WAS spent");

  const decision = decideCellReadinessRefusal(outcome);
  assert.equal(decision.refuse, true);
  assert.equal(decision.reason, "capture-cell-not-ready");
  assert.equal(decision.exitCode, 3, "a refusal, never a measured result");
  assert.equal(decision.details.runtimeReason, "predicate-unmet");
  assert.deepEqual(decision.details.unmet, ["tilesLoaded"]);
  assert.deepEqual(decision.details.observed, {
    renderReady: true,
    tilesLoaded: false,
  });
  assert.ok(decision.details.polls > 1);
  assert.equal(decision.details.timeoutMs, 2_000);
  assert.match(describeReadiness(outcome), /unmet tilesLoaded after \d+ polls/);
});

test("I. pollReadiness: a page that never answers is render-ready-absent, and a frozen clock still terminates", async () => {
  const outcome = await pollReadiness({
    sample: async () => ({}),
    now: () => 1_000, // a clock that does not advance at all
    sleep: async () => {},
    timeoutMs: 1_000,
    pollIntervalMs: 250,
  });

  assert.equal(outcome.ready, false);
  assert.deepEqual(outcome.unmet, ["renderReady", "tilesLoaded"]);
  assert.equal(
    outcome.polls,
    5,
    "bounded by the poll count derived from the budget, not by the clock",
  );
  assert.equal(
    decideCellReadinessRefusal(outcome).details.runtimeReason,
    "render-ready-absent",
  );
});

test("I. pollReadiness: a null predicate is 'this page has no such subsystem', and satisfies", async () => {
  const outcome = await pollReadiness({
    sample: async () => ({ renderReady: true, tilesLoaded: null }),
    now: steppingClock(10),
    sleep: async () => {},
    timeoutMs: 1_000,
    pollIntervalMs: 250,
  });
  assert.equal(outcome.ready, true);
  assert.equal(outcome.polls, 1);
});

test("I. waitForCellReadiness: polls FIRST, then settles, then re-reads — and a scene that regresses during the settle is refused", async () => {
  const page = makeReadinessPage();
  const observations = [
    { renderReady: false, tilesLoaded: false },
    { renderReady: true, tilesLoaded: true },
    { renderReady: true, tilesLoaded: true },
  ];
  let index = 0;
  const ready = await waitForCellReadiness(
    page,
    READINESS_CELL,
    steppingClock(1_000),
    {
      sample: async () => observations[Math.min(index++, 2)],
      sleep: async () => {},
    },
  );

  assert.equal(ready.ready, true);
  assert.equal(ready.phase, "settled");
  assert.equal(ready.polls, 3, "two polls plus the re-read after the settle");
  assert.ok(
    page.calls.includes("evaluate"),
    "the rig's settle ran, between the poll and the re-read",
  );

  // Now the regression: ready while polling, not ready after the settle.
  const regressing = [
    { renderReady: true, tilesLoaded: true },
    { renderReady: false, tilesLoaded: true },
  ];
  let step = 0;
  const after = await waitForCellReadiness(
    makeReadinessPage(),
    READINESS_CELL,
    steppingClock(1_000),
    {
      sample: async () => regressing[Math.min(step++, 1)],
      sleep: async () => {},
    },
  );
  assert.equal(after.ready, false);
  assert.equal(after.phase, "settle");
  assert.deepEqual(after.unmet, ["renderReady"]);
  assert.equal(
    decideCellReadinessRefusal(after).reason,
    "capture-cell-not-ready",
  );
});

test("I. a cell that is never ready REFUSES the run; it never becomes an UNMEASURED cell", async () => {
  // An UNMEASURED cell means "this rig declares no page for this renderer".
  // A scene that needed longer must not be recorded as if the renderer were
  // missing, so the refusal propagates and NOTHING is written.
  const seams = makeSeams();
  const refusal = new ProbeRefusal(
    "capture-cell-not-ready",
    "cell globe-default|webgpu|AFTER was not ready to capture",
    { unmet: ["renderReady"], polls: 40, elapsedMs: 10_000 },
  );
  await assert.rejects(
    capture(
      viewerRig,
      ORIGINS,
      {
        ...baseOptions,
        cellWork: async (cell) => {
          seams.cellCalls.push(cell.key);
          throw refusal;
        },
      },
      seams.dependencies,
    ),
    (error) => {
      assert.equal(error.reason, "capture-cell-not-ready");
      assert.equal(error.exitCode, 3);
      return true;
    },
  );
  assert.equal(seams.launches.length, 1);
  assert.equal(seams.closes, 1, "the browser still closed");
  assert.deepEqual(
    [...seams.written.keys()],
    [],
    "and no manifest was written",
  );
});

test("I. every registry rig declares a SETTLE, not a readiness predicate — the census behind the default", () => {
  // The premise correction the Edge leg produced: the 39 rigs' `readiness`
  // fields are settle declarations (`settleFrames` / `settleMs`), and not one
  // of them is a gate a scene can be waited ON. So the poll's predicates come
  // from this module, the settle keeps coming from the rig, and NO rig file
  // needed changing — a 30-frame settle is a correct settle, and was never
  // the reason the WebGPU cells refused.
  const kinds = new Map();
  for (const rig of REGISTRY_RIGS) {
    assert.ok(
      rig.readiness?.kind === "settleFrames" ||
        rig.readiness?.kind === "settleMs",
      `${rig.id} declares an unrecognised readiness`,
    );
    kinds.set(rig.readiness.kind, (kinds.get(rig.readiness.kind) ?? 0) + 1);
    assert.equal(
      rig.readinessPredicates,
      undefined,
      `${rig.id} declares readiness predicates, which the census says none do`,
    );
  }
  assert.equal(REGISTRY_RIGS.length, 39);
  assert.deepEqual([...kinds.entries()].sort(), [
    ["settleFrames", 36],
    ["settleMs", 3],
  ]);

  // And the seed rig the Edge recipe names is one of the 36.
  const seed = rigById(REGISTRY_RIGS, "globe-default");
  assert.deepEqual(seed.readiness, { kind: "settleFrames", frames: 30 });
});

test("I. the descriptor carries the poll interval, the predicates and both close budgets", () => {
  const descriptor = buildCaptureDescriptor(viewerRig, ORIGINS, baseOptions);
  const cell = descriptor.cells[0];
  assert.equal(
    cell.readinessPollIntervalMs,
    DEFAULT_READINESS_POLL_INTERVAL_MS,
  );
  assert.deepEqual([...cell.readinessPredicates], [...READINESS_PREDICATES]);
  assert.equal(descriptor.closeDeadlineMs, DEFAULT_CLOSE_DEADLINE_MS);
  assert.ok(
    descriptor.hardStopGraceMs > descriptor.closeDeadlineMs,
    "the grace still exceeds the close deadline, which the lifecycle requires",
  );

  const raised = buildCaptureDescriptor(viewerRig, ORIGINS, {
    ...baseOptions,
    closeDeadlineMs: 90_000,
    readinessPollIntervalMs: 50,
    readinessPredicates: ["renderReady"],
  });
  assert.equal(raised.closeDeadlineMs, 90_000);
  assert.ok(raised.hardStopGraceMs > 90_000, "and it moves WITH the deadline");
  assert.equal(raised.cells[0].readinessPollIntervalMs, 50);
  assert.deepEqual([...raised.cells[0].readinessPredicates], ["renderReady"]);
  assert.throws(
    () =>
      buildCaptureDescriptor(viewerRig, ORIGINS, {
        ...baseOptions,
        closeDeadlineMs: 0,
      }),
    /closeDeadlineMs must be a positive safe integer/,
  );
});

// ---------------------------------------------------------------------------
// J. v3 — the watchdog says what it was waiting for BEFORE it kills the run
//
// Run 2 of the Edge leg hard-exited 2 with nothing printed but the lifecycle's
// own "did not reach quiescence" line: the cell failure that caused the wedge
// was unrecoverable from the transcript. The lifecycle writes exactly one
// diagnostic, on exactly one path, so the capture's own state goes out first —
// to the same sink and to a durable `capture-incident.json`.
// ---------------------------------------------------------------------------

test("J. the hard stop writes the phase, the cell, the elapsed time and the open resources — and the lifecycle's own line still reaches the sink", async () => {
  const seams = makeSeams();
  const wedgedOptions = {
    ...baseOptions,
    cellWork: (cell) => {
      seams.cellCalls.push(cell.key);
      return new Promise(() => {});
    },
  };
  const timers = [];
  const exitCalls = [];
  const diagnostics = [];
  let identity = 0;
  let clock = 1_000;

  const settle = async (rounds = 40) => {
    for (let round = 0; round < rounds; round += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  const run = capture(splitScreenRig, ORIGINS, wedgedOptions, {
    ...seams.dependencies,
    now: () => (clock += 1_000),
    lifecycleDependencies: {
      setTimeout: (fn, ms) => {
        const id = ++identity;
        timers.push({ id, fn, ms });
        return id;
      },
      clearTimeout: (id) => {
        const index = timers.findIndex((timer) => timer.id === id);
        if (index >= 0) {
          timers.splice(index, 1);
        }
      },
      exit: (code) => exitCalls.push(code),
      writeDiagnostic: (text) => diagnostics.push(text),
    },
  });
  run.catch(() => {});

  await settle();
  for (const timer of timers.slice()) {
    timer.fn();
  }
  await settle();
  for (const timer of timers.slice()) {
    timer.fn();
  }
  await settle();

  assert.deepEqual(exitCalls, [2], "the hard stop still fires");
  assert.equal(diagnostics.length, 2, "two lines, not one");
  assert.match(diagnostics[0], /incident: phase "/);
  assert.match(diagnostics[0], /still open \[/);
  assert.match(
    diagnostics[1],
    /did not reach quiescence/,
    "the lifecycle's own message is passed through, never swallowed",
  );

  const incidentPath = [...seams.written.keys()].find((file) =>
    file.endsWith("capture-incident.json"),
  );
  assert.ok(incidentPath, "a durable incident record was written");
  const incident = JSON.parse(seams.written.get(incidentPath));
  assert.equal(incident.outcome, "errored");
  assert.equal(incident.kind, "capture-incident");
  assert.equal(
    incident.cell,
    "seam-split-screen|webgl|BEFORE",
    "the cell that never finished is named",
  );
  // The orderly deadline has already begun closing the browser by the time the
  // hard stop fires, so that is the phase — and it is the one worth printing:
  // "still closing the browser, with this cell outstanding".
  assert.equal(incident.phase, "closing the browser");
  assert.deepEqual(incident.cellsCompleted, []);
  assert.ok(incident.elapsedMs > 0, "it says how long it had been waiting");
  assert.ok(
    incident.openResources.includes("browser") ||
      incident.openResources.includes("edge slot"),
    `it says what was still open: ${JSON.stringify(incident.openResources)}`,
  );
  assert.match(incident.error, /did not reach quiescence/);
  assert.equal(incident.closeDeadlineMs, DEFAULT_CLOSE_DEADLINE_MS);
  assert.ok(run instanceof Promise);
});

test("J. buildCaptureIncident is a pure record of what the run was doing", () => {
  const descriptor = buildCaptureDescriptor(viewerRig, ORIGINS, baseOptions);
  const incident = buildCaptureIncident({
    descriptor,
    progress: {
      phase: "capturing",
      cell: "globe-default|webgpu|AFTER",
      startedAt: 1_000,
      open: new Set(["edge slot", "browser"]),
      completed: ["globe-default|webgl|BEFORE"],
    },
    at: 41_000,
    reason:
      "capture:x: lifecycle did not reach quiescence before hard-stop grace",
  });

  assert.equal(incident.outcome, "errored");
  assert.equal(incident.elapsedMs, 40_000);
  assert.deepEqual(incident.openResources, ["edge slot", "browser"]);
  assert.deepEqual(incident.cellsCompleted, ["globe-default|webgl|BEFORE"]);
  assert.equal(incident.cell, "globe-default|webgpu|AFTER");
  assert.equal(incident.captureId, descriptor.captureId);
  assert.match(incident.error, /did not reach quiescence/);
  // NOT asserted: that an incident carries no verdict vocabulary. It carries
  // `outcome: "errored"` by the runtime's own `RUN_OUTCOMES`, and its
  // `captureRoot` contains `visual-regression`. The no-verdict rule is about
  // the artefacts a reader could mistake for a ruling — the contact sheet and
  // the wave-end receipt — not about a crash diagnosis, whose whole job is to
  // say that something went wrong.
  assert.equal(incident.captureRoot, descriptor.captureRoot);
});

// ---------------------------------------------------------------------------
// K. v4 — every timing option is honourable, or the run refuses before it
//    opens anything; and a cell that WAS ready says how it got there
//
// The verifier's F1: only `closeDeadlineMs` was validated, so `Infinity`,
// `NaN`, `0` and a negative reached `pollReadiness` through
// `readinessTimeoutMs` / `readinessPollIntervalMs`. Three of those shapes blew
// a 5,000-call cap, because the poll's own bound is arithmetic on the very
// numbers nobody checked. The Edge executor's first minor is the other half:
// the polls and the elapsed time reached a caller only on the REFUSAL path, so
// a green capture had to be instrumented with a clock wrapper to answer "how
// long did readiness take, and on what".
// ---------------------------------------------------------------------------

const BAD_TIMINGS = [
  { label: "Infinity", value: Number.POSITIVE_INFINITY },
  { label: "-Infinity", value: Number.NEGATIVE_INFINITY },
  { label: "NaN", value: Number.NaN },
  { label: "zero", value: 0 },
  { label: "negative", value: -5_000 },
  { label: "a fraction", value: 1.5 },
  { label: "a numeric string", value: "45000" },
  { label: "an array", value: [45_000] },
  { label: "past the sane maximum", value: MAX_TIMING_OPTION_MS + 1 },
];

const TIMING_OPTIONS = [
  "closeDeadlineMs",
  "hardStopGraceMs",
  "navigationTimeoutMs",
  "readinessTimeoutMs",
  "readinessPollIntervalMs",
  "cellBudgetMs",
];

test("K. every timing option is refused by NAME for every unhonourable value", () => {
  for (const option of TIMING_OPTIONS) {
    // Read from the refusal rather than assumed: `closeDeadlineMs`'s ceiling
    // is the sane maximum less the margin its derived grace adds, so the
    // options do not all share one number and the spec should not pretend
    // they do.
    let ceiling = null;
    for (const { label, value } of BAD_TIMINGS) {
      let raised = null;
      try {
        buildCaptureDescriptor(viewerRig, ORIGINS, {
          ...baseOptions,
          [option]: value,
        });
      } catch (error) {
        raised = error;
      }
      assert.ok(
        raised instanceof ProbeRefusal,
        `${option}=${label} produced ${raised === null ? "no error" : raised.name}`,
      );
      assert.equal(raised.reason, TIMING_OPTION_REFUSAL);
      assert.equal(raised.exitCode, 3, "a refusal, not a crash");
      assert.equal(raised.details.option, option);
      assert.equal(raised.details.minimum, 1);
      assert.ok(
        raised.details.maximum > 0 &&
          raised.details.maximum <= MAX_TIMING_OPTION_MS,
        `${option}: the stated ceiling is within the sane maximum`,
      );
      ceiling = raised.details.maximum;
      assert.ok(
        raised.message.includes(option),
        `the refusal names the option: ${raised.message}`,
      );
    }
    // And the boundary values either side of the accepted range.
    assert.ok(
      buildCaptureDescriptor(viewerRig, ORIGINS, {
        ...baseOptions,
        [option]: 1,
      }),
      `${option}=1 is the smallest honourable budget`,
    );
    assert.ok(
      buildCaptureDescriptor(viewerRig, ORIGINS, {
        ...baseOptions,
        [option]: ceiling,
      }),
      `${option}=${ceiling} is the largest`,
    );
    assert.throws(
      () =>
        buildCaptureDescriptor(viewerRig, ORIGINS, {
          ...baseOptions,
          [option]: ceiling + 1,
        }),
      ProbeRefusal,
      `${option}=${ceiling + 1} is one past it`,
    );
    // `null` and `undefined` are NOT bad values: `??` reads both as "not
    // supplied", and the default that replaces them is itself validated. Said
    // here so the absence of those two from the table above is a decision a
    // reader can see rather than a gap.
    for (const absent of [null, undefined]) {
      const descriptor = buildCaptureDescriptor(viewerRig, ORIGINS, {
        ...baseOptions,
        [option]: absent,
      });
      assert.equal(descriptor.closeDeadlineMs, DEFAULT_CLOSE_DEADLINE_MS);
      assert.equal(
        descriptor.cells[0].readinessPollIntervalMs,
        DEFAULT_READINESS_POLL_INTERVAL_MS,
      );
    }
  }
});

test("K. the timing refusal lands BEFORE the preflight, the slot and the browser", async () => {
  const seams = makeSeams();
  await assert.rejects(
    () =>
      capture(
        viewerRig,
        ORIGINS,
        { ...baseOptions, readinessTimeoutMs: Number.POSITIVE_INFINITY },
        seams.dependencies,
      ),
    (error) =>
      error instanceof ProbeRefusal &&
      error.reason === TIMING_OPTION_REFUSAL &&
      error.message.includes("readinessTimeoutMs"),
  );
  assert.deepEqual(seams.launches, [], "no browser was launched");
  assert.deepEqual(seams.slots, [], "no Edge slot was taken");
  assert.deepEqual(seams.preflights, [], "no preflight ran");
  assert.equal(seams.written.size, 0, "nothing was written");
});

test("K. pollReadiness refuses an unspinnable budget rather than spinning on it", async () => {
  // Each of these three blew a 5,000-call cap in the verifier's harness. The
  // sample counter is the assertion that matters: the refusal happens BEFORE
  // the first observation, so there is no loop left to bound.
  const shapes = [
    {
      label: "timeoutMs Infinity against a frozen clock",
      timeoutMs: Number.POSITIVE_INFINITY,
      pollIntervalMs: 250,
      now: () => 1_000,
      option: "readinessTimeoutMs",
    },
    {
      label: "timeoutMs NaN against an advancing clock",
      timeoutMs: Number.NaN,
      pollIntervalMs: 250,
      now: steppingClock(1_000),
      option: "readinessTimeoutMs",
    },
    {
      label: "pollIntervalMs NaN against a frozen clock",
      timeoutMs: 1_000,
      pollIntervalMs: Number.NaN,
      now: () => 1_000,
      option: "readinessPollIntervalMs",
    },
  ];
  for (const shape of shapes) {
    let samples = 0;
    let sleeps = 0;
    await assert.rejects(
      () =>
        pollReadiness({
          sample: async () => {
            samples += 1;
            return { renderReady: false, tilesLoaded: false };
          },
          now: shape.now,
          sleep: async () => {
            sleeps += 1;
          },
          timeoutMs: shape.timeoutMs,
          pollIntervalMs: shape.pollIntervalMs,
        }),
      (error) =>
        error instanceof ProbeRefusal &&
        error.reason === TIMING_OPTION_REFUSAL &&
        error.message.includes(shape.option),
      shape.label,
    );
    assert.equal(samples, 0, `${shape.label}: it never sampled`);
    assert.equal(sleeps, 0, `${shape.label}: it never slept`);
  }
});

test("K. the poll count is bounded by the STATED maximum as well as the derived one", async () => {
  // A one-millisecond interval against the largest honourable budget derives
  // 86,400,001 polls. The stated cap is what actually stops it, and a frozen
  // clock is the case where nothing else can.
  let samples = 0;
  const outcome = await pollReadiness({
    sample: async () => {
      samples += 1;
      return {};
    },
    now: () => 7_000,
    sleep: async () => {},
    timeoutMs: MAX_TIMING_OPTION_MS,
    pollIntervalMs: 1,
  });
  assert.equal(outcome.ready, false);
  assert.equal(outcome.polls, MAX_READINESS_POLLS);
  assert.equal(samples, MAX_READINESS_POLLS);
  assert.ok(
    MAX_READINESS_POLLS < Math.ceil(MAX_TIMING_OPTION_MS / 1) + 1,
    "the stated cap really is the binding one here",
  );
});

test("K. a cell that became ready records HOW — polls, elapsed, budget and the last unmet predicate", async () => {
  const page = makeReadinessPage();
  // Not ready, not ready, ready — then the settle's re-read, still ready.
  const observations = [
    { renderReady: false, tilesLoaded: false },
    { renderReady: true, tilesLoaded: false },
    { renderReady: true, tilesLoaded: true },
    { renderReady: true, tilesLoaded: true },
  ];
  let index = 0;
  const ready = await waitForCellReadiness(
    page,
    READINESS_CELL,
    steppingClock(1_000),
    {
      sample: async () => observations[Math.min(index++, 3)],
      sleep: async () => {},
    },
  );

  assert.equal(ready.ready, true);
  assert.deepEqual(ready.unmet, [], "nothing is unmet at the end");
  assert.deepEqual(
    ready.lastUnmet,
    ["tilesLoaded"],
    "and the poll before the successful one was waiting for tiles",
  );

  const summary = summariseCellReadiness(ready);
  assert.deepEqual(Object.keys(summary).sort(), [
    "budgetMs",
    "elapsedMsAfterFinalPoll",
    "lastUnmet",
    "phase",
    "polls",
  ]);
  assert.equal(summary.polls, ready.polls);
  assert.equal(summary.budgetMs, READINESS_CELL.readinessTimeoutMs);
  assert.equal(summary.phase, "settled");
  assert.equal(summary.lastUnmet, "tilesLoaded");
  assert.equal(summary.elapsedMsAfterFinalPoll, ready.elapsedMs);

  // A cell that was ready on its first sample says so, in words, rather than
  // leaving the field empty for a reader to interpret.
  let first = 0;
  const immediate = await waitForCellReadiness(
    page,
    READINESS_CELL,
    steppingClock(10),
    {
      sample: async () => {
        first += 1;
        return { renderReady: true, tilesLoaded: true };
      },
      sleep: async () => {},
    },
  );
  assert.equal(summariseCellReadiness(immediate).lastUnmet, "none");
  assert.ok(first >= 1);

  // And a body that reports no readiness at all banks nothing rather than a
  // row of zeroes that reads like a measurement.
  assert.equal(summariseCellReadiness(undefined), null);
  assert.equal(summariseCellReadiness(null), null);
});

test("K. the readiness record reaches the RECEIPT and never the manifest", async () => {
  const seams = makeSeams();
  const readiness = {
    ready: true,
    polls: 11,
    elapsedMs: 7_033,
    timeoutMs: 180_000,
    unmet: [],
    lastUnmet: ["tilesLoaded"],
    phase: "settled",
  };
  const result = await capture(
    viewerRig,
    ORIGINS,
    {
      ...baseOptions,
      cellWork: async (cell) => ({
        buffer: cell.slot === "BEFORE" ? BEFORE_PNG : AFTER_PNG,
        url: cell.url,
        capturedAt: new Date(FIXED_NOW).toISOString(),
        readiness,
      }),
    },
    seams.dependencies,
  );

  assert.ok(result.receipt.captures.length > 0);
  for (const entry of result.receipt.captures) {
    assert.deepEqual(entry.readiness, {
      polls: 11,
      // NAMED for the instant it is read at: the budget is tested after a
      // sample returns, so this number may exceed `budgetMs` by one poll.
      elapsedMsAfterFinalPoll: 7_033,
      budgetMs: 180_000,
      phase: "settled",
      lastUnmet: "tilesLoaded",
    });
  }
  assert.ok(
    !JSON.stringify(result.manifest).includes("elapsedMsAfterFinalPoll"),
    "the manifest is the sheet's input and carries no timing",
  );
  assert.ok(
    !JSON.stringify(result.manifest).includes("readiness"),
    "not under any other spelling either",
  );
  assert.deepEqual(validateManifest(result.manifest), []);
});

test("K. the overshoot is REPORTED, never hidden — the refusal and the receipt agree on both numbers", async () => {
  // A sample that costs 700 ms against a 3,000 ms budget is the Edge leg's own
  // shape: the budget is tested after the sample, so the last one lands past
  // it. Nothing is clamped; both numbers travel together.
  const outcome = await pollReadiness({
    sample: async () => ({ renderReady: true, tilesLoaded: false }),
    now: steppingClock(700),
    sleep: async () => {},
    timeoutMs: 3_000,
    pollIntervalMs: 250,
  });
  assert.equal(outcome.ready, false);
  assert.ok(
    outcome.elapsedMs > outcome.timeoutMs,
    `the overshoot is real: ${outcome.elapsedMs} of ${outcome.timeoutMs}`,
  );
  assert.ok(
    outcome.elapsedMs - outcome.timeoutMs < 2 * 700,
    "and bounded by one sample, not by an unbounded drift",
  );
  const summary = summariseCellReadiness({ ...outcome, phase: "poll" });
  assert.equal(summary.elapsedMsAfterFinalPoll, outcome.elapsedMs);
  assert.equal(summary.budgetMs, outcome.timeoutMs);
  assert.equal(summary.lastUnmet, "tilesLoaded");
  // The refusal carries the same pair, so a reader never sees one without the
  // other and cannot mistake the overshoot for a budget that was ignored.
  const details = decideCellReadinessRefusal(outcome).details;
  assert.equal(details.elapsedMs, outcome.elapsedMs);
  assert.equal(details.timeoutMs, outcome.timeoutMs);
});
