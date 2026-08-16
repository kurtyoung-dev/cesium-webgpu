// purpose-header.mjs — the shared `@purpose` / `@status` header grammar.
//
// @purpose The one shared @purpose/@status header grammar (parse, locate, byte-exact splice, violations) used by the codemod, the catalog generator and the fleet-contract analyzer.
// @status ACTIVE

//
// WHY THIS EXISTS. Maintainer rulings M2 and M4 of the .mjs library audit
// (`migration_doc/TOOLING_CATALOG.md`) put self-registration in place of a
// hand-maintained index: a tooling file declares its own one-line purpose and
// lifecycle status in its header, the catalog is regenerated from those
// headers, and the fleet contract enforces that probes and gate libraries carry
// them. Three consumers therefore have to agree on one grammar — the codemod
// that writes the headers (`Tools/inject-purpose-headers.mjs`), the generator
// that reads them (`Tools/generate-tooling-catalog.mjs`), and the analyzer the
// fleet contract calls (`Tools/visual-regression/lib/probe-fleet-contract.mjs`).
// Three private parsers is how a grammar drifts into three grammars, so this is
// the single home (executor charter 3.3, "shared homes before hand-rolling").
//
// THE GRAMMAR, IN ONE PARAGRAPH. Inside a file's FIRST comment block — a run of
// `//` lines or one `/* … */` block, either one allowed to sit under a shebang
// — a line whose comment text begins with `@purpose ` carries the one-line
// purpose, and a line beginning with `@status ` carries one of ACTIVE,
// INVESTIGATION or ARCHIVED-CANDIDATE. `@class`, `@supersededBy` and `@note`
// are optional and read by the generator when present; nothing writes them by
// default. Tags outside the first comment block do not count — a header that
// can hide anywhere is a header nobody can review.
//
// BYTE-EXACTNESS. `splitLines` keeps every line's own terminator, and
// `joinLines(splitLines(x)) === x` for any input, so an injection is a splice
// of new lines rather than a re-serialization of the file. That matters on this
// repository specifically: it checks out with `core.autocrlf=true`, so a naive
// `split("\n").join("\n")` would silently rewrite every CRLF in ~990 files.

/** Header status vocabulary. Add-only; the generator and the spec read this. */
export const PURPOSE_STATUSES = Object.freeze([
  "ACTIVE",
  "INVESTIGATION",
  "ARCHIVED-CANDIDATE",
]);

/**
 * Audit-vocabulary status -> header status, or `null` for "do not touch".
 *
 * The audit graded with a wider vocabulary than the header carries, because it
 * was recording evidence rather than a lifecycle. The narrowing is deliberate
 * and is the mapping ruled for the codemod: everything still in service reads
 * ACTIVE (including the one DELIBERATE_RED_FLAG probe, which is in service
 * precisely by failing), everything whose conclusion was banked elsewhere reads
 * INVESTIGATION. The two `null` rows are frozen or honestly unclear and are
 * skipped rather than guessed.
 */
export const AUDIT_STATUS_TO_HEADER = Object.freeze({
  ACTIVE: "ACTIVE",
  DELIBERATE_RED_FLAG: "ACTIVE",
  INVESTIGATION_ARTIFACT: "INVESTIGATION",
  LIKELY_SUPERSEDED: "INVESTIGATION",
  BROKEN_STALE: "INVESTIGATION",
  HELD_FOR_D8: null,
  UNKNOWN: null,
});

/** Tags this grammar recognises. Unknown `@foo` lines are ignored, not errors. */
export const PURPOSE_TAGS = Object.freeze([
  "purpose",
  "status",
  "class",
  "supersededBy",
  "note",
]);

/** How far the stanza scan may walk before it gives up and inserts. */
const STANZA_LINE_LIMIT = 8;

/**
 * Split source into lines that remember their own terminator.
 *
 * @param {string} source File text.
 * @returns {{text: string, eol: string}[]} One entry per line; the last entry
 *   has an empty `eol` when the file does not end with a newline.
 */
export function splitLines(source) {
  const lines = [];
  let start = 0;
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "\n") {
      lines.push({ text: source.slice(start, i), eol: "\n" });
      i += 1;
      start = i;
    } else if (c === "\r") {
      const crlf = source[i + 1] === "\n";
      lines.push({ text: source.slice(start, i), eol: crlf ? "\r\n" : "\r" });
      i += crlf ? 2 : 1;
      start = i;
    } else {
      i += 1;
    }
  }
  if (start < source.length) {
    lines.push({ text: source.slice(start), eol: "" });
  }
  return lines;
}

/**
 * Inverse of `splitLines`.
 *
 * @param {{text: string, eol: string}[]} lines Lines.
 * @returns {string} The reassembled source.
 */
export function joinLines(lines) {
  let out = "";
  for (const line of lines) {
    out += line.text + line.eol;
  }
  return out;
}

/**
 * The line terminator a newly inserted line should use.
 *
 * @param {{text: string, eol: string}[]} lines Lines.
 * @param {number} near Index whose terminator is preferred.
 * @returns {string} "\r\n", "\n" or "\r".
 */
export function eolNear(lines, near) {
  for (const index of [near, near - 1, near + 1]) {
    const eol = lines[index]?.eol;
    if (eol) {
      return eol;
    }
  }
  for (const line of lines) {
    if (line.eol) {
      return line.eol;
    }
  }
  return "\n";
}

/**
 * The prose inside a comment line, with the comment punctuation removed.
 *
 * Deliberately tolerant: it is fed slash-slash lines, a JSDoc opener, a
 * continuation star, a closing line and a bare slash-slash, and every one of
 * those spellings appears in the fleet's headers.
 *
 * @param {string} raw Raw line text.
 * @returns {string} The comment's prose, trimmed.
 */
export function commentText(raw) {
  let t = raw.trim();
  if (t.startsWith("/**")) {
    t = t.slice(3);
  } else if (t.startsWith("/*")) {
    t = t.slice(2);
  } else if (t.startsWith("//")) {
    t = t.replace(/^\/+/, "");
  } else if (t.startsWith("*")) {
    t = t.replace(/^\*+/, "");
  }
  if (t.endsWith("*/")) {
    t = t.slice(0, -2);
  }
  return t.trim();
}

/**
 * Locate the file's header comment block.
 *
 * @param {{text: string, eol: string}[]} lines Lines.
 * @returns {{kind: string, start: number, end: number, prefix: string, insertAt: number}}
 *   `kind` is "line", "star", "none" (no header) or "unterminated" (a `/*` that
 *   never closes — reported so a caller can refuse rather than guess).
 *   `insertAt` is where a freshly created stanza belongs.
 */
export function locateHeaderBlock(lines) {
  let i = 0;
  if (lines[0]?.text.startsWith("#!")) {
    i = 1;
  }
  const insertAt = i;
  while (i < lines.length && lines[i].text.trim() === "") {
    i += 1;
  }
  const first = lines[i];
  const none = { kind: "none", start: -1, end: -1, prefix: "// ", insertAt };
  if (!first) {
    return none;
  }
  const indent = first.text.slice(
    0,
    first.text.length - first.text.trimStart().length,
  );
  const body = first.text.trimStart();
  if (body.startsWith("//")) {
    let end = i;
    while (
      end + 1 < lines.length &&
      lines[end + 1].text.trimStart().startsWith("//")
    ) {
      end += 1;
    }
    return { kind: "line", start: i, end, prefix: `${indent}// `, insertAt };
  }
  if (body.startsWith("/*")) {
    let end = i;
    // A `/* … */` that opens and closes on its own first line has no interior
    // to extend, so it is treated as "no header" for insertion purposes; its
    // tags are still parsed by `parsePurposeHeader`.
    if (body.slice(2).includes("*/")) {
      return { ...none, start: i, end: i, kind: "none" };
    }
    while (end < lines.length && !lines[end].text.includes("*/")) {
      end += 1;
    }
    if (end >= lines.length) {
      return {
        kind: "unterminated",
        start: i,
        end: lines.length - 1,
        prefix: `${indent} * `,
        insertAt,
      };
    }
    return { kind: "star", start: i, end, prefix: `${indent} * `, insertAt };
  }
  return none;
}

/**
 * Read the header tags out of a file.
 *
 * @param {string} source File text.
 * @returns {{block: object, tags: Map<string, {value: string, line: number}>,
 *   purpose: string|null, status: string|null, className: string|null,
 *   supersededBy: string|null, note: string|null, errors: string[]}} Parse.
 */
export function parsePurposeHeader(source) {
  const lines = splitLines(source);
  const block = locateHeaderBlock(lines);
  const tags = new Map();
  const errors = [];
  if (block.kind === "unterminated") {
    errors.push("header block comment is never closed");
  }
  if (block.start >= 0) {
    for (let i = block.start; i <= block.end && i < lines.length; i++) {
      const text = commentText(lines[i].text);
      const m = /^@([A-Za-z][\w-]*)\s*:?\s+(.*)$/.exec(text);
      if (m === null) {
        continue;
      }
      const name = m[1];
      if (!PURPOSE_TAGS.includes(name)) {
        continue;
      }
      if (tags.has(name)) {
        errors.push(`duplicate @${name} in the header block`);
        continue;
      }
      tags.set(name, { value: m[2].trim(), line: i });
    }
  }
  const status = tags.get("status")?.value ?? null;
  if (status !== null && !PURPOSE_STATUSES.includes(status)) {
    errors.push(
      `@status "${status}" is not one of ${PURPOSE_STATUSES.join(" | ")}`,
    );
  }
  return {
    block,
    tags,
    purpose: tags.get("purpose")?.value ?? null,
    status,
    className: tags.get("class")?.value ?? null,
    supersededBy: tags.get("supersededBy")?.value ?? null,
    note: tags.get("note")?.value ?? null,
    errors,
  };
}

/**
 * Collapse a purpose to the one line the grammar allows.
 *
 * @param {string} text Raw purpose text.
 * @returns {string} Single-line, whitespace-collapsed purpose.
 */
export function normalizePurpose(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Where the tag stanza belongs inside an existing header block.
 *
 * Ruling M2 puts the tags "after the first line" of the header. Taken
 * literally that splits a wrapped opening sentence in half, and 353 of the
 * fleet's 627 `//` headers wrap their first line. So the scan starts at the
 * first line and walks forward only while the opening sentence is visibly
 * unfinished — it stops at the first terminator, the first blank comment line,
 * or `STANZA_LINE_LIMIT`, whichever comes first. On a header whose first line
 * is a complete sentence, that is exactly "after its first line".
 *
 * @param {{text: string, eol: string}[]} lines Lines.
 * @param {object} block Result of `locateHeaderBlock`.
 * @returns {number} Index of the last line of the opening stanza.
 */
export function stanzaEndLine(lines, block) {
  let i = block.start;
  if (block.kind === "star" && commentText(lines[i].text) === "") {
    i += 1;
  }
  let steps = 0;
  while (i < block.end && steps < STANZA_LINE_LIMIT) {
    steps += 1;
    const text = commentText(lines[i].text);
    if (text === "" || /[.!?:;]$/.test(text)) {
      break;
    }
    if (commentText(lines[i + 1]?.text ?? "") === "") {
      break;
    }
    i += 1;
  }
  return Math.min(i, block.end);
}

/**
 * Render the tag lines for a comment style.
 *
 * @param {string} prefix Comment prefix, e.g. "// " or " * ".
 * @param {{purpose: string, status: string, className?: string|null}} fields Tags.
 * @param {string} eol Line terminator to use.
 * @returns {{text: string, eol: string}[]} Lines ready to splice.
 */
export function renderTagLines(prefix, fields, eol) {
  const out = [{ text: `${prefix}@purpose ${fields.purpose}`, eol }];
  out.push({ text: `${prefix}@status ${fields.status}`, eol });
  if (fields.className) {
    out.push({ text: `${prefix}@class ${fields.className}`, eol });
  }
  return out;
}

/**
 * The comment prefix an existing header line uses, so an in-place update keeps
 * the file's own style instead of imposing this module's.
 *
 * @param {string} raw Raw line text.
 * @returns {string} Prefix up to and including the trailing space.
 */
function prefixOf(raw) {
  const m = /^(\s*(?:\/\/+|\*+|\/\*+)\s?)/.exec(raw);
  return m === null ? "// " : m[1];
}

/**
 * Inject or refresh a file's `@purpose` / `@status` header.
 *
 * Idempotent by construction: a file that already carries `@purpose` has that
 * line REWRITTEN in place (never duplicated), and re-running with unchanged
 * fields returns the input text unchanged.
 *
 * @param {string} source File text.
 * @param {{purpose: string, status: string, className?: string|null}} fields Tags.
 * @returns {{text: string, action: string, error: string|null}} Result;
 *   `action` is "inserted", "updated", "unchanged" or "failed".
 */
export function injectPurposeHeader(source, fields) {
  const purpose = normalizePurpose(fields.purpose);
  const status = fields.status;
  if (purpose === "") {
    return { text: source, action: "failed", error: "empty @purpose" };
  }
  if (!PURPOSE_STATUSES.includes(status)) {
    return {
      text: source,
      action: "failed",
      error: `@status "${status}" is not one of ${PURPOSE_STATUSES.join(" | ")}`,
    };
  }
  const lines = splitLines(source);
  const parsed = parsePurposeHeader(source);
  if (parsed.block.kind === "unterminated") {
    return {
      text: source,
      action: "failed",
      error: "header block comment is never closed",
    };
  }
  if (parsed.errors.some((e) => e.startsWith("duplicate"))) {
    return { text: source, action: "failed", error: parsed.errors[0] };
  }

  const purposeTag = parsed.tags.get("purpose");
  if (purposeTag) {
    // Update in place. The prefix comes from the line being replaced so a
    // JSDoc header stays JSDoc and a `//` header stays `//`.
    const prefix = prefixOf(lines[purposeTag.line].text);
    lines[purposeTag.line] = {
      text: `${prefix}@purpose ${purpose}`,
      eol: lines[purposeTag.line].eol,
    };
    const statusTag = parsed.tags.get("status");
    if (statusTag) {
      const statusPrefix = prefixOf(lines[statusTag.line].text);
      lines[statusTag.line] = {
        text: `${statusPrefix}@status ${status}`,
        eol: lines[statusTag.line].eol,
      };
    } else {
      lines.splice(purposeTag.line + 1, 0, {
        text: `${prefix}@status ${status}`,
        eol: eolNear(lines, purposeTag.line),
      });
    }
    if (fields.className) {
      const classTag = parsed.tags.get("class");
      if (classTag) {
        const classPrefix = prefixOf(lines[classTag.line].text);
        lines[classTag.line] = {
          text: `${classPrefix}@class ${fields.className}`,
          eol: lines[classTag.line].eol,
        };
      } else {
        // Two lines below @purpose: past the @status line written above.
        lines.splice(purposeTag.line + 2, 0, {
          text: `${prefix}@class ${fields.className}`,
          eol: eolNear(lines, purposeTag.line),
        });
      }
    }
    const text = joinLines(lines);
    return {
      text,
      action: text === source ? "unchanged" : "updated",
      error: null,
    };
  }

  const block = parsed.block;
  if (block.kind === "line" || block.kind === "star") {
    const at = stanzaEndLine(lines, block);
    const eol = eolNear(lines, at);
    const inserted = renderTagLines(
      block.prefix,
      { ...fields, purpose, status },
      eol,
    );
    // A spacer keeps the tags from reading as a continuation of the prose that
    // follows them; it is only added when prose actually follows.
    if (commentText(lines[at + 1]?.text ?? "") !== "") {
      inserted.push({ text: block.prefix.trimEnd(), eol });
    }
    lines.splice(at + 1, 0, ...inserted);
    return { text: joinLines(lines), action: "inserted", error: null };
  }

  // No header at all: create the minimal one, under any shebang.
  const at = block.insertAt;
  const eol = eolNear(lines, at);
  const inserted = renderTagLines("// ", { ...fields, purpose, status }, eol);
  if ((lines[at]?.text ?? "").trim() !== "") {
    inserted.push({ text: "", eol });
  }
  lines.splice(at, 0, ...inserted);
  return { text: joinLines(lines), action: "inserted", error: null };
}

/**
 * The contract check ruling M4 enforces over probes and gate libraries.
 *
 * Fails CLOSED, in the same spirit as the rest of the fleet contract: a header
 * this parser cannot read is reported as a violation, so an exotic spelling
 * lands in the allowlist where a reviewer sees it rather than passing silently.
 *
 * @param {string} source File text.
 * @returns {string[]} Violations, empty when the file complies.
 */
export function purposeHeaderViolations(source) {
  const parsed = parsePurposeHeader(source);
  const violations = [];
  if (parsed.purpose === null) {
    violations.push("no @purpose header");
  } else if (normalizePurpose(parsed.purpose).length < 12) {
    violations.push("@purpose is not a sentence");
  }
  if (parsed.status === null) {
    violations.push("no @status header");
  } else if (!PURPOSE_STATUSES.includes(parsed.status)) {
    violations.push(`@status is not one of ${PURPOSE_STATUSES.join(" | ")}`);
  }
  return violations;
}
