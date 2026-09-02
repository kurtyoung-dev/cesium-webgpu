// purpose-header-contract.spec.mjs — AUTHORING-TIME enforcement of the
// `@purpose` self-registration rule. Pure Node: no browser, no network, no GPU.
//
// @purpose Contract spec for maintainer ruling M4: every probe and gate library must carry a readable @purpose/@status header.
// @status ACTIVE
//
// THE GAP THIS CLOSES. The 2026-08-14 .mjs library audit measured the fleet it
// was auditing: 642 probes, 380 of them documented nowhere, and four files
// documented in `DEBUGGING_GUIDE.md` that had already been deleted. The
// documentation was not merely behind — it had no mechanism that could keep up,
// because it was maintained by hand against a fleet that grows every batch.
// Ruling M2 replaced it with self-registration (each file declares its own
// purpose and status; the catalog is generated from those declarations) and
// ruling M4 made carrying the declaration a contract rule, "enforced where the
// contract already enforces structure". This spec is that enforcement.
//
// WHY IT IS A SEPARATE FILE FROM `probe-fleet-contract.spec.mjs`. That spec is
// owned by an in-flight lane. Two lanes editing one guard is how a guard stops
// being trustworthy, so the rule ships as its own driver over the same fleet and
// the same analyzer module. Nothing here reads or modifies that file.
//
// HOW IT IS SUPPOSED TO FEEL. A NEW probe that ships without a header fails this
// spec. An OLD probe that already shipped without one is named in
// `lib/purpose-header-allowlist.mjs`. Adding the header to an old probe requires
// deleting its allowlist row in the same change, because the spec also asserts
// every allowlisted file STILL lacks a header — the list can only shrink.
//
// THE HONEST WEAKNESS, STATED UP FRONT. At the snapshot the allowlist covers the
// ENTIRE in-scope fleet, because the codemod that writes the headers lands in a
// later batch. That makes the fleet leg (C2) vacuously true today, which is
// exactly the shape of instrument this repository has been burned by. Two things
// carry the detector instead: the synthetic mutants in group A, and C6, which
// runs the REAL injector over a REAL fleet file's source and requires the
// violation to disappear and then come back. A test named
// "coverage is recorded, not hidden" keeps the vacuity visible in the output
// rather than buried in a passing run.
//
// CRLF: this repo checks out with `core.autocrlf=true`. The grammar module
// keeps every line's own terminator, and A8 asserts a CRLF source and its LF
// twin parse identically.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PURPOSE_STATUSES,
  injectPurposeHeader,
  parsePurposeHeader,
  purposeHeaderViolations,
} from "../lib/purpose-header.mjs";
import {
  analyzePurposeHeaderSource,
  requiresPurposeHeader,
} from "./lib/probe-fleet-contract.mjs";
import {
  PURPOSE_HEADER_ALLOWLIST,
  PURPOSE_HEADER_ALLOWLIST_SNAPSHOT_SIZE,
} from "./lib/purpose-header-allowlist.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The in-scope fleet, read once, LAZILY.
 *
 * Charter 3.4 forbids filesystem work at import time: a spec that reads the
 * tree while being imported cannot fail STRUCTURAL cleanly, and cannot be
 * imported by another tool for its exports.
 *
 * @returns {{names: string[], analyses: Map<string, object>}} The fleet.
 */
let fleetCache = null;
function fleet() {
  if (fleetCache !== null) {
    return fleetCache;
  }
  const names = [];
  for (const name of readdirSync(HERE)) {
    if (requiresPurposeHeader(`Tools/visual-regression/${name}`)) {
      names.push(name);
    }
  }
  for (const name of readdirSync(join(HERE, "lib"))) {
    if (requiresPurposeHeader(`Tools/visual-regression/lib/${name}`)) {
      names.push(`lib/${name}`);
    }
  }
  names.sort();
  const analyses = new Map();
  for (const name of names) {
    analyses.set(
      name,
      analyzePurposeHeaderSource(readFileSync(join(HERE, name), "utf8")),
    );
  }
  fleetCache = { names, analyses };
  return fleetCache;
}

// ---------------------------------------------------------------------------
// Fixtures: the minimum shape of a registered file, and the ways it goes wrong.
// ---------------------------------------------------------------------------

const COMPLIANT_LINE = [
  "// probe-example.mjs — one-line title that happens to be a sentence.",
  "// @purpose Reproduces the example artifact at the saved view and diffs it.",
  "// @status ACTIVE",
  "//",
  "// Longer rationale below the stanza.",
  "",
  'import { chromium } from "playwright";',
  "",
].join("\n");

const COMPLIANT_JSDOC = [
  "/**",
  " * probe-example.mjs — reproducible example bake.",
  " *",
  " * @purpose Bakes the example asset from its pinned source and verifies it.",
  " * @status INVESTIGATION",
  " */",
  "",
  'import { chromium } from "playwright";',
  "",
].join("\n");

const COMPLIANT_SHEBANG = [
  "#!/usr/bin/env node",
  "// @purpose Runs the example lane and prints its verdict.",
  "// @status ARCHIVED-CANDIDATE",
  "",
  "const x = 1;",
  "",
].join("\n");

/** No header at all — the state of 652 files at the snapshot. */
const NO_HEADER = 'import { chromium } from "playwright";\nconst x = 1;\n';

/** The tag is in the file, but not in the FIRST comment block. */
const TAG_BELOW_THE_HEADER = [
  "// probe-example.mjs — a title.",
  "",
  'import { chromium } from "playwright";',
  "",
  "// @purpose This is far too late to be a header declaration.",
  "// @status ACTIVE",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// A. The grammar, and the ways it must fail
// ---------------------------------------------------------------------------

test("A1: a `//` header with both tags is compliant", () => {
  const a = analyzePurposeHeaderSource(COMPLIANT_LINE);
  assert.deepEqual(a.violations, []);
  assert.equal(a.status, "ACTIVE");
  assert.match(a.purpose, /^Reproduces the example artifact/);
});

test("A2: a JSDoc header with both tags is compliant", () => {
  const a = analyzePurposeHeaderSource(COMPLIANT_JSDOC);
  assert.deepEqual(a.violations, []);
  assert.equal(a.status, "INVESTIGATION");
});

test("A3: a header under a shebang is still the header", () => {
  const a = analyzePurposeHeaderSource(COMPLIANT_SHEBANG);
  assert.deepEqual(a.violations, []);
  assert.equal(a.status, "ARCHIVED-CANDIDATE");
});

test("A4 mutant: no header at all is detected", () => {
  const a = analyzePurposeHeaderSource(NO_HEADER);
  assert.equal(a.hasHeader, false);
  assert.ok(a.violations.includes("no @purpose header"));
  assert.ok(a.violations.includes("no @status header"));
});

test("A5 mutant: a @purpose with no @status is detected", () => {
  const src = COMPLIANT_LINE.replace("// @status ACTIVE\n", "");
  assert.notEqual(src, COMPLIANT_LINE, "mutation did not apply");
  assert.deepEqual(analyzePurposeHeaderSource(src).violations, [
    "no @status header",
  ]);
});

test("A6 mutant: a @status outside the vocabulary is detected", () => {
  const src = COMPLIANT_LINE.replace("@status ACTIVE", "@status MOSTLY_FINE");
  const a = analyzePurposeHeaderSource(src);
  assert.equal(a.violations.length, 1);
  assert.match(a.violations[0], /@status is not one of/);
  for (const value of PURPOSE_STATUSES) {
    assert.ok(a.violations[0].includes(value), `vocabulary omits ${value}`);
  }
});

test("A6a mutant: an unterminated header block is a violation, not a pass", () => {
  // The grammar has always RECORDED this failure; the contract dropped it on
  // the floor. A block comment that never closes swallows the rest of the
  // file, so the tags it appears to carry are not a header anyone can review.
  const src = [
    "/*",
    " * probe-example.mjs - a title.",
    " * @purpose Reproduces the example artifact at the saved view and diffs it.",
    " * @status ACTIVE",
    'import { chromium } from "playwright";',
    "",
  ].join("\n");
  const parsed = parsePurposeHeader(src);
  assert.equal(
    parsed.purpose,
    "Reproduces the example artifact at the saved view and diffs it.",
  );
  assert.equal(parsed.status, "ACTIVE");
  assert.deepEqual(purposeHeaderViolations(src), [
    "header block comment is never closed",
  ]);
});

test("A6b mutant: a duplicated tag is a violation, not a first-wins pass", () => {
  const src = COMPLIANT_LINE.replace(
    "// @status ACTIVE",
    "// @status ACTIVE\n// @status INVESTIGATION",
  );
  assert.notEqual(src, COMPLIANT_LINE, "mutation did not apply");
  const parsed = parsePurposeHeader(src);
  assert.equal(
    parsed.status,
    "ACTIVE",
    "the first spelling still wins the value",
  );
  assert.deepEqual(purposeHeaderViolations(src), [
    "duplicate @status in the header block",
  ]);
});

test("A6c: a parse failure carries a stable code beside its message", () => {
  // Consumers branch on the code; the message is for humans and may be
  // reworded without silently disabling a caller that matched on its text.
  const src = COMPLIANT_LINE.replace("@status ACTIVE", "@status MOSTLY_FINE");
  assert.deepEqual(
    parsePurposeHeader(src).errorDetails.map((detail) => detail.code),
    ["status-vocabulary"],
  );
});

test("A7 mutant: tags below the header block do NOT register", () => {
  // Fails CLOSED on purpose. A declaration that can hide anywhere in a
  // 2000-line probe is a declaration no reviewer can find, and the generator
  // would then publish a purpose that nobody reading the file's head can see.
  const a = analyzePurposeHeaderSource(TAG_BELOW_THE_HEADER);
  assert.equal(a.hasHeader, false);
  assert.equal(a.purpose, null);
});

test("A8: CRLF and LF sources parse identically", () => {
  const lf = parsePurposeHeader(COMPLIANT_LINE);
  const crlf = parsePurposeHeader(COMPLIANT_LINE.replaceAll("\n", "\r\n"));
  assert.equal(crlf.purpose, lf.purpose);
  assert.equal(crlf.status, lf.status);
  assert.deepEqual(crlf.errors, lf.errors);
});

test("A9 mutant: a stub @purpose is not a purpose", () => {
  const src = COMPLIANT_LINE.replace(/@purpose .*/, "@purpose does stuff");
  assert.deepEqual(purposeHeaderViolations(src), [
    "@purpose is not a sentence",
  ]);
});

test("A10: injection is idempotent — twice equals once", () => {
  const fields = {
    purpose: "Reproduces the artifact and diffs it.",
    status: "ACTIVE",
  };
  const once = injectPurposeHeader(NO_HEADER, fields);
  const twice = injectPurposeHeader(once.text, fields);
  assert.equal(once.action, "inserted");
  assert.equal(twice.action, "unchanged");
  assert.equal(twice.text, once.text);
  assert.equal((once.text.match(/@purpose/g) ?? []).length, 1);
});

// ---------------------------------------------------------------------------
// B. The scope rule
// ---------------------------------------------------------------------------

test("B1: the rule covers probes and gate libraries, and nothing else", () => {
  const cases = {
    "Tools/visual-regression/probe-globe.mjs": true,
    "Tools/visual-regression/lib/celestial-g1-gate.mjs": true,
    // The machine-safety guard is itself named `probe-*`; a naive glob would
    // put every guard inside its own fleet.
    "Tools/visual-regression/probe-fleet-contract.spec.mjs": false,
    "Tools/visual-regression/lib/same-task-capture.mjs": false,
    "Tools/visual-regression/capture-and-diff.mjs": false,
    "Tools/probe-elsewhere.mjs": false,
    "Tools/visual-regression/output/probe-scratch.mjs": false,
  };
  for (const [path, expected] of Object.entries(cases)) {
    assert.equal(requiresPurposeHeader(path), expected, path);
  }
});

// ---------------------------------------------------------------------------
// C. The fleet and the ratchet
// ---------------------------------------------------------------------------

/**
 * The ratchet's three findings, computed from data so the mutation control in
 * C7 can drive the SAME function with mutated inputs. A ratchet asserted by
 * inline code in one test and "controlled" by different inline code in another
 * proves nothing about the assertion that actually runs.
 *
 * @param {readonly string[]} allowlist Allowlisted names.
 * @param {number} snapshotSize The frozen census size.
 * @param {{names: string[], analyses: Map<string, object>}} scope The fleet.
 * @returns {{gone: string[], repaired: string[], grew: string|null, unsorted: string[], duplicated: string[]}} Findings.
 */
export function ratchetFindings(allowlist, snapshotSize, scope) {
  const present = new Set(scope.names);
  const gone = allowlist.filter((name) => !present.has(name));
  const repaired = allowlist.filter(
    (name) =>
      present.has(name) && scope.analyses.get(name).violations.length === 0,
  );
  const grew =
    allowlist.length > snapshotSize
      ? `allowlist grew from ${snapshotSize} to ${allowlist.length}`
      : null;
  const sorted = [...allowlist].sort();
  const unsorted = allowlist.filter((name, i) => name !== sorted[i]);
  const seen = new Set();
  const duplicated = allowlist.filter((name) =>
    seen.has(name) ? true : (seen.add(name), false),
  );
  return { gone, repaired, grew, unsorted, duplicated };
}

test("C1: the in-scope fleet is non-empty and matches the recorded shape", () => {
  const { names } = fleet();
  assert.ok(names.length > 300, `only ${names.length} in-scope files found`);
  const gateLibs = names.filter((n) => n.startsWith("lib/"));
  assert.ok(gateLibs.length > 0, "the gate-library half of the scope is empty");
  assert.ok(
    names.length - gateLibs.length > 300,
    "the probe half of the scope is empty",
  );
});

test("C2: every non-allowlisted probe and gate library carries a header", () => {
  const scope = fleet();
  const exempt = new Set(PURPOSE_HEADER_ALLOWLIST);
  const offenders = [];
  for (const name of scope.names) {
    if (exempt.has(name)) {
      continue;
    }
    const violations = scope.analyses.get(name).violations;
    if (violations.length > 0) {
      offenders.push(`${name}: ${violations.join("; ")}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Ruling M4: a probe or gate library declares its own purpose and lifecycle
status in its header, so the catalog can be regenerated from the tree. Add

  // @purpose <one sentence: what this file establishes>
  // @status ${PURPOSE_STATUSES.join(" | ")}

to the header block. Do NOT add the file to lib/purpose-header-allowlist.mjs —
that list is closed and shrink-only. Offenders:\n  ${offenders.join("\n  ")}`,
  );
});

test("C3: the allowlist is a RATCHET — no stale rows, no repaired rows", () => {
  const findings = ratchetFindings(
    PURPOSE_HEADER_ALLOWLIST,
    PURPOSE_HEADER_ALLOWLIST_SNAPSHOT_SIZE,
    fleet(),
  );
  assert.deepEqual(
    findings.gone,
    [],
    `the allowlist names files that are gone or no longer in scope: ${findings.gone}`,
  );
  assert.deepEqual(
    findings.repaired,
    [],
    `these files now carry a header and MUST be deleted from the allowlist in the
same change that added it: ${findings.repaired.join(", ")}`,
  );
});

test("C4: the allowlist cannot grow, is sorted, and has no duplicates", () => {
  const findings = ratchetFindings(
    PURPOSE_HEADER_ALLOWLIST,
    PURPOSE_HEADER_ALLOWLIST_SNAPSHOT_SIZE,
    fleet(),
  );
  assert.equal(findings.grew, null);
  assert.deepEqual(findings.unsorted, []);
  assert.deepEqual(findings.duplicated, []);
});

test("C5: coverage is recorded, not hidden", () => {
  // The point of this test is the number it prints. At the snapshot the
  // allowlist covers the whole fleet and C2 is vacuous; as the codemod lands,
  // `registered` climbs and `exempt` falls. The identity below holds at every
  // point on that path, and fails if a file is somehow neither.
  const scope = fleet();
  const exempt = new Set(PURPOSE_HEADER_ALLOWLIST);
  const registered = scope.names.filter(
    (n) => scope.analyses.get(n).violations.length === 0,
  );
  const covered = scope.names.filter((n) => exempt.has(n));
  console.log(
    `      in scope ${scope.names.length} · registered ${registered.length} · grandfathered ${covered.length}`,
  );
  assert.equal(
    registered.length + covered.length,
    scope.names.length,
    "a file is neither registered nor grandfathered",
  );
});

test("C6 MUTATION control: the rule is exercised over REAL fleet source", () => {
  // C2 passes trivially while the allowlist covers everything, so the detector
  // has to be proven on real source rather than on the synthetic fixtures
  // above. Take a real in-scope file, inject a header into a COPY through the
  // real injector, require the violation to clear — then delete the injected
  // line and require it to come back.
  const scope = fleet();
  let donor = scope.names.find(
    (n) => scope.analyses.get(n).violations.length > 0,
  );
  let source;
  if (donor) {
    source = readFileSync(join(HERE, donor), "utf8");
  } else {
    // A fully-headered fleet leaves no natural donor; synthesize the
    // violating state by stripping a real file's header so the control
    // keeps exercising the rule over real source.
    donor = scope.names[0];
    source = readFileSync(join(HERE, donor), "utf8")
      .replace(/^.*@purpose .*\r?\n/m, "")
      .replace(/^.*@status .*\r?\n/m, "");
  }
  assert.ok(purposeHeaderViolations(source).length > 0, `${donor} is clean`);

  const injected = injectPurposeHeader(source, {
    purpose: "Mutation-control copy: never written to disk.",
    status: "ACTIVE",
  });
  assert.equal(injected.action, "inserted");
  assert.deepEqual(
    purposeHeaderViolations(injected.text),
    [],
    `${donor}: a real file with a real header still reads as a violation`,
  );

  const stripped = injected.text.replace(/^.*@purpose .*\r?\n/m, "");
  assert.notEqual(stripped, injected.text, `${donor}: mutation did not apply`);
  assert.ok(
    purposeHeaderViolations(stripped).includes("no @purpose header"),
    `${donor}: the header survived its own removal`,
  );
});

test("C7 MUTATION control: a grown or stale ratchet is detected", () => {
  // Drives the SAME `ratchetFindings` that C3/C4 assert on, with mutated
  // inputs. An allowlist that can silently accumulate is the mechanism this
  // rule exists to replace, so the growth check must be shown to fire.
  const scope = fleet();
  const grown = [...PURPOSE_HEADER_ALLOWLIST, "probe-not-a-real-file.mjs"];
  const findings = ratchetFindings(
    grown,
    PURPOSE_HEADER_ALLOWLIST_SNAPSHOT_SIZE,
    scope,
  );
  assert.match(findings.grew ?? "", /allowlist grew from \d+ to \d+/);
  assert.deepEqual(findings.gone, ["probe-not-a-real-file.mjs"]);

  // And the repaired-row half: pretend one allowlisted file gained a
  // header. With the live list empty, a synthetic single-row list keeps
  // this half executable; its snapshot equals its length so only the
  // repaired signal can fire.
  const repairedName = PURPOSE_HEADER_ALLOWLIST[0] ?? scope.names[0];
  const repairList = PURPOSE_HEADER_ALLOWLIST.length
    ? PURPOSE_HEADER_ALLOWLIST
    : Object.freeze([repairedName]);
  const patched = {
    names: scope.names,
    analyses: new Map(scope.analyses).set(repairedName, { violations: [] }),
  };
  const afterRepair = ratchetFindings(repairList, repairList.length, patched);
  assert.deepEqual(afterRepair.repaired, [repairedName]);
});
