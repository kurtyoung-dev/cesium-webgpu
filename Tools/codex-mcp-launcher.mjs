#!/usr/bin/env node
/**
 * Codex MCP server launcher.
 * @purpose Resolve the Codex CLI across its hash-versioned install directories and exec `codex mcp-server` for .mcp.json; stable across desktop-app updates.
 * @status ACTIVE
 *
 * WHY THIS FILE EXISTS. The Codex CLI ships inside the ChatGPT desktop app at
 * `%LOCALAPPDATA%\OpenAI\Codex\bin\<contenthash>\codex.exe`. That hash segment
 * changes on every app update, so a literal path in `.mcp.json` breaks the next
 * time Codex updates — silently, because an MCP server that fails to spawn
 * degrades to "the tool isn't there" rather than an error anyone reads.
 *
 * Resolution order:
 *   1. $CODEX_CLI_PATH            — explicit override wins, always.
 *   2. `codex` on PATH            — a standalone `npm i -g @openai/codex` install.
 *   3. newest %LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe  — the bundled app.
 *
 * Every argument is forwarded verbatim after `mcp-server`, so per-server policy
 * lives in `.mcp.json` (e.g. `-c sandbox_mode="read-only"`) rather than being
 * baked in here. Nothing in this file mutates `~/.codex/config.toml`: Codex Sol
 * also runs independently from that config and must not be disturbed by ours.
 *
 * stdio is inherited unmodified. The MCP transport is line-delimited JSON-RPC on
 * stdin/stdout; anything written to stdout by this launcher would corrupt the
 * stream, so all diagnostics go to stderr.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const IS_WINDOWS = process.platform === "win32";
const BINARY = IS_WINDOWS ? "codex.exe" : "codex";

function fail(message) {
  process.stderr.write(`[codex-mcp-launcher] ${message}\n`);
  process.exit(2);
}

/** Newest `codex` binary across the app's content-hashed bin directories. */
function resolveBundled() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    return undefined;
  }
  const root = path.join(localAppData, "OpenAI", "Codex", "bin");
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(root, entry.name, BINARY);
    try {
      // Sort by the binary's own mtime, not the directory's: the app leaves
      // sibling hash directories in place across updates (one currently holds
      // only rg.exe), so directory order says nothing about which CLI is live.
      candidates.push({ candidate, mtimeMs: fs.statSync(candidate).mtimeMs });
    } catch {
      // Not every hash directory contains the CLI. Skip.
    }
  }
  if (candidates.length === 0) {
    return undefined;
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].candidate;
}

function resolveOnPath() {
  const pathValue = process.env.PATH ?? "";
  const separator = IS_WINDOWS ? ";" : ":";
  for (const dir of pathValue.split(separator)) {
    if (dir.length === 0) {
      continue;
    }
    const candidate = path.join(dir, BINARY);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return undefined;
}

function resolveCodex() {
  const override = process.env.CODEX_CLI_PATH;
  if (override) {
    if (!fs.existsSync(override)) {
      fail(`CODEX_CLI_PATH is set but does not exist: ${override}`);
    }
    return override;
  }
  return resolveOnPath() ?? resolveBundled();
}

const codex = resolveCodex();
if (!codex) {
  fail(
    "Codex CLI not found. Install it (`npm i -g @openai/codex` — note the scope; " +
      "the unscoped `codex` package is unrelated) or install the ChatGPT desktop " +
      "app, or set CODEX_CLI_PATH to the binary.",
  );
}

const args = ["mcp-server", ...process.argv.slice(2)];
process.stderr.write(`[codex-mcp-launcher] ${codex} ${args.join(" ")}\n`);

const child = spawn(codex, args, { stdio: "inherit", windowsHide: true });

child.on("error", (error) => {
  fail(`failed to spawn Codex: ${error.message}`);
});

// Terminating shutdown: forward the signal, then hard-exit if the child does not
// quiesce. A wedged MCP server holds the transport open and the client hangs
// with no diagnostic, which is the failure mode the fleet watchdog rule exists
// to prevent.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
    setTimeout(() => process.exit(1), 5000).unref();
  });
}

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
