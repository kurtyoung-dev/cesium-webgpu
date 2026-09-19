/**
 * DX-105 — the contact sheet: one self-contained, verdict-free HTML page over
 * a DX-104 capture manifest.
 * @purpose Pure capture-manifest → contact-sheet page model + HTML renderer: a static, verdict-free page comparing BEFORE/AFTER captures across rigs and renderers, with the manifest's own shape guard.
 * @status ACTIVE
 *
 * WHY THE PATH PREDICATE IS NOT ONE OF THE THINGS THIS FILE HAND-ROLLS. The
 * manifest's path relativity is the ONE rule `lib/capture.mjs` also enforces,
 * and the two hand-rolled copies drifted in opposite directions: this file's
 * refused `C:/ESCAPED/x.png` and the capture seam's accepted it, because that
 * one tested a `scheme://` regex a drive letter cannot match. Both now read
 * `lib/relative-path.mjs`, a leaf module with no imports, so the two readers
 * cannot disagree about what a relative path is. The rest of the validator
 * stays here for the reason below.
 *
 * WHY A MANIFEST VALIDATOR LIVES HERE, NOT IMPORTED FROM `lib/capture.mjs`.
 * The KIT-B ownership contract (`KIT-B-OWNERSHIP.md` §4a) has `lib/capture.mjs`
 * (DX-104, a sibling lane's file) export the canonical `validateManifest` for
 * this module to import, so there is exactly one manifest shape guard. DX-104
 * is developed in a separate, isolated worker clone and does not exist in
 * this one, and this lane owns no path under `lib/capture.mjs` to create it
 * in. `validateManifest` below enforces the exact §2 hard rules of that same
 * contract (schemaVersion, the two-state-word vocabulary, the no-verdict-
 * vocabulary rule, the mismatchPct range, path relativity, origin recording)
 * so this module is independently buildable and testable without that file.
 * At integration the lead should reconcile the two copies into one — the
 * "shared homes before hand-rolling" rule this duplication otherwise runs
 * against — by having one import the other; this file's copy is the one the
 * DX-105 spec below actually drives.
 *
 * WHY THE PAGE HAS NO `<script>` ELEMENT. The sheet must open from `file://`
 * with no network access and no browser to run it. A script that tried to
 * `fetch()` a sibling file would be blocked by the browser's `file://` origin
 * policy in some engines and silently succeed in others — an inconsistency
 * not worth carrying when keyboard navigation, both color schemes and linked
 * receipts are all reachable with plain anchors, `<img>` and CSS alone.
 *
 * WHY NO COLOUR OR WORD MAY IMPLY A VERDICT. `capture-manifest.json`
 * deliberately carries no gate, threshold or PASS/FAIL vocabulary (§2.1 rule
 * 3) — this renderer must not reintroduce one by choosing alarming text for a
 * high `mismatchPct` or a checkmark for a low one. Every number here renders
 * with the same neutral styling regardless of its value; `findVerdictTokens`
 * exists so a caller (this module's own spec) can prove that invariant
 * against the rendered bytes rather than against this file's intentions.
 *
 * @module contact-sheet-page
 */

import {
  isRelativePosixPath,
  relativePosixPathViolation,
} from "./relative-path.mjs";

/** Renderer identifiers a manifest/rig may use. Also the render order. */
export const RENDERER_IDS = Object.freeze(["webgl", "webgpu"]);

/** Capture slot identifiers. Also the render order. */
export const SLOT_IDS = Object.freeze(["BEFORE", "AFTER"]);

/** The two state words a cell or pair may carry — contract §2.1 rule 2. */
export const CELL_STATES = Object.freeze(["MEASURED", "UNMEASURED"]);

/**
 * Words and glyphs the rendered page may never contain — the contract's "no
 * pass/fail token anywhere in the page" rule, made checkable. Alphabetic
 * entries are matched at word boundaries by {@link findVerdictTokens}, so an
 * organic English word such as "bypass" or "compass" does not false-positive
 * against "PASS"; the glyphs match as a plain substring.
 */
export const VERDICT_TOKENS = Object.freeze([
  "PASS",
  "FAIL",
  "PASSED",
  "FAILED",
  "OK",
  "ERROR",
  "THRESHOLD",
  "REGRESSION",
  "✅",
  "❌",
  "🔴",
  "🟢",
]);

const GLYPH_TOKENS = new Set(["✅", "❌", "🔴", "🟢"]);

/**
 * Which of {@link VERDICT_TOKENS} occur in `text`.
 *
 * @param {string} text
 * @returns {string[]} The matched tokens, in `VERDICT_TOKENS` order; empty
 *   when none are present. This is the assertion both this module's spec and
 *   any future consumer should use rather than re-deriving the match rule.
 */
export function findVerdictTokens(text) {
  const haystack = String(text ?? "");
  const found = [];
  for (const token of VERDICT_TOKENS) {
    if (GLYPH_TOKENS.has(token)) {
      if (haystack.includes(token)) {
        found.push(token);
      }
      continue;
    }
    if (new RegExp(`\\b${token}\\b`, "i").test(haystack)) {
      found.push(token);
    }
  }
  return found;
}

/**
 * Every `class` token {@link renderSheetHtml} may emit.
 *
 * WHY A CLOSED VOCABULARY AND NOT JUST A WORD LIST. A word list reads TEXT,
 * so it cannot see a judgement expressed as a hook for CSS: a renderer that
 * emitted `class="pair pair-measured pair-bad"` for a high mismatch and
 * `pair-good` for a low one would leave {@link findVerdictTokens} empty while
 * ranking the page's pairs by badness and handing a stylesheet somewhere else
 * the means to colour them. A judgement has to be SPELLED to get into the
 * markup, and any spelling at all lands in a `class` attribute that is not on
 * this list. `R-2026-09-17-10` is what this list enforces; the sweep
 * assertion in the spec (identical markup across a mismatch sweep once the
 * numerals are normalised) is the other half, and covers attributes this list
 * does not name.
 */
export const PAGE_CLASS_NAMES = Object.freeze([
  "cell",
  "cell-measured",
  "cell-unmeasured",
  "cells",
  "metric",
  "note",
  "pair",
  "pair-measured",
  "pair-unmeasured",
  "placeholder",
  "placeholder-link",
  "provenance",
  "reason",
  "renderer-block",
  "rig",
  "rig-description",
  "rig-meta",
  "slot-label",
  "state-label",
  "summary",
  "tracked-by",
]);

/**
 * Every text the page carries that the MODEL does not produce — the whole of
 * the page's fixed chrome vocabulary, enumerated rather than left implicit.
 *
 * WHY IT IS EXPORTED AND WHY IT IS THIS SHORT. {@link findForeignPageTokens}
 * admits a text node only if the model produced it or this list names it, so
 * every literal the renderer wants to print has to be added here first, in
 * review, beside the one sentence already in it — and that sentence is the one
 * telling the reader the page is descriptive. A judgement cannot join a page
 * whose only fixed words are these without the addition showing up in this
 * array, which is the point of enumerating it rather than allowing "any
 * heading the renderer feels like".
 */
export const PAGE_CHROME_TEXTS = Object.freeze([
  "Descriptive metrics only — nothing on this page is a judgement.",
]);

const PAGE_NOTE_TEXT = PAGE_CHROME_TEXTS[0];

/**
 * Every attribute value the page carries that the MODEL does not produce, by
 * attribute name — the counterpart of {@link PAGE_CHROME_TEXTS}, read by
 * {@link findForeignPageTokens} for the same reason.
 *
 * The renderer does NOT read this table; it spells these values inline, the
 * way HTML is legible. So a drift between the two is a VIOLATION rather than a
 * silent agreement: the guard reports the page's value as one nothing
 * produced, and the spec reds. That is the fail-closed direction.
 */
export const PAGE_CHROME_ATTRIBUTES = Object.freeze({
  "aria-hidden": Object.freeze(["true"]),
  "aria-label": Object.freeze(["rig navigation"]),
  charset: Object.freeze(["utf-8"]),
  content: Object.freeze(["width=device-width, initial-scale=1"]),
  lang: Object.freeze(["en"]),
  loading: Object.freeze(["lazy"]),
  name: Object.freeze(["viewport"]),
});

const CLASS_ATTRIBUTE = /\sclass="([^"]*)"/g;

/**
 * Every distinct `class` token present in `html`, in sorted order. Manifest
 * text that happens to contain `class="…"` is HTML-escaped before it reaches
 * the document, so only the renderer's own attributes are seen here.
 *
 * @param {string} html
 * @returns {string[]}
 */
export function collectClassNames(html) {
  const names = new Set();
  for (const match of String(html ?? "").matchAll(CLASS_ATTRIBUTE)) {
    for (const token of match[1].split(/\s+/)) {
      if (token.length > 0) {
        names.add(token);
      }
    }
  }
  return [...names].sort();
}

/**
 * Class tokens in `html` that {@link PAGE_CLASS_NAMES} does not allow — the
 * checkable form of "no judgement reaches the markup, by any spelling".
 *
 * @param {string} html
 * @returns {string[]} Sorted; empty when the page's vocabulary is closed.
 */
export function findUnknownClassNames(html) {
  const allowed = new Set(PAGE_CLASS_NAMES);
  return collectClassNames(html).filter((name) => !allowed.has(name));
}

/**
 * Sort strings by UTF-16 code unit, never by `localeCompare`: the sheet's md5
 * is banked as its identity (`DX-106`), and a locale-dependent order gives the
 * same manifest two different pages on two machines.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function byCodeUnit(left, right) {
  const a = String(left);
  const b = String(right);
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const HEX8 = /^[0-9a-f]{8}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SHEET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A manifest image path per contract §2.1 rule 5: POSIX-separated, relative
 * (no leading slash), carrying no `..` segment, and not a URL or a Windows
 * path — plus, since the sheet is opened in a BROWSER and a browser decodes
 * what `node:fs` does not, no percent-escape that decodes to a separator or a
 * dot. All of it is {@link isRelativePosixPath}, which `lib/capture.mjs` reads
 * too so the two manifest readers cannot drift apart again.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
const isRelativeImagePath = isRelativePosixPath;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function validateCell(cell, where, failures) {
  const need = (condition, message) => {
    if (!condition) {
      failures.push(`${where}: ${message}`);
    }
  };
  if (cell === null || typeof cell !== "object") {
    need(false, "cell must be an object");
    return;
  }
  need(!Object.hasOwn(cell, "gate"), "cell must not carry a gate field");
  need(
    CELL_STATES.includes(cell.state),
    `cell.state must be one of ${CELL_STATES.join(", ")}`,
  );
  if (cell.state === "MEASURED") {
    need(
      isRelativeImagePath(cell.image),
      `MEASURED cell.image must be a relative POSIX path: ${relativePosixPathViolation(cell.image)}`,
    );
    need(
      isFiniteNumber(cell.width) && cell.width > 0,
      "MEASURED cell.width must be a positive number",
    );
    need(
      isFiniteNumber(cell.height) && cell.height > 0,
      "MEASURED cell.height must be a positive number",
    );
    need(
      isFiniteNumber(cell.byteLength) && cell.byteLength >= 0,
      "MEASURED cell.byteLength must be a non-negative number",
    );
    need(
      typeof cell.sha256 === "string" && HEX64.test(cell.sha256),
      "MEASURED cell.sha256 must be 64 lowercase hex digits",
    );
    need(
      isNonEmptyString(cell.url),
      "MEASURED cell.url must be a non-empty string",
    );
    need(
      isNonEmptyString(cell.capturedAt) && ISO_INSTANT.test(cell.capturedAt),
      "MEASURED cell.capturedAt must be an ISO-8601 UTC instant",
    );
    need(
      cell.metrics !== null && typeof cell.metrics === "object",
      "MEASURED cell.metrics must be an object",
    );
  } else if (cell.state === "UNMEASURED") {
    need(cell.image === null, "UNMEASURED cell.image must be null");
    need(
      isNonEmptyString(cell.reason),
      "UNMEASURED cell.reason must be a non-empty string",
    );
    need(cell.metrics === null, "UNMEASURED cell.metrics must be null");
  }
}

function validatePair(pair, where, failures) {
  const need = (condition, message) => {
    if (!condition) {
      failures.push(`${where}: ${message}`);
    }
  };
  if (pair === null || typeof pair !== "object") {
    need(false, "pair must be an object");
    return;
  }
  need(!Object.hasOwn(pair, "gate"), "pair must not carry a gate field");
  need(
    CELL_STATES.includes(pair.state),
    `pair.state must be one of ${CELL_STATES.join(", ")}`,
  );
  if (pair.state === "MEASURED") {
    need(
      isRelativeImagePath(pair.diffImage),
      `MEASURED pair.diffImage must be a relative POSIX path: ${relativePosixPathViolation(pair.diffImage)}`,
    );
    need(
      pair.mismatchPct === null ||
        (isFiniteNumber(pair.mismatchPct) &&
          pair.mismatchPct >= 0 &&
          pair.mismatchPct <= 100),
      "MEASURED pair.mismatchPct must be null or a percent in [0,100]",
    );
    need(
      isFiniteNumber(pair.changedPx) && pair.changedPx >= 0,
      "MEASURED pair.changedPx must be a non-negative number",
    );
    need(
      pair.bbox === null || typeof pair.bbox === "object",
      "MEASURED pair.bbox must be null or an object",
    );
    need(
      isFiniteNumber(pair.tolerance),
      "MEASURED pair.tolerance must be a number",
    );
    need(
      pair.metrics !== null && typeof pair.metrics === "object",
      "MEASURED pair.metrics must be an object",
    );
  } else if (pair.state === "UNMEASURED") {
    need(pair.diffImage === null, "UNMEASURED pair.diffImage must be null");
    need(pair.mismatchPct === null, "UNMEASURED pair.mismatchPct must be null");
    need(pair.changedPx === null, "UNMEASURED pair.changedPx must be null");
    need(pair.bbox === null, "UNMEASURED pair.bbox must be null");
    need(pair.tolerance === null, "UNMEASURED pair.tolerance must be null");
    need(pair.metrics === null, "UNMEASURED pair.metrics must be null");
    need(
      isNonEmptyString(pair.reason),
      "UNMEASURED pair.reason must be a non-empty string",
    );
  }
}

/**
 * Validate a DX-104 capture manifest against the §2 hard rules. Fails
 * CLOSED: an unrecognised shape is a violation, never a silent pass, matching
 * `validateRig`'s discipline in `rig-registry.mjs`.
 *
 * @param {object} manifest
 * @returns {string[]} Violations; empty when the manifest is sound.
 */
export function validateManifest(manifest) {
  const failures = [];
  const need = (condition, message) => {
    if (!condition) {
      failures.push(message);
    }
  };

  if (manifest === null || typeof manifest !== "object") {
    return ["manifest must be an object"];
  }

  need(manifest.schemaVersion === 1, "schemaVersion must be 1");
  need(manifest.kind === "capture-manifest", 'kind must be "capture-manifest"');
  need(
    isNonEmptyString(manifest.generatedAt) &&
      ISO_INSTANT.test(manifest.generatedAt),
    "generatedAt must be an ISO-8601 UTC instant",
  );
  need(
    isNonEmptyString(manifest.captureRoot),
    "captureRoot must be a non-empty string",
  );
  need(
    manifest.origins !== null &&
      typeof manifest.origins === "object" &&
      isNonEmptyString(manifest.origins.BEFORE) &&
      isNonEmptyString(manifest.origins.AFTER),
    "origins.BEFORE and origins.AFTER must both be non-empty strings — an absent origin is a refusal, never a default",
  );
  need(
    manifest.servedBuildAssertion === "enforced" ||
      manifest.servedBuildAssertion === "waived",
    'servedBuildAssertion must be "enforced" or "waived"',
  );
  need(
    isRelativeImagePath(manifest.receipt),
    `receipt must be a relative POSIX path with no \`..\` segment — the page links it and the CLI copies it: ${relativePosixPathViolation(manifest.receipt)}`,
  );
  need(
    Array.isArray(manifest.slots) &&
      manifest.slots.length > 0 &&
      manifest.slots.every((slot) => SLOT_IDS.includes(slot)) &&
      new Set(manifest.slots).size === manifest.slots.length,
    `slots must be a duplicate-free non-empty subset of ${SLOT_IDS.join(", ")}`,
  );
  need(
    Array.isArray(manifest.renderers) &&
      manifest.renderers.length > 0 &&
      manifest.renderers.every((renderer) => RENDERER_IDS.includes(renderer)) &&
      new Set(manifest.renderers).size === manifest.renderers.length,
    `renderers must be a duplicate-free non-empty subset of ${RENDERER_IDS.join(", ")}`,
  );
  need(
    Array.isArray(manifest.rigs) && manifest.rigs.length > 0,
    "rigs must be a non-empty array",
  );

  if (failures.length > 0) {
    // The per-rig checks below index into manifest.renderers/slots/rigs;
    // fail closed here rather than risk a crash masking the real violations
    // with an unrelated TypeError.
    return failures;
  }

  for (const rig of manifest.rigs) {
    const id = isNonEmptyString(rig?.id) ? rig.id : "(unnamed rig)";
    const where = `rig ${id}`;
    need(isNonEmptyString(rig?.id), `${where}: missing id`);
    need(
      rig?.replayKey === undefined || HEX8.test(rig.replayKey),
      `${where}: replayKey must be 8 lowercase hex digits`,
    );
    need(
      isFiniteNumber(rig?.viewport?.width) &&
        rig.viewport.width > 0 &&
        isFiniteNumber(rig?.viewport?.height) &&
        rig.viewport.height > 0,
      `${where}: viewport.width and viewport.height must be positive numbers`,
    );
    need(rig?.gate === undefined, `${where}: must not carry a gate field`);
    need(
      rig?.expectedMismatch === undefined,
      `${where}: must not carry an expectedMismatch field`,
    );
    need(
      rig?.thresholds === undefined,
      `${where}: must not carry a thresholds field`,
    );
    need(
      rig?.cells !== null && typeof rig?.cells === "object",
      `${where}: cells must be an object`,
    );
    need(
      rig?.pairs !== null && typeof rig?.pairs === "object",
      `${where}: pairs must be an object`,
    );
    if (typeof rig?.cells !== "object" || rig.cells === null) {
      continue;
    }
    for (const renderer of manifest.renderers) {
      const cellsBySlot = rig.cells[renderer];
      need(cellsBySlot !== undefined, `${where}: cells.${renderer} is missing`);
      if (cellsBySlot === undefined) {
        continue;
      }
      for (const slot of manifest.slots) {
        validateCell(
          cellsBySlot[slot],
          `${where}.cells.${renderer}.${slot}`,
          failures,
        );
      }
      validatePair(
        rig.pairs?.[renderer],
        `${where}.pairs.${renderer}`,
        failures,
      );
    }
  }

  return failures;
}

/**
 * Validate the options a caller passes to {@link sheetModel}.
 *
 * @param {object} options
 * @returns {string[]} Violations; empty when the options are sound.
 */
export function validateSheetOptions(options) {
  const failures = [];
  const need = (condition, message) => {
    if (!condition) {
      failures.push(message);
    }
  };
  if (options === null || typeof options !== "object") {
    return ["options must be an object"];
  }
  need(
    isNonEmptyString(options.sheetId) && SHEET_ID_PATTERN.test(options.sheetId),
    "sheetId must be a non-empty, path-safe identifier",
  );
  need(
    isNonEmptyString(options.generatedAt) &&
      ISO_INSTANT.test(options.generatedAt),
    "generatedAt must be an ISO-8601 UTC instant",
  );
  need(
    options.date === undefined || DATE_PATTERN.test(options.date),
    "date, when given, must be YYYY-MM-DD",
  );
  return failures;
}

/**
 * The sheet's own directory date segment, derived from `generatedAt` by
 * slicing the ISO string — never by constructing a `Date`, so the derivation
 * stays a pure string operation independent of the runtime's clock or locale.
 *
 * @param {string} generatedAt ISO-8601 UTC instant.
 * @returns {string} `YYYY-MM-DD`.
 */
export function deriveDateFromGeneratedAt(generatedAt) {
  return String(generatedAt).slice(0, 10);
}

/**
 * The LOCAL calendar date of `clock`, as `YYYY-MM-DD`.
 *
 * WHY LOCAL AND NOT UTC. Every wave-end receipt directory this fork writes is
 * named for the local calendar date, and the Edge leg of 2026-09-18 banked a
 * sheet made at 23:32 EDT into a `2026-09-19` directory because the sheet's
 * date came from slicing a UTC instant. Two conventions in one output tree is
 * a half-hour-a-year bug that costs an hour every time someone looks for
 * yesterday's sheet. `--date` still overrides, and an explicitly supplied
 * `--generated-at` still derives through {@link deriveDateFromGeneratedAt} —
 * an instant pinned by a caller carries no timezone, so the UTC slice is the
 * only honest reading of it.
 *
 * Only the three local getters are read, so a spec can inject a Date-shaped
 * double whose local date deliberately differs from its own ISO instant, and
 * assert which of the two the tool used without depending on the machine's
 * timezone.
 *
 * @param {{getFullYear: Function, getMonth: Function, getDate: Function}} clock
 *   A `Date`, or anything with its three local-calendar getters.
 * @returns {string} `YYYY-MM-DD`.
 */
export function formatCalendarDate(clock) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${clock.getFullYear()}-${pad(clock.getMonth() + 1)}-${pad(clock.getDate())}`;
}

function buildCellView(cell) {
  if (cell.state === "MEASURED") {
    return {
      state: "MEASURED",
      imagePath: `images/${cell.image}`,
      width: cell.width,
      height: cell.height,
      byteLength: cell.byteLength,
      sha256: cell.sha256,
      url: cell.url,
      capturedAt: cell.capturedAt,
      metrics: cell.metrics,
    };
  }
  return {
    state: "UNMEASURED",
    reason: cell.reason,
    trackedBy: cell.trackedBy ?? null,
  };
}

function buildPairView(pair) {
  if (!pair) {
    return null;
  }
  if (pair.state === "MEASURED") {
    return {
      state: "MEASURED",
      diffImagePath: `images/${pair.diffImage}`,
      mismatchPct: pair.mismatchPct,
      changedPx: pair.changedPx,
      bbox: pair.bbox,
      tolerance: pair.tolerance,
      metrics: pair.metrics,
    };
  }
  return {
    state: "UNMEASURED",
    reason: pair.reason,
  };
}

function buildRigView(rig, manifest) {
  const renderers = RENDERER_IDS.filter(
    (renderer) =>
      manifest.renderers.includes(renderer) &&
      Object.hasOwn(rig.cells ?? {}, renderer),
  ).map((renderer) => {
    const cellsBySlot = rig.cells[renderer];
    const cells = {};
    for (const slot of SLOT_IDS) {
      if (Object.hasOwn(cellsBySlot, slot)) {
        cells[slot] = buildCellView(cellsBySlot[slot]);
      }
    }
    return {
      renderer,
      cells,
      pair: buildPairView(rig.pairs?.[renderer]),
    };
  });
  return {
    id: rig.id,
    description: rig.description ?? "",
    replayKey: rig.replayKey ?? null,
    viewport: rig.viewport,
    renderers,
  };
}

/**
 * Every image DX-105 must copy so the sheet directory is movable — one entry
 * per MEASURED cell image and one per MEASURED pair's diff image. `from` is
 * relative to the manifest's own directory (contract §2.1 rule 5, unchanged);
 * `to` is relative to the sheet directory. Both are pure string derivations —
 * no filesystem access happens here or anywhere else in this module.
 *
 * @param {object} manifest
 * @returns {{from: string, to: string}[]}
 */
function collectImageCopies(manifest) {
  const copies = [];
  for (const rig of manifest.rigs) {
    for (const renderer of manifest.renderers) {
      const cellsBySlot = rig.cells?.[renderer];
      if (cellsBySlot) {
        for (const slot of manifest.slots) {
          const cell = cellsBySlot[slot];
          if (cell?.state === "MEASURED" && typeof cell.image === "string") {
            copies.push({ from: cell.image, to: `images/${cell.image}` });
          }
        }
      }
      const pair = rig.pairs?.[renderer];
      if (pair?.state === "MEASURED" && typeof pair.diffImage === "string") {
        copies.push({ from: pair.diffImage, to: `images/${pair.diffImage}` });
      }
    }
  }
  return copies;
}

/**
 * Count individual BEFORE/AFTER cells (not pairs) by state, across every rig,
 * renderer and slot. The worked-example fixture (one fully UNMEASURED rig
 * beside one fully MEASURED rig, both 2 renderers × 2 slots) counts 4 and 4 —
 * that is what `sheet-index.json`'s `cells` field reports.
 *
 * @param {object} manifest
 * @returns {{measured: number, unmeasured: number}}
 */
function countCells(manifest) {
  let measured = 0;
  let unmeasured = 0;
  for (const rig of manifest.rigs) {
    for (const renderer of manifest.renderers) {
      const cellsBySlot = rig.cells?.[renderer];
      if (!cellsBySlot) {
        continue;
      }
      for (const slot of manifest.slots) {
        const cell = cellsBySlot[slot];
        if (cell?.state === "MEASURED") {
          measured++;
        } else if (cell?.state === "UNMEASURED") {
          unmeasured++;
        }
      }
    }
  }
  return { measured, unmeasured };
}

/**
 * Build the contact sheet's page model — the pure function this row's spec
 * drives directly, with no browser and no filesystem.
 *
 * Rigs are sorted by `id` (never by `mismatchPct` or any other measured
 * value) so the render order itself carries no judgement — the contract's
 * "no verdict token… in sort order" rule, satisfied structurally rather than
 * by convention.
 *
 * @param {object} manifest A DX-104 capture manifest (contract §2).
 * @param {{sheetId: string, generatedAt: string, date?: string}} options
 * @returns {{sheetId: string, date: string, generatedAt: string,
 *   captureRoot: string, receipt: string, renderers: string[], slots: string[],
 *   rigs: object[], counts: {measured: number, unmeasured: number},
 *   imageCopies: {from: string, to: string}[]}}
 * @throws {TypeError} When the manifest or the options fail validation.
 */
export function sheetModel(manifest, options) {
  const manifestViolations = validateManifest(manifest);
  if (manifestViolations.length > 0) {
    throw new TypeError(
      `sheetModel: invalid manifest\n${manifestViolations.join("\n")}`,
    );
  }
  const optionViolations = validateSheetOptions(options);
  if (optionViolations.length > 0) {
    throw new TypeError(
      `sheetModel: invalid options\n${optionViolations.join("\n")}`,
    );
  }

  const date = options.date ?? deriveDateFromGeneratedAt(options.generatedAt);
  const rigs = manifest.rigs
    .slice()
    .sort((a, b) => byCodeUnit(a.id, b.id))
    .map((rig) => buildRigView(rig, manifest));

  return {
    sheetId: options.sheetId,
    date,
    generatedAt: options.generatedAt,
    captureRoot: manifest.captureRoot,
    receipt: manifest.receipt,
    renderers: manifest.renderers.slice(),
    slots: manifest.slots.slice(),
    rigs,
    counts: countCells(manifest),
    imageCopies: collectImageCopies(manifest),
  };
}

function formatMetric(value, digits = 2) {
  if (value === null || value === undefined || !isFiniteNumber(value)) {
    return "n/a";
  }
  return value.toFixed(digits);
}

function slugify(id) {
  return String(id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The alt text of a cell's image. One home, read by the renderer AND by
 * {@link findForeignFigureTokens}, so the guard's expectation cannot drift
 * from the markup by being written twice.
 *
 * @param {string} slot
 * @param {string} rigId
 * @param {string} renderer
 * @returns {string}
 */
function cellAltText(slot, rigId, renderer) {
  return `${slot} capture — ${rigId} — ${renderer}`;
}

/**
 * The alt text of a pair's difference map. Same contract as
 * {@link cellAltText}.
 *
 * @param {string} rigId
 * @param {string} renderer
 * @returns {string}
 */
function pairAltText(rigId, renderer) {
  return `difference map — ${rigId} — ${renderer}`;
}

/**
 * Every string the page's HEADER and `<title>` carry, already HTML-escaped,
 * computed from the model alone.
 *
 * Same contract as {@link cellCaptionModel}, one level up: the renderer
 * interpolates these values and {@link findForeignPageTokens} builds its
 * closed text set from the same call, so the header's summary lines cannot be
 * written twice and drift. The parts are escaped INDIVIDUALLY and then joined,
 * exactly as the template used to, so the composition is byte-for-byte the
 * markup that shipped before this table existed.
 *
 * @param {ReturnType<typeof sheetModel>} model
 * @returns {Record<string, string>}
 */
function pageChromeModel(model) {
  const rendererList = model.renderers.join(", ");
  const slotList = model.slots.join(", ");
  return {
    title: escapeHtml(`${model.sheetId} contact sheet — ${model.date}`),
    heading: escapeHtml(model.sheetId),
    runSummary: `${escapeHtml(model.date)} · generated ${escapeHtml(model.generatedAt)} · renderers ${escapeHtml(rendererList)} · slots ${escapeHtml(slotList)}`,
    countSummary: `${model.rigs.length} rigs · ${model.counts.measured} measured cells · ${model.counts.unmeasured} unmeasured cells`,
    note: PAGE_NOTE_TEXT,
  };
}

/**
 * Every string one rig SECTION's own chrome carries — its heading, its
 * description and its viewport/replay line — already HTML-escaped, plus the
 * slug its `id` and its nav link are built from.
 *
 * @param {object} rigView A `sheetModel` rig view.
 * @returns {Record<string, string>}
 */
function rigChromeModel(rigView) {
  const replaySuffix = rigView.replayKey
    ? ` · replay ${escapeHtml(rigView.replayKey)}`
    : "";
  return {
    slug: escapeHtml(slugify(rigView.id)),
    heading: escapeHtml(rigView.id),
    description: escapeHtml(rigView.description),
    meta: `viewport ${rigView.viewport.width}×${rigView.viewport.height}${replaySuffix}`,
  };
}

/**
 * EVERY string a cell figure's caption may contain, computed from the cell
 * view alone. The renderer reads these fields and nothing else, and
 * {@link findForeignFigureTokens} builds its closed text set from the same
 * call — so a word added to the markup is a word that is in the page and not
 * in the model, which is exactly the violation the guard reports.
 *
 * `null` entries are absent captions, not empty ones, and the guard drops them.
 *
 * @param {object} cellView A `sheetModel` cell view.
 * @param {string} slot
 * @returns {Record<string, string|null>}
 */
function cellCaptionModel(cellView, slot) {
  if (cellView.state === "MEASURED") {
    const metrics = cellView.metrics ?? {};
    return {
      slotLabel: slot,
      meanLuma: `mean luma ${formatMetric(metrics.rawByteLumaMean)}`,
      nonBlackFraction: `non-black fraction ${formatMetric(metrics.nonBlackFraction, 4)}`,
      provenance: metrics.provenance ?? "",
    };
  }
  return {
    slotLabel: slot,
    stateLabel: "unmeasured",
    reason: cellView.reason,
    trackedBy: cellView.trackedBy ? `tracked by ${cellView.trackedBy}` : null,
  };
}

/**
 * Every string a pair figure's caption may contain. See
 * {@link cellCaptionModel} for why the renderer and the guard share it.
 *
 * The mismatch entry is the whole reason this table exists: a judgement fits
 * in the same text node as the numeral (`mismatch 11.07% degraded`), carries
 * no class of its own, and is invisible to both a word allowlist and a class
 * vocabulary. It is visible here because the model does not produce it.
 *
 * @param {object} pairView A `sheetModel` pair view.
 * @returns {Record<string, string|null>}
 */
function pairCaptionModel(pairView) {
  if (pairView.state === "MEASURED") {
    const metrics = pairView.metrics ?? {};
    return {
      mismatch: `mismatch ${formatMetric(pairView.mismatchPct)}%`,
      changedPx: `changed px ${pairView.changedPx}`,
      tolerance: `tolerance ${pairView.tolerance}`,
      mssim: isFiniteNumber(metrics.mssim)
        ? `structure similarity ${formatMetric(metrics.mssim, 4)}`
        : null,
    };
  }
  return {
    stateLabel: "unmeasured",
    reason: pairView.reason,
  };
}

function renderCellFigure({ rigId, renderer, slot, cellView, receiptHref }) {
  const altText = cellAltText(slot, rigId, renderer);
  const caption = cellCaptionModel(cellView, slot);
  if (cellView.state === "MEASURED") {
    return `<figure class="cell cell-measured">
  <a href="${escapeHtml(receiptHref)}">
    <img src="${escapeHtml(cellView.imagePath)}" width="${cellView.width}" height="${cellView.height}" alt="${escapeHtml(altText)}" loading="lazy">
  </a>
  <figcaption>
    <span class="slot-label">${escapeHtml(caption.slotLabel)}</span>
    <span class="metric">${escapeHtml(caption.meanLuma)}</span>
    <span class="metric">${escapeHtml(caption.nonBlackFraction)}</span>
    <small class="provenance">${escapeHtml(caption.provenance)}</small>
  </figcaption>
</figure>`;
  }
  // Assembled as its own statement rather than inline: a template literal
  // nested inside a ${} substitution defeats the tokenizer that the
  // prohibited-reader rule scans every source with, and a source it cannot
  // tokenize is reported as a violation rather than skipped.
  const trackedByMarkup = caption.trackedBy
    ? '<small class="tracked-by">' + escapeHtml(caption.trackedBy) + "</small>"
    : "";
  return `<figure class="cell cell-unmeasured">
  <a class="placeholder-link" href="${escapeHtml(receiptHref)}">
    <div class="placeholder" aria-hidden="true"></div>
  </a>
  <figcaption>
    <span class="slot-label">${escapeHtml(caption.slotLabel)}</span>
    <span class="state-label">${escapeHtml(caption.stateLabel)}</span>
    <p class="reason">${escapeHtml(caption.reason)}</p>
    ${trackedByMarkup}
  </figcaption>
</figure>`;
}

function renderPairFigure({ rigId, renderer, pairView, receiptHref }) {
  if (!pairView) {
    return "";
  }
  const caption = pairCaptionModel(pairView);
  if (pairView.state === "MEASURED") {
    const altText = pairAltText(rigId, renderer);
    const mssim = caption.mssim
      ? '<span class="metric">' + escapeHtml(caption.mssim) + "</span>"
      : "";
    return `<figure class="pair pair-measured">
  <a href="${escapeHtml(receiptHref)}">
    <img src="${escapeHtml(pairView.diffImagePath)}" alt="${escapeHtml(altText)}" loading="lazy">
  </a>
  <figcaption>
    <span class="metric">${escapeHtml(caption.mismatch)}</span>
    <span class="metric">${escapeHtml(caption.changedPx)}</span>
    <span class="metric">${escapeHtml(caption.tolerance)}</span>
    ${mssim}
  </figcaption>
</figure>`;
  }
  return `<figure class="pair pair-unmeasured">
  <a class="placeholder-link" href="${escapeHtml(receiptHref)}">
    <div class="placeholder" aria-hidden="true"></div>
  </a>
  <figcaption>
    <span class="state-label">${escapeHtml(caption.stateLabel)}</span>
    <p class="reason">${escapeHtml(caption.reason)}</p>
  </figcaption>
</figure>`;
}

function renderRendererBlock(rigView, rendererView, receiptHref) {
  const cellsHtml = SLOT_IDS.filter((slot) =>
    Object.hasOwn(rendererView.cells, slot),
  )
    .map((slot) =>
      renderCellFigure({
        rigId: rigView.id,
        renderer: rendererView.renderer,
        slot,
        cellView: rendererView.cells[slot],
        receiptHref,
      }),
    )
    .join("\n");
  const pairHtml = renderPairFigure({
    rigId: rigView.id,
    renderer: rendererView.renderer,
    pairView: rendererView.pair,
    receiptHref,
  });
  return `<div class="renderer-block">
  <h3>${escapeHtml(rendererView.renderer)}</h3>
  <div class="cells">
${cellsHtml}
${pairHtml}
  </div>
</div>`;
}

function renderRigSection(rigView, receiptHref) {
  const chrome = rigChromeModel(rigView);
  const rendererBlocks = rigView.renderers
    .map((rendererView) =>
      renderRendererBlock(rigView, rendererView, receiptHref),
    )
    .join("\n");
  return `<section id="rig-${chrome.slug}" class="rig">
  <h2>${chrome.heading}</h2>
  <p class="rig-description">${chrome.description}</p>
  <p class="rig-meta">${chrome.meta}</p>
${rendererBlocks}
</section>`;
}

function renderNav(model) {
  const items = model.rigs
    .map((rig) => {
      const chrome = rigChromeModel(rig);
      return `<a href="#rig-${chrome.slug}">${chrome.heading}</a>`;
    })
    .join("\n");
  return `<nav aria-label="rig navigation">\n${items}\n</nav>`;
}

const PAGE_CSS = `:root {
  --bg: #ffffff;
  --fg: #1a1a1a;
  --muted: #5c6570;
  --border: #d7dbe0;
  --panel: #f4f6f8;
  --accent: #3b5bdb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171c;
    --fg: #e7eaee;
    --muted: #9aa4b2;
    --border: #2a2f37;
    --panel: #1c2027;
    --accent: #7c9cff;
  }
}
* { box-sizing: border-box; }
html, body {
  background: var(--bg);
  color: var(--fg);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  margin: 0;
  padding: 0;
}
header, main { padding: 1.25rem clamp(1rem, 4vw, 3rem); }
a { color: var(--accent); }
a:focus-visible, [tabindex]:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 2px;
}
nav[aria-label="rig navigation"] a {
  display: inline-block;
  margin: 0 0.75rem 0.5rem 0;
}
.summary, .note { color: var(--muted); margin: 0.25rem 0; }
.rig { border-top: 1px solid var(--border); padding-top: 1rem; margin-top: 1.5rem; }
.rig-description, .rig-meta { color: var(--muted); margin: 0.15rem 0; }
.renderer-block { margin: 0.75rem 0 1.5rem; }
.cells {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 1rem;
}
figure.cell, figure.pair {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.5rem;
  margin: 0;
}
figure img { max-width: 100%; height: auto; display: block; border-radius: 4px; }
figcaption { font-size: 0.85rem; margin-top: 0.35rem; }
.slot-label { font-weight: 600; margin-right: 0.4rem; }
.metric { color: var(--muted); margin-right: 0.6rem; }
.provenance, .tracked-by { display: block; color: var(--muted); margin-top: 0.2rem; }
.state-label { font-weight: 600; }
.reason { color: var(--muted); margin: 0.2rem 0; }
.placeholder {
  aspect-ratio: 16 / 9;
  border: 1px dashed var(--border);
  border-radius: 4px;
}`;

/**
 * Render a {@link sheetModel} result to the complete, self-contained HTML
 * document — inline CSS, relative image paths, no `<script>`, no network
 * access, both color schemes via `prefers-color-scheme`.
 *
 * Every manifest-derived string is HTML-escaped, and no branch here reads a
 * mismatch value to choose a color, an icon or a word — verified by
 * {@link findVerdictTokens} over the returned string.
 *
 * @param {ReturnType<typeof sheetModel>} model
 * @returns {string} The complete HTML document.
 */
export function renderSheetHtml(model) {
  const chrome = pageChromeModel(model);
  const rigsHtml = model.rigs
    .map((rig) => renderRigSection(rig, model.receipt))
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${chrome.title}</title>
<style>
${PAGE_CSS}
</style>
</head>
<body>
<header>
  <h1>${chrome.heading}</h1>
  <p class="summary">${chrome.runSummary}</p>
  <p class="summary">${chrome.countSummary}</p>
  <p class="note">${chrome.note}</p>
  ${renderNav(model)}
</header>
<main>
${rigsHtml}
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// The structural guard: a figure may contain only what the MODEL produced
// ---------------------------------------------------------------------------

/** Element names a cell or pair figure may be built from. */
const FIGURE_TAG_NAMES = Object.freeze([
  "a",
  "div",
  "figcaption",
  "figure",
  "img",
  "p",
  "small",
  "span",
]);

/** Attribute names a cell or pair figure may carry. */
const FIGURE_ATTRIBUTE_NAMES = Object.freeze([
  "alt",
  "aria-hidden",
  "class",
  "height",
  "href",
  "loading",
  "src",
  "width",
]);

const FIGURE_BLOCK = /<figure\b[\s\S]*?<\/figure>/g;
const TAG_TOKEN = /<\/?([a-zA-Z0-9]+)((?:\s+[a-zA-Z-]+="[^"]*")*)\s*\/?>/g;
const ATTRIBUTE_TOKEN = /([a-zA-Z-]+)="([^"]*)"/g;

function captionTextSet(captionModel) {
  const texts = new Set();
  for (const value of Object.values(captionModel)) {
    if (typeof value === "string" && value.length > 0) {
      texts.add(escapeHtml(value));
    }
  }
  return texts;
}

/**
 * The figures {@link renderSheetHtml} will emit, in emission order, each with
 * the CLOSED set of text and attribute values the model permits it. The walk
 * mirrors `renderRigSection` → `renderRendererBlock` exactly, including its
 * `Object.hasOwn` slot filter and its "no pair view, no pair figure" rule, so
 * a missing, extra or reordered figure is itself a violation.
 *
 * @param {ReturnType<typeof sheetModel>} model
 * @returns {object[]}
 */
function expectedFigures(model) {
  const figures = [];
  const receiptHref = escapeHtml(model.receipt);
  const only = (value) => new Set(value === null ? [] : [String(value)]);
  for (const rigView of model.rigs) {
    for (const rendererView of rigView.renderers) {
      for (const slot of SLOT_IDS) {
        if (!Object.hasOwn(rendererView.cells, slot)) {
          continue;
        }
        const cellView = rendererView.cells[slot];
        const measured = cellView.state === "MEASURED";
        figures.push({
          where: `${rigView.id} · ${rendererView.renderer} · ${slot}`,
          texts: captionTextSet(cellCaptionModel(cellView, slot)),
          attributes: {
            alt: measured
              ? only(
                  escapeHtml(
                    cellAltText(slot, rigView.id, rendererView.renderer),
                  ),
                )
              : only(null),
            "aria-hidden": measured ? only(null) : only("true"),
            href: only(receiptHref),
            height: measured ? only(cellView.height) : only(null),
            loading: measured ? only("lazy") : only(null),
            src: measured ? only(escapeHtml(cellView.imagePath)) : only(null),
            width: measured ? only(cellView.width) : only(null),
          },
        });
      }
      const pairView = rendererView.pair;
      if (!pairView) {
        continue;
      }
      const measured = pairView.state === "MEASURED";
      figures.push({
        where: `${rigView.id} · ${rendererView.renderer} · pair`,
        texts: captionTextSet(pairCaptionModel(pairView)),
        attributes: {
          alt: measured
            ? only(escapeHtml(pairAltText(rigView.id, rendererView.renderer)))
            : only(null),
          "aria-hidden": measured ? only(null) : only("true"),
          href: only(receiptHref),
          height: only(null),
          loading: measured ? only("lazy") : only(null),
          src: measured ? only(escapeHtml(pairView.diffImagePath)) : only(null),
          width: only(null),
        },
      });
    }
  }
  return figures;
}

/**
 * Everything inside a rendered page's cell and pair figures that the page
 * MODEL did not produce — the structural form of "the sheet carries no
 * judgement".
 *
 * WHY THIS EXISTS BESIDE {@link findVerdictTokens} AND
 * {@link findUnknownClassNames}, RATHER THAN INSTEAD OF THEM. Those two are
 * word lists, and a word list only ever refuses the words someone thought of:
 * `mismatch 11.07% degraded` passed both, and passed a mismatch sweep too,
 * because the sweep's normaliser blanked the rest of the text node. A closed
 * set inverts the question. Every text node and every attribute value inside a
 * figure must be one the model computed — a label, a formatted numeral, a
 * provenance string, an image path, the receipt link — so ANY extra token is a
 * violation BY CONSTRUCTION, whether it is a word, an emoji, a `title`, a
 * `data-` attribute or an inline style.
 *
 * ITS BOUNDARY, STATED EXACTLY — AND CORRECTED. This function reads
 * `<figure>` BLOCKS ONLY, and its closed set comes FROM
 * {@link cellCaptionModel} / {@link pairCaptionModel}. So two cases are
 * outside it, and neither is covered by this function at all:
 *
 * 1. A judgement written INTO one of those caption tables is model-derived,
 *    and this function reports nothing (the lane's mutant `P6`).
 * 2. A judgement placed OUTSIDE every figure — the header, the nav, the
 *    summary counts, a rig heading — is not in a block this function reads.
 *
 * An earlier revision of this comment claimed case 1 was covered because "a
 * judgement keyed to the measurement moves the markup across a mismatch
 * sweep". That was TRUE FOR `mismatchPct` AND FALSE FOR EVERY OTHER MEASURED
 * VALUE: the sweep varied `mismatchPct` alone and held `changedPx`,
 * `tolerance`, `mssim`, `rawByteLumaMean` and `nonBlackFraction` fixed, so a
 * judgement keyed to one of those never moved the page (the verifier's
 * `M-MSSIM`, `M-CHANGEDPX` and `M-LUMA2`, each surviving 56 of 56 tests). It
 * said nothing at all about case 2 (`M-HEADER`). Both holes are now closed
 * where they actually live, and NOT by this function:
 *
 * - Case 1 by the spec's invariance assertion, which now varies EVERY
 *   measured value independently across its range plus `null` and requires
 *   the page to differ only in that number's own formatted text.
 * - Case 2 by {@link findForeignPageTokens}, the same closed-set rule applied
 *   to the WHOLE document — every text node and attribute value must come
 *   from the page model or from {@link PAGE_CHROME_TEXTS} /
 *   {@link PAGE_CHROME_ATTRIBUTES}.
 *
 * What this function alone still buys, and why it is kept beside the page-wide
 * one, is POSITION: it walks the figures in emission order and pins each one's
 * values to THAT figure, so a caption belonging to another cell, and a missing,
 * extra or reordered figure, are violations the page-wide union cannot see.
 * {@link findVerdictTokens} and {@link findUnknownClassNames} remain as word
 * lists — cheap, and readable in a receipt.
 *
 * @param {string} html A page from {@link renderSheetHtml}.
 * @param {ReturnType<typeof sheetModel>} model The model it was rendered from.
 * @returns {string[]} Violations; empty when every token came from the model.
 */
export function findForeignFigureTokens(html, model) {
  const violations = [];
  const blocks = String(html ?? "").match(FIGURE_BLOCK) ?? [];
  const expected = expectedFigures(model);
  if (blocks.length !== expected.length) {
    violations.push(
      `the page renders ${blocks.length} figures; the model describes ${expected.length}`,
    );
  }

  blocks.forEach((block, index) => {
    const figure = expected[index];
    const where = figure?.where ?? `figure ${index}`;
    const allowedClasses = new Set(PAGE_CLASS_NAMES);
    let cursor = 0;
    TAG_TOKEN.lastIndex = 0;
    let match;
    const reportText = (raw) => {
      const text = raw.trim();
      if (text.length === 0) {
        return;
      }
      if (text.includes("<") || text.includes(">")) {
        violations.push(`${where}: unparsed markup in a text node: ${text}`);
        return;
      }
      if (figure === undefined || !figure.texts.has(text)) {
        violations.push(
          `${where}: the text "${text}" is not one the page model produced`,
        );
      }
    };
    while ((match = TAG_TOKEN.exec(block)) !== null) {
      reportText(block.slice(cursor, match.index));
      cursor = match.index + match[0].length;
      const tagName = match[1].toLowerCase();
      if (!FIGURE_TAG_NAMES.includes(tagName)) {
        violations.push(`${where}: <${tagName}> is not a figure element`);
      }
      ATTRIBUTE_TOKEN.lastIndex = 0;
      let attribute;
      while ((attribute = ATTRIBUTE_TOKEN.exec(match[2] ?? "")) !== null) {
        const name = attribute[1].toLowerCase();
        const value = attribute[2];
        if (!FIGURE_ATTRIBUTE_NAMES.includes(name)) {
          violations.push(
            `${where}: the attribute ${name}="${value}" is not one a figure may carry`,
          );
          continue;
        }
        if (name === "class") {
          for (const token of value.split(/\s+/).filter(Boolean)) {
            if (!allowedClasses.has(token)) {
              violations.push(
                `${where}: the class "${token}" is not in the page's vocabulary`,
              );
            }
          }
          continue;
        }
        if (figure !== undefined && !figure.attributes[name].has(value)) {
          violations.push(
            `${where}: ${name}="${value}" is not a value the page model produced`,
          );
        }
      }
    }
    reportText(block.slice(cursor));
  });

  return violations;
}

// ---------------------------------------------------------------------------
// The same rule, applied to the WHOLE page
// ---------------------------------------------------------------------------

/** Element names the whole document may be built from. */
export const PAGE_TAG_NAMES = Object.freeze([
  "a",
  "body",
  "div",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "head",
  "header",
  "html",
  "img",
  "main",
  "meta",
  "nav",
  "p",
  "section",
  "small",
  "span",
  "style",
  "title",
]);

/** Attribute names the whole document may carry. */
export const PAGE_ATTRIBUTE_NAMES = Object.freeze([
  "alt",
  "aria-hidden",
  "aria-label",
  "charset",
  "class",
  "content",
  "height",
  "href",
  "id",
  "lang",
  "loading",
  "name",
  "src",
  "width",
]);

const PAGE_DOCTYPE = "<!doctype html>\n";
const STYLE_BLOCK = /<style>\n([\s\S]*?)\n<\/style>/;

/**
 * Every text and every attribute value the WHOLE page is permitted to carry —
 * the model's own strings, through the same tables the renderer reads, plus
 * the two exported chrome vocabularies.
 *
 * Union, not position: `findForeignFigureTokens` is the positional guard and
 * keeps that job. This set answers the different question "is this token
 * ANYWHERE in the page's closed vocabulary", which is the question the header,
 * the nav, the summary counts and a footer need answered.
 *
 * @param {ReturnType<typeof sheetModel>} model
 * @returns {{texts: Set<string>, attributes: Map<string, Set<string>>}}
 */
function expectedPageValues(model) {
  const texts = new Set(PAGE_CHROME_TEXTS);
  const attributes = new Map();
  const allow = (name, value) => {
    if (value === null || value === undefined) {
      return;
    }
    const values = attributes.get(name) ?? new Set();
    values.add(String(value));
    attributes.set(name, values);
  };

  for (const [name, values] of Object.entries(PAGE_CHROME_ATTRIBUTES)) {
    for (const value of values) {
      allow(name, value);
    }
  }
  for (const value of Object.values(pageChromeModel(model))) {
    texts.add(value);
  }
  allow("href", escapeHtml(model.receipt));

  for (const rigView of model.rigs) {
    const chrome = rigChromeModel(rigView);
    texts.add(chrome.heading);
    texts.add(chrome.description);
    texts.add(chrome.meta);
    allow("id", `rig-${chrome.slug}`);
    allow("href", `#rig-${chrome.slug}`);
    for (const rendererView of rigView.renderers) {
      texts.add(escapeHtml(rendererView.renderer));
    }
  }

  for (const figure of expectedFigures(model)) {
    for (const text of figure.texts) {
      texts.add(text);
    }
    for (const [name, values] of Object.entries(figure.attributes)) {
      for (const value of values) {
        allow(name, value);
      }
    }
  }

  texts.delete("");
  return { texts, attributes };
}

/**
 * Everything ANYWHERE in a rendered page that neither the page model nor the
 * page's fixed chrome vocabulary produced.
 *
 * WHY THE PAGE AND NOT JUST THE FIGURES. `findForeignFigureTokens` reads
 * `<figure>` blocks only, and the verifier's `M-HEADER` walked straight past
 * it: `<p class="summary">overall structure degraded</p>` in the page header,
 * keyed to a measured value, rendered with all three of the older guards
 * reporting `[]`. Outside a figure the only guard left was a twelve-word list,
 * and a word list refuses only the words someone thought of. So the closed-set
 * rule is applied to the whole document instead: every text node and every
 * attribute value must be one the MODEL produced (through
 * {@link pageChromeModel}, {@link rigChromeModel}, {@link cellCaptionModel},
 * {@link pairCaptionModel} and the image/receipt paths — the same tables the
 * renderer reads, so they cannot drift) or one of the enumerated chrome
 * entries in {@link PAGE_CHROME_TEXTS} / {@link PAGE_CHROME_ATTRIBUTES}.
 *
 * WHAT IS COVERED, EXACTLY:
 *
 * - The doctype, which must be the document's own.
 * - The `<style>` block, which must be this module's stylesheet BYTE FOR
 *   BYTE. It is the one region whose content is not walked — it is CSS, not
 *   markup — so it is pinned by identity instead, and a judgement smuggled
 *   into a selector or a `content:` string is a violation.
 * - Every element name, against {@link PAGE_TAG_NAMES}.
 * - Every attribute name, against {@link PAGE_ATTRIBUTE_NAMES}; every `class`
 *   token against {@link PAGE_CLASS_NAMES}; every other attribute VALUE
 *   against the page's closed set.
 * - Every non-whitespace text node, against the page's closed set.
 *
 * WHAT IS NOT: position. Two figures that swap captions, or a rig heading
 * printed in the header, satisfy this function and are caught by
 * {@link findForeignFigureTokens} and by the spec's invariance assertion
 * respectively. Neither guard subsumes the other, which is why both are run.
 *
 * @param {string} html A page from {@link renderSheetHtml}.
 * @param {ReturnType<typeof sheetModel>} model The model it was rendered from.
 * @returns {string[]} Violations; empty when the whole page is closed.
 */
export function findForeignPageTokens(html, model) {
  const violations = [];
  let document = String(html ?? "");

  if (document.startsWith(PAGE_DOCTYPE)) {
    document = document.slice(PAGE_DOCTYPE.length);
  } else {
    violations.push(
      `the page does not open with "${PAGE_DOCTYPE.trim()}" — it is not a document this guard can read`,
    );
  }

  const style = document.match(STYLE_BLOCK);
  if (style === null) {
    violations.push("the page carries no <style> block this guard can read");
  } else {
    if (style[1] !== PAGE_CSS) {
      violations.push(
        "the page's <style> block is not this module's own stylesheet, byte for byte",
      );
    }
    document = document.replace(style[0], "<style></style>");
  }

  const { texts, attributes } = expectedPageValues(model);
  const allowedClasses = new Set(PAGE_CLASS_NAMES);
  let where = "the document";
  let cursor = 0;
  const reportText = (raw) => {
    const text = raw.trim();
    if (text.length === 0) {
      return;
    }
    if (text.includes("<") || text.includes(">")) {
      violations.push(`${where}: unparsed markup in a text node: ${text}`);
      return;
    }
    if (!texts.has(text)) {
      violations.push(
        `${where}: the text "${text}" is neither content the page model produced nor page chrome`,
      );
    }
  };

  TAG_TOKEN.lastIndex = 0;
  let match;
  while ((match = TAG_TOKEN.exec(document)) !== null) {
    reportText(document.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const tagName = match[1].toLowerCase();
    if (!PAGE_TAG_NAMES.includes(tagName)) {
      violations.push(`<${tagName}> is not an element this page may carry`);
    }
    if (!match[0].startsWith("</")) {
      where = `<${tagName}>`;
    }
    ATTRIBUTE_TOKEN.lastIndex = 0;
    let attribute;
    while ((attribute = ATTRIBUTE_TOKEN.exec(match[2] ?? "")) !== null) {
      const name = attribute[1].toLowerCase();
      const value = attribute[2];
      if (!PAGE_ATTRIBUTE_NAMES.includes(name)) {
        violations.push(
          `<${tagName}>: the attribute ${name}="${value}" is not one this page may carry`,
        );
        continue;
      }
      if (name === "class") {
        for (const token of value.split(/\s+/).filter(Boolean)) {
          if (!allowedClasses.has(token)) {
            violations.push(
              `<${tagName}>: the class "${token}" is not in the page's vocabulary`,
            );
          }
        }
        continue;
      }
      if (!(attributes.get(name)?.has(value) ?? false)) {
        violations.push(
          `<${tagName}>: ${name}="${value}" is neither a value the page model produced nor page chrome`,
        );
      }
    }
  }
  reportText(document.slice(cursor));

  return violations;
}

/**
 * The `sheet-index.json` entry DX-106 banks (contract §3.1).
 *
 * @param {ReturnType<typeof sheetModel>} model
 * @param {{html: string, path: string, md5: string}} written The rendered
 *   HTML, the repo-relative POSIX path it was written to, and its md5.
 * @returns {object}
 */
export function sheetIndexEntry(model, { html, path, md5 }) {
  return {
    schemaVersion: 1,
    kind: "contact-sheet-index-entry",
    sheetId: model.sheetId,
    date: model.date,
    path,
    md5,
    byteLength: Buffer.byteLength(html, "utf8"),
    rigIds: model.rigs
      .map((rig) => rig.id)
      .slice()
      .sort(byCodeUnit),
    renderers: model.renderers.slice(),
    slots: model.slots.slice(),
    cells: {
      measured: model.counts.measured,
      unmeasured: model.counts.unmeasured,
    },
    manifest: "capture-manifest.json",
    generatedAt: model.generatedAt,
  };
}
