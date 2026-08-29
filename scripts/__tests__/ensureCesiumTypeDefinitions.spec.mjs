// ensureCesiumTypeDefinitions.spec.mjs — Q-127: Source/Cesium.d.ts must exist
// before the Sandcastle2 static build copies it into the served tree.
// @purpose Coverage for the missing-type-defs decision logic AND the gulpfile.apps.js
//   wiring that makes buildSandcastle call it before buildSandcastleApp.
// @status ACTIVE
//
// Run: node --test scripts/__tests__/ensureCesiumTypeDefinitions.spec.mjs
//
// TWO THINGS THIS PINS:
//
//   1. THE DECISION LOGIC. `ensureCesiumTypeDefinitions` must call its
//      `generate` callback exactly when the file is missing, and never when
//      it is present — proven with an injected existence check so no real
//      filesystem or jsdoc/tsc invocation is needed. A mutant that always
//      regenerates (ignoring the existence check) is exercised directly and
//      must fail the "does not run when present" assertion.
//
//   2. THE WIRING. `gulpfile.apps.js`'s `buildSandcastle` task must actually
//      call `ensureCesiumTypeDefinitions(...)` — and call it BEFORE
//      `buildSandcastleApp(...)`, which is what copies the file into the
//      served tree. This is checked by reading the real gulpfile.apps.js
//      source text (never by running gulp — the hard rule for this lane) and
//      also demonstrated against a synthetic "regressed" copy of that source
//      with the call removed, so the checker is proven able to fail.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CESIUM_TYPE_DEFINITIONS_PATH,
  ensureCesiumTypeDefinitions,
  typeDefinitionsAreMissing,
} from "../ensureCesiumTypeDefinitions.js";
import { createTypeScriptDefinitions } from "../../gulpfile.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const GULPFILE_APPS_PATH = join(REPO_ROOT, "gulpfile.apps.js");

// --- Group A: typeDefinitionsAreMissing --------------------------------

test("A1 reports missing when the injected existence check says so", () => {
  assert.equal(
    typeDefinitionsAreMissing("Source/Cesium.d.ts", () => false),
    true,
  );
});

test("A2 reports NOT missing when the injected existence check says present", () => {
  assert.equal(
    typeDefinitionsAreMissing("Source/Cesium.d.ts", () => true),
    false,
  );
});

test("A3 default path is Source/Cesium.d.ts (what the sandcastle build copies)", () => {
  assert.equal(CESIUM_TYPE_DEFINITIONS_PATH, "Source/Cesium.d.ts");
});

// --- Group B: ensureCesiumTypeDefinitions wiring ------------------------

test("B1 generates exactly once when the file is missing", async () => {
  let calls = 0;
  const result = await ensureCesiumTypeDefinitions({
    existsSyncFn: () => false,
    generate: () => {
      calls++;
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { generated: true });
});

test("B2 never generates when the file is already present", async () => {
  let calls = 0;
  const result = await ensureCesiumTypeDefinitions({
    existsSyncFn: () => true,
    generate: () => {
      calls++;
    },
  });
  assert.equal(calls, 0);
  assert.deepEqual(result, { generated: false });
});

test("B3 awaits an async generator before resolving", async () => {
  let settled = false;
  const result = await ensureCesiumTypeDefinitions({
    existsSyncFn: () => false,
    generate: async () => {
      await new Promise((r) => setTimeout(r, 5));
      settled = true;
    },
  });
  assert.equal(
    settled,
    true,
    "the promise must be awaited, not fired-and-forgotten",
  );
  assert.deepEqual(result, { generated: true });
});

test("B4 missing file + no generate callback throws instead of silently skipping", async () => {
  await assert.rejects(
    () => ensureCesiumTypeDefinitions({ existsSyncFn: () => false }),
    TypeError,
  );
});

test("B5 MUTANT: an always-regenerate implementation fails the present-case assertion", async () => {
  // Reproduces the exact defect this row exists to prevent: a helper that
  // ignores the existence check and regenerates unconditionally. Cheap to
  // write inline because the contract under test is "does NOT call generate
  // when present" — the one property an inertness mutant of the real
  // ensureCesiumTypeDefinitions (e.g. `if (false && missing) { skip }`) would
  // violate. The real implementation passes this same assertion in B2.
  async function alwaysRegenerate({ generate }) {
    await generate();
    return { generated: true };
  }
  let calls = 0;
  await alwaysRegenerate({ generate: () => calls++ });
  assert.throws(() => {
    assert.equal(calls, 0, "generate must not run when the file is present");
  });
});

// --- Group C: gulpfile.js actually exports the generator ----------------

test("C1 gulpfile.js exports createTypeScriptDefinitions as a function", () => {
  assert.equal(typeof createTypeScriptDefinitions, "function");
});

// --- Group D: gulpfile.apps.js wiring (source text, never executed) -----

/**
 * Extracts one exported async function's body as a substring, by locating
 * its declaration and the next top-level `export` after it (or EOF). Good
 * enough for gulpfile.apps.js's flat, unnested task-function layout — this
 * is a source-scan for a wiring PROOF, not a general JS parser.
 */
function extractExportedFunctionBody(source, name) {
  const startMarker = `export async function ${name}(`;
  const start = source.indexOf(startMarker);
  if (start === -1) {
    return null;
  }
  const rest = source.slice(start);
  const nextExportOffset = rest.slice(startMarker.length).search(/\nexport /);
  const end =
    nextExportOffset === -1
      ? source.length
      : start + startMarker.length + nextExportOffset;
  return source.slice(start, end);
}

/**
 * The wiring predicate under test: within a buildSandcastle body, does
 * ensureCesiumTypeDefinitions get called, and strictly before
 * buildSandcastleApp (the call that copies files into the served tree)?
 */
function buildSandcastleEnsuresTypeDefinitionsFirst(source) {
  const body = extractExportedFunctionBody(source, "buildSandcastle");
  if (body === null) {
    return { wired: false, reason: "buildSandcastle not found" };
  }
  const ensureIndex = body.indexOf("ensureCesiumTypeDefinitions(");
  const buildIndex = body.indexOf("buildSandcastleApp(");
  if (ensureIndex === -1) {
    return { wired: false, reason: "ensureCesiumTypeDefinitions not called" };
  }
  if (buildIndex === -1) {
    return { wired: false, reason: "buildSandcastleApp not called" };
  }
  if (ensureIndex > buildIndex) {
    return {
      wired: false,
      reason: "ensureCesiumTypeDefinitions called AFTER buildSandcastleApp",
    };
  }
  return { wired: true, reason: "ensureCesiumTypeDefinitions runs first" };
}

test("D1 gulpfile.apps.js imports ensureCesiumTypeDefinitions", () => {
  const source = readFileSync(GULPFILE_APPS_PATH, "utf8");
  assert.match(
    source,
    /import\s*\{\s*ensureCesiumTypeDefinitions\s*\}\s*from\s*["']\.\/scripts\/ensureCesiumTypeDefinitions\.js["']/,
  );
});

test("D2 buildSandcastle calls ensureCesiumTypeDefinitions before buildSandcastleApp", () => {
  const source = readFileSync(GULPFILE_APPS_PATH, "utf8");
  const verdict = buildSandcastleEnsuresTypeDefinitionsFirst(source);
  assert.equal(verdict.wired, true, verdict.reason);
});

test("D3 MUTANT: the wiring check goes red when the call is removed", () => {
  const source = readFileSync(GULPFILE_APPS_PATH, "utf8");
  const body = extractExportedFunctionBody(source, "buildSandcastle");
  assert.ok(body, "precondition: buildSandcastle body must be extractable");
  const regressed = source.replace(
    body,
    body
      .split("\n")
      .filter((line) => !line.includes("ensureCesiumTypeDefinitions("))
      .join("\n"),
  );
  const verdict = buildSandcastleEnsuresTypeDefinitionsFirst(regressed);
  assert.equal(verdict.wired, false);
  assert.match(verdict.reason, /not called/);
});

test("D4 MUTANT: the wiring check goes red when the call is reordered after the copy", () => {
  const source = readFileSync(GULPFILE_APPS_PATH, "utf8");
  const body = extractExportedFunctionBody(source, "buildSandcastle");
  assert.ok(body, "precondition: buildSandcastle body must be extractable");
  // Move the ensure-call line to just before the closing brace, i.e. after
  // the buildSandcastleApp() call it is supposed to precede.
  const lines = body.split("\n");
  const ensureLineIndex = lines.findIndex((l) =>
    l.includes("ensureCesiumTypeDefinitions("),
  );
  assert.ok(ensureLineIndex !== -1, "precondition: ensure call present");
  const [ensureLine] = lines.splice(ensureLineIndex, 1);
  lines.splice(lines.length - 1, 0, ensureLine);
  const regressed = source.replace(body, lines.join("\n"));
  const verdict = buildSandcastleEnsuresTypeDefinitionsFirst(regressed);
  assert.equal(verdict.wired, false);
  assert.match(verdict.reason, /AFTER buildSandcastleApp/);
});
