#!/usr/bin/env node
/**
 * Codex dispatch preflight.
 * @purpose Prove a Codex worker can actually run before a batch is dispatched: resolves the CLI, checks auth, and fires a minimal canary exec to detect quota exhaustion and report the reset time.
 * @status ACTIVE
 *
 * WHY THIS EXISTS. On 2026-08-16 a nine-agent closing gate died at 0/9 on model
 * credit exhaustion and produced nothing cacheable — the whole run was wasted
 * because nothing checked capacity first. Codex bills against a ChatGPT plan
 * whose limit is enforced SERVER-SIDE, so there is no local counter to read and
 * no `codex usage` subcommand: the only reliable signal is to ask for one token
 * and see what comes back.
 *
 * The canary costs a negligible amount of quota when quota exists, and costs
 * nothing when it does not (the request is refused before any model work).
 *
 * Exit codes follow the fleet contract:
 *   0  READY      — auth valid and a live model turn completed
 *   1  EXHAUSTED  — usage limit hit; `resetsAt` carries the server's reset time
 *   2  ERROR      — CLI missing, canary timed out, or an unclassified failure
 *   3  STRUCTURAL — not logged in, or the CLI could not be resolved at all
 *
 * Usage:
 *   node Tools/codex-preflight.mjs           # human-readable, exits per table
 *   node Tools/codex-preflight.mjs --json    # machine-readable on stdout
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const JSON_MODE = process.argv.includes("--json");
const CANARY_TIMEOUT_MS = 120_000;
const IS_WINDOWS = process.platform === "win32";
const BINARY = IS_WINDOWS ? "codex.exe" : "codex";

/** Mirrors Tools/codex-mcp-launcher.mjs — one resolution rule, two consumers. */
function resolveCodex() {
  const override = process.env.CODEX_CLI_PATH;
  if (override && fs.existsSync(override)) {
    return override;
  }
  const separator = IS_WINDOWS ? ";" : ":";
  for (const dir of (process.env.PATH ?? "").split(separator)) {
    if (dir.length === 0) {
      continue;
    }
    const candidate = path.join(dir, BINARY);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
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
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(root, entry.name, BINARY);
    try {
      found.push({ candidate, mtimeMs: fs.statSync(candidate).mtimeMs });
    } catch {
      /* hash dir without the CLI */
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found[0]?.candidate;
}

function run(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // Terminating watchdog: the timer body must end the process itself. Setting
    // an exit code cannot unwedge a child that never closes its pipes.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * The exhaustion message is server-authored prose, so match on the stable
 * substring and pull the reset time out separately — a format change must
 * degrade to "exhausted, reset time unknown", never to "ready".
 */
function parseExhaustion(text) {
  if (!/usage limit/iu.test(text)) {
    return undefined;
  }
  const match = text.match(/try again at ([^.\n]+)/iu);
  return { resetsAt: match ? match[1].trim() : null };
}

function report(result) {
  if (JSON_MODE) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const lines = [`codex preflight: ${result.status}`];
  if (result.cli) {
    lines.push(`  cli      ${result.cli}`);
  }
  if (result.model) {
    lines.push(`  model    ${result.model}`);
  }
  if (result.resetsAt) {
    lines.push(`  resets   ${result.resetsAt}`);
  }
  if (result.detail) {
    lines.push(`  detail   ${result.detail}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main() {
  const cli = resolveCodex();
  if (!cli) {
    report({
      status: "STRUCTURAL",
      detail:
        "Codex CLI not found (set CODEX_CLI_PATH, or install @openai/codex — note the scope).",
    });
    process.exit(3);
  }

  const login = await run(cli, ["login", "status"], { timeoutMs: 45_000 });
  const loginText = `${login.stdout}${login.stderr}`;
  if (login.code !== 0 || /not logged in/iu.test(loginText)) {
    report({
      status: "STRUCTURAL",
      cli,
      detail: `not authenticated: ${loginText.trim() || `exit ${login.code}`}`,
    });
    process.exit(3);
  }

  // Run the canary somewhere harmless: read-only sandbox plus a temp cwd means a
  // stray model turn cannot touch the repo's ~138 uncommitted paths.
  const canaryCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-preflight-"));
  const canary = await run(
    cli,
    [
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "Reply with the single word: ready",
    ],
    { cwd: canaryCwd, timeoutMs: CANARY_TIMEOUT_MS },
  );
  try {
    fs.rmSync(canaryCwd, { recursive: true, force: true });
  } catch {
    /* best effort */
  }

  const text = `${canary.stdout}${canary.stderr}`;
  const model = text.match(/^model:\s*(.+)$/mu)?.[1]?.trim();

  if (canary.timedOut) {
    report({
      status: "ERROR",
      cli,
      model,
      detail: `canary did not return within ${CANARY_TIMEOUT_MS / 1000}s`,
    });
    process.exit(2);
  }

  const exhausted = parseExhaustion(text);
  if (exhausted) {
    report({
      status: "EXHAUSTED",
      cli,
      model,
      resetsAt: exhausted.resetsAt,
      detail: "do not dispatch Codex workers until the reset time",
    });
    process.exit(1);
  }

  if (canary.code !== 0) {
    report({
      status: "ERROR",
      cli,
      model,
      detail: `canary exited ${canary.code}: ${text.trim().split("\n").slice(-3).join(" | ")}`,
    });
    process.exit(2);
  }

  report({
    status: "READY",
    cli,
    model,
    detail: "a live model turn completed",
  });
  process.exit(0);
}

main().catch((error) => {
  report({ status: "ERROR", detail: error?.message ?? String(error) });
  process.exit(2);
});
