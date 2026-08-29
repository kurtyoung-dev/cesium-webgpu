// scripts/ensureCesiumTypeDefinitions.js
//
// @purpose Ensure Source/Cesium.d.ts exists before Sandcastle2's static build
//   copies it into the served tree, so the app's Monaco type-hint fetch does
//   not 404 (Q-127).
// @status ACTIVE
//
// THE GAP THIS CLOSES. `Source/Cesium.d.ts` is a build output produced only
// by `gulp buildTs` (aliased `npm run build-ts`), which shells out to jsdoc
// and tsc and is deliberately NOT part of the default `gulp build` task —
// `build()` in gulpfile.js calls `tsc()` (project type-checking) but never
// `buildTs()`/`createTypeScriptDefinitions()`, and `release` is the only
// task that runs both (`gulp.parallel(buildTs, buildDocs)` after
// `buildRelease`). `gulp -f gulpfile.apps.js buildSandcastle` did not call it
// either, so a tree built with the documented `npx gulp build` +
// `npm run build-sandcastle` sequence (migration_doc/DEBUGGING_GUIDE.md)
// never produced the file.
//
// Sandcastle2 needs it anyway: `packages/sandcastle/scripts/buildStatic.js`
// wires a `typesPath` for every import (including `cesium` ->
// `Source/Cesium.d.ts`) through to the `__VITE_TYPE_IMPORT_PATHS__` build
// define, and `packages/sandcastle/src/SandcastleEditor.tsx`'s `setTypes()`
// fetches each one on every demo load to feed Monaco's intellisense. The
// fetch's own try/catch cannot suppress the resulting console error, because
// the browser logs "Failed to load resource: the server responded with a
// status of 404" for the failed network request itself — that is emitted by
// the browser's network stack, not by anything the page's JS throws or
// catches. That is why every one of the 676 Sandcastle2 sweep rows failed on
// the exact same one console error, regardless of which demo was under test.
//
// The fix belongs at the build-dependency level, not the console-error
// predicate (CLAUDE.md Principle 9: fix the cause, don't teach the gate to
// ignore it, when the cause is reachable — and it is here). `buildSandcastle`
// (gulpfile.apps.js) now ensures the file exists before invoking
// `buildStatic`, generating it via `createTypeScriptDefinitions` (imported
// from gulpfile.js) when missing. The check is EXISTENCE-gated, not
// freshness-gated — deliberately cheap so a dev loop or CI run against a tree
// that already has the file (e.g. one that already ran `release` or
// `build-ts`) stays fast; jsdoc + tsc only run on a tree that genuinely lacks
// the definitions.

import { existsSync } from "node:fs";

/** Default path checked, relative to the repo root gulp/npm scripts run from. */
export const CESIUM_TYPE_DEFINITIONS_PATH = "Source/Cesium.d.ts";

/**
 * Pure predicate: does the on-disk state require (re)generating the type
 * definitions file. Kept separate from {@link ensureCesiumTypeDefinitions} so
 * the decision itself — not just the end-to-end wiring — can be asserted
 * against an injected filesystem stand-in.
 *
 * @param {string} [path] Path to check.
 * @param {(path: string) => boolean} [existsSyncFn] Injectable existence check.
 * @returns {boolean} True when generation is required.
 */
export function typeDefinitionsAreMissing(
  path = CESIUM_TYPE_DEFINITIONS_PATH,
  existsSyncFn = existsSync,
) {
  return !existsSyncFn(path);
}

/**
 * Ensure the Cesium.d.ts file the Sandcastle2 static build copies into the
 * served tree actually exists, generating it via the supplied `generate`
 * callback only when it is missing. Both the path and the generator are
 * injectable so the wiring itself — "generate exactly when missing, never
 * when present" — can be proven in a plain `node:test` without invoking
 * jsdoc/tsc (which `gulp buildTs`'s real generator shells out to).
 *
 * @param {object} [options]
 * @param {string} [options.path] Path to check/require.
 * @param {() => (void|Promise<void>)} [options.generate] Called only when the
 *   file is missing. Required in practice; a caller that omits it while the
 *   file is missing gets a thrown TypeError rather than a silently-skipped
 *   generation step.
 * @param {(path: string) => boolean} [options.existsSyncFn] Injectable
 *   existence check.
 * @returns {Promise<{generated: boolean}>} Whether generation ran.
 */
export async function ensureCesiumTypeDefinitions({
  path = CESIUM_TYPE_DEFINITIONS_PATH,
  generate,
  existsSyncFn = existsSync,
} = {}) {
  if (!typeDefinitionsAreMissing(path, existsSyncFn)) {
    return { generated: false };
  }
  if (typeof generate !== "function") {
    throw new TypeError(
      `${path} is missing and no generate() callback was supplied.`,
    );
  }
  await generate();
  return { generated: true };
}
