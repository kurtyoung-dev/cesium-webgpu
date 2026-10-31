// run.mjs - the ordered flow of Tools/provision-worker-clone.mjs.
// @purpose Run the provisioner end to end for a parsed argv (usage and clone checks, Codex trust, node_modules, governance copy, spine seed, Codex MCP, capsule, readiness check, report) and return the process exit code, with the helpers that live in the entry file passed in.
// @status ACTIVE

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseProvisionArgs, renderUsage } from "./args.mjs";
import {
  applyCodexMcp,
  copyGovernance,
  copyThirdPartyWasm,
  createProvisionContext,
  ensureLocalMainRef,
  generateCapsule,
  linkNodeModules,
  seedContextSpine,
  verifyNodeModules,
  verifyReadiness,
  writeProvisionManifest,
} from "./steps.mjs";

/**
 * True when the module at `moduleUrl` is the script node was started with, so
 * the entry file can be imported (by a spec, or for its exports) without
 * provisioning anything.
 *
 * @param {string} moduleUrl `import.meta.url` of the entry file
 * @param {string | undefined} [argv1] defaults to `process.argv[1]`
 * @returns {boolean}
 */
export function isMainModule(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) {
    return false;
  }
  try {
    return (
      fs.realpathSync.native(argv1) ===
      fs.realpathSync.native(fileURLToPath(moduleUrl))
    );
  } catch {
    return false;
  }
}

// --- Codex trust (opt-in; R-2026-09-02-23 / DX-25) --------------------------
function applyCodexTrust(ctx, options, helpers) {
  const { args, clonePath, jsonMode, codexTrust, codexUntrust } = options;
  try {
    // F7 fix-round: resolveCodexConfigPath's own validation now throws for a
    // missing/flag-shaped --config value instead of silently resolving to the
    // real config — kept inside this try so that throw is caught the same way
    // a codexTrustAdd/Remove failure is, not left to crash the process uncaught.
    const codexConfigPath = helpers.resolveCodexConfigPath({ args });
    if (codexTrust) {
      const result = helpers.codexTrustAdd({
        configPath: codexConfigPath,
        clonePath,
        args,
      });
      const line = result.changed
        ? `codex trust: added ${result.headerLine}`
        : `codex trust: already present, no change (${result.headerLine})`;
      ctx.notes.push(line);
      // F1 fix-round (Hirluin): --json promises a single JSON document on
      // stdout. Writing this line unconditionally put a bare string ahead of
      // that document, so JSON.parse(stdout) failed whenever --json was
      // combined with --codex-trust/--codex-untrust. The same string already
      // lives in the document's notes, so the human-readable echo is
      // redundant (not just wrong) in JSON mode.
      if (!jsonMode) {
        process.stdout.write(`${line}\n`);
      }
    }
    if (codexUntrust) {
      const result = helpers.codexTrustRemove({
        configPath: codexConfigPath,
        clonePath,
        args,
      });
      const line = result.changed
        ? `codex trust: removed ${result.headerLine}`
        : `codex trust: not present, no change (${result.headerLine})`;
      ctx.notes.push(line);
      if (!jsonMode) {
        process.stdout.write(`${line}\n`);
      }
    }
  } catch (error) {
    ctx.fail(`codex trust update failed: ${error?.message ?? error}`);
  }
}

/**
 * @param {{ args: string[], cwd?: string, helpers: {
 *   resolveCodexConfigPath: Function, codexTrustAdd: Function,
 *   codexTrustRemove: Function, restoreUnchangedProvisionedFile: Function,
 *   provisionNodeModulesJunctions: Function } }} input `helpers` are the
 *   functions the entry file keeps (its specs load them from its source text)
 * @returns {Promise<number>} the exit code: 0 ready, 1 not ready, 2 unusable invocation
 */
export async function runProvisioning({ args, cwd = process.cwd(), helpers }) {
  const options = parseProvisionArgs(args, cwd);
  const { clonePath, sourceRepo, jsonMode, verifyOnly, untrustOnly } = options;
  if (!clonePath) {
    process.stderr.write(renderUsage());
    return 2;
  }
  // F4 fix-round (Hirluin): retirement deletes the clone directory before
  // revoking trust is ever guaranteed to run, so a bare --codex-untrust must
  // not require the .git tree that just stopped existing. --codex-trust still
  // needs a real clone (there is nothing sane to trust otherwise), so the
  // bypass is scoped to "untrust, and nothing else requested".
  if (!untrustOnly) {
    if (!fs.existsSync(path.join(clonePath, ".git"))) {
      process.stderr.write(
        `not a git clone: ${clonePath}; first git clone --no-hardlinks <source> <clone>, then node Tools/provision-worker-clone.mjs <clone>\n`,
      );
      return 2;
    }
    // A linked worktree's .git is a FILE pointing into the orchestrator's .git, which
    // R-2026-08-18-28 disqualified for sandboxed workers: every ref and index write
    // would land under the orchestrator's repository.
    if (!fs.statSync(path.join(clonePath, ".git")).isDirectory()) {
      process.stderr.write(
        `${clonePath}/.git is a file, not a directory — this is a linked worktree, not a clone. See R-2026-08-18-28.\n`,
      );
      return 2;
    }
  }

  const ctx = createProvisionContext();
  if (options.codexTrust || options.codexUntrust) {
    applyCodexTrust(ctx, options, helpers);
  }

  // F4 fix-round: a bare --codex-untrust already skipped the .git check above
  // because the clone directory may be gone. Everything below this point
  // assumes a real clone tree — provisioning in particular would recreate the
  // retired directory via mkdirSync/copyFileSync, which is a worse surprise
  // than exiting here. The trust write is the entire job of an untrust-only
  // invocation.
  if (untrustOnly) {
    const untrustResult = {
      clone: clonePath,
      status: ctx.problems.length === 0 ? "READY" : "NOT_READY",
      provisioned: [],
      notes: ctx.notes,
      problems: ctx.problems,
    };
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(untrustResult, null, 2)}\n`);
    } else {
      for (const p of ctx.problems) {
        process.stdout.write(`  PROBLEM      ${p}\n`);
      }
    }
    return ctx.problems.length === 0 ? 0 : 1;
  }

  const junctions = {
    sourceRepo,
    clonePath,
    provisionNodeModulesJunctions: helpers.provisionNodeModulesJunctions,
  };
  if (verifyOnly) {
    verifyNodeModules(ctx, junctions);
  } else {
    copyGovernance(ctx, {
      sourceRepo,
      clonePath,
      restoreUnchangedProvisionedFile: helpers.restoreUnchangedProvisionedFile,
    });
    ensureLocalMainRef(ctx, clonePath);
    linkNodeModules(ctx, junctions);
    copyThirdPartyWasm(ctx, { sourceRepo, clonePath });
    writeProvisionManifest(ctx, clonePath);
    await seedContextSpine(ctx, {
      sourceRepo,
      clonePath,
      seedSpineDb: options.seedSpineDb,
      refreshSpine: options.refreshSpine,
    });
  }

  if (options.codexMcp || options.codexUnmcp) {
    await applyCodexMcp(ctx, {
      args,
      codexMcp: options.codexMcp,
      codexUnmcp: options.codexUnmcp,
      resolveCodexConfigPath: helpers.resolveCodexConfigPath,
    });
  }

  if (!verifyOnly && options.capsuleTargets.length > 0) {
    await generateCapsule(ctx, {
      sourceRepo,
      clonePath,
      capsuleTargets: options.capsuleTargets,
      capsuleRole: options.capsuleRole,
    });
  }

  verifyReadiness(ctx, clonePath);

  const result = {
    clone: clonePath,
    status: ctx.problems.length === 0 ? "READY" : "NOT_READY",
    provisioned: ctx.provisioned.map((p) => p.path),
    notes: ctx.notes,
    problems: ctx.problems,
  };

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`worker clone: ${result.status}\n  ${clonePath}\n`);
    for (const p of ctx.provisioned) {
      process.stdout.write(`  provisioned  ${p.path}\n`);
    }
    for (const n of ctx.notes) {
      process.stdout.write(`  note         ${n}\n`);
    }
    for (const p of ctx.problems) {
      process.stdout.write(`  PROBLEM      ${p}\n`);
    }
  }

  // 0 ready, 1 not ready. A worker must not be dispatched on a non-zero exit.
  return ctx.problems.length === 0 ? 0 : 1;
}
