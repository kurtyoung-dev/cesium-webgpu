#!/usr/bin/env node
/**
 * Orientation-mirror verification.
 * @purpose Fail closed when a status asserted by a reader-facing orientation document disagrees with, or cannot be resolved against, its campaign queue authority.
 * @status ACTIVE
 *
 * WHY THIS EXISTS. A few hand-maintained orientation documents summarize queue
 * state for readers who should not have to open every queue. The queues are the
 * status authorities; the orientation documents are only mirrors. A silent
 * drift is worse than an absent mirror because readers naturally trust the
 * shorter document they actually opened. Two such drifts were found in one
 * week: each mirror called work finished while its queue had it reopened or
 * otherwise open, and no mechanical comparison existed.
 *
 * MIRROR GRAMMAR. This verifier intentionally recognizes only two closed
 * logical-list-block forms. Fenced and indented code is never authoritative:
 *
 * - CAMPAIGN_PORTFOLIO_QUEUE.md: a numbered item whose bold heading is
 *   `<ROWID>[ / <ROWID>...] — <STATUS CLAIM>:`. A heading with only
 *   `<ROWID>:` has no status claim and is ignored.
 * - CAMPAIGN_STATE.md: a bullet containing one or more exact inline-code row
 *   IDs, optionally joined by `/`, followed on the same line by `is`, `are`,
 *   or `remains` and a prose-adjacent status claim, or directly by a
 *   closed-vocabulary status. A slice token immediately outside an inline-code
 *   base ID is part of that reference. Struck-through spans are ignored.
 *   A status may continue on an indented line of the same list block.
 *
 * QUEUE GRAMMAR. Queue files are discovered from
 * `migration_doc/QUEUE_*_CAMPAIGN*.md`. A canonical row is a Markdown table
 * line whose first cell begins with a backticked row ID. A table header with a
 * `Status` or `State` term makes every row a candidate. In other tables, a row
 * is a candidate only when a non-ID cell positively parses as a status source.
 * Inside a canonical row, the first live bold span or the status cell that
 * begins with the closed vocabulary is the operative status.
 * An optional `W<number>`/`W<number> TAIL` prefix is allowed before that status.
 * A backticked descriptive title followed by an em dash is also an allowed
 * prefix; the title itself is never interpreted as status text.
 * A spaced slice suffix resolves only through an explicit slice declaration in
 * the base row. If any canonical candidate is unresolved, or duplicate
 * candidates conflict, the status is unresolvable; no candidate wins by
 * position.
 *
 * Bold text is only a location signal after the closed vocabulary agrees. It
 * is never itself evidence that arbitrary uppercase prose is a status.
 *
 * COMPARISON. Status sets are compared subset-compatibly, not for equality.
 * A mirror legitimately summarizes, so it may state FEWER terms than its
 * authority: a portfolio row reading COMPLETE against a queue row reading
 * COMPLETE / IMPLEMENTED / VERIFIED / LANDED is terser, not wrong. Two things
 * remain contradictions and still fail. First, a mirror may not state a term
 * its authority does not state — COMPLETE against an authority that says only
 * RESOLVED / LANDED asserts a disposition nobody granted. Second, a mirror may
 * not DROP an open-state term (`OPEN_STATE_TERMS`): omitting REOPENED from
 * COMPLETE / REOPENED is precisely the drift this verifier exists to catch, so
 * the tolerance for verbosity stops at the terms that decide whether a row is
 * finished.
 *
 * Usage:
 *   node Tools/verify-orientation-mirror.mjs [--repo <path>]
 *        [--mirror <doc>...] [--allowlist <file>] [--json]
 *   node Tools/verify-orientation-mirror.mjs --help
 *
 * Exit: 0 mirror claims agree · 1 disagreement/unresolvable · 2 cannot determine
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STATUS_VOCABULARY = Object.freeze([
  "NOT STARTED",
  "NOT COMPLETE",
  "IN PROGRESS",
  "EDGE VERIFIED",
  "COMPLETE",
  "RESOLVED",
  "LANDED",
  "VERIFIED",
  "IMPLEMENTED",
  "PARTIAL",
  "OPEN",
  "REOPENED",
  "VACATED",
  "BLOCKED",
  "DEFERRED",
  "WITHDRAWN",
  "PENDING",
  "HELD",
  "CLOSED",
]);

const DEFAULT_MIRRORS = Object.freeze([
  "migration_doc/CAMPAIGN_PORTFOLIO_QUEUE.md",
  "migration_doc/CAMPAIGN_STATE.md",
]);
const DEFAULT_ALLOWLIST = "Tools/orientation-mirror-allowlist.json";
const ROW_ID_BASE_SOURCE = String.raw`C\d+-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*`;
const ROW_ID_SOURCE = String.raw`${ROW_ID_BASE_SOURCE}(?:\s+[A-Za-z]\d+)?`;
const ROW_ID_EXACT = new RegExp(`^${ROW_ID_SOURCE}$`, "i");
const QUEUE_NAME = /^QUEUE_.*_CAMPAIGN-?(\d+).*\.md$/i;

const HELP_TEXT = `Usage:
  node Tools/verify-orientation-mirror.mjs [--repo <path>] [--mirror <doc>…] [--allowlist <file>] [--json]
  node Tools/verify-orientation-mirror.mjs --help

Compare status-claiming campaign-row references in orientation mirrors with
the canonical table rows in their campaign queue authorities.

Options:
  --repo <path>       Repository root. Default: current working directory.
  --mirror <doc>...   One or more repo-relative mirror documents. The option
                      may be repeated. Defaults to the portfolio and state docs.
  --allowlist <file>  Repo-relative JSON allowlist. Default:
                      Tools/orientation-mirror-allowlist.json.
  --json              Emit one deterministic JSON report.
  --help              Show this help and exit 0.

Default mirrors:
  migration_doc/CAMPAIGN_PORTFOLIO_QUEUE.md
  migration_doc/CAMPAIGN_STATE.md

Authorities:
  migration_doc/QUEUE_*_CAMPAIGN*.md, discovered at runtime and mapped by the
  campaign number at the start of each row ID.

Exit codes:
  0  Every status-claiming reference agrees, after allowlisting.
  1  At least one disagreement or unresolvable row/status remains.
  2  Cannot determine because an input, repository, or authority is unusable.`;

const STATUS_MATCHERS = [...STATUS_VOCABULARY]
  .sort((left, right) => right.length - left.length || bytewise(left, right))
  .map((status) => ({
    status,
    pattern: new RegExp(
      `^${escapeRegex(status).replaceAll(" ", String.raw`\s+`)}(?=$|[^A-Za-z0-9])`,
      "i",
    ),
  }));

function bytewise(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripStrikethrough(text) {
  const stripped = text.replace(/~~[\s\S]*?~~/gu, (span) =>
    span.replace(/[^\r\n]/gu, " "),
  );
  return stripped;
}

function sanitizeMarkdownLines(text) {
  const lines = stripStrikethrough(text).split(/\r?\n/u);
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      const closing = new RegExp(
        `^ {0,3}${escapeRegex(fence.marker)}{${fence.length},}\\s*$`,
        "u",
      );
      if (closing.test(line)) {
        fence = null;
      }
      lines[index] = "";
      continue;
    }

    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/u);
    if (opening) {
      fence = { marker: opening[1][0], length: opening[1].length };
      lines[index] = "";
      continue;
    }
    if (/^(?: {4}|\t)/u.test(line)) {
      lines[index] = "";
    }
  }
  return lines.map((line, index) => ({ text: line, line: index + 1 }));
}

function joinLogicalBlock(parts) {
  return parts.join(" ");
}

function collectLogicalListBlocks(lines, starter) {
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!starter.test(lines[index].text)) {
      continue;
    }
    const parts = [lines[index].text.trimEnd()];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const continuation = lines[cursor].text;
      if (
        continuation.trim().length === 0 ||
        /^\s*(?:[-+*]|\d+\.)\s+/u.test(continuation) ||
        !/^ {1,3}\S/u.test(continuation)
      ) {
        break;
      }
      parts.push(continuation.trim());
    }
    blocks.push({
      text: joinLogicalBlock(parts),
      line: lines[index].line,
    });
  }
  return blocks;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function normalizeRowId(value) {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

function normalizeMirrorKey(value) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`allowlist mirror must be a repo-relative path: ${value}`);
  }
  return path.posix.normalize(normalized);
}

function parseArguments(argv) {
  const options = {
    repo: process.cwd(),
    mirrors: [],
    allowlist: DEFAULT_ALLOWLIST,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--repo" || argument === "--allowlist") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--repo") {
        options.repo = value;
      } else {
        options.allowlist = value;
      }
      index += 1;
      continue;
    }
    if (argument === "--mirror") {
      const start = index + 1;
      while (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
        options.mirrors.push(argv[index + 1]);
        index += 1;
      }
      if (index < start) {
        throw new Error("--mirror requires at least one document");
      }
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  if (options.mirrors.length === 0) {
    options.mirrors = [...DEFAULT_MIRRORS];
  }
  return options;
}

function assertRepository(repoArgument) {
  const repo = path.resolve(repoArgument);
  try {
    if (!statSync(repo).isDirectory()) {
      throw new Error("not a directory");
    }
    if (!statSync(path.join(repo, "migration_doc")).isDirectory()) {
      throw new Error("migration_doc is absent");
    }
  } catch (error) {
    throw new Error(`repository path is unusable: ${repo} (${error.message})`, {
      cause: error,
    });
  }
  return repo;
}

function resolveRepoFile(repo, requested, label) {
  const absolute = path.resolve(repo, requested);
  const relative = path.relative(repo, absolute);
  if (
    relative.length === 0 ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must be inside the repository: ${requested}`);
  }
  return { absolute, doc: toPosix(relative) };
}

function readRequiredText(file, label) {
  try {
    return readFileSync(file.absolute, "utf8");
  } catch (error) {
    throw new Error(
      `${label} is missing or unreadable: ${file.doc} (${error.message})`,
      { cause: error },
    );
  }
}

function parseAllowlist(repo, requested) {
  const file = resolveRepoFile(repo, requested, "allowlist file");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file.absolute, "utf8"));
  } catch (error) {
    throw new Error(
      `allowlist is missing or malformed: ${file.doc} (${error.message})`,
      { cause: error },
    );
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.entries)
  ) {
    throw new Error(
      `allowlist is malformed: ${file.doc} must contain version 1 and an entries array`,
    );
  }

  const entries = [];
  const seen = new Set();
  for (const [index, entry] of parsed.entries.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`allowlist entry ${index} must be an object`);
    }
    if (typeof entry.rowId !== "string" || !ROW_ID_EXACT.test(entry.rowId)) {
      throw new Error(`allowlist entry ${index} has an invalid rowId`);
    }
    const normalizedRowId = normalizeRowId(entry.rowId);
    if (entry.rowId !== normalizedRowId) {
      throw new Error(
        `allowlist entry ${index} rowId must use canonical uppercase single-space spelling`,
      );
    }
    if (typeof entry.mirror !== "string") {
      throw new Error(`allowlist entry ${index} has an invalid mirror`);
    }
    if (typeof entry.reason !== "string") {
      throw new Error(
        `allowlist entry ${index} requires a human reason string`,
      );
    }
    const normalizedReason = entry.reason.normalize("NFKC").trim();
    if (!/[\p{L}\p{N}]/u.test(normalizedReason)) {
      throw new Error(
        `allowlist entry ${index} reason must contain a visible letter or number`,
      );
    }

    const normalized = {
      rowId: normalizedRowId,
      mirror: normalizeMirrorKey(entry.mirror),
      reason: normalizedReason,
    };
    const key = `${normalized.rowId}\u0000${normalized.mirror}`;
    if (seen.has(key)) {
      throw new Error(
        `allowlist contains a duplicate row/mirror entry: ${normalized.rowId} ${normalized.mirror}`,
      );
    }
    seen.add(key);
    entries.push(normalized);
  }

  return { file: file.doc, entries };
}

function discoverQueues(repo) {
  const directory = path.join(repo, "migration_doc");
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `queue directory is unreadable: migration_doc (${error.message})`,
      { cause: error },
    );
  }

  const queues = entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const match = entry.name.match(QUEUE_NAME);
      if (!match) {
        return null;
      }
      return {
        campaign: Number.parseInt(match[1], 10),
        doc: `migration_doc/${entry.name}`,
        absolute: path.join(directory, entry.name),
      };
    })
    .filter(Boolean)
    .sort((left, right) => bytewise(left.doc, right.doc));

  if (queues.length === 0) {
    throw new Error(
      "no queue authority documents match migration_doc/QUEUE_*_CAMPAIGN*.md",
    );
  }
  return queues;
}

function matchStatusAtStart(text, caseSensitive) {
  for (const matcher of STATUS_MATCHERS) {
    const match = text.match(matcher.pattern);
    if (
      match &&
      (!caseSensitive || match[0].replace(/\s+/g, " ") === matcher.status)
    ) {
      return { status: matcher.status, length: match[0].length };
    }
  }
  return null;
}

function cleanStatusText(raw) {
  return raw.replaceAll("**", "").trim().replace(/^★\s*/u, "");
}

function parseClosedStatus(raw, { caseSensitive = false } = {}) {
  const text = cleanStatusText(raw);
  let remaining = text;
  const terms = [];
  let matched = matchStatusAtStart(remaining, caseSensitive);
  if (!matched) {
    return null;
  }

  while (matched) {
    terms.push(matched.status);
    remaining = remaining.slice(matched.length).trimStart();

    const compound = remaining.match(/^(?:\/|\+|,|\bbut\b|\band\b)\s*/i);
    if (compound) {
      remaining = remaining.slice(compound[0].length).trimStart();
      matched = matchStatusAtStart(remaining, caseSensitive);
      if (!matched) {
        return null;
      }
      continue;
    }

    const dash = remaining.match(/^(?:—|–|-)\s*/u);
    if (dash) {
      const afterDash = remaining.slice(dash[0].length).trimStart();
      const next = matchStatusAtStart(afterDash, caseSensitive);
      if (next) {
        remaining = afterDash;
        matched = next;
        continue;
      }
    }
    break;
  }

  const uniqueTerms = [...new Set(terms)];
  if (
    uniqueTerms.some(
      (term) => term.startsWith("NOT ") && uniqueTerms.includes(term.slice(4)),
    )
  ) {
    return null;
  }
  return {
    terms: uniqueTerms,
    display: uniqueTerms.join(" + "),
  };
}

function parsePortfolioClaims(line, lineNumber) {
  const heading = line.match(/^\s*\d+\.\s+\*\*(.+?):\*\*(?:\s|$)/u);
  if (!heading) {
    return [];
  }

  const separator = heading[1].match(/\s+—\s+/u);
  if (!separator) {
    return [];
  }
  const idsText = heading[1].slice(0, separator.index).trim();
  const claim = heading[1].slice(separator.index + separator[0].length).trim();
  const ids = idsText.split(/\s+\/\s+/u);
  if (ids.length === 0 || ids.some((rowId) => !ROW_ID_EXACT.test(rowId))) {
    return [];
  }

  return ids.map((rowId) => ({
    rowId: normalizeRowId(rowId),
    line: lineNumber,
    rawStatus: claim.length === 0 ? "<missing>" : cleanStatusText(claim),
    status: claim.length === 0 ? null : parseClosedStatus(claim),
  }));
}

function stateReferencePattern() {
  const tick = String.fromCharCode(96);
  const codedReference = String.raw`(?:${tick}${ROW_ID_SOURCE}${tick}|${tick}${ROW_ID_BASE_SOURCE}${tick}(?:\s+[A-Za-z]\d+)?)`;
  const joinedReferences = String.raw`${codedReference}(?:\s*\/\s*(?:${codedReference}|${ROW_ID_SOURCE}))*`;
  return new RegExp(
    String.raw`(?<refs>${joinedReferences})\s+(?:is|are|remains)\s+(?<claim>[^(),;:.]+)`,
    "giu",
  );
}

function stateDirectStatusPattern() {
  const tick = String.fromCharCode(96);
  const codedReference = String.raw`(?:${tick}${ROW_ID_SOURCE}${tick}|${tick}${ROW_ID_BASE_SOURCE}${tick}(?:\s+[A-Za-z]\d+)?)`;
  const joinedReferences = String.raw`${codedReference}(?:\s*\/\s*(?:${codedReference}|${ROW_ID_SOURCE}))*`;
  const vocabulary = [...STATUS_VOCABULARY]
    .sort((left, right) => right.length - left.length || bytewise(left, right))
    .map((status) => escapeRegex(status).replaceAll(" ", String.raw`\s+`))
    .join("|");
  return new RegExp(
    String.raw`(?<refs>${joinedReferences})\s+(?<claim>(?:\*\*)?(?:${vocabulary})[^(),;:.]*)`,
    "giu",
  );
}

function appendStateClaims(claims, match, lineNumber) {
  const flattened = match.groups.refs.replaceAll("`", "");
  const rowIds = [...flattened.matchAll(new RegExp(ROW_ID_SOURCE, "gi"))].map(
    (rowMatch) => normalizeRowId(rowMatch[0]),
  );
  const uniqueRowIds = [...new Set(rowIds)];
  for (const rowId of uniqueRowIds) {
    claims.push({
      rowId,
      line: lineNumber,
      rawStatus: cleanStatusText(match.groups.claim),
      status: parseClosedStatus(match.groups.claim),
    });
  }
}

function collectDirectStateClaims(activeLine, lineNumber) {
  const claims = [];
  for (const match of activeLine.matchAll(stateDirectStatusPattern())) {
    const prefix = activeLine.slice(0, match.index).trimEnd();
    if (/[—–-]$/u.test(prefix)) {
      continue;
    }
    appendStateClaims(claims, match, lineNumber);
  }
  return claims;
}

function stateIncompletePattern() {
  const tick = String.fromCharCode(96);
  const codedReference = String.raw`(?:${tick}${ROW_ID_SOURCE}${tick}|${tick}${ROW_ID_BASE_SOURCE}${tick}(?:\s+[A-Za-z]\d+)?)`;
  const joinedReferences = String.raw`${codedReference}(?:\s*\/\s*(?:${codedReference}|${ROW_ID_SOURCE}))*`;
  return new RegExp(
    String.raw`(?<refs>${joinedReferences})\s+(?:is|are|remains)\s*(?:[.,;:]\s*)?$`,
    "giu",
  );
}

function parseStateClaims(line, lineNumber) {
  if (!/^\s*-\s+/u.test(line)) {
    return [];
  }

  const activeLine = line.replace(/^\s*-\s+/u, "");
  const claims = [];
  for (const match of activeLine.matchAll(stateReferencePattern())) {
    appendStateClaims(claims, match, lineNumber);
  }
  claims.push(...collectDirectStateClaims(activeLine, lineNumber));
  for (const match of activeLine.matchAll(stateIncompletePattern())) {
    appendStateClaims(
      claims,
      { groups: { refs: match.groups.refs, claim: "<missing>" } },
      lineNumber,
    );
  }
  return claims;
}

function parseMirror(file, text) {
  const basename = path.posix.basename(file.doc).toUpperCase();
  let parser;
  let starter;
  if (basename === "CAMPAIGN_PORTFOLIO_QUEUE.MD") {
    parser = parsePortfolioClaims;
    starter = /^\s*\d+\.\s+/u;
  } else if (basename === "CAMPAIGN_STATE.MD") {
    parser = parseStateClaims;
    starter = /^\s*-\s+/u;
  } else {
    throw new Error(
      `mirror grammar is undefined for ${file.doc}; supported basenames are CAMPAIGN_PORTFOLIO_QUEUE.md and CAMPAIGN_STATE.md`,
    );
  }

  const claims = [];
  const blocks = collectLogicalListBlocks(sanitizeMarkdownLines(text), starter);
  blocks.forEach((block) => {
    for (const claim of parser(block.text, block.line)) {
      claims.push({ ...claim, mirrorDoc: file.doc });
    }
  });
  return claims;
}

function prepareQueueStatusText(raw) {
  const cleaned = cleanStatusText(raw);
  const prefixed = cleaned.match(/^W\d+(?:\s+TAIL)?\s+(?:—|–|-)\s+(.+)$/iu);
  if (prefixed) {
    return prefixed[1];
  }
  const titled = cleaned.match(/^`[^`]+`\s+(?:—|–|-)\s+(.+)$/u);
  return titled ? titled[1] : cleaned;
}

function extractQueueStatus(statusCell) {
  const sources = [];

  for (const match of statusCell.matchAll(/\*\*([^*]+)\*\*/gu)) {
    sources.push({ position: match.index, priority: 0, raw: match[1] });
  }
  sources.push({ position: 0, priority: 1, raw: statusCell });

  sources.sort(
    (left, right) =>
      left.position - right.position || left.priority - right.priority,
  );
  for (const source of sources) {
    const status = parseClosedStatus(prepareQueueStatusText(source.raw), {
      caseSensitive: true,
    });
    if (status) {
      return status;
    }
  }
  return null;
}

function tableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) {
    return null;
  }
  const body = trimmed.endsWith("|") ? trimmed.slice(1, -1) : trimmed.slice(1);
  return body.split(/(?<!\\)\|/u).map((cell) => cell.trim());
}

function isTableDelimiter(cells) {
  return (
    Array.isArray(cells) &&
    cells.length > 0 &&
    cells.every((cell) => /^:?-{3,}:?$/u.test(cell))
  );
}

function collectStatusTableRows(lines) {
  const rows = [];
  let statusColumn = null;
  let tableKnown = false;
  let explicitStatusSchema = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s{0,3}#{1,6}\s+/u.test(lines[index].text)) {
      statusColumn = null;
      tableKnown = false;
      explicitStatusSchema = false;
      continue;
    }
    const header = tableCells(lines[index].text);
    const delimiter =
      index + 1 < lines.length ? tableCells(lines[index + 1].text) : null;
    if (header && isTableDelimiter(delimiter)) {
      const statusColumns = header
        .map((cell, column) => ({ cell, column }))
        .filter(({ cell }) => /\b(?:status|state)\b/iu.test(cell));
      tableKnown = true;
      explicitStatusSchema = statusColumns.length > 0;
      statusColumn =
        statusColumns.length === 1 ? statusColumns[0].column : null;
      index += 1;
      continue;
    }

    const cells = tableCells(lines[index].text);
    if (!cells || !tableKnown || isTableDelimiter(cells)) {
      continue;
    }
    if (explicitStatusSchema) {
      rows.push({
        ...lines[index],
        cells,
        statusCell: statusColumn === null ? "" : (cells[statusColumn] ?? ""),
      });
      continue;
    }
    for (const statusCell of cells.slice(1).filter(extractQueueStatus)) {
      rows.push({ ...lines[index], cells, statusCell });
    }
  }
  return rows;
}

function splitSliceReference(rowId) {
  const match = rowId.match(
    new RegExp(`^(${ROW_ID_BASE_SOURCE})\\s+([A-Za-z]\\d+)$`, "iu"),
  );
  return match
    ? { base: normalizeRowId(match[1]), slice: match[2].toUpperCase() }
    : null;
}

function extractQueueSliceStatuses(line, requestedSlice) {
  const matches = [];
  for (const [sourceIndex, bold] of [
    ...line.matchAll(/\*\*([^*]+)\*\*/gu),
  ].entries()) {
    const source = cleanStatusText(bold[1]);
    const declaration = source.match(
      /^(?<slices>[A-Za-z]\d+(?:\s*\/\s*[A-Za-z]\d+)*)\s+(?<claim>.+)$/u,
    );
    if (!declaration) {
      continue;
    }
    const slices = declaration.groups.slices
      .split(/\s*\/\s*/u)
      .map((slice) => slice.toUpperCase());
    if (!slices.includes(requestedSlice)) {
      continue;
    }
    const tick = String.fromCharCode(96);
    const owner = declaration.groups.claim.match(
      new RegExp(
        String.raw`\b(?:its\s+)?canonical\s+owner\s+${tick}?(${ROW_ID_BASE_SOURCE})${tick}?`,
        "iu",
      ),
    );
    matches.push({
      sourceIndex,
      status: parseClosedStatus(declaration.groups.claim, {
        caseSensitive: true,
      }),
      owner: owner ? normalizeRowId(owner[1]) : null,
    });
  }
  return matches;
}

function readQueue(queue) {
  let text;
  try {
    text = readFileSync(queue.absolute, "utf8");
  } catch (error) {
    throw new Error(
      `queue document is missing or unreadable: ${queue.doc} (${error.message})`,
      { cause: error },
    );
  }
  const lines = sanitizeMarkdownLines(text);
  return { ...queue, lines, statusRows: collectStatusTableRows(lines) };
}

function statusKey(status) {
  return [...status.terms].sort(bytewise).join("\u0000");
}

/**
 * Terms whose presence in the authority changes the disposition of a row.
 * A mirror that omits one of these is not summarizing, it is contradicting:
 * the drift this verifier exists to catch is a mirror calling work finished
 * while its queue still holds the row open.
 */
export const OPEN_STATE_TERMS = Object.freeze([
  "NOT STARTED",
  "NOT COMPLETE",
  "IN PROGRESS",
  "PARTIAL",
  "OPEN",
  "REOPENED",
  "VACATED",
  "BLOCKED",
  "DEFERRED",
  "WITHDRAWN",
  "PENDING",
  "HELD",
]);

const OPEN_STATE_SET = new Set(OPEN_STATE_TERMS);

/**
 * Subset-compatible comparison. A mirror legitimately summarizes, so it may
 * state fewer terms than its authority. It may never state a term the
 * authority does not state, and it may never drop an open-state term.
 */
function statusesAgree(mirrorTerms, queueTerms) {
  const queue = new Set(queueTerms);
  for (const term of mirrorTerms) {
    if (!queue.has(term)) {
      return false;
    }
  }
  const mirror = new Set(mirrorTerms);
  for (const term of queueTerms) {
    if (OPEN_STATE_SET.has(term) && !mirror.has(term)) {
      return false;
    }
  }
  return true;
}

function resolveQueueRow(rowId, queues) {
  const candidates = [];
  const sliceReference = splitSliceReference(rowId);
  for (const queue of queues) {
    for (const row of queue.statusRows) {
      const canonical = row.cells[0]?.match(/^`([^`]+)`(?:\s|$)/u);
      if (!canonical) {
        continue;
      }
      const candidateRowId = normalizeRowId(canonical[1]);
      if (candidateRowId === rowId) {
        const status = extractQueueStatus(row.statusCell);
        candidates.push({
          doc: queue.doc,
          line: row.line,
          status: status?.display ?? "<unresolved>",
          statusTerms: status?.terms ?? null,
          key: status ? statusKey(status) : null,
        });
      }
      if (sliceReference && candidateRowId === sliceReference.base) {
        for (const slice of extractQueueSliceStatuses(
          row.text,
          sliceReference.slice,
        )) {
          candidates.push({
            doc: queue.doc,
            line: row.line,
            status: slice.status?.display ?? "<unresolved>",
            statusTerms: slice.status?.terms ?? null,
            owner: slice.owner,
            key: slice.status ? statusKey(slice.status) : null,
          });
        }
      }
    }

    if (sliceReference) {
      for (const line of queue.lines) {
        const bullet = line.text.match(/^\s*-\s+`([^`]+)`(?:\s|$)/u);
        if (!bullet || normalizeRowId(bullet[1]) !== sliceReference.base) {
          continue;
        }
        for (const slice of extractQueueSliceStatuses(
          line.text,
          sliceReference.slice,
        )) {
          candidates.push({
            doc: queue.doc,
            line: line.line,
            status: slice.status?.display ?? "<unresolved>",
            statusTerms: slice.status?.terms ?? null,
            owner: slice.owner,
            key: slice.status ? statusKey(slice.status) : null,
          });
        }
      }
    }
  }

  candidates.sort(
    (left, right) => bytewise(left.doc, right.doc) || left.line - right.line,
  );
  if (candidates.length === 0) {
    return {
      kind: "row-missing",
      queue: {
        doc: queues[0].doc,
        line: null,
        status: "<unresolved>",
        statusTerms: null,
      },
      candidates,
    };
  }

  const resolvedCandidates = candidates.filter(
    (candidate) => candidate.key !== null,
  );
  const keys = new Set(resolvedCandidates.map((candidate) => candidate.key));
  const everyCandidateResolved =
    resolvedCandidates.length === candidates.length;
  if (!everyCandidateResolved || keys.size !== 1) {
    const distinctStatuses = [
      ...new Set(candidates.map((candidate) => candidate.status)),
    ];
    return {
      kind: "status-unresolvable",
      queue: {
        doc: resolvedCandidates[0]?.doc ?? candidates[0].doc,
        line: resolvedCandidates[0]?.line ?? candidates[0].line,
        status: distinctStatuses.join(" <> "),
        statusTerms: null,
      },
      candidates,
    };
  }

  return {
    kind: "resolved",
    queue: {
      doc: resolvedCandidates[0].doc,
      line: resolvedCandidates[0].line,
      status: resolvedCandidates[0].status,
      statusTerms: resolvedCandidates[0].statusTerms,
    },
    candidates,
  };
}

function campaignNumber(rowId) {
  const match = rowId.match(/^C(\d+)-/u);
  return match ? Number.parseInt(match[1], 10) : null;
}

function makeFinding(verdict, claim, resolution) {
  return {
    verdict,
    rowId: claim.rowId,
    mirror: {
      doc: claim.mirrorDoc,
      line: claim.line,
      status: claim.status?.display ?? claim.rawStatus,
      statusTerms: claim.status?.terms ?? null,
    },
    queue: resolution.queue,
    queueCandidates: resolution.candidates.map(
      ({ key, ...candidate }) => candidate,
    ),
  };
}

function recordDisagreement(findings, finding) {
  findings.push(finding);
}

function recordUnresolvableRow(findings, finding) {
  findings.push(finding);
}

function recordUnresolvableStatus(findings, finding) {
  findings.push(finding);
}

function findingOrder(left, right) {
  return (
    bytewise(left.mirror.doc, right.mirror.doc) ||
    left.mirror.line - right.mirror.line ||
    bytewise(left.rowId, right.rowId)
  );
}

function applyAllowlist(findings, allowlist) {
  const byKey = new Map(
    allowlist.entries.map((entry) => [
      `${entry.rowId}\u0000${entry.mirror}`,
      entry,
    ]),
  );
  const active = [];
  const allowlisted = [];
  for (const finding of findings) {
    const entry = byKey.get(`${finding.rowId}\u0000${finding.mirror.doc}`);
    if (entry) {
      allowlisted.push({ ...finding, allowlistReason: entry.reason });
    } else {
      active.push(finding);
    }
  }
  active.sort(findingOrder);
  allowlisted.sort(findingOrder);
  return { active, allowlisted };
}

function formatLocation(record) {
  return `${record.doc}:${record.line ?? "<no-row>"}`;
}

function formatCandidateList(candidates) {
  return candidates
    .map(
      (candidate) =>
        `${candidate.doc}:${candidate.line}=${JSON.stringify(candidate.status)}`,
    )
    .join("; ");
}

function formatFinding(finding, prefix = finding.verdict) {
  let line = `${prefix} | row=${finding.rowId} | mirror=${formatLocation(
    finding.mirror,
  )} | mirror-status=${JSON.stringify(
    finding.mirror.status,
  )} | queue=${formatLocation(finding.queue)} | queue-status=${JSON.stringify(
    finding.queue.status,
  )}`;
  if (finding.queueCandidates.length > 1) {
    line += ` | queue-candidates=${JSON.stringify(
      formatCandidateList(finding.queueCandidates),
    )}`;
  }
  return line;
}

function emitHuman(report) {
  console.log(`orientation-mirror: ${report.verdict.toUpperCase()}`);
  for (const finding of report.findings) {
    console.log(formatFinding(finding));
  }
  for (const finding of report.allowlistedFindings) {
    console.log(
      `${formatFinding(
        finding,
        `allowlisted(${finding.verdict})`,
      )} | reason=${JSON.stringify(finding.allowlistReason)}`,
    );
  }
  console.log(
    `summary | agreements=${report.summary.agreements} | disagreements=${report.summary.disagreements} | unresolvable-row=${report.summary["unresolvable-row"]} | unresolvable-status=${report.summary["unresolvable-status"]} | allowlisted=${report.summary.allowlisted}`,
  );
}

function emitError(message, json) {
  const report = {
    tool: "verify-orientation-mirror",
    verdict: "error",
    exitCode: 2,
    allowlistHitCount: 0,
    errors: [message],
  };
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.error("orientation-mirror: ERROR");
    console.error(message);
  }
}

function verify(options) {
  const repo = assertRepository(options.repo);
  const allowlist = parseAllowlist(repo, options.allowlist);
  const mirrorFiles = options.mirrors.map((mirror) =>
    resolveRepoFile(repo, mirror, "mirror document"),
  );
  const seenMirrors = new Set();
  for (const mirror of mirrorFiles) {
    if (seenMirrors.has(mirror.doc)) {
      throw new Error(
        `mirror document was named more than once: ${mirror.doc}`,
      );
    }
    seenMirrors.add(mirror.doc);
  }

  const claims = mirrorFiles.flatMap((mirror) =>
    parseMirror(mirror, readRequiredText(mirror, "mirror document")),
  );
  const discoveredQueues = discoverQueues(repo);
  const queuesByCampaign = new Map();
  for (const queue of discoveredQueues) {
    const list = queuesByCampaign.get(queue.campaign) ?? [];
    list.push(queue);
    queuesByCampaign.set(queue.campaign, list);
  }

  const loadedCampaigns = new Map();
  const findings = [];
  let agreements = 0;
  for (const claim of claims) {
    const campaign = campaignNumber(claim.rowId);
    const authorityFiles = queuesByCampaign.get(campaign);
    if (!authorityFiles || authorityFiles.length === 0) {
      throw new Error(
        `queue document is missing for campaign ${campaign} referenced by ${claim.rowId}`,
      );
    }
    if (!loadedCampaigns.has(campaign)) {
      loadedCampaigns.set(campaign, authorityFiles.map(readQueue));
    }

    const resolution = resolveQueueRow(
      claim.rowId,
      loadedCampaigns.get(campaign),
    );
    if (resolution.kind === "row-missing") {
      recordUnresolvableRow(
        findings,
        makeFinding("unresolvable-row", claim, resolution),
      );
      continue;
    }
    if (!claim.status || resolution.kind === "status-unresolvable") {
      recordUnresolvableStatus(
        findings,
        makeFinding("unresolvable-status", claim, resolution),
      );
      continue;
    }
    if (!statusesAgree(claim.status.terms, resolution.queue.statusTerms)) {
      recordDisagreement(findings, makeFinding("disagree", claim, resolution));
      continue;
    }
    agreements += 1;
  }

  const { active, allowlisted } = applyAllowlist(findings, allowlist);
  const summary = {
    agreements,
    disagreements: active.filter((item) => item.verdict === "disagree").length,
    "unresolvable-row": active.filter(
      (item) => item.verdict === "unresolvable-row",
    ).length,
    "unresolvable-status": active.filter(
      (item) => item.verdict === "unresolvable-status",
    ).length,
    allowlisted: allowlisted.length,
  };
  const exitCode = active.length === 0 ? 0 : 1;
  return {
    tool: "verify-orientation-mirror",
    verdict: exitCode === 0 ? "pass" : "fail",
    exitCode,
    repo,
    mirrors: mirrorFiles.map((mirror) => mirror.doc),
    queueDocuments: discoveredQueues.map((queue) => queue.doc),
    allowlist: allowlist.file,
    allowlistHitCount: allowlisted.length,
    findings: active,
    allowlistedFindings: allowlisted,
    summary,
  };
}

function run(argv) {
  const wantsJson = argv.includes("--json");
  try {
    const options = parseArguments(argv);
    if (options.help) {
      console.log(HELP_TEXT);
      return 0;
    }
    const report = verify(options);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      emitHuman(report);
    }
    return report.exitCode;
  } catch (error) {
    emitError(error.message, wantsJson);
    return 2;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  process.exitCode = run(process.argv.slice(2));
}
