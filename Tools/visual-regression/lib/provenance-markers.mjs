// Shared enforcement for probe PROVENANCE MARKERS.
// @purpose Enforces bundler/formatter-proof provenance-marker strings for probes; encodes six recorded marker failure modes as shared validators.
// @status ACTIVE
//
// ★ THE RULE, with FIVE recorded strikes across the fleet behind it:
// A PROVENANCE MARKER MUST BE A STRING NEITHER THE BUNDLER NOR THE FORMATTER
// CAN REWRITE. A marker is matched against esbuild's OUTPUT while its source
// file has been through prettier. Anything either tool is free to rewrite is
// not a marker, it is a time bomb — the probe exits 2 in its own guard, never
// renders, and costs a full Edge cycle to discover.
//
// How it has actually failed:
//   S1         numeric literal        esbuild wrote `1.0` as `1`
//   Batch 765  prettier-wrapped call  the marker spanned a moved line break
//   Batch 766  whitespace             `function ()` emitted as `function()`
//   Batch 766  identifier renaming    local `data` emitted as `data2`
//   Batch 766  shape that never was   the marker described code the file lacked
//   Batch 766  distinctiveness        `data` passed every structural rule while
//                                     matching unrelated code in the same file
//
// ALLOWED: property names, and identifiers inside GLSL/WGSL sources (whose
// text becomes string CONTENT in the bundle and so cannot be renamed at all).
// FORBIDDEN: whitespace-adjacent syntax, local variable names, multi-token
// statements a formatter can wrap, numeric literals, and anything short enough
// to match unrelated code.
//
// ORIGIN: written as a spec case by the C12-29 S5 worker
// (`eclipse-globe-umbra.spec.mjs`, worktree `agent-a6de88899b2982d6c`) after
// the fourth strike, and extracted here verbatim in behaviour so the NEXT
// probe inherits it instead of rediscovering it. Both specs import this
// module; neither owns a private copy.
//
// @module provenance-markers

/**
 * A single bare identifier. One regex forecloses all of whitespace, formatter
 * wrapping, punctuation (`()`/`[]`/`;`/`=`/`.`) and leading numerals.
 */
export const BARE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Distinctiveness floor. Rename-proofness alone is not enough: a SHORT generic
 * identifier can satisfy every structural rule by matching something with
 * nothing to do with the slice. Measured on the real thing — the marker `data`
 * passed the property test purely because an unrelated `surfaceTile.data` and
 * a `data:` annotation lived in the same file, so its presence in the bundle
 * would have evidenced nothing. A long camelCase identifier in this codebase
 * is feature-specific by construction, which makes length a crude but honest
 * proxy.
 */
export const MIN_MARKER_LENGTH = 12;

/** Sources whose text becomes string CONTENT in the bundle. */
export const SHADER_FILE = /\.(glsl|wgsl)$/;

/**
 * Parse a probe's own `VERBATIM_SLICES` array out of its source text.
 *
 * Returns both the parsed entries AND the raw count of `marker:` keys, so a
 * malformed entry fails loudly instead of being silently skipped by the regex.
 *
 * @param {string} probeSource The probe file's text (CRLF-normalised inside).
 * @returns {{entries: Array<{file: string, marker: string, why: string}>, markerCount: number}}
 */
export function parseVerbatimSlices(probeSource) {
  const text = probeSource.replace(/\r\n/g, "\n");
  const start = text.indexOf("const VERBATIM_SLICES = [");
  if (start < 0) {
    throw new Error("VERBATIM_SLICES not found — the probe was restructured");
  }
  const end = text.indexOf("\n];", start);
  if (end <= start) {
    throw new Error("VERBATIM_SLICES terminator not found");
  }
  const block = text.slice(start, end);

  const entries = [];
  const entryPattern =
    /file:\s*"([^"]+)",\s*\n\s*marker:\s*"([^"]*)",\s*\n\s*why:\s*"([^"]*)"/g;
  let match = entryPattern.exec(block);
  while (match !== null) {
    entries.push({ file: match[1], marker: match[2], why: match[3] });
    match = entryPattern.exec(block);
  }
  const markerCount = (block.match(/\n\s*marker:/g) || []).length;
  return { entries, markerCount };
}

/**
 * Validate ONE slice against the four properties. Pure: the caller supplies
 * the named source file's text, so this module never touches the filesystem.
 *
 * @param {{file: string, marker: string, why: string}} entry
 * @param {string|undefined} sourceText Text of `entry.file`, or `undefined`
 *   when the file could not be read (reported as a failure, never thrown).
 * @returns {string[]} Human-readable failures; empty means the marker is sound.
 */
export function validateProvenanceMarker(entry, sourceText) {
  const failures = [];
  const marker = entry?.marker ?? "";

  // (1) SHAPE. Also the gate on arm (3): the property test builds a RegExp
  // from the marker, and an unsound marker can carry regex metacharacters
  // (`- earthOcclusion) * (1.0` threw "Unmatched ')'" the first time this
  // suite re-injected the numeric-literal strike). A malformed marker must be
  // REJECTED, never throw — and once the shape is wrong, the property test has
  // nothing meaningful to say anyway.
  const shapeOk = BARE_IDENTIFIER.test(marker);
  if (!shapeOk) {
    failures.push(
      `marker "${marker}" is not a single bare identifier — whitespace, punctuation, wrapping or a numeric literal can all be rewritten between source and bundle`,
    );
  }

  // (1a) JUSTIFICATION. The author has to say why it is rename-proof.
  if (!(entry?.why?.length > 10)) {
    failures.push(
      `marker "${marker}" has no justification for why it is rename-proof`,
    );
  }

  // (1b) DISTINCTIVENESS.
  if (marker.length < MIN_MARKER_LENGTH) {
    failures.push(
      `marker "${marker}" is too short to be distinctive — it can satisfy the rename-proof test by matching unrelated code in the same file`,
    );
  }

  // (2) PRESENCE in the file the entry names. This catches "the marker
  // describes a code shape this file has never had" at `node --test` time
  // instead of in the probe's guard, an Edge cycle later.
  const source = (sourceText ?? "").replace(/\r\n/g, "\n");
  if (sourceText === undefined) {
    failures.push(`source for ${entry?.file} could not be read`);
  } else if (!source.includes(marker)) {
    failures.push(`marker "${marker}" is absent from ${entry.file}`);
  }

  // (3) RENAME-PROOF. Shader sources become string CONTENT in the bundle, so
  // nothing in them can be renamed. Elsewhere the marker must be a PROPERTY
  // name — `x: …` or `.x` — which esbuild does not touch. A local binding
  // would appear as neither, which is exactly how a `const data` came to be
  // emitted as `data2`.
  if (
    shapeOk &&
    sourceText !== undefined &&
    !SHADER_FILE.test(entry?.file ?? "")
  ) {
    const asKey = new RegExp(`(^|[^\\w.])${marker}\\s*:`, "m");
    const asAccess = new RegExp(`\\.${marker}\\b`);
    if (!(asKey.test(source) || asAccess.test(source))) {
      failures.push(
        `marker "${marker}" is not a property name in ${entry.file} — a local binding is renameable on bundle-scope collision`,
      );
    }
  }

  return failures;
}

/**
 * Validate a whole probe's slice set.
 *
 * @param {object} options
 * @param {string} options.probeSource The probe file's text.
 * @param {(file: string) => string|undefined} options.readSource Resolver for
 *   a slice's `file` (repo-relative) to its text.
 * @param {number} [options.minEntries=6] Floor on how many slices a probe must
 *   carry, so provenance cannot be thinned to nothing.
 * @returns {{entries: Array, markerCount: number, failures: string[]}}
 */
export function validateProvenanceSlices({
  probeSource,
  readSource,
  minEntries = 6,
}) {
  const { entries, markerCount } = parseVerbatimSlices(probeSource);
  const failures = [];

  if (entries.length !== markerCount) {
    failures.push(
      `parsed ${entries.length} of ${markerCount} entries — an entry is missing its file/marker/why triple`,
    );
  }
  if (entries.length < minEntries) {
    failures.push(
      `only ${entries.length} provenance slices (minimum ${minEntries})`,
    );
  }
  for (const entry of entries) {
    let text;
    try {
      text = readSource(entry.file);
    } catch {
      text = undefined;
    }
    failures.push(...validateProvenanceMarker(entry, text));
  }
  return { entries, markerCount, failures };
}

// ── SOURCE PINS: the same class, one layer out ─────────────────────────────
//
// A provenance MARKER is matched against the bundle; a SOURCE PIN is an
// `assert.match(source, /.../)` in a spec, matched against a prettier-formatted
// file. Both fail the same way, and the pin class has now cost SIX cycles. The
// sixth was a pin using a literal space against a line measured at exactly 79
// characters — one under prettier's 80-column `printWidth`. Renaming the
// left-hand side or adding an indent level splits the call across four lines
// and the pin fails as a false regression in the feature it was pinning.
//
// Doctrine did not stop it, so the check is mechanical: a pin may not contain a
// literal space (use `\s+`/`\s*`, which survive any wrapping), and a pin whose
// target line sits within a margin of `printWidth` is fragile even if it
// matches today.

/** Prettier's configured print width for this repo (default). */
export const PRINT_WIDTH = 80;

/**
 * How close to `PRINT_WIDTH` a target line may sit before a pin against it is
 * considered fragile. One identifier rename or one indent level is ~2-8 chars.
 */
export const WIDTH_SAFETY_MARGIN = 8;

/**
 * Check one source pin for width fragility.
 *
 * @param {object} options
 * @param {RegExp|string} options.pattern The pin as written in the spec.
 * @param {string} options.sourceText Text of the file the pin is matched against.
 * @param {string} [options.label] Name used in failure messages.
 * @returns {string[]} Failures; empty means the pin is wrap-proof.
 */
export function checkSourcePinWidth({ pattern, sourceText, label = "pin" }) {
  const failures = [];
  const src = String(pattern instanceof RegExp ? pattern.source : pattern);

  // (1) A literal space is the defect itself — it cannot survive a wrap.
  // Spaces inside a character class are the author's explicit choice, so they
  // are stripped before the test.
  const withoutClasses = src.replace(/\[[^\]]*\]/g, "");
  if (/ /.test(withoutClasses)) {
    failures.push(
      `${label}: contains a literal space — use \\s+ or \\s* so the pin survives a prettier wrap`,
    );
  }

  // (2) A near-printWidth target line means the shape is about to change —
  // but that only MATTERS if the pattern cannot absorb the whitespace a wrap
  // inserts. Pins are matched against whole-file text, where `\s` spans
  // newlines, so a `\s+`/`\s*`-tolerant pin survives the re-wrap and is not
  // fragile. Firing on it anyway would reject the correct fix alongside the
  // broken one, which is how a check ends up disabled.
  const absorbsWrap = /\\s[*+]/.test(src);
  if (!absorbsWrap && typeof sourceText === "string" && sourceText.length > 0) {
    let re;
    try {
      re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    } catch {
      failures.push(`${label}: is not a valid pattern`);
      return failures;
    }
    const lines = sourceText.replace(/\r\n/g, "\n").split("\n");
    const hits = lines.filter((l) => re.test(l));
    for (const line of hits) {
      if (line.length > PRINT_WIDTH - WIDTH_SAFETY_MARGIN) {
        failures.push(
          `${label}: target line is ${line.length} chars, within ${WIDTH_SAFETY_MARGIN} of printWidth ${PRINT_WIDTH} — ` +
            `one rename or indent will re-wrap it and the pin will fail as a false regression`,
        );
      }
    }
  }
  return failures;
}

/**
 * Throwing wrapper, so a spec can state the requirement in one line.
 *
 * @param {object} options See {@link checkSourcePinWidth}.
 */
export function assertSourcePinIsWidthSafe(options) {
  const failures = checkSourcePinWidth(options);
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
}

export default {
  BARE_IDENTIFIER,
  MIN_MARKER_LENGTH,
  SHADER_FILE,
  PRINT_WIDTH,
  WIDTH_SAFETY_MARGIN,
  parseVerbatimSlices,
  validateProvenanceMarker,
  validateProvenanceSlices,
  checkSourcePinWidth,
  assertSourcePinIsWidthSafe,
};
