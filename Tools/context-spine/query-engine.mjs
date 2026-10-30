// query-engine.mjs — Unified build & token-compact query engine for code seams, contracts, rulings, and spatial rigs.
// @purpose Orchestrate context-spine builds and execute token-budgeted symbol, seam, contract, Charter-ranked ledger, spatial R-tree rig cover, and impact-pack queries.
// @status ACTIVE

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { indexCodeAndSeams } from "./extract-code-seams.mjs";
import { ACTIVE_LEDGER_STATUSES, indexLedger } from "./extract-ledger.mjs";
import {
  findSpatialCoverageGaps,
  indexSpatialAndGis,
  selectMinimalRigCover,
} from "./extract-spatial.mjs";
import {
  importGraphifyJson,
  runGraphifyExtractCodeOnly,
} from "./graphify-bridge.mjs";
import {
  finalizeDatabaseForReadOnly,
  openContextDatabase,
  readVerifiedSlice,
  resolveDbPath,
  SCHEMA_VERSION,
  sha256Hex,
  toPosixRel,
} from "./schema.mjs";

/**
 * Read current repository HEAD SHA using read-only `git rev-parse HEAD`.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
export function readGitHeadSha(repoRoot) {
  const res = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (res.status === 0 && res.stdout.trim()) {
    return res.stdout.trim();
  }
  return "UNTRACKED";
}

/**
 * Build or rebuild the SQLite context spine.
 *
 * @param {{
 *   repoRoot: string,
 *   dbPath?: string,
 *   reset?: boolean,
 *   scanRoots?: string[],
 *   docsDir?: string,
 *   rigsDir?: string,
 *   gisAssets?: object[],
 *   withGraphify?: boolean,
 *   bootstrapGraphify?: boolean,
 *   graphifyJsonPath?: string
 * }} options
 */
export async function buildContextSpine(options) {
  const startedAt = Date.now();
  const repoRoot = path.resolve(options.repoRoot);
  const dbFilePath =
    options.dbPath === ":memory:"
      ? ":memory:"
      : resolveDbPath(repoRoot, options.dbPath);
  const isIncremental =
    Boolean(options.incremental) &&
    dbFilePath !== ":memory:" &&
    fs.existsSync(dbFilePath);
  const db = openContextDatabase(dbFilePath, {
    reset: isIncremental ? false : options.reset !== false,
  });

  try {
    const headSha = readGitHeadSha(repoRoot);
    const codeStats = indexCodeAndSeams(db, repoRoot, {
      scanRoots: options.scanRoots,
      incremental: isIncremental,
    });
    const ledgerStats = indexLedger(db, repoRoot, {
      docsDir: options.docsDir,
    });
    const spatialStats = await indexSpatialAndGis(db, repoRoot, {
      rigsDir: options.rigsDir,
      gisAssets: options.gisAssets,
    });

    let graphifyStats = null;
    const defaultCachedGraphify = path.join(
      repoRoot,
      ".cache",
      "context-spine",
      "graphify",
      "graphify-out",
      "graph.json",
    );
    if (options.graphifyJsonPath) {
      graphifyStats = importGraphifyJson(
        db,
        path.resolve(repoRoot, options.graphifyJsonPath),
        repoRoot,
      );
    } else if (options.withGraphify) {
      graphifyStats = runGraphifyExtractCodeOnly(db, {
        repoRoot,
        bootstrapVenv: Boolean(options.bootstrapGraphify),
        graphifyVersion: options.graphifyVersion,
      });
    } else if (
      !options.incremental &&
      options.reuseCachedGraphify !== false &&
      fs.existsSync(defaultCachedGraphify)
    ) {
      graphifyStats = importGraphifyJson(db, defaultCachedGraphify, repoRoot, {
        scanPrefix: "packages/engine/Source",
      });
    }

    const builtAt = new Date().toISOString();
    const setMeta = db.prepare(
      "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
    );
    db.exec("BEGIN;");
    setMeta.run("schema_version", SCHEMA_VERSION);
    setMeta.run("head_sha", headSha);
    setMeta.run("built_at", builtAt);
    setMeta.run("code_files", String(codeStats.fileCount));
    setMeta.run("symbols", String(codeStats.symbolCount));
    setMeta.run("edges", String(codeStats.edgeCount));
    setMeta.run("contracts", String(codeStats.contractCount));
    setMeta.run("ledger_entries", String(ledgerStats.entryCount));
    setMeta.run("spatial_rigs", String(spatialStats.rigCount));
    setMeta.run("gis_assets", String(spatialStats.gisAssetCount));
    db.exec("COMMIT;");

    if (dbFilePath !== ":memory:") {
      finalizeDatabaseForReadOnly(db);
    }

    return {
      dbPath:
        dbFilePath === ":memory:"
          ? ":memory:"
          : toPosixRel(repoRoot, dbFilePath),
      headSha,
      builtAt,
      durationMs: Date.now() - startedAt,
      code: codeStats,
      ledger: ledgerStats,
      spatial: spatialStats,
      graphify: graphifyStats,
    };
  } finally {
    db.close();
  }
}

/**
 * Open an existing context-spine database (building it automatically if missing,
 * and falling back to an in-memory build if running inside a read-only sandbox).
 *
 * @param {string} repoRoot
 * @param {{ dbPath?: string, autoBuild?: boolean }} [options]
 * @returns {Promise<import("node:sqlite").DatabaseSync>}
 */
export async function openOrBuildSpine(repoRoot, options = {}) {
  const absRoot = path.resolve(repoRoot);
  const dbFilePath = resolveDbPath(absRoot, options.dbPath);
  if (!fs.existsSync(dbFilePath)) {
    if (options.autoBuild === false) {
      throw new Error(
        `Context spine DB not found at ${dbFilePath}; run 'node Tools/query-context.mjs build' first.`,
      );
    }
    try {
      await buildContextSpine({ repoRoot: absRoot, dbPath: dbFilePath });
    } catch (err) {
      const code = /** @type {{ code?: string }} */ (err)?.code;
      if (code === "EPERM" || code === "EACCES" || code === "EROFS") {
        // Read-only NTFS sandbox fallback: build in `:memory:` so MCP/CLI still works.
        const memDb = openContextDatabase(":memory:", { readOnly: false });
        indexCodeAndSeams(memDb, absRoot);
        indexLedger(memDb, absRoot);
        await indexSpatialAndGis(memDb, absRoot);
        return memDb;
      }
      throw err;
    }
  }
  return openContextDatabase(dbFilePath, { readOnly: true });
}

/**
 * Convert arbitrary user query text into a safe FTS5 match expression.
 *
 * @param {string} raw
 * @param {string} [allowedExtra]
 * @returns {string | null}
 */
export function toSafeFtsMatch(raw, allowedExtra = "_") {
  if (!raw || typeof raw !== "string") return null;
  const charClass = new RegExp(`[A-Za-z0-9${allowedExtra}]+`, "g");
  const tokens = [...raw.matchAll(charClass)]
    .map((m) => m[0])
    .filter((t) => t.length >= 2)
    .slice(0, 8);
  if (tokens.length === 0) return null;
  return tokens
    .map((t) => (t.includes("-") ? `"${t}"` : `${t}*`))
    .join(" AND ");
}

/**
 * Summarize table counts and metadata from an open spine database.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function getSpineStats(db) {
  const metaRows = db.prepare("SELECT key, value FROM meta").all();
  const meta = Object.fromEntries(metaRows.map((r) => [r.key, r.value]));
  const symbolsByKind = db
    .prepare(
      "SELECT kind, COUNT(*) AS count FROM symbols GROUP BY kind ORDER BY count DESC",
    )
    .all();
  const edgesByRel = db
    .prepare(
      "SELECT relation, provenance, COUNT(*) AS count FROM edges GROUP BY relation, provenance ORDER BY count DESC",
    )
    .all();
  const contractsBySummary = db
    .prepare(
      "SELECT category, severity, COUNT(*) AS count FROM contracts GROUP BY category, severity ORDER BY count DESC",
    )
    .all();
  const ledgerByKind = db
    .prepare(
      "SELECT doc_kind, status, COUNT(*) AS count FROM ledger_entries GROUP BY doc_kind, status ORDER BY doc_kind, status",
    )
    .all();
  const rigRows = db.prepare("SELECT regimes_json FROM spatial_rigs").all();
  const parsedRigs = rigRows.map((r) => ({
    regimes: JSON.parse(r.regimes_json),
  }));

  return {
    meta,
    symbolsByKind,
    edgesByRel,
    contractsBySummary,
    ledgerByKind,
    spatialCoverageGaps: findSpatialCoverageGaps(parsedRigs),
  };
}

/**
 * Search symbols with optional live SHA-256 disk-verified code slice extraction.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} repoRoot
 * @param {string} query
 * @param {{
 *   limit?: number,
 *   kind?: string,
 *   excludeUtilities?: boolean,
 *   includeSlice?: boolean,
 *   maxSliceLines?: number
 * }} [options]
 */
export function querySymbols(db, repoRoot, query, options = {}) {
  const limit = options.limit ?? 15;
  const excludeUtilities = options.excludeUtilities !== false;
  const includeSlice = Boolean(options.includeSlice);
  const maxSliceLines = options.maxSliceLines ?? 35;
  const norm = query.trim().replace(/\\/g, "/");

  const seen = new Map();
  function collectRows(rows) {
    for (const r of rows) {
      if (excludeUtilities && r.is_utility) continue;
      if (options.kind && r.kind !== options.kind) continue;
      if (!seen.has(r.id)) seen.set(r.id, r);
      if (seen.size >= limit) break;
    }
  }

  // 1. Exact ID, symbol name, or file path / basename match
  const exactRows = db
    .prepare(
      `SELECT s.*, f.sha256 AS indexed_sha256
       FROM symbols s
       LEFT JOIN files f ON f.path = s.file_path
       WHERE s.id = ? OR s.name = ? OR s.file_path = ? OR s.file_path LIKE ?
       ORDER BY CASE WHEN s.kind = 'file' THEN 0 ELSE 1 END, s.start_line ASC
       LIMIT ?`,
    )
    .all(norm, norm, norm, `%/${path.posix.basename(norm)}`, limit * 2);
  collectRows(exactRows);

  // 2. FTS5 match
  if (seen.size < limit) {
    const ftsExpr = toSafeFtsMatch(norm, "_");
    if (ftsExpr) {
      try {
        const ftsRows = db
          .prepare(
            `SELECT s.*, f.sha256 AS indexed_sha256
             FROM symbols_fts fts
             JOIN symbols s ON s.id = fts.id
             LEFT JOIN files f ON f.path = s.file_path
             WHERE symbols_fts MATCH ?
             ORDER BY bm25(symbols_fts)
             LIMIT ?`,
          )
          .all(ftsExpr, limit * 2);
        collectRows(ftsRows);
      } catch {
        // Fallback to LIKE below on exotic punctuation
      }
    }
  }

  // 3. Substring LIKE fallback
  if (seen.size < limit) {
    const likeRows = db
      .prepare(
        `SELECT s.*, f.sha256 AS indexed_sha256
         FROM symbols s
         LEFT JOIN files f ON f.path = s.file_path
         WHERE s.name LIKE ? OR s.file_path LIKE ?
         ORDER BY s.is_utility ASC, LENGTH(s.name) ASC
         LIMIT ?`,
      )
      .all(`%${norm}%`, `%${norm}%`, limit * 2);
    collectRows(likeRows);
  }

  const results = [...seen.values()].slice(0, limit).map((row) => {
    const item = {
      id: row.id,
      name: row.name,
      kind: row.kind,
      filePath: row.file_path,
      startLine: row.start_line,
      endLine: row.end_line,
      signature: row.signature,
      communityId: row.community_id,
      indexedSha256: row.indexed_sha256 ?? null,
    };

    if (includeSlice) {
      const cappedEnd = Math.min(
        row.end_line,
        row.start_line + maxSliceLines - 1,
      );
      const verified = readVerifiedSlice(
        repoRoot,
        row.file_path,
        row.start_line,
        cappedEnd,
        row.indexed_sha256 ?? null,
        row.kind === "file" ? undefined : row.name,
      );
      item.slice = verified;
      item.startLine = verified.startLine;
      item.endLine = verified.endLine;
    }
    return item;
  });

  return results;
}

/**
 * Query Cesium cross-boundary seams (`FeatureRendererKey`, `ShaderSourceId`,
 * 3-word `ShaderDefine` + WGSL `//>>ifdef`, `GLSL<->WGSL` parity) and structural edges.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} target
 * @param {{ limit?: number }} [options]
 */
export function querySeams(db, target, options = {}) {
  const limit = options.limit ?? 40;
  const norm = target.trim().replace(/\\/g, "/");
  const baseName = path.posix.basename(norm);

  // Locate matching anchor IDs (file:<path>, frkey:<X>, define:<X>, shader-source:<X>, or symbol IDs)
  const matchedSymbols = db
    .prepare(
      `SELECT id, name, kind, file_path, start_line, end_line, signature, community_id
       FROM symbols
       WHERE id = ? OR name = ? OR file_path = ? OR file_path LIKE ?
          OR id = ? OR id = ? OR id = ?
       LIMIT 30`,
    )
    .all(
      norm,
      norm,
      norm,
      `%/${baseName}`,
      `frkey:${norm.replace(/^FeatureRendererKey\./, "")}`,
      `define:${norm.replace(/^ShaderDefine(?:Hi|Ext)?\./, "")}`,
      `shader-source:${norm.replace(/^ShaderSourceId\./, "")}`,
    );

  const anchorIds = new Set(matchedSymbols.map((s) => s.id));
  const anchorFiles = new Set(matchedSymbols.map((s) => s.file_path));
  for (const f of anchorFiles) {
    anchorIds.add(`file:${f}`);
  }
  if (anchorIds.size === 0) {
    anchorIds.add(norm);
  }

  const placeholders = [...anchorIds].map(() => "?").join(", ");
  const filePlaceholders =
    anchorFiles.size > 0 ? [...anchorFiles].map(() => "?").join(", ") : null;

  const rawEdges = db
    .prepare(
      `SELECT src_id, dst_id, relation, provenance, detail, file_path, line
       FROM edges
       WHERE src_id IN (${placeholders})
          OR dst_id IN (${placeholders})
          ${filePlaceholders ? `OR file_path IN (${filePlaceholders})` : ""}
       ORDER BY CASE WHEN provenance = 'cesium-seam' OR provenance = 'wgsl-preprocessor' THEN 0 ELSE 1 END,
                CASE WHEN file_path LIKE 'packages/%' THEN 0 ELSE 1 END,
                relation ASC, line ASC
       LIMIT ?`,
    )
    .all(
      ...[...anchorIds],
      ...[...anchorIds],
      ...(filePlaceholders ? [...anchorFiles] : []),
      limit * 3,
    );

  const SEAM_RELATIONS = new Set([
    "registers_feature_renderer",
    "consumes_feature_renderer",
    "reads_shader_define",
    "ifdef_guards",
    "uses_shader_source",
    "glsl_wgsl_parity",
    "crs_transition",
    "crs_pipeline_step",
    "gis_consumes",
    "gis_verified_by",
  ]);

  const seamEdges = [];
  const callAndImportEdges = [];

  // Expand 1-hop across `frkey:*` and `define:*` bridges so asking about `Globe.js` or `GlobeTerrain.wgsl`
  // reveals the other side of the seam immediately!
  const bridgeHubIds = new Set();
  for (const e of rawEdges) {
    if (SEAM_RELATIONS.has(e.relation)) {
      seamEdges.push(e);
      if (
        e.src_id.startsWith("frkey:") ||
        e.src_id.startsWith("define:") ||
        e.src_id.startsWith("shader-source:")
      ) {
        bridgeHubIds.add(e.src_id);
      }
      if (
        e.dst_id.startsWith("frkey:") ||
        e.dst_id.startsWith("define:") ||
        e.dst_id.startsWith("shader-source:")
      ) {
        bridgeHubIds.add(e.dst_id);
      }
    } else {
      callAndImportEdges.push(e);
    }
  }

  const counterpartEdges = [];
  if (bridgeHubIds.size > 0) {
    const bp = [...bridgeHubIds].map(() => "?").join(", ");
    const hop2 = db
      .prepare(
        `SELECT src_id, dst_id, relation, provenance, detail, file_path, line
         FROM edges
         WHERE (src_id IN (${bp}) OR dst_id IN (${bp}))
         LIMIT ?`,
      )
      .all(...[...bridgeHubIds], ...[...bridgeHubIds], limit * 2);

    const seenEdgeKey = new Set(
      seamEdges.map((e) => `${e.src_id}|${e.dst_id}|${e.relation}`),
    );
    for (const h of hop2) {
      const k = `${h.src_id}|${h.dst_id}|${h.relation}`;
      if (!seenEdgeKey.has(k)) {
        seenEdgeKey.add(k);
        counterpartEdges.push(h);
      }
    }
  }

  // Enrich define symbols referenced in seamEdges with their bit/owner signature
  const defineDetails = [];
  const defineIds = [...bridgeHubIds].filter((id) => id.startsWith("define:"));
  if (defineIds.length > 0) {
    const dp = defineIds.map(() => "?").join(", ");
    defineDetails.push(
      ...db
        .prepare(
          `SELECT id, name, kind, file_path, start_line, signature FROM symbols WHERE id IN (${dp})`,
        )
        .all(...defineIds),
    );
  }

  return {
    anchors: matchedSymbols.slice(0, 12),
    seamEdges: seamEdges.slice(0, limit),
    counterpartEdges: counterpartEdges.slice(0, limit),
    defineDetails,
    callAndImportEdges: callAndImportEdges.slice(0, limit),
  };
}

/**
 * Query rulings, queue rows, `CAMPAIGN_STATE`, Blueprint hotspots/epics, and `DEFERRED_WORK`
 * ordered strictly by Charter §0.4 authority rank and highest Batch number.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} query
 * @param {{
 *   activeOnly?: boolean,
 *   docKind?: string,
 *   limit?: number
 * }} [options]
 */
export function queryLedger(db, query, options = {}) {
  const limit = options.limit ?? 15;
  const activeOnly = options.activeOnly !== false;
  const norm = query.trim();

  // Check if caller asked for an exact ruling / queue ID — always return exact ID hits even if AMENDED/CLOSED!
  const exactHits = db
    .prepare(
      `SELECT * FROM ledger_entries
       WHERE id = ? OR id = ? OR id = ? OR id = ?
       ORDER BY authority_rank ASC`,
    )
    .all(
      norm,
      `queue:${norm}`,
      `campaign:${norm}`,
      `hotspot:${path.posix.basename(norm)}`,
    );

  // An ACTIVE row whose id IS the query leads its rank: `ruling R-2026-08-29-1`
  // must answer with that ruling, not with a later ruling that merely cites it.
  // An inactive exact hit (AMENDED / VACATED) still sorts after the active rows
  // that supersede it.
  const exactActiveIds = new Set(
    exactHits
      .filter((r) => ACTIVE_LEDGER_STATUSES.has(r.status))
      .map((r) => r.id),
  );
  const seen = new Map();
  for (const row of exactHits) {
    if (options.docKind && row.doc_kind !== options.docKind) continue;
    seen.set(row.id, row);
  }

  function keepRow(row) {
    if (options.docKind && row.doc_kind !== options.docKind) return false;
    if (activeOnly && !ACTIVE_LEDGER_STATUSES.has(row.status)) return false;
    return true;
  }

  // FTS5 search
  const ftsExpr = toSafeFtsMatch(norm, "_");
  if (seen.size < limit && ftsExpr) {
    try {
      const ftsRows = db
        .prepare(
          `SELECT le.*
           FROM ledger_fts fts
           JOIN ledger_entries le ON le.id = fts.id
           WHERE ledger_fts MATCH ?
           ORDER BY le.authority_rank ASC, COALESCE(le.batch_num, 0) DESC, bm25(ledger_fts)
           LIMIT ?`,
        )
        .all(ftsExpr, limit * 3);
      for (const r of ftsRows) {
        if (!seen.has(r.id) && keepRow(r)) {
          seen.set(r.id, r);
          if (seen.size >= limit) break;
        }
      }
    } catch {
      // Fallback to LIKE below
    }
  }

  // Substring fallback on cited_paths / title / id
  if (seen.size < limit) {
    const base = path.posix.basename(norm.replace(/\\/g, "/"));
    const likeRows = db
      .prepare(
        `SELECT * FROM ledger_entries
         WHERE cited_paths LIKE ? OR title LIKE ? OR id LIKE ?
         ORDER BY authority_rank ASC, COALESCE(batch_num, 0) DESC
         LIMIT ?`,
      )
      .all(`%${base}%`, `%${norm}%`, `%${norm}%`, limit * 3);
    for (const r of likeRows) {
      if (!seen.has(r.id) && keepRow(r)) {
        seen.set(r.id, r);
        if (seen.size >= limit) break;
      }
    }
  }

  return [...seen.values()]
    .sort((a, b) => {
      if (a.authority_rank !== b.authority_rank) {
        return a.authority_rank - b.authority_rank;
      }
      const aExact = exactActiveIds.has(a.id) ? 0 : 1;
      const bExact = exactActiveIds.has(b.id) ? 0 : 1;
      if (aExact !== bExact) {
        return aExact - bExact;
      }
      const aActive = ACTIVE_LEDGER_STATUSES.has(a.status) ? 0 : 1;
      const bActive = ACTIVE_LEDGER_STATUSES.has(b.status) ? 0 : 1;
      if (aActive !== bActive) {
        return aActive - bActive;
      }
      return (b.batch_num ?? 0) - (a.batch_num ?? 0);
    })
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      sourceFile: r.source_file,
      startLine: r.start_line,
      endLine: r.end_line,
      authorityRank: r.authority_rank,
      docKind: r.doc_kind,
      status: r.status,
      batchNum: r.batch_num,
      title: r.title,
      summary: r.summary,
      amendsIds: r.amends_ids ? r.amends_ids.split(",") : [],
      citedPaths: r.cited_paths ? r.cited_paths.split(" ") : [],
    }));
}

/**
 * Infer primary `RIG_TAGS` domain affinity for a target file or symbol so domain-specific
 * rigs outscore generic `globe` / `wave-end` rigs on single-target ties.
 *
 * @param {string} target
 * @returns {string | undefined}
 */
export function inferPrimaryDomainTag(target) {
  const lower = target.toLowerCase();
  if (/\bssr\b|screenspacereflection/.test(lower)) return "ssr";
  if (
    /ocean|water|bathymetry|tide|tidal|river|lake|meniscus|caustic|jerlov/.test(
      lower,
    )
  ) {
    return "water";
  }
  if (/cloud/.test(lower)) return "cloud";
  if (/weather/.test(lower)) return "weather";
  if (/voxel/.test(lower)) return "voxel";
  if (/aurora/.test(lower)) return "aurora";
  if (/polyline/.test(lower)) return "polyline";
  if (/globe|terrain|imagery|ellipsoid|geoid/.test(lower)) return "globe";
  return undefined;
}

/**
 * Infer relevant spatial validation regimes and rig tags from a target path or symbol name.
 *
 * @param {string} target
 * @returns {string[]}
 */
export function inferSpatialTargetsForSubject(target) {
  const lower = target.toLowerCase();
  const targets = new Set();

  const isSsrSubject = /\bssr\b|screenspacereflection/.test(lower);
  const isWaterSubject =
    !isSsrSubject &&
    /ocean|water|bathymetry|tide|tidal|river|lake|meniscus|caustic|jerlov/.test(
      lower,
    );

  if (isSsrSubject) {
    targets.add("coastal_or_water");
    targets.add("ssr");
  }
  if (isWaterSubject) {
    targets.add("water");
    targets.add("coastal_or_water");
    targets.add("stratospheric_or_limb");
    targets.add("orbital");
    targets.add("equatorial");
    targets.add("inland_lake_or_river");
    targets.add("sub_ellipsoid_ocean_bathy");
    if (/antimeridian|coastline/.test(lower)) {
      targets.add("antimeridian_coast_sdf");
    }
  }
  if (/cloud|weather/.test(lower)) {
    targets.add("cloud");
    targets.add("north_pole");
    targets.add("grazing_terminator");
    targets.add("orbital");
  }
  if (
    !isWaterSubject &&
    /globe|terrain|imagery|ellipsoid|geoid|coast/.test(lower)
  ) {
    targets.add("globe");
    targets.add("wgs84");
    targets.add("coastal_or_water");
    targets.add("north_pole");
    targets.add("grazing_terminator");
  }
  if (/voxel/.test(lower)) {
    targets.add("voxel_volume");
    targets.add("sub_ellipsoid_or_underground");
  }
  if (/aurora/.test(lower)) {
    targets.add("aurora");
    targets.add("high_latitude");
    targets.add("night_lit");
  }
  if (/sky|atmosphere|sun|moon|star|eclipse|aerial|fog/.test(lower)) {
    targets.add("grazing_terminator");
    targets.add("night_lit");
    targets.add("orbital");
  }
  if (/polyline|vector/.test(lower)) {
    targets.add("polyline");
    targets.add("near_surface");
  }
  if (/model|pbr|ibl|cluster|shadow|oit|postprocess|taa/.test(lower)) {
    targets.add("wave-end");
    targets.add("near_surface");
  }
  if (targets.size === 0) {
    targets.add("wave-end");
  }
  return [...targets];
}

/**
 * Query spatial R-tree rigs, minimal set-cover validation recommendations, and overlapping GIS assets.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{
 *   bbox?: [number, number, number, number],
 *   regimes?: string[],
 *   tags?: string[],
 *   renderer?: string,
 *   forTarget?: string,
 *   limit?: number
 * }} [options]
 */
export function querySpatialValidation(db, options = {}) {
  const limit = options.limit ?? 20;
  let rigRows;

  if (Array.isArray(options.bbox) && options.bbox.length === 4) {
    const [minLon, minLat, maxLon, maxLat] = options.bbox;
    rigRows = db
      .prepare(
        `SELECT sr.*
         FROM spatial_rigs_rtree rt
         JOIN spatial_rigs sr ON sr.rowid_num = rt.rowid_num
         WHERE rt.max_lon >= ? AND rt.min_lon <= ?
           AND rt.max_lat >= ? AND rt.min_lat <= ?
         ORDER BY sr.id ASC`,
      )
      .all(minLon, maxLon, minLat, maxLat);
  } else {
    rigRows = db.prepare("SELECT * FROM spatial_rigs ORDER BY id ASC").all();
  }

  let parsed = rigRows.map((r) => ({
    id: r.id,
    filePath: r.file_path,
    tags: JSON.parse(r.tags_json),
    renderers: JSON.parse(r.renderers_json),
    lon: r.lon,
    lat: r.lat,
    heightM: r.height_m,
    bbox:
      r.min_lon !== null ? [r.min_lon, r.min_lat, r.max_lon, r.max_lat] : null,
    clockUtc: r.clock_utc,
    solarElevationDeg: r.solar_elevation_deg,
    regimes: JSON.parse(r.regimes_json),
    description: r.description,
  }));

  if (options.renderer) {
    parsed = parsed.filter((r) => r.renderers.includes(options.renderer));
  }

  const requestedTargets = [
    ...(options.regimes ?? []),
    ...(options.tags ?? []),
    ...(options.forTarget
      ? inferSpatialTargetsForSubject(options.forTarget)
      : []),
  ];
  const uniqueTargets = [...new Set(requestedTargets)];

  let filtered = parsed;
  if ((options.regimes?.length ?? 0) > 0 || (options.tags?.length ?? 0) > 0) {
    filtered = parsed.filter((r) => {
      const regOk =
        !options.regimes?.length ||
        options.regimes.some((req) => r.regimes.includes(req));
      const tagOk =
        !options.tags?.length ||
        options.tags.some((req) => r.tags.includes(req));
      return regOk && tagOk;
    });
  }

  const primaryDomainTag =
    options.tags?.[0] ??
    (options.forTarget ? inferPrimaryDomainTag(options.forTarget) : undefined);

  const minimalCover =
    uniqueTargets.length > 0
      ? selectMinimalRigCover(parsed, uniqueTargets, { primaryDomainTag })
      : null;

  // Match GIS datum assets by bbox overlap or target consumer path
  const gisRows = db.prepare("SELECT * FROM gis_assets ORDER BY id ASC").all();
  let gisAssets = gisRows.map((g) => ({
    id: g.id,
    builderPath: g.builder_path,
    assetPath: g.asset_path,
    crsFrom: g.crs_from,
    crsTo: g.crs_to,
    verticalDatum: g.vertical_datum,
    bbox: [g.min_lon, g.min_lat, g.max_lon, g.max_lat],
    resolutionDeg: g.resolution_deg,
    seamRule: g.seam_rule,
    errorBudget: g.error_budget,
    consumers: JSON.parse(g.consumers_json),
  }));

  if (options.forTarget) {
    const base = path.posix
      .basename(options.forTarget.replace(/\\/g, "/"))
      .toLowerCase();
    const matchedGis = gisAssets.filter(
      (g) =>
        g.consumers.some((c) => c.toLowerCase().includes(base)) ||
        g.id.includes(base.replace(/\..*$/, "")),
    );
    if (matchedGis.length > 0) {
      gisAssets = matchedGis;
    } else if (
      !/globe|terrain|water|cloud|weather|geoid|eclipse|sky/.test(
        options.forTarget.toLowerCase(),
      )
    ) {
      gisAssets = [];
    }
  } else if (Array.isArray(options.bbox) && options.bbox.length === 4) {
    const [minLon, minLat, maxLon, maxLat] = options.bbox;
    gisAssets = gisAssets.filter(
      (g) =>
        g.bbox[2] >= minLon &&
        g.bbox[0] <= maxLon &&
        g.bbox[3] >= minLat &&
        g.bbox[1] <= maxLat,
    );
  }

  const allRigsForGaps = db
    .prepare("SELECT regimes_json FROM spatial_rigs")
    .all()
    .map((r) => ({ regimes: JSON.parse(r.regimes_json) }));

  return {
    totalMatchingRigs: filtered.length,
    rigs: filtered.slice(0, limit),
    minimalCover,
    gisAssets,
    fleetCoverageGaps: findSpatialCoverageGaps(allRigsForGaps),
  };
}

/**
 * Query coordinate-space, RTE 64-bit precision, log-depth, CameraUniforms tail, and bind-group contracts.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{
 *   filePath?: string,
 *   category?: string,
 *   severity?: string,
 *   limit?: number
 * }} [options]
 */
export function queryContracts(db, options = {}) {
  const limit = options.limit ?? 30;
  const clauses = [];
  const params = [];

  if (options.filePath) {
    const norm = options.filePath.replace(/\\/g, "/");
    clauses.push("(file_path = ? OR file_path LIKE ?)");
    params.push(norm, `%${norm}%`);
  }
  if (options.category) {
    clauses.push("category = ?");
    params.push(options.category);
  }
  if (options.severity) {
    clauses.push("severity = ?");
    params.push(options.severity);
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const summary = db
    .prepare(
      `SELECT category, contract_type, severity, COUNT(*) AS count
       FROM contracts
       ${whereSql}
       GROUP BY category, contract_type, severity
       ORDER BY CASE severity WHEN 'hazard' THEN 0 WHEN 'review' THEN 1 ELSE 2 END, count DESC`,
    )
    .all(...params);

  const items = db
    .prepare(
      `SELECT file_path, line, category, contract_type, severity, detail
       FROM contracts
       ${whereSql}
       ORDER BY CASE severity WHEN 'hazard' THEN 0 WHEN 'review' THEN 1 ELSE 2 END, file_path ASC, line ASC
       LIMIT ?`,
    )
    .all(...params, limit);

  return { summary, items };
}

/**
 * Find exported runtime symbols (`class`, `function`, `const`) under `options.prefix`
 * that have zero inbound runtime (`packages/engine/` or `packages/widgets/`) imports or call edges,
 * excluding `@experimental`-tagged symbols, barrel `index.*` files, and worker entrypoints.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{
 *   prefix?: string,
 *   includePublicJsDefaults?: boolean,
 *   includeToolConsumers?: boolean,
 *   limit?: number
 * }} [options]
 */
export function queryDeadExports(db, options = {}) {
  const rawPrefix = (
    options.prefix ??
    options.scopePrefix ??
    "packages/engine/Source"
  ).replace(/\\/g, "/");
  const prefix = /^(?:packages|Tools|Specs|Apps)\//.test(rawPrefix)
    ? rawPrefix
    : `packages/engine/Source/${rawPrefix.replace(/^\/+/, "")}`;
  const limit = options.limit ?? 50;
  const includePublicJsDefaults = Boolean(options.includePublicJsDefaults);
  const includeToolConsumers = Boolean(options.includeToolConsumers);

  const candidates = db
    .prepare(
      `SELECT id, name, kind, file_path, start_line, end_line, signature
       FROM symbols
       WHERE file_path LIKE ?
         AND kind IN ('class', 'function', 'const')
         AND is_utility = 0
         AND signature LIKE 'export %'
         AND signature NOT LIKE '%[@experimental]%'
         AND file_path NOT LIKE '%/index.js'
         AND file_path NOT LIKE '%/index.ts'
         AND file_path NOT LIKE '%/Workers/%'
       ORDER BY file_path ASC, start_line ASC`,
    )
    .all(`${prefix}%`);

  const selFileImports = db.prepare(
    `SELECT src_id, detail, file_path
     FROM edges
     WHERE relation = 'imports' AND dst_id = ?`,
  );
  const selSymEdges = db.prepare(
    `SELECT src_id, relation, file_path
     FROM edges
     WHERE dst_id = ? OR dst_id = ?`,
  );

  const importCache = new Map();
  function getImportsForFile(relPath) {
    if (!importCache.has(relPath)) {
      importCache.set(relPath, selFileImports.all(`file:${relPath}`));
    }
    return importCache.get(relPath);
  }

  function isRuntimePath(p) {
    if (!p) return true;
    if (p.endsWith("/index.js") || p.endsWith("/index.ts")) return false;
    if (includeToolConsumers) return true;
    return (
      p.startsWith("packages/engine/") || p.startsWith("packages/widgets/")
    );
  }

  const dead = [];
  for (const sym of candidates) {
    const isJsDefault =
      sym.file_path.endsWith(".js") &&
      sym.signature.startsWith("export default ");
    if (isJsDefault && !includePublicJsDefaults) {
      continue;
    }

    const fileStem = path.posix
      .basename(sym.file_path)
      .replace(/\.(?:js|ts|mjs)$/, "");
    const isDefaultSym =
      sym.signature.startsWith("export default ") || sym.name === fileStem;
    const nameWordRe = new RegExp(
      `\\b${sym.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    );

    let runtimeConsumers = 0;
    let toolOnlyConsumers = 0;

    for (const imp of getImportsForFile(sym.file_path)) {
      if (imp.file_path === sym.file_path) continue;
      if (
        imp.file_path &&
        (imp.file_path.endsWith("/index.js") ||
          imp.file_path.endsWith("/index.ts"))
      ) {
        continue;
      }
      const d = String(imp.detail ?? "");
      const bindsSymbol =
        d.includes("* as") ||
        d === "dynamic import()" ||
        nameWordRe.test(d) ||
        (isDefaultSym &&
          (!/^\s*(?:re-export\s+)?\{/.test(d) || /\bdefault\s+as\b/.test(d)));
      if (!bindsSymbol) continue;
      if (isRuntimePath(imp.file_path)) {
        runtimeConsumers += 1;
      } else {
        toolOnlyConsumers += 1;
      }
    }

    if (runtimeConsumers === 0) {
      for (const se of selSymEdges.all(sym.id, `symbol:${sym.name}`)) {
        if (se.src_id === sym.id || se.file_path === sym.file_path) continue;
        if (isRuntimePath(se.file_path)) {
          runtimeConsumers += 1;
          break;
        } else {
          toolOnlyConsumers += 1;
        }
      }
    }

    if (runtimeConsumers === 0) {
      dead.push({
        id: sym.id,
        name: sym.name,
        kind: sym.kind,
        filePath: sym.file_path,
        startLine: sym.start_line,
        endLine: sym.end_line,
        signature: sym.signature,
        toolOnlyConsumers,
      });
    }
  }

  return {
    prefix,
    totalDeadExports: dead.length,
    items: dead.slice(0, limit),
  };
}

/**
 * Match `package.json` `test-*` runner scripts relevant to a set of target files/stems.
 *
 * @param {string} repoRoot
 * @param {string[]} targetStrings
 * @returns {Array<{ script: string, command: string }>}
 */
export function findMatchingTestScripts(repoRoot, targetStrings) {
  const pkgPath = path.resolve(repoRoot, "package.json");
  if (!fs.existsSync(pkgPath)) return [];
  let scripts;
  try {
    scripts = JSON.parse(fs.readFileSync(pkgPath, "utf8")).scripts ?? {};
  } catch {
    return [];
  }

  const keywords = new Set();
  for (const t of targetStrings) {
    const stem = path.posix
      .basename(t.replace(/\\/g, "/"))
      .replace(/\.(ts|js|mjs|wgsl|glsl)$/, "")
      .replace(/^WebGPU/, "")
      .replace(/Renderer$/, "");
    for (const part of stem.split(/(?=[A-Z])|[-_]/)) {
      const low = part.toLowerCase();
      if (
        low.length >= 3 &&
        !["web", "gpu", "src", "lib", "the"].includes(low)
      ) {
        keywords.add(low);
      }
    }
  }

  const scored = [];
  for (const [name, cmd] of Object.entries(scripts)) {
    if (!name.startsWith("test-") && !name.startsWith("lint-")) continue;
    const hay = `${name} ${cmd}`.toLowerCase();
    let hits = 0;
    for (const kw of keywords) {
      if (hay.includes(kw)) hits += 1;
    }
    if (hits > 0) {
      scored.push({ script: name, command: String(cmd), hits });
    }
  }

  scored.sort((a, b) => b.hits - a.hits || a.script.localeCompare(b.script));
  return scored.slice(0, 6).map(({ script, command }) => ({
    script,
    command: command.length > 140 ? `${command.slice(0, 137)}...` : command,
  }));
}

/**
 * Build a unified ~1.5K-2.5K token Impact Pack for any file, symbol, define, or subsystem.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} repoRoot
 * @param {string} target
 * @param {{ includeSlice?: boolean }} [options]
 */
export function buildImpactPack(db, repoRoot, target, options = {}) {
  const symbols = querySymbols(db, repoRoot, target, {
    limit: 10,
    includeSlice: Boolean(options.includeSlice),
    maxSliceLines: 25,
  });

  // A registry key (FeatureRendererKey, ShaderDefine*, ShaderSourceId) lives in
  // a shared registry file. Packing that FILE answers a different question: its
  // outline is the first keys of the table and its seams belong to other keys.
  // When the target names a key, the pack is anchored on the key itself.
  const registryAnchors = symbols.filter(
    (s) =>
      REGISTRY_ANCHOR_KINDS.has(s.kind) &&
      (s.name === target ||
        s.name.endsWith(`.${target}`) ||
        s.id.endsWith(`:${target}`)),
  );
  const anchorTarget = registryAnchors.length > 0 ? target : null;

  const primaryFile =
    symbols.find((s) => s.kind === "file")?.filePath ??
    symbols[0]?.filePath ??
    null;

  // Check live disk freshness of primaryFile
  let fileFreshness = null;
  let fileOutline = [];
  if (primaryFile) {
    const indexedRow = db
      .prepare("SELECT * FROM files WHERE path = ?")
      .get(primaryFile);
    const fullDiskPath = path.resolve(repoRoot, primaryFile);
    const existsOnDisk = fs.existsSync(fullDiskPath);
    const diskSha = existsOnDisk
      ? sha256Hex(fs.readFileSync(fullDiskPath))
      : null;
    fileFreshness = {
      filePath: primaryFile,
      lineCount: indexedRow?.line_count ?? null,
      bytes: indexedRow?.bytes ?? null,
      domain: indexedRow?.domain ?? null,
      indexedSha256: indexedRow?.sha256 ?? null,
      currentSha256: diskSha,
      fresh:
        Boolean(existsOnDisk) &&
        indexedRow?.sha256 !== undefined &&
        diskSha === indexedRow.sha256,
    };

    fileOutline = db
      .prepare(
        `SELECT name, kind, start_line, end_line, signature, community_id
         FROM symbols
         WHERE file_path = ? AND kind != 'file' AND is_utility = 0
         ORDER BY start_line ASC
         LIMIT 25`,
      )
      .all(primaryFile);
  }
  if (anchorTarget) {
    // A key can sit in another registry than the primary file
    // (ShaderSourceId.X lives in WebGPUShaderDefines.ts), so each row names its file.
    fileOutline = registryAnchors.map((s) => ({
      file_path: s.filePath,
      name: s.name,
      kind: s.kind,
      start_line: s.startLine,
      end_line: s.endLine,
      signature: s.signature,
      community_id: s.communityId,
    }));
  }

  const seams = querySeams(db, anchorTarget ?? primaryFile ?? target, {
    limit: 20,
  });
  const contracts = queryContracts(db, {
    filePath: primaryFile ?? target,
    limit: 15,
  });
  const ledger = queryLedger(
    db,
    !anchorTarget && primaryFile ? path.posix.basename(primaryFile) : target,
    {
      activeOnly: true,
      limit: 10,
    },
  );
  const spatial = querySpatialValidation(db, {
    forTarget: anchorTarget ?? primaryFile ?? target,
    limit: 6,
  });
  const testScripts = findMatchingTestScripts(repoRoot, [
    target,
    ...(primaryFile ? [primaryFile] : []),
  ]);

  return {
    target,
    // false when nothing in the index matches the target: every later section
    // is then inferred from the target's name alone, and the pack must say so.
    resolved: symbols.length > 0,
    registryAnchor: Boolean(anchorTarget),
    headSha:
      db.prepare("SELECT value FROM meta WHERE key = 'head_sha'").get()
        ?.value ?? "UNKNOWN",
    fileFreshness,
    symbols,
    fileOutline,
    seams,
    contracts,
    ledger,
    spatial: {
      minimalCover: spatial.minimalCover,
      gisAssets: spatial.gisAssets,
      fleetCoverageGaps: spatial.fleetCoverageGaps,
    },
    testScripts,
  };
}

/** Symbol kinds that are keys of a shared registry rather than code in a file. */
const REGISTRY_ANCHOR_KINDS = new Set([
  "feature-renderer-key",
  "shader-define-lo",
  "shader-define-hi",
  "shader-define-ext",
  "shader-source-id",
]);

/**
 * Format an Impact Pack into concise, citation-verified Markdown (~1.5K-2.5K tokens).
 *
 * @param {ReturnType<typeof buildImpactPack>} pack
 * @returns {string}
 */
export function formatImpactPackMarkdown(pack) {
  const lines = [];
  lines.push(
    `# Impact Pack: \`${pack.target}\` (Indexed HEAD \`${pack.headSha.slice(0, 10)}\`)`,
  );
  lines.push("");
  if (pack.resolved === false) {
    lines.push(
      `- **TARGET NOT FOUND** in the index built at HEAD \`${pack.headSha.slice(0, 10)}\`: no file, symbol or registry key matches \`${pack.target}\`. The sections below are inferred from the target's name only and are not evidence about it. Check the spelling, or run \`npm run context-refresh\` if the target is new.`,
    );
    lines.push("");
  }

  if (pack.fileFreshness) {
    const f = pack.fileFreshness;
    const statusBadge = f.fresh
      ? "FRESH (disk SHA-256 matches index)"
      : "STALE_INDEX_WARNING (working-tree file modified since index build; re-verify line numbers)";
    lines.push(
      `- **Primary File**: \`${f.filePath}\` (${f.lineCount ?? "?"} lines, domain \`${f.domain ?? "?"}\`) — **${statusBadge}**`,
    );
    lines.push("");
  }

  if (pack.fileOutline.length > 0) {
    lines.push("## 1. Symbol & Shader Outline (Line-Anchored)");
    lines.push("");
    for (const s of pack.fileOutline.slice(0, 18)) {
      const comm =
        s.community_id !== null && s.community_id !== undefined
          ? ` [cluster ${s.community_id}]`
          : "";
      const where = s.file_path ? `${s.file_path}:` : "";
      lines.push(
        `- \`${where}L${s.start_line}-L${s.end_line}\` (${s.kind}) \`${s.name}\`${comm}${s.signature ? ` — \`${s.signature}\`` : ""}`,
      );
    }
    lines.push("");
  } else if (pack.symbols.length > 0) {
    lines.push("## 1. Matching Symbols");
    lines.push("");
    for (const s of pack.symbols.slice(0, 10)) {
      lines.push(
        `- \`${s.filePath}:L${s.startLine}-L${s.endLine}\` (${s.kind}) \`${s.name}\``,
      );
    }
    lines.push("");
  }

  lines.push("## 2. Cross-Boundary Cesium Seams");
  lines.push("");
  if (
    pack.seams.seamEdges.length === 0 &&
    pack.seams.counterpartEdges.length === 0
  ) {
    lines.push(
      "- None detected on `FeatureRendererKey`, `ShaderDefine*`, `ShaderSourceId`, or `GLSL<->WGSL` stems.",
    );
  } else {
    for (const d of pack.seams.defineDetails.slice(0, 8)) {
      lines.push(
        `- **Define Registry**: \`${d.file_path}:L${d.start_line}\` — \`${d.signature}\``,
      );
    }
    for (const e of pack.seams.seamEdges.slice(0, 10)) {
      lines.push(
        `- \`[${e.relation}]\` \`${e.src_id}\` -> \`${e.dst_id}\`${e.file_path ? ` (\`${e.file_path}:L${e.line}\`)` : ""}`,
      );
    }
    for (const c of pack.seams.counterpartEdges.slice(0, 6)) {
      lines.push(
        `- \`[counterpart:${c.relation}]\` \`${c.src_id}\` -> \`${c.dst_id}\`${c.file_path ? ` (\`${c.file_path}:L${c.line}\`)` : ""}`,
      );
    }
  }
  if (pack.seams.callAndImportEdges.length > 0) {
    lines.push("");
    lines.push("### Structural Imports / Calls (Utility-Filtered)");
    lines.push("");
    for (const e of pack.seams.callAndImportEdges.slice(0, 10)) {
      lines.push(
        `- \`[${e.relation}]\` \`${e.src_id}\` -> \`${e.dst_id}\`${e.line ? ` (L${e.line})` : ""}`,
      );
    }
  }
  lines.push("");

  lines.push("## 3. Coordinate, RTE Precision & Bind-Group Contracts");
  lines.push("");
  if (pack.contracts.summary.length === 0) {
    lines.push("- No RTE/depth/bind-group contracts recorded on this target.");
  } else {
    for (const s of pack.contracts.summary) {
      lines.push(
        `- **${s.severity.toUpperCase()}** \`${s.category}/${s.contract_type}\`: ${s.count} site(s)`,
      );
    }
    const notable = pack.contracts.items.filter(
      (i) => i.severity !== "positive",
    );
    for (const item of notable.slice(0, 8)) {
      lines.push(
        `  - \`${item.file_path}:L${item.line}\` [${item.severity.toUpperCase()}] ${item.detail}`,
      );
    }
  }
  lines.push("");

  lines.push(
    "## 4. Active Governance, Rulings & Queue State (Charter §0.4 Order)",
  );
  lines.push("");
  if (pack.ledger.length === 0) {
    lines.push(
      "- No active rulings, open queue rows, or blueprint hotspots cite this target.",
    );
  } else {
    for (const l of pack.ledger.slice(0, 8)) {
      const brief =
        l.summary.length > 220 ? `${l.summary.slice(0, 219)}…` : l.summary;
      lines.push(
        `- **[Rank ${l.authorityRank} | ${l.status}]** \`${l.id}\` (\`${l.sourceFile}:L${l.startLine}\`): ${brief}`,
      );
    }
  }
  lines.push("");

  lines.push("## 5. Spatial & GIS Validation Matrix (Probe Kit)");
  lines.push("");
  const cover = pack.spatial.minimalCover;
  if (cover && cover.selectedRigs.length > 0) {
    lines.push(
      `- **Minimal Rig Set-Cover** (${cover.selectedRigs.length} rig(s) covering \`${cover.coveredTargets.join(", ")}\`):`,
    );
    for (const r of cover.selectedRigs) {
      const coord =
        r.lon !== null && r.lat !== null
          ? `lon=${r.lon.toFixed(1)}, lat=${r.lat.toFixed(1)}, h=${Math.round(r.heightM ?? 0)}m`
          : "procedural/harness pose";
      lines.push(
        `  - \`${r.id}\` (\`${r.filePath}\`, renderers: \`${r.renderers.join("+")}\`, ${coord}) -> covers \`${r.newlyCovered.join(", ")}\``,
      );
    }
    if (cover.uncoveredTargets.length > 0) {
      lines.push(
        `- **Uncovered Regimes**: \`${cover.uncoveredTargets.join(", ")}\``,
      );
    }
  }
  for (const g of pack.spatial.gisAssets.slice(0, 4)) {
    lines.push(
      `- **GIS Datum Asset** \`${g.id}\` (\`${g.crsFrom}\` -> \`${g.crsTo}\`; seam: ${g.seamRule})`,
    );
  }
  if (pack.testScripts.length > 0) {
    lines.push("- **Candidate `npm run` Gates (`R-2026-08-29-1`)**:");
    for (const ts of pack.testScripts) {
      lines.push(`  - \`npm run ${ts.script}\` (\`${ts.command}\`)`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Generate a role-tailored (`worker | reviewer | orchestrator`) `HEAD`-stamped context capsule
 * so worker clones never pay the ~210K-token cold-start governance read tax.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} repoRoot
 * @param {{
 *   targets: string[],
 *   role?: "worker" | "reviewer" | "orchestrator",
 *   outPath?: string
 * }} options
 */
export function generateContextCapsule(db, repoRoot, options) {
  const role = options.role ?? "worker";
  const targets = options.targets ?? [];
  const headSha = readGitHeadSha(repoRoot);
  const indexedSha =
    db.prepare("SELECT value FROM meta WHERE key = 'head_sha'").get()?.value ??
    headSha;

  const lines = [];
  lines.push(`# Context Capsule (${role.toUpperCase()})`);
  lines.push("");
  lines.push(`- **Generated At**: \`${new Date().toISOString()}\``);
  lines.push(`- **Checkout HEAD**: \`${headSha}\``);
  lines.push(`- **Spine Index HEAD**: \`${indexedSha}\``);
  lines.push("");
  lines.push("## Non-Negotiable Binding Invariants (`AGENTS.md` Part 1)");
  lines.push("");
  if (role === "worker") {
    lines.push(
      "- **64-bit RTE**: Never single `vec3<f32>` world pos; always `mvpRelativeToEye * translateRelativeToEye(posHigh, posLow, camHigh, camLow)`; `CameraUniforms.previousViewProjection` stays at struct tail.",
    );
    lines.push(
      "- **Shader Defines**: Add-only 3-word registry (`ShaderDefine`, `Hi`, `Ext`); bit 31 reserved; cloud Ext <= bit 20; pass all 3 words to `preprocess`/`getOrCreate`.",
    );
    lines.push(
      "- **Comments & Pragmas**: No batch/campaign/row/date markers in `packages/{engine,widgets}/Source`; wrap non-error logs in `//>>includeStart('debug', pragmas.debug);`.",
    );
    lines.push(
      "- **Worker Discipline**: Zero git writes; never rewrite files > 100 lines; `node` commands first; scratch temp via `Tools/lib/lane-tmp.mjs` (`withLaneTmp`); wire any new `.spec.mjs` to a `test-*` script in `package.json`.",
    );
  } else if (role === "reviewer") {
    lines.push(
      "- **Independent Verification (`audit-cesium-certification`)**: Re-open every cited `file:line` at `HEAD`; never combine reviewer and repair-author roles in one pass (Charter §4.6).",
    );
    lines.push(
      "- **Measured Reds (`Charter §1.1`)**: Never de-score, demote, or quarantine a measured red; verify inertness mutants bite on actual runtime behavior.",
    );
    lines.push(
      "- **Precedence (`Charter §0.4`)**: Maintainer rulings (`MAINTAINER_RULINGS_*.md`, newest wins) > campaign queue rows > `CAMPAIGN_STATE.md` > Blueprint > `DEFERRED_WORK.md`.",
    );
  } else {
    lines.push(
      "- **Landing Seat Discipline**: Worker clones hand over patches (`_lane-out/<name>.patch`); check `CAMPAIGN_STATE.md` and GitHub quiet hours (`07:00-19:00 ET` Mon-Fri) before any remote push.",
    );
  }
  lines.push("");

  for (const target of targets) {
    const pack = buildImpactPack(db, repoRoot, target);
    lines.push("---");
    lines.push("");
    lines.push(formatImpactPackMarkdown(pack));
  }

  const markdown = lines.join("\n");
  if (options.outPath) {
    const absOut = path.isAbsolute(options.outPath)
      ? options.outPath
      : path.resolve(repoRoot, options.outPath);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    fs.writeFileSync(absOut, markdown, "utf8");
  }

  return {
    role,
    headSha,
    targets,
    charCount: markdown.length,
    approxTokens: Math.ceil(markdown.length / 4),
    markdown,
  };
}
