// probe-runtime.spec.mjs — hermetic contract for the shared probe runtime.
// Pure Node: no browser, no GPU, no build, no network. Every filesystem write
// lands under `os.tmpdir()`.
//
// WHAT IS BEING PINNED, AND WHY IT IS NOT A TEXT-SHAPE SPEC. The runtime's job
// is to make a set of governance rules impossible to half-apply across a fleet
// of several hundred probes. Each rule below is asserted as OBSERVABLE
// BEHAVIOUR of the real exported functions:
//
//   * a run pointed at port 8080 does not measure — it refuses, with a named
//     reason and exit 3;
//   * a served-build assertion that did not match every required artifact does
//     not measure;
//   * two concurrent Edge jobs do not both get a browser;
//   * a refusal is never scored as a pass, and a measured red is never scored
//     as a refusal or rounded down to a pass;
//   * a preflight refusal happens BEFORE a browser is launched and before the
//     Edge slot is taken — asserted by counting launches and by looking for the
//     lock file, not by reading the source;
//   * a migrated probe's receipt keeps the exact document it published before
//     it was migrated.
//
// THE LAST ONE IS THE ROW'S ACCEPTANCE, so it is worth saying how the fixture
// was built. `fixtures/probe-runtime/globe-cold-start-pre-runtime-receipt.json`
// was produced by lifting the PRE-RUNTIME probe's own receipt-assembly block
// (and its `decideReadinessVerdict`) out of git — the file this lane edited is
// not what generated it — and running that lifted code over synthetic cells.
// The spec then feeds the same cells to the migrated probe's exported builders
// and requires deep equality, key order included. A field added, dropped or
// renamed anywhere in the document fails.
//
// MUTANTS. Every group that claims a guard is live re-imports the module
// through a source mutation that makes the guard UNREACHABLE while leaving its
// text in place (`if (false && ...)`), and requires the assertion to go red.
// Deleting code is the easy mutation and most specs survive it; inertness is
// the one that catches a guard that is only decorative. Each mutation checks
// that its anchor occurs exactly once first, so a moved anchor fails loudly
// instead of silently mutating nothing.
//
// Run: node --test Tools/visual-regression/probe-runtime.spec.mjs

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_SERVED_BUILD_ARTIFACTS } from "./lib/served-build-preflight.mjs";
import {
  EDGE_LAUNCH_ARGS,
  PROBE_EXIT_CODES,
  ProbeRefusal,
  REQUIRED_SERVED_ARTIFACTS,
  acquireEdgeSlot,
  assembleReceipt,
  captureElement,
  decideEdgeSlot,
  decideOriginRefusal,
  decideRenderReadyRefusal,
  decideServedBuildRefusal,
  exitCodeForOutcome,
  isEntryPoint,
  launchEdge,
  normalizeJson,
  parseProbeArgs,
  runProbe,
  sha256,
} from "./lib/probe-runtime.mjs";
import {
  buildColdStartReceipt,
  buildColdStartVerdicts,
} from "./probe-globe-cold-start-readiness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_PATH = path.join(HERE, "lib", "probe-runtime.mjs");
const SLOT_PATH = path.join(HERE, "lib", "probe-edge-slot.mjs");
const PROBE_PATH = path.join(HERE, "probe-globe-cold-start-readiness.mjs");
const FIXTURE_PATH = path.join(
  HERE,
  "fixtures",
  "probe-runtime",
  "globe-cold-start-pre-runtime-receipt.json",
);

// ---------------------------------------------------------------------------
// Mutation harness
// ---------------------------------------------------------------------------

/**
 * Import a module from mutated source. Relative specifiers are rewritten to
 * absolute file urls first, because a `data:` module cannot resolve `./`.
 *
 * @param {string} file Absolute path of the module to mutate.
 * @param {Array<[string, string]>} replacements Anchor/replacement pairs.
 * @returns {Promise<object>} The mutated module namespace.
 */
async function importMutated(file, replacements = []) {
  // Normalized on the way in. `.gitattributes` pins this file set to LF, but a
  // spec whose anchors only match under one checkout configuration is a gate
  // that reports on the checkout rather than on the code.
  let source = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const base = pathToFileURL(path.dirname(file) + path.sep).href;
  source = source.replaceAll('from "./', `from "${base}`);
  for (const [anchor, replacement] of replacements) {
    const occurrences = source.split(anchor).length - 1;
    assert.equal(
      occurrences,
      1,
      `mutation anchor must occur exactly once, found ${occurrences}: ${anchor}`,
    );
    source = source.replace(anchor, replacement);
  }
  const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  return import(url);
}

/**
 * @returns {string} A fresh temporary directory, removed by the caller.
 */
function makeTempRoot() {
  return mkdtempSync(path.join(tmpdir(), "probe-runtime-"));
}

// ---------------------------------------------------------------------------
// A. Argument parsing
// ---------------------------------------------------------------------------

test("A. argv parsing", async (t) => {
  await t.test("defaults are the governed ones", () => {
    const options = parseProbeArgs([]);
    assert.equal(options.port, 8094);
    assert.equal(options.runs, 1);
    assert.equal(options.reverse, false);
    assert.equal(options.headed, false);
    assert.equal(options.timeoutMs, 120000);
    assert.deepEqual(options.renderers, ["webgl", "webgpu"]);
    assert.equal(
      options.servedBuild,
      true,
      "the served-build assertion is fail-closed by default",
    );
  });

  await t.test("flags are read", () => {
    const options = parseProbeArgs([
      "--port",
      "8095",
      "--runs",
      "3",
      "--reverse",
      "--headed",
      "--timeout-ms",
      "5000",
      "--output",
      "out",
      "--repository-root",
      "root",
    ]);
    assert.equal(options.port, 8095);
    assert.equal(options.runs, 3);
    assert.equal(options.reverse, true);
    assert.equal(options.headed, true);
    assert.equal(options.timeoutMs, 5000);
    assert.equal(options.outputDirectory, "out");
    assert.equal(options.repositoryRoot, "root");
  });

  await t.test("--renderer canonicalises order, whatever the spelling", () => {
    assert.deepEqual(parseProbeArgs(["--renderer", "webgpu"]).renderers, [
      "webgpu",
    ]);
    assert.deepEqual(parseProbeArgs(["--renderer", "both"]).renderers, [
      "webgl",
      "webgpu",
    ]);
    assert.deepEqual(
      parseProbeArgs(["--renderer", "webgpu,webgl"]).renderers,
      ["webgl", "webgpu"],
      "cell order must not depend on how the flag was typed",
    );
    assert.throws(() => parseProbeArgs(["--renderer", "vulkan"]), TypeError);
  });

  await t.test("--no-serve-built is the visible waiver", () => {
    assert.equal(parseProbeArgs(["--no-serve-built"]).servedBuild, false);
    assert.equal(parseProbeArgs(["--serve-built"]).servedBuild, true);
  });

  await t.test("probe-declared flags are parsed and defaulted", () => {
    const extraOptions = [
      {
        flag: "--settled-frames",
        key: "settledFrames",
        kind: "positive-integer",
        default: 60,
      },
      {
        flag: "--black-tolerance-pp",
        key: "blackTolerancePp",
        kind: "non-negative-number",
        default: 0.5,
      },
    ];
    assert.equal(parseProbeArgs([], { extraOptions }).settledFrames, 60);
    assert.equal(parseProbeArgs([], { extraOptions }).blackTolerancePp, 0.5);
    const options = parseProbeArgs(
      ["--settled-frames", "120", "--black-tolerance-pp", "0"],
      { extraOptions },
    );
    assert.equal(options.settledFrames, 120);
    assert.equal(options.blackTolerancePp, 0);
  });

  await t.test("malformed input is a caller error, not a refusal", () => {
    assert.throws(() => parseProbeArgs(["--nope"]), TypeError);
    assert.throws(() => parseProbeArgs(["--runs"]), TypeError);
    assert.throws(() => parseProbeArgs(["--runs", "0"]), TypeError);
    assert.throws(() => parseProbeArgs(["--runs", "1.5"]), TypeError);
    assert.throws(() => parseProbeArgs(["--port", "70000"]), TypeError);
  });

  await t.test("port 8080 refuses, and the refusal exits 3", () => {
    let thrown;
    try {
      parseProbeArgs(["--port", "8080"]);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof ProbeRefusal);
    assert.equal(thrown.reason, "port-8080-forbidden");
    assert.equal(thrown.exitCode, PROBE_EXIT_CODES.REFUSAL);
  });

  await t.test("MUTANT: an inert 8080 guard lets the run through", async () => {
    const mutated = await importMutated(RUNTIME_PATH, [
      ["if (parsed.port === 8080) {", "if (false && parsed.port === 8080) {"],
    ]);
    assert.equal(
      mutated.parseProbeArgs(["--port", "8080"]).port,
      8080,
      "the mutant must reach 8080 — otherwise the assertion above proves nothing",
    );
  });
});

// ---------------------------------------------------------------------------
// B. The single Edge slot
// ---------------------------------------------------------------------------

test("B. the single Edge slot", async (t) => {
  await t.test("a live, recent holder keeps the slot", () => {
    const decision = decideEdgeSlot({
      holder: { pid: 4242, acquiredAt: 1000 },
      now: 2000,
      staleAfterMs: 100000,
      isProcessAlive: () => true,
    });
    assert.deepEqual(decision, { reclaim: false, reason: "held" });
  });

  await t.test("a dead, corrupt or aged holder is reclaimed", () => {
    assert.equal(
      decideEdgeSlot({
        holder: { pid: 4242, acquiredAt: 1000 },
        now: 2000,
        staleAfterMs: 100000,
        isProcessAlive: () => false,
      }).reason,
      "dead-holder",
    );
    assert.equal(
      decideEdgeSlot({
        holder: null,
        now: 2000,
        staleAfterMs: 100000,
        isProcessAlive: () => true,
      }).reason,
      "unreadable-lock",
    );
    assert.equal(
      decideEdgeSlot({
        holder: { pid: 4242, acquiredAt: 1000 },
        now: 999999,
        staleAfterMs: 100,
        isProcessAlive: () => true,
      }).reason,
      "stale-lock",
    );
  });

  await t.test("a second job is refused while the first holds", () => {
    const root = makeTempRoot();
    try {
      const lockPath = path.join(root, "output", ".edge-slot.lock");
      const first = acquireEdgeSlot({
        lockPath,
        owner: "first",
        now: 1000,
        pid: 111,
        isProcessAlive: () => true,
      });
      assert.equal(first.reclaimed, null);

      let thrown;
      try {
        acquireEdgeSlot({
          lockPath,
          owner: "second",
          now: 1500,
          pid: 222,
          isProcessAlive: () => true,
        });
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown instanceof ProbeRefusal);
      assert.equal(thrown.reason, "edge-slot-busy");

      // Released, the slot is free again, and the release is recorded as a
      // takeover rather than pretending the second job was first.
      first.release();
      const third = acquireEdgeSlot({
        lockPath,
        owner: "third",
        now: 2000,
        pid: 333,
        isProcessAlive: () => true,
      });
      assert.equal(third.reclaimed, null);
      third.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("release does not remove a slot someone else reclaimed", () => {
    const root = makeTempRoot();
    try {
      const lockPath = path.join(root, ".edge-slot.lock");
      const mine = acquireEdgeSlot({
        lockPath,
        owner: "mine",
        now: 1000,
        pid: 111,
        isProcessAlive: () => true,
      });
      // A later job decided mine was stale and took the slot.
      const theirs = acquireEdgeSlot({
        lockPath,
        owner: "theirs",
        now: 9999999,
        pid: 222,
        staleAfterMs: 10,
        isProcessAlive: () => true,
      });
      assert.equal(theirs.reclaimed, "stale-lock");
      mine.release();
      assert.equal(
        JSON.parse(readFileSync(lockPath, "utf8")).owner,
        "theirs",
        "my release must not free a slot that is no longer mine",
      );
      theirs.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test(
    "MUTANT: an inert busy check double-books the slot",
    async () => {
      const mutated = await importMutated(SLOT_PATH, [
        ["if (!decision.reclaim) {", "if (false && !decision.reclaim) {"],
      ]);
      const root = makeTempRoot();
      try {
        const lockPath = path.join(root, ".edge-slot.lock");
        mutated.acquireEdgeSlot({
          lockPath,
          owner: "first",
          now: 1000,
          pid: 111,
          isProcessAlive: () => true,
        });
        const second = mutated.acquireEdgeSlot({
          lockPath,
          owner: "second",
          now: 1500,
          pid: 222,
          isProcessAlive: () => true,
        });
        assert.equal(
          second.owner,
          "second",
          "the mutant must hand out the slot twice",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

// ---------------------------------------------------------------------------
// C. Refusal decisions
// ---------------------------------------------------------------------------

const MATCHED_PREFLIGHT = {
  ok: true,
  origin: "http://localhost:8094",
  artifacts: [
    { path: "Build/CesiumUnminified/Cesium.js", match: true },
    { path: "packages/engine/Build/Unminified/index.js", match: true },
  ],
};

test("C. refusal decisions", async (t) => {
  await t.test("a matched preflight clears the run", () => {
    assert.equal(decideServedBuildRefusal(MATCHED_PREFLIGHT).refuse, false);
  });

  await t.test("a stale or partial preflight refuses", () => {
    assert.equal(
      decideServedBuildRefusal(null).reason,
      "served-build-preflight-failed",
    );
    assert.equal(
      decideServedBuildRefusal({ ...MATCHED_PREFLIGHT, ok: false }).reason,
      "served-build-preflight-failed",
    );
    const oneStale = {
      ok: true,
      artifacts: [
        { path: "Build/CesiumUnminified/Cesium.js", match: true },
        { path: "packages/engine/Build/Unminified/index.js", match: false },
      ],
    };
    const decision = decideServedBuildRefusal(oneStale);
    assert.equal(decision.reason, "served-build-preflight-incomplete");
    assert.deepEqual(decision.details.missingOrUnmatched, [
      "packages/engine/Build/Unminified/index.js",
    ]);
  });

  await t.test("the second bundle is required, not optional", () => {
    // Q-98: a probe that preflights only `Cesium.js` and then drives a
    // Sandcastle2 demo has verified bytes the page never loads.
    const onlyFirst = {
      ok: true,
      artifacts: [{ path: "Build/CesiumUnminified/Cesium.js", match: true }],
    };
    assert.equal(
      decideServedBuildRefusal(onlyFirst).reason,
      "served-build-preflight-incomplete",
    );
  });

  await t.test("a waiver is accepted and is visible", () => {
    assert.equal(
      decideServedBuildRefusal(null, { waived: true }).refuse,
      false,
    );
  });

  await t.test("a navigation off the requested origin refuses", () => {
    assert.equal(
      decideOriginRefusal({
        requestedOrigin: "http://localhost:8094",
        actualUrl: "http://localhost:8094/Apps/Sandcastle2/index.html",
      }).refuse,
      false,
    );
    const breach = decideOriginRefusal({
      requestedOrigin: "http://localhost:8094",
      actualUrl: "http://localhost:8080/Apps/Sandcastle2/index.html",
    });
    assert.equal(breach.reason, "origin-mismatch");
    assert.equal(breach.details.actualOrigin, "http://localhost:8080");
    assert.equal(
      decideOriginRefusal({
        requestedOrigin: "http://localhost:8094",
        actualUrl: "not a url",
      }).reason,
      "navigation-url-invalid",
    );
    assert.equal(
      decideOriginRefusal({
        requestedOrigin: "nonsense",
        actualUrl: "http://localhost:8094/",
      }).reason,
      "requested-origin-invalid",
    );
  });

  await t.test("a capture taken before readiness refuses", () => {
    assert.equal(
      decideRenderReadyRefusal({
        renderReady: true,
        elapsedMs: 10,
        timeoutMs: 100,
      }).refuse,
      false,
    );
    assert.equal(
      decideRenderReadyRefusal({
        renderReady: false,
        elapsedMs: 100,
        timeoutMs: 100,
      }).reason,
      "render-ready-timeout",
    );
    assert.equal(
      decideRenderReadyRefusal({
        renderReady: undefined,
        elapsedMs: 1,
        timeoutMs: 100,
      }).reason,
      "render-ready-absent",
      "a build with no readiness signal is not a slow build",
    );
  });
});

// ---------------------------------------------------------------------------
// D. Receipts and exit codes
// ---------------------------------------------------------------------------

test("D. receipts and exit codes", async (t) => {
  await t.test("a probe-owned receipt gains no runtime fields", () => {
    const receipt = assembleReceipt({
      envelope: "probe-owned",
      fields: { a: 1, b: 2 },
      runtime: { probe: "x", exitCode: 0 },
    });
    assert.deepEqual(Object.keys(receipt), ["a", "b"]);
  });

  await t.test("a runtime-enveloped receipt carries both", () => {
    const receipt = assembleReceipt({
      envelope: "runtime",
      fields: { a: 1 },
      runtime: { probe: "x", exitCode: 0 },
    });
    assert.deepEqual(Object.keys(receipt), ["probe", "exitCode", "a"]);
    assert.throws(
      () => assembleReceipt({ envelope: "wat", fields: {}, runtime: {} }),
      TypeError,
    );
  });

  await t.test("serialization is LF with a trailing newline", () => {
    const text = normalizeJson({ a: "x\r\ny" });
    assert.ok(text.endsWith("}\n"));
    assert.equal(text.includes("\r\n"), false);
  });

  await t.test("sha256 is the plain lowercase hex digest", () => {
    assert.equal(
      sha256(Buffer.from("abc")),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  await t.test("a refusal outranks a measured red, which outranks OK", () => {
    assert.equal(exitCodeForOutcome({ verdicts: [] }), PROBE_EXIT_CODES.OK);
    assert.equal(
      exitCodeForOutcome({ verdicts: [{ pass: true }] }),
      PROBE_EXIT_CODES.OK,
    );
    assert.equal(
      exitCodeForOutcome({ verdicts: [{ pass: true }, { pass: false }] }),
      PROBE_EXIT_CODES.FAILURE,
    );
    assert.equal(
      exitCodeForOutcome({ errored: true, verdicts: [] }),
      PROBE_EXIT_CODES.ERROR,
    );
    assert.equal(
      exitCodeForOutcome({
        refusal: { reason: "port-8080-forbidden" },
        verdicts: [{ pass: false }],
      }),
      PROBE_EXIT_CODES.REFUSAL,
      "a run that could not be validated has no standing to report a red",
    );
  });

  await t.test("a measured red is never rounded down", () => {
    assert.notEqual(PROBE_EXIT_CODES.FAILURE, PROBE_EXIT_CODES.OK);
    assert.equal(PROBE_EXIT_CODES.FAILURE, 1);
  });

  await t.test("isEntryPoint only matches the started script", () => {
    const url = pathToFileURL(RUNTIME_PATH).href;
    assert.equal(isEntryPoint(url, ["node", RUNTIME_PATH]), true);
    assert.equal(isEntryPoint(url, ["node", PROBE_PATH]), false);
    assert.equal(isEntryPoint(url, ["node"]), false);
  });
});

// ---------------------------------------------------------------------------
// E. The composition root, driven with fakes
// ---------------------------------------------------------------------------

/**
 * @param {object} [options] Overrides.
 * @returns {object} A descriptor whose cells never touch a browser.
 */
function fakeDescriptor(options = {}) {
  return {
    name: "fake-probe",
    title: "Fake probe",
    receiptEnvelope: options.receiptEnvelope ?? "probe-owned",
    cells: options.cells ?? (async ({ run }) => [{ run, value: run * 2 }]),
    receipt: (cells) => ({ cells }),
    verdicts: options.verdicts ?? (() => [{ id: "v", pass: true }]),
  };
}

test("E. runProbe", async (t) => {
  await t.test("happy path writes two documents and exits 0", async () => {
    const root = makeTempRoot();
    try {
      const out = path.join(root, "out");
      const launches = [];
      const code = await runProbe(fakeDescriptor(), {
        argv: [
          "--repository-root",
          root,
          "--output",
          out,
          "--runs",
          "2",
          "--no-serve-built",
        ],
        now: () => Date.UTC(2026, 8, 2, 4, 0, 0),
        launch: async (args) => {
          launches.push(args);
          return { close: async () => {} };
        },
      });
      assert.equal(code, PROBE_EXIT_CODES.OK);
      assert.equal(
        launches.length,
        2,
        "one browser per run, not one per probe",
      );

      const receipt = JSON.parse(
        readFileSync(path.join(out, "fake-probe-report.json"), "utf8"),
      );
      assert.deepEqual(Object.keys(receipt), ["cells"]);
      assert.equal(receipt.cells.length, 2);

      const runtimeReceipt = JSON.parse(
        readFileSync(path.join(out, "fake-probe-runtime.json"), "utf8"),
      );
      assert.equal(runtimeReceipt.probe, "fake-probe");
      assert.equal(runtimeReceipt.origin, "http://localhost:8094");
      assert.equal(runtimeReceipt.servedBuildAssertion, "waived");
      assert.equal(runtimeReceipt.exitCode, 0);
      assert.equal(runtimeReceipt.generatedAt, "2026-09-02T04:00:00.000Z");
      assert.ok(
        readFileSync(path.join(out, "fake-probe-summary.md"), "utf8").includes(
          "Fake probe",
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("a failing verdict exits 1 and still publishes", async () => {
    const root = makeTempRoot();
    try {
      const out = path.join(root, "out");
      const code = await runProbe(
        fakeDescriptor({ verdicts: () => [{ id: "v", pass: false }] }),
        {
          argv: [
            "--repository-root",
            root,
            "--output",
            out,
            "--no-serve-built",
          ],
          launch: async () => ({ close: async () => {} }),
        },
      );
      assert.equal(code, PROBE_EXIT_CODES.FAILURE);
      const runtimeReceipt = JSON.parse(
        readFileSync(path.join(out, "fake-probe-runtime.json"), "utf8"),
      );
      assert.equal(runtimeReceipt.exitCode, 1);
      assert.equal(runtimeReceipt.verdicts.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("a stale build refuses BEFORE a browser is opened", async () => {
    const root = makeTempRoot();
    try {
      const out = path.join(root, "out");
      const launches = [];
      const code = await runProbe(fakeDescriptor(), {
        argv: ["--repository-root", root, "--output", out],
        preflight: async () => ({
          ok: false,
          artifacts: [
            { path: "Build/CesiumUnminified/Cesium.js", match: false },
            { path: "packages/engine/Build/Unminified/index.js", match: true },
          ],
        }),
        launch: async () => {
          launches.push("launched");
          return { close: async () => {} };
        },
      });
      assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
      assert.equal(launches.length, 0, "no browser is opened on a refusal");
      const record = JSON.parse(
        readFileSync(path.join(out, "fake-probe-refusal.json"), "utf8"),
      );
      assert.equal(record.outcome, "refused");
      assert.equal(record.refusal.reason, "served-build-preflight-failed");
      assert.equal(record.edgeSlot, null, "the slot was never taken");
      assert.equal(
        record.preflight.artifacts[0].match,
        false,
        "the record carries the preflight fact that caused the refusal",
      );
      assert.equal(record.exitCode, PROBE_EXIT_CODES.REFUSAL);
      assert.equal(
        record.generatedAt,
        new Date(record.generatedAt).toISOString(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("the Edge slot is released when the run ends", async () => {
    const root = makeTempRoot();
    try {
      const lockPath = path.join(
        root,
        "Tools/visual-regression/output/.edge-slot.lock",
      );
      await runProbe(fakeDescriptor(), {
        argv: [
          "--repository-root",
          root,
          "--output",
          path.join(root, "out"),
          "--no-serve-built",
        ],
        launch: async () => ({ close: async () => {} }),
      });
      assert.throws(() => readFileSync(lockPath, "utf8"), { code: "ENOENT" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("a throwing cell is an ERROR, not a silent pass", async () => {
    const root = makeTempRoot();
    try {
      const out = path.join(root, "out");
      const code = await runProbe(
        fakeDescriptor({
          cells: async () => {
            throw new Error("the harness wedged");
          },
        }),
        {
          argv: [
            "--repository-root",
            root,
            "--output",
            out,
            "--no-serve-built",
          ],
          launch: async () => ({ close: async () => {} }),
        },
      );
      assert.equal(code, PROBE_EXIT_CODES.ERROR);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("a busy Edge slot refuses the run", async () => {
    const root = makeTempRoot();
    try {
      const lockPath = path.join(
        root,
        "Tools/visual-regression/output/.edge-slot.lock",
      );
      const held = acquireEdgeSlot({
        lockPath,
        owner: "another-tranche",
        isProcessAlive: () => true,
      });
      const launches = [];
      const code = await runProbe(fakeDescriptor(), {
        argv: [
          "--repository-root",
          root,
          "--output",
          path.join(root, "out"),
          "--no-serve-built",
        ],
        launch: async () => {
          launches.push("launched");
          return { close: async () => {} };
        },
      });
      assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
      assert.equal(launches.length, 0);
      held.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── A run that did not measure must not publish over one that did ─────────
  //
  // These are about the FILES, not the exit code. The exit code was already
  // right on a refusal; what was wrong is that the run still wrote
  // `<name>-report.json`, and a probe-owned envelope carries none of the
  // runtime's fields, so what landed was well-formed, reported zero failing
  // verdicts, and never mentioned the refusal. An output directory is what the
  // Evidence Repatriation rule harvests, so that document does not stay a
  // local mistake — it becomes the banked record of a measurement nobody took.

  /**
   * @param {string} out The output directory.
   * @returns {object} The bytes of every artifact a measured run publishes.
   */
  function bankedArtifacts(out) {
    return {
      report: readFileSync(path.join(out, "fake-probe-report.json")),
      runtime: readFileSync(path.join(out, "fake-probe-runtime.json")),
      summary: readFileSync(path.join(out, "fake-probe-summary.md")),
    };
  }

  /**
   * @param {string} root Repository root for the run.
   * @param {string} out Output directory for the run.
   * @returns {Promise<number>} The exit code of one measured 3-run probe.
   */
  function measureInto(root, out) {
    return runProbe(fakeDescriptor(), {
      argv: [
        "--repository-root",
        root,
        "--output",
        out,
        "--runs",
        "3",
        "--no-serve-built",
      ],
      now: () => Date.UTC(2026, 8, 2, 4, 0, 0),
      launch: async () => ({ close: async () => {} }),
    });
  }

  /**
   * @param {string} root Repository root for the run.
   * @param {string} out Output directory for the run.
   * @returns {Promise<number>} The exit code of one preflight-refused run.
   */
  function refuseInto(root, out) {
    return runProbe(fakeDescriptor(), {
      argv: ["--repository-root", root, "--output", out],
      now: () => Date.UTC(2026, 8, 2, 5, 0, 0),
      preflight: async () => ({
        ok: false,
        artifacts: [
          { path: "Build/CesiumUnminified/Cesium.js", match: false },
          { path: "packages/engine/Build/Unminified/index.js", match: true },
        ],
      }),
      launch: async () => ({ close: async () => {} }),
    });
  }

  await t.test(
    "a refusal leaves a banked receipt byte-identical and records itself beside it",
    async () => {
      const root = makeTempRoot();
      try {
        const out = path.join(root, "out");
        assert.equal(await measureInto(root, out), PROBE_EXIT_CODES.OK);
        const banked = bankedArtifacts(out);
        assert.equal(JSON.parse(banked.report).cells.length, 3);

        assert.equal(await refuseInto(root, out), PROBE_EXIT_CODES.REFUSAL);

        const after = bankedArtifacts(out);
        assert.deepEqual(
          after.report,
          banked.report,
          "the last real measurement must survive a refused run byte for byte",
        );
        assert.deepEqual(after.runtime, banked.runtime);
        assert.deepEqual(after.summary, banked.summary);

        const record = JSON.parse(
          readFileSync(path.join(out, "fake-probe-refusal.json"), "utf8"),
        );
        assert.equal(record.outcome, "refused");
        assert.equal(record.refusal.reason, "served-build-preflight-failed");
        assert.equal(record.generatedAt, "2026-09-02T05:00:00.000Z");
        assert.equal(record.origin, "http://localhost:8094");
        assert.equal(record.servedBuildAssertion, "enforced");
        assert.equal(record.preflight.ok, false);
        assert.equal(record.exitCode, PROBE_EXIT_CODES.REFUSAL);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "a refusal with nothing banked writes no success-shaped report",
    async () => {
      const root = makeTempRoot();
      try {
        const out = path.join(root, "out");
        assert.equal(await refuseInto(root, out), PROBE_EXIT_CODES.REFUSAL);

        // Absence is the signal: a reader who finds no report knows no
        // measurement was published, which an empty-but-well-formed one cannot
        // communicate however carefully it is worded.
        for (const name of [
          "fake-probe-report.json",
          "fake-probe-runtime.json",
          "fake-probe-summary.md",
        ]) {
          assert.equal(
            existsSync(path.join(out, name)),
            false,
            `${name} must not exist after a run that measured nothing`,
          );
        }
        assert.equal(
          existsSync(path.join(out, "fake-probe-refusal.json")),
          true,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "a wedged harness does not publish over the receipt either",
    async () => {
      const root = makeTempRoot();
      try {
        const out = path.join(root, "out");
        await measureInto(root, out);
        const banked = bankedArtifacts(out);

        const code = await runProbe(
          fakeDescriptor({
            cells: async () => {
              throw new Error("the harness wedged");
            },
          }),
          {
            argv: [
              "--repository-root",
              root,
              "--output",
              out,
              "--no-serve-built",
            ],
            launch: async () => ({ close: async () => {} }),
          },
        );
        assert.equal(code, PROBE_EXIT_CODES.ERROR);
        assert.deepEqual(bankedArtifacts(out).report, banked.report);

        const record = JSON.parse(
          readFileSync(path.join(out, "fake-probe-error.json"), "utf8"),
        );
        assert.equal(record.outcome, "errored");
        assert.equal(record.exitCode, PROBE_EXIT_CODES.ERROR);
        assert.match(record.error, /the harness wedged/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  await t.test("a measured run publishes and files no incident", async () => {
    const root = makeTempRoot();
    try {
      const out = path.join(root, "out");
      assert.equal(await measureInto(root, out), PROBE_EXIT_CODES.OK);
      assert.equal(JSON.parse(bankedArtifacts(out).report).cells.length, 3);
      assert.equal(
        existsSync(path.join(out, "fake-probe-refusal.json")),
        false,
      );
      assert.equal(existsSync(path.join(out, "fake-probe-error.json")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test(
    "MUTANT (inertness): an inert outcome guard destroys the banked receipt",
    async () => {
      // The guard's text stays; only its selectivity is removed, which is
      // exactly the pre-fix runtime. A spec that survived this would be
      // pinning the refusal record's existence and nothing about the receipt.
      const mutated = await importMutated(RUNTIME_PATH, [
        [
          "if (outcome === RUN_OUTCOMES.MEASURED) {",
          "if (true || outcome === RUN_OUTCOMES.MEASURED) {",
        ],
      ]);
      const root = makeTempRoot();
      try {
        const out = path.join(root, "out");
        await mutated.runProbe(fakeDescriptor(), {
          argv: [
            "--repository-root",
            root,
            "--output",
            out,
            "--runs",
            "3",
            "--no-serve-built",
          ],
          launch: async () => ({ close: async () => {} }),
        });
        const banked = readFileSync(path.join(out, "fake-probe-report.json"));
        await mutated.runProbe(fakeDescriptor(), {
          argv: ["--repository-root", root, "--output", out],
          preflight: async () => ({
            ok: false,
            artifacts: [
              { path: "Build/CesiumUnminified/Cesium.js", match: false },
            ],
          }),
          launch: async () => ({ close: async () => {} }),
        });
        const after = readFileSync(path.join(out, "fake-probe-report.json"));
        assert.notDeepEqual(
          after,
          banked,
          "the mutant must actually destroy the receipt",
        );
        assert.equal(
          JSON.parse(after).cells.length,
          0,
          "and replace it with a document reporting nothing",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

// ---------------------------------------------------------------------------
// F. Field identity of the migrated probe's receipt
// ---------------------------------------------------------------------------

/**
 * Every field path in a document, so "same fields" is checked as a set rather
 * than inferred from a deep-equality pass that also compares values.
 *
 * @param {unknown} value The document.
 * @param {string} [prefix] Path prefix.
 * @returns {string[]} Sorted, deduplicated field paths.
 */
function fieldPaths(value, prefix = "") {
  if (Array.isArray(value)) {
    const paths = new Set();
    for (const entry of value) {
      for (const p of fieldPaths(entry, `${prefix}[]`)) {
        paths.add(p);
      }
    }
    return [...paths].sort();
  }
  if (value === null || typeof value !== "object") {
    return prefix === "" ? [] : [prefix];
  }
  const paths = new Set();
  for (const [key, entry] of Object.entries(value)) {
    const next = prefix === "" ? key : `${prefix}.${key}`;
    paths.add(next);
    for (const p of fieldPaths(entry, next)) {
      paths.add(p);
    }
  }
  return [...paths].sort();
}

/**
 * The pre-runtime receipt, read LAZILY. A spec that touches the filesystem
 * while being imported cannot fail cleanly and cannot be imported by another
 * tool for its exports.
 *
 * @returns {object} The fixture.
 */
let fixtureCache = null;
function fixture() {
  if (fixtureCache === null) {
    fixtureCache = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  }
  return fixtureCache;
}

/**
 * @param {object} [namespace] The probe module namespace; defaults to the real one.
 * @returns {object} The receipt the migrated probe would publish for the fixture's cells.
 */
function rebuildFixtureReceipt(namespace) {
  const build = namespace?.buildColdStartReceipt ?? buildColdStartReceipt;
  const verdictsOf =
    namespace?.buildColdStartVerdicts ?? buildColdStartVerdicts;
  return build(fixture().cells, {
    generatedAt: fixture().generatedAt,
    harness: fixture().harness,
    runs: fixture().runs,
    verdicts: verdictsOf(fixture().cells, 0.005),
  });
}

test("F. the migrated probe publishes the pre-runtime document", async (t) => {
  await t.test("the fixture is not vacuous", () => {
    assert.deepEqual(Object.keys(fixture()), [
      "generatedAt",
      "harness",
      "runs",
      "cellOrder",
      "verdicts",
      "firstNonEmptyByCell",
      "cells",
    ]);
    assert.equal(fixture().cells.length, 8);
    assert.equal(fixture().verdicts.length, 4);
    assert.ok(fieldPaths(fixture()).length > 60);
  });

  await t.test("field paths are identical", () => {
    assert.deepEqual(
      fieldPaths(rebuildFixtureReceipt()),
      fieldPaths(fixture()),
    );
  });

  await t.test("key order is identical", () => {
    assert.deepEqual(
      Object.keys(rebuildFixtureReceipt()),
      Object.keys(fixture()),
    );
  });

  await t.test("values and serialization are identical", () => {
    assert.deepStrictEqual(rebuildFixtureReceipt(), fixture());
    assert.equal(
      normalizeJson(rebuildFixtureReceipt()),
      normalizeJson(fixture()),
    );
  });

  await t.test("MUTANT (absence): a dropped field is caught", async () => {
    const mutated = await importMutated(PROBE_PATH, [
      ["    runs: context.runs,\n", ""],
    ]);
    assert.throws(
      () =>
        assert.deepEqual(
          fieldPaths(rebuildFixtureReceipt(mutated)),
          fieldPaths(fixture()),
        ),
      { name: "AssertionError" },
    );
  });

  await t.test("MUTANT (addition): an extra field is caught", async () => {
    const mutated = await importMutated(PROBE_PATH, [
      [
        "    verdicts: context.verdicts,\n    firstNonEmptyByCell:",
        "    runtimeVersion: 1,\n    verdicts: context.verdicts,\n    firstNonEmptyByCell:",
      ],
    ]);
    assert.throws(
      () =>
        assert.deepEqual(
          fieldPaths(rebuildFixtureReceipt(mutated)),
          fieldPaths(fixture()),
        ),
      { name: "AssertionError" },
    );
  });

  await t.test("MUTANT (inertness): a dead gate filter is caught", async () => {
    // The filter's text stays; only its reachability is removed. A spec that
    // only survives DELETION would pass this one.
    const mutated = await importMutated(PROBE_PATH, [
      [
        'if (cell.gate !== "readiness") {',
        'if (false && cell.gate !== "readiness") {',
      ],
    ]);
    const receipt = rebuildFixtureReceipt(mutated);
    assert.equal(
      receipt.verdicts.length,
      8,
      "the mutant must actually change behaviour",
    );
    assert.throws(() => assert.deepStrictEqual(receipt, fixture()), {
      name: "AssertionError",
    });
  });

  await t.test("importing the probe does not run it", () => {
    // The entry guard is what lets a spec import the pure builders. If it were
    // removed, importing this module at the top of the file would have launched
    // Edge before any test ran.
    const source = readFileSync(PROBE_PATH, "utf8");
    assert.ok(source.includes("if (isEntryPoint(import.meta.url)) {"));
    assert.equal(typeof buildColdStartReceipt, "function");
  });
});

// A sentinel: the fixture must stay derived from the pre-runtime source, never
// regenerated from the migrated probe. Regenerating it from the file under test
// would make every assertion in group F circular.
test("G. the fixture records its provenance", () => {
  const receipt = rebuildFixtureReceipt();
  assert.notEqual(
    receipt.harness,
    "",
    "the fixture's harness url is the pre-runtime field, not a placeholder",
  );
  const temp = makeTempRoot();
  try {
    const copy = path.join(temp, "receipt.json");
    writeFileSync(copy, normalizeJson(fixture()));
    // EOL-normalized on both sides: what is being pinned is the SERIALIZATION
    // -- two-space JSON, key order, trailing newline -- not which checkout
    // wrote the file. The `.gitattributes` pin is what keeps the on-disk bytes
    // LF; this comparison is what keeps the document honest either way.
    const normalizeEol = (text) => text.replace(/\r\n/g, "\n");
    assert.equal(
      normalizeEol(readFileSync(copy, "utf8")),
      normalizeEol(readFileSync(FIXTURE_PATH, "utf8")),
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// H. Element-only capture, and the conditions a measurement ran under
// ---------------------------------------------------------------------------
//
// Capture is where a number gets attached to a picture, so the two ways it can
// lie are refusals rather than warnings: photographing nothing, and
// photographing whichever element happened to be first. `matchCount` is the
// field that makes the second one visible after the fact, and it is what the
// owed Edge leg compares against the banked pre-runtime black fractions.
//
// The launch flags are pinned here for the same reason. A flag is a
// measurement condition that leaves no trace in a result, so the runtime keeps
// its default to what the fleet shares and records what it actually used.

/**
 * A page whose locator resolves to `count` elements. `screenshot` writes the
 * bytes to the path it is handed, the way Playwright's does, so a test can ask
 * whether the PNG landed rather than trusting the return value.
 *
 * @param {object} options Options.
 * @param {number} options.count How many elements the selector matches.
 * @param {Buffer} options.bytes The bytes every screenshot returns.
 * @param {Array<object>} [options.calls] Sink recording each screenshot call.
 * @returns {object} The fake page.
 */
function fakePage({ count, bytes, calls = [] }) {
  const shoot = (index) => async (opts) => {
    calls.push({ index, path: opts?.path, type: opts?.type });
    if (opts?.path) {
      writeFileSync(opts.path, bytes);
    }
    return bytes;
  };
  return {
    calls,
    locator(selector) {
      return {
        selector,
        count: async () => count,
        nth: (index) => ({ screenshot: shoot(index) }),
        screenshot: shoot(undefined),
      };
    },
  };
}

test("H. element capture and launch conditions", async (t) => {
  await t.test(
    "zero matches refuses rather than returning nothing",
    async () => {
      const root = makeTempRoot();
      try {
        await assert.rejects(
          captureElement({
            page: fakePage({ count: 0, bytes: Buffer.from("png") }),
            selector: "canvas.scene",
            name: "webgpu",
            outputDirectory: root,
          }),
          (error) => {
            assert.ok(error instanceof ProbeRefusal);
            assert.equal(error.reason, "capture-selector-ambiguous");
            assert.equal(error.details.count, 0);
            return true;
          },
          "an empty capture is not a black frame",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  await t.test("several matches and no declared index refuses", async () => {
    const root = makeTempRoot();
    try {
      await assert.rejects(
        captureElement({
          page: fakePage({ count: 3, bytes: Buffer.from("png") }),
          name: "webgl",
          outputDirectory: root,
        }),
        (error) => {
          assert.equal(error.reason, "capture-selector-ambiguous");
          assert.equal(error.details.count, 3);
          return true;
        },
        "photographing the first of three is the silent failure this guards",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("one match records the bytes it actually took", async () => {
    const root = makeTempRoot();
    try {
      const bytes = Buffer.from("the pixels that were photographed");
      const captures = [];
      const record = await captureElement({
        page: fakePage({ count: 1, bytes }),
        name: "webgpu-far",
        outputDirectory: path.join(root, "nested"),
        captures,
      });
      assert.equal(record.matchCount, 1);
      assert.equal(record.byteLength, bytes.byteLength);
      assert.equal(record.sha256, sha256(bytes));
      assert.deepEqual(
        readFileSync(record.path),
        bytes,
        "the fingerprint must describe the file that was written",
      );
      assert.equal(captures.length, 1);
      assert.equal(captures[0].sha256, record.sha256);
      assert.equal(
        captures[0].buffer,
        undefined,
        "the receipt records the fingerprint, never the megabytes",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test(
    "a declared index takes that element and publishes matchCount",
    async () => {
      const root = makeTempRoot();
      try {
        const calls = [];
        const record = await captureElement({
          page: fakePage({ count: 2, bytes: Buffer.from("second"), calls }),
          selector: "canvas",
          index: 1,
          name: "split-right",
          outputDirectory: root,
          captures: [],
        });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].index, 1, "nth(1), not the first match");
        assert.equal(
          record.matchCount,
          2,
          "a page that grew a second canvas must be visible in the receipt",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "MUTANT (inertness): an inert match check photographs nothing and calls it a capture",
    async () => {
      const mutated = await importMutated(RUNTIME_PATH, [
        [
          "if (count === 0 || (count !== 1 && index === undefined)) {",
          "if (false && (count === 0 || (count !== 1 && index === undefined))) {",
        ],
      ]);
      const root = makeTempRoot();
      try {
        const record = await mutated.captureElement({
          page: fakePage({ count: 0, bytes: Buffer.from("png") }),
          name: "webgpu",
          outputDirectory: root,
        });
        assert.equal(
          record.matchCount,
          0,
          "the mutant must produce a record for a selector that matched nothing",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  await t.test("the runtime adds only the flag the fleet shares", async () => {
    assert.deepEqual(EDGE_LAUNCH_ARGS, ["--enable-unsafe-webgpu"]);
    let passed = null;
    await launchEdge({
      headed: false,
      chromium: {
        launch: async (opts) => {
          passed = opts;
          return { close: async () => {} };
        },
      },
    });
    assert.equal(passed.channel, "msedge");
    assert.equal(passed.headless, true);
    assert.deepEqual(passed.args, ["--enable-unsafe-webgpu"]);
  });

  await t.test(
    "a probe that needs other flags declares them, and they are recorded",
    async () => {
      const root = makeTempRoot();
      try {
        const out = path.join(root, "out");
        const launched = [];
        const code = await runProbe(
          {
            ...fakeDescriptor(),
            launchArgs: ["--enable-unsafe-webgpu", "--use-vulkan"],
          },
          {
            argv: [
              "--repository-root",
              root,
              "--output",
              out,
              "--no-serve-built",
            ],
            now: () => Date.UTC(2026, 8, 2, 4, 0, 0),
            launch: async (options) => {
              launched.push(options.launchArgs);
              return { close: async () => {} };
            },
          },
        );
        assert.equal(code, PROBE_EXIT_CODES.OK);
        assert.deepEqual(launched, [
          ["--enable-unsafe-webgpu", "--use-vulkan"],
        ]);
        const runtimeReceipt = JSON.parse(
          readFileSync(path.join(out, "fake-probe-runtime.json"), "utf8"),
        );
        assert.deepEqual(runtimeReceipt.launchArgs, [
          "--enable-unsafe-webgpu",
          "--use-vulkan",
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "an undeclared run records the default it launched with",
    async () => {
      const root = makeTempRoot();
      try {
        const out = path.join(root, "out");
        await runProbe(fakeDescriptor(), {
          argv: [
            "--repository-root",
            root,
            "--output",
            out,
            "--no-serve-built",
          ],
          now: () => Date.UTC(2026, 8, 2, 4, 0, 0),
          launch: async () => ({ close: async () => {} }),
        });
        const runtimeReceipt = JSON.parse(
          readFileSync(path.join(out, "fake-probe-runtime.json"), "utf8"),
        );
        assert.deepEqual(runtimeReceipt.launchArgs, ["--enable-unsafe-webgpu"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  await t.test("the required-artifact list has one owner", () => {
    // Identity, not deep equality: two lists that happen to agree today are
    // exactly the drift this catches, and the drift fails OPEN -- a third
    // bundle the preflight checks but the runtime does not require would go
    // missing from the refusal instead of into it.
    assert.equal(REQUIRED_SERVED_ARTIFACTS, DEFAULT_SERVED_BUILD_ARTIFACTS);
  });
});
