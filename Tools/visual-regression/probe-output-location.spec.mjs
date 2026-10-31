// probe-output-location.spec.mjs — a probe's output never depends on the working directory.
// @purpose Pins that the probe runtime resolves its repository root and default output from the kit's own location, resolves a relative --output against that root, refuses an output outside it unless a repository root is named, and that a runProbe started from a foreign cwd writes nothing there; an inertness mutant restores the cwd default and must turn the runtime check red.
// @status ACTIVE
//
// DX-KIT-OUTPUT-NOT-CWD. The runtime used to default to `process.cwd()`, so a
// probe or a probe spec started with another checkout as its working directory
// wrote into that checkout. Every test below changes the working directory to a
// fresh lane temp directory and asserts on what is (not) on disk afterwards.
// No browser is opened: `launch` is a fake, and the served-build preflight is
// waived with --no-serve-built.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { mkLaneTmp, removeLaneTmp, sweepLaneTmp } from "../lib/lane-tmp.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import {
  KIT_REPOSITORY_ROOT,
  resolveProbeLocations,
} from "./lib/probe-output-location.mjs";
import { runProbe } from "./lib/probe-runtime.mjs";

const LANE = "probe-output-location-spec";
const here = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(here, "lib", "probe-runtime.mjs");

test.after(() => sweepLaneTmp(LANE));

/** Run `fn` with a fresh foreign directory as cwd; always restore and remove it. */
async function inForeignCwd(fn) {
  const foreign = mkLaneTmp("foreign-cwd-", { laneName: LANE });
  const previous = process.cwd();
  process.chdir(foreign);
  try {
    return await fn(foreign);
  } finally {
    process.chdir(previous);
    removeLaneTmp(foreign);
  }
}

function fakeDescriptor() {
  return {
    name: "output-location-probe",
    cells: async ({ run }) => [{ run }],
    receipt: (cells) => ({ cells }),
    verdicts: () => [{ id: "v", pass: true }],
  };
}

/**
 * runProbe from a foreign cwd with an absolute --output inside that cwd and no
 * --repository-root. Returns the exit code, the launches and what landed.
 */
async function runFromForeignCwd(run) {
  return inForeignCwd(async (foreign) => {
    const launches = [];
    const code = await run(fakeDescriptor(), {
      argv: ["--output", path.join(foreign, "out"), "--no-serve-built"],
      launch: async () => {
        launches.push(1);
        return { close: async () => {} };
      },
    });
    return { code, launches: launches.length, landed: fs.readdirSync(foreign) };
  });
}

function assertNothingLanded(result) {
  assert.deepEqual(result.landed, [], "the probe wrote into the foreign cwd");
  assert.equal(result.launches, 0, "a browser was launched before the refusal");
  assert.notEqual(
    result.code,
    0,
    "an output outside the kit root must not exit 0",
  );
}

test("the kit root is the checkout holding the kit, whatever the cwd", async () => {
  assert.ok(fs.existsSync(path.join(KIT_REPOSITORY_ROOT, "package.json")));
  assert.ok(
    fs.existsSync(
      path.join(
        KIT_REPOSITORY_ROOT,
        "Tools/visual-regression/lib/probe-runtime.mjs",
      ),
    ),
  );
  await inForeignCwd((foreign) => {
    const { repositoryRoot, outputDirectory } = resolveProbeLocations({
      outputSubdirectory: "some-probe",
    });
    assert.equal(repositoryRoot, KIT_REPOSITORY_ROOT);
    assert.equal(
      outputDirectory,
      path.join(
        KIT_REPOSITORY_ROOT,
        "Tools/visual-regression/output/some-probe",
      ),
    );
    assert.ok(!outputDirectory.startsWith(foreign));
  });
});

test("a relative --output resolves against the kit root, not the cwd", async () => {
  await inForeignCwd(() => {
    const { outputDirectory } = resolveProbeLocations({
      outputDirectory: "Tools/visual-regression/output/rel",
      outputSubdirectory: "unused",
    });
    assert.equal(
      outputDirectory,
      path.join(KIT_REPOSITORY_ROOT, "Tools/visual-regression/output/rel"),
    );
  });
});

test("an output outside the kit root is refused unless a repository root is named", async () => {
  await inForeignCwd((foreign) => {
    const outside = path.join(foreign, "out");
    assert.throws(
      () =>
        resolveProbeLocations({
          outputDirectory: outside,
          outputSubdirectory: "x",
        }),
      /outside the kit's repository root.*--repository-root/s,
    );
    for (const named of [
      { repositoryRoot: foreign },
      { repositoryRootOverride: foreign },
    ]) {
      const located = resolveProbeLocations({
        ...named,
        outputDirectory: outside,
        outputSubdirectory: "x",
      });
      assert.equal(located.repositoryRoot, foreign);
      assert.equal(located.outputDirectory, outside);
    }
  });
});

test("runProbe from a foreign cwd writes nothing there and opens no browser", async () => {
  assertNothingLanded(await runFromForeignCwd(runProbe));
});

test("INERTNESS MUTANT — with the cwd default restored, the runtime check goes red", async () => {
  const mutant = await importMutated(RUNTIME, [
    [
      "      repositoryRootOverride,\n      outputDirectory: options.outputDirectory,",
      "      repositoryRootOverride,\n      kitRepositoryRoot: process.cwd(),\n      outputDirectory: options.outputDirectory,",
    ],
  ]);
  const result = await runFromForeignCwd(mutant.runProbe);
  assert.throws(
    () => assertNothingLanded(result),
    "the runtime check survived the cwd default — it is not testing the resolution",
  );
  assert.ok(
    result.landed.includes("out"),
    "sanity: the mutant wrote its receipts into the foreign cwd",
  );
});
