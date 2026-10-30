// codex-mcp-config.mjs — Safe idempotent TOML registrar for `[mcp_servers.cesium_context_spine]` in `~/.codex/config.toml`.
// @purpose Register or remove `[mcp_servers.cesium_context_spine]` in Codex's `config.toml` using TOML literal strings and the `os.tmpdir()` test/dry-run guard.
// @status ACTIVE

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SERVER_SCRIPT = path.resolve(__dirname, "mcp-server.mjs");
export const CODEX_MCP_TABLE_HEADER = "[mcp_servers.cesium_context_spine]";

function detectEol(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function atomicWriteFile(targetPath, content, fsOps = fs) {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`,
  );
  fsOps.writeFileSync(tmpPath, content, "utf8");
  fsOps.renameSync(tmpPath, targetPath);
}

/**
 * Maintainer rule 2026-08-31: refuse any write outside `os.tmpdir()` when
 * `NODE_ENV === "test"` or `--dry-run` is present.
 *
 * @param {{
 *   configPath: string,
 *   nodeEnv?: string,
 *   args?: string[],
 *   tmpdir?: string
 * }} options
 */
export function assertCodexMcpConfigTargetAllowed({
  configPath,
  nodeEnv = process.env.NODE_ENV,
  args = [],
  tmpdir = os.tmpdir(),
}) {
  const guarded = nodeEnv === "test" || args.includes("--dry-run");
  if (!guarded) return;

  const resolvedTarget = path.resolve(configPath).toLowerCase();
  const resolvedTmp = path.resolve(tmpdir).toLowerCase();
  const withinTmp =
    resolvedTarget === resolvedTmp ||
    resolvedTarget.startsWith(resolvedTmp + path.sep.toLowerCase());
  if (!withinTmp) {
    throw new Error(
      `refusing to touch ${configPath}: outside os.tmpdir() (${tmpdir}) while NODE_ENV=test or --dry-run is set`,
    );
  }
}

/**
 * Build the 4-line TOML `[mcp_servers.cesium_context_spine]` block using TOML
 * literal strings (`'...'`) so Windows backslashes never trigger escape errors.
 *
 * @param {string} [serverScriptPath]
 * @returns {string[]}
 */
export function buildCodexMcpTableLines(
  serverScriptPath = DEFAULT_SERVER_SCRIPT,
) {
  const resolved = path.resolve(serverScriptPath);
  if (/['\r\n]/.test(resolved)) {
    throw new Error(
      `refusing to write unrepresentable serverScriptPath into TOML literal string: ${JSON.stringify(resolved)}`,
    );
  }
  return [
    CODEX_MCP_TABLE_HEADER,
    `args = ['${resolved}']`,
    "command = 'node'",
    "startup_timeout_sec = 30",
  ];
}

/**
 * Idempotently register `[mcp_servers.cesium_context_spine]` in Codex's `config.toml`.
 *
 * @param {{
 *   configPath?: string,
 *   serverScriptPath?: string,
 *   fs?: typeof fs,
 *   nodeEnv?: string,
 *   args?: string[],
 *   tmpdir?: string
 * }} [options]
 */
export function codexMcpAdd(options = {}) {
  const {
    configPath = path.join(os.homedir(), ".codex", "config.toml"),
    serverScriptPath = DEFAULT_SERVER_SCRIPT,
    fs: fsOps = fs,
    nodeEnv = process.env.NODE_ENV,
    args = [],
    tmpdir = os.tmpdir(),
  } = options;

  assertCodexMcpConfigTargetAllowed({ configPath, nodeEnv, args, tmpdir });
  if (!fsOps.existsSync(configPath)) {
    throw new Error(`Codex config.toml not found at ${configPath}`);
  }

  const content = fsOps.readFileSync(configPath, "utf8");
  const eol = detectEol(content);
  const lines = content.split(eol);
  if (lines.some((l) => l.trim() === CODEX_MCP_TABLE_HEADER)) {
    return {
      changed: false,
      header: CODEX_MCP_TABLE_HEADER,
      configPath,
    };
  }

  const blockLines = buildCodexMcpTableLines(serverScriptPath);

  // Prefer inserting cleanly after the last `[mcp_servers.*]` section if present;
  // otherwise append at EOF separated by a single blank line.
  let lastMcpHeaderIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\[mcp_servers\./.test(lines[i].trim())) {
      lastMcpHeaderIdx = i;
    }
  }

  if (lastMcpHeaderIdx >= 0) {
    let insertAt = lastMcpHeaderIdx + 1;
    while (
      insertAt < lines.length &&
      lines[insertAt].trim() !== "" &&
      !/^\[/.test(lines[insertAt].trim())
    ) {
      insertAt += 1;
    }
    lines.splice(insertAt, 0, "", ...blockLines);
  } else {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }
    lines.push("", ...blockLines, "");
  }

  atomicWriteFile(configPath, lines.join(eol), fsOps);
  return {
    changed: true,
    header: CODEX_MCP_TABLE_HEADER,
    configPath,
  };
}

/**
 * Idempotently remove `[mcp_servers.cesium_context_spine]` from Codex's `config.toml`.
 *
 * @param {{
 *   configPath?: string,
 *   fs?: typeof fs,
 *   nodeEnv?: string,
 *   args?: string[],
 *   tmpdir?: string
 * }} [options]
 */
export function codexMcpRemove(options = {}) {
  const {
    configPath = path.join(os.homedir(), ".codex", "config.toml"),
    fs: fsOps = fs,
    nodeEnv = process.env.NODE_ENV,
    args = [],
    tmpdir = os.tmpdir(),
  } = options;

  assertCodexMcpConfigTargetAllowed({ configPath, nodeEnv, args, tmpdir });
  if (!fsOps.existsSync(configPath)) {
    return { changed: false, header: CODEX_MCP_TABLE_HEADER, configPath };
  }

  const content = fsOps.readFileSync(configPath, "utf8");
  const eol = detectEol(content);
  const lines = content.split(eol);
  const headerIdx = lines.findIndex((l) => l.trim() === CODEX_MCP_TABLE_HEADER);
  if (headerIdx === -1) {
    return { changed: false, header: CODEX_MCP_TABLE_HEADER, configPath };
  }

  let endIdx = headerIdx + 1;
  while (endIdx < lines.length && !/^\[/.test(lines[endIdx].trim())) {
    endIdx += 1;
  }
  // Also trim a single preceding blank line if we inserted one.
  const removeStart =
    headerIdx > 0 && lines[headerIdx - 1].trim() === ""
      ? headerIdx - 1
      : headerIdx;
  lines.splice(removeStart, endIdx - removeStart);
  atomicWriteFile(configPath, lines.join(eol), fsOps);
  return { changed: true, header: CODEX_MCP_TABLE_HEADER, configPath };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const cliArgs = process.argv.slice(2);
  const cfgIdx = cliArgs.indexOf("--config");
  const configPath =
    cfgIdx >= 0 && cliArgs[cfgIdx + 1] ? cliArgs[cfgIdx + 1] : undefined;

  if (cliArgs.includes("--uninstall")) {
    const res = codexMcpRemove({ configPath, args: cliArgs });
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  } else if (cliArgs.includes("--install")) {
    const res = codexMcpAdd({ configPath, args: cliArgs });
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  } else {
    const target =
      configPath ?? path.join(os.homedir(), ".codex", "config.toml");
    const installed =
      fs.existsSync(target) &&
      fs
        .readFileSync(target, "utf8")
        .split(/\r?\n/)
        .some((l) => l.trim() === CODEX_MCP_TABLE_HEADER);
    process.stdout.write(
      `${JSON.stringify({ configPath: target, installed, header: CODEX_MCP_TABLE_HEADER }, null, 2)}\n`,
    );
  }
}
