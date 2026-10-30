// graphify-bridge.mjs — Safe --code-only Graphify AST/Leiden bridge into the SQLite context spine.
// @purpose Safely invoke `graphify extract --code-only` into gitignored `.cache/` and merge its tree-sitter call edges and Leiden communities into SQLite without touching governance files or git hooks.
// @status ACTIVE

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CESIUM_UTILITY_NAMES } from "./extract-code-seams.mjs";
import { toPosixRel } from "./schema.mjs";

const IMPORTABLE_RELATIONS = new Set([
  "calls",
  "indirect_call",
  "inherits",
  "implements",
  "dynamic_import",
  "re_exports",
]);

/**
 * Parse a Graphify `source_location` field (`"L106"`, `"L106-L140"`, or `106`) into a 1-based line number.
 *
 * @param {unknown} rawLoc
 * @returns {number | null}
 */
function parseGraphifyLine(rawLoc) {
  if (typeof rawLoc === "number" && Number.isFinite(rawLoc)) {
    return rawLoc;
  }
  if (typeof rawLoc === "string") {
    const m = rawLoc.match(/L?(\d+)/i);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Normalize a Graphify `source_file` path to a repository-relative POSIX path.
 *
 * @param {string} repoRoot
 * @param {string | undefined} rawSourceFile
 * @param {string} [scanPrefix]
 * @param {Set<string>} knownFilePaths
 * @returns {string | null}
 */
function resolveGraphifyFile(
  repoRoot,
  rawSourceFile,
  scanPrefix,
  knownFilePaths,
) {
  if (!rawSourceFile || typeof rawSourceFile !== "string") return null;
  const posixRaw = toPosixRel(repoRoot, rawSourceFile);
  if (knownFilePaths.has(posixRaw)) return posixRaw;
  if (scanPrefix) {
    const prefixed = path.posix.join(
      scanPrefix.replace(/\\/g, "/").replace(/\/+$/, ""),
      posixRaw,
    );
    if (knownFilePaths.has(prefixed)) return prefixed;
  }
  const enginePrefixed = path.posix.join("packages/engine/Source", posixRaw);
  if (knownFilePaths.has(enginePrefixed)) return enginePrefixed;
  return posixRaw;
}

/**
 * Import a Graphify `graph.json` (NetworkX node-link format) into the SQLite context spine.
 * Preserves all Cesium WGSL/GLSL/seam nodes while enriching JS/TS symbols with
 * Leiden `community_id` clusters and tree-sitter `calls` / `inherits` edges.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} graphJsonPath
 * @param {string} repoRoot
 * @param {{ scanPrefix?: string, skipUtilityTargets?: boolean }} [options]
 */
export function importGraphifyJson(db, graphJsonPath, repoRoot, options = {}) {
  const skipUtilityTargets = options.skipUtilityTargets !== false;
  const raw = JSON.parse(fs.readFileSync(graphJsonPath, "utf8"));
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const rawEdges = Array.isArray(raw.links)
    ? raw.links
    : Array.isArray(raw.edges)
      ? raw.edges
      : [];

  const fileRows = db.prepare("SELECT path FROM files").all();
  const knownFiles = new Set(fileRows.map((r) => r.path));

  const symRows = db
    .prepare("SELECT id, name, file_path, kind FROM symbols")
    .all();
  const symByFileAndName = new Map();
  for (const s of symRows) {
    const key = `${s.file_path}::${s.name}`;
    if (!symByFileAndName.has(key)) {
      symByFileAndName.set(key, s.id);
    }
  }

  const graphifyIdToSpineId = new Map();
  const nodeMetaById = new Map();
  const communitiesUpdated = [];

  for (const node of nodes) {
    if (!node || typeof node.id !== "string") continue;
    const cleanName = String(node.label ?? node.name ?? node.id)
      .replace(/\(\)$/, "")
      .trim();
    const relFile = resolveGraphifyFile(
      repoRoot,
      node.source_file,
      options.scanPrefix,
      knownFiles,
    );
    const line = parseGraphifyLine(node.source_location);

    let spineId = null;
    if (relFile) {
      spineId =
        symByFileAndName.get(`${relFile}::${cleanName}`) ??
        (cleanName === path.posix.basename(relFile) ? `file:${relFile}` : null);
    }
    if (!spineId) {
      spineId = relFile ? `${relFile}::${cleanName}` : `graphify:${node.id}`;
    }

    graphifyIdToSpineId.set(node.id, spineId);
    nodeMetaById.set(node.id, {
      spineId,
      cleanName,
      relFile,
      line,
      community:
        typeof node.community === "number" && Number.isFinite(node.community)
          ? node.community
          : null,
    });

    if (
      typeof node.community === "number" &&
      Number.isFinite(node.community) &&
      relFile
    ) {
      communitiesUpdated.push({
        community: node.community,
        filePath: relFile,
        name: cleanName,
        spineId,
      });
    }
  }

  const updateCommunityById = db.prepare(
    "UPDATE symbols SET community_id = ? WHERE id = ?",
  );
  const updateCommunityByFileAndName = db.prepare(
    "UPDATE symbols SET community_id = ? WHERE file_path = ? AND name = ?",
  );
  const insertEdge = db.prepare(`
    INSERT OR IGNORE INTO edges(src_id, dst_id, relation, provenance, detail, file_path, line)
    VALUES (?, ?, ?, 'graphify-ast', ?, ?, ?)
  `);
  const setMeta = db.prepare(
    "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
  );

  let importedEdges = 0;
  let skippedUtilityEdges = 0;
  let updatedSymbolCommunities = 0;

  db.exec("BEGIN;");
  try {
    db.exec("DELETE FROM edges WHERE provenance = 'graphify-ast';");

    for (const item of communitiesUpdated) {
      const r1 = updateCommunityById.run(item.community, item.spineId);
      if (r1.changes > 0) {
        updatedSymbolCommunities += Number(r1.changes);
      } else {
        const r2 = updateCommunityByFileAndName.run(
          item.community,
          item.filePath,
          item.name,
        );
        updatedSymbolCommunities += Number(r2.changes);
      }
    }

    for (const edge of rawEdges) {
      const relation = String(edge.relation ?? "");
      if (!IMPORTABLE_RELATIONS.has(relation)) continue;

      const srcMeta = nodeMetaById.get(edge.source);
      const dstMeta = nodeMetaById.get(edge.target);
      if (!srcMeta || !dstMeta) continue;

      if (skipUtilityTargets && CESIUM_UTILITY_NAMES.has(dstMeta.cleanName)) {
        skippedUtilityEdges += 1;
        continue;
      }

      const edgeFile =
        resolveGraphifyFile(
          repoRoot,
          edge.source_file,
          options.scanPrefix,
          knownFiles,
        ) ?? srcMeta.relFile;
      const edgeLine =
        parseGraphifyLine(edge.source_location) ?? srcMeta.line ?? null;
      const detail = edge.confidence ? `confidence:${edge.confidence}` : null;

      const res = insertEdge.run(
        srcMeta.spineId,
        dstMeta.spineId,
        relation,
        detail,
        edgeFile,
        edgeLine,
      );
      importedEdges += Number(res.changes);
    }

    setMeta.run("graphify_imported_at", new Date().toISOString());
    setMeta.run("graphify_nodes", String(nodes.length));
    setMeta.run("graphify_imported_edges", String(importedEdges));
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }

  return {
    graphifyNodes: nodes.length,
    graphifyRawEdges: rawEdges.length,
    updatedSymbolCommunities,
    importedEdges,
    skippedUtilityEdges,
  };
}

/**
 * The pip requirement for the bootstrap install, pinned to one exact version.
 * The bootstrap downloads from the default Python package index, so it never
 * installs an unpinned (latest) release: the caller names the version it vetted.
 *
 * @param {unknown} version e.g. "0.4.2"
 * @returns {string} `graphifyy==<version>`
 */
export function graphifyPipRequirement(version) {
  const v = typeof version === "string" ? version.trim() : "";
  if (!/^\d+(?:\.\d+){1,3}$/.test(v)) {
    throw new Error(
      "refusing to install graphifyy without an exact version pin: pass --graphify-version <x.y.z> (the release you vetted); --bootstrap-graphify downloads it from the default Python package index",
    );
  }
  return `graphifyy==${v}`;
}

/**
 * Locate an existing `graphify` CLI binary in `.cache/context-spine/py-venv` or `PATH`.
 * Never mutates global Python packages; optionally creates an isolated venv inside
 * gitignored `.cache/context-spine/py-venv` when `bootstrapVenv === true`.
 *
 * @param {string} repoRoot
 * @param {{ bootstrapVenv?: boolean, graphifyVersion?: string, pathProbe?: boolean,
 *   spawnSyncImpl?: typeof spawnSync }} [options] `spawnSyncImpl` replaces the
 *   bootstrap's python/pip spawns (specs).
 *   `graphifyVersion` is required with `bootstrapVenv`; `pathProbe: false` skips the
 *   PATH lookup (specs, so a machine's own graphify cannot mask the bootstrap path).
 * @returns {string | null}
 */
export function resolveGraphifyBinary(repoRoot, options = {}) {
  if (
    typeof process.env.GRAPHIFY_BIN === "string" &&
    process.env.GRAPHIFY_BIN.trim() &&
    fs.existsSync(process.env.GRAPHIFY_BIN.trim())
  ) {
    return path.resolve(process.env.GRAPHIFY_BIN.trim());
  }

  const pointerPath = path.resolve(
    repoRoot,
    ".cache/context-spine/graphify-bin.txt",
  );
  if (fs.existsSync(pointerPath)) {
    try {
      const pointed = fs.readFileSync(pointerPath, "utf8").trim();
      if (pointed && fs.existsSync(pointed)) {
        return path.resolve(pointed);
      }
    } catch {
      // Ignore unreadable pointer file and continue discovery.
    }
  }

  const isWin = process.platform === "win32";
  const venvDir = path.resolve(repoRoot, ".cache/context-spine/py-venv");
  const venvBin = isWin
    ? path.join(venvDir, "Scripts", "graphify.exe")
    : path.join(venvDir, "bin", "graphify");

  if (fs.existsSync(venvBin)) return venvBin;

  if (options.pathProbe !== false) {
    const probe = spawnSync(isWin ? "where.exe" : "which", ["graphify"], {
      encoding: "utf8",
    });
    if (probe.status === 0 && probe.stdout.trim()) {
      return probe.stdout.trim().split(/\r?\n/)[0].trim();
    }
  }

  if (options.bootstrapVenv) {
    // Refuse before anything is created or spawned.
    const requirement = graphifyPipRequirement(options.graphifyVersion);
    const run = options.spawnSyncImpl ?? spawnSync;
    const tmpDir = path.resolve(repoRoot, ".cache/context-spine/tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const isolatedEnv = {
      ...process.env,
      TEMP: tmpDir,
      TMP: tmpDir,
      TMPDIR: tmpDir,
      PIP_CACHE_DIR: path.join(tmpDir, "pip-cache"),
      PYTHONIOENCODING: "utf-8",
    };
    try {
      const pyCmd = isWin ? "python" : "python3";
      const mk = run(pyCmd, ["-m", "venv", venvDir], {
        env: isolatedEnv,
        encoding: "utf8",
      });
      if (mk.status !== 0) {
        throw new Error(
          `Failed to create .cache/context-spine/py-venv: ${mk.stderr || mk.stdout}`,
        );
      }
      const pyBin = isWin
        ? path.join(venvDir, "Scripts", "python.exe")
        : path.join(venvDir, "bin", "python");
      const inst = run(
        pyBin,
        ["-m", "pip", "install", "--quiet", "--no-cache-dir", requirement],
        { env: isolatedEnv, encoding: "utf8", timeout: 180000 },
      );
      if (inst.status !== 0) {
        throw new Error(
          `Failed to install graphifyy in .cache/context-spine/py-venv: ${inst.stderr || inst.stdout}`,
        );
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    if (fs.existsSync(venvBin)) return venvBin;
  }

  return null;
}

/**
 * Safely run `graphify extract <target> --code-only` into gitignored `.cache/context-spine/graphify`
 * and import the resulting `graph.json` into `db`.
 *
 * Governance guard: never invokes `graphify * install` or `graphify hook`, so `CLAUDE.md`,
 * `AGENTS.md`, `GEMINI.md`, and `.git/hooks` are never touched.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{
 *   repoRoot: string,
 *   targetRelPath?: string,
 *   outDir?: string,
 *   bootstrapVenv?: boolean,
 *   graphifyVersion?: string
 * }} options
 */
export function runGraphifyExtractCodeOnly(db, options) {
  const {
    repoRoot,
    targetRelPath = "packages/engine/Source",
    bootstrapVenv = false,
    graphifyVersion,
  } = options;
  const outDir =
    options.outDir ?? path.resolve(repoRoot, ".cache/context-spine/graphify");

  const bin = resolveGraphifyBinary(repoRoot, {
    bootstrapVenv,
    graphifyVersion,
  });
  if (!bin) {
    return {
      executed: false,
      reason:
        "graphify binary not found in .cache/context-spine/py-venv or PATH (pass --bootstrap-graphify to install inside .cache/context-spine/py-venv)",
    };
  }

  const tmpDir = path.resolve(repoRoot, ".cache/context-spine/tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const absTarget = path.resolve(repoRoot, targetRelPath);
  let run;
  try {
    run = spawnSync(
      bin,
      ["extract", absTarget, "--code-only", "--out", outDir],
      {
        cwd: outDir,
        env: {
          ...process.env,
          TEMP: tmpDir,
          TMP: tmpDir,
          TMPDIR: tmpDir,
          PYTHONIOENCODING: "utf-8",
        },
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 300000,
      },
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  if (run.status !== 0) {
    throw new Error(
      `graphify extract --code-only failed (exit ${run.status}): ${run.stderr || run.stdout}`,
    );
  }

  const candidateA = path.join(outDir, "graphify-out", "graph.json");
  const candidateB = path.join(outDir, "graph.json");
  const graphJsonPath = fs.existsSync(candidateA) ? candidateA : candidateB;
  if (!fs.existsSync(graphJsonPath)) {
    throw new Error(`Expected graph.json not found under ${outDir}`);
  }

  const imported = importGraphifyJson(db, graphJsonPath, repoRoot, {
    scanPrefix: targetRelPath,
  });
  return {
    executed: true,
    graphJsonPath,
    ...imported,
  };
}
