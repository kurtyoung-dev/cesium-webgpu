// @purpose Behaviour coverage for Tools/lib/lane-tmp.mjs — the directory is created under the lane root, removed on success AND on throw AND on rejection, refused outside tmpdir, and an inert `finally` is caught by the mutant.
// @status ACTIVE
//
// The assertions below are written against observable behaviour — does the
// directory exist on disk after the call — not against the shape of the
// implementation, so they stay honest if the module is rewritten. The final
// test makes the cleanup UNREACHABLE (`if (false && …)`) in a copy of the
// module and requires the success/throw assertions to start failing; a spec
// that survives an inert `finally` is certifying its own fixture.

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_LANE_NAME,
  LANE_TMP_NAMESPACE,
  assertRemovableLanePath,
  isUnderTmpdir,
  laneTmpRoot,
  mkLaneTmp,
  removeLaneTmp,
  sweepLaneTmp,
  withLaneTmp,
} from "./lane-tmp.mjs";

const MODULE_PATH = path.join(import.meta.dirname, "lane-tmp.mjs");
const LANE = "lane-tmp-spec";

function cleanLane(laneName = LANE) {
  sweepLaneTmp(laneName);
}

test.after(() => {
  cleanLane();
  cleanLane("lane-tmp-spec-mutant");
  cleanLane("lane-tmp-spec-sweep");
});

// ---------------------------------------------------------------------------
// A. Roots and placement.
// ---------------------------------------------------------------------------

test("A1: laneTmpRoot is <tmpdir>/cesium-lane/<lane>", () => {
  assert.equal(
    laneTmpRoot(LANE),
    path.join(path.resolve(os.tmpdir()), LANE_TMP_NAMESPACE, LANE),
  );
});

test("A2: laneTmpRoot falls back to CESIUM_LANE, then to the default name", () => {
  const previous = process.env.CESIUM_LANE;
  try {
    process.env.CESIUM_LANE = "from-env";
    assert.equal(path.basename(laneTmpRoot()), "from-env");
    delete process.env.CESIUM_LANE;
    assert.equal(path.basename(laneTmpRoot()), DEFAULT_LANE_NAME);
  } finally {
    if (previous === undefined) {
      delete process.env.CESIUM_LANE;
    } else {
      process.env.CESIUM_LANE = previous;
    }
  }
});

test("A3: a lane name that is not one safe path segment is refused", () => {
  for (const bad of ["..", "a/b", "a\\b", "", ".hidden", "with space"]) {
    assert.throws(
      () => laneTmpRoot(bad),
      /invalid lane name/,
      `lane name ${JSON.stringify(bad)} should be refused`,
    );
  }
});

test("A4: mkLaneTmp creates a directory under the lane root, not at the Temp root", () => {
  const directory = mkLaneTmp("placement-", { laneName: LANE });
  try {
    assert.ok(fs.existsSync(directory), "directory was not created");
    assert.equal(path.dirname(directory), laneTmpRoot(LANE));
    assert.ok(
      path.basename(directory).startsWith("placement-"),
      `unexpected basename ${path.basename(directory)}`,
    );
    assert.notEqual(
      path.dirname(directory),
      path.resolve(os.tmpdir()),
      "the sandbox landed at the Temp root — the whole point is that it does not",
    );
  } finally {
    removeLaneTmp(directory);
  }
});

test("A5: a prefix containing a separator is refused", () => {
  for (const bad of ["../escape-", "a/b-", "a\\b-", ""]) {
    assert.throws(
      () => mkLaneTmp(bad, { laneName: LANE }),
      /invalid temp prefix/,
      `prefix ${JSON.stringify(bad)} should be refused`,
    );
  }
});

// ---------------------------------------------------------------------------
// B. Removal — the behaviour the leaking specs did not have.
// ---------------------------------------------------------------------------

test("B1: withLaneTmp removes the directory after the body returns", () => {
  let seen = null;
  const returned = withLaneTmp(
    "success-",
    (directory) => {
      seen = directory;
      fs.writeFileSync(path.join(directory, "fixture.txt"), "content");
      assert.ok(fs.existsSync(directory), "body ran without its directory");
      return 42;
    },
    { laneName: LANE },
  );
  assert.equal(returned, 42);
  assert.equal(fs.existsSync(seen), false, `${seen} survived a successful run`);
});

test("B2: withLaneTmp removes the directory when the body THROWS", () => {
  let seen = null;
  assert.throws(
    () =>
      withLaneTmp(
        "throwing-",
        (directory) => {
          seen = directory;
          fs.writeFileSync(path.join(directory, "fixture.txt"), "content");
          throw new Error("assertion failed inside the body");
        },
        { laneName: LANE },
      ),
    /assertion failed inside the body/,
  );
  assert.ok(seen, "the body never ran");
  assert.equal(fs.existsSync(seen), false, `${seen} survived a throwing run`);
});

test("B3: withLaneTmp removes the directory when an async body REJECTS", async () => {
  let seen = null;
  await assert.rejects(
    withLaneTmp(
      "rejecting-",
      async (directory) => {
        seen = directory;
        await Promise.resolve();
        fs.writeFileSync(path.join(directory, "fixture.txt"), "content");
        throw new Error("rejected inside the body");
      },
      { laneName: LANE },
    ),
    /rejected inside the body/,
  );
  assert.equal(fs.existsSync(seen), false, `${seen} survived a rejected run`);
});

test("B4: withLaneTmp awaits an async body before removing the directory", async () => {
  let observedInside = false;
  const seen = await withLaneTmp(
    "async-success-",
    async (directory) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      observedInside = fs.existsSync(directory);
      return directory;
    },
    { laneName: LANE },
  );
  assert.equal(observedInside, true, "the directory vanished mid-body");
  assert.equal(fs.existsSync(seen), false, `${seen} survived an async run`);
});

test("B5: a non-empty tree is removed, not just an empty directory", () => {
  let seen = null;
  withLaneTmp(
    "deep-",
    (directory) => {
      seen = directory;
      fs.mkdirSync(path.join(directory, "a", "b", "c"), { recursive: true });
      fs.writeFileSync(path.join(directory, "a", "b", "c", "leaf.bin"), "x");
    },
    { laneName: LANE },
  );
  assert.equal(fs.existsSync(seen), false, `${seen} survived with content`);
});

// ---------------------------------------------------------------------------
// C. Safety — nothing outside the lane namespace is ever removable.
// ---------------------------------------------------------------------------

test("C1: isUnderTmpdir accepts children of tmpdir and rejects the root itself", () => {
  const root = path.resolve(os.tmpdir());
  assert.equal(isUnderTmpdir(path.join(root, "child")), true);
  assert.equal(isUnderTmpdir(root), false);
  assert.equal(isUnderTmpdir(path.join(root, "..")), false);
});

test("C2: removeLaneTmp refuses a path outside tmpdir", () => {
  assert.throws(
    () => removeLaneTmp(path.join(process.cwd(), "packages")),
    /outside the system temp directory/,
  );
});

test("C3: removeLaneTmp refuses a path inside tmpdir but outside the lane namespace", () => {
  const outside = path.join(path.resolve(os.tmpdir()), "not-a-lane-dir");
  assert.throws(
    () => removeLaneTmp(outside),
    /outside the lane namespace/,
    "anything under the Temp root that this module did not create must be refused",
  );
});

test("C4: the tmpdir root and the namespace root are both unremovable", () => {
  assert.throws(
    () => assertRemovableLanePath(os.tmpdir()),
    /outside the system temp directory/,
  );
  assert.throws(
    () =>
      assertRemovableLanePath(
        path.join(path.resolve(os.tmpdir()), LANE_TMP_NAMESPACE),
      ),
    /outside the lane namespace/,
  );
});

test("C5: a junction inside a lane directory is unlinked, never followed", (t) => {
  const sibling = mkLaneTmp("junction-target-", { laneName: LANE });
  const host = mkLaneTmp("junction-host-", { laneName: LANE });
  const keeper = path.join(sibling, "must-survive.txt");
  fs.writeFileSync(keeper, "evidence");
  try {
    try {
      fs.symlinkSync(sibling, path.join(host, "link"), "junction");
    } catch (error) {
      t.skip(`this platform/account cannot create junctions: ${error.message}`);
      return;
    }
    removeLaneTmp(host);
    assert.equal(fs.existsSync(host), false, "the host directory survived");
    assert.equal(
      fs.readFileSync(keeper, "utf8"),
      "evidence",
      "the removal followed the junction and deleted the linked tree",
    );
  } finally {
    removeLaneTmp(sibling);
    removeLaneTmp(host);
  }
});

// ---------------------------------------------------------------------------
// D. sweepLaneTmp — the backstop for what a killed run left behind.
// ---------------------------------------------------------------------------

test("D1: sweepLaneTmp with no age gate removes the whole lane root", () => {
  const lane = "lane-tmp-spec-sweep";
  const directory = mkLaneTmp("orphan-", { laneName: lane });
  assert.ok(fs.existsSync(directory));
  const summary = sweepLaneTmp(lane);
  assert.equal(summary.removedRoot, true);
  assert.equal(fs.existsSync(laneTmpRoot(lane)), false);
});

test("D2: sweepLaneTmp with an age gate keeps young entries and removes old ones", () => {
  const lane = "lane-tmp-spec-sweep";
  const young = mkLaneTmp("young-", { laneName: lane });
  const old = mkLaneTmp("old-", { laneName: lane });
  const hour = 3600_000;
  const past = new Date(Date.now() - 4 * hour);
  fs.utimesSync(old, past, past);
  try {
    const summary = sweepLaneTmp(lane, { olderThanMs: 2 * hour });
    assert.deepEqual(summary.removed, [old]);
    assert.deepEqual(summary.kept, [young]);
    assert.equal(summary.removedRoot, false);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(young), true);
  } finally {
    sweepLaneTmp(lane);
  }
});

test("D3: sweepLaneTmp on a lane that never ran is a no-op", () => {
  const summary = sweepLaneTmp("lane-tmp-spec-never-used");
  assert.deepEqual(summary.removed, []);
  assert.equal(summary.removedRoot, false);
});

// `Tools/generate-tooling-catalog-launcher.cjs` is the one caller that cannot
// adopt this module: it is a built-ins-only CommonJS trust boundary
// (`:6-10`) that cannot `require` ESM, and `bindLauncher` (`:205-214`) compares
// its own worktree bytes to the blob in the git INDEX, so an uncommitted edit to
// it is STRUCTURAL and unverifiable inside a lane. It keeps its Temp-root
// `mkdtempSync` and is carried as item 4 of `DX-71`. If a later batch does give
// it an inline copy of the lane root, pin the copy against
// `LANE_TMP_NAMESPACE` / `DEFAULT_LANE_NAME` / `CESIUM_LANE` here.

// ---------------------------------------------------------------------------
// E. Inertness mutant.
// ---------------------------------------------------------------------------

test("E1: INERTNESS MUTANT — with the finally-cleanup unreachable, B1 and B2 stop failing", async () => {
  // Host the mutant copy in a real lane directory so the mutant test does not
  // itself leave a sandbox at the Temp root.
  const host = mkLaneTmp("mutant-host-", { laneName: "lane-tmp-spec-mutant" });
  try {
    // EOL-tolerant: the anchor below spans a newline, and a CRLF checkout would
    // otherwise match it zero times (see the `.gitattributes` block that pins
    // this module to LF — that is the fix, this is its belt).
    const source = fs
      .readFileSync(MODULE_PATH, "utf8")
      .split("\r\n")
      .join("\n");
    const marker = `    if (!ownershipPassedToPromise) {
      removeLaneTmp(directory);
    }`;
    assert.ok(
      source.includes(marker),
      "the mutant needs withLaneTmp's finally body to still read as written",
    );
    const mutated = source.replace(
      marker,
      `    if (false && !ownershipPassedToPromise) {
      removeLaneTmp(directory);
    }`,
    );
    assert.notEqual(mutated, source, "the mutation changed nothing");
    const file = path.join(host, "lane-tmp-mutant.mjs");
    fs.writeFileSync(file, mutated);
    const inert = await import(pathToFileURL(file).href);

    // Sanity: the mutant really is inert on the success path.
    let leakedOnSuccess = null;
    inert.withLaneTmp(
      "mutant-success-",
      (directory) => {
        leakedOnSuccess = directory;
      },
      { laneName: "lane-tmp-spec-mutant" },
    );
    assert.equal(
      fs.existsSync(leakedOnSuccess),
      true,
      "the mutant still cleaned up — the mutation did not reach the cleanup",
    );

    // The point of the mutant: B1's and B2's assertions must now fail.
    assert.throws(
      () => assert.equal(fs.existsSync(leakedOnSuccess), false),
      "B1 survived an inert finally — the spec is not testing the cleanup",
    );

    let leakedOnThrow = null;
    assert.throws(() =>
      inert.withLaneTmp(
        "mutant-throw-",
        (directory) => {
          leakedOnThrow = directory;
          throw new Error("boom");
        },
        { laneName: "lane-tmp-spec-mutant" },
      ),
    );
    assert.throws(
      () => assert.equal(fs.existsSync(leakedOnThrow), false),
      "B2 survived an inert finally — the spec is not testing the cleanup",
    );
  } finally {
    sweepLaneTmp("lane-tmp-spec-mutant");
  }
});
