// seed-clone.mjs — Seed a worker clone with the source repository's context-spine DB and .mcp.json.
// @purpose Copy the source repository's gitignored `.cache/context-spine/cesium-context.sqlite` and `.mcp.json` into a worker clone for Tools/provision-worker-clone.mjs, writing nothing in the source and pointing the clone at no executable outside it.
// @status ACTIVE

import fs from "node:fs";
import path from "node:path";

export const SPINE_DB_REL_PATH = ".cache/context-spine/cesium-context.sqlite";

/**
 * Seed `<clonePath>` from `<sourceRepo>`.
 *
 * The source is read-only here: a DB with a `-wal` sidecar is mid-write (a
 * build is running, or one died), so it is NOT copied rather than checkpointed
 * in place; the clone keeps whatever it had. No pointer to the source's Python
 * venv is written: a worker that wants Graphify edges reads them from the
 * seeded DB, and a clone never executes a binary that lives in another tree.
 *
 * @param {{ sourceRepo: string, clonePath: string, seedDb?: boolean,
 *   fsOps?: typeof fs }} args
 * @returns {string[]} notes for the provisioning report
 */
export function seedCloneContextSpine({
  sourceRepo,
  clonePath,
  seedDb = true,
  fsOps = fs,
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
