// seed-clone.mjs — Seed a worker clone with the source repository's context-spine DB and .mcp.json.
// @purpose Copy the source repository's gitignored `.cache/context-spine/cesium-context.sqlite` and `.mcp.json` into a worker clone for Tools/provision-worker-clone.mjs, then bring a seeded DB that is behind the clone's HEAD up to it with the clone's own incremental build, writing nothing in the source and pointing the clone at no executable outside it.
// @status ACTIVE

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SPINE_DB_REL_PATH = ".cache/context-spine/cesium-context.sqlite";

// Bounds the clone's incremental build so a wedged child cannot hang provisioning; the
// resulting ETIMEDOUT throw becomes a WARNING note in seedCloneContextSpine.
export const REFRESH_TIMEOUT_MS = 180000;

/**
 * The `meta.head_sha` a spine DB was last built at.
 *
 * @param {string} dbFile
 * @returns {string | null} null when the DB has no head_sha or cannot be read
 */
export function readDbHeadSha(dbFile) {
  let db;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'head_sha'")
      .get();
    return typeof row?.value === "string" && row.value ? row.value : null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

/**
 * @param {string} clonePath
 * @returns {string | null} the clone's `git rev-parse HEAD`, or null
 */
export function readCloneHead(clonePath) {
  const res = spawnSync("git", ["-C", clonePath, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  const sha = res.status === 0 ? res.stdout.trim() : "";
  return sha || null;
}

/**
 * Run the clone's OWN `Tools/query-context.mjs build --incremental` (never a
 * script from the source tree) with cwd = the clone. Throws on failure.
 *
 * @param {string} clonePath
 * @param {number} [timeoutMs]
 * @param {typeof spawnSync} [spawn] replaces the child spawn (specs)
 */
export function runIncrementalBuildInClone(
  clonePath,
  timeoutMs = REFRESH_TIMEOUT_MS,
  spawn = spawnSync,
) {
  const script = path.resolve(clonePath, "Tools", "query-context.mjs");
  const run = spawn(
    process.execPath,
    [script, "build", "--incremental", "--repo", clonePath],
    { cwd: clonePath, encoding: "utf8", timeout: timeoutMs },
  );
  if (run.error || run.status !== 0) {
    const detail =
      run.error?.message ??
      `exit ${run.status}: ${String(run.stderr || run.stdout)
        .trim()
        .slice(-300)}`;
    throw new Error(detail);
  }
}

/**
 * Seed `<clonePath>` from `<sourceRepo>`.
 *
 * The source is read-only here: a DB with a `-wal` sidecar is mid-write (a
 * build is running, or one died), so it is NOT copied rather than checkpointed
 * in place; the clone keeps whatever it had. No pointer to the source's Python
 * venv is written: a worker that wants Graphify edges reads them from the
 * seeded DB, and a clone never executes a binary that lives in another tree.
 *
 * A seeded DB is only as current as the source's last build, so when the
 * clone has a DB whose `meta.head_sha` differs from the clone's HEAD the clone's
 * own incremental build brings it up (`refreshSpine`, on by default). A failed
 * refresh is a `WARNING:` note, never an abort.
 *
 * @param {{ sourceRepo: string, clonePath: string, seedDb?: boolean,
 *   refreshSpine?: boolean, fsOps?: typeof fs,
 *   readDbHeadSha?: (dbFile: string) => string | null,
 *   readCloneHead?: (clonePath: string) => string | null,
 *   runIncrementalBuild?: (clonePath: string) => void }} args the three
 *   function options replace the head reads and the build (specs)
 * @returns {string[]} notes for the provisioning report
 */
export function seedCloneContextSpine({
  sourceRepo,
  clonePath,
  seedDb = true,
  refreshSpine = true,
  fsOps = fs,
  readDbHeadSha: readDbHead = readDbHeadSha,
  readCloneHead: readCloneHeadSha = readCloneHead,
  runIncrementalBuild,
}) {
  const notes = [];
  const srcSpineDb = path.resolve(sourceRepo, SPINE_DB_REL_PATH);
  const dstSpineDb = path.resolve(clonePath, SPINE_DB_REL_PATH);
  if (seedDb && fsOps.existsSync(srcSpineDb) && srcSpineDb !== dstSpineDb) {
    if (fsOps.existsSync(`${srcSpineDb}-wal`)) {
      notes.push(
        "skipped context-spine DB seed: the source DB has a -wal sidecar (a build is writing it, or one died); run npm run context-refresh in the source, then re-provision",
      );
    } else {
      try {
        const shouldCopy =
          !fsOps.existsSync(dstSpineDb) ||
          fsOps.statSync(srcSpineDb).mtimeMs >
            fsOps.statSync(dstSpineDb).mtimeMs;
        if (shouldCopy) {
          fsOps.mkdirSync(path.dirname(dstSpineDb), { recursive: true });
          fsOps.copyFileSync(srcSpineDb, dstSpineDb);
          notes.push(
            "seeded .cache/context-spine/cesium-context.sqlite from source repo",
          );
        }
      } catch (error) {
        notes.push(
          `skipped context-spine DB seed (${error?.message ?? error})`,
        );
      }
    }
  }

  if (refreshSpine && fsOps.existsSync(dstSpineDb)) {
    notes.push(
      ...refreshSeededSpine({
        clonePath,
        dstSpineDb,
        fsOps,
        readDbHead,
        readCloneHeadSha,
        runIncrementalBuild,
      }),
    );
  }

  const srcMcpJson = path.resolve(sourceRepo, ".mcp.json");
  const dstMcpJson = path.resolve(clonePath, ".mcp.json");
  if (fsOps.existsSync(srcMcpJson) && !fsOps.existsSync(dstMcpJson)) {
    try {
      fsOps.copyFileSync(srcMcpJson, dstMcpJson);
      notes.push("seeded gitignored .mcp.json from source repo");
    } catch (error) {
      notes.push(`skipped .mcp.json seed (${error?.message ?? error})`);
    }
  }
  return notes;
}

function refreshSeededSpine({
  clonePath,
  dstSpineDb,
  fsOps,
  readDbHead,
  readCloneHeadSha,
  runIncrementalBuild,
}) {
  const dbSha = readDbHead(dstSpineDb);
  const headSha = readCloneHeadSha(clonePath);
  const short = (sha) => (sha ? sha.slice(0, 10) : "none");
  if (!headSha) {
    return [
      `WARNING: context-spine DB not refreshed: cannot read the clone's HEAD (DB at ${short(dbSha)}); run npm run context-refresh in the clone`,
    ];
  }
  if (dbSha === headSha) {
    return [`context-spine DB is current at ${short(headSha)}; no refresh run`];
  }
  if (
    !runIncrementalBuild &&
    !fsOps.existsSync(path.resolve(clonePath, "Tools", "query-context.mjs"))
  ) {
    return [
      `context-spine refresh skipped: the clone has no Tools/query-context.mjs (DB at ${short(dbSha)}, HEAD ${short(headSha)})`,
    ];
  }
  const startedAt = Date.now();
  try {
    (runIncrementalBuild ?? runIncrementalBuildInClone)(clonePath);
  } catch (error) {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    return [
      `WARNING: context-spine refresh failed after ${seconds}s (${error?.message ?? error}); the seeded pack is stale: DB at ${short(dbSha)}, clone HEAD ${short(headSha)}`,
    ];
  }
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  return [
    `refreshed context-spine DB incrementally from ${short(dbSha)} to clone HEAD ${short(headSha)} in ${seconds}s`,
  ];
}

/**
 * The repository whose spine DB a capsule is generated from: the clone's own
 * seeded DB when present, else the source's. Never one that has to be built:
 * a capsule must not start a full build in the source tree.
 *
 * @param {{ sourceRepo: string, clonePath: string, fsOps?: typeof fs }} args
 * @returns {string | null} the repo root, or null when neither has a DB
 */
export function capsuleSpineRoot({ sourceRepo, clonePath, fsOps = fs }) {
  if (fsOps.existsSync(path.resolve(clonePath, SPINE_DB_REL_PATH))) {
    return clonePath;
  }
  if (fsOps.existsSync(path.resolve(sourceRepo, SPINE_DB_REL_PATH))) {
    return sourceRepo;
  }
  return null;
}
