// args.mjs - argv parsing and the usage text of Tools/provision-worker-clone.mjs.
// @purpose Own the provisioner's flag table (every flag it reads, once), parse argv into the options the provisioning flow consumes, and render the usage text from the same table so the two cannot drift apart.
// @status ACTIVE

/**
 * Every flag the provisioner reads. `--config` and `--dry-run` are consumed by
 * the Codex config helpers from the raw argv; they are listed (and parsed
 * below) so the usage text and the parser stay one vocabulary.
 *
 * @type {ReadonlyArray<{ flag: string, value?: string, help: string }>}
 */
export const PROVISION_FLAGS = [
  {
    flag: "--source",
    value: "<repo>",
    help: "seat repository to copy governance, node_modules and the spine DB from (default: the current directory)",
  },
  { flag: "--json", help: "print one JSON document instead of the report" },
  {
    flag: "--verify-only",
    help: "check readiness (node_modules junctions, routed authorities, main ref) and write nothing else",
  },
  {
    flag: "--codex-trust",
    help: "add the clone's [projects.'<path>'] trust entry to the Codex config",
  },
  {
    flag: "--codex-untrust",
    help: "remove that entry; alone, it skips every clone check (the retirement path)",
  },
  {
    flag: "--codex-mcp",
    help: "register the cesium-context-spine MCP server in the Codex config",
  },
  {
    flag: "--codex-unmcp",
    help: "remove that registration from the Codex config",
  },
  {
    flag: "--config",
    value: "<path>",
    help: "Codex config.toml to edit (default: ~/.codex/config.toml)",
  },
  {
    flag: "--dry-run",
    help: "refuse any Codex config target outside os.tmpdir()",
  },
  {
    flag: "--capsule",
    value: "<targets>",
    help: "write _review/context-capsule.md for these comma-separated files or symbols",
  },
  {
    flag: "--capsule-role",
    value: "<role>",
    help: "capsule audience: worker (default), reviewer or orchestrator",
  },
  {
    flag: "--no-spine-seed",
    help: "skip copying the source's context-spine DB and .mcp.json into the clone",
  },
  {
    flag: "--no-spine-refresh",
    help: "skip bringing a seeded DB up to the clone's HEAD with its incremental build",
  },
];

/**
 * @returns {string} the text printed on stderr when no clone path is given
 */
export function renderUsage() {
  const lines = PROVISION_FLAGS.map(({ flag, value, help }) => {
    const left = value ? `${flag} ${value}` : flag;
    return `  ${left.padEnd(26)} ${help}`;
  });
  return (
    "usage: node Tools/provision-worker-clone.mjs <clone-path> [options]\n" +
    `${lines.join("\n")}\n` +
    "  --codex-untrust alone (no --codex-trust) skips the .git check and\n" +
    "  exits after the trust write — it is the retirement path and must work on\n" +
    "  a clone directory that has already been removed (F4/DX-25 fix-round).\n"
  );
}

/**
 * @typedef {object} ProvisionOptions
 * @property {string[]} args the raw argv (after the script name)
 * @property {boolean} jsonMode
 * @property {boolean} verifyOnly
 * @property {string | undefined} clonePath the first argument that is not a flag
 * @property {string} sourceRepo
 * @property {boolean} codexTrust
 * @property {boolean} codexUntrust
 * @property {boolean} untrustOnly --codex-untrust without --codex-trust
 * @property {boolean} codexMcp
 * @property {boolean} codexUnmcp
 * @property {string[]} capsuleTargets
 * @property {"worker" | "reviewer" | "orchestrator"} capsuleRole
 * @property {boolean} seedSpineDb false under --no-spine-seed
 * @property {boolean} refreshSpine false under --no-spine-refresh
 * @property {boolean} dryRun
 * @property {string | null} configArg the value after --config, if any
 */

/**
 * @param {string[]} args argv after the script name
 * @param {string} [cwd] the default source repo
 * @returns {ProvisionOptions}
 */
export function parseProvisionArgs(args, cwd = process.cwd()) {
  const sourceIdx = args.indexOf("--source");
  const capsuleIdx = args.indexOf("--capsule");
  const capsuleRaw = capsuleIdx >= 0 ? (args[capsuleIdx + 1] ?? "") : "";
  const capsuleRoleIdx = args.indexOf("--capsule-role");
  const configIdx = args.indexOf("--config");
  const codexTrust = args.includes("--codex-trust");
  const codexUntrust = args.includes("--codex-untrust");
  return {
    args,
    jsonMode: args.includes("--json"),
    verifyOnly: args.includes("--verify-only"),
    clonePath: args.find((a) => !a.startsWith("--")),
    sourceRepo: sourceIdx >= 0 ? args[sourceIdx + 1] : cwd,
    codexTrust,
    codexUntrust,
    untrustOnly: codexUntrust && !codexTrust,
    codexMcp: args.includes("--codex-mcp"),
    codexUnmcp: args.includes("--codex-unmcp"),
    capsuleTargets: capsuleRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith("--")),
    capsuleRole:
      capsuleRoleIdx >= 0 &&
      (args[capsuleRoleIdx + 1] === "reviewer" ||
        args[capsuleRoleIdx + 1] === "orchestrator")
        ? args[capsuleRoleIdx + 1]
        : "worker",
    seedSpineDb: !args.includes("--no-spine-seed"),
    refreshSpine: !args.includes("--no-spine-refresh"),
    dryRun: args.includes("--dry-run"),
    configArg: configIdx >= 0 ? (args[configIdx + 1] ?? null) : null,
  };
}
