// probe-fleet-contract.spec.mjs — AUTHORING-TIME enforcement of the probe
// machine-safety contract. Pure Node: no browser, no network, no GPU.
//
// THE GAP THIS CLOSES. `DEFERRED_WORK.md`'s 2026-08-07 machine-safety sweep
// found 11 of 34 recently-added probes with NO watchdog, 5 of them also closing
// the browser outside any `try/finally`, and filed the real residual in its own
// words: "the sweep was manual, so the next batch of probes can reintroduce it.
// A source-anchor spec over `Tools/visual-regression/probe-*.mjs` requiring both
// constructs would close it permanently." This is that spec.
//
// HOW IT IS SUPPOSED TO FEEL. A NEW probe that ships without a watchdog fails
// this spec. An OLD probe that already shipped without one is in
// `lib/probe-fleet-contract-allowlist.mjs` with a one-line reason. Repairing an
// old probe requires deleting its allowlist row in the same change, because the
// spec also asserts every allowlisted probe STILL violates — the list can only
// shrink. That ratchet is the whole design: an allowlist that can silently
// accumulate is the mechanism it was meant to replace.
//
// WHY THE DETECTORS ARE MUTANT-TESTED FIRST. This repo has repeatedly paid for
// instruments that could not fail: a probe reading a field name that does not
// exist, a gate differencing a metric pinned at its bound, a reachability
// assertion naming a variable held at zero. A source-anchor spec is exactly that
// shape of instrument, so the analyzer is run against synthetic sources that
// SHOULD trip it before it is ever run against the fleet, and the fleet
// assertions are paired with a MUTATION control that strips the watchdog out of
// a copy of a compliant probe's source and requires the violation to reappear.
//
// CRLF: this repo checks out with `core.autocrlf=true`. `blankNonCode`
// normalizes line endings before any offset arithmetic; assertions here never
// anchor on a bare "\n".

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  analyzeProbeSource,
  blankNonCode,
  browserIdentifiers,
  finallyBodies,
  findExitSites,
  hasStructuralTier,
  hasWatchdog,
  innermostGuard,
  matchBrace,
  scanEndsInCode,
  stringLiteralSpans,
  structuralRoutedToTwo,
  verdictExitViolations,
} from "./lib/probe-fleet-contract.mjs";
import { PROBE_CONTRACT_ALLOWLIST } from "./lib/probe-fleet-contract-allowlist.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// `.spec.mjs` files are browser-free guards, not probes — and this file is
// itself named `probe-fleet-contract.spec.mjs`, so a naive `probe-*.mjs` glob
// puts the spec in its own fleet and reports itself as a violator.
const probeFiles = readdirSync(HERE)
  .filter(
    (f) =>
      f.startsWith("probe-") && f.endsWith(".mjs") && !f.endsWith(".spec.mjs"),
  )
  .sort();

const readProbe = (name) => readFileSync(join(HERE, name), "utf8");

/** Analysis cache — 620 files parsed once, not once per assertion. */
const analyses = new Map();
for (const f of probeFiles) {
  analyses.set(f, analyzeProbeSource(readProbe(f)));
}

/**
 * Whether a probe reaches a structural exit tier, following the ONE hop into
 * its own extracted verdict module.
 *
 * The fleet's two reference implementations both put the fold in `lib/`:
 * `probe-celestial-gates.mjs` exits through `EXIT_CODE.STRUCTURAL` and
 * `probe-c11-205-lifecycle-v2.mjs` through `combined.exitCode` computed in
 * `lib/c11-205-evidence.mjs`. A source anchor that reads only the probe file
 * would report the two probes that DEFINE the pattern as not having it.
 *
 * Watchdog and close-in-`finally` are deliberately NOT resolved this way — both
 * must live in the process that owns the browser.
 *
 * @param {string} name Probe file name.
 * @returns {boolean} True when the probe or its local lib declares exit 3.
 */
function declaresStructuralExitDeep(name) {
  if (analyses.get(name)?.declaresStructuralExit) {
    return true;
  }
  const source = readProbe(name).replaceAll("\r\n", "\n");
  const imports = [
    ...source.matchAll(/from\s*["'](\.\/lib\/[\w.-]+\.mjs)["']/g),
  ];
  for (const [, rel] of imports) {
    const abs = resolve(HERE, rel);
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (
      /\bexitCode\s*:\s*3\b/.test(text) ||
      analyzeProbeSource(text).declaresStructuralExit
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fixtures: the minimum shape of a compliant probe, and the ways it goes wrong.
// ---------------------------------------------------------------------------

const COMPLIANT = `
import { chromium } from "playwright";
const WATCHDOG_MS = 420_000;
const watchdog = setTimeout(() => {
  console.error("watchdog fired");
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref?.();
const browser = await chromium.launch({ channel: "msedge" });
let structural = [];
try {
  const page = await browser.newPage();
  await page.goto("http://localhost:8080/");
} finally {
  await browser.close();
}
clearTimeout(watchdog);
if (structural.length > 0) {
  process.exit(3);
}
process.exit(0);
`;

const NO_WATCHDOG = COMPLIANT.replace(
  /const watchdog = setTimeout\([\s\S]*?\}, WATCHDOG_MS\);\nwatchdog\.unref\?\.\(\);\n/,
  "",
).replace("clearTimeout(watchdog);\n", "");

const CLOSE_OUTSIDE_FINALLY = COMPLIANT.replace(
  "} finally {\n  await browser.close();\n}",
  "}\nawait browser.close();",
);

const NEVER_CLOSES = COMPLIANT.replace("  await browser.close();\n", "");

const STRUCTURAL_TO_TWO = COMPLIANT.replace(
  "if (structural.length > 0) {\n  process.exit(3);\n}",
  "if (structural.length > 0) {\n  process.exit(2);\n}\nprocess.exit(3);",
);

/**
 * A `setTimeout` that yields rather than exits is NOT a watchdog. Probes are
 * full of these (`await new Promise((r) => setTimeout(r, 0))`), and a detector
 * that counts them would certify the whole fleet as compliant.
 */
const YIELD_TIMEOUT_ONLY = NO_WATCHDOG.replace(
  'await page.goto("http://localhost:8080/");',
  'await page.goto("http://localhost:8080/");\n  await new Promise((r) => setTimeout(r, 0));\n  await new Promise((r) => { setTimeout(() => { r(); }, 16); });',
);

/**
 * The word "watchdog" in a comment or a printed string is not a watchdog. The
 * pinned weather probes print `STRUCTURAL: ...` from their exception handler,
 * which is what made a naive text scan report them as contract violators.
 */
const PROSE_ONLY = `
import { chromium } from "playwright";
// This probe has a watchdog and calls process.exit(2) on timeout.
const browser = await chromium.launch();
console.error("watchdog fired after 420000 ms; process.exit(2)");
/* setTimeout(() => { process.exit(2); }, 1000); */
await browser.close();
`;

// ---------------------------------------------------------------------------
// A. The analyzer's own primitives
// ---------------------------------------------------------------------------

test("A1: blankNonCode preserves length and offsets", () => {
  const src = 'const a = 1; // x\nconst b = "hello";\n/* c */\n';
  const out = blankNonCode(src);
  assert.equal(out.length, src.replaceAll("\r\n", "\n").length);
  assert.equal(
    out.split("\n").length,
    src.replaceAll("\r\n", "\n").split("\n").length,
  );
  assert.ok(out.includes("const a = 1;"));
  assert.ok(!out.includes("hello"));
});

test("A2: blankNonCode erases comment and string interiors", () => {
  const out = blankNonCode(PROSE_ONLY);
  assert.ok(
    !/process\.exit/.test(out),
    "commented/quoted exits must be erased",
  );
});

test("A3: blankNonCode keeps template-literal EXPRESSIONS as code", () => {
  // `${...}` holes are real code; a probe can (and does) call helpers there.
  const out = blankNonCode("const s = `a ${process.exit(2)} b`;");
  assert.ok(/process\.exit/.test(out));
});

test("A4: matchBrace pairs nested blocks", () => {
  const s = "{ a { b } c }";
  assert.equal(matchBrace(s, 0), s.length - 1);
  assert.equal(matchBrace(s, 4), 8);
  assert.equal(matchBrace("a", 0), -1);
});

test("A5: findExitSites reads both exit forms and their code expressions", () => {
  const sites = findExitSites(
    blankNonCode(
      "process.exit(2); process.exitCode = pass ? 0 : 1; process.exit(structural ? 3 : 0);",
    ),
  );
  assert.equal(sites.length, 3);
  assert.equal(sites[0].expression, "2");
  assert.equal(sites[1].expression, "pass ? 0 : 1");
  assert.equal(sites[2].expression, "structural ? 3 : 0");
});

test("A5b: hasWatchdog needs a TERMINATING timer, not any timer", () => {
  assert.equal(
    hasWatchdog(blankNonCode("setTimeout(() => { process.exit(2); }, 1000);")),
    true,
  );
  assert.equal(
    hasWatchdog(
      blankNonCode("setTimeout(function () { process.exitCode = 2; }, 1000);"),
    ),
    true,
  );
  assert.equal(hasWatchdog(blankNonCode("setTimeout(resolve, 0);")), false);
  assert.equal(
    hasWatchdog(blankNonCode("setTimeout(() => { render(); }, 16);")),
    false,
  );
});

test("A5c: structuralRoutedToTwo distinguishes blindness from a crash", () => {
  assert.equal(
    structuralRoutedToTwo(
      blankNonCode("if (structural.length) { process.exit(2); }"),
    ).length,
    1,
  );
  assert.equal(
    structuralRoutedToTwo(blankNonCode("if (fatal) { process.exit(2); }"))
      .length,
    0,
  );
  assert.equal(
    structuralRoutedToTwo(blankNonCode("process.exit(laneBlind ? 2 : 0);"))
      .length,
    1,
  );
});

test("A6: browserIdentifiers finds the launched handle, not every variable", () => {
  assert.deepEqual(
    browserIdentifiers(
      blankNonCode("const decoderBrowser = await chromium.launch();"),
    ),
    ["decoderBrowser"],
  );
  assert.deepEqual(browserIdentifiers(blankNonCode("const x = 1;")), [
    "browser",
  ]);
});

test("A7: finallyBodies extracts only real finally blocks", () => {
  const bodies = finallyBodies(
    blankNonCode("try { a(); } finally { b(); }\nconst finallyish = 1;"),
  );
  assert.equal(bodies.length, 1);
  assert.ok(bodies[0].includes("b()"));
});

test("A8: innermostGuard returns the tightest enclosing condition", () => {
  const code = blankNonCode("if (outer) { if (inner) { process.exit(2); } }");
  const site = findExitSites(code)[0];
  assert.equal(innermostGuard(code, site.index).trim(), "inner");
});

test("A9: innermostGuard returns null for an unguarded site", () => {
  const code = blankNonCode("process.exit(2);");
  assert.equal(innermostGuard(code, findExitSites(code)[0].index), null);
});

test("A10: stringLiteralSpans reads the verdict out of a template hole", () => {
  // This is where the fleet actually spells its per-leg verdicts, so a span
  // reader that stopped at the outer backtick would see no PASS and no FAIL.
  const spans = stringLiteralSpans(
    'console.log(`(A) renders: ${ok ? "PASS" : "FAIL"}`);',
  );
  const contents = spans.map((s) => s.content);
  assert.ok(contents.includes("PASS"), `no PASS span: ${contents}`);
  assert.ok(contents.includes("FAIL"), `no FAIL span: ${contents}`);
  // The outer literal contributes its own text with the hole blanked, so the
  // identifiers inside `${…}` cannot be mistaken for printed words.
  const outer = contents.find((c) => c.includes("(A) renders:"));
  assert.ok(outer !== undefined);
  assert.ok(!/\bok\b/.test(outer), `hole leaked into printed text: ${outer}`);
});

test("A11: a regex literal with an unpaired quote does not blind the scanner", () => {
  // A regex may legally carry a lone quote. Read as a string opener it puts the
  // scanner into string mode for the whole REST OF THE FILE, and every
  // construct below reads as absent — which is how one real probe's
  // `process.exit` and another's `browser.close` disappeared from the census.
  const src = [
    'const PATTERNS = [/Destroyed texture \\[Texture "GlobeDepth-DepthCopy/];',
    "const pass = PATTERNS.length === 1;",
    "process.exit(pass ? 0 : 1);",
    "",
  ].join("\n");
  assert.equal(scanEndsInCode(src), true);
  const sites = findExitSites(blankNonCode(src));
  assert.equal(sites.length, 1);
  assert.equal(sites[0].expression, "pass ? 0 : 1");
});

test("A11b: division is still division, and a quoted exit is still quoted", () => {
  // The control for A11: a scanner that treats every `/` as a regex opener
  // would swallow the code between two divisions, and one that treats regex
  // bodies as code would resurrect the exits A2 requires it to erase.
  const divided =
    "const half = total / 2;\nconst r = (a + b) / c;\nprocess.exit(1);\n";
  assert.equal(scanEndsInCode(divided), true);
  assert.equal(findExitSites(blankNonCode(divided)).length, 1);
  const quoted = 'const hint = "call process.exit(1) yourself";\n';
  assert.deepEqual(findExitSites(blankNonCode(quoted)), []);
  const inRegex = "const re = /process\\.exit\\(1\\)/;\n";
  assert.deepEqual(findExitSites(blankNonCode(inRegex)), []);
});

test("A12 mutant: an unterminated string is reported, not papered over", () => {
  // scanEndsInCode is the canary for A11's failure mode, so it has to be able
  // to say no.
  assert.equal(scanEndsInCode('const s = "never closed;\n'), false);
  assert.equal(scanEndsInCode("const s = 1;\n"), true);
});

// ---------------------------------------------------------------------------
// B. Mutants — every rule stated once, then run against the wrong implementation
// ---------------------------------------------------------------------------

test("B1: the compliant fixture has ZERO violations", () => {
  const a = analyzeProbeSource(COMPLIANT);
  assert.deepEqual(a.violations, []);
  assert.equal(a.launchesBrowser, true);
  assert.equal(a.hasWatchdog, true);
  assert.equal(a.closeInFinally, true);
  assert.equal(a.declaresStructuralExit, true);
});

test("B2 mutant: a removed watchdog is detected", () => {
  const a = analyzeProbeSource(NO_WATCHDOG);
  assert.equal(a.hasWatchdog, false);
  assert.ok(a.violations.includes("no watchdog"));
});

test("B3 mutant: close moved out of finally is detected", () => {
  const a = analyzeProbeSource(CLOSE_OUTSIDE_FINALLY);
  assert.equal(a.closesBrowser, true);
  assert.equal(a.closeInFinally, false);
  assert.ok(a.violations.includes("browser.close outside finally"));
});

test("B4 mutant: a browser that is never closed is detected", () => {
  const a = analyzeProbeSource(NEVER_CLOSES);
  assert.ok(a.violations.includes("never closes the browser"));
});

test("B5 mutant: yield-shaped setTimeout is NOT counted as a watchdog", () => {
  // The over-permissive detector this guards against would report the entire
  // fleet compliant, since almost every probe yields via setTimeout somewhere.
  const a = analyzeProbeSource(YIELD_TIMEOUT_ONLY);
  assert.equal(a.hasWatchdog, false, "a yielding timer is not a watchdog");
});

test("B6 mutant: watchdog/exit prose in comments and strings is NOT the construct", () => {
  const a = analyzeProbeSource(PROSE_ONLY);
  assert.equal(a.hasWatchdog, false);
  assert.deepEqual(a.exitCodes, []);
});

test("B7 mutant: structural routed to exit 2 is detected", () => {
  const a = analyzeProbeSource(STRUCTURAL_TO_TWO);
  assert.equal(a.structuralRoutedToTwo.length, 1);
  assert.ok(a.violations.includes("structural routed to exit 2"));
});

test("B8: an EXCEPTION routed to exit 2 is correct and must NOT be flagged", () => {
  // This is the shape every pinned weather probe uses. Flagging it would make
  // the rule unfollowable — 2 is exactly where a thrown error belongs.
  const src = `
import { chromium } from "playwright";
const watchdog = setTimeout(() => { process.exit(2); }, 1000);
const browser = await chromium.launch();
let fatal = null;
let structural = [];
try { await browser.newPage(); } catch (error) { fatal = error; } finally { await browser.close(); }
if (fatal) { console.error("STRUCTURAL: " + fatal); process.exit(2); }
if (structural.length > 0) { process.exit(3); }
process.exit(0);
`;
  const a = analyzeProbeSource(src);
  assert.deepEqual(a.structuralRoutedToTwo, []);
  assert.deepEqual(a.violations, []);
});

test("B9: a probe that launches nothing is out of scope entirely", () => {
  const a = analyzeProbeSource("const x = 1;\nprocess.exit(0);\n");
  assert.equal(a.launchesBrowser, false);
  assert.deepEqual(a.violations, []);
});

test("B9b: hasStructuralTier accepts all four spellings the fleet uses", () => {
  const forms = {
    "literal exit": "process.exit(3);",
    "folded exit expression": "process.exitCode = structural ? 3 : 0;",
    "named constant": "process.exit(EXIT_CODE.STRUCTURAL);",
    "guarded return": "if (structural.length > 0) { return 3; }",
    "blind ternary": "const exitCode = laneBlind ? 3 : 0;",
    "lib verdict object": "return { verdict: 'STRUCTURAL', exitCode: 3 };",
  };
  for (const [label, src] of Object.entries(forms)) {
    assert.equal(
      hasStructuralTier(blankNonCode(src)),
      true,
      `missed: ${label}`,
    );
  }
});

test("B9c mutant: an UNGUARDED literal 3 is not a structural tier", () => {
  // The over-permissive detector this guards against would keep reporting the
  // tier as present after somebody deleted it, which is what an anchor exists
  // to prevent.
  assert.equal(hasStructuralTier(blankNonCode("const three = 3;")), false);
  assert.equal(
    hasStructuralTier(blankNonCode("function f() { return 3; }")),
    false,
  );
  assert.equal(
    hasStructuralTier(blankNonCode("const n = retries ? 3 : 0;")),
    false,
  );
  assert.equal(
    hasStructuralTier(blankNonCode("if (fatal) { return 3; }")),
    false,
    "an exception guard is exit 2's business, not a structural tier",
  );
});

test("B10 mutant rejection: every mutant is caught by at least one rule", () => {
  for (const [name, src] of [
    ["NO_WATCHDOG", NO_WATCHDOG],
    ["CLOSE_OUTSIDE_FINALLY", CLOSE_OUTSIDE_FINALLY],
    ["NEVER_CLOSES", NEVER_CLOSES],
    ["STRUCTURAL_TO_TWO", STRUCTURAL_TO_TWO],
    ["YIELD_TIMEOUT_ONLY", YIELD_TIMEOUT_ONLY],
  ]) {
    assert.ok(
      analyzeProbeSource(src).violations.length > 0,
      `mutant ${name} escaped every rule`,
    );
  }
});

// ---------------------------------------------------------------------------
// B'. The verdict-exit rule — a printed FAIL must be able to leave non-zero
// ---------------------------------------------------------------------------

/** The canonical shape: legs printed, verdict printed, verdict exited. */
const VERDICT_BOUND = [
  "const pass = renders && noErrs;",
  'console.log(`(A) renders: ${renders ? "PASS" : "FAIL"}`);',
  'console.log(pass ? "GATE PASS" : "GATE FAIL");',
  "process.exit(pass ? 0 : 1);",
  "",
].join("\n");

/** The defect: the verdict is computed, printed, and then dropped. */
const VERDICT_DROPPED = VERDICT_BOUND.replace(
  "process.exit(pass ? 0 : 1);\n",
  "",
);

/** The subtler defect: the only non-zero exit sits ABOVE the verdict. */
const VERDICT_EXIT_ABOVE = [
  "if (fatal) {",
  "  process.exit(2);",
  "}",
  'console.log(pass ? "GATE PASS" : "GATE FAIL");',
  "",
].join("\n");

/** Correct: an exitCode ASSIGNMENT applies wherever in the file it sits. */
const VERDICT_EXITCODE_ABOVE = [
  "process.exitCode = pass ? 0 : 1;",
  'console.log(pass ? "GATE PASS" : "GATE FAIL");',
  "",
].join("\n");

/** A per-item status column on a diagnostic dump is not a verdict. */
const DIAGNOSTIC_LABELS = [
  "for (const r of results) {",
  '  const status = r.error ? "CONSTRUCT-FAIL" : r.slow ? "PRIM-FAIL" : "OK";',
  "  console.log(status);",
  "}",
  "",
].join("\n");

test("B11: a verdict bound to an exit is clean", () => {
  assert.deepEqual(verdictExitViolations(VERDICT_BOUND), []);
  assert.deepEqual(analyzeProbeSource(VERDICT_BOUND).verdictExitViolations, []);
});

test("B12 mutant: a printed verdict with no non-zero exit is detected", () => {
  assert.deepEqual(verdictExitViolations(VERDICT_DROPPED), [
    "prints a PASS/FAIL verdict but no exit path can be non-zero",
  ]);
});

test("B13 mutant: a non-zero exit ABOVE the verdict does not carry it", () => {
  // `exit(2)` on a fatal branch is correct and stays; it just says nothing
  // about the verdict printed after it, which still leaves with status 0.
  assert.deepEqual(verdictExitViolations(VERDICT_EXIT_ABOVE), [
    "the last FAIL verdict print is followed by no non-zero exit",
  ]);
});

test("B14: process.exitCode above the print DOES carry the verdict", () => {
  // Position-independent by construction: the process leaves with whatever the
  // assignment last set, so demanding it appear below the print would be a
  // false rule that forces authors to move correct code.
  assert.deepEqual(verdictExitViolations(VERDICT_EXITCODE_ABOVE), []);
});

test("B15: a diagnostic dump with FAIL labels is NOT a verdict", () => {
  // Adoption of the exit-code contract is a maintainer ruling, so this rule
  // must fire on probes that took a POSITION (they print both outcomes), never
  // on probes that merely tabulate per-item status.
  assert.deepEqual(verdictExitViolations(DIAGNOSTIC_LABELS), []);
});

test("B16 mutant: FAIL in a comment or a regex is not a printed verdict", () => {
  const prose = [
    "// prints PASS or FAIL depending on the run",
    "/* FAIL means the gate is red, PASS means green */",
    "const re = /PASS|FAIL/;",
    "",
  ].join("\n");
  assert.deepEqual(verdictExitViolations(prose), []);
});

test("B17 mutant: exit(0) after the verdict is not an exit code", () => {
  const zeroOnly = `${VERDICT_DROPPED}process.exit(0);\n`;
  assert.deepEqual(verdictExitViolations(zeroOnly), [
    "prints a PASS/FAIL verdict but no exit path can be non-zero",
  ]);
});

// ---------------------------------------------------------------------------
// C. The fleet
// ---------------------------------------------------------------------------

test("C1: the fleet is non-empty and the census matches the recorded shape", () => {
  assert.ok(probeFiles.length > 500, `only ${probeFiles.length} probes found`);
  const launching = probeFiles.filter((f) => analyses.get(f).launchesBrowser);
  assert.ok(
    launching.length > probeFiles.length * 0.9,
    "the analyzer stopped recognising Playwright launches",
  );
});

test("C2: every non-allowlisted probe satisfies the contract", () => {
  const offenders = [];
  for (const f of probeFiles) {
    if (Object.hasOwn(PROBE_CONTRACT_ALLOWLIST, f)) {
      continue;
    }
    const a = analyses.get(f);
    if (a.violations.length > 0) {
      offenders.push(`${f}: ${a.violations.join("; ")}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `New probes must carry a watchdog (setTimeout -> process.exit) and close the
browser inside a finally. Add the constructs; do NOT add the probe to
lib/probe-fleet-contract-allowlist.mjs — that list is closed and shrink-only.
Offenders:\n  ${offenders.join("\n  ")}`,
  );
});

test("C3: the allowlist is a RATCHET — no stale entries, no repaired entries", () => {
  const present = new Set(probeFiles);
  const gone = [];
  const repaired = [];
  for (const name of Object.keys(PROBE_CONTRACT_ALLOWLIST)) {
    if (!present.has(name)) {
      gone.push(name);
      continue;
    }
    if (analyses.get(name).violations.length === 0) {
      repaired.push(name);
    }
  }
  assert.deepEqual(
    gone,
    [],
    `allowlist names files that no longer exist: ${gone}`,
  );
  assert.deepEqual(
    repaired,
    [],
    `these probes now satisfy the contract and MUST be deleted from the allowlist
in the same change that repaired them: ${repaired.join(", ")}`,
  );
});

test("C4: every allowlist entry carries a one-line reason", () => {
  for (const [name, reason] of Object.entries(PROBE_CONTRACT_ALLOWLIST)) {
    assert.equal(typeof reason, "string", `${name} has no reason`);
    assert.ok(
      reason.trim().length >= 20,
      `${name}'s reason is not a reason: ${reason}`,
    );
    assert.ok(!reason.includes("\n"), `${name}'s reason spans lines`);
    assert.match(
      reason,
      /added \d{4}-\d{2}-\d{2}/,
      `${name}'s reason must record when the probe was added`,
    );
  }
});

test("C5: the allowlist names the exact violations each probe still has", () => {
  // A reason that says "no watchdog" for a probe whose only defect is the
  // `finally` is a stale record, and a reader triaging the list would fix the
  // wrong thing. Every named construct must actually be missing.
  const mismatched = [];
  for (const [name, reason] of Object.entries(PROBE_CONTRACT_ALLOWLIST)) {
    const actual = analyses.get(name)?.violations ?? [];
    for (const v of actual) {
      if (!reason.includes(v)) {
        mismatched.push(`${name}: has "${v}" which the reason omits`);
      }
    }
    for (const claim of [
      "no watchdog",
      "browser.close outside finally",
      "never closes the browser",
      "structural routed to exit 2",
    ]) {
      if (reason.includes(claim) && !actual.includes(claim)) {
        mismatched.push(
          `${name}: reason claims "${claim}" which is no longer true`,
        );
      }
    }
  }
  assert.deepEqual(mismatched, [], mismatched.join("\n"));
});

test("C6: no probe declaring the 0/1/2/3 contract routes structural to exit 2", () => {
  // Unlike C2 this rule is NOT allowlisted. Conflating "the lane could not see
  // its subject" with "the harness broke" is a verdict defect, not inherited
  // machine-safety debt, and the fleet is currently clean of it.
  const offenders = probeFiles.filter((f) => {
    const a = analyses.get(f);
    return a.declaresStructuralExit && a.structuralRoutedToTwo.length > 0;
  });
  assert.deepEqual(offenders, []);
});

test("C7: the probes that DO implement the exit-3 contract keep implementing it", () => {
  // Anchored, not enumerated as a requirement: `PROBE-FLEET-EXIT3-CONTRACT-
  // ADOPTION` is a maintainer ruling, so this spec must not push adoption. It
  // only forbids a silent REGRESSION in the probes that already adopted.
  const adopted = [
    "probe-celestial-gates.mjs",
    "probe-sun-shadow-gate.mjs",
    "probe-c11-205-lifecycle-v2.mjs",
    "probe-cloud-shadows-polar.mjs",
    "probe-scene-snap.mjs",
    "probe-csm-soft-shadow.mjs",
    "probe-cold-optics-hq.mjs",
    "probe-logdepth-payoff.mjs",
    "probe-env-skybox-stars.mjs",
    "probe-skybox-star-modulation.mjs",
  ];
  for (const name of adopted) {
    assert.ok(analyses.get(name), `${name} is missing from the fleet`);
    assert.equal(
      declaresStructuralExitDeep(name),
      true,
      `${name} lost its exit-3 structural tier`,
    );
  }
});

test("C8 MUTATION control: stripping a compliant probe's watchdog is detected", () => {
  // The fleet assertions above pass trivially if the analyzer cannot see a
  // violation. Take a probe that is compliant TODAY, delete its watchdog from a
  // copy of its source, and require the violation to come back.
  const donor = probeFiles.find((f) => {
    const a = analyses.get(f);
    return a.violations.length === 0 && a.hasWatchdog && a.closeInFinally;
  });
  assert.ok(donor, "no compliant probe left to mutate");
  const src = readProbe(donor).replaceAll("\r\n", "\n");
  const mutated = src.replace(/setTimeout\(/, "queueMicrotask(");
  assert.notEqual(mutated, src, `${donor}: mutation did not apply`);
  const a = analyzeProbeSource(mutated);
  assert.equal(
    a.hasWatchdog,
    false,
    `${donor}: watchdog survived its own removal`,
  );
  assert.ok(a.violations.includes("no watchdog"));
});

test("C9 MUTATION control: moving a close out of finally is detected", () => {
  const donor = probeFiles.find((f) => {
    const a = analyses.get(f);
    return a.violations.length === 0 && a.closeInFinally;
  });
  assert.ok(donor, "no compliant probe left to mutate");
  const src = readProbe(donor).replaceAll("\r\n", "\n");
  // Replace EVERY `finally` — several probes have three, and mutating only the
  // first leaves the close still inside a surviving one, which would make this
  // control pass for the wrong reason.
  const mutated = src.replaceAll(/\bfinally\b/g, "catch (mutantError)");
  assert.notEqual(mutated, src, `${donor}: mutation did not apply`);
  const a = analyzeProbeSource(mutated);
  assert.equal(
    a.closeInFinally,
    false,
    `${donor}: finally survived its own removal`,
  );
});

test("C10: every probe that prints a verdict can leave with a non-zero code", () => {
  // NOT allowlisted, and deliberately so. A probe that prints GATE FAIL and
  // exits 0 does not merely fail to attribute a red — it reports one as GREEN
  // to every runner that scores by exit code, which is worse than printing
  // nothing at all. The fleet is clean of it, so the rule holds with no
  // exemptions and a new probe inherits the requirement automatically.
  const offenders = [];
  for (const f of probeFiles) {
    const v = analyses.get(f).verdictExitViolations;
    if (v.length > 0) {
      offenders.push(`${f}: ${v.join("; ")}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `A probe that prints PASS/FAIL must carry that verdict in its exit status:
0 pass, 1 gate fail, 2 the harness broke, 3 structural. Bind the verdict to
process.exit (or process.exitCode); do NOT delete the printed verdict to satisfy
this rule. Offenders:\n  ${offenders.join("\n  ")}`,
  );
});

test("C11 MUTATION control: deleting a probe's exits brings the violation back", () => {
  // C10 passes trivially if the rule cannot see a violation in real source.
  // Take a probe that prints a verdict and carries it TODAY, delete the exits
  // from a copy, and require the violation to reappear.
  const donor = probeFiles.find((f) => {
    const src = readProbe(f);
    return (
      /GATE (?:PASS|FAIL)/.test(src) &&
      analyses.get(f).verdictExitViolations.length === 0 &&
      analyses.get(f).exitCodes.length > 0
    );
  });
  assert.ok(donor, "no verdict-printing probe left to mutate");
  const src = readProbe(donor).replaceAll("\r\n", "\n");
  // `recordVerdict` is not a prefix or a superstring of the construct being
  // removed: the detector matches `process.exit` / `process.exitCode`, and
  // neither survives inside the replacement.
  const mutated = src.replaceAll("process.exit", "recordVerdict");
  assert.notEqual(mutated, src, `${donor}: mutation did not apply`);
  assert.ok(
    !/process\.exit/.test(mutated),
    `${donor}: an exit survived its own removal`,
  );
  assert.deepEqual(verdictExitViolations(mutated), [
    "prints a PASS/FAIL verdict but no exit path can be non-zero",
  ]);
});

test("C12 MUTATION control: the rule keys on the VERDICT, not on the exits", () => {
  // The converse direction. A probe with no exits and no verdict is silent —
  // adding ONLY the verdict print must make it speak, which proves C10 is not
  // secretly asserting "every probe must exit".
  const donor = probeFiles.find((f) => {
    const a = analyses.get(f);
    return (
      a.exitCodes.length === 0 &&
      a.verdictExitViolations.length === 0 &&
      !/\bFAIL\b/.test(readProbe(f))
    );
  });
  assert.ok(donor, "no exit-free diagnostic probe left to mutate");
  const src = readProbe(donor).replaceAll("\r\n", "\n");
  assert.deepEqual(verdictExitViolations(src), []);
  const mutated = `${src}\nconsole.log(ok ? "GATE PASS" : "GATE FAIL");\n`;
  assert.deepEqual(verdictExitViolations(mutated), [
    "prints a PASS/FAIL verdict but no exit path can be non-zero",
  ]);
});

test("C13: the scanner reaches the end of every probe still reading code", () => {
  // The analyzer reports what it cannot see as ABSENT, so a scan that dies
  // mid-file manufactures violations below the wound and hides real ones. A
  // source file cannot legally end inside a string, which makes this cheap to
  // assert and impossible to satisfy by accident.
  const blind = probeFiles.filter((f) => !scanEndsInCode(readProbe(f)));
  assert.deepEqual(
    blind,
    [],
    `the source scanner went blind partway through: ${blind.join(", ")}`,
  );
});
