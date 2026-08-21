// generate-tooling-catalog-launcher.cjs — trusted bootstrap for the catalog.
//
// @purpose Binds and materializes the candidate-index catalog module graph before any candidate census code executes.
// @status ACTIVE
//
// This file is deliberately CommonJS and uses Node built-ins only. It is the
// small, independently reviewable trust boundary for the much larger catalog
// implementation. The implementation cannot establish its own provenance: a
// dirty entry module could otherwise terminate successfully before its imports
// or top-level binding checks run.

"use strict";

const { spawnSync } = require("node:child_process");
const { createHash, randomBytes } = require("node:crypto");
const {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const SELF_PATH = "Tools/generate-tooling-catalog-launcher.cjs";
const ENTRY_PATH = "Tools/generate-tooling-catalog.mjs";
const MODULE_GRAPH = Object.freeze([
  ENTRY_PATH,
  "Tools/lib/purpose-header.mjs",
]);
const REQUIRED_PATHS = Object.freeze([SELF_PATH, ...MODULE_GRAPH]);
const ROOT_ENV = "TOOLING_CATALOG_ROOT";
const TRUST_ENV = "TOOLING_CATALOG_TRUSTED_LAUNCHER";
const RECEIPT_CHALLENGE_ENV = "TOOLING_CATALOG_RECEIPT_CHALLENGE";
const RECEIPT_FD_ENV = "TOOLING_CATALOG_RECEIPT_FD";
const RECEIPT_SUBJECT_ENV = "TOOLING_CATALOG_RECEIPT_SUBJECT";
const RECEIPT_SCHEMA = "tooling-catalog-completion-v1";
const RECEIPT_FD = 3;
const FORBIDDEN_STARTUP_ENV = Object.freeze(["NODE_OPTIONS", "NODE_PATH"]);
const STRIPPED_NODE_ENV = Object.freeze([
  "NODE_CHANNEL_FD",
  "NODE_CHANNEL_SERIALIZATION_MODE",
  "NODE_COMPILE_CACHE",
  "NODE_DEBUG",
  "NODE_DEBUG_NATIVE",
  "NODE_DISABLE_COMPILE_CACHE",
  "NODE_DISABLE_COLORS",
  "NODE_ICU_DATA",
  "NODE_NO_WARNINGS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_PENDING_DEPRECATION",
  "NODE_PRESERVE_SYMLINKS",
  "NODE_PRESERVE_SYMLINKS_MAIN",
  "NODE_REDIRECT_WARNINGS",
  "NODE_REPL_EXTERNAL_MODULE",
  "NODE_SKIP_PLATFORM_CHECK",
  "NODE_V8_COVERAGE",
]);
const SEALED_ENV = Object.freeze([
  "TOOLING_CATALOG_CANDIDATE_RUNTIME",
  "TOOLING_CATALOG_CANDIDATE_HEAD",
  "TOOLING_CATALOG_HISTORY_GIT_DIR",
  "TOOLING_CATALOG_HISTORY_OBJECT_DIR",
  "TOOLING_CATALOG_HISTORY_ALTERNATES",
  "TOOLING_CATALOG_HISTORY_CONFIG",
  RECEIPT_CHALLENGE_ENV,
  RECEIPT_FD_ENV,
  RECEIPT_SUBJECT_ENV,
]);

class StructuralError extends Error {
  constructor(message) {
    super(message);
    this.name = "StructuralError";
  }
}

function gitEnvironment() {
  return {
    ...process.env,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function runGit(args, cwd, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    env: gitEnvironment(),
    maxBuffer: 512 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.signal !== null || result.status !== 0) {
    const detail =
      result.error?.message ??
      result.stderr?.toString("utf8").trim() ??
      result.signal ??
      `exit ${result.status}`;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout;
}

function resolveRoot() {
  const output = runGit(
    ["rev-parse", "--path-format=absolute", "--show-toplevel"],
    process.cwd(),
  );
  const root = output.toString("utf8").trim();
  if (root === "") {
    throw new Error("Git returned an empty candidate worktree root");
  }
  return path.resolve(root);
}

function readIndexSnapshot(root) {
  return runGit(["ls-files", "--stage", "-z"], root);
}

function parseRequiredEntries(snapshot) {
  const requested = new Set(REQUIRED_PATHS);
  const entries = new Map();
  for (const raw of snapshot.toString("utf8").split("\0").filter(Boolean)) {
    const tab = raw.indexOf("\t");
    const header = tab === -1 ? "" : raw.slice(0, tab);
    const pathname = tab === -1 ? "" : raw.slice(tab + 1);
    if (!requested.has(pathname)) {
      continue;
    }
    const match = /^(\d{6}) ([0-9a-f]{40,64}) ([0-3])$/u.exec(header);
    if (match === null || match[3] !== "0" || entries.has(pathname)) {
      throw new StructuralError(
        `candidate index entry for ${JSON.stringify(pathname)} is unresolved`,
      );
    }
    entries.set(pathname, { mode: match[1], oid: match[2] });
  }
  for (const pathname of REQUIRED_PATHS) {
    const entry = entries.get(pathname);
    if (entry === undefined) {
      throw new StructuralError(
        `candidate index has no stage-zero entry for ${JSON.stringify(pathname)}`,
      );
    }
    if (!new Set(["100644", "100755"]).has(entry.mode)) {
      throw new StructuralError(
        `candidate index path ${JSON.stringify(pathname)} has non-regular mode ${entry.mode}`,
      );
    }
  }
  return entries;
}

function readCandidateBlobs(root, entries) {
  const input = `${REQUIRED_PATHS.map((pathname) => entries.get(pathname).oid).join("\n")}\n`;
  const output = runGit(["cat-file", "--batch"], root, {
    input,
  });
  const blobs = new Map();
  let offset = 0;
  for (const pathname of REQUIRED_PATHS) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd === -1) {
      throw new Error(`truncated Git batch header for ${pathname}`);
    }
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const match = /^([0-9a-f]{40,64}) blob (\d+)$/u.exec(header);
    if (match === null || match[1] !== entries.get(pathname).oid) {
      throw new Error(
        `candidate object for ${pathname} is not the expected blob`,
      );
    }
    const size = Number(match[2]);
    const start = headerEnd + 1;
    const end = start + size;
    if (!Number.isSafeInteger(size) || size < 0 || end >= output.length) {
      throw new Error(`candidate blob for ${pathname} has invalid framing`);
    }
    if (output[end] !== 0x0a) {
      throw new Error(`candidate blob for ${pathname} lacks a terminator`);
    }
    blobs.set(pathname, Buffer.from(output.subarray(start, end)));
    offset = end + 1;
  }
  if (offset !== output.length) {
    throw new Error("candidate blob batch contains unrequested trailing data");
  }
  return blobs;
}

function normalizeBootstrapLineEndings(bytes) {
  const normalized = Buffer.allocUnsafe(bytes.length);
  let write = 0;
  for (let read = 0; read < bytes.length; read++) {
    if (bytes[read] === 0x0d && bytes[read + 1] === 0x0a) {
      continue;
    }
    normalized[write++] = bytes[read];
  }
  return normalized.subarray(0, write);
}

function bindLauncher(initialBytes, candidateBytes) {
  if (
    !initialBytes.equals(candidateBytes) &&
    !normalizeBootstrapLineEndings(initialBytes).equals(candidateBytes)
  ) {
    throw new StructuralError(
      `${SELF_PATH} startup bytes do not match the candidate-index trust boundary`,
    );
  }
}

function moduleSpecifiers(source) {
  const specifiers = [];
  const staticImport =
    /\bimport\s+(?:(?:[\s\S]*?)\s+from\s+)?["']([^"'\r\n]+)["']/gu;
  const exportFrom =
    /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"'\r\n]+)["']/gu;
  const dynamicImport = /\bimport\s*\(\s*["']([^"'\r\n]+)["']\s*\)/gu;
  for (const expression of [staticImport, exportFrom, dynamicImport]) {
    for (const match of source.matchAll(expression)) {
      specifiers.push(match[1]);
    }
  }
  const dynamicCount = [...source.matchAll(/\bimport\s*\(/gu)].length;
  if (dynamicCount !== [...source.matchAll(dynamicImport)].length) {
    throw new StructuralError(
      "candidate module graph contains a computed dynamic import",
    );
  }
  if (/\brequire\s*\(/u.test(source)) {
    throw new StructuralError(
      "candidate ESM module graph contains an undeclared require call",
    );
  }
  return specifiers;
}

function validateModuleGraph(blobs) {
  const graph = new Set(MODULE_GRAPH);
  const reachable = new Set([ENTRY_PATH]);
  const queue = [ENTRY_PATH];
  while (queue.length > 0) {
    const pathname = queue.shift();
    const source = blobs.get(pathname).toString("utf8");
    for (const specifier of moduleSpecifiers(source)) {
      if (specifier.startsWith("node:")) {
        continue;
      }
      if (!specifier.startsWith(".")) {
        throw new StructuralError(
          `candidate module ${pathname} imports non-materialized ${JSON.stringify(specifier)}`,
        );
      }
      const dependency = path.posix.normalize(
        path.posix.join(path.posix.dirname(pathname), specifier),
      );
      if (!graph.has(dependency)) {
        throw new StructuralError(
          `candidate module ${pathname} imports undeclared ${JSON.stringify(dependency)}`,
        );
      }
      if (!reachable.has(dependency)) {
        reachable.add(dependency);
        queue.push(dependency);
      }
    }
  }
  for (const pathname of MODULE_GRAPH) {
    if (!reachable.has(pathname)) {
      throw new StructuralError(
        `declared candidate module ${pathname} is unreachable from ${ENTRY_PATH}`,
      );
    }
  }
}

function materializeGraph(privateRoot, blobs) {
  const runtimeRoot = path.join(privateRoot, "runtime");
  for (const pathname of MODULE_GRAPH) {
    const destination = path.join(runtimeRoot, ...pathname.split("/"));
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, blobs.get(pathname));
  }
  return path.join(runtimeRoot, ...ENTRY_PATH.split("/"));
}

function deleteEnvironmentNames(env, names) {
  const folded = new Set(names.map((name) => name.toUpperCase()));
  for (const name of Object.keys(env)) {
    if (folded.has(name.toUpperCase())) {
      delete env[name];
    }
  }
}

function assertSafeLauncherStartup() {
  const inherited = Object.keys(process.env).filter(
    (name) =>
      FORBIDDEN_STARTUP_ENV.includes(name.toUpperCase()) &&
      process.env[name] !== undefined &&
      process.env[name] !== "",
  );
  if (inherited.length > 0) {
    throw new StructuralError(
      `forbidden inherited Node startup environment: ${inherited
        .map((name) => name.toUpperCase())
        .sort()
        .join(", ")}`,
    );
  }
  if (process.execArgv.length > 0) {
    throw new StructuralError(
      "forbidden Node startup arguments are active for the launcher",
    );
  }
}

function subjectIdentity(indexSnapshot, entries) {
  const hash = createHash("sha256");
  hash.update("tooling-catalog-candidate-subject-v1\0", "utf8");
  hash.update(indexSnapshot);
  for (const pathname of REQUIRED_PATHS) {
    const entry = entries.get(pathname);
    hash.update("\0", "utf8");
    hash.update(pathname, "utf8");
    hash.update("\0", "utf8");
    hash.update(entry.mode, "utf8");
    hash.update("\0", "utf8");
    hash.update(entry.oid, "ascii");
  }
  return hash.digest("hex");
}

function childEnvironment(root, challenge, subject) {
  const env = {
    ...process.env,
    [ROOT_ENV]: root,
    [TRUST_ENV]: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
  for (const name of SEALED_ENV) {
    delete env[name];
  }
  deleteEnvironmentNames(env, STRIPPED_NODE_ENV);
  env[RECEIPT_CHALLENGE_ENV] = challenge;
  env[RECEIPT_FD_ENV] = String(RECEIPT_FD);
  env[RECEIPT_SUBJECT_ENV] = subject;
  return env;
}

function validateCompletionReceipt(bytes, challenge, subject, status) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new StructuralError(
      "candidate runtime returned no completion receipt",
    );
  }
  if (bytes.length > 4096 || bytes[bytes.length - 1] !== 0x0a) {
    throw new StructuralError(
      "candidate runtime returned an invalid completion receipt frame",
    );
  }
  let receipt;
  try {
    receipt = JSON.parse(bytes.subarray(0, -1).toString("utf8"));
  } catch {
    throw new StructuralError(
      "candidate runtime returned malformed completion receipt JSON",
    );
  }
  if (
    receipt === null ||
    Array.isArray(receipt) ||
    typeof receipt !== "object" ||
    !Object.keys(receipt).every((key) =>
      ["challenge", "schema", "status", "subject"].includes(key),
    ) ||
    Object.keys(receipt).length !== 4 ||
    receipt.schema !== RECEIPT_SCHEMA ||
    receipt.challenge !== challenge ||
    receipt.subject !== subject ||
    receipt.status !== status
  ) {
    throw new StructuralError(
      "candidate runtime completion receipt does not bind the launched subject and verdict",
    );
  }
}

function diagnostic(status, message) {
  const label = status === 3 ? "STRUCTURAL" : "ERROR";
  return {
    status,
    stderr: Buffer.from(
      `generate-tooling-catalog-launcher: ${label} — ${message}\n`,
      "utf8",
    ),
    stdout: Buffer.alloc(0),
  };
}

function launch(argv) {
  let privateRoot;
  let outcome;
  try {
    assertSafeLauncherStartup();
    const initialBytes = readFileSync(__filename);
    const root = resolveRoot();
    const indexSnapshot = readIndexSnapshot(root);
    const entries = parseRequiredEntries(indexSnapshot);
    const blobs = readCandidateBlobs(root, entries);
    bindLauncher(initialBytes, blobs.get(SELF_PATH));
    validateModuleGraph(blobs);
    const challenge = randomBytes(32).toString("hex");
    const subject = subjectIdentity(indexSnapshot, entries);

    privateRoot = mkdtempSync(path.join(tmpdir(), "tooling-catalog-launcher-"));
    const entry = materializeGraph(privateRoot, blobs);
    const result = spawnSync(process.execPath, [entry, ...argv], {
      cwd: root,
      env: childEnvironment(root, challenge, subject),
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });

    const terminalIndex = readIndexSnapshot(root);
    if (!terminalIndex.equals(indexSnapshot)) {
      throw new StructuralError(
        "candidate Git index changed while the materialized runtime executed",
      );
    }
    if (!readFileSync(__filename).equals(initialBytes)) {
      throw new StructuralError(
        "the reviewed launcher changed while the candidate runtime executed",
      );
    }
    if (
      result.error ||
      result.signal !== null ||
      !Number.isInteger(result.status)
    ) {
      throw new Error(
        `candidate runtime failed to settle: ${result.error?.message ?? result.signal ?? "unknown child failure"}`,
      );
    }
    if (![0, 1, 2, 3].includes(result.status)) {
      throw new Error(
        `candidate runtime returned invalid exit ${result.status}`,
      );
    }
    validateCompletionReceipt(
      result.output?.[RECEIPT_FD],
      challenge,
      subject,
      result.status,
    );
    outcome = {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } catch (error) {
    outcome = diagnostic(
      error instanceof StructuralError ? 3 : 2,
      error.message,
    );
  } finally {
    if (privateRoot !== undefined) {
      try {
        rmSync(privateRoot, { recursive: true, force: true });
      } catch (error) {
        outcome = diagnostic(
          2,
          `cannot clean private runtime: ${error.message}`,
        );
      }
    }
  }
  if (outcome.stdout.length > 0) {
    process.stdout.write(outcome.stdout);
  }
  if (outcome.stderr.length > 0) {
    process.stderr.write(outcome.stderr);
  }
  return outcome.status;
}

process.exitCode = launch(process.argv.slice(2));
