// edge-job-runner.spec.mjs — the Edge-job runner, driven with a stub spawner.
// Pure Node: no probe, browser or server is launched. The only children are
// `node` itself: the real spawner's env case (`node -e`) and the runner run
// through a directory link with a bad flag. The plan's probes are fakes served
// through the runner's own readText/exists seams where a spec needs a source it
// controls, and real probe files where the runner is driven end to end through
// `main`. Every write lands under a lane temp root.
// @purpose Pins KIT-5A (e): the runner runs entries strictly in plan order and one at a time, always passes --output <jobDir>/<family>/<id> and each entry's env (the real spawner merging it over the shell's), stops after an infrastructure refusal (and an unidentified refusal, a spawn failure or a timeout) without ever retrying, continues past a subject refusal, a verdict failure and an error but exits 4 (one stdout line and an elapsed.json record naming them) when a finished entry exited outside its plan expectedExit (a subject refusal under the shipped plan's 0-or-1 expectations included; 0 when a planned verdict failure, 1 when the job stopped), writes INDEX.md and elapsed.json from the receipts (also when it stops early, and with the refusal id read off stderr when the child wrote no refusal file), launches nothing in --dry-run, refuses a bad plan and a selection that resolves no entry (exit 2) before anything is spawned or made, reaches main when run through a directory link, and notes a Moria F3 waitForFunction shape in the entry's instrument note.
// @status ACTIVE
//
// The assertions are groups over a module namespace. The live tests run each
// group over the real runner; the mutant tests run the same group over a copy
// with the clause under test made unreachable and require it to fail.
//
// Run: node --test Tools/visual-regression/edge-job-runner.spec.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import * as realRunner from "./edge-job-runner.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { acquireEdgeSlot } from "./lib/probe-edge-slot.mjs";
import {
  decideOriginRefusal,
  decidePortRefusal,
  decideServedBuildRefusal,
  throwIfProbeBaseRefused,
} from "./lib/probe-runtime-decisions.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.join(HERE, "edge-job-runner.mjs");
const HERE_ANCHOR =
  "const HERE = path.dirname(fileURLToPath(import.meta.url));";

/** Load the runner, with the module-location constant made absolute. */
function loadRunner(replacements = []) {
  return importMutated(RUNNER_PATH, [
    [HERE_ANCHOR, `const HERE = ${JSON.stringify(HERE)};`],
    ...replacements,
  ]);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_SOURCE = "// @runtime lib/probe-runtime.mjs\nexport const x = 1;\n";

/**
 * readText/exists seams serving fake probe sources by basename, and the
 * repository root the job directory must lie in: the test's lane temp root
 * stands in for the checkout, since every job directory here lives under it.
 */
function seamsFor(sources, repositoryRoot) {
  return {
    ...(repositoryRoot ? { repositoryRoot } : {}),
    readText: (file) => {
      const base = path.basename(file);
      return Object.hasOwn(sources, base)
        ? sources[base]
        : fs.readFileSync(file, "utf8");
    },
    exists: (file) =>
      Object.hasOwn(sources, path.basename(file)) || fs.existsSync(file),
  };
}

const entry = (family, id, over = {}) => ({
  family,
  id,
  probe: "probe-fake-a.mjs",
  args: [],
  env: {},
  expectedExit: [0, 1, 2, 3],
  rigs: [],
  instrumentNote: "",
  ...over,
});

/** Four entries over two families, in a known order, one carrying env/--runs. */
function fourEntryPlan() {
  return {
    schema: 1,
    entries: [
      entry("alpha", "one", {
        args: ["--port", "8094"],
        instrumentNote: "instrument changed vs the baseline",
      }),
      entry("alpha", "two", {
        probe: "probe-fake-b.mjs",
        args: ["--runs", "3"],
      }),
      entry("beta", "three", {
        probe: "probe-fake-c.mjs",
        env: { PROBE_BASE: "http://localhost:8094" },
      }),
      entry("beta", "four"),
    ],
  };
}

const FAKE_SOURCES = {
  "probe-fake-a.mjs": FAKE_SOURCE,
  "probe-fake-b.mjs": FAKE_SOURCE,
  "probe-fake-c.mjs": FAKE_SOURCE,
};

const ORDER = ["alpha/one", "alpha/two", "beta/three", "beta/four"];

/**
 * A stub spawner. `script["family/id"]` gives an entry's behaviour:
 * `{exitCode, stderr, timedOut, spawnError, throws, files}`; `files` are
 * written into the entry's --output directory before the child "exits".
 */
function makeSpawner(script = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const spawnEntry = async (command) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      const outputDirectory =
        command.argv[command.argv.indexOf("--output") + 1];
      const key = `${path.basename(path.dirname(outputDirectory))}/${path.basename(outputDirectory)}`;
      calls.push({
        key,
        argv: command.argv,
        env: command.env,
        cwd: command.cwd,
        outputDirectory,
      });
      const behaviour = script[key] ?? {};
      for (const [name, content] of Object.entries(behaviour.files ?? {})) {
        fs.mkdirSync(path.dirname(path.join(outputDirectory, name)), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(outputDirectory, name),
          typeof content === "string" ? content : JSON.stringify(content),
        );
      }
      if (behaviour.throws) {
        throw new Error(behaviour.throws);
      }
      return {
        exitCode: behaviour.exitCode === undefined ? 0 : behaviour.exitCode,
        timedOut: behaviour.timedOut ?? false,
        spawnError: behaviour.spawnError ?? null,
        stdout: "",
        stderr: behaviour.stderr ?? "",
      };
    } finally {
      inFlight -= 1;
    }
  };
  return {
    spawnEntry,
    calls,
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

const sink = () => {
  const lines = [];
  return { write: (text) => lines.push(String(text)), lines };
};

/** A clock advancing `step` ms per reading. */
const steppingClock = (step = 500) => {
  let t = Date.UTC(2026, 9, 9, 3, 0, 0);
  return () => (t += step);
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const md5 = (text) => createHash("md5").update(text).digest("hex");

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/** Plan resolution: order, argv, env, families, and the refusals. */
async function planGroup(api) {
  await withLaneTmp("edge-job-plan-", async (root) => {
    const jobDir = path.join(root, "job");
    const seams = seamsFor(FAKE_SOURCES, root);
    const resolved = api.resolvePlan(fourEntryPlan(), { jobDir, ...seams });
    assert.deepEqual(
      resolved.map((e) => `${e.family}/${e.id}`),
      ORDER,
      "plan order is kept",
    );
    for (const e of resolved) {
      assert.deepEqual(
        e.argv.slice(-2),
        ["--output", path.resolve(jobDir, e.family, e.id)],
        `${e.id}: argv ends with --output <jobDir>/<family>/<id>`,
      );
      assert.equal(e.outputDirectory, path.resolve(jobDir, e.family, e.id));
    }
    assert.deepEqual(resolved[2].env, { PROBE_BASE: "http://localhost:8094" });
    assert.deepEqual(resolved[0].env, {});
    assert.deepEqual(resolved[0].args, ["--port", "8094"]);

    // A positive family list runs only those families, still in plan order.
    const onlyBeta = api.resolvePlan(fourEntryPlan(), {
      jobDir,
      families: ["beta"],
      ...seams,
    });
    assert.deepEqual(
      onlyBeta.map((e) => `${e.family}/${e.id}`),
      ["beta/three", "beta/four"],
    );
    assert.throws(
      () =>
        api.resolvePlan(fourEntryPlan(), {
          jobDir,
          families: ["gamma"],
          ...seams,
        }),
      (error) =>
        error instanceof api.EdgeJobPlanError && /gamma/.test(error.message),
    );

    // Every plan the runner will not run is refused whole, naming the problem.
    const refuse = (label, mutate, pattern, extraSeams = seams) => {
      const plan = fourEntryPlan();
      mutate(plan);
      assert.throws(
        () => api.resolvePlan(plan, { jobDir, ...extraSeams }),
        (error) => {
          assert.ok(
            error instanceof api.EdgeJobPlanError,
            `${label}: an EdgeJobPlanError`,
          );
          assert.match(error.message, pattern, label);
          return true;
        },
        label,
      );
    };
    refuse(
      "args carrying --output",
      (p) => (p.entries[0].args = ["--output", "somewhere"]),
      /--output/,
    );
    refuse(
      "args pointing at port 8080",
      (p) => (p.entries[0].args = ["--port", "8080"]),
      /8080/,
    );
    refuse(
      "env pointing at port 8080",
      (p) => (p.entries[2].env = { PROBE_BASE: "http://localhost:8080" }),
      /8080/,
    );
    refuse(
      "a duplicate family/id",
      (p) => (p.entries[1].id = "one"),
      /duplicate/,
    );
    refuse(
      "an unknown probe file",
      (p) => (p.entries[0].probe = "probe-missing-xyz.mjs"),
      /does not exist/,
    );
    refuse(
      "a probe that cannot take --output",
      () => {},
      /cannot take --output/,
      seamsFor(
        {
          ...FAKE_SOURCES,
          "probe-fake-a.mjs": "console.log('no flags here');\n",
        },
        root,
      ),
    );
    refuse(
      "an invalid expectedExit",
      (p) => (p.entries[0].expectedExit = [7]),
      /expectedExit/,
    );
    refuse(
      "a non-object env",
      (p) => (p.entries[0].env = "PROBE_BASE=x"),
      /env/,
    );
    assert.throws(
      () => api.resolvePlan({ schema: 2, entries: [] }, { jobDir, ...seams }),
      api.EdgeJobPlanError,
    );

    // A job never writes over an earlier job's receipts.
    fs.mkdirSync(path.join(jobDir, "alpha", "one"), { recursive: true });
    assert.throws(
      () => api.resolvePlan(fourEntryPlan(), { jobDir, ...seams }),
      (error) =>
        error instanceof api.EdgeJobPlanError &&
        /already exists/.test(error.message),
    );

    // All problems are listed, not just the first.
    const plan = fourEntryPlan();
    plan.entries[1].args = ["--output", "x"];
    plan.entries[2].args = ["--port", "8080"];
    assert.throws(
      () =>
        api.resolvePlan(plan, {
          jobDir: path.join(root, "fresh-job"),
          ...seams,
        }),
      (error) => error.problems.length >= 2,
    );
  });
}

/** Strictly in order, one at a time, --output and env on every spawn, no repeats. */
async function orderGroup(api) {
  await withLaneTmp("edge-job-order-", async (root) => {
    const jobDir = path.join(root, "job");
    const entries = api.resolvePlan(fourEntryPlan(), {
      jobDir,
      ...seamsFor(FAKE_SOURCES, root),
    });
    const spawner = makeSpawner();
    const result = await api.runJob(entries, {
      jobDir,
      spawnEntry: spawner.spawnEntry,
      now: steppingClock(),
      log: sink(),
    });
    assert.deepEqual(
      spawner.calls.map((c) => c.key),
      ORDER,
      "spawned in plan order, each once",
    );
    assert.equal(spawner.maxInFlight, 1, "one child at a time");
    assert.equal(result.stopped, false);
    const expectedEnv = {
      "alpha/one": {},
      "alpha/two": {},
      "beta/three": { PROBE_BASE: "http://localhost:8094" },
      "beta/four": {},
    };
    for (const call of spawner.calls) {
      const [family, id] = call.key.split("/");
      assert.deepEqual(
        call.argv.slice(-2),
        ["--output", path.resolve(jobDir, family, id)],
        `${call.key}: --output under the job directory`,
      );
      assert.equal(
        call.argv[0],
        process.execPath,
        `${call.key}: node runs the probe`,
      );
      assert.match(
        call.argv[1],
        /^Tools\/visual-regression\/probe-fake-[abc]\.mjs$/,
      );
      assert.deepEqual(
        call.env,
        expectedEnv[call.key],
        `${call.key}: the entry's env is passed`,
      );
    }
    assert.deepEqual(
      spawner.calls[0].argv.slice(2, 4),
      ["--port", "8094"],
      "the entry's args precede --output",
    );
    assert.deepEqual(spawner.calls[1].argv.slice(2, 4), ["--runs", "3"]);
  });
}

const INFRASTRUCTURE_CASES = [
  [
    "a served-build refusal file",
    {
      exitCode: 3,
      files: {
        "fake-refusal.json": {
          refusal: { reason: "served-build-preflight-failed" },
        },
      },
    },
  ],
  [
    "an incomplete served-build refusal file",
    {
      exitCode: 3,
      files: {
        "fake-refusal.json": {
          refusal: { reason: "served-build-preflight-incomplete" },
        },
      },
    },
  ],
  [
    "an origin refusal file",
    {
      exitCode: 3,
      files: {
        "fake-refusal.json": { refusal: { reason: "origin-mismatch" } },
      },
    },
  ],
  [
    "an Edge-slot refusal file",
    {
      exitCode: 3,
      files: { "fake-refusal.json": { refusal: { reason: "edge-slot-busy" } } },
    },
  ],
  [
    "a port-8080 refusal file",
    {
      exitCode: 3,
      files: {
        "fake-refusal.json": { refusal: { reason: "port-8080-forbidden" } },
      },
    },
  ],
  [
    "a probe-base-unset refusal file",
    {
      exitCode: 3,
      files: {
        "fake-refusal.json": { refusal: { reason: "probe-base-unset" } },
      },
    },
  ],
  [
    "a REFUSED line on stderr and no file",
    {
      exitCode: 3,
      stderr: "fake: REFUSED (origin-mismatch) - the page is not the origin\n",
    },
  ],
  ["an exit-3 refusal with no identifiable reason", { exitCode: 3 }],
  [
    "a spawn failure",
    { exitCode: null, spawnError: { message: "spawn ENOENT" } },
  ],
  ["a timeout", { exitCode: null, timedOut: true }],
  ["a spawner that throws", { throws: "the spawner fell over" }],
];

/** The job stops after an infrastructure-class end, and nothing after it runs. */
async function stopGroup(api) {
  for (const [label, behaviour] of INFRASTRUCTURE_CASES) {
    await withLaneTmp("edge-job-stop-", async (root) => {
      const jobDir = path.join(root, "job");
      const entries = api.resolvePlan(fourEntryPlan(), {
        jobDir,
        ...seamsFor(FAKE_SOURCES, root),
      });
      const spawner = makeSpawner({ "alpha/two": behaviour });
      const result = await api.runJob(entries, {
        jobDir,
        spawnEntry: spawner.spawnEntry,
        now: steppingClock(),
        log: sink(),
      });
      assert.deepEqual(
        spawner.calls.map((c) => c.key),
        ["alpha/one", "alpha/two"],
        `${label}: nothing after the stopping entry was spawned, and nothing twice`,
      );
      assert.equal(result.stopped, true, label);
      assert.equal(result.stoppedAt, "alpha/two", label);

      // The record of a stopped job is still on disk.
      const index = fs.readFileSync(
        path.join(jobDir, "alpha", "INDEX.md"),
        "utf8",
      );
      assert.match(
        index,
        /probe-fake-a\.mjs/,
        `${label}: INDEX lists the entry before`,
      );
      assert.match(
        index,
        /two \(probe-fake-b\.mjs\)/,
        `${label}: INDEX lists the stopping entry`,
      );
      assert.equal(
        fs.existsSync(path.join(jobDir, "beta", "INDEX.md")),
        false,
        `${label}: no index for a family never reached`,
      );
      const elapsed = readJson(path.join(jobDir, "elapsed.json"));
      assert.equal(elapsed.stoppedAt, "alpha/two", label);
      assert.deepEqual(
        elapsed.entries.map((e) => `${e.family}/${e.id}`),
        ["alpha/one", "alpha/two"],
        label,
      );
    });
  }
}

/** Subject refusals, verdict failures and errors are recorded and the job goes on. */
async function continueGroup(api) {
  const cases = [
    [
      "a subject refusal",
      {
        exitCode: 3,
        files: {
          "fake-refusal.json": {
            refusal: { reason: "capture-selector-ambiguous" },
          },
        },
      },
      "subject-refusal",
    ],
    ["a verdict failure", { exitCode: 1 }, "verdict-fail"],
    [
      "an error",
      { exitCode: 2, files: { "fake-error.json": { outcome: "errored" } } },
      "errored",
    ],
  ];
  for (const [label, behaviour, outcome] of cases) {
    await withLaneTmp("edge-job-continue-", async (root) => {
      const jobDir = path.join(root, "job");
      const entries = api.resolvePlan(fourEntryPlan(), {
        jobDir,
        ...seamsFor(FAKE_SOURCES, root),
      });
      const spawner = makeSpawner({ "alpha/two": behaviour });
      const result = await api.runJob(entries, {
        jobDir,
        spawnEntry: spawner.spawnEntry,
        now: steppingClock(),
        log: sink(),
      });
      assert.deepEqual(
        spawner.calls.map((c) => c.key),
        ORDER,
        `${label}: every entry ran, each once (no retry)`,
      );
      assert.equal(result.stopped, false, label);
      assert.equal(result.rows[1].outcome, outcome, label);
    });
  }
}

/** INDEX.md and elapsed.json, from the stub receipts. */
async function recordsGroup(api) {
  await withLaneTmp("edge-job-records-", async (root) => {
    const jobDir = path.join(root, "job");
    const entries = api.resolvePlan(fourEntryPlan(), {
      jobDir,
      ...seamsFor(FAKE_SOURCES, root),
    });
    const oneReport = JSON.stringify({ probe: "fake", cells: [1] });
    const twoReport = JSON.stringify({ probe: "fake", cells: [2, 3] });
    const spawner = makeSpawner({
      "alpha/one": {
        exitCode: 0,
        files: {
          "fake-report.json": oneReport,
          "fake-runtime.json": {
            elapsedMs: 1234,
            verdicts: [{ id: "g1", pass: true }],
          },
        },
      },
      "alpha/two": {
        exitCode: 1,
        files: {
          "fake-report.json": twoReport,
          "fake-runtime.json": {
            elapsedMs: 4321,
            verdicts: [
              { id: "g1", pass: true },
              { id: "g2-parity", pass: false },
            ],
          },
        },
      },
      "beta/three": {
        exitCode: 3,
        files: {
          "fake-refusal.json": {
            elapsedMs: 55,
            refusal: { reason: "renderer-unsupported" },
          },
        },
      },
      "beta/four": {
        exitCode: 2,
        files: { "fake-error.json": { elapsedMs: 7, outcome: "errored" } },
      },
    });
    await api.runJob(entries, {
      jobDir,
      spawnEntry: spawner.spawnEntry,
      now: steppingClock(500),
      log: sink(),
    });

    const alpha = fs.readFileSync(
      path.join(jobDir, "alpha", "INDEX.md"),
      "utf8",
    );
    const alphaRows = alpha
      .split("\n")
      .filter((line) => /^\| (one|two) /.test(line));
    assert.equal(alphaRows.length, 2, "one INDEX row per entry");
    assert.match(alpha, /\| probe \| exit \|/, "the INDEX has its header");
    assert.match(alphaRows[0], /one \(probe-fake-a\.mjs\)/);
    assert.match(
      alphaRows[0],
      new RegExp(`fake-report\\.json ${md5(oneReport)}`),
      "the report md5",
    );
    assert.match(
      alphaRows[0],
      /instrument changed vs the baseline/,
      "the plan's instrument note",
    );
    assert.match(alphaRows[0], /1234/, "the receipt elapsedMs");
    assert.match(
      alphaRows[1],
      new RegExp(`fake-report\\.json ${md5(twoReport)}`),
    );
    assert.match(alphaRows[1], /g2-parity/, "the red verdict id");
    assert.doesNotMatch(
      alphaRows[1],
      /g1/,
      "a green verdict is not listed as red",
    );
    assert.match(alphaRows[1], /4321/);
    const beta = fs.readFileSync(path.join(jobDir, "beta", "INDEX.md"), "utf8");
    const betaRows = beta
      .split("\n")
      .filter((line) => /^\| (three|four) /.test(line));
    assert.equal(betaRows.length, 2);
    assert.match(betaRows[0], /renderer-unsupported/, "the refusal id");
    assert.match(betaRows[0], /55/);
    assert.match(betaRows[1], /\b7\b/);

    const elapsed = readJson(path.join(jobDir, "elapsed.json"));
    assert.equal(elapsed.schema, 1);
    assert.equal(elapsed.stoppedAt, null, "a complete job stopped nowhere");
    assert.equal(elapsed.entries.length, 4);
    for (const row of elapsed.entries) {
      for (const key of [
        "family",
        "id",
        "probe",
        "args",
        "runs",
        "exitCode",
        "outcome",
        "wallClockMs",
        "receiptElapsedMs",
      ]) {
        assert.ok(Object.hasOwn(row, key), `${row.id}: elapsed row has ${key}`);
      }
      assert.equal(
        row.wallClockMs,
        500,
        `${row.id}: wall clock from the stub clock`,
      );
    }
    assert.deepEqual(
      elapsed.entries.map((e) => e.runs),
      [1, 3, 1, 1],
      "runs from --runs",
    );
    assert.deepEqual(
      elapsed.entries.map((e) => e.exitCode),
      [0, 1, 3, 2],
    );
    assert.deepEqual(
      elapsed.entries.map((e) => e.receiptElapsedMs),
      [1234, 4321, 55, 7],
    );
    assert.deepEqual(
      elapsed.entries.map((e) => e.outcome),
      ["ok", "verdict-fail", "subject-refusal", "errored"],
    );
  });
}

/** --dry-run prints one command per entry and launches and writes nothing. */
async function dryRunGroup(api) {
  await withLaneTmp("edge-job-dry-", async (root) => {
    const planFile = path.join(root, "plan.json");
    fs.writeFileSync(
      planFile,
      JSON.stringify({
        schema: 1,
        entries: [
          entry("polar", "standing", {
            probe: "probe-polar-multi-plain.mjs",
            args: ["--port", "8094", "--renderer", "both"],
            instrumentNote: "a note that rides along",
          }),
          entry("c11", "thirteen", {
            probe: "probe-c11-13-voxel-inside-camera.mjs",
            env: { PROBE_BASE: "http://localhost:8094" },
          }),
        ],
      }),
    );
    const jobDir = path.join(root, "never-made");
    const log = sink();
    const spawner = makeSpawner();
    const code = await api.main(
      ["--job-dir", jobDir, "--plan", planFile, "--dry-run"],
      {
        spawnEntry: spawner.spawnEntry,
        log,
        repositoryRoot: root,
      },
    );
    assert.equal(code, 0);
    assert.deepEqual(spawner.calls, [], "nothing was spawned");
    assert.equal(
      fs.existsSync(jobDir),
      false,
      "no job directory, index or elapsed file was created",
    );
    assert.deepEqual(fs.readdirSync(root), ["plan.json"]);
    const commands = log.lines
      .join("")
      .split("\n")
      .filter((line) => line.length > 0 && !line.startsWith("  #"));
    assert.equal(commands.length, 2, "one command per entry");
    assert.match(
      commands[0],
      /^node Tools\/visual-regression\/probe-polar-multi-plain\.mjs --port 8094 --renderer both --output /,
    );
    assert.ok(
      commands[0].includes(
        path.resolve(jobDir, "polar", "standing").replaceAll("\\", "/"),
      ) || commands[0].includes(path.resolve(jobDir, "polar", "standing")),
      "the --output directory is under the job directory",
    );
    assert.match(
      commands[1],
      /^PROBE_BASE=http:\/\/localhost:8094 node Tools\/visual-regression\/probe-c11-13-voxel-inside-camera\.mjs --output /,
    );
    assert.match(
      log.lines.join(""),
      /a note that rides along/,
      "the instrument note is shown",
    );
  });
}

/** The CLI: exit 0 when every finished entry exited as planned, 1 when the job stopped, 2 on a bad invocation (4, an entry outside its expected exits, is pinned by its own groups). */
async function cliGroup(api) {
  await withLaneTmp("edge-job-cli-", async (root) => {
    const planFile = path.join(root, "plan.json");
    const realPlan = (over = {}) => ({
      schema: 1,
      entries: [
        entry("polar", "standing", {
          probe: "probe-polar-multi-plain.mjs",
          args: ["--port", "8094"],
        }),
        entry("c11", "thirteen", {
          probe: "probe-c11-13-voxel-inside-camera.mjs",
          env: { PROBE_BASE: "http://localhost:8094" },
        }),
      ],
      ...over,
    });
    const run = async (jobName, script, plan = realPlan()) => {
      fs.writeFileSync(planFile, JSON.stringify(plan));
      const spawner = makeSpawner(script);
      const jobDir = path.join(root, jobName);
      const code = await api.main(["--job-dir", jobDir, "--plan", planFile], {
        spawnEntry: spawner.spawnEntry,
        now: steppingClock(),
        log: sink(),
        repositoryRoot: root,
      });
      return { code, spawner, jobDir };
    };

    let outcome = await run("job-ok", { "polar/standing": { exitCode: 1 } });
    assert.equal(outcome.code, 0, "a verdict failure is still a complete job");
    assert.deepEqual(
      outcome.spawner.calls.map((c) => c.key),
      ["polar/standing", "c11/thirteen"],
    );
    const c11Call = outcome.spawner.calls[1];
    assert.deepEqual(
      c11Call.env,
      { PROBE_BASE: "http://localhost:8094" },
      "the c11 entry gets PROBE_BASE",
    );
    assert.deepEqual(c11Call.argv.slice(-2), [
      "--output",
      path.resolve(outcome.jobDir, "c11", "thirteen"),
    ]);

    outcome = await run("job-stopped", {
      "polar/standing": {
        exitCode: 3,
        files: { "x-refusal.json": { refusal: { reason: "origin-mismatch" } } },
      },
    });
    assert.equal(
      outcome.code,
      1,
      "an infrastructure refusal stops the job: exit 1",
    );
    assert.deepEqual(
      outcome.spawner.calls.map((c) => c.key),
      ["polar/standing"],
    );

    const bad = realPlan();
    bad.entries[0].args = ["--output", "elsewhere"];
    outcome = await run("job-bad-plan", {}, bad);
    assert.equal(outcome.code, 2, "a plan the runner refuses is a usage error");
    assert.deepEqual(
      outcome.spawner.calls,
      [],
      "nothing was spawned from a refused plan",
    );
    assert.equal(
      fs.existsSync(outcome.jobDir),
      false,
      "nothing was created either",
    );

    const usage = await api.main(["--plan", planFile], {
      spawnEntry: makeSpawner().spawnEntry,
      log: sink(),
    });
    assert.equal(usage, 2, "--job-dir is required");
    const unknown = await api.main(
      ["--job-dir", path.join(root, "j"), "--bogus"],
      {
        spawnEntry: makeSpawner().spawnEntry,
        log: sink(),
      },
    );
    assert.equal(unknown, 2, "an unknown flag is a usage error");
  });
}

/** The Moria F3 note: a two-argument waitForFunction whose second argument is an options object. */
async function noteGroup(api) {
  await withLaneTmp("edge-job-note-", (root) => {
    const jobDir = path.join(root, "job");
    const noteFor = (sources, over = {}) => {
      const [resolved] = api.resolvePlan(
        { schema: 1, entries: [entry("alpha", "one", over)] },
        {
          jobDir,
          ...seamsFor({ "probe-fake-a.mjs": FAKE_SOURCE, ...sources }, root),
        },
      );
      return resolved.instrumentNote;
    };
    const f3 = (body) => `${FAKE_SOURCE}${body}\n`;

    const flagged = noteFor({
      "probe-fake-a.mjs": f3(
        "async function wait(page) {\n  await page.waitForFunction(() => window.ready, { timeout: 90_000 });\n}",
      ),
    });
    assert.match(
      flagged,
      /Moria F3/,
      "options as the page function's argument is noted",
    );
    // FAKE_SOURCE is two lines; the waitForFunction call is on the fourth.
    assert.match(flagged, /probe-fake-a\.mjs:4:/, "with the line it sits on");

    assert.doesNotMatch(
      noteFor({
        "probe-fake-a.mjs": f3(
          "await page.waitForFunction(fn, null, { timeout: 90_000 });",
        ),
      }),
      /Moria F3/,
      "options as the third argument are correct",
    );
    assert.doesNotMatch(
      noteFor({
        "probe-fake-a.mjs": f3(
          "await page.waitForFunction(fn, undefined, { timeout: 90_000 });",
        ),
      }),
      /Moria F3/,
    );
    assert.doesNotMatch(
      noteFor({
        "probe-fake-a.mjs": f3(
          "// await page.waitForFunction(fn, { timeout: 5 });\nconst s = 'waitForFunction(fn, { timeout: 5 })';",
        ),
      }),
      /Moria F3/,
      "a comment or a string is not a call",
    );
    assert.doesNotMatch(
      noteFor({
        "probe-fake-a.mjs": f3(
          "await page.waitForFunction(() => window.ready);",
        ),
      }),
      /Moria F3/,
    );

    // The shape in a direct ./lib/ import counts, and the plan's own note comes first.
    const fromLib = noteFor(
      {
        "probe-fake-a.mjs": f3('import { waitReady } from "./lib/waits.mjs";'),
        "waits.mjs":
          "export const w = (p) => p.waitForFunction(() => 1, { timeout: 1000 });\n",
      },
      { instrumentNote: "plan note" },
    );
    assert.match(fromLib, /^plan note \| Moria F3 at .*waits\.mjs:1/);
  });
}

/** The plan that ships is a valid, positive-list plan. */
async function shippedPlanGroup(api) {
  const plan = readJson(api.DEFAULT_PLAN_PATH);
  const resolved = api.resolvePlan(plan, {
    jobDir: path.join(path.parse(HERE).root, "no-such-job-dir-for-spec"),
    repositoryRoot: path.parse(HERE).root,
  });
  assert.ok(resolved.length > 0);
  assert.equal(
    new Set(resolved.map((e) => `${e.family}/${e.id}`)).size,
    resolved.length,
  );
  const c11 = resolved.filter((e) => e.family === "c11");
  assert.ok(c11.length > 0, "the c11 probes are in the plan");
  for (const e of c11) {
    assert.ok(
      typeof e.env.PROBE_BASE === "string" && !/:8080/.test(e.env.PROBE_BASE),
      `${e.id}: PROBE_BASE, never 8080`,
    );
  }
  for (const e of resolved) {
    assert.equal(e.argv.includes("8080"), false, `${e.id}: no port 8080`);
    assert.equal(
      e.argv.filter((a) => a === "--output").length,
      1,
      `${e.id}: exactly one --output`,
    );
  }
}

/**
 * A refusal reported ONLY on stderr: the c11 entries write no refusal file, and
 * neither does a runtime refusal raised while a probe's arguments are parsed.
 * The INDEX row still names the id, the entry is classed infrastructure, and
 * the job stops there.
 */
async function stderrRefusalGroup(api) {
  await withLaneTmp("edge-job-stderr-refusal-", async (root) => {
    const jobDir = path.join(root, "job");
    const entries = api.resolvePlan(fourEntryPlan(), {
      jobDir,
      ...seamsFor(FAKE_SOURCES, root),
    });
    const spawner = makeSpawner({
      "beta/three": {
        exitCode: 3,
        stderr:
          "probe-c11-13-voxel-inside-camera: REFUSED (probe-base-unset) - PROBE_BASE is unset; set it to the governed origin\n",
      },
    });
    const result = await api.runJob(entries, {
      jobDir,
      spawnEntry: spawner.spawnEntry,
      now: steppingClock(),
      log: sink(),
    });
    assert.deepEqual(
      fs.readdirSync(path.join(jobDir, "beta", "three")),
      [],
      "the stub child wrote no file",
    );
    assert.deepEqual(
      spawner.calls.map((c) => c.key),
      ["alpha/one", "alpha/two", "beta/three"],
      "the job stops at the stderr-only refusal",
    );
    assert.equal(result.stopped, true);
    assert.equal(result.stoppedAt, "beta/three");
    const row = result.rows.at(-1);
    assert.equal(row.refusalId, "probe-base-unset", "the id read off stderr");
    assert.equal(row.outcome, "infrastructure-refusal");
    const indexRow = fs
      .readFileSync(path.join(jobDir, "beta", "INDEX.md"), "utf8")
      .split("\n")
      .find((line) => line.startsWith("| three "));
    assert.ok(indexRow, "the INDEX carries the refused entry");
    assert.match(indexRow, /\| infrastructure-refusal \|/, "INDEX outcome");
    assert.match(indexRow, /\| probe-base-unset \|/, "INDEX refusal id");
    assert.equal(
      readJson(path.join(jobDir, "elapsed.json")).stoppedAt,
      "beta/three",
    );
  });
}

/**
 * The REAL spawner merges the entry's env over the runner's own: a value the
 * operator's shell carries is overridden by the plan's. Node only: the child is
 * `node -e`, no browser.
 */
async function realSpawnerEnvGroup(api) {
  await withLaneTmp("edge-job-real-spawn-", async (root) => {
    const saved = process.env.KIT5_ENV;
    process.env.KIT5_ENV = "shell";
    try {
      const child = await api.spawnWithBoundedCommand({
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write(process.env.KIT5_ENV ?? '')",
        ],
        cwd: root,
        env: { KIT5_ENV: "plan" },
        timeoutMs: 30_000,
        artifactPath: path.join(root, "a.jsonl"),
      });
      assert.equal(child.exitCode, 0, child.stderr);
      assert.equal(child.stdout, "plan", "the plan's env reached the child");
    } finally {
      if (saved === undefined) {
        delete process.env.KIT5_ENV;
      } else {
        process.env.KIT5_ENV = saved;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Live tests
// ---------------------------------------------------------------------------

test("e. the plan resolves in order with --output and env, and a bad plan is refused whole", () =>
  planGroup(realRunner));
test("e. entries run strictly in order, one at a time, each once, with --output and env", () =>
  orderGroup(realRunner));
test("e. the job stops after an infrastructure-class end and never retries", () =>
  stopGroup(realRunner));
test("e. a subject refusal, a verdict failure and an error do not stop the job", () =>
  continueGroup(realRunner));
test("e. INDEX.md and elapsed.json are written from the receipts", () =>
  recordsGroup(realRunner));
test("e. --dry-run prints the commands and launches and writes nothing", () =>
  dryRunGroup(realRunner));
test("e. the CLI exits 0, 1 and 2", () => cliGroup(realRunner));
test("e. a two-argument waitForFunction with an options object is noted as Moria F3", () =>
  noteGroup(realRunner));
test("e. the shipped plan is a valid positive-list plan", () =>
  shippedPlanGroup(realRunner));
test("e. a refusal printed only on stderr is indexed by id, classed infrastructure, and stops the job", () =>
  stderrRefusalGroup(realRunner));
test("e. the real spawner passes the entry's env over the shell's", () =>
  realSpawnerEnvGroup(realRunner));

/**
 * A job directory outside the checkout is refused when the plan is loaded,
 * naming the directory and the root, and nothing is spawned or created; one
 * inside it is accepted. Since Batch 1623 a probe on the runtime refuses an
 * --output outside its repository root, so such a job would otherwise run
 * every runtime entry to an exit 2 (a wall of errors). The default root is the
 * runner's own checkout (no seam is passed here). The lane temp root is on
 * another drive on this host, so this case reaches the path.isAbsolute half of
 * the check; the same-volume sibling is pinned by siblingJobDirGroup.
 */
async function outsideJobDirGroup(api) {
  await withLaneTmp("edge-job-outside-", async (root) => {
    const planFile = path.join(root, "plan.json");
    fs.writeFileSync(
      planFile,
      JSON.stringify({
        schema: 1,
        entries: [
          entry("polar", "standing", {
            probe: "probe-polar-multi-plain.mjs",
            args: ["--port", "8094"],
          }),
        ],
      }),
    );
    const outside = path.join(root, "job");
    assert.throws(
      () => api.resolvePlan(readJson(planFile), { jobDir: outside }),
      (error) =>
        error instanceof api.EdgeJobPlanError &&
        error.message.includes(outside) &&
        /outside the repository root/.test(error.message),
      "a job directory outside the checkout is refused, named, at plan load",
    );
    const spawner = makeSpawner({});
    const code = await api.main(["--job-dir", outside, "--plan", planFile], {
      spawnEntry: spawner.spawnEntry,
      log: sink(),
    });
    assert.equal(code, 2, "the CLI reads it as an invalid plan");
    assert.deepEqual(spawner.calls, [], "nothing was spawned");
    assert.equal(fs.existsSync(outside), false, "nothing was created");
    // The control: inside the checkout the same plan resolves (nothing is
    // written by resolvePlan, so the directory is never made).
    const inside = path.resolve(
      HERE,
      "output",
      "edge-job-spec-inside-never-made",
    );
    const [resolved] = api.resolvePlan(readJson(planFile), { jobDir: inside });
    assert.equal(
      resolved.outputDirectory,
      path.resolve(inside, "polar", "standing"),
    );
    assert.equal(fs.existsSync(inside), false);
  });
}

test("e. a job directory outside the checkout is refused at plan load, before any spawn", () =>
  outsideJobDirGroup(realRunner));

/**
 * The ids the kit itself refuses with for an infrastructure cause, produced by
 * driving the kit's own decisions (never typed here): the served-build
 * preflight, the navigated origin, the port, PROBE_BASE and the Edge slot.
 */
function kitInfrastructureRefusalIds(root) {
  const ids = [
    decideServedBuildRefusal(null).reason,
    decideServedBuildRefusal({ ok: true, artifacts: [] }).reason,
    decideOriginRefusal({ requestedOrigin: "not a url", actualUrl: "x" })
      .reason,
    decideOriginRefusal({
      requestedOrigin: "http://localhost:8094",
      actualUrl: "http://localhost:8095/Apps/CesiumViewer/index.html",
    }).reason,
    decideOriginRefusal({
      requestedOrigin: "http://localhost:8094",
      actualUrl: "::not a url",
    }).reason,
    decidePortRefusal(8080).reason,
  ];
  const thrown = (fn) => {
    try {
      fn();
    } catch (error) {
      return error.reason;
    }
    throw new Error("expected the kit to refuse");
  };
  ids.push(thrown(() => throwIfProbeBaseRefused(undefined)));
  const lockPath = path.join(root, "edge-slot.lock");
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ owner: "spec", pid: process.pid, acquiredAt: Date.now() }),
  );
  ids.push(
    thrown(() =>
      acquireEdgeSlot({ lockPath, owner: "spec", isProcessAlive: () => true }),
    ),
  );
  return ids;
}

/**
 * The runner's infrastructure classes are exactly the kit's infrastructure
 * refusal ids: a kit id renamed or added without the runner would otherwise be
 * read as a subject refusal, and the job would carry on past it.
 */
async function infrastructureIdsGroup(api) {
  await withLaneTmp("edge-job-infra-ids-", (root) => {
    const kit = kitInfrastructureRefusalIds(root);
    for (const id of kit) {
      assert.equal(
        typeof id,
        "string",
        "every kit decision refused with an id",
      );
      assert.equal(
        api.classifyEntry({ exitCode: 3 }, id),
        api.ENTRY_OUTCOMES.INFRASTRUCTURE_REFUSAL,
        `the kit's ${id} is classed infrastructure`,
      );
    }
    assert.deepEqual(
      [...new Set(kit)].sort(),
      Object.keys(api.INFRASTRUCTURE_REFUSAL_CLASSES).sort(),
      "the runner's infrastructure classes are the kit's infrastructure ids, no more and no fewer",
    );
  });
}

test("e. the runner's infrastructure refusal classes are the ids the kit's own decisions refuse with", () =>
  infrastructureIdsGroup(realRunner));

// ---------------------------------------------------------------------------
// Exit 4: a finished entry outside its expected exits
// ---------------------------------------------------------------------------

const THREE_ORDER = ["polar/one", "polar/two", "c11/three"];
const UNEXPECTED_LINE =
  /^\[edge-job\] \d+ of \d+ finished entries exited outside their expected exits: /;

/** Three real-probe entries over two families; `expectedExit` per entry (default [0, 1]). */
function threeEntryPlan(expected = {}) {
  const exits = (key) => expected[key] ?? [0, 1];
  return {
    schema: 1,
    entries: [
      entry("polar", "one", {
        probe: "probe-polar-multi-plain.mjs",
        args: ["--port", "8094"],
        expectedExit: exits("polar/one"),
      }),
      entry("polar", "two", {
        probe: "probe-polar-multi-plain.mjs",
        args: ["--port", "8094"],
        expectedExit: exits("polar/two"),
      }),
      entry("c11", "three", {
        probe: "probe-c11-13-voxel-inside-camera.mjs",
        env: { PROBE_BASE: "http://localhost:8094" },
        expectedExit: exits("c11/three"),
      }),
    ],
  };
}

const erroredFiles = { "fake-error.json": { outcome: "errored" } };

/** Run a plan through `main` with a stub spawner; returns the code, the calls, the stdout and the record. */
async function runThroughMain(api, root, jobName, plan, script) {
  const planFile = path.join(root, `${jobName}-plan.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const spawner = makeSpawner(script);
  const log = sink();
  const jobDir = path.join(root, jobName);
  const code = await api.main(["--job-dir", jobDir, "--plan", planFile], {
    spawnEntry: spawner.spawnEntry,
    now: steppingClock(),
    log,
    repositoryRoot: root,
  });
  const stdout = log.lines.join("");
  const elapsedFile = path.join(jobDir, "elapsed.json");
  return {
    code,
    spawner,
    jobDir,
    stdout,
    summaryLines: stdout
      .split("\n")
      .filter((line) => UNEXPECTED_LINE.test(line)),
    elapsed: fs.existsSync(elapsedFile) ? readJson(elapsedFile) : null,
  };
}

/** A job in which every entry errors is not a clean job: exit 4, everything still run and recorded. */
async function allErroredGroup(api) {
  await withLaneTmp("edge-job-all-errored-", async (root) => {
    const run = await runThroughMain(api, root, "job", threeEntryPlan(), {
      "polar/one": { exitCode: 2, files: erroredFiles },
      "polar/two": { exitCode: 2, files: erroredFiles },
      "c11/three": { exitCode: 2, files: erroredFiles },
    });
    assert.equal(run.code, 4, "every entry errored: the job exits 4");
    assert.deepEqual(
      run.spawner.calls.map((c) => c.key),
      THREE_ORDER,
      "every entry was still spawned, in order, once",
    );
    for (const family of ["polar", "c11"]) {
      const index = fs.readFileSync(
        path.join(run.jobDir, family, "INDEX.md"),
        "utf8",
      );
      assert.match(index, /errored/, `${family}: INDEX.md is written`);
      assert.match(index, /\(UNEXPECTED\)/, `${family}: INDEX marks the rows`);
    }
    assert.ok(run.elapsed, "elapsed.json is written");
    assert.equal(run.elapsed.stoppedAt, null);
    assert.deepEqual(
      run.elapsed.entries.map((e) => `${e.family}/${e.id}`),
      THREE_ORDER,
    );
    assert.deepEqual(run.elapsed.unexpectedExits, {
      count: 3,
      entries: [
        { family: "polar", id: "one", exitCode: 2, expectedExit: [0, 1] },
        { family: "polar", id: "two", exitCode: 2, expectedExit: [0, 1] },
        { family: "c11", id: "three", exitCode: 2, expectedExit: [0, 1] },
      ],
    });
    assert.equal(run.summaryLines.length, 1, "exactly one summary line");
    assert.equal(
      run.summaryLines[0],
      "[edge-job] 3 of 3 finished entries exited outside their expected exits: polar/one (exit 2, expected 0,1), polar/two (exit 2, expected 0,1), c11/three (exit 2, expected 0,1)",
    );
  });
}

/** One entry that errors among entries that exit 0: exit 4, and the line and the record name exactly it. */
async function singleErroredGroup(api) {
  await withLaneTmp("edge-job-single-errored-", async (root) => {
    const run = await runThroughMain(api, root, "job", threeEntryPlan(), {
      "polar/two": { exitCode: 2, files: erroredFiles },
    });
    assert.equal(run.code, 4, "one errored entry: the job exits 4");
    assert.deepEqual(
      run.spawner.calls.map((c) => c.key),
      THREE_ORDER,
      "the job ran past the errored entry",
    );
    assert.deepEqual(run.elapsed.unexpectedExits, {
      count: 1,
      entries: [
        { family: "polar", id: "two", exitCode: 2, expectedExit: [0, 1] },
      ],
    });
    assert.equal(run.summaryLines.length, 1);
    assert.equal(
      run.summaryLines[0],
      "[edge-job] 1 of 3 finished entries exited outside their expected exits: polar/two (exit 2, expected 0,1)",
    );
  });
}

/** What the plan expects decides: a planned verdict failure is 0, an expected red that passes is 4. */
async function expectedExitsGroup(api) {
  await withLaneTmp("edge-job-expected-exits-", async (root) => {
    // A verdict failure (exit 1) with expectedExit [0, 1]: still a clean job.
    let run = await runThroughMain(api, root, "verdict", threeEntryPlan(), {
      "polar/two": { exitCode: 1 },
    });
    assert.equal(run.code, 0, "a planned verdict failure leaves exit 0");
    assert.deepEqual(
      run.spawner.calls.map((c) => c.key),
      THREE_ORDER,
    );
    assert.equal(
      run.summaryLines[0],
      "[edge-job] 0 of 3 finished entries exited outside their expected exits: none",
    );
    assert.deepEqual(run.elapsed.unexpectedExits, { count: 0, entries: [] });

    // An expected red ([1]) that exits 1 is as planned: 0.
    const expectRed = threeEntryPlan({ "polar/two": [1] });
    run = await runThroughMain(api, root, "expected-red", expectRed, {
      "polar/two": { exitCode: 1 },
    });
    assert.equal(run.code, 0, "an expected red that is red leaves exit 0");
    assert.equal(run.summaryLines.length, 1);
    assert.equal(
      run.summaryLines[0],
      "[edge-job] 0 of 3 finished entries exited outside their expected exits: none",
    );

    // The same entry exiting 0 is outside its expected exits: 4.
    run = await runThroughMain(api, root, "expected-red-passes", expectRed, {
      "polar/two": { exitCode: 0 },
    });
    assert.equal(run.code, 4, "an expected red that passes is outside [1]");
    assert.equal(
      run.summaryLines[0],
      "[edge-job] 1 of 3 finished entries exited outside their expected exits: polar/two (exit 0, expected 1)",
    );
    assert.deepEqual(run.elapsed.unexpectedExits, {
      count: 1,
      entries: [{ family: "polar", id: "two", exitCode: 0, expectedExit: [1] }],
    });
  });
}

const MEASURED_LINE = /^\[edge-job\] \d+ of \d+ finished entries measured /;
const reportFiles = {
  "fake-report.json": { verdicts: [{ id: "v", pass: true }] },
};

/** How many entries measured is said: only a pass or a verdict failure that left a report receipt counts. */
async function measuredCountGroup(api) {
  await withLaneTmp("edge-job-measured-", async (root) => {
    // A pass and a verdict failure with receipts measured; an error did not.
    let run = await runThroughMain(api, root, "mixed", threeEntryPlan(), {
      "polar/one": { exitCode: 0, files: reportFiles },
      "polar/two": { exitCode: 1, files: reportFiles },
      "c11/three": { exitCode: 2, files: erroredFiles },
    });
    let lines = run.stdout.split("\n").filter((l) => MEASURED_LINE.test(l));
    assert.deepEqual(lines, [
      "[edge-job] 2 of 3 finished entries measured (exit 0 or 1 with a receipt): polar/one, polar/two",
    ]);
    assert.deepEqual(run.elapsed.measured, {
      count: 2,
      entries: [
        { family: "polar", id: "one" },
        { family: "polar", id: "two" },
      ],
    });

    // Exit 0 with no receipt did not measure, though the job exits 0.
    run = await runThroughMain(api, root, "receiptless", threeEntryPlan(), {
      "polar/one": { exitCode: 0 },
      "polar/two": { exitCode: 0 },
      "c11/three": { exitCode: 0, files: reportFiles },
    });
    assert.equal(run.code, 0, "every exit is as planned");
    lines = run.stdout.split("\n").filter((l) => MEASURED_LINE.test(l));
    assert.deepEqual(lines, [
      "[edge-job] 1 of 3 finished entries measured (exit 0 or 1 with a receipt): c11/three",
    ]);
    assert.deepEqual(run.elapsed.measured, {
      count: 1,
      entries: [{ family: "c11", id: "three" }],
    });

    // A c11 harness measures through its performance/ artifact; its
    // write-once first-red alone is not a receipt.
    run = await runThroughMain(api, root, "harness", threeEntryPlan(), {
      "polar/one": {
        exitCode: 1,
        files: { "performance/x.first-red.json": { red: true } },
      },
      "polar/two": { exitCode: 2, files: erroredFiles },
      "c11/three": {
        exitCode: 0,
        files: { "performance/c11-13-voxel-inside-camera.json": {} },
      },
    });
    lines = run.stdout.split("\n").filter((l) => MEASURED_LINE.test(l));
    assert.deepEqual(lines, [
      "[edge-job] 1 of 3 finished entries measured (exit 0 or 1 with a receipt): c11/three",
    ]);

    // Nothing measured is said as none.
    run = await runThroughMain(api, root, "none", threeEntryPlan(), {});
    lines = run.stdout.split("\n").filter((l) => MEASURED_LINE.test(l));
    assert.deepEqual(lines, [
      "[edge-job] 0 of 3 finished entries measured (exit 0 or 1 with a receipt): none",
    ]);
    assert.deepEqual(run.elapsed.measured, { count: 0, entries: [] });
  });
}

/** A stopped job is exit 1 whatever else it ran, and still carries the unexpected entries. */
async function stoppedAfterUnexpectedGroup(api) {
  const cases = [
    [
      "an infrastructure refusal",
      {
        exitCode: 3,
        files: { "x-refusal.json": { refusal: { reason: "origin-mismatch" } } },
      },
      "polar/two (exit 3, expected 0,1,3)",
    ],
    [
      "a timeout (no exit)",
      { exitCode: null, timedOut: true },
      "polar/two (exit null, expected 0,1,3)",
    ],
  ];
  for (const [label, behaviour, stoppingEntry] of cases) {
    await withLaneTmp("edge-job-stopped-unexpected-", async (root) => {
      const plan = threeEntryPlan({ "polar/two": [0, 1, 3] });
      // The stopping entry itself is outside [0, 1, 3] only for the timeout.
      const run = await runThroughMain(api, root, "job", plan, {
        "polar/one": { exitCode: 2, files: erroredFiles },
        "polar/two": behaviour,
      });
      assert.equal(run.code, 1, `${label}: the stopped job exits 1, not 4`);
      assert.deepEqual(
        run.spawner.calls.map((c) => c.key),
        ["polar/one", "polar/two"],
        `${label}: nothing after the stopping entry ran`,
      );
      assert.equal(run.elapsed.stoppedAt, "polar/two", label);
      assert.equal(run.summaryLines.length, 1, `${label}: one summary line`);
      assert.match(
        run.summaryLines[0],
        /polar\/one \(exit 2, expected 0,1\)/,
        `${label}: the line carries the unexpected entry`,
      );
      assert.ok(
        run.elapsed.unexpectedExits.entries.some(
          (e) => e.family === "polar" && e.id === "one" && e.exitCode === 2,
        ),
        `${label}: the record carries the unexpected entry`,
      );
      if (behaviour.exitCode === null) {
        assert.ok(
          run.summaryLines[0].includes(stoppingEntry),
          `${label}: an entry with no exit counts as outside its expected exits`,
        );
        assert.equal(run.elapsed.unexpectedExits.count, 2, label);
      } else {
        assert.equal(run.elapsed.unexpectedExits.count, 1, label);
        assert.match(run.summaryLines[0], /^\[edge-job\] 1 of 2 /, label);
      }
    });
  }
}

/**
 * A job directory that is a never-made SIBLING of the checkout on the same
 * volume (its path relative to the root starts with `..` and is not absolute)
 * is refused at plan load, naming it and the root; the lane temp root used by
 * `outsideJobDirGroup` is on another drive here and reaches only the
 * `path.isAbsolute` half of the check.
 */
async function siblingJobDirGroup(api) {
  await withLaneTmp("edge-job-sibling-", async (root) => {
    const planFile = path.join(root, "plan.json");
    fs.writeFileSync(
      planFile,
      JSON.stringify({
        schema: 1,
        entries: [
          entry("polar", "standing", {
            probe: "probe-polar-multi-plain.mjs",
            args: ["--port", "8094"],
          }),
        ],
      }),
    );
    // The runner's default root is its own checkout (HERE/../..).
    const repositoryRoot = path.resolve(HERE, "..", "..");
    const sibling = path.resolve(
      repositoryRoot,
      "..",
      "edge-job-spec-outside-never-made",
    );
    const relative = path.relative(repositoryRoot, sibling);
    assert.ok(
      relative.startsWith("..") && !path.isAbsolute(relative),
      `the case is a same-volume sibling (relative ${relative})`,
    );
    assert.equal(fs.existsSync(sibling), false, "the sibling is never made");
    // resolvePlan first: were the check halved, nothing below may run.
    assert.throws(
      () => api.resolvePlan(readJson(planFile), { jobDir: sibling }),
      (error) =>
        error instanceof api.EdgeJobPlanError &&
        error.message.includes(sibling) &&
        /outside the repository root/.test(error.message),
      "a sibling of the checkout is refused, named, at plan load",
    );
    const spawner = makeSpawner({});
    const code = await api.main(["--job-dir", sibling, "--plan", planFile], {
      spawnEntry: spawner.spawnEntry,
      log: sink(),
    });
    assert.equal(code, 2, "the CLI reads it as an invalid plan");
    assert.deepEqual(spawner.calls, [], "nothing was spawned");
    assert.equal(fs.existsSync(sibling), false, "nothing was created");
  });
}

test("e. a job in which every entry errors exits 4 after running and recording every entry", () =>
  allErroredGroup(realRunner));
test("e. one errored entry among entries that exit 0 exits 4 and is the only one named", () =>
  singleErroredGroup(realRunner));
test("e. the plan's expectedExit decides the exit: a planned verdict failure is 0, an expected red that passes is 4", () =>
  expectedExitsGroup(realRunner));
test("e. a job that stopped is exit 1 and still names the entries outside their expected exits", () =>
  stoppedAfterUnexpectedGroup(realRunner));
test("e. a never-made sibling of the checkout on the same volume is refused at plan load", () =>
  siblingJobDirGroup(realRunner));

// ---------------------------------------------------------------------------
// A job that would measure nothing: every route to it is refused or non-zero
// ---------------------------------------------------------------------------

/**
 * Run `main` over a plan written to the lane temp root, with a stub spawner,
 * a stdout sink and a stderr sink; the job directory is `<root>/<jobName>`.
 */
async function mainOver(api, root, jobName, plan, args = [], script = {}) {
  const planFile = path.join(root, `${jobName}-plan.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const jobDir = path.join(root, jobName);
  const spawner = makeSpawner(script);
  const log = sink();
  const stderr = sink();
  const code = await api.main(
    ["--job-dir", jobDir, "--plan", planFile, ...args],
    {
      spawnEntry: spawner.spawnEntry,
      now: steppingClock(),
      log,
      stderr,
      repositoryRoot: root,
    },
  );
  return {
    code,
    spawner,
    jobDir,
    stdout: log.lines.join(""),
    stderr: stderr.lines.join(""),
  };
}

const NO_FAMILY_CAUSE =
  /--family names no family once split on commas and trimmed/;

/** The selections that resolve no entry: [label, extra args, plan or null for threeEntryPlan, the named cause]. */
const EMPTY_SELECTIONS = [
  ['--family ""', ["--family", ""], null, NO_FAMILY_CAUSE],
  ['--family ","', ["--family", ","], null, NO_FAMILY_CAUSE],
  ['--family " "', ["--family", " "], null, NO_FAMILY_CAUSE],
  [
    "a plan with no entries",
    [],
    { schema: 1, entries: [] },
    /the plan has no entries/,
  ],
];

/**
 * A selection that resolves no entry is a usage error, with and without
 * --dry-run: exit 2, nothing spawned, no job directory, nothing on stdout, and
 * stderr names the cause. The controls: --family nosuch keeps its exit 2, and
 * a selection of at least one entry still runs (or prints, under --dry-run)
 * and exits 0.
 */
async function emptySelectionGroup(api) {
  await withLaneTmp("edge-job-empty-selection-", async (root) => {
    let n = 0;
    for (const [label, args, plan, cause] of EMPTY_SELECTIONS) {
      for (const dryRun of [false, true]) {
        const what = `${label}${dryRun ? " --dry-run" : ""}`;
        n += 1;
        const run = await mainOver(
          api,
          root,
          `job-${n}`,
          plan ?? threeEntryPlan(),
          [...args, ...(dryRun ? ["--dry-run"] : [])],
        );
        assert.equal(run.code, 2, `${what}: a usage error, exit 2`);
        assert.deepEqual(run.spawner.calls, [], `${what}: nothing spawned`);
        assert.equal(
          fs.existsSync(run.jobDir),
          false,
          `${what}: no job directory and no elapsed.json`,
        );
        assert.equal(run.stdout, "", `${what}: no command and no summary line`);
        assert.match(
          run.stderr,
          /the selection resolves no entry/,
          `${what}: stderr says the selection is empty`,
        );
        assert.match(run.stderr, cause, `${what}: stderr names the cause`);
      }
    }

    // The control: a family the plan does not have keeps its exit 2.
    const nosuch = await mainOver(api, root, "nosuch", threeEntryPlan(), [
      "--family",
      "nosuch",
    ]);
    assert.equal(nosuch.code, 2, "--family nosuch: exit 2");
    assert.deepEqual(nosuch.spawner.calls, []);
    assert.equal(fs.existsSync(nosuch.jobDir), false);
    assert.match(nosuch.stderr, /--family nosuch names no family in the plan/);

    // A selection of at least one entry is not refused: a dry run prints it
    // and exits 0, a run spawns it and exits 0, and empty pieces around a
    // family name are dropped.
    const dry = await mainOver(api, root, "dry", threeEntryPlan(), [
      "--family",
      "polar",
      "--dry-run",
    ]);
    assert.equal(dry.code, 0, "a dry run of a non-empty selection keeps 0");
    assert.deepEqual(dry.spawner.calls, []);
    assert.equal(fs.existsSync(dry.jobDir), false);
    assert.equal(
      dry.stdout.split("\n").filter((line) => line.startsWith("node ")).length,
      2,
      "the dry run prints the two polar commands",
    );
    const ran = await mainOver(api, root, "ran", threeEntryPlan(), [
      "--family",
      " , c11 , ",
    ]);
    assert.equal(ran.code, 0, "a run of a non-empty selection exits 0");
    assert.deepEqual(
      ran.spawner.calls.map((c) => c.key),
      ["c11/three"],
    );

    // resolvePlan refuses an empty family list handed to it directly.
    assert.throws(
      () =>
        api.resolvePlan(threeEntryPlan(), {
          jobDir: path.join(root, "direct"),
          families: [],
          repositoryRoot: root,
        }),
      (error) =>
        error instanceof api.EdgeJobPlanError &&
        /the selection resolves no entry/.test(error.message) &&
        NO_FAMILY_CAUSE.test(error.message),
    );
  });
}

const SUBJECT_REFUSAL = {
  exitCode: 3,
  files: {
    "fake-refusal.json": { refusal: { reason: "capture-selector-ambiguous" } },
  },
};

/**
 * A subject refusal (exit 3 with an id that is not an infrastructure class)
 * does not stop the job, and under an expectedExit of [0, 1] the job exits 4,
 * naming the entry on the stdout line, in elapsed.json and in INDEX.md. The
 * control: a plan that lists 3 for that entry leaves 0.
 */
async function subjectRefusalExitGroup(api) {
  await withLaneTmp("edge-job-subject-refusal-", async (root) => {
    const run = await runThroughMain(api, root, "job", threeEntryPlan(), {
      "polar/two": SUBJECT_REFUSAL,
    });
    assert.equal(run.code, 4, "a subject refusal outside [0, 1] exits 4");
    assert.deepEqual(
      run.spawner.calls.map((c) => c.key),
      THREE_ORDER,
      "the subject refusal did not stop the job",
    );
    assert.equal(run.elapsed.stoppedAt, null);
    assert.equal(run.elapsed.entries[1].outcome, "subject-refusal");
    assert.deepEqual(run.elapsed.unexpectedExits, {
      count: 1,
      entries: [
        { family: "polar", id: "two", exitCode: 3, expectedExit: [0, 1] },
      ],
    });
    assert.deepEqual(run.summaryLines, [
      "[edge-job] 1 of 3 finished entries exited outside their expected exits: polar/two (exit 3, expected 0,1)",
    ]);
    const row = fs
      .readFileSync(path.join(run.jobDir, "polar", "INDEX.md"), "utf8")
      .split("\n")
      .find((line) => line.startsWith("| two "));
    assert.match(row, /\(UNEXPECTED\)/, "INDEX marks the refused row");
    assert.match(row, /\| subject-refusal \|/);
    assert.match(row, /\| capture-selector-ambiguous \|/);

    const planned = await runThroughMain(
      api,
      root,
      "planned",
      threeEntryPlan({ "polar/two": [0, 1, 3] }),
      { "polar/two": SUBJECT_REFUSAL },
    );
    assert.equal(planned.code, 0, "a refusal the plan lists leaves 0");
  });
}

/** The shipped plan as `main` loads it: the file's text through JSON.parse. */
function loadShippedPlan(api) {
  return JSON.parse(fs.readFileSync(api.DEFAULT_PLAN_PATH, "utf8"));
}

/**
 * Entries of a plan that list an error (2) or a refusal (3) in expectedExit,
 * or anything outside a pass (0) and a verdict failure (1). Such an entry
 * would let a job in which it errored or refused finish 0.
 */
function entriesExpectingOtherThanPassOrFail(plan) {
  return plan.entries
    .filter(
      (e) =>
        !Array.isArray(e.expectedExit) ||
        !e.expectedExit.every((code) => code === 0 || code === 1),
    )
    .map((e) => `${e.family}/${e.id} ${JSON.stringify(e.expectedExit)}`);
}

/**
 * Every entry of the shipped plan expects a pass or a verdict failure only
 * (0 or 1), so a subject refusal or an error in any of them makes the job
 * exit 4; through `main` over the shipped plan (its first family), a subject
 * refusal in the first entry exits 4 and the job still runs the family.
 */
async function shippedPlanExpectedExitGroup(api) {
  const plan = loadShippedPlan(api);
  assert.ok(plan.entries.length > 0);
  assert.deepEqual(
    entriesExpectingOtherThanPassOrFail(plan),
    [],
    "no shipped entry expects an error or a refusal",
  );
  for (const e of plan.entries) {
    assert.ok(
      Array.isArray(e.expectedExit) && e.expectedExit.length > 0,
      `${e.family}/${e.id}: an explicit expectedExit`,
    );
  }
  const first = plan.entries[0];
  const family = plan.entries.filter((e) => e.family === first.family);
  await withLaneTmp("edge-job-shipped-refusal-", async (root) => {
    const jobDir = path.join(root, "job");
    const spawner = makeSpawner({
      [`${first.family}/${first.id}`]: SUBJECT_REFUSAL,
    });
    const code = await api.main(
      ["--job-dir", jobDir, "--family", first.family],
      {
        spawnEntry: spawner.spawnEntry,
        now: steppingClock(),
        log: sink(),
        stderr: sink(),
        repositoryRoot: root,
      },
    );
    assert.equal(
      code,
      4,
      "a subject refusal in a shipped entry makes the job exit 4",
    );
    assert.deepEqual(
      spawner.calls.map((c) => c.key),
      family.map((e) => `${e.family}/${e.id}`),
      "the job ran the whole family past the refusal",
    );
    assert.deepEqual(
      readJson(path.join(jobDir, "elapsed.json")).unexpectedExits.entries.map(
        (e) => `${e.family}/${e.id} ${e.exitCode}`,
      ),
      [`${first.family}/${first.id} 3`],
    );
  });
}

/** The census check is not vacuous: a plan entry that lists 3 (or 2) is caught. */
function shippedPlanCensusControl(api) {
  for (const code of [2, 3]) {
    const plan = loadShippedPlan(api);
    const last = plan.entries.at(-1);
    last.expectedExit = [...last.expectedExit, code];
    assert.deepEqual(entriesExpectingOtherThanPassOrFail(plan), [
      `${last.family}/${last.id} ${JSON.stringify(last.expectedExit)}`,
    ]);
  }
}

/**
 * The other routes by which a job could end having measured nothing, each
 * refused or non-zero through `main`: a selection filter the runner does not
 * have, a plan whose entries carry no command, a job directory that already
 * holds an earlier job's entry, a spawner that never starts a child or never
 * reports an exit, and a job directory that cannot be made. The control: a job
 * directory that exists but holds no entry of the plan runs every entry.
 */
async function emptyJobRoutesGroup(api) {
  await withLaneTmp("edge-job-routes-", async (root) => {
    const plan = threeEntryPlan();
    for (const flag of ["--only", "--id", "--entry", "--skip", "--exclude"]) {
      const run = await mainOver(api, root, `flag${flag}`, plan, [
        flag,
        "polar/one",
      ]);
      assert.equal(run.code, 2, `${flag}: not a filter the runner has`);
      assert.match(run.stderr, new RegExp(`unknown argument: ${flag}`));
      assert.deepEqual(run.spawner.calls, []);
      assert.equal(fs.existsSync(run.jobDir), false);
    }

    const noCommand = threeEntryPlan();
    for (const e of noCommand.entries) {
      e.probe = "";
    }
    let run = await mainOver(api, root, "no-command", noCommand);
    assert.equal(run.code, 2, "entries with no probe: exit 2");
    assert.match(run.stderr, /probe must be a top-level probe-\*\.mjs/);
    assert.deepEqual(run.spawner.calls, []);
    assert.equal(fs.existsSync(run.jobDir), false);

    fs.mkdirSync(path.join(root, "earlier", "polar", "one"), {
      recursive: true,
    });
    run = await mainOver(api, root, "earlier", plan);
    assert.equal(run.code, 2, "an earlier job's entry directory: exit 2");
    assert.match(run.stderr, /already exists/);
    assert.deepEqual(run.spawner.calls, []);
    assert.equal(fs.existsSync(path.join(run.jobDir, "elapsed.json")), false);

    fs.mkdirSync(path.join(root, "existing"));
    run = await mainOver(api, root, "existing", plan);
    assert.equal(run.code, 0, "an existing, empty job directory runs");
    assert.deepEqual(
      run.spawner.calls.map((c) => c.key),
      THREE_ORDER,
    );

    const every = (behaviour) =>
      Object.fromEntries(THREE_ORDER.map((key) => [key, behaviour]));
    for (const [label, behaviour] of [
      ["a spawner that throws", { throws: "no child was started" }],
      ["a child with no exit", { exitCode: null }],
      [
        "a spawn error beside an exit 0",
        { exitCode: 0, spawnError: { message: "spawn ENOENT" } },
      ],
      ["a timeout beside an exit 0", { exitCode: 0, timedOut: true }],
    ]) {
      run = await mainOver(
        api,
        root,
        `never-${label.replaceAll(" ", "-")}`,
        plan,
        [],
        every(behaviour),
      );
      assert.equal(run.code, 1, `${label}: the job stopped, exit 1`);
      assert.deepEqual(
        run.spawner.calls.map((c) => c.key),
        ["polar/one"],
        `${label}: stopped at the first entry`,
      );
      assert.equal(
        readJson(path.join(run.jobDir, "elapsed.json")).stoppedAt,
        "polar/one",
      );
    }

    // A job directory that is a file: main rejects, so the CLI exits non-zero.
    fs.writeFileSync(path.join(root, "a-file"), "x");
    await assert.rejects(() => mainOver(api, root, "a-file", plan));
  });
}

/** Thrown when this host cannot make a directory link. */
class LinkUnsupported extends Error {}

/**
 * The CLI runs `main` when node is given the runner through a link (a
 * junction on Windows, a symlink elsewhere): node loads the main module from
 * its real path, so a guard that compared the typed path with
 * `import.meta.url` would skip `main` and exit 0 having run nothing.
 */
async function scriptGuardGroup(api) {
  await withLaneTmp("edge-job-script-guard-", async (root) => {
    const url = pathToFileURL(RUNNER_PATH).href;
    assert.equal(api.isInvokedAsScript(RUNNER_PATH, url), true, "own path");
    assert.equal(
      api.isInvokedAsScript(fileURLToPath(import.meta.url), url),
      false,
      "another script",
    );
    assert.equal(api.isInvokedAsScript(undefined, url), false, "no script");
    assert.equal(
      api.isInvokedAsScript(RUNNER_PATH, "data:text/javascript,0"),
      false,
      "a module that is not a file",
    );
    const link = path.join(root, "linked-visual-regression");
    try {
      fs.symlinkSync(HERE, link, "junction");
    } catch (error) {
      throw new LinkUnsupported(String(error?.code ?? error));
    }
    try {
      const linked = path.join(link, "edge-job-runner.mjs");
      assert.equal(
        api.isInvokedAsScript(linked, url),
        true,
        "the runner's path through a link names the runner",
      );
      const child = spawnSync(process.execPath, [linked, "--bogus"], {
        encoding: "utf8",
        timeout: 60_000,
      });
      assert.equal(
        child.status,
        2,
        `run through a link the CLI still reaches main (stderr: ${child.stderr})`,
      );
      assert.match(child.stderr, /unknown argument: --bogus/);
    } finally {
      fs.unlinkSync(link);
    }
    assert.equal(fs.existsSync(RUNNER_PATH), true, "the link's target is kept");
  });
}

/** Run the script-guard group, skipping where the host cannot make a link. */
async function withLinks(t, run) {
  try {
    await run();
  } catch (error) {
    if (error instanceof LinkUnsupported) {
      t.skip(`no directory link on this host (${error.message})`);
      return;
    }
    throw error;
  }
}

test("e. a selection that resolves no entry is a usage error (exit 2, nothing spawned or made), with or without --dry-run", () =>
  emptySelectionGroup(realRunner));
test("e. a subject refusal the plan does not list makes the job exit 4 and does not stop it", () =>
  subjectRefusalExitGroup(realRunner));
test("e. every shipped entry expects 0 or 1, so a subject refusal in the shipped plan exits 4", () =>
  shippedPlanExpectedExitGroup(realRunner));
test("e. the shipped-plan census catches an entry that expects an error or a refusal", () =>
  shippedPlanCensusControl(realRunner));
test("e. every other route to a job that measured nothing is refused or non-zero", () =>
  emptyJobRoutesGroup(realRunner));
test("e. the CLI reaches main when the runner is given through a link", (t) =>
  withLinks(t, () => scriptGuardGroup(realRunner)));
test("e. the job says how many finished entries measured, and which", () =>
  measuredCountGroup(realRunner));

// ---------------------------------------------------------------------------
// Inertness mutants
// ---------------------------------------------------------------------------

/**
 * @param {string} label What the mutant does.
 * @param {Array<[string, string]>} replacements Anchors.
 * @param {Function} group The group to run over the mutated runner.
 */
function mutant(label, replacements, group) {
  test(`mutant: ${label} turns the group RED`, async () => {
    const api = await loadRunner(replacements);
    await assert.rejects(
      () => group(api),
      (error) =>
        !(
          error instanceof TypeError ||
          error instanceof ReferenceError ||
          error instanceof SyntaxError
        ),
      `${label}: the group still passed over the mutant`,
    );
  });
}

mutant(
  "an infrastructure class dropped from the runner (navigation-url-invalid)",
  [['  "navigation-url-invalid": "origin",\n', ""]],
  infrastructureIdsGroup,
);
mutant(
  "the job-directory-inside-the-checkout check inert",
  [
    [
      '  if (jobRelative.startsWith("..") || path.isAbsolute(jobRelative)) {',
      '  if (false && (jobRelative.startsWith("..") || path.isAbsolute(jobRelative))) {',
    ],
  ],
  outsideJobDirGroup,
);
mutant(
  "the stop on an infrastructure refusal inert",
  [
    [
      "    if (STOPPING_OUTCOMES.has(outcome)) {",
      "    if (false && STOPPING_OUTCOMES.has(outcome)) {",
    ],
  ],
  stopGroup,
);
mutant(
  "an infrastructure refusal id read as a subject refusal",
  [
    [
      "    return Object.hasOwn(INFRASTRUCTURE_REFUSAL_CLASSES, refusalId)",
      "    return false && Object.hasOwn(INFRASTRUCTURE_REFUSAL_CLASSES, refusalId)",
    ],
  ],
  stopGroup,
);
mutant(
  "a subject refusal stopping the job",
  [
    [
      "  if (child.exitCode === PROBE_EXIT_CODES.REFUSAL) {\n    if (refusalId === null) {",
      "  if (child.exitCode === PROBE_EXIT_CODES.REFUSAL) {\n    if (true) {",
    ],
  ],
  continueGroup,
);
mutant(
  "the stderr REFUSED (<id>) fallback inert",
  [
    [
      "  let refusalId = incident?.refusal?.reason ?? null;\n  if (refusalId === null) {",
      "  let refusalId = incident?.refusal?.reason ?? null;\n  if (false && refusalId === null) {",
    ],
  ],
  stderrRefusalGroup,
);
mutant(
  "the real spawner dropping the entry env",
  [
    [
      "          env: { ...process.env, ...command.env },",
      "          env: { ...process.env },",
    ],
  ],
  realSpawnerEnvGroup,
);
mutant(
  "the runner omitting --output",
  [['        "--output",\n        outputDirectory,\n', ""]],
  orderGroup,
);
mutant(
  "the runner dropping env",
  [["        env: entry.env,", "        env: {},"]],
  orderGroup,
);
mutant(
  "the runner dropping env (through main)",
  [["        env: entry.env,", "        env: {},"]],
  cliGroup,
);
mutant(
  "--dry-run launching anyway",
  [["  if (dryRun) {", "  if (false && dryRun) {"]],
  dryRunGroup,
);
mutant(
  "the refusal of --output in plan args inert",
  [
    [
      '    if (args.includes("--output")) {',
      '    if (false && args.includes("--output")) {',
    ],
  ],
  planGroup,
);
mutant(
  "the refusal of an env on port 8080 inert",
  [
    [
      "      } else if (/:8080(?:\\/|$)/.test(value)) {",
      "      } else if (false && /:8080(?:\\/|$)/.test(value)) {",
    ],
  ],
  planGroup,
);
mutant(
  "the receipt elapsed time left out of elapsed.json",
  [
    [
      "      receiptElapsedMs: receipts.receiptElapsedMs,\n    });",
      "      receiptElapsedMs: null,\n    });",
    ],
  ],
  recordsGroup,
);
mutant(
  "the red verdict ids left out of the receipts read",
  [
    [
      "    .filter((verdict) => verdict?.pass !== true)",
      "    .filter((verdict) => false && verdict?.pass !== true)",
    ],
  ],
  recordsGroup,
);
mutant(
  "the F3 detection inert",
  [
    [
      '    if (second.startsWith("{") && /\\btimeout\\b/.test(second)) {',
      '    if (false && second.startsWith("{") && /\\btimeout\\b/.test(second)) {',
    ],
  ],
  noteGroup,
);
mutant(
  "the F3 detection flagging an options object in any position",
  [
    [
      "    if (args === null || args.length !== 2) {",
      "    if (args === null || args.length < 2) {",
    ],
    [
      "    const second = args[1].trim();",
      "    const second = args[args.length - 1].trim();",
    ],
  ],
  noteGroup,
);
mutant(
  "the exit-4 clause unreachable (all-errored job)",
  [
    [
      "  return result.unexpectedExits.count > 0 ? 4 : 0;",
      "  return false && result.unexpectedExits.count > 0 ? 4 : 0;",
    ],
  ],
  allErroredGroup,
);
mutant(
  "the exit-4 clause unreachable (single errored entry)",
  [
    [
      "  return result.unexpectedExits.count > 0 ? 4 : 0;",
      "  return false && result.unexpectedExits.count > 0 ? 4 : 0;",
    ],
  ],
  singleErroredGroup,
);
mutant(
  "the exit-4 clause unreachable (an expected red that passes)",
  [
    [
      "  return result.unexpectedExits.count > 0 ? 4 : 0;",
      "  return false && result.unexpectedExits.count > 0 ? 4 : 0;",
    ],
  ],
  expectedExitsGroup,
);
mutant(
  "an entry's exit judged against exit 0 instead of its expectedExit",
  [
    [
      "      unexpectedExit: !entry.expectedExit.includes(child.exitCode),",
      "      unexpectedExit: child.exitCode !== 0,",
    ],
  ],
  expectedExitsGroup,
);
mutant(
  "the stop taking no precedence over exit 4",
  [["  if (result.stopped) {", "  if (false && result.stopped) {"]],
  stoppedAfterUnexpectedGroup,
);
mutant(
  "the unexpected-exits summary line not written",
  [
    [
      "  log.write(unexpectedExitsLine(rows.length, unexpectedExits));",
      "  void unexpectedExitsLine;",
    ],
  ],
  allErroredGroup,
);
mutant(
  "the unexpected exits left out of elapsed.json",
  [
    [
      "    elapsed.unexpectedExits = summarizeUnexpectedExits(rows);",
      "    elapsed.unexpectedExits = { count: 0, entries: [] };",
    ],
  ],
  singleErroredGroup,
);
mutant(
  "the sibling-of-the-checkout half (startsWith ..) of the job-directory check dropped",
  [
    [
      '  if (jobRelative.startsWith("..") || path.isAbsolute(jobRelative)) {',
      "  if (path.isAbsolute(jobRelative)) {",
    ],
  ],
  siblingJobDirGroup,
);
mutant(
  "the empty-selection check unreachable",
  [["  if (selected === 0) {", "  if (false && selected === 0) {"]],
  emptySelectionGroup,
);
const SUBJECT_REFUSAL_EXEMPTED = [
  [
    "      unexpectedExit: !entry.expectedExit.includes(child.exitCode),",
    "      unexpectedExit: !entry.expectedExit.includes(child.exitCode) && outcome !== ENTRY_OUTCOMES.SUBJECT_REFUSAL,",
  ],
];
mutant(
  "a subject refusal exempted from the expected-exit check",
  SUBJECT_REFUSAL_EXEMPTED,
  subjectRefusalExitGroup,
);
mutant(
  "a subject refusal exempted from the expected-exit check (shipped plan)",
  SUBJECT_REFUSAL_EXEMPTED,
  shippedPlanExpectedExitGroup,
);
mutant(
  "every finished entry counted as measured",
  [
    [
      "      (row) =>\n        (row.outcome === ENTRY_OUTCOMES.OK ||",
      "      (row) =>\n        true ||\n        (row.outcome === ENTRY_OUTCOMES.OK ||",
    ],
  ],
  measuredCountGroup,
);
mutant(
  "the receipt requirement of the measured check made always true",
  [
    [
      "        (row.reports.length > 0 || row.harnessArtifacts.length > 0),",
      "        (true || row.reports.length > 0 || row.harnessArtifacts.length > 0),",
    ],
  ],
  measuredCountGroup,
);
mutant(
  "the report-receipt half of the measured check unreachable",
  [
    [
      "        (row.reports.length > 0 || row.harnessArtifacts.length > 0),",
      "        ((false && row.reports.length > 0) || row.harnessArtifacts.length > 0),",
    ],
  ],
  measuredCountGroup,
);
mutant(
  "the c11 harness artifact half of the measured check unreachable",
  [
    [
      "        (row.reports.length > 0 || row.harnessArtifacts.length > 0),",
      "        (row.reports.length > 0 || (false && row.harnessArtifacts.length > 0)),",
    ],
  ],
  measuredCountGroup,
);
mutant(
  "the measured line left out of stdout",
  [
    [
      "  log.write(measuredLine(rows.length, elapsed.measured));",
      "  void measuredLine;",
    ],
  ],
  measuredCountGroup,
);
test("mutant: the script guard comparing typed paths turns the group RED", (t) =>
  withLinks(t, async () => {
    const api = await loadRunner([
      [
        "  return real(path.resolve(argv1)) === real(fileURLToPath(moduleUrl));",
        "  return path.resolve(argv1) === fileURLToPath(moduleUrl);",
      ],
    ]);
    await assert.rejects(
      () => scriptGuardGroup(api),
      (error) => {
        if (error instanceof LinkUnsupported) {
          throw error;
        }
        return error instanceof assert.AssertionError;
      },
      "the script-guard group still passed over the mutant",
    );
  }));
