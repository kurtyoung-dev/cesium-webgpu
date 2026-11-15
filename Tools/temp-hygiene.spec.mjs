// @purpose Behaviour coverage for Tools/temp-hygiene.mjs — classification age gates, the plan-only default, the execute-time protect/horizon/evidence refusals, the guarantee that a junction inside a delete target is never followed, no guessed running session, tracked-image copies not counted as evidence, and finished lanes named for the sweep.
// @status ACTIVE
//
// DESTRUCTIVE TESTS LIVE UNDER os.tmpdir() AND NOWHERE ELSE (maintainer,
// 2026-08-31). Every fixture here is a fake Temp root allocated by
// `Tools/lib/lane-tmp.mjs`, which asserts containment structurally, and each
// test re-asserts it before letting `executePlan` remove anything.
//
// The assertions are written against what ends up on disk, not against the
// classifier's internals. Group F makes the link-unlinking step unreachable in
// a copy of the module and requires the junction test to start failing — a
// removal that follows a junction is the one failure mode here that destroys
// data outside the plan.

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { mkLaneTmp, removeLaneTmp, sweepLaneTmp } from "./lib/lane-tmp.mjs";
import {
  executePlan,
  findEvidenceDirs,
  gitBlobId,
  hasLiveLock,
  isProtected,
  NEVER_FINISHED_LANES,
  planTempRoot,
  protectPaths,
  trackedImageBlobIds,
} from "./temp-hygiene.mjs";

const LANE = "temp-hygiene-spec";
const MODULE_PATH = path.join(import.meta.dirname, "temp-hygiene.mjs");
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = MODULE_PATH;
const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-09-11T18:00:00.000Z");

test.after(() => sweepLaneTmp(LANE));

/**
 * Allocate a fake Temp root and prove, in the test itself, that it is inside
 * the real one before anything destructive runs against it.
 */
function fakeTemp() {
  const root = mkLaneTmp("fake-temp-", { laneName: LANE });
  assert.ok(
    path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep),
    `the fixture escaped os.tmpdir(): ${root}`,
  );
  return root;
}

function age(target, days) {
  const when = new Date(NOW - days * DAY_MS);
  fs.utimesSync(target, when, when);
}

/**
 * Age a whole tree, deepest first. The tool reads the NEWEST mtime anywhere
 * under an entry, so ageing only the top directory leaves the entry looking
 * brand new — and creating anything inside it (a junction, a nested file)
 * re-stamps the parent. Every fixture ages last.
 */
function ageTree(target, days) {
  const stats = fs.lstatSync(target);
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    for (const entry of fs.readdirSync(target)) {
      ageTree(path.join(target, entry), days);
    }
  }
  age(target, days);
}

function makeDir(root, name, days, { file = null } = {}) {
  const target = path.join(root, name);
  fs.mkdirSync(target, { recursive: true });
  if (file !== null) {
    const filePath = path.join(target, file);
    fs.writeFileSync(filePath, "x");
    age(filePath, days);
  }
  age(target, days);
  return target;
}

function makeFile(root, name, days) {
  const target = path.join(root, name);
  fs.writeFileSync(target, "x");
  age(target, days);
  return target;
}

function rowFor(plan, target) {
  for (const list of ["delete", "keep", "residue"]) {
    const row = plan[list].find((entry) => entry.path === target);
    if (row !== undefined) return { list, ...row };
  }
  return null;
}

// ---------------------------------------------------------------------------
// A. Classification.
// ---------------------------------------------------------------------------

test("A1: age gates and name classes put every fixture in the right list", () => {
  const root = fakeTemp();
  try {
    const staleKarma = makeDir(root, "karma-98123", 5, { file: "profile" });
    const freshKarma = makeDir(root, "karma-fresh", 0, { file: "profile" });
    const sandbox = makeDir(root, "turin-stall-locus-Ab3xYz", 5, { file: "f" });
    const foreign = makeDir(root, ".tmpAb3xYz", 5);
    const unknownYoung = makeDir(root, "important-project", 5, {
      file: "notes",
    });
    const ancient = makeDir(root, "ancient-thing", 40, { file: "notes" });
    const emptyOld = makeDir(root, "empty-old", 5);
    const bundle = makeFile(root, "served_8080.js", 5);
    const staleLoose = makeFile(root, "notes.weirdext", 5);
    const youngLoose = makeFile(root, "recent.weirdext", 2);
    const protectedDir = makeDir(root, "node-compile-cache", 40, { file: "c" });

    const plan = planTempRoot({ temp: root, now: NOW });

    assert.equal(rowFor(plan, staleKarma).list, "delete");
    assert.equal(rowFor(plan, staleKarma).category, "karma");
    assert.equal(rowFor(plan, freshKarma).list, "keep");
    assert.equal(rowFor(plan, sandbox).category, "mkdtemp-sandbox");
    assert.equal(rowFor(plan, sandbox).list, "delete");
    assert.equal(rowFor(plan, foreign).category, "foreign-tempfile-crate");
    assert.equal(rowFor(plan, unknownYoung).list, "residue");
    assert.equal(rowFor(plan, ancient).list, "delete");
    assert.equal(rowFor(plan, ancient).category, "stale-dir");
    assert.equal(rowFor(plan, emptyOld).category, "empty-dir");
    assert.equal(rowFor(plan, bundle).category, "bundle-copy-or-script");
    assert.equal(rowFor(plan, staleLoose).category, "stale-file");
    assert.equal(rowFor(plan, youngLoose).list, "residue");
    assert.equal(rowFor(plan, protectedDir).list, "keep");
    assert.equal(rowFor(plan, protectedDir).category, "protected");
  } finally {
    removeLaneTmp(root);
  }
});

test("A2: a lane root is swept whole once it is a day old, and left alone while it is young", () => {
  const root = fakeTemp();
  try {
    const lanes = path.join(root, "cesium-lane");
    fs.mkdirSync(lanes);
    const finished = makeDir(lanes, "gimli", 5, { file: "scratch" });
    const running = makeDir(lanes, "legolas", 0, { file: "scratch" });
    age(lanes, 0);

    const plan = planTempRoot({ temp: root, now: NOW });
    assert.equal(rowFor(plan, finished).list, "delete");
    assert.equal(rowFor(plan, finished).category, "lane-root");
    assert.equal(rowFor(plan, running).list, "keep");
    // The namespace directory itself is never a target.
    assert.equal(rowFor(plan, lanes), null);
  } finally {
    removeLaneTmp(root);
  }
});

test("A3: the running Claude session is never descended into; other sessions go only if empty", () => {
  const root = fakeTemp();
  const previous = process.env.CLAUDE_SESSION_ID;
  try {
    const project = path.join(root, "claude", "some-project");
    fs.mkdirSync(project, { recursive: true });
    const running = makeDir(project, "session-running", 0, {
      file: "transcript",
    });
    const emptyOther = makeDir(project, "session-empty", 9);
    const busyOther = makeDir(project, "session-busy", 9, {
      file: "transcript",
    });
    process.env.CLAUDE_SESSION_ID = "session-running";

    const plan = planTempRoot({ temp: root, now: NOW });
    assert.equal(rowFor(plan, running).list, "keep");
    assert.equal(rowFor(plan, running).category, "running-session");
    assert.equal(rowFor(plan, emptyOther).list, "delete");
    assert.equal(rowFor(plan, emptyOther).category, "empty-session");
    assert.equal(rowFor(plan, busyOther).list, "keep");
    assert.equal(rowFor(plan, busyOther).category, "other-session");
    // Nothing inside the running session may appear anywhere in the plan.
    const inside = [...plan.delete, ...plan.residue].filter((row) =>
      row.path.startsWith(running + path.sep),
    );
    assert.deepEqual(inside, []);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = previous;
    removeLaneTmp(root);
  }
});

// ---------------------------------------------------------------------------
// B. Plan-only default.
// ---------------------------------------------------------------------------

test("B1: the CLI default writes a plan and deletes nothing", () => {
  const root = fakeTemp();
  try {
    const doomed = makeDir(root, "karma-98123", 5, { file: "profile" });
    const out = path.join(root, "..", "plan-b1.json");
    const run = spawnSync(
      process.execPath,
      [SCRIPT, "--plan", "--temp", root, "--out", out],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.ok(fs.existsSync(out), "no plan file was written");
    assert.equal(
      fs.existsSync(doomed),
      true,
      "the default mode deleted something — it must be read-only",
    );
    const plan = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.ok(plan.delete.some((row) => row.path === doomed));
    fs.rmSync(out, { force: true });
  } finally {
    removeLaneTmp(root);
  }
});

// ---------------------------------------------------------------------------
// C. Execute-time refusals. Every one of these is re-checked against the plan.
// ---------------------------------------------------------------------------

test("C0: every protect entry covers its whole subtree, including a drive root", () => {
  // A protect entry that matches only its own literal string protects nothing.
  // `path.resolve("F:\\")` keeps the trailing separator, so a naive
  // `root + path.sep` builds `f:\\` and every real path under F: walks straight
  // past the guard — the silently-empty keep rule the positive-list memory names.
  const protects = protectPaths(path.resolve(os.tmpdir()));
  for (const entry of protects) {
    assert.equal(
      isProtected(entry, protects),
      true,
      `${entry} does not protect itself`,
    );
    assert.equal(
      isProtected(path.join(entry, "child", "grandchild"), protects),
      true,
      `${entry} does not protect its own subtree`,
    );
  }
  const driveRoot = protects.find((entry) => /^[A-Za-z]:\\$/.test(entry));
  assert.ok(driveRoot, "the repo-drive protect entry is gone");
  assert.equal(
    isProtected(path.join(driveRoot, "Dev", "GH", "cesium-webgpu"), protects),
    true,
    "the repo drive is in the protect set but does not protect the repo",
  );
  assert.equal(
    isProtected(path.join(path.resolve(os.tmpdir()), "karma-1"), protects),
    false,
    "the protect set swallowed an ordinary sweep target",
  );
});

test("C1: a protected path inside the delete list is skipped, not removed", () => {
  const root = fakeTemp();
  try {
    const guarded = makeDir(root, "node-compile-cache", 40, { file: "c" });
    const ordinary = makeDir(root, "karma-98123", 5, { file: "profile" });
    assert.ok(isProtected(guarded, protectPaths(root)));

    // A hand-forged plan: the protect check must hold even when the list is wrong.
    const plan = {
      generatedAt: new Date(NOW).toISOString(),
      generatedAtMs: NOW,
      temp: root,
      delete: [
        { path: guarded, bytes: 1, files: 1 },
        { path: ordinary, bytes: 1, files: 1 },
      ],
      evidence: { dirs: [], receipt: null },
    };
    const report = executePlan(plan);
    assert.equal(fs.existsSync(guarded), true, "a protected path was deleted");
    assert.equal(
      fs.existsSync(ordinary),
      false,
      "the ordinary target survived",
    );
    assert.ok(report.skipped.some((line) => line.startsWith("PROTECTED")));
    assert.equal(report.deleted, 1);
  } finally {
    removeLaneTmp(root);
  }
});

test("C2: a path outside the plan's temp root is skipped", () => {
  const root = fakeTemp();
  const outside = fakeTemp();
  try {
    const witness = makeFile(outside, "must-survive.txt", 5);
    const plan = {
      generatedAt: new Date(NOW).toISOString(),
      generatedAtMs: NOW,
      temp: root,
      delete: [{ path: witness, bytes: 1, files: 1 }],
      evidence: { dirs: [], receipt: null },
    };
    const report = executePlan(plan);
    assert.equal(fs.existsSync(witness), true);
    assert.ok(report.skipped.some((line) => line.startsWith("OUTSIDE TEMP")));
  } finally {
    removeLaneTmp(root);
    removeLaneTmp(outside);
  }
});

test("C3: a target that changed after the plan was written is skipped", () => {
  const root = fakeTemp();
  try {
    const target = makeDir(root, "karma-98123", 5, { file: "profile" });
    const plan = {
      generatedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
      generatedAtMs: NOW - 10 * DAY_MS,
      temp: root,
      delete: [{ path: target, bytes: 1, files: 1 }],
      evidence: { dirs: [], receipt: null },
    };
    const report = executePlan(plan);
    assert.equal(
      fs.existsSync(target),
      true,
      "a path younger than the plan was deleted",
    );
    assert.ok(
      report.skipped.some((line) => line.startsWith("CHANGED SINCE THE PLAN")),
    );
  } finally {
    removeLaneTmp(root);
  }
});

test("C3b: a plan whose own temp root is not the system temp directory is refused", () => {
  // The only containment `--execute` has on a target is `plan.temp`, and the
  // plan supplies that value to itself. Without this refusal, `--plan --temp
  // <any directory>` followed by `--execute` is a delete path outside Temp.
  const outside = path.resolve(process.cwd());
  const report = executePlan({
    generatedAt: new Date(NOW).toISOString(),
    generatedAtMs: NOW,
    temp: outside,
    delete: [{ path: path.join(outside, "package.json"), bytes: 1, files: 1 }],
    evidence: { dirs: [], receipt: null },
  });
  assert.match(report.refused ?? "", /not the system temp directory/);
  assert.equal(report.deleted, 0);
  assert.equal(
    fs.existsSync(path.join(outside, "package.json")),
    true,
    "the repo's own package.json was inside a refused plan and must be untouched",
  );

  // ...and the real Temp ROOT, which is what this tool exists to sweep, is not
  // refused by that guard. An empty delete list keeps the check harmless.
  const atRoot = executePlan({
    generatedAt: new Date(NOW).toISOString(),
    generatedAtMs: NOW,
    temp: path.resolve(os.tmpdir()),
    delete: [],
    evidence: { dirs: [], receipt: null },
  });
  assert.equal(atRoot.refused, null, atRoot.refused ?? "");
});

test("C3b2: a root whose path STRING is prefix-adjacent to tmpdir is still refused", () => {
  // C3b's non-temp root shares no prefix with tmpdir, so it cannot tell a
  // correct containment check from one that forgot the separator — the same
  // class of defect as the protect-set bug. This one can: `<t>-adjacent` starts
  // with `<t>` as a string and is not inside it. Everything stays under the real
  // temp directory by repointing TEMP/TMP at a fixture that is itself a child.
  const base = mkLaneTmp("adjacency-", { laneName: LANE });
  const inner = path.join(base, "t");
  const adjacent = `${inner}-adjacent`;
  fs.mkdirSync(inner);
  fs.mkdirSync(adjacent);
  const previous = {
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
  };
  const planFor = (temp) => ({
    generatedAt: new Date(NOW).toISOString(),
    generatedAtMs: NOW,
    temp,
    delete: [],
    evidence: { dirs: [], receipt: null },
  });
  try {
    process.env.TEMP = inner;
    process.env.TMP = inner;
    process.env.TMPDIR = inner;
    assert.equal(
      path.resolve(os.tmpdir()),
      inner,
      "the fixture failed to repoint os.tmpdir(); the rest of this test proves nothing",
    );
    assert.ok(
      path.resolve(adjacent).startsWith(path.resolve(inner)),
      "the sibling must share the temp root's path string for this to discriminate",
    );
    assert.match(
      executePlan(planFor(adjacent)).refused ?? "",
      /not the system temp directory/,
      "a prefix-adjacent sibling of tmpdir was accepted as the temp root",
    );
    // Control: the repointed root itself is still admitted.
    assert.equal(executePlan(planFor(inner)).refused, null);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    removeLaneTmp(base);
  }
});

test("C3c: a plan with no usable timestamp is refused rather than losing the age guard", () => {
  const root = fakeTemp();
  try {
    const target = makeDir(root, "karma-98123", 5, { file: "profile" });
    const report = executePlan({
      temp: root,
      delete: [{ path: target, bytes: 1, files: 1 }],
      evidence: { dirs: [], receipt: null },
    });
    assert.match(report.refused ?? "", /no usable generatedAt horizon/);
    assert.equal(report.deleted, 0);
    assert.equal(fs.existsSync(target), true);
  } finally {
    removeLaneTmp(root);
  }
});

test("C3d: a target at or under the plan's running session is skipped at execute time", () => {
  const root = fakeTemp();
  try {
    const session = makeDir(root, "session-running", 5, { file: "transcript" });
    const inside = makeDir(session, "scratch", 5, { file: "note" });
    const report = executePlan({
      generatedAt: new Date(NOW).toISOString(),
      generatedAtMs: NOW,
      temp: root,
      runningSession: session,
      delete: [
        { path: session, bytes: 1, files: 1 },
        { path: inside, bytes: 1, files: 1 },
      ],
      evidence: { dirs: [], receipt: null },
    });
    assert.equal(
      fs.existsSync(session),
      true,
      "the running session was deleted",
    );
    assert.equal(fs.existsSync(inside), true, "a path inside it was deleted");
    assert.equal(
      report.skipped.filter((line) => line.startsWith("RUNNING SESSION"))
        .length,
      2,
    );
    assert.equal(report.deleted, 0);
  } finally {
    removeLaneTmp(root);
  }
});

test("C3e: a target something still holds open is skipped, and a read-only one is not", () => {
  const root = fakeTemp();
  try {
    const held = makeDir(root, "karma-held", 5, { file: "LOCK" });
    const readOnly = makeDir(root, "karma-readonly", 5, { file: "LOCK" });
    const readOnlyLock = path.join(readOnly, "LOCK");
    fs.chmodSync(readOnlyLock, 0o444);
    ageTree(held, 5);
    ageTree(readOnly, 5);

    // The busy branch cannot be reached from one process without a second one
    // holding the handle, so the write-open probe is injected. Everything else —
    // the lock-file discovery, the read-only rule, the skip — is the real code.
    const busyWith = (code) => () => {
      const error = new Error(`held (${code})`);
      error.code = code;
      throw error;
    };
    const busy = busyWith("EBUSY");
    // All three codes, not just EBUSY: a live mapped image on Windows throws
    // EPERM, which is the case the EBUSY-only first draft of this rule missed.
    // Pinning one code lets a later "simplification" put that gap straight back.
    for (const code of ["EBUSY", "EPERM", "EACCES"]) {
      assert.equal(
        hasLiveLock(held, busyWith(code)),
        true,
        `a LOCK file whose open fails with ${code} must read as held`,
      );
      assert.equal(
        hasLiveLock(readOnly, busyWith(code)),
        false,
        `a read-only LOCK file must stay a permission bit under ${code}`,
      );
    }
    assert.equal(
      hasLiveLock(held),
      false,
      "nothing actually holds the fixture",
    );

    const plan = (target) => ({
      generatedAt: new Date(NOW).toISOString(),
      generatedAtMs: NOW,
      temp: root,
      delete: [{ path: target, bytes: 1, files: 1 }],
      evidence: { dirs: [], receipt: null },
    });
    const blocked = executePlan(plan(held), { open: busy });
    assert.equal(fs.existsSync(held), true, "a locked target was deleted");
    assert.ok(blocked.skipped.some((line) => line.startsWith("LOCKED")));
    assert.equal(blocked.deleted, 0);

    const allowed = executePlan(plan(readOnly), { open: busy });
    assert.equal(
      fs.existsSync(readOnly),
      false,
      "a read-only tree was treated as locked and became unsweepable",
    );
    assert.equal(allowed.deleted, 1);
  } finally {
    try {
      fs.chmodSync(path.join(root, "karma-readonly", "LOCK"), 0o666);
    } catch {
      /* already gone */
    }
    removeLaneTmp(root);
  }
});

test("C4: unbanked visual evidence inside the delete set refuses the whole execute", () => {
  const root = fakeTemp();
  try {
    const captures = path.join(
      root,
      "vr-run-Ab3xYz",
      "visual-regression",
      "output",
    );
    fs.mkdirSync(captures, { recursive: true });
    fs.writeFileSync(path.join(captures, "diff.png"), "not really a png");
    const target = path.join(root, "vr-run-Ab3xYz");
    ageTree(target, 5);

    const plan = planTempRoot({ temp: root, now: NOW });
    assert.deepEqual(findEvidenceDirs(plan), [captures]);
    assert.equal(plan.evidence.dirs.length, 1);

    const report = executePlan(plan);
    assert.match(report.refused ?? "", /not banked/);
    assert.equal(report.deleted, 0);
    assert.equal(fs.existsSync(path.join(captures, "diff.png")), true);

    // With a verified receipt the same plan proceeds.
    plan.evidence.receipt = { verified: true, pngInZip: 1, pngOnDisk: 1 };
    const second = executePlan(plan);
    assert.equal(second.refused, null);
    assert.equal(fs.existsSync(target), false);
  } finally {
    removeLaneTmp(root);
  }
});

// ---------------------------------------------------------------------------
// D. The junction guarantee.
// ---------------------------------------------------------------------------

function junctionFixture(root) {
  const victim = makeDir(root, "karma-victim", 5, { file: "profile" });
  const sibling = makeDir(root, "keepsafe", 5);
  const keeper = path.join(sibling, "must-survive.txt");
  fs.writeFileSync(keeper, "evidence");
  fs.symlinkSync(sibling, path.join(victim, "link"), "junction");
  // After the junction: creating it re-stamps the victim's mtime, and an entry
  // newer than the plan is skipped at execute time.
  ageTree(sibling, 5);
  age(victim, 5);
  return { victim, sibling, keeper };
}

test("D1: a junction inside a delete target is unlinked, and the tree it points at survives", (t) => {
  const root = fakeTemp();
  try {
    let fixture;
    try {
      fixture = junctionFixture(root);
    } catch (error) {
      t.skip(`this platform/account cannot create junctions: ${error.message}`);
      return;
    }
    const plan = {
      generatedAt: new Date(NOW).toISOString(),
      generatedAtMs: NOW,
      temp: root,
      delete: [{ path: fixture.victim, bytes: 1, files: 1 }],
      evidence: { dirs: [], receipt: null },
    };
    const report = executePlan(plan);
    assert.equal(
      fs.existsSync(fixture.victim),
      false,
      "the delete target survived",
    );
    assert.equal(
      fs.readFileSync(fixture.keeper, "utf8"),
      "evidence",
      "the removal followed the junction and destroyed a tree that was never in the plan",
    );
    assert.ok(report.links >= 1, "no link was reported as unlinked");
  } finally {
    removeLaneTmp(root);
  }
});

// ---------------------------------------------------------------------------
// E. Inertness mutant for the junction guarantee.
// ---------------------------------------------------------------------------

test("E1: INERTNESS MUTANT — with the link-unlinking step unreachable, D1 stops failing", async (t) => {
  const host = mkLaneTmp("mutant-host-", { laneName: LANE });
  const root = fakeTemp();
  try {
    let fixture;
    try {
      fixture = junctionFixture(root);
    } catch (error) {
      t.skip(`this platform/account cannot create junctions: ${error.message}`);
      return;
    }
    const source = fs
      .readFileSync(MODULE_PATH, "utf8")
      .split("\r\n")
      .join("\n");
    const marker = "      unlinkLinksWithin(target, log);";
    assert.ok(
      source.includes(marker),
      "executePlan no longer calls unlinkLinksWithin",
    );
    const mutated = source
      .replace(marker, "      if (false) unlinkLinksWithin(target, log);")
      .replace(
        'from "./lib/lane-tmp.mjs"',
        `from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "lib", "lane-tmp.mjs")).href)}`,
      );
    assert.notEqual(mutated, source, "the mutation changed nothing");
    const file = path.join(host, "temp-hygiene-mutant.mjs");
    fs.writeFileSync(file, mutated);
    const inert = await import(pathToFileURL(file).href);

    inert.executePlan({
      generatedAt: new Date(NOW).toISOString(),
      generatedAtMs: NOW,
      temp: root,
      delete: [{ path: fixture.victim, bytes: 1, files: 1 }],
      evidence: { dirs: [], receipt: null },
    });

    // On a host where rmSync happens not to traverse the junction the mutant is
    // harmless and there is nothing to prove; where it does, D1's assertion must
    // now fail. Either way the spec must not claim a guarantee it did not test.
    const keeperSurvived = fs.existsSync(fixture.keeper);
    if (keeperSurvived) {
      // MEASURED 2026-09-11 on Windows 10 / Node 22: `fs.rmSync(recursive)` does
      // not traverse a directory junction, so the explicit unlink is defence in
      // depth rather than the only thing standing between a sweep and a tree
      // outside the plan. Recorded rather than asserted — claiming the mutant
      // proved the guarantee here would be false.
      t.diagnostic(
        "rmSync did not traverse the junction on this host — the unlink step is defence in depth; D1 still asserts the outcome",
      );
    } else {
      assert.throws(
        () => assert.equal(fs.readFileSync(fixture.keeper, "utf8"), "evidence"),
        "D1 survived an inert unlink step — the spec is not testing the guarantee",
      );
    }
  } finally {
    removeLaneTmp(root);
    removeLaneTmp(host);
  }
});

test("E2: INERTNESS MUTANT — with the protect check unreachable, C1 stops failing", async () => {
  const host = mkLaneTmp("mutant-host-", { laneName: LANE });
  const root = fakeTemp();
  try {
    const guarded = makeDir(root, "node-compile-cache", 40, { file: "c" });
    ageTree(guarded, 40);
    const source = fs
      .readFileSync(MODULE_PATH, "utf8")
      .split("\r\n")
      .join("\n");
    const marker = "export function isProtected(candidate, protects) {";
    assert.ok(source.includes(marker), "isProtected was renamed");
    const mutated = source
      .replace(marker, `${marker}\n  if (true) return false;`)
      .replace(
        'from "./lib/lane-tmp.mjs"',
        `from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "lib", "lane-tmp.mjs")).href)}`,
      );
    assert.notEqual(mutated, source, "the mutation changed nothing");
    const file = path.join(host, "temp-hygiene-protect-mutant.mjs");
    fs.writeFileSync(file, mutated);
    const inert = await import(pathToFileURL(file).href);

    const report = inert.executePlan({
      generatedAt: new Date(NOW).toISOString(),
      generatedAtMs: NOW,
      temp: root,
      delete: [{ path: guarded, bytes: 1, files: 1 }],
      evidence: { dirs: [], receipt: null },
    });
    assert.equal(report.deleted, 1, "sanity: the mutant really is inert");
    assert.throws(
      () => assert.equal(fs.existsSync(guarded), true),
      "C1 survived an inert protect check — the spec is not testing the protect set",
    );
  } finally {
    removeLaneTmp(root);
    removeLaneTmp(host);
  }
});

// ---------------------------------------------------------------------------
// G. The default plan path does not depend on the working directory
// (DX-KIT-OUTPUT-NOT-CWD): a plan run from inside another checkout used to
// leave `temp-hygiene-plan.json` in that checkout.
// ---------------------------------------------------------------------------

const PLAN_LANE = "temp-hygiene-spec-plan";

/**
 * Run `script --plan` with no `--out` from a foreign working directory and
 * report what landed there and where the plan went.
 */
function planFromForeignCwd(script) {
  const foreign = mkLaneTmp("foreign-cwd-", { laneName: LANE });
  const temp = fakeTemp();
  try {
    const run = spawnSync(
      process.execPath,
      [script, "--plan", "--temp", temp],
      {
        cwd: foreign,
        encoding: "utf8",
        env: { ...process.env, CESIUM_LANE: PLAN_LANE },
      },
    );
    assert.equal(run.status, 0, run.stderr);
    const planLine = /^PLAN (.+)$/m.exec(run.stdout);
    return {
      landedInCwd: fs.readdirSync(foreign),
      planPath: planLine ? planLine[1].trim() : null,
    };
  } finally {
    removeLaneTmp(foreign);
    removeLaneTmp(temp);
    sweepLaneTmp(PLAN_LANE);
  }
}

function assertNothingLandsInCwd(result) {
  assert.deepEqual(
    result.landedInCwd,
    [],
    "the plan was written into the working directory",
  );
}

test("G1: --plan without --out writes the plan to the lane temp root, not the cwd", () => {
  const result = planFromForeignCwd(SCRIPT);
  assertNothingLandsInCwd(result);
  assert.ok(result.planPath, "the CLI did not report where the plan went");
  assert.ok(
    path
      .resolve(result.planPath)
      .startsWith(
        path.resolve(os.tmpdir(), "cesium-lane", PLAN_LANE) + path.sep,
      ),
    `the plan went to ${result.planPath}, not the lane temp root`,
  );
});

test("G2: INERTNESS MUTANT — with the cwd default restored, G1 goes red", () => {
  const host = mkLaneTmp("mutant-host-", { laneName: LANE });
  try {
    const source = fs
      .readFileSync(MODULE_PATH, "utf8")
      .split("\r\n")
      .join("\n");
    const marker = "    out = defaultPlanPath();";
    assert.ok(source.includes(marker), "main no longer defaults the plan path");
    const mutated = source
      .replace(marker, '    out = path.resolve("temp-hygiene-plan.json");')
      .replace(
        'from "./lib/lane-tmp.mjs"',
        `from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "lib", "lane-tmp.mjs")).href)}`,
      );
    assert.notEqual(mutated, source, "the mutation changed nothing");
    const file = path.join(host, "temp-hygiene-cwd-mutant.mjs");
    fs.writeFileSync(file, mutated);
    assert.throws(
      () => assertNothingLandsInCwd(planFromForeignCwd(file)),
      "G1 survived the cwd default — the spec is not testing the plan path",
    );
  } finally {
    removeLaneTmp(host);
  }
});

// ---------------------------------------------------------------------------
// H. The running session is never guessed (T1), copies of tracked images are
// not evidence (T3), and a finished lane can be named (T2). Each behaviour is
// one assertion function, run on the real module and on a mutant of it.
// ---------------------------------------------------------------------------

/**
 * Import a copy of the tool with each `[anchor, replacement]` applied exactly
 * once; the copy is written under the lane temp root and removed once loaded.
 */
async function importToolMutant(name, pairs) {
  const host = mkLaneTmp("mutant-host-", { laneName: LANE });
  try {
    let source = fs.readFileSync(MODULE_PATH, "utf8").split("\r\n").join("\n");
    for (const [anchor, replacement] of pairs) {
      assert.equal(
        source.split(anchor).length - 1,
        1,
        `a mutant anchor must occur exactly once: ${anchor}`,
      );
      source = source.replace(anchor, () => replacement);
    }
    source = source.replace(
      'from "./lib/lane-tmp.mjs"',
      () =>
        `from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "lib", "lane-tmp.mjs")).href)}`,
    );
    const file = path.join(host, `temp-hygiene-${name}-mutant.mjs`);
    fs.writeFileSync(file, source);
    return await import(pathToFileURL(file).href);
  } finally {
    removeLaneTmp(host);
  }
}

function withSessionId(value, body) {
  const previous = process.env.CLAUDE_SESSION_ID;
  if (value === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = value;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = previous;
  }
}

/**
 * Four session folders: the live one, an hour old and still holding only
 * empty folders; a stale one whose own folder was touched last (the newest
 * folder time, which is what a guess would pick); a young one with a file;
 * and an old empty one, which is still swept.
 */
function sessionFixture(root) {
  const project = path.join(root, "claude", "some-project");
  fs.mkdirSync(project, { recursive: true });
  const live = path.join(project, "session-live");
  fs.mkdirSync(path.join(live, "scratchpad"), { recursive: true });
  fs.mkdirSync(path.join(live, "tasks"));
  ageTree(live, 1 / 24);
  const stale = makeDir(project, "session-stale", 6, { file: "transcript" });
  age(stale, 0);
  const youngWithFile = makeDir(project, "session-young", 2 / 24, {
    file: "transcript",
  });
  const oldEmpty = makeDir(project, "session-old-empty", 9);
  return { live, stale, youngWithFile, oldEmpty };
}

/** T1, as one check: no guess, and nothing young in a session ever deleted. */
function assertNoSessionGuess(module) {
  const root = fakeTemp();
  try {
    const fixture = sessionFixture(root);
    const plan = withSessionId(undefined, () =>
      module.planTempRoot({ temp: root, now: NOW }),
    );
    assert.equal(
      plan.runningSession,
      null,
      "with CLAUDE_SESSION_ID unset the plan named a running session by guess",
    );
    assert.equal(
      rowFor(plan, fixture.live).list,
      "keep",
      "the live session (an hour old, no files yet) is on the delete list",
    );
    assert.equal(rowFor(plan, fixture.youngWithFile).list, "keep");
    assert.equal(rowFor(plan, fixture.stale).list, "keep");
    assert.equal(
      rowFor(plan, fixture.oldEmpty).list,
      "delete",
      "control: an old empty session folder is still swept",
    );
    const claudeRoot = path.join(root, "claude") + path.sep;
    assert.deepEqual(
      plan.delete
        .filter((row) => row.path.startsWith(claudeRoot) && row.ageDays < 1)
        .map((row) => row.path),
      [],
      "a session folder younger than a day is on the delete list",
    );
  } finally {
    removeLaneTmp(root);
  }
}

test("H1 (T1): with CLAUDE_SESSION_ID unset no session is named running, and no session folder younger than a day is deleted, empty or not", () => {
  assertNoSessionGuess({ planTempRoot });
});

test("H1b (T1): with CLAUDE_SESSION_ID set, the named folder is the running session and the others are classified as before", () => {
  const root = fakeTemp();
  try {
    const fixture = sessionFixture(root);
    const plan = withSessionId("session-live", () =>
      planTempRoot({ temp: root, now: NOW }),
    );
    assert.equal(plan.runningSession, fixture.live);
    assert.equal(rowFor(plan, fixture.live).category, "running-session");
    assert.equal(rowFor(plan, fixture.oldEmpty).category, "empty-session");
    assert.equal(rowFor(plan, fixture.youngWithFile).list, "keep");
  } finally {
    removeLaneTmp(root);
  }
});

test("H1m (T1): MUTANT — with the newest-folder guess restored, H1 goes red", async () => {
  const mutant = await importToolMutant("session-guess", [
    [
      "  if (declared === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(declared))\n    return null;",
      [
        "  if (declared === undefined) {",
        "    let newest = null;",
        "    let newestTime = -1;",
        "    for (const project of fs.readdirSync(claudeRoot)) {",
        "      for (const session of fs.readdirSync(path.join(claudeRoot, project))) {",
        "        const sessionPath = path.join(claudeRoot, project, session);",
        "        const stats = fs.lstatSync(sessionPath);",
        "        if (stats.mtimeMs > newestTime) {",
        "          newestTime = stats.mtimeMs;",
        "          newest = sessionPath;",
        "        }",
        "      }",
        "    }",
        "    return newest;",
        "  }",
      ].join("\n"),
    ],
  ]);
  assert.throws(
    () => assertNoSessionGuess(mutant),
    /named a running session by guess/,
  );
});

test("H1n (T1): MUTANT — with the session age floor unreachable, H1 goes red", async () => {
  const mutant = await importToolMutant("session-floor", [
    [
      "      if (age < PATTERN_AGE_DAYS) {\n        // A session in use",
      "      if (false && age < PATTERN_AGE_DAYS) {\n        // A session in use",
    ],
  ]);
  assert.throws(
    () => assertNoSessionGuess(mutant),
    /the live session \(an hour old, no files yet\) is on the delete list/,
  );
});

/** A tracked PNG whose working-tree bytes are the bytes the index holds. */
function trackedImageBytes() {
  const listed = spawnSync("git", ["ls-files", "-s", "-z", "--", "*.png"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(listed.status, 0, listed.stderr);
  for (const record of listed.stdout.split("\0")) {
    const match = /^\d{6} ([0-9a-f]{40,64}) \d\t(.+)$/.exec(record);
    if (match === null) continue;
    const file = path.join(REPO_ROOT, match[2]);
    let bytes;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      continue;
    }
    const algorithm = match[1].length === 64 ? "sha256" : "sha1";
    if (bytes.length > 0 && gitBlobId(bytes, algorithm) === match[1]) {
      return bytes;
    }
  }
  assert.fail("no tracked PNG whose working-tree bytes match the index");
}

/** T3, as one check: copies of tracked images are not evidence; one changed image is. */
function assertTrackedCopiesAreNotEvidence(module) {
  const root = fakeTemp();
  try {
    const bytes = trackedImageBytes();
    const builtTarget = path.join(root, "build-copy-Ab3xYz");
    const built = path.join(builtTarget, "Build", "Assets", "Images");
    fs.mkdirSync(built, { recursive: true });
    fs.writeFileSync(path.join(built, "first.png"), bytes);
    fs.writeFileSync(path.join(built, "second.png"), bytes);
    const mixedTarget = path.join(root, "diff-run-Cd4eFg");
    const mixed = path.join(mixedTarget, "out");
    fs.mkdirSync(mixed, { recursive: true });
    fs.writeFileSync(path.join(mixed, "copy.png"), bytes);
    fs.writeFileSync(
      path.join(mixed, "changed.png"),
      Buffer.concat([bytes, Buffer.from([0])]),
    );
    ageTree(builtTarget, 5);
    ageTree(mixedTarget, 5);

    const plan = module.planTempRoot({
      temp: root,
      now: NOW,
      repoRoot: REPO_ROOT,
    });
    assert.equal(rowFor(plan, builtTarget).list, "delete");
    assert.equal(rowFor(plan, mixedTarget).list, "delete");
    assert.deepEqual(
      plan.evidence.dirs,
      [mixed],
      "a folder of tracked-image copies counted as evidence, or one changed image did not",
    );
    assert.equal(plan.evidence.trackedCopyDirs, 1);
  } finally {
    removeLaneTmp(root);
  }
}

test("H3 (T3): a folder whose images are all copies of tracked images is not evidence; one image that differs makes it evidence", () => {
  assertTrackedCopiesAreNotEvidence({ planTempRoot });
});

test("H3m (T3): MUTANT — with the tracked-copy test unreachable, H3 goes red", async () => {
  const mutant = await importToolMutant("tracked-copies", [
    [
      "if (!found.has(directory) && !isTrackedCopy(child)) {",
      "if (!found.has(directory) && !(false && isTrackedCopy(child))) {",
    ],
  ]);
  assert.throws(
    () => assertTrackedCopiesAreNotEvidence(mutant),
    /a folder of tracked-image copies counted as evidence/,
  );
});

/**
 * T3, where git cannot answer: no image counts as a copy of a tracked one, so a
 * folder of images in a delete target is evidence and `executePlan` refuses it
 * until it is banked. The images are byte copies of a tracked image, so only a
 * tool that treats "no answer" as "everything is tracked" drops them.
 */
function assertNoGitMeansEvidence(module) {
  const root = fakeTemp();
  const notRepo = mkLaneTmp("not-a-repo-", { laneName: LANE });
  try {
    const bytes = trackedImageBytes();
    const target = path.join(root, "shots-run-Ef5gHi");
    const shots = path.join(target, "out");
    fs.mkdirSync(shots, { recursive: true });
    fs.writeFileSync(path.join(shots, "copy.png"), bytes);
    ageTree(target, 5);

    for (const [label, repoRoot] of [
      ["repoRoot: null", null],
      ["a repoRoot that is no repository", notRepo],
    ]) {
      const plan = module.planTempRoot({ temp: root, now: NOW, repoRoot });
      assert.equal(rowFor(plan, target).list, "delete", label);
      assert.deepEqual(
        plan.evidence.dirs,
        [shots],
        `${label}: with git unable to answer, an image folder was not evidence`,
      );
      assert.equal(plan.evidence.trackedCopyDirs, 0, label);
      const refused = module.executePlan(plan);
      assert.match(
        refused.refused ?? "",
        /not banked/,
        `${label}: the unbanked image folder was not refused`,
      );
      assert.equal(fs.existsSync(target), true, `${label}: nothing deleted`);
    }
  } finally {
    removeLaneTmp(notRepo);
    removeLaneTmp(root);
  }
}

test("H3n (T3): where git cannot answer, an image folder in a delete target is evidence and execute refuses it unbanked", () => {
  assertNoGitMeansEvidence({ planTempRoot, executePlan });
});

test("H3o (T3): MUTANT — with 'git cannot answer' read as 'every image is tracked', H3n goes red", async () => {
  const mutant = await importToolMutant("no-git", [
    [
      "    if (tracked === null) return false;",
      "    if (tracked === null) return true;",
    ],
  ]);
  assert.throws(
    () => assertNoGitMeansEvidence(mutant),
    /with git unable to answer, an image folder was not evidence/,
  );
});

/**
 * T3, with a repository variable of git set in the caller's environment (as a
 * git hook sets them): what the tool learns from git about a folder is about
 * that folder. The two variables that change git's answer are tested one at a
 * time: `GIT_INDEX_FILE` naming a missing index and `GIT_DIR` naming another
 * repository (an empty one made by hand) must not change the answer for the
 * repository itself, and `GIT_DIR` naming a real repository must not make a
 * `repoRoot` that is no repository answer for it. `GIT_WORK_TREE` alone changes
 * nothing git says here, so it is not stripped. The environment is restored
 * whatever happens.
 */
function assertGitVariablesAreNotTaken(module) {
  const gitDir = spawnSync("git", ["rev-parse", "--absolute-git-dir"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(gitDir.status, 0, gitDir.stderr);
  const names = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];
  const saved = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  const setOnly = (name, value) => {
    for (const other of names) delete process.env[other];
    if (name !== null) process.env[name] = value;
  };
  const answer = (repoRoot) => {
    const found = module.trackedImageBlobIds(repoRoot);
    return found === null
      ? null
      : { algorithm: found.algorithm, ids: [...found.ids].sort() };
  };
  const root = fakeTemp();
  const notRepo = mkLaneTmp("not-a-repo-env-", { laneName: LANE });
  const hostile = mkLaneTmp("hostile-git-env-", { laneName: LANE });
  try {
    // An empty repository, made by hand: HEAD, objects and refs.
    const other = path.join(hostile, "other.git");
    fs.mkdirSync(path.join(other, "objects", "info"), { recursive: true });
    fs.mkdirSync(path.join(other, "objects", "pack"), { recursive: true });
    fs.mkdirSync(path.join(other, "refs", "heads"), { recursive: true });
    fs.writeFileSync(path.join(other, "HEAD"), "ref: refs/heads/main\n");

    setOnly(null);
    const bytes = trackedImageBytes();
    const baseline = answer(REPO_ROOT);
    assert.ok(
      baseline !== null && baseline.ids.length > 0,
      "the repository itself lists tracked images",
    );
    for (const [name, value, what] of [
      [
        "GIT_INDEX_FILE",
        path.join(hostile, "missing-index"),
        "a missing index",
      ],
      ["GIT_DIR", other, "another repository"],
    ]) {
      setOnly(name, value);
      assert.deepEqual(
        answer(REPO_ROOT),
        baseline,
        `with ${name} naming ${what}, the answer for the repository itself changed`,
      );
    }

    const target = path.join(root, "shots-run-Gh6iJk");
    const shots = path.join(target, "out");
    fs.mkdirSync(shots, { recursive: true });
    fs.writeFileSync(path.join(shots, "copy.png"), bytes);
    ageTree(target, 5);
    setOnly("GIT_DIR", gitDir.stdout.trim());
    const plan = module.planTempRoot({
      temp: root,
      now: NOW,
      repoRoot: notRepo,
    });
    assert.deepEqual(
      plan.evidence.dirs,
      [shots],
      "with GIT_DIR naming a repository, a repoRoot that is no repository answered for that repository",
    );
    assert.equal(module.trackedImageBlobIds(notRepo), null);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    removeLaneTmp(hostile);
    removeLaneTmp(notRepo);
    removeLaneTmp(root);
  }
}

test("H3p (T3): GIT_DIR and GIT_INDEX_FILE in the caller's environment, each alone, do not change what git says about the folder asked", () => {
  const names = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];
  const before = names.map((name) => process.env[name]);
  assertGitVariablesAreNotTaken({ planTempRoot, trackedImageBlobIds });
  assert.deepEqual(
    names.map((name) => process.env[name]),
    before,
    "the case leaks nothing into the environment",
  );
});

test("H3q (T3): MUTANT — with the caller's git variables handed through, H3p goes red", async () => {
  const mutant = await importToolMutant("git-variables", [
    [
      "    if (GIT_REPOSITORY_VARIABLES.includes(name.toUpperCase())) continue;",
      "    if (false && GIT_REPOSITORY_VARIABLES.includes(name.toUpperCase())) continue;",
    ],
  ]);
  assert.throws(
    () => assertGitVariablesAreNotTaken(mutant),
    /the answer for the repository itself changed/,
  );
});

test("H3r (T3): MUTANT — with GIT_INDEX_FILE handed through, H3p goes red on that variable", async () => {
  const mutant = await importToolMutant("git-index-file", [
    [
      'const GIT_REPOSITORY_VARIABLES = ["GIT_DIR", "GIT_INDEX_FILE"];',
      'const GIT_REPOSITORY_VARIABLES = ["GIT_DIR"];',
    ],
  ]);
  assert.throws(
    () => assertGitVariablesAreNotTaken(mutant),
    /with GIT_INDEX_FILE naming a missing index, the answer for the repository itself changed/,
  );
});

/** Lane roots: two young lanes, the slot's state folder, and an old lane. */
function laneFixture(root) {
  const lanes = path.join(root, "cesium-lane");
  fs.mkdirSync(lanes);
  const finished = makeDir(lanes, "gimli", 0, { file: "scratch" });
  const running = makeDir(lanes, "legolas", 0, { file: "scratch" });
  const slot = makeDir(lanes, "_seat", 0, { file: "BUILD_SLOT.lock" });
  const old = makeDir(lanes, "boromir", 5, { file: "scratch" });
  age(lanes, 0);
  return { lanes, finished, running, slot, old };
}

/** T2, as one check on the plan. */
function assertFinishedLanes(module) {
  const root = fakeTemp();
  try {
    const fixture = laneFixture(root);
    const plan = module.planTempRoot({
      temp: root,
      now: NOW,
      finishedLanes: "gimli, ghost",
    });
    assert.equal(
      rowFor(plan, fixture.finished).list,
      "delete",
      "a lane named finished was kept because it is young",
    );
    assert.equal(rowFor(plan, fixture.finished).category, "finished-lane");
    assert.equal(rowFor(plan, fixture.running).list, "keep");
    assert.equal(rowFor(plan, fixture.slot).list, "keep");
    assert.equal(rowFor(plan, fixture.old).list, "delete");
    assert.deepEqual(plan.finishedLanes, {
      named: ["gimli"],
      missing: ["ghost"],
    });
    for (const named of ["_seat", "_SEAT", "gimli,_Seat"]) {
      assert.throws(
        () =>
          module.planTempRoot({ temp: root, now: NOW, finishedLanes: named }),
        /may never name _seat: it is the slot's state folder/,
        `--finished-lanes ${named} was not refused`,
      );
    }
    assert.throws(
      () =>
        module.planTempRoot({ temp: root, now: NOW, finishedLanes: "../up" }),
      /invalid lane name/,
    );
  } finally {
    removeLaneTmp(root);
  }
}

test("H2 (T2): finished lanes go on the delete list whatever their age; _seat can never be named; a name with no root is reported", () => {
  assertFinishedLanes({ planTempRoot });
});

test("H2b (T2): a finished lane's root still passes the evidence gate and the lock probe at execute time", () => {
  const root = fakeTemp();
  try {
    const fixture = laneFixture(root);
    const shots = path.join(fixture.finished, "shots");
    fs.mkdirSync(shots);
    fs.writeFileSync(path.join(shots, "frame.png"), "not a tracked image");
    fs.writeFileSync(path.join(fixture.finished, "LOCK"), "");
    ageTree(fixture.finished, 0);
    const plan = planTempRoot({ temp: root, now: NOW, finishedLanes: "gimli" });
    assert.deepEqual(plan.evidence.dirs, [shots]);

    const unbanked = executePlan(plan);
    assert.match(unbanked.refused ?? "", /not banked/);
    assert.equal(fs.existsSync(fixture.finished), true);

    plan.evidence.receipt = { verified: true, pngInZip: 1, pngOnDisk: 1 };
    const busy = () => {
      const error = new Error("held");
      error.code = "EBUSY";
      throw error;
    };
    const locked = executePlan(plan, { open: busy });
    assert.ok(
      locked.skipped.some(
        (line) => line === `LOCKED ${path.resolve(fixture.finished)}`,
      ),
      locked.skipped.join("\n"),
    );
    assert.equal(fs.existsSync(fixture.finished), true);

    const swept = executePlan(plan);
    assert.equal(swept.refused, null);
    assert.equal(fs.existsSync(fixture.finished), false);
    assert.equal(fs.existsSync(fixture.running), true);
    assert.equal(fs.existsSync(fixture.slot), true);
  } finally {
    removeLaneTmp(root);
  }
});

test("H2c (T2): the CLI prints the finished lanes and the names with no root, and refuses _seat", () => {
  const root = fakeTemp();
  const out = path.join(root, "..", `plan-h2c-${process.pid}.json`);
  try {
    laneFixture(root);
    const listed = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "--plan",
        "--temp",
        root,
        "--out",
        out,
        "--finished-lanes",
        "gimli,ghost",
      ],
      { encoding: "utf8" },
    );
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(
      listed.stdout,
      /^FINISHED LANES on the delete list: gimli; NO ROOT: ghost$/m,
    );
    const refused = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "--plan",
        "--temp",
        root,
        "--out",
        out,
        "--finished-lanes",
        "_seat",
      ],
      { encoding: "utf8" },
    );
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /REFUSED: .*slot's state folder/);
    const empty = spawnSync(
      process.execPath,
      [SCRIPT, "--plan", "--temp", root, "--out", out, "--finished-lanes"],
      { encoding: "utf8" },
    );
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /needs <lane>/);
  } finally {
    fs.rmSync(out, { force: true });
    removeLaneTmp(root);
  }
});

test("H2m (T2): MUTANT — with the finished-lane branch unreachable, H2 goes red", async () => {
  const mutant = await importToolMutant("finished-branch", [
    [
      "    if (finished.has(fold(lane)) && stats.isDirectory()) {",
      "    if (false && finished.has(fold(lane)) && stats.isDirectory()) {",
    ],
  ]);
  assert.throws(
    () => assertFinishedLanes(mutant),
    /a lane named finished was kept because it is young/,
  );
});

test("H2n (T2): MUTANT — with the shared-lane refusal unreachable, H2 goes red", async () => {
  const mutant = await importToolMutant("seat-refusal", [
    [
      "    if (shared !== undefined) {",
      "    if (false && shared !== undefined) {",
    ],
  ]);
  assert.throws(
    () => assertFinishedLanes(mutant),
    /--finished-lanes _seat was not refused|may never name _seat/,
  );
});

// The lane folders that are shared roots, written out here and not read from
// the tool: the slot's state, the root of every process run without a lane
// name, and the landing tools' scratch.
const SHARED_LANES = ["_seat", "seat", "landing"];

/** T2 (shared roots), as one check: none of them can be named a finished lane. */
function assertSharedLanesNeverFinished(module) {
  const root = fakeTemp();
  try {
    const lanes = path.join(root, "cesium-lane");
    fs.mkdirSync(lanes);
    const shared = SHARED_LANES.map((name) =>
      makeDir(lanes, name, 0, { file: "scratch" }),
    );
    makeDir(lanes, "gimli", 0, { file: "scratch" });
    age(lanes, 0);
    for (const base of SHARED_LANES) {
      for (const named of [
        base,
        base.toUpperCase(),
        `gimli,${base}`,
        `${base} gimli`,
      ]) {
        assert.throws(
          () =>
            module.planTempRoot({ temp: root, now: NOW, finishedLanes: named }),
          new RegExp(`may never name ${base}: it is `),
          `--finished-lanes ${named} was not refused`,
        );
      }
    }
    const plan = module.planTempRoot({
      temp: root,
      now: NOW,
      finishedLanes: "gimli",
    });
    for (const folder of shared) {
      assert.equal(rowFor(plan, folder).list, "keep", folder);
    }
    assert.deepEqual(
      [...module.NEVER_FINISHED_LANES.keys()].sort(),
      [...SHARED_LANES].sort(),
      "the one constant names exactly the shared lanes",
    );
  } finally {
    removeLaneTmp(root);
  }
}

test("H2d (T2): seat and landing, like _seat, can never be named a finished lane, in any case or list position", () => {
  assertSharedLanesNeverFinished({
    planTempRoot,
    NEVER_FINISHED_LANES,
  });
});

test("H2o (T2): MUTANT — with seat and landing left out of the refusal, H2d goes red", async () => {
  const mutant = await importToolMutant("shared-lanes", [
    [
      "    const shared = NEVER_FINISHED_LANES.get(name.toLowerCase());",
      "    const shared =\n      name.toLowerCase() === SLOT_STATE_LANE\n        ? NEVER_FINISHED_LANES.get(SLOT_STATE_LANE)\n        : undefined;",
    ],
  ]);
  assert.throws(
    () => assertSharedLanesNeverFinished(mutant),
    /--finished-lanes seat was not refused/,
  );
});
