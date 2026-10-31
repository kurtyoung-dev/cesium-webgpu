// schema.mjs — SQLite schema and live disk-freshness guard for the context spine.
// @purpose SQLite schema, connection factory, and live SHA-256 disk-freshness helpers for the zero-dependency context, seam, ledger, and spatial validation spine.
// @status ACTIVE

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = "1";

export const DEFAULT_DB_REL_PATH = ".cache/context-spine/cesium-context.sqlite";

/**
 * Authority ranks matching EXECUTOR_LANE_CHARTER §0.4 precedence (lowest number wins).
 */
export const AUTHORITY_RANK = Object.freeze({
  MAINTAINER_RULING: 1,
  CAMPAIGN_QUEUE: 2,
  CAMPAIGN_STATE: 3,
  BLUEPRINT: 4,
  LEDGER_INVENTORY: 5,
  DESIGN_DOC: 6,
});

/**
 * Resolve the SQLite database path against a repository root.
 *
 * @param {string} repoRoot
 * @param {string} [dbPath]
 * @returns {string}
 */
export function resolveDbPath(repoRoot, dbPath) {
  if (dbPath) {
    return path.isAbsolute(dbPath) ? dbPath : path.resolve(repoRoot, dbPath);
  }
  return path.resolve(repoRoot, DEFAULT_DB_REL_PATH);
}

/**
 * Open and initialize a SQLite context-spine database.
 *
 * @param {string} dbFilePath
 * @param {{ readOnly?: boolean, reset?: boolean,
 *   removeFile?: (file: string) => void }} [options] `removeFile` replaces the
 *   reset's file removal (specs; default `fs.rmSync` with `force`).
 * @returns {DatabaseSync}
 */
export function openContextDatabase(dbFilePath, options = {}) {
  const {
    readOnly = false,
    reset = false,
    removeFile = (file) => fs.rmSync(file, { force: true }),
  } = options;
  if (dbFilePath !== ":memory:") {
    if (reset && !readOnly) {
      for (const suffix of ["", "-wal", "-shm"]) {
        const candidate = `${dbFilePath}${suffix}`;
        if (fs.existsSync(candidate)) {
          try {
            removeFile(candidate);
          } catch (err) {
            const code = /** @type {{ code?: string }} */ (err)?.code;
            if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
              // The main file is removed first, so a refusal here (another
              // process holds it open, as the cesium-context-spine MCP server
              // does on Windows) happens before anything has been deleted.
              throw Object.assign(
                new Error(
                  `${dbFilePath}: the cesium-context-spine MCP server holds the database; use the incremental build or close the session's MCP server`,
                  { cause: err },
                ),
                { code },
              );
            }
            throw err;
          }
        }
      }
    }
    if (!readOnly) {
      fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });
    }
  }

  const db = new DatabaseSync(dbFilePath, { readOnly });
  if (!readOnly) {
    try {
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA synchronous = NORMAL;");
      db.exec("PRAGMA foreign_keys = ON;");
      ensureSchema(db);
    } catch (err) {
      try {
        db.close();
      } catch {}
      throw err;
    }
  }
  return db;
}

/**
 * Checkpoint WAL and switch journal mode back to `DELETE` so the built SQLite
 * file has zero `-wal` / `-shm` sidecars. This allows strict read-only NTFS
 * sandboxes (`codex mcp-server -c sandbox_mode="read-only"`) to open the DB
 * without write access to the parent directory, and lets worker-clone
 * provisioning copy a single self-contained `.sqlite` file.
 *
 * @param {DatabaseSync} db
 */
export function finalizeDatabaseForReadOnly(db) {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec("PRAGMA optimize;");
  } catch {
    // Ignore on `:memory:` or already-DELETE databases.
  }
}

/**
 * Create all relational, FTS5, and R-tree tables if absent.
 *
 * @param {DatabaseSync} db
 */
export function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      line_count INTEGER NOT NULL,
      ext TEXT NOT NULL,
      domain TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS symbols (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      signature TEXT,
      community_id INTEGER,
      is_utility INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
    CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);

    CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
      id UNINDEXED,
      name,
      file_path,
      signature,
      kind,
      tokenize = 'unicode61 tokenchars _'
    );

    CREATE TABLE IF NOT EXISTS edges (
      src_id TEXT NOT NULL,
      dst_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      provenance TEXT NOT NULL,
      detail TEXT,
      file_path TEXT,
      line INTEGER,
      PRIMARY KEY (src_id, dst_id, relation, provenance)
    );

    CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_id);
    CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_id);
    CREATE INDEX IF NOT EXISTS idx_edges_rel ON edges(relation);

    CREATE TABLE IF NOT EXISTS contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      line INTEGER NOT NULL,
      category TEXT NOT NULL,
      contract_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      detail TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_contracts_file ON contracts(file_path);
    CREATE INDEX IF NOT EXISTS idx_contracts_cat ON contracts(category, severity);

    CREATE TABLE IF NOT EXISTS ledger_entries (
      id TEXT PRIMARY KEY,
      source_file TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      authority_rank INTEGER NOT NULL,
      doc_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      batch_num INTEGER,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      amends_ids TEXT,
      cited_paths TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_ledger_status_rank ON ledger_entries(status, authority_rank);
    CREATE INDEX IF NOT EXISTS idx_ledger_file ON ledger_entries(source_file);

    CREATE VIRTUAL TABLE IF NOT EXISTS ledger_fts USING fts5(
      id,
      title,
      summary,
      cited_paths,
      doc_kind,
      status,
      tokenize = 'unicode61 tokenchars _'
    );

    CREATE TABLE IF NOT EXISTS spatial_rigs (
      rowid_num INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      file_path TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      renderers_json TEXT NOT NULL,
      lon REAL,
      lat REAL,
      height_m REAL,
      min_lon REAL,
      max_lon REAL,
      min_lat REAL,
      max_lat REAL,
      clock_utc TEXT,
      solar_elevation_deg REAL,
      regimes_json TEXT NOT NULL,
      dials_json TEXT,
      description TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS spatial_rigs_rtree USING rtree(
      rowid_num,
      min_lon,
      max_lon,
      min_lat,
      max_lat
    );

    CREATE TABLE IF NOT EXISTS gis_assets (
      id TEXT PRIMARY KEY,
      builder_path TEXT NOT NULL,
      asset_path TEXT NOT NULL,
      crs_from TEXT NOT NULL,
      crs_to TEXT NOT NULL,
      vertical_datum TEXT NOT NULL,
      min_lon REAL NOT NULL,
      max_lon REAL NOT NULL,
      min_lat REAL NOT NULL,
      max_lat REAL NOT NULL,
      resolution_deg REAL,
      seam_rule TEXT NOT NULL,
      error_budget TEXT,
      consumers_json TEXT NOT NULL
    );
  `);
}

/**
 * Compute SHA-256 hex digest of a Buffer or UTF-8 string.
 *
 * @param {Buffer | string} content
 * @returns {string}
 */
export function sha256Hex(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Normalize a path to forward-slash repository-relative form.
 *
 * @param {string} repoRoot
 * @param {string} filePath
 * @returns {string}
 */
export function toPosixRel(repoRoot, filePath) {
  const rel = path.isAbsolute(filePath)
    ? path.relative(repoRoot, filePath)
    : filePath;
  return rel.split(path.sep).join("/").replace(/^\.\//, "");
}

/**
 * Read a line range directly from disk, verifying its current SHA-256 against
 * the indexed blob digest so callers never cite stale line numbers when a
 * working-tree file has moved since indexing.
 *
 * @param {string} repoRoot
 * @param {string} relPath
 * @param {number} startLine 1-based inclusive
 * @param {number} endLine 1-based inclusive
 * @param {string | null} [indexedSha256]
 * @param {string} [symbolName] Optional symbol name to relocate if the file changed
 * @returns {{
 *   exists: boolean,
 *   fresh: boolean,
 *   relocated: boolean,
 *   currentSha256: string | null,
 *   startLine: number,
 *   endLine: number,
 *   totalLines: number,
 *   snippet: string
 * }}
 */
export function readVerifiedSlice(
  repoRoot,
  relPath,
  startLine,
  endLine,
  indexedSha256 = null,
  symbolName = undefined,
) {
  const fullPath = path.resolve(repoRoot, relPath);
  if (!fs.existsSync(fullPath)) {
    return {
      exists: false,
      fresh: false,
      relocated: false,
      currentSha256: null,
      startLine,
      endLine,
      totalLines: 0,
      snippet: "",
    };
  }

  const rawBuf = fs.readFileSync(fullPath);
  const currentSha256 = sha256Hex(rawBuf);
  const text = rawBuf.toString("utf8");
  const lines = text.split(/\r?\n/);
  const totalLines = lines.length;
  const fresh = indexedSha256 == null ? true : currentSha256 === indexedSha256;

  let resolvedStart = Math.max(1, Math.min(startLine, totalLines));
  let resolvedEnd = Math.max(resolvedStart, Math.min(endLine, totalLines));
  let relocated = false;

  // If the file changed on disk and a symbol name was provided, check whether
  // the symbol moved out of the original window and re-anchor on live source.
  if (!fresh && symbolName && symbolName.length >= 2) {
    const windowText = lines.slice(resolvedStart - 1, resolvedEnd).join("\n");
    const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const declRe = new RegExp(
      `\\b(?:function|class|interface|type|const|let|fn|struct)\\s+${escaped}\\b|^\\s*(?:async\\s+)?${escaped}\\s*\\(`,
    );
    if (!declRe.test(windowText)) {
      const span = Math.max(0, endLine - startLine);
      for (let i = 0; i < totalLines; i += 1) {
        if (declRe.test(lines[i])) {
          resolvedStart = i + 1;
          resolvedEnd = Math.min(totalLines, resolvedStart + span);
          relocated = true;
          break;
        }
      }
    }
  }

  const numbered = [];
  for (let lineNo = resolvedStart; lineNo <= resolvedEnd; lineNo += 1) {
    numbered.push(`${lineNo}: ${lines[lineNo - 1]}`);
  }

  return {
    exists: true,
    fresh,
    relocated,
    currentSha256,
    startLine: resolvedStart,
    endLine: resolvedEnd,
    totalLines,
    snippet: numbered.join("\n"),
  };
}
