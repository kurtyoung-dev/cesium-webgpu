// @purpose Enforce the measured prohibited-reader allowlist as a shrink-only ratchet.
// @status ACTIVE

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PROHIBITED_READER_ALLOWLIST,
  PROHIBITED_READER_ALLOWLIST_SNAPSHOT,
} from "./lib/prohibited-reader-allowlist.mjs";
import { analyzeProhibitedReader } from "./lib/prohibited-reader-rule.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_SIZE = 175;
const SNAPSHOT_MEMBER_DIGEST =
  "02b60967519599371c5eda04faa99f65650ef2446aea16d1fca9c327c639055a";
const SANCTIONED_TO_DATA_URL_SIZE = 48;
const SANCTIONED_TO_DATA_URL = /\.\s*canvas\s*\.\s*toDataURL\s*\(/u;

let fleetCache;

function fleet() {
  if (fleetCache !== undefined) {
    return fleetCache;
  }
  const names = readdirSync(HERE)
    .filter(
      (name) =>
        name.startsWith("probe-") &&
        name.endsWith(".mjs") &&
        !name.endsWith(".spec.mjs"),
    )
    .sort();
  const sources = new Map(
    names.map((name) => [name, readFileSync(join(HERE, name), "utf8")]),
  );
  const analyses = new Map(
    names.map((name) => [name, analyzeProhibitedReader(sources.get(name))]),
  );
  fleetCache = { analyses, names, sources };
  return fleetCache;
}

const memberDigest = (members) =>
  createHash("sha256").update(JSON.stringify(members)).digest("hex");

const duplicates = (names) => {
  const seen = new Set();
  return names.filter((name) =>
    seen.has(name) ? true : (seen.add(name), false),
  );
};

/**
 * Compute every ratchet finding from injectable data. The real assertion and
 * its controls call this same function, so a control cannot test a substitute
 * implementation.
 */
export function ratchetFindings(allowlist, snapshot, scope) {
  const allowlistNames = Object.keys(allowlist);
  const allowlisted = new Set(allowlistNames);
  const present = new Set(scope.names);
  const snapshotNames = snapshot.members;
  const snapshotSet = new Set(snapshotNames);
  const snapshotChanges = [];

  if (snapshot.size !== SNAPSHOT_SIZE) {
    snapshotChanges.push(
      `snapshot size changed from ${SNAPSHOT_SIZE} to ${snapshot.size}`,
    );
  }
  if (snapshotNames.length !== snapshot.size) {
    snapshotChanges.push(
      `snapshot has ${snapshotNames.length} members but records ${snapshot.size}`,
    );
  }
  if (memberDigest(snapshotNames) !== SNAPSHOT_MEMBER_DIGEST) {
    snapshotChanges.push("snapshot member names changed");
  }

  return {
    added: allowlistNames.filter((name) => !snapshotSet.has(name)),
    duplicatedSnapshotNames: duplicates(snapshotNames),
    gone: allowlistNames.filter((name) => !present.has(name)),
    grew:
      allowlistNames.length > snapshot.size
        ? `allowlist grew from ${snapshot.size} to ${allowlistNames.length}`
        : null,
    repaired: allowlistNames.filter(
      (name) =>
        present.has(name) && scope.analyses.get(name)?.violations.length === 0,
    ),
    snapshotChanges,
    uncovered: scope.names.filter(
      (name) =>
        scope.analyses.get(name).violations.length > 0 &&
        !allowlisted.has(name),
    ),
    unsortedAllowlist: allowlistNames.filter(
      (name, index) => name !== [...allowlistNames].sort()[index],
    ),
    unsortedSnapshot: snapshotNames.filter(
      (name, index) => name !== [...snapshotNames].sort()[index],
    ),
  };
}

function assertRatchet(allowlist, snapshot, scope) {
  const findings = ratchetFindings(allowlist, snapshot, scope);
  assert.deepEqual(
    findings.snapshotChanges,
    [],
    findings.snapshotChanges.join("; "),
  );
  assert.deepEqual(
    findings.added,
    [],
    `allowlist added names outside the frozen snapshot: ${findings.added}`,
  );
  assert.equal(findings.grew, null, findings.grew ?? undefined);
  assert.deepEqual(
    findings.gone,
    [],
    `allowlist names files that no longer exist: ${findings.gone}`,
  );
  assert.deepEqual(
    findings.repaired,
    [],
    `repaired probes must be removed from the allowlist: ${findings.repaired}`,
  );
  assert.deepEqual(
    findings.uncovered,
    [],
    `violating probes are not allowlisted: ${findings.uncovered}`,
  );
  assert.deepEqual(findings.unsortedAllowlist, []);
  assert.deepEqual(findings.unsortedSnapshot, []);
  assert.deepEqual(findings.duplicatedSnapshotNames, []);
}

test("the allowlist and its independent snapshot are frozen, sorted data", () => {
  assert.ok(Object.isFrozen(PROHIBITED_READER_ALLOWLIST));
  assert.ok(Object.isFrozen(PROHIBITED_READER_ALLOWLIST_SNAPSHOT));
  assert.ok(Object.isFrozen(PROHIBITED_READER_ALLOWLIST_SNAPSHOT.members));

  for (const [name, reason] of Object.entries(PROHIBITED_READER_ALLOWLIST)) {
    assert.match(name, /^probe-.*\.mjs$/u);
    assert.equal(typeof reason, "string", `${name} has no reason`);
    assert.ok(reason.trim().length >= 20, `${name} has no useful reason`);
    assert.doesNotMatch(reason, /[\r\n]/u, `${name}'s reason spans lines`);
    assert.match(reason, /added 2026-08-20/u, `${name} has no add-date`);
  }
});

test("the measured fleet satisfies the complete allowlist ratchet", () => {
  const scope = fleet();
  const findings = [...scope.analyses.values()].flatMap(
    (analysis) => analysis.violations,
  );
  const violatingFiles = scope.names.filter(
    (name) => scope.analyses.get(name).violations.length > 0,
  );
  console.log(
    `      scanned ${scope.names.length} probes; ${violatingFiles.length} violating files; ${findings.length} findings`,
  );
  assertRatchet(
    PROHIBITED_READER_ALLOWLIST,
    PROHIBITED_READER_ALLOWLIST_SNAPSHOT,
    scope,
  );
});

test("CONTROL: sanctioned live-canvas toDataURL probes stay clean", () => {
  const scope = fleet();
  const candidates = scope.names.filter(
    (name) =>
      !Object.hasOwn(PROHIBITED_READER_ALLOWLIST, name) &&
      SANCTIONED_TO_DATA_URL.test(scope.sources.get(name)),
  );
  assert.equal(candidates.length, SANCTIONED_TO_DATA_URL_SIZE);
  const violations = candidates.filter(
    (name) => scope.analyses.get(name).violations.length > 0,
  );
  assert.deepEqual(
    violations,
    [],
    `sanctioned toDataURL probes were flagged: ${violations}`,
  );
});

test("MUTATION: a fabricated allowlist member is rejected", () => {
  const fabricated = "probe-zz-fabricated-reader.mjs";
  const grown = {
    ...PROHIBITED_READER_ALLOWLIST,
    [fabricated]: "fabricated mutation — added 2026-08-20",
  };
  assert.throws(
    () => assertRatchet(grown, PROHIBITED_READER_ALLOWLIST_SNAPSHOT, fleet()),
    /outside the frozen snapshot.*probe-zz-fabricated-reader/u,
  );
});

test("MUTATION: adding a fabricated name to the frozen snapshot is rejected", () => {
  const mutatedSnapshot = {
    size: PROHIBITED_READER_ALLOWLIST_SNAPSHOT.size,
    members: [
      ...PROHIBITED_READER_ALLOWLIST_SNAPSHOT.members,
      "probe-zz-fabricated-reader.mjs",
    ],
  };
  assert.throws(
    () => assertRatchet(PROHIBITED_READER_ALLOWLIST, mutatedSnapshot, fleet()),
    /snapshot has 176 members but records 175/u,
  );
});

test("CONTROL: removing a repaired real probe passes the complete ratchet", () => {
  const repairedName = Object.keys(PROHIBITED_READER_ALLOWLIST)[0];
  assert.ok(repairedName, "the measured allowlist unexpectedly has no donor");
  const reduced = Object.fromEntries(
    Object.entries(PROHIBITED_READER_ALLOWLIST).filter(
      ([name]) => name !== repairedName,
    ),
  );
  const realScope = fleet();
  const repairedScope = {
    analyses: new Map(realScope.analyses).set(repairedName, { violations: [] }),
    names: realScope.names,
  };
  assert.doesNotThrow(() =>
    assertRatchet(reduced, PROHIBITED_READER_ALLOWLIST_SNAPSHOT, repairedScope),
  );
});

test("CONTROL: retaining a repaired row is rejected as stale", () => {
  const repairedName = Object.keys(PROHIBITED_READER_ALLOWLIST)[0];
  const realScope = fleet();
  const repairedScope = {
    analyses: new Map(realScope.analyses).set(repairedName, { violations: [] }),
    names: realScope.names,
  };
  assert.throws(
    () =>
      assertRatchet(
        PROHIBITED_READER_ALLOWLIST,
        PROHIBITED_READER_ALLOWLIST_SNAPSHOT,
        repairedScope,
      ),
    /repaired probes must be removed.*probe-2d-blank-where/u,
  );
});

test("CONTROL: a new non-allowlisted violation is rejected", () => {
  const scope = fleet();
  const cleanName = scope.names.find(
    (name) =>
      !Object.hasOwn(PROHIBITED_READER_ALLOWLIST, name) &&
      scope.analyses.get(name).violations.length === 0,
  );
  assert.ok(cleanName, "the fleet has no clean non-allowlisted control donor");
  const mutatedScope = {
    analyses: new Map(scope.analyses).set(cleanName, {
      violations: [{ kind: "prohibited-live-canvas-reader", line: 1 }],
    }),
    names: scope.names,
  };
  assert.throws(
    () =>
      assertRatchet(
        PROHIBITED_READER_ALLOWLIST,
        PROHIBITED_READER_ALLOWLIST_SNAPSHOT,
        mutatedScope,
      ),
    new RegExp(`violating probes are not allowlisted.*${cleanName}`, "u"),
  );
});
