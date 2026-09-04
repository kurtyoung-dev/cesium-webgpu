// runtime-residency-contract.spec.mjs — AUTHORING-TIME enforcement of DX-02,
// the anti-re-accretion contract. Pure Node: no browser, no network, no GPU.
//
// @purpose Contract spec for DX-02: a probe that declares @runtime residency on lib/probe-runtime.mjs must not re-implement the four concerns that module already owns.
// @status ACTIVE
//
// WHY IT IS A SEPARATE FILE FROM `probe-fleet-contract.spec.mjs`. Same reason
// `purpose-header-contract.spec.mjs` is separate from it: that spec is owned
// by an in-flight lane, and two lanes editing one guard is how a guard stops
// being trustworthy. This ships as its own driver over the same probe
// directory and its own analyzer module (`lib/runtime-residency-contract.mjs`).
// Nothing here reads or modifies `probe-fleet-contract.spec.mjs` or its
// allowlist.
//
// THE RATCHET SHAPE. Mirrors `prohibited-reader-allowlist.spec.mjs`: a
// `{name: reason}` allowlist plus an independently frozen `{size, members}`
// snapshot, both asserted sorted with no duplicates, and a digest over the
// snapshot's membership so a member cannot be silently swapped for another of
// the same count. At this snapshot the allowlist and its census are BOTH
// empty — `DX-01` migrated one probe and it is clean — so `C2` (every
// resident probe is either violation-free or allowlisted) holds trivially
// today. That is not proof the ratchet bites; group `D` proves it with
// synthetic scope objects the way `prohibited-reader-allowlist.spec.mjs`'s own
// MUTATION controls do, and group `C` proves the four-concern SCAN bites by
// mutating the one REAL resident probe's source in memory (never written to
// disk) and requiring each concern's characteristic shape to be caught, then
// to clear when removed.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_CONCERNS,
  RUNTIME_MODULE,
  analyzeRuntimeResidency,
  parseRuntimeTag,
} from "./lib/runtime-residency-contract.mjs";
import {
  RUNTIME_RESIDENCY_ALLOWLIST,
  RUNTIME_RESIDENCY_ALLOWLIST_SNAPSHOT,
} from "./lib/runtime-residency-allowlist.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_SIZE = 0;
const SNAPSHOT_MEMBER_DIGEST = createHash("sha256")
  .update(JSON.stringify([]))
  .digest("hex");
const PILOT_PROBE = "probe-globe-cold-start-readiness.mjs";

// ---------------------------------------------------------------------------
// The measured fleet: top-level probes only. A `@runtime` tag names an ENTRY
// POINT's residency; the shared `lib/*.mjs` files it imports are not
// themselves probes and carry no tag of their own.
// ---------------------------------------------------------------------------

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
    names.map((name) => [name, analyzeRuntimeResidency(sources.get(name))]),
  );
  fleetCache = { names, sources, analyses };
  return fleetCache;
}

const memberDigest = (members) =>
  createHash("sha256").update(JSON.stringify(members)).digest("hex");

/**
 * Compute every ratchet finding from injectable data, mirroring
 * `prohibited-reader-allowlist.spec.mjs`'s `ratchetFindings` so the real
 * assertion and its MUTATION controls exercise the same function.
 *
 * @param {Readonly<Record<string, string>>} allowlist
 * @param {{size: number, members: readonly string[]}} snapshot
 * @param {{names: string[], analyses: Map<string, object>}} scope
 * @returns {object} Findings.
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

  const duplicates = (names) => {
    const seen = new Set();
    return names.filter((name) =>
      seen.has(name) ? true : (seen.add(name), false),
    );
  };

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
        (scope.analyses.get(name)?.violations.length ?? 0) > 0 &&
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
    `repaired files must be removed from the allowlist: ${findings.repaired}`,
  );
  assert.deepEqual(
    findings.uncovered,
    [],
    `runtime-resident probes are not allowlisted: ${findings.uncovered}`,
  );
  assert.deepEqual(findings.unsortedAllowlist, []);
  assert.deepEqual(findings.unsortedSnapshot, []);
  assert.deepEqual(findings.duplicatedSnapshotNames, []);
}

// ---------------------------------------------------------------------------
// A. The @runtime tag grammar
// ---------------------------------------------------------------------------

test("A1: a probe declaring residency parses resident=true with no violations", () => {
  const src = [
    "// probe-x.mjs",
    "// @purpose Does one thing worth a sentence.",
    "// @status ACTIVE",
    "// @runtime lib/probe-runtime.mjs",
    "//",
    'import { isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";',
    'export const descriptor = { name: "x", cells() { return []; } };',
    "if (isEntryPoint(import.meta.url)) { await runProbe(descriptor); }",
    "",
  ].join("\n");
  const a = analyzeRuntimeResidency(src);
  assert.equal(a.runtimeTag, "lib/probe-runtime.mjs");
  assert.equal(a.resident, true);
  assert.deepEqual(a.violations, []);
});

test("A2: an untagged probe is out of scope — resident=false, no violations, whatever it contains", () => {
  const src = [
    "// probe-x.mjs",
    "// @purpose Does one thing worth a sentence.",
    "// @status ACTIVE",
    "//",
    'import { createHash } from "node:crypto";',
    'const lock = { flag: "wx" };',
    "",
  ].join("\n");
  const a = analyzeRuntimeResidency(src);
  assert.equal(a.runtimeTag, null);
  assert.equal(a.resident, false);
  assert.deepEqual(a.violations, []);
});

test("A3: @runtime none is a legal, explicit non-resident declaration", () => {
  const src = [
    "// probe-x.mjs",
    "// @purpose Does one thing worth a sentence.",
    "// @status ACTIVE",
    "// @runtime none",
    "//",
    "",
  ].join("\n");
  const a = analyzeRuntimeResidency(src);
  assert.equal(a.runtimeTag, "none");
  assert.equal(a.resident, false);
  assert.deepEqual(a.violations, []);
});

test("A4 mutant: an out-of-vocabulary @runtime value is a violation", () => {
  const src = [
    "// probe-x.mjs",
    "// @purpose Does one thing worth a sentence.",
    "// @status ACTIVE",
    "// @runtime some-other-runtime.mjs",
    "//",
    "",
  ].join("\n");
  const a = analyzeRuntimeResidency(src);
  assert.equal(a.resident, false);
  assert.equal(a.violations.length, 1);
  assert.match(a.violations[0].message, /not one of/);
});

test("A5: a @runtime tag outside the header block does not register", () => {
  const src = [
    "// probe-x.mjs",
    "// @purpose Does one thing worth a sentence.",
    "// @status ACTIVE",
    "//",
    'import { runProbe } from "./lib/probe-runtime.mjs";',
    "",
    "// @runtime lib/probe-runtime.mjs — far too late to be a header declaration.",
    "",
  ].join("\n");
  const a = analyzeRuntimeResidency(src);
  assert.equal(a.runtimeTag, null);
  assert.equal(a.resident, false);
});

test("A6: parseRuntimeTag reports the tag's own line", () => {
  const src = [
    "// probe-x.mjs",
    "// @purpose Does one thing worth a sentence.",
    "// @status ACTIVE",
    "// @runtime lib/probe-runtime.mjs",
    "",
  ].join("\n");
  const tag = parseRuntimeTag(src);
  assert.equal(tag.value, "lib/probe-runtime.mjs");
  assert.equal(tag.line, 3);
});

// ---------------------------------------------------------------------------
// B. Residency without actual use — the "claims residency, never uses it" case
// ---------------------------------------------------------------------------

const RESIDENT_BASE = [
  "// probe-x.mjs",
  "// @purpose Does one thing worth a sentence.",
  "// @status ACTIVE",
  "// @runtime lib/probe-runtime.mjs",
  "//",
  'import { isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";',
  'export const descriptor = { name: "x", cells() { return []; } };',
  "if (isEntryPoint(import.meta.url)) { await runProbe(descriptor); }",
  "",
].join("\n");

test("B1: residency declared without importing the runtime is a violation", () => {
  const src = RESIDENT_BASE.replace(
    'import { isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";\n',
    "",
  );
  assert.notEqual(src, RESIDENT_BASE, "mutation did not apply");
  const violations = analyzeRuntimeResidency(src).violations.map((v) => v.id);
  assert.ok(violations.includes("residency-without-import"));
});

test("B2: residency declared without calling runProbe( is a violation", () => {
  const src = RESIDENT_BASE.replace(
    "await runProbe(descriptor);",
    "void descriptor;",
  );
  assert.notEqual(src, RESIDENT_BASE, "mutation did not apply");
  const violations = analyzeRuntimeResidency(src).violations.map((v) => v.id);
  assert.deepEqual(violations, ["residency-without-runProbe-call"]);
});

test("B3: a probe that imports and calls runProbe without the @runtime tag is a violation", () => {
  const src = [
    "// probe-evil.mjs",
    "// @purpose Does one thing worth a sentence.",
    "// @status ACTIVE",
    "//",
    'import { createHash } from "node:crypto";',
    'import { runProbe } from "./lib/probe-runtime.mjs";',
    'const lock = { flag: "wx" };',
    "class EvilRefusal extends Error {}",
    'const p1 = "evil-report.json";',
    'const p2 = "evil-refusal.json";',
    'export const descriptor = { name: "evil", cells() { return []; } };',
    "await runProbe(descriptor);",
    "",
  ].join("\n");
  const a = analyzeRuntimeResidency(src);
  // The tag is still absent, so the four-concern scan does not run over this
  // file — `resident` stays false by design (see the module header). Only
  // the one unambiguous signal, the named `runProbe` import, is checked
  // regardless of the tag.
  assert.equal(a.resident, false);
  assert.deepEqual(
    a.violations.map((v) => v.id),
    ["missing-runtime-tag"],
  );
});

test("B4: importing an unrelated runtime export (sha256) without the tag does not enroll a probe", () => {
  const src = [
    "// probe-benign.mjs",
    "// @purpose Does one thing worth a sentence.",
    "// @status ACTIVE",
    "//",
    'import { sha256 } from "./lib/probe-runtime.mjs";',
    "console.log(sha256('x'));",
    "",
  ].join("\n");
  const a = analyzeRuntimeResidency(src);
  assert.equal(a.resident, false);
  assert.deepEqual(a.violations, []);
});

test("B5: a resident probe correctly importing acquireEdgeSlot is not flagged as writing its own lock", () => {
  const src = RESIDENT_BASE.replace(
    'import { isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";\n',
    'import { isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";\n' +
      'import { acquireEdgeSlot } from "./lib/probe-edge-slot.mjs";\n',
  );
  assert.notEqual(src, RESIDENT_BASE, "mutation did not apply");
  const a = analyzeRuntimeResidency(src);
  assert.deepEqual(a.violations, []);
});

test("B6 MUTATION: a resident probe hand-rolling the lock file path is still caught", () => {
  const src = RESIDENT_BASE.replace(
    'import { isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";\n',
    'import { isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";\n' +
      'const LOCK_PATH = "Tools/visual-regression/output/.edge-slot.lock";\n',
  );
  assert.notEqual(src, RESIDENT_BASE, "mutation did not apply");
  const violations = analyzeRuntimeResidency(src).violations.map((v) => v.id);
  assert.deepEqual(violations, ["own-edge-slot-lock"]);
});

// ---------------------------------------------------------------------------
// C. The four-concern scan — mutation controls over REAL fleet source
// ---------------------------------------------------------------------------
//
// `A1`/`RESIDENT_BASE` prove the shapes on a fixture; a fixture cannot prove
// the detector survives contact with a real, comment-heavy, 500-line file —
// which is exactly the shape that produced the false-positive risk this
// contract's own header documents (the pilot probe's pre-migration prose
// narrating "the last good ...report.json survived"). These mutate the REAL
// pilot source in memory; nothing here is written to disk.

function pilotSource() {
  return readFileSync(join(HERE, PILOT_PROBE), "utf8");
}

test("C0: the pilot probe declares residency and is genuinely clean", () => {
  const a = analyzeRuntimeResidency(pilotSource());
  assert.equal(a.runtimeTag, RUNTIME_MODULE);
  assert.equal(a.resident, true);
  assert.deepEqual(a.violations, []);
});

test("C1: the pilot's own prose ('...report.json survived', '...refusal.json') does not trip the scan", () => {
  // Sanity-check the premise C0 relies on: the pilot's header comments
  // literally contain the filename substrings the receipt/refusal patterns
  // look for (this file's own header explains why). A raw-text scan would
  // fail C0; the comment-aware scan must not.
  const source = pilotSource();
  assert.match(source, /-report\.json/);
  assert.match(source, /-refusal\.json/);
});

const CONCERN_INSERTIONS = Object.freeze({
  "own-hash-or-preflight": 'import { createHash } from "node:crypto";\n',
  "own-edge-slot-lock": 'const SCRATCH_LOCK = { flag: "wx" };\n',
  "own-refusal-or-incident-writer": "class ScratchRefusal extends Error {}\n",
  "own-receipt-writer": 'const SCRATCH_PATH = "scratch-report.json";\n',
});

for (const concern of RUNTIME_CONCERNS) {
  test(`C2 MUTATION [${concern.id}]: re-adding the hand-rolled shape in the REAL pilot source is caught, and clears when removed`, () => {
    const base = pilotSource();
    const insertion = CONCERN_INSERTIONS[concern.id];
    assert.ok(insertion, `no mutation wired for concern ${concern.id}`);
    const anchor = "const HARNESS_PATH";
    assert.ok(base.includes(anchor), "anchor line moved in the pilot probe");
    const mutated = base.replace(anchor, insertion + anchor);
    assert.notEqual(mutated, base, `${concern.id}: mutation did not apply`);

    const mutatedViolations = analyzeRuntimeResidency(mutated).violations.map(
      (v) => v.id,
    );
    assert.ok(
      mutatedViolations.includes(concern.id),
      `${concern.id}: mutated pilot source was not flagged (got ${mutatedViolations})`,
    );

    // Round trip: removing exactly the inserted line restores the base text
    // byte for byte, and clears the finding — proving the detector reacts to
    // the inserted SHAPE and not to some other side effect of editing the
    // file (a shifted line count, say).
    const restored = mutated.replace(insertion, "");
    assert.equal(
      restored,
      base,
      `${concern.id}: round trip did not restore base`,
    );
    assert.deepEqual(
      analyzeRuntimeResidency(restored).violations,
      [],
      `${concern.id}: restored source still reports a violation`,
    );
  });
}

// ---------------------------------------------------------------------------
// D. The fleet and the ratchet
// ---------------------------------------------------------------------------

test("D1: the fleet scan finds the pilot probe and marks it resident", () => {
  const scope = fleet();
  assert.ok(scope.names.includes(PILOT_PROBE));
  assert.equal(scope.analyses.get(PILOT_PROBE).resident, true);
});

test("D2: every probe in the real fleet is either clean or allowlisted — tag-resident probes against the four-concern scan, and any probe that imports runProbe against the tag itself", () => {
  const scope = fleet();
  const exempt = new Set(Object.keys(RUNTIME_RESIDENCY_ALLOWLIST));
  const residents = scope.names.filter((n) => scope.analyses.get(n).resident);
  console.log(
    `      scanned ${scope.names.length} probes; ${residents.length} declare @runtime residency`,
  );
  // Loop over the WHOLE fleet, not just tag-declared residents: a probe that
  // imports `runProbe` without the tag reports `missing-runtime-tag` while
  // `resident` stays false (see the module header), and this gate must still
  // catch it — that is the de-facto-residency case the tag-only loop missed.
  const offenders = [];
  for (const name of scope.names) {
    if (exempt.has(name)) {
      continue;
    }
    const violations = scope.analyses.get(name).violations;
    if (violations.length > 0) {
      offenders.push(`${name}: ${violations.map((v) => v.id).join("; ")}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `DX-02: a probe tagged @runtime ${RUNTIME_MODULE} must not re-implement a
concern the runtime already owns, and a probe that imports runProbe must
carry the tag. Import the runtime's own export instead of hand-rolling it. Do
NOT add the file to lib/runtime-residency-allowlist.mjs — that list is closed
and shrink-only.
Offenders:\n  ${offenders.join("\n  ")}`,
  );
});

test("D3: the allowlist and its independent snapshot are frozen, sorted data", () => {
  assert.ok(Object.isFrozen(RUNTIME_RESIDENCY_ALLOWLIST));
  assert.ok(Object.isFrozen(RUNTIME_RESIDENCY_ALLOWLIST_SNAPSHOT));
  assert.ok(Object.isFrozen(RUNTIME_RESIDENCY_ALLOWLIST_SNAPSHOT.members));
  for (const [name, reason] of Object.entries(RUNTIME_RESIDENCY_ALLOWLIST)) {
    assert.match(name, /^probe-.*\.mjs$/u);
    assert.equal(typeof reason, "string", `${name} has no reason`);
    assert.ok(reason.trim().length >= 20, `${name} has no useful reason`);
  }
});

test("D4: the measured fleet satisfies the complete allowlist ratchet", () => {
  assertRatchet(
    RUNTIME_RESIDENCY_ALLOWLIST,
    RUNTIME_RESIDENCY_ALLOWLIST_SNAPSHOT,
    fleet(),
  );
});

test("D5 MUTATION: a fabricated allowlist member is rejected", () => {
  const fabricated = "probe-zz-fabricated-resident.mjs";
  const grown = {
    ...RUNTIME_RESIDENCY_ALLOWLIST,
    [fabricated]: "fabricated mutation — added 2026-09-02",
  };
  assert.throws(
    () => assertRatchet(grown, RUNTIME_RESIDENCY_ALLOWLIST_SNAPSHOT, fleet()),
    /outside the frozen snapshot.*probe-zz-fabricated-resident/u,
  );
});

test("D6 MUTATION: growing the frozen snapshot member count is rejected", () => {
  const mutatedSnapshot = {
    size: RUNTIME_RESIDENCY_ALLOWLIST_SNAPSHOT.size,
    members: [
      ...RUNTIME_RESIDENCY_ALLOWLIST_SNAPSHOT.members,
      "probe-zz-fabricated-resident.mjs",
    ],
  };
  assert.throws(
    () => assertRatchet(RUNTIME_RESIDENCY_ALLOWLIST, mutatedSnapshot, fleet()),
    /snapshot has 1 members but records 0/u,
  );
});

test("D7 MUTATION: a repaired allowlist row is rejected as stale", () => {
  const scope = fleet();
  const patched = {
    names: scope.names,
    analyses: new Map(scope.analyses).set(PILOT_PROBE, { violations: [] }),
  };
  const grownAllowlist = Object.freeze({
    [PILOT_PROBE]: "synthetic pre-existing offender — added 2026-09-02",
  });
  const grownSnapshot = Object.freeze({
    size: 1,
    members: Object.freeze([PILOT_PROBE]),
  });
  assert.throws(() => {
    const findings = ratchetFindings(grownAllowlist, grownSnapshot, patched);
    // Reuse only the "repaired" half of assertRatchet's checks: the
    // digest/size guard above is keyed to the real (empty) snapshot and
    // would fire first for the wrong reason.
    assert.deepEqual(
      findings.repaired,
      [],
      `repaired files must be removed from the allowlist: ${findings.repaired}`,
    );
  }, /repaired files must be removed/u);
});

test("D8 MUTATION: a new non-allowlisted violation is rejected", () => {
  const scope = fleet();
  const mutatedScope = {
    names: scope.names,
    analyses: new Map(scope.analyses).set(PILOT_PROBE, {
      violations: [{ id: "own-hash-or-preflight", message: "synthetic" }],
    }),
  };
  assert.throws(
    () =>
      assertRatchet(
        RUNTIME_RESIDENCY_ALLOWLIST,
        RUNTIME_RESIDENCY_ALLOWLIST_SNAPSHOT,
        mutatedScope,
      ),
    new RegExp(`not allowlisted.*${PILOT_PROBE}`, "u"),
  );
});
