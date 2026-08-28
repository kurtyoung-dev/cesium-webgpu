// cloud-temporal-source-view.spec.mjs — the cloud temporal bind groups must be
// keyed on the identity of the half-resolution view they bind, not merely on
// being present and not merely on its size.
// @purpose Pins that both cloud temporal bind-group pairs rebuild when the half-res target is replaced at an unchanged size, and that the check is live rather than inert.
// @status ACTIVE
//
// Pure Node (`node --test`). No browser, no build, no adapter.
//
// WHY THIS EXISTS
// ---------------
// A bind group captures its texture views by identity. The half-resolution
// cloud target is destroyed and recreated whenever the resolved half size
// changes, so a pair built against one target and a target of the same
// dimensions allocated afterwards are different GPU resources that compare
// equal on every dimension a size check can see.
//
// That gap was reachable, and on the default path. The temporal history is only
// re-examined on frames that run temporal reprojection; a morph between scene
// modes suspends reprojection but does NOT suspend the half-resolution march.
// So a half size that changes during a morph and changes back before the morph
// ends restores the recorded size, and the size-keyed reset never fires — while
// both pairs still hold views into a texture destroyed partway through. The
// consuming pair could not save itself either: it is keyed on the attachment
// generation, and the attachment allocation is gated on the same reprojection
// flag the morph clears, so that generation cannot advance during the excursion.
// Both tiers that enable temporal accumulation also ship a half-resolution
// scale, so this was the shipped configuration, and the failure is a persistent
// total loss of the cloud frame rather than a transient artifact.
//
// WHAT IT PINS
// ------------
//   A. BEHAVIOUR. The rebuild decision is executed over the real A -> B -> A2
//      sequence. The load-bearing case is the LAST one: a target reallocated at
//      the SAME size, with both groups still present, must still rebuild. A
//      presence check and a size check both answer "no rebuild" there.
//   B. THE CHECK IS LIVE. The same contract is run against two mutants of the
//      helper source and must FAIL against both — an ABSENCE mutant with the
//      comparison deleted, and an INERTNESS mutant in which the comparison is
//      still present but its result is discarded. A spec that survives its
//      inert mutant has asserted nothing about the code being reached.
//   C. THE CHECK IS WIRED. Both call sites in the cloud renderer must consult
//      the helper AND record the view afterwards, and the superseded
//      presence-only guard must be gone. A helper that is correct but unwired
//      is the same outage.
//
// Run: node --test Tools/visual-regression/cloud-temporal-source-view.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const enginePath = (p) => path.join(root, "packages/engine/Source", p);

// Multi-line source anchors below are written with LF. The checkout is CRLF on
// Windows working trees, so normalize or every anchor silently misses.
const readEngine = (p) =>
  fs.readFileSync(enginePath(p), "utf8").replace(/\r\n/g, "\n");

const LEAF = "Renderer/WebGPU/WebGPUCloudReconstructionAttachments.ts";
const leafSource = readEngine(LEAF);
const cloudRenderer = readEngine(
  "Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
);

const toDataUrl = (code) =>
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;

/** Transpiles LEAF TS source text (no relative imports) to an importable URL. */
async function importLeafSource(source) {
  const { code } = await transform(source, {
    loader: "ts",
    format: "esm",
    target: "es2022",
  });
  return import(toDataUrl(code));
}

// The single line the two mutants below rewrite. Asserted unique so a rename
// cannot silently turn either mutant into a no-op that "passes".
const DECISION_LINE = "  return recordedSourceView !== currentSourceView;";

const real = await importLeafSource(leafSource);
const { cloudBindGroupsNeedRebuild } = real;

/**
 * The contract, as a function of the decision procedure, so the identical
 * assertions can run against the real helper and against its mutants.
 */
function runBehaviouralContract(needRebuild) {
  const viewA = { id: "half-view-A" };
  const viewB = { id: "half-view-B" };
  // A NEW view over a NEW texture, at the same size as viewA.
  const viewA2 = { id: "half-view-A-reallocated" };
  const pair = [{ id: "group-read-0" }, { id: "group-read-1" }];

  // An unbuilt or half-built pair always rebuilds, as before the fix.
  assert.equal(
    needRebuild([null, null], null, viewA),
    true,
    "an unbuilt pair must rebuild",
  );
  assert.equal(
    needRebuild([pair[0], null], viewA, viewA),
    true,
    "a half-built pair must rebuild",
  );

  // Steady state: same target, both groups present. Rebuilding here every frame
  // would be the allocation churn the pair exists to avoid.
  assert.equal(
    needRebuild(pair, viewA, viewA),
    false,
    "an unchanged target must NOT rebuild",
  );

  // The excursion. Away from the recorded size, the size check would also have
  // caught this one.
  assert.equal(
    needRebuild(pair, viewA, viewB),
    true,
    "a target replaced at a different size must rebuild",
  );

  // THE LOAD-BEARING CASE. Back at the recorded size, with both groups present,
  // against a target that is nonetheless a different GPU resource. Presence
  // says no rebuild; size says no rebuild; only identity says otherwise.
  assert.equal(
    needRebuild(pair, viewA, viewA2),
    true,
    "a target reallocated at the SAME size is a different resource and must rebuild",
  );

  // Once the rebuild records the live view, steady state resumes.
  assert.equal(
    needRebuild(pair, viewA2, viewA2),
    false,
    "the recorded view must settle after a rebuild",
  );
}

/** Assert `re` matches `source`, and that it STOPS matching a mutated copy. */
function pinWithMutant(source, re, mutate, label) {
  assert.match(source, re, `missing: ${label}`);
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `mutation was a no-op for: ${label}`);
  assert.doesNotMatch(
    mutated,
    re,
    `the check for "${label}" does not actually detect its own mutant`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Behaviour
// ─────────────────────────────────────────────────────────────────────────────

test("A1 the helper is exported from the leaf and is a function", () => {
  assert.equal(typeof cloudBindGroupsNeedRebuild, "function");
});

test("A2 the rebuild decision holds over the whole excursion", () => {
  runBehaviouralContract(cloudBindGroupsNeedRebuild);
});

test("A3 the decision is pure: repeated calls do not mutate the inputs", () => {
  const view = { id: "v" };
  const pair = Object.freeze([{ id: "a" }, { id: "b" }]);
  assert.equal(cloudBindGroupsNeedRebuild(pair, view, view), false);
  assert.equal(cloudBindGroupsNeedRebuild(pair, view, view), false);
  assert.equal(cloudBindGroupsNeedRebuild(pair, view, { id: "v" }), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// B. The check is live — the contract must fail against its own mutants
// ─────────────────────────────────────────────────────────────────────────────

test("B0 the mutation anchor is present exactly once", () => {
  assert.equal(
    leafSource.split(DECISION_LINE).length - 1,
    1,
    "the decision line moved or was renamed; both mutants below would be no-ops",
  );
});

test("B1 an ABSENCE mutant (comparison deleted) fails the contract", async () => {
  const mutated = leafSource.replace(DECISION_LINE, "  return false;");
  assert.notEqual(mutated, leafSource);
  const { cloudBindGroupsNeedRebuild: absent } =
    await importLeafSource(mutated);
  assert.throws(
    () => runBehaviouralContract(absent),
    /must rebuild/,
    "the contract passes with the comparison deleted, so it tests nothing",
  );
});

test("B2 an INERTNESS mutant (comparison present, result discarded) fails", async () => {
  // The comparison is still written, and still evaluated. Only its RESULT is
  // dropped, leaving the pre-fix presence-only answer. This is the mutant a
  // source-text grep for the comparison cannot distinguish from the fix.
  const inert = [
    "  const replaced = recordedSourceView !== currentSourceView;",
    "  void replaced;",
    "  return false;",
  ].join("\n");
  const mutated = leafSource.replace(DECISION_LINE, inert);
  assert.notEqual(mutated, leafSource);
  assert.match(
    mutated,
    /recordedSourceView !== currentSourceView/,
    "the inert mutant must still CONTAIN the comparison, or it is just B1",
  );
  const { cloudBindGroupsNeedRebuild: dead } = await importLeafSource(mutated);
  assert.throws(
    () => runBehaviouralContract(dead),
    /must rebuild/,
    "the contract passes when the result of the comparison is discarded",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// C. The check is wired into both call sites
// ─────────────────────────────────────────────────────────────────────────────

test("C1 the resolve pair consults the helper and records the view", () => {
  pinWithMutant(
    cloudRenderer,
    /cloudBindGroupsNeedRebuild\(\n\s*cache\.temporalBindGroups,\n\s*cache\.temporalBindGroupSourceView,\n\s*cache\.halfView,\n\s*\)/,
    (s) =>
      s.replace(
        "cache.temporalBindGroupSourceView,\n      cache.halfView,",
        "cache.halfView,",
      ),
    "resolve pair consults cloudBindGroupsNeedRebuild with its recorded view",
  );
  pinWithMutant(
    cloudRenderer,
    /cache\.temporalBindGroupSourceView = cache\.halfView;/,
    (s) => s.replace("cache.temporalBindGroupSourceView = cache.halfView;", ""),
    "resolve pair records the view it was built against",
  );
});

test("C2 the consuming pair consults the helper and records the view", () => {
  pinWithMutant(
    cloudRenderer,
    /cloudBindGroupsNeedRebuild\(\n\s*cache\.temporalConsumeBindGroups,\n\s*cache\.temporalConsumeBindGroupSourceView,\n\s*cache\.halfView,\n\s*\)/,
    (s) =>
      s.replace(
        "cache.temporalConsumeBindGroupSourceView,\n      cache.halfView,",
        "cache.halfView,",
      ),
    "consuming pair consults cloudBindGroupsNeedRebuild with its recorded view",
  );
  pinWithMutant(
    cloudRenderer,
    /cache\.temporalConsumeBindGroupSourceView = cache\.halfView;/,
    (s) =>
      s.replace(
        "cache.temporalConsumeBindGroupSourceView = cache.halfView;",
        "",
      ),
    "consuming pair records the view it was built against",
  );
});

test("C3 the superseded presence-only guard is gone", () => {
  assert.doesNotMatch(
    cloudRenderer,
    /\(!cache\.temporalBindGroups\[0\] \|\| !cache\.temporalBindGroups\[1\]\)/,
    "the presence-only rebuild guard is back; it cannot see a same-size replacement",
  );
  assert.doesNotMatch(
    cloudRenderer,
    /!cache\.temporalConsumeBindGroups\[0\] \|\|\n\s*!cache\.temporalConsumeBindGroups\[1\] \|\|/,
    "the consuming presence-only rebuild guard is back",
  );
});

test("C4 every site that drops a pair also drops its recorded view", () => {
  // Leaving a recorded view behind after nulling the groups is not itself an
  // outage — a null group forces the rebuild anyway — but it strands a
  // reference to a destroyed texture on the cache, which is what the teardown
  // and release paths exist to avoid.
  const dropsResolve = cloudRenderer.match(
    /cache\.temporalBindGroups = \[null, null\];/g,
  );
  const clearsResolve = cloudRenderer.match(
    /cache\.temporalBindGroupSourceView = null;/g,
  );
  assert.ok(dropsResolve.length >= 2, "expected the reset and teardown sites");
  assert.equal(
    clearsResolve.length,
    dropsResolve.length,
    "a site drops the resolve pair without clearing its recorded view",
  );

  const dropsConsume = cloudRenderer.match(
    /cache\.temporalConsumeBindGroups = \[null, null\];/g,
  );
  const clearsConsume = cloudRenderer.match(
    /cache\.temporalConsumeBindGroupSourceView = null;/g,
  );
  assert.ok(dropsConsume.length >= 2, "expected the reset and release sites");
  assert.equal(
    clearsConsume.length,
    dropsConsume.length,
    "a site drops the consuming pair without clearing its recorded view",
  );
});
