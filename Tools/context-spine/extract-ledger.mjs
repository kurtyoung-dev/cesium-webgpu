// extract-ledger.mjs — Precedence-aware compiler for rulings, queues, campaign state, blueprint, and ledgers.
// @purpose Compile migration_doc rulings, campaign queues, CAMPAIGN_STATE, blueprint epics/hotspots, and DEFERRED_WORK into Charter-ranked SQLite FTS5 rows.
// @status ACTIVE

import fs from "node:fs";
import path from "node:path";
import { AUTHORITY_RANK, toPosixRel } from "./schema.mjs";

export const ACTIVE_LEDGER_STATUSES = new Set([
  "ACTIVE",
  "OPEN",
  "PARTIAL",
  "BLOCKED",
  "HELD",
]);

/**
 * Extract highest `Batch NNNN` number mentioned in a text block.
 * Per DEFERRED_WORK.md convention 2, batch numbers outrank printed dates.
 *
 * @param {string} text
 * @returns {number | null}
 */
function extractMaxBatchNumber(text) {
  let maxBatch = null;
  for (const m of text.matchAll(/\bBatch\s+(\d{1,5})\b/gi)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && (maxBatch === null || n > maxBatch)) {
      maxBatch = n;
    }
  }
  return maxBatch;
}

/**
 * Extract cited repository paths and source basenames from a markdown block.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractCitedPaths(text) {
  const found = new Set();
  for (const m of text.matchAll(
    /\b((?:packages\/(?:engine|widgets)\/Source|Tools|Apps)\/[A-Za-z0-9_./-]+\.(?:ts|js|mjs|wgsl|glsl|json|md))\b/g,
  )) {
    found.add(m[1]);
  }
  for (const m of text.matchAll(
    /`([A-Za-z0-9_-]+\.(?:ts|js|mjs|wgsl|glsl))(?::\d+(?:-\d+)?)?`/g,
  )) {
    found.add(m[1]);
  }
  return [...found].slice(0, 25);
}

/**
 * Condense markdown prose into a compact single-paragraph summary.
 *
 * @param {string} raw
 * @param {number} [maxChars]
 * @returns {string}
 */
function compactSummary(raw, maxChars = 420) {
  const cleaned = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Parse `MAINTAINER_RULINGS_*.md` files and resolve `amends` / `supersedes` / `vacates`.
 *
 * @param {string} repoRoot
 * @param {string[]} absFiles
 * @returns {object[]}
 */
function parseMaintainerRulings(repoRoot, absFiles) {
  const sorted = [...absFiles].sort((a, b) =>
    path.basename(a).localeCompare(path.basename(b)),
  );
  const entries = [];
  const byRulingId = new Map();

  for (const absPath of sorted) {
    const relPath = toPosixRel(repoRoot, absPath);
    const lines = fs.readFileSync(absPath, "utf8").split(/\r?\n/);

    const starts = [];
    for (let i = 0; i < lines.length; i += 1) {
      const hm = lines[i].match(
        /^#{2,4}\s+`?(R-\d{4}-\d{2}-\d{2}-[A-Za-z0-9-]+)`?(?:\s*[—–:-]\s*(.*))?$/,
      );
      if (hm) {
        starts.push({
          id: hm[1],
          titleSuffix: (hm[2] ?? "").trim(),
          startIdx: i,
        });
      }
    }

    for (let s = 0; s < starts.length; s += 1) {
      const cur = starts[s];
      const endIdx =
        s + 1 < starts.length ? starts[s + 1].startIdx - 1 : lines.length - 1;
      const bodyLines = lines.slice(cur.startIdx + 1, endIdx + 1);
      const bodyText = bodyLines.join("\n");

      const amendsSet = new Set();
      for (const am of bodyText.matchAll(
        /(?:amend(?:s|ed)?|supersed(?:es|ed)|vacat(?:es|ed)|replac(?:es|ed)|overrid(?:es|den))[^.\n]{0,90}?\b(R-\d{4}-\d{2}-\d{2}-[A-Za-z0-9-]+)/gi,
      )) {
        if (am[1] !== cur.id) amendsSet.add(am[1]);
      }

      let status = "ACTIVE";
      if (/\b(?:VACATED|WITHDRAWN)\b/.test(cur.titleSuffix)) {
        status = "VACATED";
      }

      const firstPara =
        bodyLines
          .map((l) => l.trim())
          .find(
            (l) =>
              l.length > 0 &&
              !l.startsWith("#") &&
              !l.startsWith("Authority:") &&
              !l.startsWith("---"),
          ) ?? cur.titleSuffix;

      const entry = {
        id: cur.id,
        sourceFile: relPath,
        startLine: cur.startIdx + 1,
        endLine: endIdx + 1,
        authorityRank: AUTHORITY_RANK.MAINTAINER_RULING,
        docKind: "ruling",
        status,
        batchNum: extractMaxBatchNumber(bodyText),
        title: cur.titleSuffix ? `${cur.id} — ${cur.titleSuffix}` : cur.id,
        summary: compactSummary(firstPara, 420),
        amendsIds: [...amendsSet],
        citedPaths: extractCitedPaths(bodyText),
        rawLower: bodyText.toLowerCase(),
      };

      // If a later file re-declares the same ID, keep the newer file's copy.
      byRulingId.set(entry.id, entry);
      entries.push(entry);
    }
  }

  // Apply forward amendment / supersession links from newer rulings onto older rulings.
  for (const entry of entries) {
    if (entry.amendsIds.length === 0) continue;
    const isVacate = /\bvacat(?:es|ed)\b/i.test(entry.rawLower);
    for (const targetId of entry.amendsIds) {
      const target = byRulingId.get(targetId);
      if (target && target !== entry) {
        target.status = isVacate ? "VACATED" : "AMENDED";
        const tag = `[${isVacate ? "Vacated" : "Amended"} by ${entry.id}] `;
        if (!target.summary.startsWith("[")) {
          target.summary = compactSummary(`${tag}${target.summary}`, 420);
        }
      }
    }
  }

  return [...byRulingId.values()];
}

/**
 * Determine normalized row status from a queue status cell or section body.
 *
 * @param {string} rawStatus
 * @returns {string}
 */
function classifyQueueStatus(rawStatus) {
  const upper = rawStatus.toUpperCase();
  if (
    /\b(?:CLOSURE VACATED|REOPENED)\b/.test(upper) ||
    (/\bVACATED\b/.test(upper) && /\bOPEN\b/.test(upper))
  ) {
    return "OPEN";
  }
  if (/\bPARTIAL\b/.test(upper)) return "PARTIAL";
  if (/\bBLOCKED\b/.test(upper)) return "BLOCKED";
  if (/\bHELD\b|\bON HOLD\b/.test(upper)) return "HELD";
  if (
    /^(?:[\s*_✅]*)(?:DONE|LANDED|COMPLETE|COMPLETED|CLOSED|SHIPPED|CERTIFIED|RESOLVED)\b/.test(
      upper,
    ) &&
    !/\bSTILL NOT COMPLETE\b/.test(upper)
  ) {
    return "CLOSED";
  }
  if (/\bSUPERSEDED\b|\bWITHDRAWN\b/.test(upper) && !/\bOPEN\b/.test(upper)) {
    return "SUPERSEDED";
  }
  return "OPEN";
}

/**
 * Parse `QUEUE_*.md` and `CAMPAIGN_PORTFOLIO_QUEUE.md` rows and headings.
 *
 * @param {string} repoRoot
 * @param {string[]} absFiles
 * @returns {object[]}
 */
function parseQueueFiles(repoRoot, absFiles) {
  const byId = new Map();
  const rowIdRe = /^`?((?:C\d{1,2}|DX|AR|W\d+|SOL|EPIC)-[A-Za-z0-9._-]+)`?$/;

  for (const absPath of absFiles) {
    const relPath = toPosixRel(repoRoot, absPath);
    const lines = fs.readFileSync(absPath, "utf8").split(/\r?\n/);

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];

      // Markdown table row: | `C16-00` | Work | Size | Status |
      if (line.trimStart().startsWith("|")) {
        const cells = line
          .replace(/\\\|/g, "__ESCAPED_PIPE__")
          .split("|")
          .slice(1, -1)
          .map((c) => c.replaceAll("__ESCAPED_PIPE__", "|").trim());
        if (cells.length >= 2) {
          const idMatch = cells[0].match(rowIdRe);
          if (idMatch) {
            const rawId = idMatch[1];
            const workText = cells[1] ?? "";
            const statusText = cells[cells.length - 1] ?? "";
            const status = classifyQueueStatus(statusText);
            const key = `queue:${rawId}`;
            byId.set(key, {
              id: key,
              sourceFile: relPath,
              startLine: i + 1,
              endLine: i + 1,
              authorityRank: AUTHORITY_RANK.CAMPAIGN_QUEUE,
              docKind: "queue-row",
              status,
              batchNum: extractMaxBatchNumber(line),
              title: `${rawId} — ${compactSummary(workText, 110)}`,
              summary: compactSummary(`${statusText} || ${workText}`, 420),
              amendsIds: [],
              citedPaths: extractCitedPaths(line),
            });
          }
        }
        continue;
      }

      // Section heading row: ### C13-41 — ... or ## AR-D1 ...
      const hm = line.match(
        /^#{2,4}\s+`?((?:C\d{1,2}|DX|AR|W\d+|SOL)-[A-Za-z0-9._-]+)`?(?:\s*[—–:-]\s*(.*))?$/,
      );
      if (hm) {
        const rawId = hm[1];
        const key = `queue:${rawId}`;
        if (byId.has(key)) continue;
        let endIdx = Math.min(lines.length - 1, i + 40);
        for (let k = i + 1; k < lines.length; k += 1) {
          if (/^#{1,3}\s+/.test(lines[k])) {
            endIdx = k - 1;
            break;
          }
        }
        const block = lines.slice(i + 1, endIdx + 1).join("\n");
        byId.set(key, {
          id: key,
          sourceFile: relPath,
          startLine: i + 1,
          endLine: endIdx + 1,
          authorityRank: AUTHORITY_RANK.CAMPAIGN_QUEUE,
          docKind: "queue-row",
          status: classifyQueueStatus(block.slice(0, 500)),
          batchNum: extractMaxBatchNumber(block),
          title: hm[2] ? `${rawId} — ${hm[2].trim()}` : rawId,
          summary: compactSummary(block, 420),
          amendsIds: [],
          citedPaths: extractCitedPaths(block),
        });
      }
    }
  }

  return [...byId.values()];
}

/**
 * Parse `CAMPAIGN_STATE.md` campaign blocks, prioritizing latest dated status addenda.
 *
 * @param {string} repoRoot
 * @param {string} absPath
 * @returns {object[]}
 */
function parseCampaignState(repoRoot, absPath) {
  if (!fs.existsSync(absPath)) return [];
  const relPath = toPosixRel(repoRoot, absPath);
  const lines = fs.readFileSync(absPath, "utf8").split(/\r?\n/);
  const starts = [];

  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^###\s+(C\d{2}[A-Za-z0-9-]*)\s*[—–-]\s*(.+)$/);
    if (m) {
      starts.push({ id: m[1], title: m[2].trim(), startIdx: i });
    }
  }

  const out = [];
  for (let s = 0; s < starts.length; s += 1) {
    const cur = starts[s];
    let endIdx =
      s + 1 < starts.length ? starts[s + 1].startIdx - 1 : lines.length - 1;
    for (let k = cur.startIdx + 1; k <= endIdx; k += 1) {
      if (/^##\s+/.test(lines[k])) {
        endIdx = k - 1;
        break;
      }
    }
    const block = lines.slice(cur.startIdx + 1, endIdx + 1).join("\n");

    // Extract latest `Status added YYYY-MM-DD` addendum if present so stale top paragraphs don't win.
    const addenda = [
      ...block.matchAll(
        /\*\[(?:\*\*)?Status added\s+(\d{4}-\d{2}-\d{2})[\s\S]*?\]\*/g,
      ),
    ];
    const preferredSummary =
      addenda.length > 0 ? addenda[addenda.length - 1][0] : block;

    let status = "ACTIVE";
    if (/\bHELD\b|\bunlaunched\b/i.test(block.slice(0, 260))) {
      status = "HELD";
    } else if (
      /\bCLOSED\b/i.test(preferredSummary.slice(0, 180)) &&
      !/\bnot closed\b|\bis OPEN\b/i.test(preferredSummary)
    ) {
      status = "CLOSED";
    }

    out.push({
      id: `campaign:${cur.id}`,
      sourceFile: relPath,
      startLine: cur.startIdx + 1,
      endLine: endIdx + 1,
      authorityRank: AUTHORITY_RANK.CAMPAIGN_STATE,
      docKind: "campaign-state",
      status,
      batchNum: extractMaxBatchNumber(block),
      title: `${cur.id} — ${cur.title}`,
      summary: compactSummary(preferredSummary, 420),
      amendsIds: [],
      citedPaths: extractCitedPaths(block),
    });
  }
  return out;
}

/**
 * Parse `CONSOLIDATED_REMEDIATION_BLUEPRINT_*.md` epics and 20 hotspot rows.
 *
 * @param {string} repoRoot
 * @param {string[]} absFiles
 * @returns {object[]}
 */
function parseBlueprints(repoRoot, absFiles) {
  const out = [];
  for (const absPath of absFiles) {
    const relPath = toPosixRel(repoRoot, absPath);
    const lines = fs.readFileSync(absPath, "utf8").split(/\r?\n/);

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];

      // Hotspot table row: | `ModelPBRComplete.wgsl` | **82** | EPIC-06, EPIC-03 | Summary |
      const hotspotMatch = line.match(
        /^\|\s*`([^`]+\.(?:ts|js|wgsl|glsl|mjs))`\s*\|\s*\*?\*?(\d+)\*?\*?\s*\|\s*([^|]+)\|\s*([^|]+)\|/,
      );
      if (hotspotMatch) {
        const [, fileBase, countStr, epics, vulnSummary] = hotspotMatch;
        out.push({
          id: `hotspot:${fileBase}`,
          sourceFile: relPath,
          startLine: i + 1,
          endLine: i + 1,
          authorityRank: AUTHORITY_RANK.BLUEPRINT,
          docKind: "blueprint-hotspot",
          status: "ACTIVE",
          batchNum: null,
          title: `Hotspot ${fileBase} (${countStr} findings — ${epics.trim()})`,
          summary: compactSummary(
            `${fileBase}: ${countStr} audit findings across ${epics.trim()}. ${vulnSummary.trim()}`,
            420,
          ),
          amendsIds: [],
          citedPaths: [fileBase],
        });
        continue;
      }

      // Epic heading: ## EPIC-01: ... or ### EPIC-01: ...
      const epicMatch = line.match(
        /^#{2,4}\s+.*?\b(EPIC-\d{2})\s*:\s*([^(\n]+)(?:\(([^)]+)\))?/,
      );
      if (epicMatch) {
        const [, epicId, epicTitle] = epicMatch;
        let endIdx = Math.min(lines.length - 1, i + 80);
        for (let k = i + 1; k < lines.length; k += 1) {
          if (/^#{2,3}\s+/.test(lines[k])) {
            endIdx = k - 1;
            break;
          }
        }
        const block = lines.slice(i + 1, endIdx + 1).join("\n");
        out.push({
          id: `blueprint:${epicId}`,
          sourceFile: relPath,
          startLine: i + 1,
          endLine: endIdx + 1,
          authorityRank: AUTHORITY_RANK.BLUEPRINT,
          docKind: "blueprint-epic",
          status: "ACTIVE",
          batchNum: extractMaxBatchNumber(block),
          title: `${epicId} — ${epicTitle.trim()}`,
          summary: compactSummary(block, 420),
          amendsIds: [],
          citedPaths: extractCitedPaths(block),
        });
      }
    }
  }
  return out;
}

/**
 * Parse `DEFERRED_WORK.md` and `FEATURE_INVENTORY.md` section entries.
 *
 * @param {string} repoRoot
 * @param {string} absPath
 * @param {string} docKind
 * @returns {object[]}
 */
function parseInventorySections(repoRoot, absPath, docKind) {
  if (!fs.existsSync(absPath)) return [];
  const relPath = toPosixRel(repoRoot, absPath);
  const lines = fs.readFileSync(absPath, "utf8").split(/\r?\n/);
  const headings = [];

  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^#{2,3}\s+(.+)$/);
    if (m) {
      headings.push({ rawTitle: m[1].trim(), startIdx: i });
    }
  }

  const out = [];
  const seenIds = new Set();

  for (let h = 0; h < headings.length; h += 1) {
    const cur = headings[h];
    if (/^HOW TO READ THIS FILE/i.test(cur.rawTitle)) continue;

    const endIdx =
      h + 1 < headings.length ? headings[h + 1].startIdx - 1 : lines.length - 1;
    const sliceEnd = Math.min(endIdx, cur.startIdx + 90);
    const block = lines.slice(cur.startIdx + 1, sliceEnd + 1).join("\n");

    const idTokenMatch = cur.rawTitle.match(
      /\b((?:NEW|C-R|BUG|FAR|PERF|DX|UP\d*)-[A-Za-z0-9_-]+|C\d{1,2}-\d+[A-Za-z0-9-]*)/,
    );
    const slug = idTokenMatch
      ? idTokenMatch[1]
      : `${docKind}-L${cur.startIdx + 1}`;
    const id = seenIds.has(`${docKind}:${slug}`)
      ? `${docKind}:${slug}@L${cur.startIdx + 1}`
      : `${docKind}:${slug}`;
    seenIds.add(id);

    let status = "ACTIVE";
    const statusLine = block.slice(0, 450);
    if (
      /\*\*Status:\*\*\s*(?:✅\s*)?(?:SHIPPED|DONE|CLOSED|RESOLVED|LANDED|FIXED|COMPLETE)\b/i.test(
        statusLine,
      ) &&
      !/\b(?:PARTIAL|REOPENED)\b/i.test(statusLine)
    ) {
      status = "CLOSED";
    } else if (/\b(?:CLOSED|RESOLVED|SHIPPED|FIXED)\b/.test(cur.rawTitle)) {
      status = "CLOSED";
    } else if (/\bPARTIAL\b/i.test(statusLine)) {
      status = "PARTIAL";
    }

    out.push({
      id,
      sourceFile: relPath,
      startLine: cur.startIdx + 1,
      endLine: endIdx + 1,
      authorityRank: AUTHORITY_RANK.LEDGER_INVENTORY,
      docKind,
      status,
      batchNum: extractMaxBatchNumber(block),
      title: cur.rawTitle.slice(0, 180),
      summary: compactSummary(block || cur.rawTitle, 420),
      amendsIds: [],
      citedPaths: extractCitedPaths(`${cur.rawTitle}\n${block}`),
    });
  }

  return out;
}

/**
 * Compile live governance/rulings/queue/ledger entries into `ledger_entries` + `ledger_fts`.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} repoRoot
 * @param {{ docsDir?: string }} [options]
 */
export function indexLedger(db, repoRoot, options = {}) {
  const docsRoot = path.resolve(repoRoot, options.docsDir ?? "migration_doc");
  if (!fs.existsSync(docsRoot)) {
    return { entryCount: 0, activeCount: 0, rulingCount: 0 };
  }

  const topEntries = fs.readdirSync(docsRoot, { withFileTypes: true });
  const mdFiles = topEntries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => path.join(docsRoot, e.name))
    .sort();

  const rulingFiles = mdFiles.filter((f) =>
    /^MAINTAINER_RULINGS_.*\.md$/i.test(path.basename(f)),
  );
  const queueFiles = mdFiles.filter((f) =>
    /^(?:QUEUE_.*|CAMPAIGN_PORTFOLIO_QUEUE)\.md$/i.test(path.basename(f)),
  );
  const blueprintFiles = mdFiles.filter((f) =>
    /^CONSOLIDATED_REMEDIATION_BLUEPRINT.*\.md$/i.test(path.basename(f)),
  );

  const compiled = [
    ...parseMaintainerRulings(repoRoot, rulingFiles),
    ...parseQueueFiles(repoRoot, queueFiles),
    ...parseCampaignState(repoRoot, path.join(docsRoot, "CAMPAIGN_STATE.md")),
    ...parseBlueprints(repoRoot, blueprintFiles),
    ...parseInventorySections(
      repoRoot,
      path.join(docsRoot, "DEFERRED_WORK.md"),
      "deferred-work",
    ),
    ...parseInventorySections(
      repoRoot,
      path.join(docsRoot, "FEATURE_INVENTORY.md"),
      "feature-inventory",
    ),
  ];

  const insertEntry = db.prepare(`
    INSERT OR REPLACE INTO ledger_entries(
      id, source_file, start_line, end_line, authority_rank, doc_kind,
      status, batch_num, title, summary, amends_ids, cited_paths
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO ledger_fts(id, title, summary, cited_paths, doc_kind, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let activeCount = 0;
  let rulingCount = 0;

  db.exec("BEGIN;");
  try {
    db.exec("DELETE FROM ledger_entries;");
    db.exec("DELETE FROM ledger_fts;");

    for (const row of compiled) {
      if (ACTIVE_LEDGER_STATUSES.has(row.status)) activeCount += 1;
      if (row.docKind === "ruling") rulingCount += 1;
      const amendsStr =
        row.amendsIds && row.amendsIds.length > 0
          ? row.amendsIds.join(",")
          : null;
      const citedStr =
        row.citedPaths && row.citedPaths.length > 0
          ? row.citedPaths.join(" ")
          : "";

      insertEntry.run(
        row.id,
        row.sourceFile,
        row.startLine,
        row.endLine,
        row.authorityRank,
        row.docKind,
        row.status,
        row.batchNum ?? null,
        row.title,
        row.summary,
        amendsStr,
        citedStr || null,
      );
      insertFts.run(
        row.id,
        row.title,
        row.summary,
        citedStr,
        row.docKind,
        row.status,
      );
    }
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }

  return {
    entryCount: compiled.length,
    activeCount,
    rulingCount,
  };
}
