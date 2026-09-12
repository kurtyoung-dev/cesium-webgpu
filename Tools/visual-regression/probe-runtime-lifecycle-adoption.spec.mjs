// probe-runtime-lifecycle-adoption.spec.mjs — the staged adoption, asserted as
// behaviour rather than as source shape.
//
// Pure Node: no browser, no GPU, no build, no network. Every filesystem write
// lands under `<tmpdir>/cesium-lane/<lane>` through `withLaneTmp`.
//
// WHAT THIS PINS. `C13-42a` adopted a probe lifecycle that hands
// `descriptor.cells` a tracked `scope` and bounds the whole run with a deadline
// derived from the probe's own declared work budget. The version it was adopted
// from made that budget REQUIRED, which would have killed every probe on this
// runtime that declares none — 18 of them, measured in the adopting tree; the
// figure of 21 in the record is from an earlier one. So the adoption turns on
// ONE predicate — does the descriptor declare `workBudgetMs`? — and everything
// below exists to make that predicate, and the machinery behind it, impossible
// to leave decorative:
//
//   A. a descriptor with no budget is handed no scope, takes the lock-file Edge
//      slot, and publishes the same artifacts it always did; a descriptor with
//      a budget is handed a scope carrying every member the C13-42 probe uses;
//   B. work that outlives its budget is STOPPED, writes no receipt, and records
//      the orderly deadline by name in its incident file — with a same-shaped
//      probe that finishes inside the budget as the negative control;
//   C. the C13-42 probe's scope members are a subset of what the runtime hands
//      out, its seventeen `scope.run` sites and two `scope.checkpoint` sites are
//      all still there, and it reaches its own refusal tree in a Node dry run
//      with `launch` wired to throw;
//   D. both response-cap sites read the landed per-subject apparatus rather than
//      the module constant they used to read;
//   E. the ownership and cancellation machinery this fork wrote ITSELF — the
//      lock-file lease adapter, the post-run `assertHeld()` bracket, and
//      `checkpoint` — actually decides outcomes. Group E was added after review
//      (Calimehtar, 2026-09-12) found that three independent mutants of exactly
//      that machinery survived A-D green;
//   F. what the work registry really guarantees (the run outlives its unawaited
//      work, and a failing item costs the run its receipt) AND what it does not
//      (the browser closes concurrently with the drain; the hard stop writes no
//      artifact at all). Group F was added after adversarial verification
//      (Ciryaher, 2026-09-12) REFUTED this lane's documentation — five documents
//      said work is "drained before the browser is closed", which is the
//      opposite of what the code does. The limits are asserted, not just the
//      guarantees, so the corrected prose cannot quietly rot back;
//   G. a malformed third argument to `scope.run` is REPORTED — the work it
//      drops costs the run its receipt instead of being published over. The
//      hole (the run exited 0 over work that never ran) was found in the
//      fifth adversarial round and filed as `C13-42a-3` item 8; group G
//      characterized it until the item was closed on 2026-09-12, and was
//      inverted then, as its header required;
//   H. the descriptor scope's `checkpoint` is the LIFECYCLE's checkpoint and
//      not a look-alike — the member a probe calls to abandon its own work
//      early really does observe cancellation.
//
// MUTANTS. Every group that claims something is live re-imports the module
// through a source mutation that makes the mechanism UNREACHABLE while leaving
// its text in place (`if (false && …)`), and requires the assertion to go red.
// Deleting code is the easy mutation and most specs survive it; inertness is
// what catches a mechanism that is only decorative. Each mutation asserts its
// anchor occurs exactly once, so a moved anchor fails loudly instead of
// silently mutating nothing.
//
// One finding is recorded in the tests rather than in prose: a stolen Edge slot
// is caught by TWO guards, so no single-guard mutant flips it. E4 and E5 show
// each guard catching the theft with the other inert, and E6 shows the run
// reporting only when both are inert.
//
// Run: node --test Tools/visual-regression/probe-runtime-lifecycle-adoption.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import {
  initialCoreSubjects,
  servedResponseBudgetFor,
  servedResponseBudgetMs,
} from "./lib/c13-42-reproduction-contract.mjs";
import { acquireEdgeSlot, withEdgeSlot } from "./lib/probe-edge-slot.mjs";
import {
  deriveLifecycleDeadline,
  HARD_STOP_GRACE_MS,
  LAUNCH_BUDGET_MS,
  PREFLIGHT_BUDGET_MS,
  RESOURCE_CLOSE_DEADLINE_MS,
  RUN_SETTLEMENT_MARGIN_MS,
  runDescriptorUnderLifecycle,
} from "./lib/probe-lifecycle-run.mjs";
import {
  closeBrowserAfter,
  makeWorkRegistry,
} from "./lib/probe-work-registry.mjs";
import { PROBE_EXIT_CODES, runProbe } from "./lib/probe-runtime.mjs";
import {
  appendC13_42ServedResponse,
  descriptor as c13_42Descriptor,
  workBudgetMs as c13_42WorkBudgetMs,
} from "./probe-c13-42-reported-demos.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_PATH = path.join(HERE, "lib", "probe-runtime.mjs");
const LIFECYCLE_PATH = path.join(HERE, "lib", "probe-lifecycle.mjs");
const LIFECYCLE_RUN_PATH = path.join(HERE, "lib", "probe-lifecycle-run.mjs");
const WORK_REGISTRY_PATH = path.join(HERE, "lib", "probe-work-registry.mjs");
const SLOT_PATH = path.join(HERE, "lib", "probe-edge-slot.mjs");
const C13_42_PROBE_PATH = path.join(HERE, "probe-c13-42-reported-demos.mjs");
const SLOT_LOCK_RELATIVE = path.join(
  "Tools",
  "visual-regression",
  "output",
  ".edge-slot.lock",
);

/** The per-response drain budget the probe charges; mirrored from its source. */
const RESPONSE_BODY_BUDGET_MS = 30_000;

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
  // Normalized on the way in: a spec whose anchors only match under one
  // checkout's line endings reports on the checkout, not on the code.
  let source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const base = pathToFileURL(path.dirname(file) + path.sep).href;
  source = source.replaceAll('from "./', `from "${base}`);
  source = source.replaceAll('from "../', `from "${base}../`);
  // A `data:` module has no `import.meta.url` a file url can be recovered
  // from, and a probe that resolves its own path at module scope would die
  // there before any mutation could be observed. Pinning it to the real file
  // is what keeps the mutant a mutant of THIS module rather than of a module
  // that cannot locate itself.
  source = source.replaceAll(
    "import.meta.url",
    JSON.stringify(pathToFileURL(file).href),
  );
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
 * The absolute file-url prefix `importMutated` rewrites a module's relative
 * specifiers to. Needed when a mutant has to REDIRECT one of those imports,
 * because by then the specifier is no longer `./name.mjs`.
 *
 * @param {string} file Absolute path of the importing module.
 * @returns {string} The base url its siblings resolve under.
 */
function moduleBaseUrl(file) {
  return pathToFileURL(path.dirname(file) + path.sep).href;
}

/**
 * The same mutation as {@link importMutated}, but returning the data url rather
 * than importing it — so a mutant can be spliced into ANOTHER module's import
 * graph. That is the only way to reach a mechanism two modules deep without
 * writing a mutated file to disk.
 *
 * @param {string} file Absolute path of the module to mutate.
 * @param {Array<[string, string]>} replacements Anchor/replacement pairs.
 * @returns {string} A `data:` url for the mutated module.
 */
function mutatedSourceUrl(file, replacements = []) {
  let source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const base = moduleBaseUrl(file);
  source = source.replaceAll('from "./', `from "${base}`);
  source = source.replaceAll('from "../', `from "${base}../`);
  source = source.replaceAll(
    "import.meta.url",
    JSON.stringify(pathToFileURL(file).href),
  );
  for (const [anchor, replacement] of replacements) {
    const occurrences = source.split(anchor).length - 1;
    assert.equal(
      occurrences,
      1,
      `mutation anchor must occur exactly once, found ${occurrences}: ${anchor}`,
    );
    source = source.replace(anchor, replacement);
  }
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * A browser the lifecycle can acquire, observe and prove closed, with no Edge
 * anywhere near it.
 *
 * @returns {object} The fake browser.
 */
function fakeBrowser() {
  let connected = true;
  return {
    isConnected: () => connected,
    close: async () => {
      connected = false;
    },
  };
}

/**
 * Read a probe's artifacts out of a run root.
 *
 * @param {string} root Repository root the run was pointed at.
 * @param {string} name Probe name.
 * @returns {{directory: string, files: string[]}} What the run published.
 */
function artifactsOf(root, name) {
  const directory = path.join(
    root,
    "Tools",
    "visual-regression",
    "output",
    name,
  );
  return {
    directory,
    files: fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [],
  };
}

// ---------------------------------------------------------------------------
// A. The opt-in is one field, and it is the field that decides
// ---------------------------------------------------------------------------

test("A. the opt-in switch", async (t) => {
  /**
   * @param {object} overrides Descriptor fields to merge in.
   * @returns {object} A descriptor that records the context it was handed.
   */
  const recordingDescriptor = (overrides) => {
    const seen = [];
    return {
      seen,
      descriptor: {
        name: overrides.name,
        async cells(context) {
          seen.push(context);
          return [{ run: context.run }];
        },
        receipt: (cells) => ({ cells }),
        verdicts: () => [{ id: "measured", pass: true }],
        ...overrides,
      },
    };
  };

  await t.test(
    "a descriptor that declares NO workBudgetMs is handed no scope and still measures",
    () =>
      withLaneTmp("adoption-legacy-", async (root) => {
        const { seen, descriptor } = recordingDescriptor({ name: "legacy" });
        assert.equal(
          descriptor.workBudgetMs,
          undefined,
          "the fixture must be the legacy shape",
        );
        const exitCode = await runProbe(descriptor, {
          argv: ["--no-serve-built", "--repository-root", root],
          launch: async () => fakeBrowser(),
        });
        assert.equal(exitCode, PROBE_EXIT_CODES.OK);
        assert.equal(seen.length, 1);
        assert.ok(
          !Object.hasOwn(seen[0], "scope"),
          "the pre-adoption context must not grow a scope key",
        );
        assert.deepEqual(Object.keys(seen[0]).sort(), [
          "browser",
          "captures",
          "options",
          "origin",
          "outputDirectory",
          "repositoryRoot",
          "run",
        ]);
        assert.deepEqual(artifactsOf(root, "legacy").files, [
          "legacy-report.json",
          "legacy-runtime.json",
          "legacy-summary.md",
        ]);
      }),
  );

  await t.test(
    "a descriptor that declares workBudgetMs is handed a working scope",
    () =>
      withLaneTmp("adoption-declaring-", async (root) => {
        const { seen, descriptor } = recordingDescriptor({
          name: "declaring",
          workBudgetMs: () => 5_000,
          async cells(context) {
            seen.push(context);
            const value = await context.scope.run("unit", async () => 7);
            context.scope.checkpoint();
            return [{ value }];
          },
        });
        const exitCode = await runProbe(descriptor, {
          argv: ["--no-serve-built", "--repository-root", root],
          launch: async () => fakeBrowser(),
        });
        assert.equal(exitCode, PROBE_EXIT_CODES.OK);
        assert.equal(seen.length, 1);
        assert.ok(
          seen[0].scope,
          "a declaring descriptor must be handed a scope",
        );
        assert.equal(typeof seen[0].scope.run, "function");
        assert.equal(typeof seen[0].scope.checkpoint, "function");
        assert.equal(typeof seen[0].scope.race, "function");
        assert.ok(seen[0].scope.signal, "the scope must carry an abort signal");
        const report = JSON.parse(
          fs.readFileSync(
            path.join(
              artifactsOf(root, "declaring").directory,
              "declaring-report.json",
            ),
            "utf8",
          ),
        );
        assert.deepEqual(report.cells, [{ value: 7 }]);
      }),
  );

  await t.test(
    "INERTNESS: with the opt-in predicate unreachable, a declaring descriptor loses its scope",
    () =>
      withLaneTmp("adoption-inert-", async (root) => {
        const mutated = await importMutated(RUNTIME_PATH, [
          [
            "const lifecycleAdopted = descriptor.workBudgetMs !== undefined;",
            "const lifecycleAdopted = false && descriptor.workBudgetMs !== undefined;",
          ],
        ]);
        const seen = [];
        const exitCode = await mutated.runProbe(
          {
            name: "inert",
            workBudgetMs: () => 5_000,
            async cells(context) {
              seen.push(context);
              return [
                { scope: context.scope === undefined ? "absent" : "present" },
              ];
            },
            receipt: (cells) => ({ cells }),
          },
          {
            argv: ["--no-serve-built", "--repository-root", root],
            launch: async () => fakeBrowser(),
          },
        );
        assert.equal(exitCode, PROBE_EXIT_CODES.OK);
        assert.equal(
          seen.length,
          1,
          "the mutant must still reach the descriptor",
        );
        assert.equal(
          seen[0].scope,
          undefined,
          "the mutant must actually withhold the scope — otherwise the live assertion proves nothing",
        );
      }),
  );

  await t.test(
    "both paths publish the same receipt shape and the same exit code for a red verdict",
    () =>
      withLaneTmp("adoption-parity-", async (root) => {
        const observed = [];
        for (const [name, workBudgetMs] of [
          ["parity-lifecycle", () => 5_000],
          ["parity-legacy", undefined],
        ]) {
          const exitCode = await runProbe(
            {
              name,
              ...(workBudgetMs === undefined ? {} : { workBudgetMs }),
              cells: async () => [{ ok: false }],
              receipt: (cells) => ({ cells }),
              verdicts: () => [{ id: "red", pass: false }],
            },
            {
              argv: ["--no-serve-built", "--repository-root", root],
              launch: async () => fakeBrowser(),
            },
          );
          const runtime = JSON.parse(
            fs.readFileSync(
              path.join(
                artifactsOf(root, name).directory,
                `${name}-runtime.json`,
              ),
              "utf8",
            ),
          );
          observed.push({
            exitCode,
            verdicts: runtime.verdicts,
            edgeSlotKeys: Object.keys(runtime.edgeSlot).sort(),
            servedBuildAssertion: runtime.servedBuildAssertion,
            files: artifactsOf(root, name).files.map((file) =>
              file.replace(name, "<probe>"),
            ),
          });
        }
        // A measured red must cost the same on either path. A run that scored
        // a failing verdict and exited 0 because its verdicts were assembled
        // on the wrong side of the composition root is the defect this pins.
        assert.equal(observed[0].exitCode, PROBE_EXIT_CODES.FAILURE);
        assert.deepEqual(observed[0], observed[1]);
      }),
  );

  await t.test(
    "a declared-but-malformed budget is rejected, never ignored",
    () =>
      withLaneTmp("adoption-malformed-", async (root) => {
        for (const budget of [() => 0, () => -1, () => 1.5, () => "600000"]) {
          const exitCode = await runProbe(
            {
              name: "malformed",
              workBudgetMs: budget,
              cells: async () => [{}],
            },
            {
              argv: ["--no-serve-built", "--repository-root", root],
              launch: async () => {
                throw new Error("a malformed budget must not reach a browser");
              },
            },
          );
          assert.equal(
            exitCode,
            PROBE_EXIT_CODES.ERROR,
            `a budget of ${budget()} must be refused as an error, not silently ignored`,
          );
        }
      }),
  );

  await t.test("the deadline is composed from the declared budget", () => {
    const deadline = deriveLifecycleDeadline(
      { runs: 3, timeoutMs: 120_000 },
      { workBudgetMs: () => 1_000 },
    );
    assert.equal(
      deadline,
      PREFLIGHT_BUDGET_MS +
        3 * (LAUNCH_BUDGET_MS + 1_000 + RUN_SETTLEMENT_MARGIN_MS),
    );
    // A deadline that raising the budget does not move is a deadline that is
    // not paying for the work the raise bought.
    assert.equal(
      deriveLifecycleDeadline(
        { runs: 3, timeoutMs: 120_000 },
        { workBudgetMs: () => 2_000 },
      ) - deadline,
      3_000,
    );
    assert.ok(
      HARD_STOP_GRACE_MS > RESOURCE_CLOSE_DEADLINE_MS,
      "the hard stop must leave room for a bounded close to settle",
    );
  });
});

// ---------------------------------------------------------------------------
// B. The budget is enforced
// ---------------------------------------------------------------------------

/**
 * Run a descriptor whose work never settles, with the orderly deadline's timer
 * fired immediately instead of four minutes from now.
 *
 * @param {string} root Repository root for the run.
 * @param {object} options Options.
 * @param {Function} [options.runProbeImpl] Runtime under test.
 * @param {object} [options.lifecycle] Lifecycle implementation override.
 * @param {boolean} [options.settle] Whether the work settles inside its budget.
 * @returns {Promise<{exitCode: number, exits: number[], files: string[], directory: string}>} What the run did.
 */
async function runWedgedProbe(
  root,
  { runProbeImpl = runProbe, lifecycle, settle = false } = {},
) {
  let release;
  const descriptor = {
    name: "overrun",
    workBudgetMs: () => 5_000,
    async cells(context) {
      await context.scope.run(
        "work",
        () =>
          settle
            ? Promise.resolve("done")
            : new Promise((resolve) => {
                release = resolve;
              }),
        { abort: () => release?.(undefined) },
      );
      return [{ measured: true }];
    },
    receipt: (cells) => ({ cells }),
    verdicts: () => [{ id: "measured", pass: true }],
  };
  const deadlineMs = deriveLifecycleDeadline(
    { runs: 1, timeoutMs: 120_000 },
    descriptor,
  );
  const exits = [];
  const exitCode = await runProbeImpl(descriptor, {
    argv: ["--no-serve-built", "--repository-root", root],
    launch: async () => fakeBrowser(),
    ...(lifecycle === undefined ? {} : { lifecycle }),
    lifecycleDependencies: {
      setTimeout(callback, delay) {
        // Only the orderly timer is shortened; every other budget keeps its
        // real duration, so a pass here is a pass about the deadline and not
        // about a harness that fires everything at once.
        return setTimeout(callback, delay === deadlineMs ? 0 : delay);
      },
      clearTimeout,
      exit: (code) => exits.push(code),
      writeDiagnostic: () => {},
    },
  });
  return { exitCode, exits, ...artifactsOf(root, "overrun") };
}

test("B. work that outlives its budget is stopped", async (t) => {
  await t.test("the wedged run writes an incident, never a receipt", () =>
    withLaneTmp("adoption-overrun-", async (root) => {
      const result = await runWedgedProbe(root);
      assert.equal(result.exitCode, PROBE_EXIT_CODES.ERROR);
      assert.deepEqual(result.files, ["overrun-error.json"]);
      const record = JSON.parse(
        fs.readFileSync(
          path.join(result.directory, "overrun-error.json"),
          "utf8",
        ),
      );
      assert.equal(record.outcome, "errored");
      // THE RECEIPT FACT. A stopped run names the obligation it missed, by
      // label, in the incident file — not only in a console line nobody banks.
      assert.ok(
        Array.isArray(record.lifecycleFailures),
        "a stopped run must project its lifecycle failures into the incident",
      );
      assert.ok(
        record.lifecycleFailures.some(
          (failure) => failure.label === "orderly deadline",
        ),
        `the orderly deadline must be named: ${JSON.stringify(record.lifecycleFailures)}`,
      );
      assert.equal(record.verdicts.length, 0);
    }),
  );

  await t.test(
    "NEGATIVE CONTROL: the same probe finishing inside its budget measures",
    () =>
      withLaneTmp("adoption-inbudget-", async (root) => {
        const result = await runWedgedProbe(root, { settle: true });
        assert.equal(result.exitCode, PROBE_EXIT_CODES.OK);
        assert.deepEqual(result.files, [
          "overrun-report.json",
          "overrun-runtime.json",
          "overrun-summary.md",
        ]);
      }),
  );

  await t.test(
    "INERTNESS: with the orderly stop unreachable, the wedged run is not stopped",
    () =>
      withLaneTmp("adoption-overrun-inert-", async (root) => {
        const mutated = await importMutated(LIFECYCLE_PATH, [
          [
            '() => settleStop("deadline"),\n    deadlineMs,',
            '() => false && settleStop("deadline"),\n    deadlineMs,',
          ],
        ]);
        const finished = await Promise.race([
          runWedgedProbe(root, { lifecycle: mutated.withProbeLifecycle }).then(
            () => "returned",
          ),
          new Promise((resolve) =>
            setTimeout(() => resolve("still-running"), 3_000),
          ),
        ]);
        assert.equal(
          finished,
          "still-running",
          "the mutant must actually leave the run wedged — otherwise the stop above proves nothing",
        );
      }),
  );
});

// ---------------------------------------------------------------------------
// C. The C13-42 call sites resolve against the adopted runtime
// ---------------------------------------------------------------------------

test("C. the C13-42 probe resolves against the runtime", async (t) => {
  const source = fs
    .readFileSync(C13_42_PROBE_PATH, "utf8")
    .replace(/\r\n/g, "\n");

  await t.test(
    "the seventeen scope.run sites and two checkpoints are present",
    () => {
      assert.equal(source.split("scope.run(").length - 1, 17);
      assert.equal(source.split("scope.checkpoint(").length - 1, 2);
      assert.ok(
        c13_42Descriptor.workBudgetMs === c13_42WorkBudgetMs,
        "the probe must declare its budget, which is what puts it on the lifecycle",
      );
    },
  );

  await t.test(
    "every scope member the probe uses is a member the runtime hands out",
    () =>
      withLaneTmp("adoption-members-", async (root) => {
        const used = new Set(
          [...source.matchAll(/\bscope\.([A-Za-z0-9_$]+)/g)].map(
            (match) => match[1],
          ),
        );
        assert.ok(used.size > 0, "the probe must actually use a scope");
        let handed;
        await runProbe(
          {
            name: "members",
            workBudgetMs: () => 5_000,
            async cells(context) {
              handed = context.scope;
              return [{}];
            },
            receipt: () => ({}),
          },
          {
            argv: ["--no-serve-built", "--repository-root", root],
            launch: async () => fakeBrowser(),
          },
        );
        for (const member of used) {
          assert.equal(
            typeof handed[member],
            "function",
            `the runtime's scope must provide ${member}(), which the C13-42 probe calls`,
          );
        }
      }),
  );

  await t.test(
    "the probe reaches its own refusal tree in a Node dry run, with no browser",
    () =>
      withLaneTmp("adoption-dryrun-", async (root) => {
        let launches = 0;
        const launch = async () => {
          launches++;
          throw new Error("this lane opens no browser");
        };
        const exitCode = await runProbe(c13_42Descriptor, {
          argv: [
            "--no-serve-built",
            "--repository-root",
            root,
            "--renderer",
            "both",
          ],
          launch,
        });
        assert.equal(
          exitCode,
          PROBE_EXIT_CODES.REFUSAL,
          "the probe's own two-renderer refusal must decide the run",
        );
        assert.equal(launches, 0, "the refusal must precede any browser");
        const record = JSON.parse(
          fs.readFileSync(
            path.join(
              artifactsOf(root, "c13-42-reported-demos").directory,
              "c13-42-reported-demos-refusal.json",
            ),
            "utf8",
          ),
        );
        assert.equal(record.outcome, "refused");
        assert.equal(record.refusal.reason, "c13-42-renderer-scope");
      }),
  );

  await t.test("a second refusal branch is reachable the same way", () =>
    withLaneTmp("adoption-dryrun2-", async (root) => {
      const exitCode = await runProbe(c13_42Descriptor, {
        argv: [
          "--no-serve-built",
          "--repository-root",
          root,
          "--runs",
          "2",
          "--renderer",
          "webgpu",
        ],
        launch: async () => {
          throw new Error("this lane opens no browser");
        },
      });
      assert.equal(exitCode, PROBE_EXIT_CODES.REFUSAL);
      const record = JSON.parse(
        fs.readFileSync(
          path.join(
            artifactsOf(root, "c13-42-reported-demos").directory,
            "c13-42-reported-demos-refusal.json",
          ),
          "utf8",
        ),
      );
      assert.equal(record.refusal.reason, "c13-42-single-repeat-contract");
    }),
  );
});

// ---------------------------------------------------------------------------
// D. Both cap sites read the landed apparatus
// ---------------------------------------------------------------------------

test("D. the response cap comes from the landed apparatus", async (t) => {
  const subjects = initialCoreSubjects();

  await t.test(
    "site 1: the listener retains exactly this subject's bound",
    () => {
      for (const subject of subjects) {
        const cap = servedResponseBudgetFor(subject);
        assert.ok(
          Number.isSafeInteger(cap) && cap > 48,
          `${subject.id} must carry the raised derived bound, got ${cap}`,
        );
        const responses = [];
        const seen = new Set();
        const origins = new Set(["http://localhost:8094"]);
        const response = (index) => ({
          url: () =>
            `http://localhost:8094/Build/CesiumUnminified/chunk-${index}.js`,
        });
        for (let index = 0; index < cap; index++) {
          assert.equal(
            appendC13_42ServedResponse(
              responses,
              seen,
              response(index),
              origins,
              cap,
            ),
            null,
            "a response inside the bound is retained, not reported as overflow",
          );
        }
        assert.equal(responses.length, cap);
        assert.equal(
          appendC13_42ServedResponse(
            responses,
            seen,
            response(cap),
            origins,
            cap,
          ),
          `http://localhost:8094/Build/CesiumUnminified/chunk-${cap}.js`,
          "the first response past the bound is reported as overflow",
        );
        assert.equal(
          responses.length,
          cap,
          "an overflowing response is not retained",
        );
      }
    },
  );

  await t.test("site 1 refuses a bound that was never supplied", () => {
    assert.throws(
      () =>
        appendC13_42ServedResponse(
          [],
          new Set(),
          { url: () => "x" },
          new Set(),
        ),
      RangeError,
      "a missing per-subject bound must fail loudly rather than fall back to a constant",
    );
  });

  await t.test(
    "site 2: the work budget carries the per-subject response term",
    async () => {
      const options = { renderers: ["webgpu"], runs: 1 };
      const live = c13_42WorkBudgetMs(options);
      const withoutResponses = await importMutated(C13_42_PROBE_PATH, [
        [
          "servedResponseBudgetMs(RESPONSE_BODY_BUDGET_MS, schedule.coreSubjects)",
          "0",
        ],
      ]);
      const delta = live - withoutResponses.workBudgetMs(options);
      assert.equal(
        delta,
        servedResponseBudgetMs(RESPONSE_BODY_BUDGET_MS, subjects),
        "the work budget's response term must be the apparatus's per-subject sum",
      );
      // And it must differ from the constant the site used to read, or wiring it
      // would have been a rename.
      assert.notEqual(
        delta,
        48 * subjects.length * RESPONSE_BODY_BUDGET_MS,
        "the wired term must not coincide with the retired 48-response constant",
      );
    },
  );

  await t.test(
    "INERTNESS: with the bound unreachable, the listener stops bounding",
    async () => {
      const mutated = await importMutated(C13_42_PROBE_PATH, [
        [
          "const overflowing = responses.length >= cap;",
          "const overflowing = false && responses.length >= cap;",
        ],
      ]);
      const cap = servedResponseBudgetFor(subjects[0]);
      const responses = [];
      const seen = new Set();
      const origins = new Set(["http://localhost:8094"]);
      for (let index = 0; index <= cap; index++) {
        mutated.appendC13_42ServedResponse(
          responses,
          seen,
          {
            url: () =>
              `http://localhost:8094/Build/CesiumUnminified/chunk-${index}.js`,
          },
          origins,
          cap,
        );
      }
      assert.equal(
        responses.length,
        cap + 1,
        "the mutant must actually let the bound be exceeded — otherwise the live assertion proves nothing",
      );
    },
  );

  await t.test("the probe no longer carries its own cap constant", () => {
    const executable = fs
      .readFileSync(C13_42_PROBE_PATH, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    assert.ok(
      !executable.includes("MAX_SERVED_RESPONSES"),
      "a surviving module constant is a second cap that a raise would not reach",
    );
  });

  // C13-42b. The bound is enforced correctly; what was wrong is the COUNT the
  // enforcement reports. `seenUrls` was written only on the retaining path, so
  // a url seen twice past the bound was reported twice, and the banked figures
  // (125, 58, 12 on 2026-09-09) are sighting counts standing in for distinct
  // urls. The pair below pins the corrected polarity and proves the hoist is
  // what produces it.
  const driveOverflow = (append, cap, sightings) => {
    const origins = new Set(["http://localhost:8094"]);
    const url = (index) =>
      `http://localhost:8094/Build/CesiumUnminified/chunk-${index}.js`;
    const responses = [];
    const seen = new Set();
    for (let index = 0; index < cap; index++) {
      append(responses, seen, { url: () => url(index) }, origins, cap);
    }
    const reported = [];
    for (let sighting = 0; sighting < sightings; sighting++) {
      const overflow = append(
        responses,
        seen,
        { url: () => url(cap) },
        origins,
        cap,
      );
      if (overflow !== null) {
        reported.push(overflow);
      }
    }
    return { reported, retained: responses.length, expected: url(cap) };
  };

  await t.test(
    "C13-42b: one url past the bound is reported once however often it is seen",
    () => {
      // Playwright emits one `response` event per response, and a page that
      // re-requests an asset — a redirect chain, a revalidation, a second
      // navigation — emits the same url again. Past the bound that is ONE
      // distinct overflowing url, however many sightings it makes.
      const cap = servedResponseBudgetFor(subjects[0]);
      const run = driveOverflow(appendC13_42ServedResponse, cap, 5);
      assert.deepEqual(
        run.reported,
        [run.expected],
        "five sightings of one url past the bound are one overflowing url",
      );
      assert.equal(run.retained, cap, "and none of the sightings is retained");
    },
  );

  await t.test(
    "INERTNESS: recorded only on retention, the same url is reported five times",
    async () => {
      // The fix is the hoist. Putting the record back after the cap return
      // makes it unreachable for an overflowing url, which is this defect's
      // inertness form — the assertion above must not survive it.
      const mutated = await importMutated(C13_42_PROBE_PATH, [
        [
          "const overflowing = responses.length >= cap;\n  seenUrls.add(url);\n  if (overflowing) return url;",
          "const overflowing = responses.length >= cap;\n  if (overflowing) return url;\n  seenUrls.add(url);",
        ],
      ]);
      const cap = servedResponseBudgetFor(subjects[0]);
      const run = driveOverflow(mutated.appendC13_42ServedResponse, cap, 5);
      assert.equal(
        run.reported.length,
        5,
        "the mutant must report every sighting — otherwise the live assertion proves nothing",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// E. The ownership mechanism this fork invented in place of Astra's listener
// ---------------------------------------------------------------------------
//
// WHY THIS GROUP EXISTS. Groups A-D were reviewed (Calimehtar, 2026-09-12) with
// six independent mutants, and three of them SURVIVED green: making
// `scope.checkpoint` a no-op, removing the post-run `assertHeld()` bracket, and
// making `assertHeld()` structurally unable to observe a lost slot. That is the
// worst place for a blind spot — the lock-file lease adapter is the part this
// fork wrote itself instead of adopting, so nobody else's tests cover it
// either. Each test below is paired with the mutant that survived.

test("E. slot ownership and cancellation are live, not decorative", async (t) => {
  /**
   * The inputs `runDescriptorUnderLifecycle` needs, with no browser anywhere.
   *
   * @param {string} root Repository root for the run.
   * @param {object} descriptor The descriptor under test.
   * @param {object} [extra] Overrides merged into the inputs.
   * @returns {object} The inputs plus the mutable state object.
   */
  const lifecycleInputs = (root, descriptor, extra = {}) => {
    const state = { slot: null, verdicts: [] };
    return {
      state,
      inputs: {
        descriptor,
        options: { runs: 1, timeoutMs: 120_000, headed: false },
        origin: "http://localhost:8094",
        outputDirectory: path.join(root, "out"),
        repositoryRoot: root,
        captures: [],
        cells: [],
        launchArgs: [],
        edgeSlotLockPath: path.join(root, SLOT_LOCK_RELATIVE),
        preflight: async () => {},
        launch: async () => fakeBrowser(),
        state,
        ...extra,
      },
    };
  };

  /**
   * Overwrite the Edge-slot lock with a foreign holder, the way a later job
   * reclaiming it as stale would.
   *
   * @param {string} lockPath Where the lock lives.
   * @returns {void}
   */
  const stealSlot = (lockPath) => {
    const holder = {
      owner: "another-job",
      pid: process.pid,
      acquiredAt: Date.now(),
      token: "not-ours",
    };
    fs.writeFileSync(lockPath, `${JSON.stringify(holder, null, 2)}\n`);
  };

  await t.test(
    "heldByUs() is a real ownership check, not a presence check",
    () =>
      withLaneTmp("adoption-ownership-", (root) => {
        const lockPath = path.join(root, SLOT_LOCK_RELATIVE);
        const mine = acquireEdgeSlot({
          lockPath,
          owner: "mine",
          now: Date.now(),
        });
        assert.equal(mine.heldByUs(), true);
        // A later job reclaims it as stale. The FILE is still there, so a
        // presence check would report that nothing had changed.
        const theirs = acquireEdgeSlot({
          lockPath,
          owner: "theirs",
          now: Date.now(),
          staleAfterMs: 1,
        });
        assert.equal(theirs.reclaimed, "stale-lock");
        assert.equal(fs.existsSync(lockPath), true);
        assert.equal(mine.heldByUs(), false, "presence is not ownership");
        assert.equal(theirs.heldByUs(), true);
        theirs.release();
      }),
  );

  await t.test(
    "withEdgeSlot fails a callback whose slot was taken, and reports the release did not succeed",
    () =>
      withLaneTmp("adoption-slotloss-", async (root) => {
        const lockPath = path.join(root, SLOT_LOCK_RELATIVE);
        let observed;
        await assert.rejects(
          withEdgeSlot(
            {
              owner: "victim",
              lockPath,
              onLeaseObservation: (observation) => {
                observed = observation;
              },
            },
            async () => {
              stealSlot(lockPath);
              return "measured anyway";
            },
          ),
          "a run whose slot was taken must not return a measurement",
        );
        const release = await observed.releaseOutcome;
        assert.equal(release.attempted, true);
        assert.equal(
          release.succeeded,
          false,
          "a slot already reclaimed was never ours to give back",
        );
        await observed.whenClosed;
      }),
  );

  await t.test(
    "the post-run assertHeld bracket fails a run that lost its slot",
    () =>
      withLaneTmp("adoption-bracket-", async (root) => {
        const { inputs } = lifecycleInputs(root, {
          name: "stolen",
          workBudgetMs: () => 5_000,
          async cells(context) {
            stealSlot(path.join(root, SLOT_LOCK_RELATIVE));
            context.scope.checkpoint();
            return [{ measured: true }];
          },
        });
        await assert.rejects(
          runDescriptorUnderLifecycle(inputs),
          "a run that finished on a slot it no longer held must fail, not report",
        );
      }),
  );

  /**
   * A descriptor that steals its own Edge slot part-way through the run.
   *
   * @param {string} root Repository root for the run.
   * @returns {object} The descriptor.
   */
  const stolenSlotDescriptor = (root) => ({
    name: "stolen",
    workBudgetMs: () => 5_000,
    async cells() {
      stealSlot(path.join(root, SLOT_LOCK_RELATIVE));
      return [{ measured: true }];
    },
  });

  /**
   * The lease adapter with its release-time ownership check made inert — the
   * check can never report that the slot stopped being ours.
   *
   * @returns {Promise<Function>} The mutated `withEdgeSlot`.
   */
  const inertOwnershipSlot = async () => {
    const mutated = await importMutated(SLOT_PATH, [
      [
        "    const stillOurs = held.heldByUs();",
        "    const stillOurs = true || held.heldByUs();",
      ],
    ]);
    return mutated.withEdgeSlot;
  };

  // TWO GUARDS, AND THE FIRST MUTANT FOUND THAT OUT. A stolen slot is caught
  // both by the post-run `assertHeld()` bracket in `probe-lifecycle-run.mjs`
  // AND by the lease adapter's release-time ownership check in
  // `probe-edge-slot.mjs`, so making either one inert alone does NOT let the
  // run report. The three tests below say exactly that: each guard catches it
  // with the other disabled, and disabling both is what lets a run measure on a
  // slot it had already lost.

  await t.test(
    "the release-time ownership check still fails the run when the bracket is inert",
    () =>
      withLaneTmp("adoption-bracket-inert-", async (root) => {
        const mutated = await importMutated(LIFECYCLE_RUN_PATH, [
          [
            "          heldSlot.assertHeld();\n        } catch (error) {",
            "          false && heldSlot.assertHeld();\n        } catch (error) {",
          ],
        ]);
        const { inputs } = lifecycleInputs(root, stolenSlotDescriptor(root));
        await assert.rejects(
          mutated.runDescriptorUnderLifecycle(inputs),
          "with the bracket inert the adapter's release check must still catch the theft",
        );
      }),
  );

  await t.test(
    "the post-run bracket still fails the run when the ownership check is inert",
    () =>
      withLaneTmp("adoption-ownership-inert-", async (root) => {
        const { inputs } = lifecycleInputs(root, stolenSlotDescriptor(root), {
          lifecycleDependencies: { edgeSlot: await inertOwnershipSlot() },
        });
        await assert.rejects(
          runDescriptorUnderLifecycle(inputs),
          "with the ownership check inert the post-run bracket must still catch the theft",
        );
      }),
  );

  await t.test(
    "INERTNESS: with BOTH guards unreachable, the stolen-slot run reports",
    () =>
      withLaneTmp("adoption-both-inert-", async (root) => {
        const mutated = await importMutated(LIFECYCLE_RUN_PATH, [
          [
            "          heldSlot.assertHeld();\n        } catch (error) {",
            "          false && heldSlot.assertHeld();\n        } catch (error) {",
          ],
        ]);
        const { inputs, state } = lifecycleInputs(
          root,
          stolenSlotDescriptor(root),
          { lifecycleDependencies: { edgeSlot: await inertOwnershipSlot() } },
        );
        await mutated.runDescriptorUnderLifecycle(inputs);
        assert.equal(
          inputs.cells.length,
          1,
          "with both guards inert the stolen-slot run must report — otherwise the two live assertions prove nothing",
        );
        assert.ok(state.slot, "the mutant must still have taken a slot");
      }),
  );

  /**
   * Drive a run whose `cells` waits for the orderly deadline to fire and then
   * tries to start more work.
   *
   * @param {string} root Repository root for the run.
   * @param {object} [options] Options.
   * @param {object} [options.lifecycle] Lifecycle implementation override.
   * @returns {Promise<{secondStarted: boolean}>} Whether the post-deadline work ran.
   */
  const runPastTheDeadline = async (root, { lifecycle } = {}) => {
    let announceDeadline;
    const deadlineFired = new Promise((resolve) => {
      announceDeadline = resolve;
    });
    const record = { secondStarted: false };
    const descriptor = {
      name: "post-deadline",
      workBudgetMs: () => 5_000,
      async cells(context) {
        await deadlineFired;
        try {
          await context.scope.run("second", () => {
            record.secondStarted = true;
          });
        } catch {
          // A cancelled unit of work is the expected outcome here, not a
          // failure of the test.
        }
        return [{}];
      },
    };
    const deadlineMs = deriveLifecycleDeadline(
      { runs: 1, timeoutMs: 120_000 },
      descriptor,
    );
    const { inputs } = lifecycleInputs(root, descriptor, {
      ...(lifecycle === undefined ? {} : { lifecycle }),
      lifecycleDependencies: {
        setTimeout(callback, delay) {
          if (delay !== deadlineMs) {
            return setTimeout(callback, delay);
          }
          return setTimeout(() => {
            callback();
            announceDeadline();
          }, 0);
        },
        clearTimeout,
        exit: () => {},
        writeDiagnostic: () => {},
      },
    });
    await runDescriptorUnderLifecycle(inputs).catch(() => undefined);
    return record;
  };

  await t.test(
    "checkpoint refuses to admit work once the lifecycle is draining",
    () =>
      withLaneTmp("adoption-checkpoint-", async (root) => {
        const record = await runPastTheDeadline(root);
        assert.equal(
          record.secondStarted,
          false,
          "work started after the deadline must never run",
        );
      }),
  );

  await t.test(
    "INERTNESS: with checkpoint a no-op, post-deadline work is admitted",
    () =>
      withLaneTmp("adoption-checkpoint-inert-", async (root) => {
        const mutated = await importMutated(LIFECYCLE_PATH, [
          [
            '    if (accepting && phase === "ACTIVE") {\n      return;\n    }\n    throw new ProbeLifecycleError("probe lifecycle is draining");',
            '    if (true || (accepting && phase === "ACTIVE")) {\n      return;\n    }\n    throw new ProbeLifecycleError("probe lifecycle is draining");',
          ],
        ]);
        const record = await runPastTheDeadline(root, {
          lifecycle: mutated.withProbeLifecycle,
        });
        assert.equal(
          record.secondStarted,
          true,
          "the mutant must actually admit the work — otherwise the live assertion proves nothing",
        );
      }),
  );
});

// ---------------------------------------------------------------------------
// F. What the work registry actually guarantees — and what it does not
// ---------------------------------------------------------------------------
//
// WHY THIS GROUP EXISTS. The adversarial verifier (Ciryaher, 2026-09-12)
// REFUTED this lane's documentation, not its code: five documents claimed
// unawaited `scope.run` work is "drained before the browser is closed", and it
// is not — `closeBrowserAfter` starts `browser.close()` in the same tick it
// starts awaiting the registry. Two mutants of exactly that mechanism left the
// suite green, because nothing tested it.
//
// The prose is now corrected. This group is what stops it from drifting back:
// each of the four facts below is asserted as an observable, including the
// LIMITATION, so a future reader who writes "drained before the browser is
// closed" is contradicted by a test rather than by a comment.

test("F. the work registry's real guarantee, and its real limit", async (t) => {
  /**
   * Drive one declaring descriptor whose `cells` starts work it does not await.
   *
   * @param {string} root Repository root for the run.
   * @param {object} options Options.
   * @param {boolean} [options.fail] Whether the unawaited work rejects.
   * @param {Function} [options.runProbeImpl] Runtime under test.
   * @returns {Promise<object>} The observed ordering and outcome.
   */
  const runWithUnawaitedWork = async (
    root,
    { fail = false, runProbeImpl = runProbe } = {},
  ) => {
    const order = [];
    let settled;
    const workSettled = new Promise((resolve) => {
      settled = resolve;
    });
    const browser = () => {
      let connected = true;
      return {
        isConnected: () => connected,
        close: async () => {
          order.push("browser.close");
          connected = false;
        },
      };
    };
    const descriptor = {
      name: fail ? "unawaited-fail" : "unawaited",
      workBudgetMs: () => 30_000,
      async cells(context) {
        context.scope.run("late", async () => {
          await new Promise((resolve) => setTimeout(resolve, 120));
          order.push(
            `late settled; browser open = ${context.browser.isConnected()}`,
          );
          settled();
          if (fail) {
            throw new Error("the readback lost its page");
          }
          return "late";
        });
        order.push("cells returned");
        return [{ ok: true }];
      },
      receipt: (cells) => ({ cells }),
    };
    const exitCode = await runProbeImpl(descriptor, {
      argv: ["--no-serve-built", "--repository-root", root],
      launch: async () => browser(),
    });
    order.push("runProbe returned");
    await workSettled;
    return { exitCode, order, ...artifactsOf(root, descriptor.name) };
  };

  await t.test(
    "THE GUARANTEE: the run does not report complete until unawaited work settles",
    () =>
      withLaneTmp("adoption-drain-", async (root) => {
        const result = await runWithUnawaitedWork(root);
        assert.equal(result.exitCode, PROBE_EXIT_CODES.OK);
        assert.ok(
          result.order.indexOf("runProbe returned") >
            result.order.findIndex((entry) => entry.startsWith("late settled")),
          `the run must outlive its own unawaited work: ${JSON.stringify(result.order)}`,
        );
      }),
  );

  // F1 IS HELD UP BY THREE MECHANISMS, NOT ONE — the same shape as E4/E5/E6,
  // and found the same way (Ciryaher, re-verification). The close-time drain,
  // `waitForFixedPoint` and `waitForOwnedFixedPoint` each independently keep the
  // run alive until its unawaited work settles, so removing any ONE, or any
  // TWO, leaves F1 green. Only the combined mutant below reds it, and it is
  // therefore the honest inertness control for F1.
  await t.test(
    "INERTNESS: F1 needs all THREE waits removed before the run outruns its work",
    () =>
      withLaneTmp("adoption-drain-triple-", async (root) => {
        const inertLifecycle = mutatedSourceUrl(LIFECYCLE_PATH, [
          [
            "  await drainingGate.promise;\n  await cleanupBarrier;\n  await waitForFixedPoint();",
            "  await drainingGate.promise;\n  await cleanupBarrier;\n  if (false) await waitForFixedPoint();",
          ],
          [
            "                } finally {\n                  await waitForOwnedFixedPoint(childTracked);\n                }",
            "                } finally {\n                  if (false) await waitForOwnedFixedPoint(childTracked);\n                }",
          ],
        ]);
        // The runtime does not import the lifecycle directly — it imports the
        // lifecycle BODY, which imports the lifecycle. So the redirect has to
        // be nested one level deeper than the F3 mutant.
        const inertRun = mutatedSourceUrl(LIFECYCLE_RUN_PATH, [
          ["workRegistry.settleAndSeal(),", "Promise.resolve([]),"],
          [
            `from "${moduleBaseUrl(LIFECYCLE_RUN_PATH)}probe-lifecycle.mjs"`,
            `from "${inertLifecycle}"`,
          ],
        ]);
        const mutated = await importMutated(RUNTIME_PATH, [
          [
            `from "${moduleBaseUrl(RUNTIME_PATH)}probe-lifecycle-run.mjs"`,
            `from "${inertRun}"`,
          ],
        ]);
        const result = await runWithUnawaitedWork(root, {
          runProbeImpl: mutated.runProbe,
        });
        assert.ok(
          result.order.indexOf("runProbe returned") <
            result.order.findIndex((entry) => entry.startsWith("late settled")),
          `with all three waits inert the run must outrun its work — otherwise F1 proves nothing: ${JSON.stringify(result.order)}`,
        );
      }),
  );

  await t.test(
    "THE GUARANTEE: a failing unawaited work item costs the run its receipt",
    () =>
      withLaneTmp("adoption-drain-fail-", async (root) => {
        const result = await runWithUnawaitedWork(root, { fail: true });
        assert.equal(result.exitCode, PROBE_EXIT_CODES.ERROR);
        assert.deepEqual(result.files, ["unawaited-fail-error.json"]);
        const record = JSON.parse(
          fs.readFileSync(
            path.join(result.directory, "unawaited-fail-error.json"),
            "utf8",
          ),
        );
        assert.equal(record.outcome, "errored");
        assert.ok(
          record.lifecycleFailures.length > 0,
          "the failure must reach the incident rather than become an unhandled rejection",
        );
      }),
  );

  await t.test(
    "INERTNESS: with the registry drain removed, the failing work is not noticed",
    () =>
      withLaneTmp("adoption-drain-inert-", async (root) => {
        // Two levels: neuter the drain the browser close is handed, then
        // point the runtime's import at the neutered module.
        const inertRun = mutatedSourceUrl(LIFECYCLE_RUN_PATH, [
          ["workRegistry.settleAndSeal(),", "Promise.resolve([]),"],
        ]);
        const mutated = await importMutated(RUNTIME_PATH, [
          [
            `from "${moduleBaseUrl(RUNTIME_PATH)}probe-lifecycle-run.mjs"`,
            `from "${inertRun}"`,
          ],
        ]);
        const result = await runWithUnawaitedWork(root, {
          fail: true,
          runProbeImpl: mutated.runProbe,
        });
        assert.equal(
          result.exitCode,
          PROBE_EXIT_CODES.OK,
          "the mutant must let the failing work go unnoticed — otherwise the guarantee above proves nothing",
        );
        assert.ok(result.files.includes("unawaited-fail-report.json"));
      }),
  );

  await t.test(
    "THE LIMIT: the browser is closed CONCURRENTLY with the drain, not after it",
    () =>
      withLaneTmp("adoption-concurrent-", async (root) => {
        const result = await runWithUnawaitedWork(root);
        // This is the fact five documents used to state backwards. It is
        // asserted here so the correction cannot silently rot back.
        assert.ok(
          result.order.indexOf("browser.close") <
            result.order.findIndex((entry) => entry.startsWith("late settled")),
          `the close is not deferred for the drain: ${JSON.stringify(result.order)}`,
        );
        assert.ok(
          result.order.some(
            (entry) => entry === "late settled; browser open = false",
          ),
          `unawaited work finds the page gone: ${JSON.stringify(result.order)}`,
        );
      }),
  );

  await t.test(
    "THE LIMIT: the hard stop exits without writing any artifact",
    () =>
      withLaneTmp("adoption-hardstop-", async (root) => {
        const descriptor = {
          name: "hard-stop",
          workBudgetMs: () => 5_000,
          cells: async () => [{ ok: true }],
          receipt: (cells) => ({ cells }),
        };
        const deadlineMs = deriveLifecycleDeadline(
          { runs: 1, timeoutMs: 120_000 },
          descriptor,
        );
        const exits = [];
        const diagnostics = [];
        const outcome = await Promise.race([
          runProbe(descriptor, {
            argv: ["--no-serve-built", "--repository-root", root],
            // A close that never settles is enough to reach the hard stop.
            launch: async () => ({
              isConnected: () => true,
              close: () => new Promise(() => {}),
            }),
            lifecycleDependencies: {
              setTimeout(callback, delay) {
                if (delay === deadlineMs) return setTimeout(callback, 0);
                if (delay === HARD_STOP_GRACE_MS)
                  return setTimeout(callback, 200);
                return setTimeout(callback, delay);
              },
              clearTimeout,
              exit: (code) => exits.push(code),
              writeDiagnostic: (text) => diagnostics.push(text.trim()),
            },
          }).then(() => "returned"),
          new Promise((resolve) =>
            setTimeout(() => resolve("never-returned"), 5_000),
          ),
        ]);
        assert.equal(
          outcome,
          "never-returned",
          "the hard stop exits from inside the lifecycle; runProbe never returns",
        );
        assert.deepEqual(exits, [PROBE_EXIT_CODES.ERROR]);
        assert.deepEqual(diagnostics, [
          "hard-stop: lifecycle did not reach quiescence before hard-stop grace",
        ]);
        assert.deepEqual(
          artifactsOf(root, "hard-stop").files,
          [],
          "no artifact of any kind is written on this path — the stderr line is the whole record",
        );
      }),
  );

  await t.test(
    "INERTNESS: with the hard-stop grace never armed, the wedged teardown never ends",
    () =>
      withLaneTmp("adoption-hardstop-inert-", async (root) => {
        const mutated = await importMutated(LIFECYCLE_PATH, [
          [
            "    hardArmed = true;\n    hardTimer = dependencies.setTimeout(hardExit, hardStopGraceMs);",
            "    hardArmed = true;\n    hardTimer = false && dependencies.setTimeout(hardExit, hardStopGraceMs);",
          ],
        ]);
        const descriptor = {
          name: "hard-stop-inert",
          workBudgetMs: () => 5_000,
          cells: async () => [{ ok: true }],
          receipt: (cells) => ({ cells }),
        };
        const deadlineMs = deriveLifecycleDeadline(
          { runs: 1, timeoutMs: 120_000 },
          descriptor,
        );
        const exits = [];
        await Promise.race([
          runProbe(descriptor, {
            argv: ["--no-serve-built", "--repository-root", root],
            launch: async () => ({
              isConnected: () => true,
              close: () => new Promise(() => {}),
            }),
            lifecycle: mutated.withProbeLifecycle,
            lifecycleDependencies: {
              setTimeout(callback, delay) {
                if (delay === deadlineMs) return setTimeout(callback, 0);
                if (delay === HARD_STOP_GRACE_MS)
                  return setTimeout(callback, 200);
                return setTimeout(callback, delay);
              },
              clearTimeout,
              exit: (code) => exits.push(code),
              writeDiagnostic: () => {},
            },
          }),
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
        assert.deepEqual(
          exits,
          [],
          "the mutant must never reach the hard exit — otherwise the assertion above proves nothing",
        );
      }),
  );
});

// ---------------------------------------------------------------------------
// G. A dropped registration is reported, not published over
// ---------------------------------------------------------------------------
//
// WHAT THIS GROUP PINS. A malformed third argument to `scope.run` — a
// non-function `abort`, or a `null` where the options object belongs — rejects
// inside `slotScope.run` before the work is ever entered. The registry records
// that rejection on a record that settles `not-started`, and the close-time
// drain must COLLECT it: the run costs itself its receipt rather than
// publishing a clean measurement over work that never ran.
//
// WHAT IT WAS UNTIL 2026-09-12, KEPT BECAUSE THE DIAGNOSIS IS THE CONTRACT.
// `closeBrowserAfter` collected `workOutcomes.filter(o => o.status ===
// "rejected")`, which cannot see a `not-started` record EVEN WHEN IT CARRIES A
// FAILURE REASON, so both triggers exited 0 with a full receipt over work that
// never ran. Found by adversarial verification (Ciryaher, 2026-09-12, fifth
// round), filed as `C13-42a-3` item 8, and pinned here as a CHARACTERIZATION —
// the group asserted the defect, so a green suite could not hide it — under a
// header requiring whoever fixed the item to INVERT the group. Item 8 was
// closed the same day (`carriedFailure` in `probe-work-registry.mjs`: collect
// on "carries a failure", not on status) and the group was inverted, as that
// header promised. The history stays because the next reader of the drain
// needs to know which predicate it is not allowed to drift back to.
//
// THE TWO TRIGGERS STAY SEPARATE SUB-TESTS. They reach the same terminal state
// by different lines — the `abort` guard, and the property access one line
// above it that a `null` dies on — so a fix that closed only one of them would
// pass a merged test.

test("G. a dropped registration is reported", async (t) => {
  /**
   * Run one declaring descriptor whose `cells` makes a single `scope.run` call.
   *
   * @param {string} root Repository root for the run.
   * @param {string} name Probe name.
   * @param {Function} call Receives the scope; makes the call under test.
   * @param {object} [options] Options.
   * @param {Function} [options.runProbeImpl] Runtime under test.
   * @returns {Promise<object>} Exit code, artifacts, and whether the label appears in any of them.
   */
  const runOneCall = async (
    root,
    name,
    call,
    { runProbeImpl = runProbe } = {},
  ) => {
    const exitCode = await runProbeImpl(
      {
        name,
        workBudgetMs: () => 30_000,
        async cells(context) {
          await Promise.resolve(call(context.scope)).catch(() => undefined);
          return [{ ok: true }];
        },
        receipt: (cells) => ({ cells }),
      },
      {
        argv: ["--no-serve-built", "--repository-root", root],
        launch: async () => fakeBrowser(),
      },
    );
    const { directory, files } = artifactsOf(root, name);
    const named = files.some((file) =>
      fs.readFileSync(path.join(directory, file), "utf8").includes("readback"),
    );
    return { exitCode, files, named };
  };

  await t.test("CONTROL: work that rejects costs the run its receipt", () =>
    withLaneTmp("adoption-g-control-", async (root) => {
      const result = await runOneCall(root, "g-control", (scope) =>
        scope.run("readback", async () => {
          throw new Error("readback failed");
        }),
      );
      assert.equal(result.exitCode, PROBE_EXIT_CODES.ERROR);
      assert.deepEqual(result.files, ["g-control-error.json"]);
    }),
  );

  await t.test(
    "CONTROL: a non-function `start` is reported — it fails INSIDE the work",
    () =>
      withLaneTmp("adoption-g-start-", async (root) => {
        const result = await runOneCall(root, "g-start", (scope) =>
          scope.run("readback", "not-a-function"),
        );
        assert.equal(result.exitCode, PROBE_EXIT_CODES.ERROR);
        assert.deepEqual(result.files, ["g-start-error.json"]);
      }),
  );

  await t.test(
    "THE CONTRACT: a non-function `abort` costs the run its receipt",
    () =>
      withLaneTmp("adoption-g-abort-", async (root) => {
        const result = await runOneCall(root, "g-abort", (scope) =>
          scope.run("readback", async () => "value", {
            abort: "not-a-function",
          }),
        );
        assert.equal(result.exitCode, PROBE_EXIT_CODES.ERROR);
        assert.deepEqual(result.files, ["g-abort-error.json"]);
        // Measured, not assumed. The label reaches the incident on THIS
        // trigger only because the guard's own TypeError message opens with it
        // ("readback abort must be a function"). What the incident records is
        // the raw error, not the `<label> wrapper` the drain collected — see
        // the `null` trigger below, where the same assertion is false.
        assert.equal(
          result.named,
          true,
          "the dropped work must be identifiable in the incident",
        );
      }),
  );

  await t.test(
    "THE CONTRACT, second trigger: a `null` third argument is reported too",
    () =>
      withLaneTmp("adoption-g-null-", async (root) => {
        // `operationOptions = {}` defaults only for `undefined`, so `null`
        // throws at the property access BEFORE the guard the first trigger
        // hits. Same terminal state, different line — which is why item 8 is
        // titled "third argument", why hardening only the `abort` guard would
        // have closed one of the two, and why the fix went into the DRAIN,
        // where both converge, rather than into either guard.
        const result = await runOneCall(root, "g-null", (scope) =>
          scope.run("readback", async () => "value", null),
        );
        assert.equal(result.exitCode, PROBE_EXIT_CODES.ERROR);
        assert.deepEqual(result.files, ["g-null-error.json"]);
        // A RESIDUAL, MEASURED AND ASSERTED RATHER THAN GLOSSED: the run is
        // reported, but the dropped work is named NOWHERE in it. The incident
        // carries the raw error, which on this trigger is Cannot read
        // properties of null (reading abort) — thrown by the property access,
        // carrying no label. The failure the drain collected does carry
        // `readback wrapper`, but nothing projects that label into an artifact
        // here. Closing that is a change to what the incident record projects,
        // not to the drain, so it is asserted as it is rather than wished
        // otherwise.
        assert.equal(
          result.named,
          false,
          "measured residual: on this trigger the label reaches no artifact",
        );
      }),
  );

  await t.test(
    "the MECHANISM, not just the symptom: the drain collects on the failure, not on the status",
    async () => {
      // A symptom-only assertion would survive a mechanism change that kept
      // the exit code, and a spec that re-implements the predicate inline
      // proves nothing about the one that shipped. So this drives the SHIPPED
      // `closeBrowserAfter` over a registry built by hand, with a fulfilled
      // attempt and a browser that closes cleanly, leaving what the drain
      // collects as the only thing under test.
      const drain = async (reason) => {
        const registry = makeWorkRegistry();
        const record = registry.enroll("readback");
        record.attachWrapper();
        assert.equal(record.finishNotStarted(reason), true);
        assert.equal(
          record.terminal.status,
          "not-started",
          "the terminal state the old status filter could not see",
        );
        try {
          await closeBrowserAfter(
            Promise.resolve(Object.freeze({ status: "fulfilled" })),
            registry.settleAndSeal(),
            fakeBrowser(),
          );
          return "collected nothing";
        } catch (error) {
          return `surfaced: ${error.message}`;
        }
      };

      assert.equal(
        await drain({
          occurred: true,
          occurrence: 1,
          label: "readback wrapper",
          raw: new TypeError("readback abort must be a function"),
        }),
        "surfaced: readback abort must be a function",
        "a not-started record CARRYING a failure must reach the drain",
      );
      // The other half of the predicate, and the reason it is not simply
      // "status !== fulfilled": `probe-lifecycle-run.mjs` settles the ordinary
      // not-started records with a plain STRING reason, on every healthy run.
      // Were those collected too, every green run in this file would fail.
      assert.equal(
        await drain("resource use was not started"),
        "collected nothing",
        "an ordinary not-started record must stay silent",
      );
    },
  );

  await t.test(
    "BOTH HALVES: the attempt outcome reads the same predicate as the work outcomes",
    async () => {
      // Review finding F5. `closeBrowserAfter` has two collectors, and until
      // this sub-test existed only one of them had been moved off the status
      // test item 8 removed. The attempt is registered through the same
      // `registerObservedRun`, so its pre-start-cancellation path settles it
      // `not-started` carrying a real `sourceFailure` too.
      //
      // WHAT IS OBSERVABLE, and it is not 'one more failure is reported'. The
      // attempt's failure is the run's PRIMARY — `probe-lifecycle-run.mjs`
      // rethrows it as `runFailure` — so the drain's job is to recognise it
      // and NOT re-throw it as a secondary. A primary the filter cannot see is
      // a primary reported twice, which is the one thing this module's header
      // says the two-promises-per-attempt design exists to prevent.
      const drainWithAttempt = async (
        attemptOutcome,
        workReason,
        drainImpl,
      ) => {
        const registry = makeWorkRegistry();
        const record = registry.enroll("readback");
        record.attachWrapper();
        record.finishNotStarted(workReason);
        try {
          await drainImpl(
            Promise.resolve(attemptOutcome),
            registry.settleAndSeal(),
            fakeBrowser(),
          );
          return "collected nothing";
        } catch (error) {
          return `surfaced: ${error.message}`;
        }
      };
      // ONE occurrence, reaching the drain through BOTH halves — the shape the
      // propagated-failure path produces.
      const shared = Object.freeze({
        occurred: true,
        occurrence: 1,
        label: "attempt wrapper",
        raw: new TypeError("abort must be a function"),
      });
      const notStartedAttempt = Object.freeze({
        status: "not-started",
        reason: shared,
      });

      assert.equal(
        await drainWithAttempt(notStartedAttempt, shared, closeBrowserAfter),
        "collected nothing",
        "a not-started attempt carrying a failure IS the primary, and a primary is not re-thrown as a secondary",
      );
      // The healthy shape stays untouched: an ordinary not-started attempt
      // carries a plain string, is no primary, and must not swallow real work
      // failures behind it.
      assert.equal(
        await drainWithAttempt(
          Object.freeze({
            status: "not-started",
            reason: "resource use was not started",
          }),
          Object.freeze({
            occurred: true,
            occurrence: 2,
            label: "readback wrapper",
            raw: new Error("readback failed"),
          }),
          closeBrowserAfter,
        ),
        "surfaced: readback failed",
        "an ordinary not-started attempt must not be mistaken for a primary",
      );

      // INERTNESS: put the attempt half back on the status test. One level —
      // this sub-test calls `closeBrowserAfter` directly.
      const mutated = await importMutated(WORK_REGISTRY_PATH, [
        [
          "const attemptFailure = carriedFailure(attemptOutcome);",
          'const attemptFailure = attemptOutcome.status === "rejected" ? attemptOutcome.failure : undefined;',
        ],
      ]);
      assert.equal(
        await drainWithAttempt(
          notStartedAttempt,
          shared,
          mutated.closeBrowserAfter,
        ),
        "surfaced: abort must be a function",
        "the status-only mutant must re-throw the primary — otherwise the assertion above proves nothing",
      );
    },
  );

  await t.test(
    "INERTNESS: with the drain's failure collection unreachable, the run reports success again",
    () =>
      withLaneTmp("adoption-g-inert-", async (root) => {
        // Three levels, for the same reason the F1 mutant needs two: the
        // runtime imports the lifecycle body, which imports the registry. The
        // mutation leaves the shipped predicate's text in place and makes its
        // `not-started` half unreachable, which is precisely the pre-fix
        // behaviour — so if this went green, the sub-tests above would be
        // passing for some other reason than the fix.
        const inertRegistry = mutatedSourceUrl(WORK_REGISTRY_PATH, [
          [
            'outcome.status === "rejected" ? outcome.failure : outcome.reason;',
            'outcome.status === "rejected" ? outcome.failure : false && outcome.reason;',
          ],
        ]);
        const inertRun = mutatedSourceUrl(LIFECYCLE_RUN_PATH, [
          [
            `from "${moduleBaseUrl(LIFECYCLE_RUN_PATH)}probe-work-registry.mjs"`,
            `from "${inertRegistry}"`,
          ],
        ]);
        const mutated = await importMutated(RUNTIME_PATH, [
          [
            `from "${moduleBaseUrl(RUNTIME_PATH)}probe-lifecycle-run.mjs"`,
            `from "${inertRun}"`,
          ],
        ]);
        const result = await runOneCall(
          root,
          "g-inert",
          (scope) =>
            scope.run("readback", async () => "value", {
              abort: "not-a-function",
            }),
          { runProbeImpl: mutated.runProbe },
        );
        assert.equal(
          result.exitCode,
          PROBE_EXIT_CODES.OK,
          "the mutant must let the dropped work go unnoticed — otherwise the contract above proves nothing",
        );
        assert.deepEqual(result.files, [
          "g-inert-report.json",
          "g-inert-runtime.json",
          "g-inert-summary.md",
        ]);
      }),
  );

  await t.test(
    "the registration and the work now converge on the same outcome",
    () =>
      withLaneTmp("adoption-g-converge-", async (root) => {
        const start = await runOneCall(root, "g-converge-start", (scope) =>
          scope.run("readback", "not-a-function"),
        );
        const abort = await runOneCall(root, "g-converge-abort", (scope) =>
          scope.run("readback", async () => "value", {
            abort: "not-a-function",
          }),
        );
        // Two caller errors of the same class that used to have OPPOSITE
        // outcomes, and that contrast was the diagnosis: a bad `start` fails
        // inside the work, where `record.reject` sets status `rejected`; a bad
        // `abort` fails in the registration, settles `not-started`, and the
        // old status filter could not see it. Agreement is the correct outcome
        // now precisely because the drain no longer asks which of the two
        // terminal states a record reached — only whether it carries a
        // failure. If these ever diverge again, the drain has regressed to a
        // status test.
        assert.equal(
          start.exitCode,
          abort.exitCode,
          "the drain must not care which terminal state carried the failure",
        );
        assert.equal(start.exitCode, PROBE_EXIT_CODES.ERROR);
        assert.equal(abort.exitCode, PROBE_EXIT_CODES.ERROR);
      }),
  );
});

// ---------------------------------------------------------------------------
// H. The descriptor scope's `checkpoint` is the lifecycle's, not a look-alike
// ---------------------------------------------------------------------------
//
// `makeDescriptorScope` forwards `checkpoint` to the probe, and that member is
// how a probe abandons its own work the moment the run is no longer wanted. A
// forwarding replaced by a no-op would satisfy every shape check — the member
// exists, it is a function, it returns undefined while the run is healthy — and
// would silently let a cancelled run keep working. An identity assertion would
// not help: it pins which object a property points at, which is not the thing
// that has to be true. So the forwarding is pinned through the BEHAVIOUR it
// must produce, from inside `cells`: the same call returns while the lifecycle
// is ACTIVE and throws once the orderly deadline has moved it to draining.

test("H. the descriptor scope forwards the live checkpoint", async (t) => {
  /**
   * Call `scope.checkpoint` from inside `cells` twice — once while the run is
   * healthy, once after the orderly deadline has fired — and report what each
   * call did.
   *
   * @param {string} root Repository root for the run.
   * @param {object} [options] Options.
   * @param {Function} [options.runProbeImpl] Runtime under test.
   * @returns {Promise<string[]>} The two observations, in order.
   */
  const observeCheckpoint = async (root, { runProbeImpl = runProbe } = {}) => {
    let release;
    const observations = [];
    const observe = (scope) => {
      try {
        scope.checkpoint();
        return "returned";
      } catch (error) {
        return `threw: ${error.message}`;
      }
    };
    const descriptor = {
      name: "checkpoint-forwarding",
      workBudgetMs: () => 5_000,
      async cells(context) {
        observations.push(observe(context.scope));
        // Work only the orderly stop can end. Awaiting it is what puts the
        // second observation after cancellation without the test having to
        // time anything: the stop aborts the operation, the await settles, and
        // only then is `checkpoint` called again.
        await context.scope
          .run("work", () => new Promise((resolve) => (release = resolve)), {
            abort: () => release?.(undefined),
          })
          .then(
            () => undefined,
            () => undefined,
          );
        observations.push(observe(context.scope));
        return [{ ok: true }];
      },
      receipt: (cells) => ({ cells }),
    };
    const deadlineMs = deriveLifecycleDeadline(
      { runs: 1, timeoutMs: 120_000 },
      descriptor,
    );
    await runProbeImpl(descriptor, {
      argv: ["--no-serve-built", "--repository-root", root],
      launch: async () => fakeBrowser(),
      lifecycleDependencies: {
        // Only the orderly timer is shortened, as in group B.
        setTimeout(callback, delay) {
          return setTimeout(callback, delay === deadlineMs ? 0 : delay);
        },
        clearTimeout,
        exit: () => {},
        writeDiagnostic: () => {},
      },
    });
    return observations;
  };

  await t.test(
    "THE CONTRACT: the forwarded checkpoint returns while ACTIVE and throws once the run is cancelled",
    () =>
      withLaneTmp("adoption-h-checkpoint-", async (root) => {
        assert.deepEqual(await observeCheckpoint(root), [
          "returned",
          "threw: probe lifecycle is draining",
        ]);
      }),
  );

  await t.test(
    "INERTNESS: with the forwarding replaced by a no-op, the cancelled run never notices",
    () =>
      withLaneTmp("adoption-h-checkpoint-inert-", async (root) => {
        const inertRegistry = mutatedSourceUrl(WORK_REGISTRY_PATH, [
          ["checkpoint: slotScope.checkpoint,", "checkpoint: () => {},"],
        ]);
        const inertRun = mutatedSourceUrl(LIFECYCLE_RUN_PATH, [
          [
            `from "${moduleBaseUrl(LIFECYCLE_RUN_PATH)}probe-work-registry.mjs"`,
            `from "${inertRegistry}"`,
          ],
        ]);
        const mutated = await importMutated(RUNTIME_PATH, [
          [
            `from "${moduleBaseUrl(RUNTIME_PATH)}probe-lifecycle-run.mjs"`,
            `from "${inertRun}"`,
          ],
        ]);
        assert.deepEqual(
          await observeCheckpoint(root, { runProbeImpl: mutated.runProbe }),
          ["returned", "returned"],
          "the no-op mutant must swallow the cancellation — otherwise the contract above proves nothing",
        );
      }),
  );
});
