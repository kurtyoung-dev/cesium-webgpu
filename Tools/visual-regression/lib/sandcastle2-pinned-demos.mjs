// sandcastle2-pinned-demos.mjs — pure helpers for auditing which Sandcastle2
// gallery demos pin their own renderer via `contextOptions.renderer`. No
// browser, no network, no filesystem beyond the gallery listing.
//
// @purpose Derive, comment-aware, which gallery demos construct their Viewer/CesiumWidget with an explicit contextOptions.renderer, and classify HOW (Q-133).
// @status ACTIVE
//
// THE GAP THIS CLOSES. Two prior counts of "how many demos pin a renderer"
// disagreed — 32 vs 30 — because a naive text scan for `renderer: "webgpu"`
// (or `"webgl"`) counts a match inside a `//` comment the same as a match
// inside real code. Two gallery demos — `atmospheric-conditions` and
// `volumetric-effects` — document the pin pattern in a comment ("To force a
// backend, pass `contextOptions: { renderer: "webgpu" }` here.") without
// actually passing it; a comment-blind scan miscounts them as pinned, which
// is exactly the 32-vs-30 gap. (The historical "32" is NOT reproduced by
// this naive method, which lands on 29: it over-counts these two comment-only
// demos and under-counts the three param-defaulted ones. What IS verified
// against the live gallery is the comment-aware count of 30 and the identity
// of the two over-counted ids — see the spec's A3 assertion.) This module strips
// comments/strings before matching (reusing the same {@link
// stripJsSourceComments} the no-viewer derivation in
// sandcastle2-renderer-gate.mjs uses, for the identical reason — Q-129), so
// it counts the demos that actually pin, and classifies each into the shape
// that matters for runtime behaviour:
//
//   - "async-literal"    Viewer.createAsync/CesiumWidget.createAsync with a
//                         literal contextOptions.renderer ("webgpu" or
//                         "webgl"). The supported, working shape — the vast
//                         majority of pins in the gallery.
//   - "param-defaulted"  contextOptions.renderer is a variable resolved from
//                         a URL query param with a literal `||` fallback
//                         (e.g. `new URLSearchParams(...).get("renderer") ||
//                         "webgpu"`). Still async, still works, but the
//                         pinned VALUE is data-dependent, so a scan that only
//                         matches a quoted literal at the `renderer:` site
//                         misses these three demos entirely; this module
//                         resolves the `||` fallback so their default is
//                         still reported.
//   - "sync-pin-throws"  `new Cesium.Viewer(...)` / `new Cesium.CesiumWidget(...)`
//                         (the SYNCHRONOUS constructor) with a literal
//                         non-"webgl" contextOptions.renderer. This ALWAYS
//                         throws at construction: RendererType.ts's
//                         `getSynchronousRendererType` rejects any requested
//                         renderer other than "webgl" before the DOM is
//                         touched ("... requires asynchronous
//                         initialization. Use createAsync instead."). One
//                         gallery demo currently ships this way
//                         (`webgpu-depth-of-field`) — a real, load-bearing
//                         defect this census SURFACES (already tracked
//                         separately under SC2-D2's discussion of that demo;
//                         out of scope for this module to fix).
//
// This module only counts and classifies; it does not fix
// `webgpu-depth-of-field`'s throw or decide the SC2-D2 forced-renderer
// question — both are separate, judgment-shaped rows.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  enumerateGalleryIds,
  stripJsSourceComments,
} from "./sandcastle2-renderer-gate.mjs";

/** The three ways a gallery demo can pin its own renderer. */
export const PIN_KIND = Object.freeze({
  ASYNC_LITERAL: "async-literal",
  PARAM_DEFAULTED: "param-defaulted",
  SYNC_PIN_THROWS: "sync-pin-throws",
  // Zero occurrences in the gallery today (verified by the spec), but a
  // sync `new Cesium.Viewer(..., { contextOptions: { renderer: "webgl" } })`
  // does NOT throw — RendererType.ts's getSynchronousRendererType only
  // rejects a requested renderer other than "webgl". Kept as its own kind
  // rather than folded into ASYNC_LITERAL: that name would misreport a sync
  // construction as async, which is exactly the kind of mislabeling this
  // module exists to avoid.
  SYNC_LITERAL_SAFE: "sync-literal-safe",
});

// Matches `renderer: "webgpu"` / `renderer: 'webgl'` (literal) OR
// `renderer: someIdentifier` (a variable — resolved separately below),
// scoped loosely to a `contextOptions: { ... }` block so a `renderer:` key
// on an unrelated object is never mistaken for a pin. (No gallery demo
// currently has such an unrelated `renderer:` key — verified by the spec's
// A2 assertion — but the scope keeps the match honest as the gallery grows.)
const CONTEXT_OPTIONS_RENDERER_PATTERN =
  /contextOptions\s*:\s*\{[^{}]*?\brenderer\s*:\s*(?:(["'`])(webgpu|webgl)\1|([A-Za-z_$][\w$]*))/;

// Matches the nearest preceding Viewer/CesiumWidget construction token, so a
// match can be classified sync vs async by which kind occurs LAST before it.
const CONSTRUCTION_TOKEN_PATTERN =
  /(?:new\s+(?:Cesium\.)?(?:Viewer|CesiumWidget)\s*\()|(?:(?:Cesium\.)?(?:Viewer|CesiumWidget)\.createAsync\s*\()/g;

/**
 * Resolve a `const <name> = <expr> || "<default>";` fallback literal for a
 * param-defaulted pin (e.g. `new URLSearchParams(location.search).get(
 * "renderer") || "webgpu"`). Returns `null` when no such declaration with a
 * literal fallback is found — callers report the pin as unresolved rather
 * than guessing.
 *
 * @param {string} strippedSource Comment/string-safe source (comment bodies
 *   already blanked, but string literal CONTENTS are preserved — see
 *   {@link stripJsSourceComments}).
 * @param {string} identifierName The variable named at the `renderer:` site.
 * @returns {"webgpu"|"webgl"|null} The resolved default, or null if unresolved.
 */
function resolveParamDefaultedLiteral(strippedSource, identifierName) {
  const declPattern = new RegExp(
    `\\bconst\\s+${identifierName}\\s*=[\\s\\S]*?\\|\\|\\s*(["'\`])(webgpu|webgl)\\1`,
  );
  const match = declPattern.exec(strippedSource);
  return match ? match[2] : null;
}

/**
 * Classify one demo's pin, if it has one.
 *
 * @param {string} rawSource The demo's raw `main.js` text.
 * @returns {{kind: string, literal: string|null}|null} `null` when the demo
 *   does not pin a renderer at all.
 */
export function classifyPin(rawSource) {
  const stripped = stripJsSourceComments(rawSource);
  const match = CONTEXT_OPTIONS_RENDERER_PATTERN.exec(stripped);
  if (!match) {
    return null;
  }

  const literalValue = match[2] ?? null;
  if (literalValue === null) {
    // Identifier form — param-defaulted (or, in principle, unresolved).
    const identifierName = match[3];
    return {
      kind: PIN_KIND.PARAM_DEFAULTED,
      literal: resolveParamDefaultedLiteral(stripped, identifierName),
    };
  }

  // Literal form — determine sync vs async by the nearest preceding
  // construction token.
  const before = stripped.slice(0, match.index);
  let lastToken = null;
  CONSTRUCTION_TOKEN_PATTERN.lastIndex = 0;
  for (let tok; (tok = CONSTRUCTION_TOKEN_PATTERN.exec(before));) {
    lastToken = tok[0];
  }
  const isSync = lastToken !== null && lastToken.startsWith("new ");
  if (isSync) {
    return literalValue === "webgl"
      ? { kind: PIN_KIND.SYNC_LITERAL_SAFE, literal: literalValue }
      : { kind: PIN_KIND.SYNC_PIN_THROWS, literal: literalValue };
  }
  return { kind: PIN_KIND.ASYNC_LITERAL, literal: literalValue };
}

/**
 * Derive the full census of self-pinned demos from the gallery itself.
 *
 * @param {string} galleryDir Absolute path to `packages/sandcastle/gallery`.
 * @param {{includeDevelopment?: boolean}} [options] Forwarded to
 *   {@link enumerateGalleryIds}.
 * @returns {Array<{id: string, kind: string, literal: string|null}>} Sorted
 *   by id.
 */
export function derivePinnedDemos(galleryDir, options = {}) {
  const ids = enumerateGalleryIds(galleryDir, options);
  const rows = [];
  for (const id of ids) {
    const rawSource = readFileSync(join(galleryDir, id, "main.js"), "utf8");
    const pin = classifyPin(rawSource);
    if (pin) {
      rows.push({ id, ...pin });
    }
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Render the census as a fixed-width text table, for a human-readable dump
 * (e.g. from a small CLI wrapper or a spec failure message).
 *
 * @param {Array<{id: string, kind: string, literal: string|null}>} rows
 *   Output of {@link derivePinnedDemos}.
 * @returns {string} A newline-joined table, including a totals footer.
 */
export function formatPinnedDemosTable(rows) {
  const idWidth = Math.max(2, ...rows.map((r) => r.id.length));
  const kindWidth = Math.max(4, ...rows.map((r) => r.kind.length));
  const lines = rows.map(
    (r) =>
      `${r.id.padEnd(idWidth)}  ${r.kind.padEnd(kindWidth)}  ${r.literal ?? "(unresolved)"}`,
  );
  const counts = {};
  for (const r of rows) {
    counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  }
  const totals = Object.entries(counts)
    .map(([kind, count]) => `${kind}=${count}`)
    .join(", ");
  lines.push(`--- total pinned: ${rows.length} (${totals}) ---`);
  return lines.join("\n");
}
