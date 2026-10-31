// steps.mjs - the individual provisioning and readiness steps of Tools/provision-worker-clone.mjs.
// @purpose Implement each provisioning step (governance copy, local main ref, node_modules and WASM inputs, context-spine seed, Codex MCP registration, capsule, readiness checks) over a shared result context, so the entry file only orders them.
// @status ACTIVE

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PROVISION, ROUTED_AUTHORITIES } from "./authorities.mjs";

/**
 * The result a provisioning run accumulates: `fail` records a problem (the run
 * exits 1), `notes` and `provisioned` feed the report.
 *
 * @returns {{ problems: string[], provisioned: Array<{ path: string, objectId: string, why: string }>, notes: string[], fail: (message: string) => void }}
 */
export function createProvisionContext() {
  const problems = [];
  return {
    problems,
    provisioned: [],
    notes: [],
    fail(message) {
      problems.push(message);
    },
  };
}

function gitObjectId(file) {
  // git hash-object, i.e. SHA-1 over the blob — an identity stamp for the
  // provisioned copy, not a cryptographic digest. Named for what it is.
  return execFileSync("git", ["hash-object", "--", file], {
    encoding: "utf8",
  }).trim();
}

function reportNodeModules(ctx, workspaceModules) {
  ctx.notes.push(...workspaceModules.reports);
  for (const relativePath of workspaceModules.missingWorkspaceNodeModules) {
    ctx.fail(
      `workspace package node_modules missing from clone: ${relativePath}`,
    );
  }
}

/** --verify-only: report which node_modules junctions are missing, create nothing. */
export function verifyNodeModules(
  ctx,
  { sourceRepo, clonePath, provisionNodeModulesJunctions },
) {
  reportNodeModules(
    ctx,
    provisionNodeModulesJunctions({
      sourceRepo,
      clonePath,
      verifyOnly: true,
    }),
  );
}

/** Copy the PROVISION governance files into the clone and stamp each with its object id. */
export function copyGovernance(
  ctx,
  { sourceRepo, clonePath, restoreUnchangedProvisionedFile },
) {
  for (const entry of PROVISION) {
    const from = path.join(sourceRepo, entry.src);
    const to = path.join(clonePath, entry.dest);
    if (!fs.existsSync(from)) {
      if (entry.required) {
        ctx.fail(
          `source missing, cannot provision: ${entry.src} (${entry.why})`,
        );
      }
      continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    const restore = restoreUnchangedProvisionedFile({
      clonePath,
      dest: entry.dest,
    });
    ctx.notes.push(restore.note);
    ctx.provisioned.push({
      path: entry.dest,
      // The destination may now hold checkout bytes; stamp the seat's input.
      objectId: gitObjectId(from),
      why: entry.why,
    });
  }
}

/**
 * `git clone --branch <b>` leaves no local main, so `main...HEAD` — the diff the
 * worker owes in its handoff report — cannot resolve. Create it from the remote.
 */
export function ensureLocalMainRef(ctx, clonePath) {
  try {
    execFileSync("git", ["-C", clonePath, "rev-parse", "--verify", "main"], {
      stdio: "ignore",
    });
    ctx.notes.push("local main ref already present");
  } catch {
    try {
      execFileSync("git", ["-C", clonePath, "branch", "main", "origin/main"], {
        stdio: "ignore",
      });
      ctx.notes.push("created local main ref from origin/main");
    } catch (error) {
      ctx.fail(`could not create a local main ref: ${error?.message ?? error}`);
    }
  }
}

/**
 * A fresh clone has no `node_modules`, so every npm-script gate a brief might
 * ask for — `build-ts`, `build-docs`, the C16 tools' own deps — fails before
 * it reaches the code under test. A worker then either reports an honest
 * non-PASS (the good outcome, and what happened) or invents a workaround.
 * Junction the source tree's modules in: same filesystem, no copy, and Node's
 * ESM resolver walks it exactly as it would a real directory. Not fatal if it
 * fails — plenty of briefs need no npm script — but the note tells the
 * orchestrator which kind of dispatch this clone can carry.
 */
export function linkNodeModules(
  ctx,
  { sourceRepo, clonePath, provisionNodeModulesJunctions },
) {
  reportNodeModules(
    ctx,
    provisionNodeModulesJunctions({ sourceRepo, clonePath }),
  );
}

/**
 * The ThirdParty WASM binaries (splats, Draco, zip) are UNTRACKED build
 * inputs that `gulp prepare` copies from node_modules into
 * packages/engine/Source/ThirdParty. A fresh clone plus build without this
 * step produces an artifact whose splat, Draco, and zip paths 404 at
 * runtime — the stall looks like a product readiness defect and costs a
 * diagnosis to attribute. Copy them here so a provisioned clone can never
 * build that trap.
 */
export function copyThirdPartyWasm(ctx, { sourceRepo, clonePath }) {
  const thirdPartyDir = path.join(
    clonePath,
    "packages",
    "engine",
    "Source",
    "ThirdParty",
  );
  const wasmSources = [
    ["@cesium/wasm-splats", "wasm_splats_bg.wasm"],
    ["@cesium/wasm-splats", "wasm_splats.js"],
  ];
  let wasmCopied = 0;
  for (const [pkg, file] of wasmSources) {
    const src = path.resolve(sourceRepo, "node_modules", pkg, file);
    const dest = path.join(thirdPartyDir, file);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      try {
        fs.copyFileSync(src, dest);
        wasmCopied += 1;
      } catch {
        ctx.notes.push(`could not copy ${file} into ThirdParty`);
      }
    }
  }
  const requiredThirdParty = ["wasm_splats_bg.wasm", "draco_decoder.wasm"];
  const missingThirdParty = requiredThirdParty.filter(
    (f) => !fs.existsSync(path.join(thirdPartyDir, f)),
  );
  if (wasmCopied > 0) {
    ctx.notes.push(
      `copied ${wasmCopied} ThirdParty WASM file(s) from node_modules`,
    );
  }
  if (missingThirdParty.length > 0) {
    ctx.notes.push(
      `ThirdParty still missing ${missingThirdParty.join(", ")} — run \`npx gulp prepare\` in the clone before any build, or its artifact will 404 splats/Draco at runtime`,
    );
  }
}

/** Write _review/PROVISION.objectid, the identity stamps of the copied governance files. */
export function writeProvisionManifest(ctx, clonePath) {
  if (ctx.provisioned.length === 0) {
    return;
  }
  const manifest = ctx.provisioned
    .map((p) => `${p.objectId}  ${p.path}`)
    .join("\n");
  fs.mkdirSync(path.join(clonePath, "_review"), { recursive: true });
  fs.writeFileSync(
    path.join(clonePath, "_review", "PROVISION.objectid"),
    `${manifest}\n`,
  );
}

/**
 * Seed the gitignored context-spine DB and .mcp.json (Tools/context-spine/seed-clone.mjs:
 * nothing is written in the source, and no pointer into the source tree is left).
 * `seedSpineDb` / `refreshSpine` carry --no-spine-seed / --no-spine-refresh.
 */
export async function seedContextSpine(
  ctx,
  { sourceRepo, clonePath, seedSpineDb, refreshSpine },
) {
  const { seedCloneContextSpine } =
    await import("../context-spine/seed-clone.mjs");
  ctx.notes.push(
    ...seedCloneContextSpine({
      sourceRepo,
      clonePath,
      seedDb: seedSpineDb,
      refreshSpine,
    }),
  );
}

/** --codex-mcp / --codex-unmcp: register or remove the context-spine MCP server in the Codex config. */
export async function applyCodexMcp(
  ctx,
  { args, codexMcp, codexUnmcp, resolveCodexConfigPath },
) {
  try {
    const codexConfigPath = resolveCodexConfigPath({ args });
    const { codexMcpAdd, codexMcpRemove } =
      await import("../context-spine/codex-mcp-config.mjs");
    if (codexMcp) {
      const r = codexMcpAdd({ configPath: codexConfigPath, args });
      ctx.notes.push(
        r.changed
          ? `codex mcp: registered ${r.header}`
          : `codex mcp: already present (${r.header})`,
      );
    }
    if (codexUnmcp) {
      const r = codexMcpRemove({ configPath: codexConfigPath, args });
      ctx.notes.push(
        r.changed
          ? `codex mcp: removed ${r.header}`
          : `codex mcp: not present (${r.header})`,
      );
    }
  } catch (error) {
    ctx.fail(`codex mcp update failed: ${error?.message ?? error}`);
  }
}

/** --capsule: write _review/context-capsule.md from the clone's (else the source's) spine DB. */
export async function generateCapsule(
  ctx,
  { sourceRepo, clonePath, capsuleTargets, capsuleRole },
) {
  try {
    const { openOrBuildSpine, generateContextCapsule } =
      await import("../context-spine/query-engine.mjs");
    const { capsuleSpineRoot } =
      await import("../context-spine/seed-clone.mjs");
    const spineRoot = capsuleSpineRoot({ sourceRepo, clonePath });
    if (!spineRoot) {
      throw new Error(
        "no context-spine DB in the clone or the source; run npm run context-build in the source first",
      );
    }
    // autoBuild false: a capsule never starts a full build in the source tree.
    const spineDb = await openOrBuildSpine(spineRoot, { autoBuild: false });
    try {
      const capsuleOut = path.join(clonePath, "_review", "context-capsule.md");
      const cap = generateContextCapsule(spineDb, clonePath, {
        targets: capsuleTargets,
        role: capsuleRole,
        outPath: capsuleOut,
      });
      ctx.notes.push(
        `generated _review/context-capsule.md (~${cap.approxTokens} tokens for ${capsuleTargets.join(", ")})`,
      );
    } finally {
      spineDb.close();
    }
  } catch (error) {
    ctx.fail(`context capsule generation failed: ${error?.message ?? error}`);
  }
}

/** The readiness assertion: every routed authority reachable, and a local main ref. */
export function verifyReadiness(ctx, clonePath) {
  for (const rel of ROUTED_AUTHORITIES) {
    if (!fs.existsSync(path.join(clonePath, rel))) {
      ctx.fail(`routed authority unreachable in clone: ${rel}`);
    }
  }

  try {
    execFileSync("git", ["-C", clonePath, "rev-parse", "--verify", "main"], {
      stdio: "ignore",
    });
  } catch {
    ctx.fail(
      "no local main ref — the worker's `git diff main...HEAD` cannot resolve",
    );
  }
}
