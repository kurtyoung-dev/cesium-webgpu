import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const VISUAL_EVIDENCE_SCHEMA = "cesium-visual-evidence-publication/v2";
export const VISUAL_EVIDENCE_LEGACY_SCHEMA =
  "cesium-visual-evidence-publication/v1";
export const VISUAL_EVIDENCE_VERIFY_SCHEMA =
  "cesium-visual-evidence-verification/v2";
export const VISUAL_EVIDENCE_CATALOG_SCHEMA =
  "cesium-visual-evidence-catalog/v2";
export const VISUAL_EVIDENCE_PLAN_SCHEMA =
  "cesium-visual-evidence-archive-plan/v2";
export const VISUAL_EVIDENCE_UPGRADE_PLAN_SCHEMA =
  "cesium-visual-evidence-upgrade-plan/v1";

const FINAL_STATUSES = Object.freeze([
  "PASS",
  "FAIL",
  "ERROR",
  "STRUCTURAL",
  "NON_CERTIFYING",
  "UNKNOWN",
]);
const TOKEN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const REQUIRED_INTEGRITY_CLAIMS = Object.freeze([
  "sourcePrePostStable",
  "repositoryPrePostStable",
  "activeLockAbsentAtPreflightAndPostflight",
  "runningOrIncompleteMarkerAbsent",
  "contentAddressedObjectsVerified",
  "contentAddressedObjectsAreReadOnly",
  "originalPathViewsAreIndependentCopies",
  "originalPathViewsAreReadOnly",
  "publicationNoClobber",
]);
const LEGACY_INTEGRITY_CLAIMS = Object.freeze([
  "sourcePrePostStable",
  "repositoryPrePostStable",
  "activeLockAbsentAtPreflightAndPostflight",
  "runningOrIncompleteMarkerAbsent",
  "contentAddressedObjectsVerified",
  "originalPathViewsAreHardlinks",
  "publicationNoClobber",
]);
const READ_ONLY_MODE = 0o444;
const MANIFEST_KEYS = Object.freeze([
  "schema",
  "schemaVersion",
  "kind",
  "namespace",
  "producer",
  "runId",
  "publicationPath",
  "publishedAt",
  "result",
  "invocation",
  "legacyImport",
  "upgradedFrom",
  "source",
  "integrity",
  "files",
]);
const RESULT_KEYS = Object.freeze([
  "status",
  "exitCode",
  "certificationEligible",
]);
const LEGACY_IMPORT_KEYS = Object.freeze([
  "namespace",
  "reason",
  "certificationEligible",
]);
const SOURCE_KEYS = Object.freeze(["worktreeLabel", "guardPath", "repository"]);
const REPOSITORY_KEYS = Object.freeze(["pre", "post", "stable"]);
const REPOSITORY_PROVENANCE_KEYS = Object.freeze([
  "capturedAt",
  "head",
  "branch",
  "detached",
  "dirty",
  "statusByteLength",
  "statusSha256",
  "statusTokenCount",
]);
const FILE_ENTRY_KEYS = Object.freeze([
  "originalPath",
  "role",
  "mediaType",
  "objectPath",
  "viewPath",
  "byteLength",
  "sha256",
  "sourcePre",
  "sourcePost",
]);
const CAPTURE_IDENTITY_KEYS = Object.freeze([
  "byteLength",
  "sha256",
  "modifiedMs",
  "changedMs",
  "device",
  "inode",
]);

export class StructuralEvidenceError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = "StructuralEvidenceError";
    this.code = "VISUAL_EVIDENCE_STRUCTURAL";
    this.details = details;
  }
}

const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

const jsonBytes = (value) =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

const portablePath = (value) => value.split(path.sep).join("/");

function fail(message, details = null) {
  throw new StructuralEvidenceError(message, details);
}

// Windows file IDs are wider than JavaScript's exact integer range. Node's
// default numeric Stats can therefore round two adjacent, distinct inode IDs
// to the same Number and falsely classify an ordinary copy as a hardlink.
// Always use bigint Stats for topology/replace detection and serialize the key
// only inside this process; public v1/v2 manifests retain their numeric source
// stat fields for schema compatibility.
function preciseFileKey(file, operations, method = "lstatSync") {
  const value = operations[method](file, { bigint: true });
  return Object.freeze({
    device: String(value.dev),
    inode: String(value.ino),
  });
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

function validateToken(value, label) {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    fail(
      `${label} must be a 1-128 character path-safe token containing only letters, numbers, dot, underscore, or hyphen`,
    );
  }
  return value;
}

function validateStatus(value) {
  if (!FINAL_STATUSES.includes(value)) {
    fail(`status must be one of ${FINAL_STATUSES.join(", ")}`);
  }
  return value;
}

function validateExitCode(value) {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    fail("exitCode must be an integer from 0 through 255");
  }
  return value;
}

function validateResultCoherence(status, exitCode) {
  if (status === "PASS" && exitCode !== 0) {
    fail("PASS evidence requires exitCode 0");
  }
}

function isSafePublicReason(value) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > 2048 ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return code < 0x20 || code === 0x7f;
    })
  ) {
    return false;
  }
  const absoluteHostPath =
    /(?:^|[\s"'`(])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]|\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)/u;
  const credentialLiteral =
    /(?:--(?:api[-_]?key|authorization|passwd|password|secret|token)\s+\S+|(?:api[-_]?key|authorization|bearer|passwd|password|secret|token)\s*(?:=|:)\s*\S+)/iu;
  return !absoluteHostPath.test(value) && !credentialLiteral.test(value);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function resolveInside(root, candidate, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  if (!isInside(resolvedRoot, resolved)) {
    fail(`${label} escapes source root ${resolvedRoot}`);
  }
  return resolved;
}

function assertPathHasNoSymbolicComponents(
  root,
  candidate,
  label,
  operations,
  { allowMissing = false } = {},
) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (!isInside(resolvedRoot, resolved)) {
    fail(`${label} escapes ${resolvedRoot}`);
  }

  const relative = path.relative(resolvedRoot, resolved);
  let current = resolvedRoot;
  const parts = relative ? relative.split(path.sep) : [];
  for (let index = 0; index <= parts.length; index++) {
    if (index > 0) {
      current = path.join(current, parts[index - 1]);
    }
    let stat;
    try {
      stat = operations.lstatSync(current);
    } catch (error) {
      if (allowMissing && isMissing(error)) {
        return;
      }
      fail(`${label} has an unreadable path component`, {
        component: portablePath(path.relative(resolvedRoot, current)) || ".",
        error: error?.code ?? error?.message ?? String(error),
      });
    }
    if (stat.isSymbolicLink()) {
      fail(`${label} traverses a symbolic link or junction`, {
        component: portablePath(path.relative(resolvedRoot, current)) || ".",
      });
    }
  }

  let canonicalRoot;
  let canonical;
  try {
    canonicalRoot = operations.realpathSync(resolvedRoot);
    canonical = operations.realpathSync(resolved);
  } catch (error) {
    if (allowMissing && isMissing(error)) {
      return;
    }
    fail(`${label} could not be canonicalized`, {
      error: error?.code ?? error?.message ?? String(error),
    });
  }
  if (!isInside(canonicalRoot, canonical)) {
    fail(`${label} resolves outside its root`);
  }
}

function ensureRegularDirectory(libraryRoot, relative, operations) {
  let current = path.resolve(libraryRoot);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      operations.mkdirSync(current, { recursive: false });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
    const stat = operations.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail(
        "library directory topology contains a symbolic link, junction, or non-directory",
        {
          component: portablePath(path.relative(libraryRoot, current)),
        },
      );
    }
  }
  assertPathHasNoSymbolicComponents(
    libraryRoot,
    current,
    "library directory",
    operations,
  );
  return current;
}

function normalizeOriginalPath(root, file) {
  const relative = path.relative(root, file);
  if (!relative || !isInside(root, file)) {
    fail(`source file ${file} has no safe path relative to ${root}`);
  }
  const portable = portablePath(relative);
  if (
    path.posix.isAbsolute(portable) ||
    path.win32.isAbsolute(portable) ||
    /^[A-Za-z]:/u.test(portable) ||
    portable.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail(`source file ${file} has an unsafe original path ${portable}`);
  }
  return portable;
}

function normalizeManifestOriginalPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail(`manifest originalPath is unsafe: ${String(value)}`);
  }
  return value;
}

function readGitPointer(repositoryRoot, operations) {
  const dotGit = path.join(repositoryRoot, ".git");
  const dotGitStat = operations.lstatSync(dotGit);
  if (dotGitStat.isDirectory()) {
    return { gitDirectory: dotGit, commonDirectory: dotGit };
  }
  if (!dotGitStat.isFile()) {
    fail(`${dotGit} is neither a Git directory nor a worktree pointer`);
  }
  const pointer = operations.readFileSync(dotGit, "utf8").trim();
  const match = /^gitdir:\s*(.+)$/iu.exec(pointer);
  if (!match) {
    fail(`${dotGit} is not a valid Git worktree pointer`);
  }
  const gitDirectory = path.resolve(repositoryRoot, match[1]);
  const commonPointer = path.join(gitDirectory, "commondir");
  let commonDirectory = gitDirectory;
  try {
    const common = operations.readFileSync(commonPointer, "utf8").trim();
    if (!common) {
      fail(`${commonPointer} is empty`);
    }
    commonDirectory = path.resolve(gitDirectory, common);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
  if (!operations.lstatSync(gitDirectory).isDirectory()) {
    fail(`Git administration path is not a directory: ${gitDirectory}`);
  }
  if (!operations.lstatSync(commonDirectory).isDirectory()) {
    fail(`Git common directory is not a directory: ${commonDirectory}`);
  }
  return { gitDirectory, commonDirectory };
}

export function resolveGitLayout(repositoryRoot, operations = fs) {
  const worktreeRoot = path.resolve(repositoryRoot);
  const pointer = readGitPointer(worktreeRoot, operations);
  return Object.freeze({
    worktreeRoot,
    gitDirectory: path.resolve(pointer.gitDirectory),
    commonDirectory: path.resolve(pointer.commonDirectory),
    primaryRoot: path.dirname(path.resolve(pointer.commonDirectory)),
  });
}

export function deriveDefaultVisualEvidenceRoot(
  repositoryRoot,
  operations = fs,
) {
  const layout = resolveGitLayout(repositoryRoot, operations);
  const primaryName = path.basename(layout.primaryRoot);
  if (!primaryName || primaryName === path.parse(layout.primaryRoot).root) {
    fail(`cannot derive a repository name from ${layout.primaryRoot}`);
  }
  return path.join(
    path.dirname(layout.primaryRoot),
    `${primaryName}-visual-evidence`,
  );
}

function runGit(repositoryRoot, args, execute) {
  return execute(
    "git",
    [
      "-c",
      `safe.directory=${path.resolve(repositoryRoot)}`,
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    {
      cwd: repositoryRoot,
      encoding: null,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
}

export function collectRepositoryProvenance(repositoryRoot, options = {}) {
  const operations = options.operations ?? fs;
  const execute = options.execute ?? execFileSync;
  const now = options.now ?? (() => new Date());
  const layout = resolveGitLayout(repositoryRoot, operations);
  let head;
  let branch = null;
  let status;
  try {
    head = runGit(layout.worktreeRoot, ["rev-parse", "HEAD"], execute)
      .toString("utf8")
      .trim();
    try {
      branch = runGit(
        layout.worktreeRoot,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        execute,
      )
        .toString("utf8")
        .trim();
    } catch {
      branch = null;
    }
    status = runGit(
      layout.worktreeRoot,
      ["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
      execute,
    );
  } catch (error) {
    fail(`could not collect Git provenance for ${layout.worktreeRoot}`, {
      error: String(error?.stack ?? error),
    });
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(head)) {
    fail(`Git HEAD identity is malformed: ${head}`);
  }
  const tokens = status.toString("utf8").split("\0").filter(Boolean);
  return Object.freeze({
    capturedAt: now().toISOString(),
    worktreeRoot: layout.worktreeRoot,
    primaryRoot: layout.primaryRoot,
    gitDirectory: layout.gitDirectory,
    gitCommonDirectory: layout.commonDirectory,
    head: head.toLowerCase(),
    branch: branch || null,
    detached: !branch,
    dirty: status.byteLength !== 0,
    statusByteLength: status.byteLength,
    statusSha256: hashBytes(status),
    statusTokenCount: tokens.length,
  });
}

function compareRepositoryProvenance(before, after) {
  const fields = [
    "worktreeRoot",
    "primaryRoot",
    "gitDirectory",
    "gitCommonDirectory",
    "head",
    "branch",
    "detached",
    "dirty",
    "statusByteLength",
    "statusSha256",
    "statusTokenCount",
  ];
  const changed = fields.filter(
    (field) =>
      JSON.stringify(before?.[field]) !== JSON.stringify(after?.[field]),
  );
  if (changed.length > 0) {
    fail(
      `repository provenance changed during archival: ${changed.join(", ")}`,
      {
        before,
        after,
      },
    );
  }
}

function statIdentity(file, operations) {
  let value;
  let precise;
  try {
    value = operations.lstatSync(file);
    precise = preciseFileKey(file, operations);
  } catch (error) {
    fail(`source file is unreadable: ${file}`, {
      error: error?.code ?? error?.message ?? String(error),
    });
  }
  if (!value.isFile() || value.isSymbolicLink()) {
    fail(`source path is not a regular, non-symbolic file: ${file}`);
  }
  return Object.freeze({
    byteLength: value.size,
    modifiedMs: value.mtimeMs,
    changedMs: value.ctimeMs,
    device: value.dev,
    inode: value.ino,
    preciseDevice: precise.device,
    preciseInode: precise.inode,
  });
}

function sameStatIdentity(left, right) {
  return (
    left?.byteLength === right?.byteLength &&
    left?.modifiedMs === right?.modifiedMs &&
    left?.changedMs === right?.changedMs &&
    left?.device === right?.device &&
    left?.inode === right?.inode &&
    left?.preciseDevice === right?.preciseDevice &&
    left?.preciseInode === right?.preciseInode
  );
}

function captureStableSource(file, originalPath, role, operations) {
  const beforeRead = statIdentity(file, operations);
  let bytes;
  try {
    bytes = operations.readFileSync(file);
  } catch (error) {
    fail(`source file could not be read: ${file}`, {
      error: error?.code ?? error?.message ?? String(error),
    });
  }
  const afterRead = statIdentity(file, operations);
  if (
    !sameStatIdentity(beforeRead, afterRead) ||
    bytes.byteLength !== afterRead.byteLength
  ) {
    fail(`source file changed while it was read: ${originalPath}`);
  }
  return Object.freeze({
    absolutePath: file,
    originalPath,
    role,
    bytes,
    identity: Object.freeze({
      ...afterRead,
      sha256: hashBytes(bytes),
    }),
  });
}

function publicCapture(capture) {
  return {
    byteLength: capture.identity.byteLength,
    sha256: capture.identity.sha256,
    modifiedMs: capture.identity.modifiedMs,
    changedMs: capture.identity.changedMs,
    device: capture.identity.device,
    inode: capture.identity.inode,
  };
}

function publicRepositoryProvenance(value) {
  return {
    capturedAt: value.capturedAt,
    head: value.head,
    branch: value.branch,
    detached: value.detached,
    dirty: value.dirty,
    statusByteLength: value.statusByteLength,
    statusSha256: value.statusSha256,
    statusTokenCount: value.statusTokenCount,
  };
}

function publicInvocation(command) {
  if (typeof command !== "string" || command.length === 0) {
    return null;
  }
  const bytes = Buffer.from(command, "utf8");
  return {
    commandSha256: hashBytes(bytes),
    commandByteLength: bytes.byteLength,
  };
}

function assertCaptureStable(before, after) {
  if (
    before.originalPath !== after.originalPath ||
    before.role !== after.role ||
    before.identity.sha256 !== after.identity.sha256 ||
    !sameStatIdentity(before.identity, after.identity)
  ) {
    fail(`source file changed during archival: ${before.originalPath}`, {
      before: publicCapture(before),
      after: publicCapture(after),
    });
  }
}

function walkSourceDirectory(directory, sourceRoot, operations, results) {
  const resolved = resolveInside(sourceRoot, directory, "source directory");
  assertPathHasNoSymbolicComponents(
    sourceRoot,
    resolved,
    "source directory",
    operations,
  );
  const stat = operations.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(
      `source directory is not a regular, non-symbolic directory: ${resolved}`,
    );
  }
  const entries = operations
    .readdirSync(resolved, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const entryPath = path.join(resolved, entry.name);
    if (entry.isSymbolicLink()) {
      fail(`source directory contains a symbolic link: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      walkSourceDirectory(entryPath, sourceRoot, operations, results);
    } else if (entry.isFile()) {
      results.push(entryPath);
    } else {
      fail(`source directory contains an unsupported entry: ${entryPath}`);
    }
  }
}

function resolveSourceSelection(options, operations) {
  const sourceRoot = path.resolve(options.sourceRoot);
  const artifact = options.artifact
    ? resolveInside(sourceRoot, options.artifact, "artifact")
    : null;
  const candidates = [];
  for (const file of options.files ?? []) {
    candidates.push(resolveInside(sourceRoot, file, "source file"));
  }
  for (const directory of options.directories ?? []) {
    walkSourceDirectory(directory, sourceRoot, operations, candidates);
  }
  if (artifact) {
    candidates.push(artifact);
  }
  const byOriginalPath = new Map();
  const caseFolded = new Map();
  for (const file of candidates) {
    assertPathHasNoSymbolicComponents(
      sourceRoot,
      file,
      "source file",
      operations,
    );
    const originalPath = normalizeOriginalPath(sourceRoot, file);
    const lower = originalPath.toLocaleLowerCase("en-US");
    const priorCase = caseFolded.get(lower);
    if (priorCase && priorCase !== originalPath) {
      fail(
        `source paths collide on a case-insensitive filesystem: ${priorCase} and ${originalPath}`,
      );
    }
    caseFolded.set(lower, originalPath);
    const name = path.basename(file).toLocaleLowerCase("en-US");
    if (name.endsWith(".lock") || name.endsWith(".tmp")) {
      fail(
        `active/temporary lifecycle files cannot be archived: ${originalPath}`,
      );
    }
    byOriginalPath.set(originalPath, {
      absolutePath: file,
      originalPath,
      role:
        artifact && path.resolve(file) === path.resolve(artifact)
          ? "artifact"
          : "file",
    });
  }
  const selected = [...byOriginalPath.values()].sort((left, right) =>
    left.originalPath.localeCompare(right.originalPath),
  );
  if (selected.length === 0) {
    fail("at least one source file is required");
  }
  if (options.kind === "run") {
    if (!artifact) {
      fail("a normal run archive requires one --artifact JSON file");
    }
    if (!selected.some((entry) => entry.role === "artifact")) {
      fail("the authoritative artifact is absent from the source selection");
    }
  } else if (artifact) {
    fail("legacy imports do not accept an authoritative artifact role");
  }
  return { sourceRoot, selected };
}

function commonDirectory(files) {
  let common = path.dirname(files[0]);
  for (const file of files.slice(1)) {
    while (!isInside(common, file)) {
      const parent = path.dirname(common);
      if (parent === common) {
        fail("source files have no usable common guard directory");
      }
      common = parent;
    }
  }
  return common;
}

function resolveGuardRoot(options, source, operations) {
  const visualOutputRoot = path.join(
    source.sourceRoot,
    "Tools",
    "visual-regression",
    "output",
  );
  const selectedInsideVisualOutput = source.selected.every((entry) =>
    isInside(visualOutputRoot, entry.absolutePath),
  );
  const guardRoot = options.guardRoot
    ? resolveInside(source.sourceRoot, options.guardRoot, "guard root")
    : selectedInsideVisualOutput
      ? visualOutputRoot
      : commonDirectory(source.selected.map((entry) => entry.absolutePath));
  let guardStat;
  try {
    guardStat = operations.lstatSync(guardRoot);
  } catch (error) {
    fail(`guard root is unreadable: ${guardRoot}`, {
      error: error?.code ?? error?.message ?? String(error),
    });
  }
  if (!guardStat.isDirectory() || guardStat.isSymbolicLink()) {
    fail(`guard root is not a regular, non-symbolic directory: ${guardRoot}`);
  }
  assertPathHasNoSymbolicComponents(
    source.sourceRoot,
    guardRoot,
    "guard root",
    operations,
  );
  for (const entry of source.selected) {
    if (!isInside(guardRoot, entry.absolutePath)) {
      fail(`guard root does not cover ${entry.originalPath}`);
    }
  }
  return guardRoot;
}

function findActiveLocks(directory, operations) {
  const locks = [];
  const visit = (current) => {
    const entries = operations
      .readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        fail(`guard directory contains a symbolic link: ${entryPath}`);
      }
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (
        entry.isFile() &&
        entry.name.toLocaleLowerCase("en-US").endsWith(".lock")
      ) {
        locks.push(entryPath);
      }
    }
  };
  visit(directory);
  return locks;
}

function assertNoActiveLocks(directory, operations) {
  const locks = findActiveLocks(directory, operations);
  if (locks.length > 0) {
    fail("active visual-evidence lock(s) refuse archival", {
      locks: locks.map((file) => portablePath(path.relative(directory, file))),
    });
  }
}

function parseSelectedJson(captures) {
  const parsed = new Map();
  for (const capture of captures) {
    if (
      path.extname(capture.originalPath).toLocaleLowerCase("en-US") !== ".json"
    ) {
      continue;
    }
    try {
      parsed.set(
        capture.originalPath,
        JSON.parse(capture.bytes.toString("utf8")),
      );
    } catch (error) {
      fail(`selected JSON is malformed: ${capture.originalPath}`, {
        error: error?.message ?? String(error),
      });
    }
  }
  return parsed;
}

function assertNoRunningMarkers(parsed) {
  for (const [originalPath, value] of parsed) {
    if (value?.status === "RUNNING" || value?.incomplete === true) {
      fail(`RUNNING/incomplete artifact refuses archival: ${originalPath}`, {
        runId: value?.runId ?? null,
        status: value?.status ?? null,
        incomplete: value?.incomplete ?? null,
      });
    }
  }
}

function assertFinalArtifact(options, captures, parsed) {
  if (options.kind !== "run") {
    return;
  }
  const artifactCapture = captures.find(
    (capture) => capture.role === "artifact",
  );
  const artifact = parsed.get(artifactCapture.originalPath);
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    fail("authoritative artifact must be a JSON object");
  }
  if (artifact.runId !== options.runId) {
    fail(
      `authoritative artifact runId ${String(artifact.runId)} does not match ${options.runId}`,
    );
  }
  if (artifact.status !== options.status) {
    fail(
      `authoritative artifact status ${String(artifact.status)} does not match ${options.status}`,
    );
  }
  if (
    artifact.exitCode !== undefined &&
    artifact.exitCode !== null &&
    artifact.exitCode !== options.exitCode
  ) {
    fail(
      `authoritative artifact exitCode ${String(artifact.exitCode)} does not match ${options.exitCode}`,
    );
  }
}

function fingerprintStoredFile(file, operations) {
  let beforeRead;
  let afterRead;
  let beforeKey;
  let afterKey;
  let bytes;
  try {
    beforeRead = operations.lstatSync(file);
    beforeKey = preciseFileKey(file, operations);
    if (!beforeRead.isFile() || beforeRead.isSymbolicLink()) {
      fail(`library path is not a regular file: ${file}`);
    }
    bytes = operations.readFileSync(file);
    afterRead = operations.lstatSync(file);
    afterKey = preciseFileKey(file, operations);
    if (!afterRead.isFile() || afterRead.isSymbolicLink()) {
      fail(`library path changed type while it was read: ${file}`);
    }
  } catch (error) {
    if (error instanceof StructuralEvidenceError) {
      throw error;
    }
    fail(`library file is unreadable: ${file}`, {
      error: error?.code ?? error?.message ?? String(error),
    });
  }
  const beforeIdentity = {
    byteLength: beforeRead.size,
    modifiedMs: beforeRead.mtimeMs,
    changedMs: beforeRead.ctimeMs,
    device: beforeRead.dev,
    inode: beforeRead.ino,
    preciseDevice: beforeKey.device,
    preciseInode: beforeKey.inode,
  };
  const afterIdentity = {
    byteLength: afterRead.size,
    modifiedMs: afterRead.mtimeMs,
    changedMs: afterRead.ctimeMs,
    device: afterRead.dev,
    inode: afterRead.ino,
    preciseDevice: afterKey.device,
    preciseInode: afterKey.inode,
  };
  if (
    !sameStatIdentity(beforeIdentity, afterIdentity) ||
    bytes.byteLength !== afterIdentity.byteLength
  ) {
    fail(`library file changed while it was read: ${file}`);
  }
  return {
    byteLength: bytes.byteLength,
    sha256: hashBytes(bytes),
    device: afterKey.device,
    inode: afterKey.inode,
    links: afterRead.nlink,
    readOnly: (afterRead.mode & 0o222) === 0,
  };
}

function protectStoredFile(file, expected, operations, label) {
  try {
    operations.chmodSync(file, READ_ONLY_MODE);
  } catch (error) {
    fail(`${label} could not be protected read-only: ${file}`, {
      error: error?.code ?? error?.message ?? String(error),
    });
  }
  const protectedIdentity = fingerprintStoredFile(file, operations);
  if (
    protectedIdentity.sha256 !== expected.sha256 ||
    protectedIdentity.byteLength !== expected.byteLength ||
    !protectedIdentity.readOnly
  ) {
    fail(`${label} failed read-only identity verification: ${file}`, {
      expected,
      actual: protectedIdentity,
    });
  }
  return protectedIdentity;
}

function objectRelativePath(sha256) {
  return path.posix.join("objects", "sha256", sha256.slice(0, 2), sha256);
}

function ensureContentObject(libraryRoot, capture, operations) {
  const sha256 = capture.identity.sha256;
  const relative = objectRelativePath(sha256);
  const destination = path.join(libraryRoot, ...relative.split("/"));
  ensureRegularDirectory(
    libraryRoot,
    path.join("objects", "sha256", sha256.slice(0, 2)),
    operations,
  );
  assertPathHasNoSymbolicComponents(
    libraryRoot,
    destination,
    "content object",
    operations,
    { allowMissing: true },
  );
  try {
    const existing = fingerprintStoredFile(destination, operations);
    if (
      existing.sha256 !== sha256 ||
      existing.byteLength !== capture.identity.byteLength
    ) {
      fail(`content-addressed object is corrupt: ${relative}`, { existing });
    }
    protectStoredFile(
      destination,
      { sha256, byteLength: capture.identity.byteLength },
      operations,
      "content-addressed object",
    );
    return { relative, destination, reused: true };
  } catch (error) {
    if (
      !(error instanceof StructuralEvidenceError) ||
      !error.message.startsWith("library file is unreadable") ||
      error.details?.error !== "ENOENT"
    ) {
      throw error;
    }
  }

  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    operations.writeFileSync(temporary, capture.bytes, { flag: "wx" });
    const temporaryIdentity = fingerprintStoredFile(temporary, operations);
    if (
      temporaryIdentity.sha256 !== sha256 ||
      temporaryIdentity.byteLength !== capture.identity.byteLength
    ) {
      fail(`temporary object verification failed for ${relative}`);
    }
    try {
      operations.linkSync(temporary, destination);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
    const stored = fingerprintStoredFile(destination, operations);
    if (
      stored.sha256 !== sha256 ||
      stored.byteLength !== capture.identity.byteLength
    ) {
      fail(`published content-addressed object is corrupt: ${relative}`, {
        stored,
      });
    }
    protectStoredFile(
      destination,
      { sha256, byteLength: capture.identity.byteLength },
      operations,
      "content-addressed object",
    );
    return { relative, destination, reused: false };
  } finally {
    try {
      operations.unlinkSync(temporary);
    } catch (error) {
      if (!isMissing(error)) {
        // The verified object remains authoritative. A leftover unique temp is
        // detected by `verify`; do not mask an earlier publication error.
      }
    }
  }
}

function mediaTypeFor(file) {
  switch (path.extname(file).toLocaleLowerCase("en-US")) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".json":
      return "application/json";
    case ".log":
    case ".md":
    case ".txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function createIndependentView(stage, capture, object, operations) {
  const relative = path.posix.join("files", capture.originalPath);
  const destination = path.join(stage, ...relative.split("/"));
  ensureRegularDirectory(
    stage,
    path.relative(stage, path.dirname(destination)),
    operations,
  );
  operations.copyFileSync(
    object.destination,
    destination,
    operations.constants.COPYFILE_EXCL,
  );
  const objectKey = preciseFileKey(object.destination, operations, "statSync");
  const viewKey = preciseFileKey(destination, operations, "statSync");
  if (
    objectKey.device === viewKey.device &&
    objectKey.inode === viewKey.inode
  ) {
    fail(`original-path view is not an independent copy: ${relative}`);
  }
  protectStoredFile(
    destination,
    {
      sha256: capture.identity.sha256,
      byteLength: capture.identity.byteLength,
    },
    operations,
    "original-path view",
  );
  return relative;
}

function publicationPaths(libraryRoot, options) {
  const destination =
    options.kind === "legacy-import"
      ? path.join(
          libraryRoot,
          "legacy",
          options.namespace,
          options.producer,
          options.runId,
        )
      : path.join(libraryRoot, "runs", options.producer, options.runId);
  const claim =
    options.kind === "legacy-import"
      ? path.join(
          libraryRoot,
          ".claims",
          "legacy",
          options.namespace,
          options.producer,
          `${options.runId}.lock`,
        )
      : path.join(
          libraryRoot,
          ".claims",
          "runs",
          options.producer,
          `${options.runId}.lock`,
        );
  return {
    destination,
    claim,
    stage: path.join(libraryRoot, ".incoming", randomUUID()),
  };
}

function initializeLibrary(libraryRoot, operations) {
  operations.mkdirSync(libraryRoot, { recursive: true });
  const rootStat = operations.lstatSync(libraryRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail(
      `library root is not a regular, non-symbolic directory: ${libraryRoot}`,
    );
  }
  for (const relative of [
    path.join("objects", "sha256"),
    "runs",
    "legacy",
    ".incoming",
    ".claims",
  ]) {
    ensureRegularDirectory(libraryRoot, relative, operations);
  }
}

function acquirePublicationClaim(paths, options, operations, now) {
  ensureRegularDirectory(
    options.libraryRoot,
    path.relative(options.libraryRoot, path.dirname(paths.claim)),
    operations,
  );
  try {
    operations.writeFileSync(
      paths.claim,
      jsonBytes({
        schema: VISUAL_EVIDENCE_SCHEMA,
        kind: options.kind,
        namespace: options.namespace ?? null,
        producer: options.producer,
        runId: options.runId,
        acquiredAt: now().toISOString(),
        processId: process.pid,
      }),
      { flag: "wx" },
    );
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail(
        `publication claim already exists for ${options.producer}/${options.runId}`,
      );
    }
    throw error;
  }
}

function releasePublicationClaim(paths, operations) {
  operations.unlinkSync(paths.claim);
}

function publicationRelativePath(options) {
  return options.kind === "legacy-import"
    ? path.posix.join(
        "legacy",
        options.namespace,
        options.producer,
        options.runId,
      )
    : path.posix.join("runs", options.producer, options.runId);
}

function buildManifest(options, context) {
  return {
    schema: VISUAL_EVIDENCE_SCHEMA,
    schemaVersion: 2,
    kind: options.kind,
    namespace: options.namespace ?? null,
    producer: options.producer,
    runId: options.runId,
    publicationPath: publicationRelativePath(options),
    publishedAt: context.publishedAt,
    result: {
      status: options.status,
      exitCode: options.exitCode,
      certificationEligible:
        options.kind === "run" &&
        options.status === "PASS" &&
        options.exitCode === 0,
    },
    invocation: {
      command: publicInvocation(options.command),
    },
    legacyImport:
      options.kind === "legacy-import"
        ? {
            namespace: options.namespace,
            reason: options.reason,
            certificationEligible: false,
          }
        : null,
    upgradedFrom: null,
    source: {
      worktreeLabel: path.basename(context.sourceRoot),
      guardPath:
        portablePath(path.relative(context.sourceRoot, context.guardRoot)) ||
        ".",
      repository: {
        pre: publicRepositoryProvenance(context.repositoryPre),
        post: publicRepositoryProvenance(context.repositoryPost),
        stable: true,
      },
    },
    integrity: {
      sourcePrePostStable: true,
      repositoryPrePostStable: true,
      activeLockAbsentAtPreflightAndPostflight: true,
      runningOrIncompleteMarkerAbsent: true,
      contentAddressedObjectsVerified: true,
      contentAddressedObjectsAreReadOnly: true,
      originalPathViewsAreIndependentCopies: true,
      originalPathViewsAreReadOnly: true,
      publicationNoClobber: true,
    },
    files: context.files.map((entry) => ({
      originalPath: entry.capture.originalPath,
      role: entry.capture.role,
      mediaType: mediaTypeFor(entry.capture.originalPath),
      objectPath: entry.object.relative,
      viewPath: entry.viewPath,
      byteLength: entry.capture.identity.byteLength,
      sha256: entry.capture.identity.sha256,
      sourcePre: publicCapture(entry.capture),
      sourcePost: publicCapture(entry.postCapture),
    })),
  };
}

function stableRepositoryIdentity(provenance) {
  if (!provenance || typeof provenance !== "object") {
    return provenance;
  }
  const { capturedAt: _capturedAt, ...identity } = provenance;
  return identity;
}

function archivalRequestIdentity(manifest) {
  return {
    schema: manifest.schema,
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    namespace: manifest.namespace,
    producer: manifest.producer,
    runId: manifest.runId,
    publicationPath: manifest.publicationPath,
    result: manifest.result,
    invocation: manifest.invocation,
    legacyImport: manifest.legacyImport,
    source: {
      worktreeLabel: manifest.source?.worktreeLabel,
      guardPath: manifest.source?.guardPath,
      repository: stableRepositoryIdentity(manifest.source?.repository?.post),
    },
    files: (manifest.files ?? []).map((entry) => ({
      originalPath: entry.originalPath,
      role: entry.role,
      mediaType: entry.mediaType,
      objectPath: entry.objectPath,
      viewPath: entry.viewPath,
      byteLength: entry.byteLength,
      sha256: entry.sha256,
    })),
  };
}

function candidateManifestForRetry(
  normalized,
  source,
  guardRoot,
  preflight,
  postflight,
  publishedAt,
) {
  return buildManifest(normalized, {
    sourceRoot: source.sourceRoot,
    guardRoot,
    repositoryPre: preflight.repositoryPre,
    repositoryPost: postflight.repositoryPost,
    publishedAt,
    files: preflight.pre.map((capture, index) => ({
      capture,
      postCapture: postflight.post[index],
      object: { relative: objectRelativePath(capture.identity.sha256) },
      viewPath: path.posix.join("files", capture.originalPath),
    })),
  });
}

function resolveIdempotentPublication(
  normalized,
  paths,
  source,
  guardRoot,
  preflight,
  postflight,
  operations,
  now,
) {
  const verification = verifyVisualEvidenceLibrary(
    { libraryRoot: normalized.libraryRoot },
    { operations, now },
  );
  if (!verification.valid) {
    fail(
      "existing publication cannot be reused because library verification failed",
      {
        reasons: verification.reasons,
      },
    );
  }
  const publicationPath = publicationRelativePath(normalized);
  const existing = verification.publications.find(
    (entry) => entry.manifest?.publicationPath === publicationPath,
  );
  if (!existing) {
    fail("existing publication directory has no verified manifest", {
      publicationPath,
    });
  }
  const candidate = candidateManifestForRetry(
    normalized,
    source,
    guardRoot,
    preflight,
    postflight,
    existing.manifest.publishedAt,
  );
  const existingIdentity = archivalRequestIdentity(existing.manifest);
  const candidateIdentity = archivalRequestIdentity(candidate);
  const existingFingerprint = hashBytes(jsonBytes(existingIdentity));
  const candidateFingerprint = hashBytes(jsonBytes(candidateIdentity));
  if (existingFingerprint !== candidateFingerprint) {
    fail("publication already exists with a different archival identity", {
      publicationPath,
      existingFingerprint,
      candidateFingerprint,
    });
  }
  const objectCount = new Set(
    existing.manifest.files.map((entry) => entry.sha256),
  ).size;
  return Object.freeze({
    manifest: existing.manifest,
    manifestSha256: existing.manifestHash,
    publicationDirectory: paths.destination,
    manifestFile: path.join(paths.destination, "manifest.json"),
    objectCount,
    reusedObjectCount: objectCount,
    idempotent: true,
  });
}

function validateArchiveOptions(options) {
  const kind = options.kind ?? "run";
  if (!["run", "legacy-import"].includes(kind)) {
    fail("kind must be run or legacy-import");
  }
  validateToken(options.producer, "producer");
  validateToken(options.runId, "runId");
  if (kind === "legacy-import") {
    validateToken(options.namespace, "legacy namespace");
    if (!isSafePublicReason(options.reason)) {
      fail(
        "legacy imports require a concise public reason without host paths, control characters, or credential literals",
      );
    }
    if (options.status !== "NON_CERTIFYING" || options.exitCode !== null) {
      fail("legacy imports are always NON_CERTIFYING with a null exitCode");
    }
  } else {
    validateStatus(options.status);
    validateExitCode(options.exitCode);
    validateResultCoherence(options.status, options.exitCode);
  }
  if (!options.sourceRoot) {
    fail("sourceRoot is required");
  }
  if (!options.libraryRoot) {
    fail("libraryRoot is required");
  }
  return kind;
}

function normalizeArchiveOptions(options, operations) {
  const kind = validateArchiveOptions(options);
  const normalized = {
    ...options,
    kind,
    producer: validateToken(options.producer, "producer"),
    runId: validateToken(options.runId, "runId"),
    namespace:
      kind === "legacy-import"
        ? validateToken(options.namespace, "legacy namespace")
        : null,
    libraryRoot: path.resolve(options.libraryRoot),
    sourceRoot: path.resolve(options.sourceRoot),
  };
  let sourceRootStat;
  try {
    sourceRootStat = operations.lstatSync(normalized.sourceRoot);
  } catch (error) {
    fail(`source root is unreadable: ${normalized.sourceRoot}`, {
      error: error?.code ?? error?.message ?? String(error),
    });
  }
  if (!sourceRootStat.isDirectory() || sourceRootStat.isSymbolicLink()) {
    fail(
      `source root is not a regular, non-symbolic directory: ${normalized.sourceRoot}`,
    );
  }
  assertPathHasNoSymbolicComponents(
    path.parse(normalized.sourceRoot).root,
    normalized.sourceRoot,
    "source root",
    operations,
  );
  assertPathHasNoSymbolicComponents(
    path.parse(normalized.libraryRoot).root,
    normalized.libraryRoot,
    "library root",
    operations,
    { allowMissing: true },
  );
  if (
    isInside(normalized.sourceRoot, normalized.libraryRoot) ||
    isInside(normalized.libraryRoot, normalized.sourceRoot)
  ) {
    fail("libraryRoot and sourceRoot must be disjoint directories");
  }
  return normalized;
}

function assertPublicationPathAvailable(paths, options, operations) {
  for (const [label, candidate] of [
    ["publication", paths.destination],
    ["publication claim", paths.claim],
  ]) {
    assertPathHasNoSymbolicComponents(
      options.libraryRoot,
      candidate,
      label,
      operations,
      { allowMissing: true },
    );
    try {
      operations.lstatSync(candidate);
      fail(
        label === "publication"
          ? `publication already exists and will not be replaced: ${publicationRelativePath(options)}`
          : `publication claim already exists for ${options.producer}/${options.runId}`,
      );
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
  }
}

function pathExists(file, operations) {
  try {
    operations.lstatSync(file);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

function captureArchivePreflight(
  normalized,
  source,
  guardRoot,
  operations,
  provenanceCollector,
) {
  const repositoryPre = provenanceCollector(source.sourceRoot);
  assertNoActiveLocks(guardRoot, operations);
  const pre = source.selected.map((entry) =>
    captureStableSource(
      entry.absolutePath,
      entry.originalPath,
      entry.role,
      operations,
    ),
  );
  const parsed = parseSelectedJson(pre);
  assertNoRunningMarkers(parsed);
  assertFinalArtifact(normalized, pre, parsed);
  return { repositoryPre, pre };
}

function captureArchivePostflight(
  normalized,
  source,
  guardRoot,
  preflight,
  operations,
  provenanceCollector,
  selectionChangeLabel,
) {
  const postSelection = resolveSourceSelection(normalized, operations);
  const prePaths = source.selected.map((entry) => entry.originalPath);
  const postPaths = postSelection.selected.map((entry) => entry.originalPath);
  if (JSON.stringify(prePaths) !== JSON.stringify(postPaths)) {
    fail(selectionChangeLabel, { prePaths, postPaths });
  }
  const post = postSelection.selected.map((entry) =>
    captureStableSource(
      entry.absolutePath,
      entry.originalPath,
      entry.role,
      operations,
    ),
  );
  for (let index = 0; index < preflight.pre.length; index++) {
    assertCaptureStable(preflight.pre[index], post[index]);
  }
  const parsedPost = parseSelectedJson(post);
  assertNoRunningMarkers(parsedPost);
  assertFinalArtifact(normalized, post, parsedPost);
  assertNoActiveLocks(guardRoot, operations);
  const repositoryPost = provenanceCollector(source.sourceRoot);
  compareRepositoryProvenance(preflight.repositoryPre, repositoryPost);
  return { post, repositoryPost };
}

/**
 * Performs the archival source/provenance checks without creating the library,
 * claims, objects, stages, views, or manifests. A later archive deliberately
 * repeats every check; this plan is informational and never reserves a run ID.
 */
export function planVisualEvidenceArchive(options, dependencies = {}) {
  const operations = dependencies.operations ?? fs;
  const now = dependencies.now ?? (() => new Date());
  const provenanceCollector =
    dependencies.provenanceCollector ??
    ((repositoryRoot) =>
      collectRepositoryProvenance(repositoryRoot, { operations, now }));
  const normalized = normalizeArchiveOptions(options, operations);
  const source = resolveSourceSelection(normalized, operations);
  const guardRoot = resolveGuardRoot(normalized, source, operations);
  const paths = publicationPaths(normalized.libraryRoot, normalized);

  try {
    const libraryRootStat = operations.lstatSync(normalized.libraryRoot);
    if (!libraryRootStat.isDirectory() || libraryRootStat.isSymbolicLink()) {
      fail(
        `library root is not a regular, non-symbolic directory: ${normalized.libraryRoot}`,
      );
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
  assertPublicationPathAvailable(paths, normalized, operations);

  const preflight = captureArchivePreflight(
    normalized,
    source,
    guardRoot,
    operations,
    provenanceCollector,
  );
  const postflight = captureArchivePostflight(
    normalized,
    source,
    guardRoot,
    preflight,
    operations,
    provenanceCollector,
    "source selection changed during dry-run inspection",
  );

  return Object.freeze({
    schema: VISUAL_EVIDENCE_PLAN_SCHEMA,
    schemaVersion: 2,
    ready: true,
    writesPerformed: false,
    kind: normalized.kind,
    namespace: normalized.namespace,
    producer: normalized.producer,
    runId: normalized.runId,
    publicationPath: publicationRelativePath(normalized),
    plannedAt: now().toISOString(),
    libraryRoot: normalized.libraryRoot,
    result: {
      status: normalized.status,
      exitCode: normalized.exitCode,
      certificationEligible:
        normalized.kind === "run" &&
        normalized.status === "PASS" &&
        normalized.exitCode === 0,
    },
    invocation: {
      command: publicInvocation(normalized.command),
    },
    legacyImport:
      normalized.kind === "legacy-import"
        ? {
            namespace: normalized.namespace,
            reason: normalized.reason,
            certificationEligible: false,
          }
        : null,
    source: {
      worktreeLabel: path.basename(source.sourceRoot),
      guardPath:
        portablePath(path.relative(source.sourceRoot, guardRoot)) || ".",
      repository: {
        pre: publicRepositoryProvenance(preflight.repositoryPre),
        post: publicRepositoryProvenance(postflight.repositoryPost),
        stable: true,
      },
    },
    integrity: {
      sourcePrePostStable: true,
      repositoryPrePostStable: true,
      activeLockAbsentAtPreflightAndPostflight: true,
      runningOrIncompleteMarkerAbsent: true,
      destinationAndClaimAbsent: true,
    },
    files: preflight.pre.map((capture, index) => ({
      originalPath: capture.originalPath,
      role: capture.role,
      mediaType: mediaTypeFor(capture.originalPath),
      objectPath: objectRelativePath(capture.identity.sha256),
      viewPath: path.posix.join("files", capture.originalPath),
      byteLength: capture.identity.byteLength,
      sha256: capture.identity.sha256,
      sourcePre: publicCapture(capture),
      sourcePost: publicCapture(postflight.post[index]),
    })),
  });
}

export function archiveVisualEvidence(options, dependencies = {}) {
  const operations = dependencies.operations ?? fs;
  const now = dependencies.now ?? (() => new Date());
  const provenanceCollector =
    dependencies.provenanceCollector ??
    ((repositoryRoot) =>
      collectRepositoryProvenance(repositoryRoot, { operations, now }));
  const normalized = normalizeArchiveOptions(options, operations);
  const source = resolveSourceSelection(normalized, operations);
  const guardRoot = resolveGuardRoot(normalized, source, operations);
  const paths = publicationPaths(normalized.libraryRoot, normalized);
  let published = false;
  let primaryError = null;
  let result = null;
  const upgradeClaim = `${normalized.libraryRoot}.upgrade.lock`;

  if (pathExists(upgradeClaim, operations)) {
    fail(`visual-evidence library upgrade is active: ${upgradeClaim}`);
  }

  initializeLibrary(normalized.libraryRoot, operations);
  assertPathHasNoSymbolicComponents(
    normalized.libraryRoot,
    paths.destination,
    "publication destination",
    operations,
    { allowMissing: true },
  );
  assertPathHasNoSymbolicComponents(
    normalized.libraryRoot,
    paths.claim,
    "publication claim",
    operations,
    { allowMissing: true },
  );
  if (!pathExists(paths.claim, operations)) {
    const libraryState = verifyVisualEvidenceLibrary(
      { libraryRoot: normalized.libraryRoot, allowLegacy: true },
      { operations, now },
    );
    if (!libraryState.valid) {
      fail("visual-evidence library is not safe for publication", {
        reasons: libraryState.reasons,
      });
    }
    if (
      libraryState.publications.some(
        ({ manifest }) => manifest.schema === VISUAL_EVIDENCE_LEGACY_SCHEMA,
      )
    ) {
      fail(
        "visual-evidence library contains legacy hardlink publications; run the explicit upgrade first",
      );
    }
  }
  if (pathExists(paths.destination, operations)) {
    if (pathExists(paths.claim, operations)) {
      fail(
        `publication claim already exists for ${normalized.producer}/${normalized.runId}`,
      );
    }
    const retryPreflight = captureArchivePreflight(
      normalized,
      source,
      guardRoot,
      operations,
      provenanceCollector,
    );
    const retryPostflight = captureArchivePostflight(
      normalized,
      source,
      guardRoot,
      retryPreflight,
      operations,
      provenanceCollector,
      "source selection changed during archival retry",
    );
    return resolveIdempotentPublication(
      normalized,
      paths,
      source,
      guardRoot,
      retryPreflight,
      retryPostflight,
      operations,
      now,
    );
  }
  acquirePublicationClaim(paths, normalized, operations, now);
  try {
    try {
      operations.lstatSync(paths.destination);
      fail(
        `publication already exists and will not be replaced: ${publicationRelativePath(normalized)}`,
      );
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
    assertPathHasNoSymbolicComponents(
      normalized.libraryRoot,
      paths.stage,
      "incoming publication stage",
      operations,
      { allowMissing: true },
    );
    operations.mkdirSync(paths.stage, { recursive: false });
    const preflight = captureArchivePreflight(
      normalized,
      source,
      guardRoot,
      operations,
      provenanceCollector,
    );

    const stagedFiles = preflight.pre.map((capture) => {
      const object = ensureContentObject(
        normalized.libraryRoot,
        capture,
        operations,
      );
      const viewPath = createIndependentView(
        paths.stage,
        capture,
        object,
        operations,
      );
      return { capture, object, viewPath };
    });

    const postflight = captureArchivePostflight(
      normalized,
      source,
      guardRoot,
      preflight,
      operations,
      provenanceCollector,
      "source selection changed during archival",
    );
    for (let index = 0; index < preflight.pre.length; index++) {
      stagedFiles[index].postCapture = postflight.post[index];
    }

    const manifest = buildManifest(normalized, {
      sourceRoot: source.sourceRoot,
      guardRoot,
      repositoryPre: preflight.repositoryPre,
      repositoryPost: postflight.repositoryPost,
      files: stagedFiles,
      publishedAt: now().toISOString(),
    });
    const serializedManifest = jsonBytes(manifest);
    const manifestSha256 = hashBytes(serializedManifest);
    operations.writeFileSync(
      path.join(paths.stage, "manifest.json"),
      serializedManifest,
      { flag: "wx" },
    );
    operations.writeFileSync(
      path.join(paths.stage, "manifest.sha256"),
      `${manifestSha256}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    protectStoredFile(
      path.join(paths.stage, "manifest.json"),
      { sha256: manifestSha256, byteLength: serializedManifest.byteLength },
      operations,
      "publication manifest",
    );
    const sidecarBytes = Buffer.from(`${manifestSha256}\n`, "utf8");
    protectStoredFile(
      path.join(paths.stage, "manifest.sha256"),
      { sha256: hashBytes(sidecarBytes), byteLength: sidecarBytes.byteLength },
      operations,
      "publication manifest sidecar",
    );
    assertNoActiveLocks(guardRoot, operations);
    ensureRegularDirectory(
      normalized.libraryRoot,
      path.relative(normalized.libraryRoot, path.dirname(paths.destination)),
      operations,
    );
    assertPathHasNoSymbolicComponents(
      normalized.libraryRoot,
      paths.destination,
      "publication destination",
      operations,
      { allowMissing: true },
    );
    if (pathExists(upgradeClaim, operations)) {
      fail(`visual-evidence library upgrade became active: ${upgradeClaim}`);
    }
    operations.renameSync(paths.stage, paths.destination);
    published = true;
    result = Object.freeze({
      manifest,
      manifestSha256,
      publicationDirectory: paths.destination,
      manifestFile: path.join(paths.destination, "manifest.json"),
      objectCount: new Set(manifest.files.map((entry) => entry.sha256)).size,
      reusedObjectCount: stagedFiles.filter((entry) => entry.object.reused)
        .length,
      idempotent: false,
    });
  } catch (error) {
    primaryError = error;
  } finally {
    if (!published) {
      try {
        operations.rmSync(paths.stage, { recursive: true, force: true });
      } catch {
        // Verification exposes any abandoned incoming directory.
      }
    }
    try {
      releasePublicationClaim(paths, operations);
    } catch (error) {
      if (!primaryError) {
        primaryError = new StructuralEvidenceError(
          `publication claim could not be released: ${paths.claim}`,
          { error: error?.code ?? error?.message ?? String(error) },
        );
      }
    }
  }
  if (primaryError) {
    throw primaryError;
  }
  return result;
}

function listDirectory(directory, operations, reasons, label) {
  try {
    return operations
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    reasons.push(
      `${label} is unreadable: ${error?.code ?? error?.message ?? String(error)}`,
    );
    return [];
  }
}

function collectPublicationDirectories(libraryRoot, operations, reasons) {
  const results = [];
  const runsRoot = path.join(libraryRoot, "runs");
  for (const producer of listDirectory(
    runsRoot,
    operations,
    reasons,
    "runs root",
  )) {
    const producerPath = path.join(runsRoot, producer.name);
    if (!producer.isDirectory() || producer.isSymbolicLink()) {
      reasons.push(`runs contains unsupported entry ${producer.name}`);
      continue;
    }
    for (const run of listDirectory(
      producerPath,
      operations,
      reasons,
      `runs/${producer.name}`,
    )) {
      if (!run.isDirectory() || run.isSymbolicLink()) {
        reasons.push(
          `runs/${producer.name} contains unsupported entry ${run.name}`,
        );
        continue;
      }
      results.push({
        kind: "run",
        namespace: null,
        producer: producer.name,
        runId: run.name,
        directory: path.join(producerPath, run.name),
      });
    }
  }

  const legacyRoot = path.join(libraryRoot, "legacy");
  for (const namespace of listDirectory(
    legacyRoot,
    operations,
    reasons,
    "legacy root",
  )) {
    const namespacePath = path.join(legacyRoot, namespace.name);
    if (!namespace.isDirectory() || namespace.isSymbolicLink()) {
      reasons.push(`legacy contains unsupported entry ${namespace.name}`);
      continue;
    }
    for (const producer of listDirectory(
      namespacePath,
      operations,
      reasons,
      `legacy/${namespace.name}`,
    )) {
      const producerPath = path.join(namespacePath, producer.name);
      if (!producer.isDirectory() || producer.isSymbolicLink()) {
        reasons.push(
          `legacy/${namespace.name} contains unsupported entry ${producer.name}`,
        );
        continue;
      }
      for (const run of listDirectory(
        producerPath,
        operations,
        reasons,
        `legacy/${namespace.name}/${producer.name}`,
      )) {
        if (!run.isDirectory() || run.isSymbolicLink()) {
          reasons.push(
            `legacy/${namespace.name}/${producer.name} contains unsupported entry ${run.name}`,
          );
          continue;
        }
        results.push({
          kind: "legacy-import",
          namespace: namespace.name,
          producer: producer.name,
          runId: run.name,
          directory: path.join(producerPath, run.name),
        });
      }
    }
  }
  return results;
}

function listFilesRecursive(
  directory,
  operations,
  reasons,
  root = directory,
  directories = null,
) {
  const files = [];
  for (const entry of listDirectory(
    directory,
    operations,
    reasons,
    directory,
  )) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      reasons.push(`symbolic links are forbidden in the library: ${entryPath}`);
    } else if (entry.isDirectory()) {
      directories?.push(portablePath(path.relative(root, entryPath)));
      files.push(
        ...listFilesRecursive(
          entryPath,
          operations,
          reasons,
          root,
          directories,
        ),
      );
    } else if (entry.isFile()) {
      files.push(portablePath(path.relative(root, entryPath)));
    } else {
      reasons.push(`unsupported library entry: ${entryPath}`);
    }
  }
  return files;
}

function inspectObjectStore(libraryRoot, operations, reasons) {
  const root = path.join(libraryRoot, "objects", "sha256");
  const objects = new Map();
  for (const prefix of listDirectory(
    root,
    operations,
    reasons,
    "object store",
  )) {
    const prefixPath = path.join(root, prefix.name);
    if (
      !prefix.isDirectory() ||
      prefix.isSymbolicLink() ||
      !/^[0-9a-f]{2}$/u.test(prefix.name)
    ) {
      reasons.push(`invalid object-store prefix entry ${prefix.name}`);
      continue;
    }
    for (const object of listDirectory(
      prefixPath,
      operations,
      reasons,
      `objects/sha256/${prefix.name}`,
    )) {
      const objectPath = path.join(prefixPath, object.name);
      if (
        !object.isFile() ||
        object.isSymbolicLink() ||
        !HASH_PATTERN.test(object.name) ||
        object.name.slice(0, 2) !== prefix.name
      ) {
        reasons.push(`invalid object-store entry ${objectPath}`);
        continue;
      }
      try {
        const identity = fingerprintStoredFile(objectPath, operations);
        if (identity.sha256 !== object.name) {
          reasons.push(`object hash does not match its path: ${objectPath}`);
        }
        objects.set(object.name, {
          path: objectPath,
          relative: objectRelativePath(object.name),
          ...identity,
        });
      } catch (error) {
        reasons.push(error.message);
      }
    }
  }
  return objects;
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== "string") {
    return false;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function hasExactKeys(value, expected) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function captureIdentityIsComplete(value, expectedHash, expectedLength) {
  return (
    hasExactKeys(value, CAPTURE_IDENTITY_KEYS) &&
    value.sha256 === expectedHash &&
    value.byteLength === expectedLength &&
    Number.isInteger(value.byteLength) &&
    value.byteLength >= 0 &&
    Number.isFinite(value.modifiedMs) &&
    value.modifiedMs >= 0 &&
    Number.isFinite(value.changedMs) &&
    value.changedMs >= 0 &&
    Number.isInteger(value.device) &&
    value.device >= 0 &&
    Number.isInteger(value.inode) &&
    value.inode >= 0
  );
}

function isSafeGitBranchName(value) {
  if (value === null) {
    return true;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value === "@" ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return code <= 0x20 || code === 0x7f;
    }) ||
    /[~^:?*[\]\\]/u.test(value) ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{")
  ) {
    return false;
  }
  return value
    .split("/")
    .every(
      (component) => !component.startsWith(".") && !component.endsWith(".lock"),
    );
}

function repositoryProvenanceIsComplete(value) {
  return (
    hasExactKeys(value, REPOSITORY_PROVENANCE_KEYS) &&
    isCanonicalIsoTimestamp(value.capturedAt) &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value.head ?? "") &&
    isSafeGitBranchName(value.branch) &&
    typeof value.detached === "boolean" &&
    value.detached === (value.branch === null) &&
    typeof value.dirty === "boolean" &&
    Number.isInteger(value.statusByteLength) &&
    value.statusByteLength >= 0 &&
    HASH_PATTERN.test(value.statusSha256 ?? "") &&
    Number.isInteger(value.statusTokenCount) &&
    value.statusTokenCount >= 0 &&
    value.dirty === value.statusByteLength > 0 &&
    value.dirty === value.statusTokenCount > 0
  );
}

function repositoryProvenanceIdentityMatches(left, right) {
  return REPOSITORY_PROVENANCE_KEYS.filter((key) => key !== "capturedAt").every(
    (key) => JSON.stringify(left?.[key]) === JSON.stringify(right?.[key]),
  );
}

function inspectPublication(
  descriptor,
  libraryRoot,
  objects,
  operations,
  reasons,
  { allowLegacy = false } = {},
) {
  const manifestFile = path.join(descriptor.directory, "manifest.json");
  const sidecarFile = path.join(descriptor.directory, "manifest.sha256");
  let manifestBytes;
  let manifest;
  let sidecar;
  try {
    manifestBytes = operations.readFileSync(manifestFile);
    manifest = JSON.parse(manifestBytes.toString("utf8"));
    sidecar = operations.readFileSync(sidecarFile, "utf8").trim();
  } catch (error) {
    reasons.push(
      `${portablePath(path.relative(libraryRoot, descriptor.directory))}: manifest is unreadable: ${error?.code ?? error?.message ?? String(error)}`,
    );
    return null;
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    reasons.push(
      `${portablePath(path.relative(libraryRoot, descriptor.directory))}: manifest JSON must be an object`,
    );
    return null;
  }
  if (
    manifest.schema === VISUAL_EVIDENCE_SCHEMA &&
    manifest.schemaVersion === 2 &&
    !hasExactKeys(manifest, MANIFEST_KEYS)
  ) {
    reasons.push(
      `${portablePath(path.relative(libraryRoot, descriptor.directory))}: manifest does not have the exact v2 schema fields`,
    );
  }
  const manifestHash = hashBytes(manifestBytes);
  if (!HASH_PATTERN.test(sidecar) || sidecar !== manifestHash) {
    reasons.push(
      `${manifest.publicationPath ?? descriptor.directory}: manifest SHA-256 sidecar mismatch`,
    );
  }
  const isCurrentSchema =
    manifest.schema === VISUAL_EVIDENCE_SCHEMA && manifest.schemaVersion === 2;
  const isLegacySchema =
    manifest.schema === VISUAL_EVIDENCE_LEGACY_SCHEMA &&
    manifest.schemaVersion === 1;
  if (isCurrentSchema) {
    try {
      const manifestIdentity = fingerprintStoredFile(manifestFile, operations);
      const sidecarIdentity = fingerprintStoredFile(sidecarFile, operations);
      if (!manifestIdentity.readOnly || !sidecarIdentity.readOnly) {
        reasons.push(`${descriptor.directory}: manifest files are writable`);
      }
    } catch (error) {
      reasons.push(error.message);
    }
  }
  if (!isCurrentSchema && !isLegacySchema) {
    reasons.push(`${descriptor.directory}: unsupported manifest schema`);
  } else if (isLegacySchema && !allowLegacy) {
    reasons.push(
      `${descriptor.directory}: legacy hardlink publication requires explicit upgrade`,
    );
  }
  for (const field of ["producer", "runId"]) {
    try {
      validateToken(manifest[field], `manifest ${field}`);
    } catch (error) {
      reasons.push(error.message);
    }
  }
  if (
    manifest.kind !== descriptor.kind ||
    manifest.namespace !== descriptor.namespace ||
    manifest.producer !== descriptor.producer ||
    manifest.runId !== descriptor.runId
  ) {
    reasons.push(
      `${descriptor.directory}: manifest identity differs from its path`,
    );
  }
  const expectedPublicationPath =
    descriptor.kind === "legacy-import"
      ? path.posix.join(
          "legacy",
          descriptor.namespace,
          descriptor.producer,
          descriptor.runId,
        )
      : path.posix.join("runs", descriptor.producer, descriptor.runId);
  if (manifest.publicationPath !== expectedPublicationPath) {
    reasons.push(
      `${descriptor.directory}: manifest publicationPath is incorrect`,
    );
  }
  if (!isCanonicalIsoTimestamp(manifest.publishedAt)) {
    reasons.push(`${descriptor.directory}: manifest publishedAt is invalid`);
  }
  const commandIdentity = manifest.invocation?.command;
  if (
    !hasExactKeys(manifest.invocation, ["command"]) ||
    (commandIdentity !== null &&
      (!hasExactKeys(commandIdentity, ["commandSha256", "commandByteLength"]) ||
        !HASH_PATTERN.test(commandIdentity.commandSha256 ?? "") ||
        !Number.isInteger(commandIdentity.commandByteLength) ||
        commandIdentity.commandByteLength < 0))
  ) {
    reasons.push(`${descriptor.directory}: invocation identity is invalid`);
  }
  const resultValid =
    hasExactKeys(manifest.result, RESULT_KEYS) &&
    FINAL_STATUSES.includes(manifest.result.status) &&
    (descriptor.kind === "legacy-import"
      ? manifest.result.status === "NON_CERTIFYING" &&
        manifest.result.exitCode === null &&
        manifest.result.certificationEligible === false
      : Number.isInteger(manifest.result.exitCode) &&
        manifest.result.exitCode >= 0 &&
        manifest.result.exitCode <= 255 &&
        (manifest.result.status !== "PASS" || manifest.result.exitCode === 0) &&
        manifest.result.certificationEligible ===
          (manifest.result.status === "PASS" &&
            manifest.result.exitCode === 0));
  if (!resultValid) {
    reasons.push(
      `${descriptor.directory}: manifest result classification is invalid`,
    );
  }
  const legacyImportValid =
    descriptor.kind === "legacy-import"
      ? hasExactKeys(manifest.legacyImport, LEGACY_IMPORT_KEYS) &&
        manifest.legacyImport.namespace === descriptor.namespace &&
        isSafePublicReason(manifest.legacyImport.reason) &&
        manifest.legacyImport.certificationEligible === false
      : manifest.legacyImport === null;
  if (!legacyImportValid) {
    reasons.push(
      `${descriptor.directory}: legacy import provenance is invalid`,
    );
  }
  const expectedIntegrityClaims = isLegacySchema
    ? LEGACY_INTEGRITY_CLAIMS
    : REQUIRED_INTEGRITY_CLAIMS;
  if (
    !manifest.integrity ||
    typeof manifest.integrity !== "object" ||
    Array.isArray(manifest.integrity) ||
    expectedIntegrityClaims.some(
      (claim) => manifest.integrity?.[claim] !== true,
    ) ||
    Object.keys(manifest.integrity ?? {}).some(
      (claim) => !expectedIntegrityClaims.includes(claim),
    )
  ) {
    reasons.push(
      `${descriptor.directory}: manifest integrity claims are incomplete`,
    );
  }
  const upgradeIdentity = manifest.upgradedFrom;
  if (
    isCurrentSchema &&
    upgradeIdentity !== null &&
    (typeof upgradeIdentity !== "object" ||
      Array.isArray(upgradeIdentity) ||
      !hasExactKeys(upgradeIdentity, [
        "schema",
        "manifestSha256",
        "upgradedAt",
      ]) ||
      upgradeIdentity.schema !== VISUAL_EVIDENCE_LEGACY_SCHEMA ||
      !HASH_PATTERN.test(upgradeIdentity.manifestSha256 ?? "") ||
      !isCanonicalIsoTimestamp(upgradeIdentity.upgradedAt))
  ) {
    reasons.push(`${descriptor.directory}: upgrade provenance is invalid`);
  }
  try {
    compareRepositoryProvenance(
      manifest.source?.repository?.pre,
      manifest.source?.repository?.post,
    );
    if (
      !hasExactKeys(manifest.source, SOURCE_KEYS) ||
      !hasExactKeys(manifest.source?.repository, REPOSITORY_KEYS) ||
      manifest.source.repository.stable !== true ||
      typeof manifest.source?.worktreeLabel !== "string" ||
      !TOKEN_PATTERN.test(manifest.source.worktreeLabel) ||
      (manifest.source?.guardPath !== "." &&
        normalizeManifestOriginalPath(manifest.source?.guardPath ?? "") !==
          manifest.source.guardPath) ||
      !repositoryProvenanceIsComplete(manifest.source?.repository?.pre) ||
      !repositoryProvenanceIsComplete(manifest.source?.repository?.post) ||
      !repositoryProvenanceIdentityMatches(
        manifest.source?.repository?.pre,
        manifest.source?.repository?.post,
      )
    ) {
      throw new StructuralEvidenceError("repository provenance is malformed");
    }
  } catch (error) {
    reasons.push(`${descriptor.directory}: ${error.message}`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    reasons.push(`${descriptor.directory}: manifest has no evidence files`);
    return { descriptor, manifest, manifestHash, manifestFile };
  }

  const expectedFiles = new Set(["manifest.json", "manifest.sha256"]);
  const expectedDirectories = new Set(["files"]);
  const originals = new Set();
  let artifactCount = 0;
  for (const entry of manifest.files) {
    if (!hasExactKeys(entry, FILE_ENTRY_KEYS)) {
      reasons.push(`${descriptor.directory}: manifest file entry is invalid`);
      continue;
    }
    let originalPath;
    try {
      originalPath = normalizeManifestOriginalPath(entry.originalPath);
    } catch (error) {
      reasons.push(error.message);
      continue;
    }
    const folded = originalPath.toLocaleLowerCase("en-US");
    if (originals.has(folded)) {
      reasons.push(
        `${descriptor.directory}: duplicate originalPath ${originalPath}`,
      );
      continue;
    }
    originals.add(folded);
    if (entry.role === "artifact") {
      artifactCount++;
    } else if (entry.role !== "file") {
      reasons.push(`${descriptor.directory}: invalid role for ${originalPath}`);
    }
    if (
      !HASH_PATTERN.test(entry.sha256 ?? "") ||
      !Number.isInteger(entry.byteLength) ||
      entry.byteLength < 0
    ) {
      reasons.push(
        `${descriptor.directory}: invalid identity for ${originalPath}`,
      );
      continue;
    }
    if (entry.mediaType !== mediaTypeFor(originalPath)) {
      reasons.push(
        `${descriptor.directory}: media type is invalid for ${originalPath}`,
      );
    }
    if (
      !captureIdentityIsComplete(
        entry.sourcePre,
        entry.sha256,
        entry.byteLength,
      ) ||
      !captureIdentityIsComplete(
        entry.sourcePost,
        entry.sha256,
        entry.byteLength,
      ) ||
      !sameStatIdentity(entry.sourcePre, entry.sourcePost)
    ) {
      reasons.push(
        `${descriptor.directory}: source pre/post identity differs for ${originalPath}`,
      );
    }
    const expectedObject = objectRelativePath(entry.sha256);
    const expectedView = path.posix.join("files", originalPath);
    if (
      entry.objectPath !== expectedObject ||
      entry.viewPath !== expectedView
    ) {
      reasons.push(
        `${descriptor.directory}: path binding is invalid for ${originalPath}`,
      );
    }
    expectedFiles.add(expectedView);
    let expectedDirectory = path.posix.dirname(expectedView);
    while (expectedDirectory !== ".") {
      expectedDirectories.add(expectedDirectory);
      expectedDirectory = path.posix.dirname(expectedDirectory);
    }
    const object = objects.get(entry.sha256);
    if (!object) {
      reasons.push(
        `${descriptor.directory}: object is missing for ${originalPath}`,
      );
      continue;
    }
    if (object.byteLength !== entry.byteLength) {
      reasons.push(
        `${descriptor.directory}: object length differs for ${originalPath}`,
      );
    }
    if (isCurrentSchema) {
      if (!object.readOnly) {
        reasons.push(
          `${descriptor.directory}: content object is writable for ${originalPath}`,
        );
      }
      if (object.links !== 1) {
        reasons.push(
          `${descriptor.directory}: content object has external hardlinks for ${originalPath}`,
        );
      }
    }
    const viewFile = path.join(
      descriptor.directory,
      ...expectedView.split("/"),
    );
    try {
      const view = fingerprintStoredFile(viewFile, operations);
      if (
        view.sha256 !== entry.sha256 ||
        view.byteLength !== entry.byteLength
      ) {
        reasons.push(
          `${descriptor.directory}: view bytes differ for ${originalPath}`,
        );
      }
      if (entry.role === "artifact") {
        try {
          const artifact = JSON.parse(
            operations.readFileSync(viewFile, "utf8"),
          );
          if (
            !artifact ||
            typeof artifact !== "object" ||
            Array.isArray(artifact) ||
            artifact.runId !== manifest.runId ||
            artifact.status !== manifest.result.status ||
            artifact.status === "RUNNING" ||
            artifact.incomplete === true ||
            (artifact.exitCode !== undefined &&
              artifact.exitCode !== null &&
              artifact.exitCode !== manifest.result.exitCode)
          ) {
            reasons.push(
              `${descriptor.directory}: authoritative artifact semantics are invalid`,
            );
          }
        } catch (error) {
          reasons.push(
            `${descriptor.directory}: authoritative artifact JSON is unreadable: ${error?.code ?? error?.message ?? String(error)}`,
          );
        }
      }
      if (isLegacySchema) {
        if (
          view.device !== object.device ||
          view.inode !== object.inode ||
          view.links < 2 ||
          object.links < 2
        ) {
          reasons.push(
            `${descriptor.directory}: legacy view is not an object hardlink for ${originalPath}`,
          );
        }
      } else if (isCurrentSchema) {
        if (view.device === object.device && view.inode === object.inode) {
          reasons.push(
            `${descriptor.directory}: view is not independent from its object for ${originalPath}`,
          );
        }
        if (!view.readOnly) {
          reasons.push(
            `${descriptor.directory}: view is writable for ${originalPath}`,
          );
        }
        if (view.links !== 1) {
          reasons.push(
            `${descriptor.directory}: view has external hardlinks for ${originalPath}`,
          );
        }
      }
    } catch (error) {
      reasons.push(error.message);
    }
  }
  if (
    (descriptor.kind === "run" && artifactCount !== 1) ||
    (descriptor.kind === "legacy-import" && artifactCount !== 0)
  ) {
    reasons.push(
      `${descriptor.directory}: authoritative artifact role count is invalid`,
    );
  }
  const actualDirectoryList = [];
  const actualFiles = new Set(
    listFilesRecursive(
      descriptor.directory,
      operations,
      reasons,
      descriptor.directory,
      actualDirectoryList,
    ),
  );
  const actualDirectories = new Set(actualDirectoryList);
  for (const expected of expectedFiles) {
    if (!actualFiles.has(expected)) {
      reasons.push(
        `${descriptor.directory}: expected file is missing: ${expected}`,
      );
    }
  }
  for (const actual of actualFiles) {
    if (!expectedFiles.has(actual)) {
      reasons.push(
        `${descriptor.directory}: unmanifested file exists: ${actual}`,
      );
    }
  }
  for (const expected of expectedDirectories) {
    if (!actualDirectories.has(expected)) {
      reasons.push(
        `${descriptor.directory}: expected directory is missing: ${expected}`,
      );
    }
  }
  for (const actual of actualDirectories) {
    if (!expectedDirectories.has(actual)) {
      reasons.push(
        `${descriptor.directory}: unmanifested directory exists: ${actual}`,
      );
    }
  }
  return { descriptor, manifest, manifestHash, manifestFile };
}

function countActiveTreeEntries(directory, operations, reasons) {
  const directories = [];
  const files = listFilesRecursive(
    directory,
    operations,
    reasons,
    directory,
    directories,
  );
  return { files, directories };
}

export function verifyVisualEvidenceLibrary(options, dependencies = {}) {
  const operations = dependencies.operations ?? fs;
  const now = dependencies.now ?? (() => new Date());
  const allowLegacy = options.allowLegacy === true;
  const libraryRoot = path.resolve(options.libraryRoot);
  const reasons = [];
  const warnings = [];
  try {
    const rootStat = operations.lstatSync(libraryRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      reasons.push(`library root is not a directory: ${libraryRoot}`);
    }
    assertPathHasNoSymbolicComponents(
      path.parse(libraryRoot).root,
      libraryRoot,
      "library root",
      operations,
    );
  } catch (error) {
    reasons.push(
      `library root is unreadable: ${error?.code ?? error?.message ?? String(error)}`,
    );
    return {
      schema: VISUAL_EVIDENCE_VERIFY_SCHEMA,
      generatedAt: now().toISOString(),
      libraryRoot,
      valid: false,
      reasons,
      warnings,
      publications: [],
      objects: { count: 0, referenced: 0, orphaned: [] },
    };
  }
  const allowedTopLevel = new Set([
    "objects",
    "runs",
    "legacy",
    ".incoming",
    ".claims",
  ]);
  for (const entry of listDirectory(
    libraryRoot,
    operations,
    reasons,
    "library root",
  )) {
    if (
      !allowedTopLevel.has(entry.name) ||
      !entry.isDirectory() ||
      entry.isSymbolicLink()
    ) {
      reasons.push(`unsupported top-level library entry: ${entry.name}`);
    }
  }
  for (const entry of listDirectory(
    path.join(libraryRoot, "objects"),
    operations,
    reasons,
    "objects root",
  )) {
    if (
      entry.name !== "sha256" ||
      !entry.isDirectory() ||
      entry.isSymbolicLink()
    ) {
      reasons.push(`unsupported objects-root entry: ${entry.name}`);
    }
  }
  for (const required of [
    path.join("objects", "sha256"),
    "runs",
    "legacy",
    ".incoming",
    ".claims",
  ]) {
    const requiredPath = path.join(libraryRoot, required);
    try {
      const requiredStat = operations.lstatSync(requiredPath);
      if (!requiredStat.isDirectory() || requiredStat.isSymbolicLink()) {
        reasons.push(
          `required library directory is not a directory: ${required}`,
        );
      } else {
        assertPathHasNoSymbolicComponents(
          libraryRoot,
          requiredPath,
          "required library directory",
          operations,
        );
      }
    } catch (error) {
      reasons.push(
        `required library directory is absent/unreadable: ${required} (${error?.code ?? error?.message ?? String(error)})`,
      );
    }
  }
  if (reasons.length > 0) {
    return {
      schema: VISUAL_EVIDENCE_VERIFY_SCHEMA,
      generatedAt: now().toISOString(),
      libraryRoot,
      valid: false,
      reasons,
      warnings,
      publications: [],
      objects: { count: 0, referenced: 0, orphaned: [] },
    };
  }

  const incoming = countActiveTreeEntries(
    path.join(libraryRoot, ".incoming"),
    operations,
    reasons,
  );
  if (incoming.files.length > 0 || incoming.directories.length > 0) {
    reasons.push("library has an unfinished .incoming publication");
  }
  const claims = countActiveTreeEntries(
    path.join(libraryRoot, ".claims"),
    operations,
    reasons,
  );
  if (claims.files.length > 0) {
    reasons.push("library has an active or stale publication claim");
  }

  const objects = inspectObjectStore(libraryRoot, operations, reasons);
  const descriptors = collectPublicationDirectories(
    libraryRoot,
    operations,
    reasons,
  );
  const publications = descriptors
    .map((descriptor) =>
      inspectPublication(
        descriptor,
        libraryRoot,
        objects,
        operations,
        reasons,
        {
          allowLegacy,
        },
      ),
    )
    .filter(Boolean);
  const referenced = new Set(
    publications.flatMap((publication) =>
      (Array.isArray(publication.manifest.files)
        ? publication.manifest.files
        : []
      )
        .filter(
          (entry) =>
            entry && typeof entry === "object" && !Array.isArray(entry),
        )
        .map((entry) => entry.sha256),
    ),
  );
  const orphaned = [...objects.keys()].filter((hash) => !referenced.has(hash));
  if (orphaned.length > 0) {
    warnings.push(
      `${orphaned.length} content object(s) are not referenced by a completed publication`,
    );
  }
  return {
    schema: VISUAL_EVIDENCE_VERIFY_SCHEMA,
    generatedAt: now().toISOString(),
    libraryRoot,
    valid: reasons.length === 0,
    reasons,
    warnings,
    publications,
    objects: {
      count: objects.size,
      referenced: referenced.size,
      orphaned,
    },
  };
}

function upgradeControlPaths(libraryRoot) {
  return {
    claim: `${libraryRoot}.upgrade.lock`,
    stage: `${libraryRoot}.upgrade-stage-${randomUUID()}`,
    backup: `${libraryRoot}.upgrade-backup-${randomUUID()}`,
  };
}

function assertSafeUpgradeSibling(libraryRoot, candidate, label, operations) {
  const parent = path.dirname(libraryRoot);
  if (path.dirname(candidate) !== parent) {
    fail(`${label} is not a sibling of the library root`);
  }
  assertPathHasNoSymbolicComponents(
    path.parse(parent).root,
    parent,
    "visual-evidence library parent",
    operations,
  );
  if (pathExists(candidate, operations)) {
    fail(`${label} already exists: ${candidate}`);
  }
}

function inspectUpgradeableLibrary(libraryRoot, operations, now) {
  const verification = verifyVisualEvidenceLibrary(
    { libraryRoot, allowLegacy: true },
    { operations, now },
  );
  if (!verification.valid) {
    fail("visual-evidence library is not safe to upgrade", {
      reasons: verification.reasons,
    });
  }
  const legacy = verification.publications.filter(
    ({ manifest }) => manifest.schema === VISUAL_EVIDENCE_LEGACY_SCHEMA,
  );
  const current = verification.publications.filter(
    ({ manifest }) => manifest.schema === VISUAL_EVIDENCE_SCHEMA,
  );
  if (legacy.length + current.length !== verification.publications.length) {
    fail("visual-evidence library contains an unclassified publication");
  }
  return { verification, legacy, current };
}

function upgradeInspectionIdentity(inspection) {
  return hashBytes(
    jsonBytes({
      publications: inspection.verification.publications
        .map(({ manifest, manifestHash }) => ({
          publicationPath: manifest.publicationPath,
          manifestHash,
        }))
        .sort((left, right) =>
          left.publicationPath.localeCompare(right.publicationPath),
        ),
      objectCount: inspection.verification.objects.count,
      orphanedObjects: [...inspection.verification.objects.orphaned].sort(),
    }),
  );
}

export function planVisualEvidenceLibraryUpgrade(options, dependencies = {}) {
  const operations = dependencies.operations ?? fs;
  const now = dependencies.now ?? (() => new Date());
  const libraryRoot = path.resolve(options.libraryRoot);
  const paths = upgradeControlPaths(libraryRoot);
  if (pathExists(paths.claim, operations)) {
    fail(`visual-evidence library upgrade is already active: ${paths.claim}`);
  }
  const inspection = inspectUpgradeableLibrary(libraryRoot, operations, now);
  return Object.freeze({
    schema: VISUAL_EVIDENCE_UPGRADE_PLAN_SCHEMA,
    schemaVersion: 1,
    plannedAt: now().toISOString(),
    libraryRoot,
    writesPerformed: false,
    changesRequired: inspection.legacy.length > 0,
    legacyPublicationCount: inspection.legacy.length,
    currentPublicationCount: inspection.current.length,
    objectCount: inspection.verification.objects.count,
    publicationPaths: inspection.legacy
      .map(({ manifest }) => manifest.publicationPath)
      .sort((left, right) => left.localeCompare(right)),
  });
}

function copyProtectedFile(source, destination, expected, operations, label) {
  operations.copyFileSync(
    source,
    destination,
    operations.constants.COPYFILE_EXCL,
  );
  return protectStoredFile(destination, expected, operations, label);
}

function upgradedManifest(legacyManifest, legacyManifestHash, upgradedAt) {
  return {
    ...legacyManifest,
    schema: VISUAL_EVIDENCE_SCHEMA,
    schemaVersion: 2,
    upgradedFrom: {
      schema: VISUAL_EVIDENCE_LEGACY_SCHEMA,
      manifestSha256: legacyManifestHash,
      upgradedAt,
    },
    integrity: {
      sourcePrePostStable: true,
      repositoryPrePostStable: true,
      activeLockAbsentAtPreflightAndPostflight: true,
      runningOrIncompleteMarkerAbsent: true,
      contentAddressedObjectsVerified: true,
      contentAddressedObjectsAreReadOnly: true,
      originalPathViewsAreIndependentCopies: true,
      originalPathViewsAreReadOnly: true,
      publicationNoClobber: true,
    },
  };
}

function buildUpgradedLibrary(
  libraryRoot,
  stageRoot,
  inspection,
  operations,
  now,
) {
  initializeLibrary(stageRoot, operations);
  const objectReasons = [];
  const objects = inspectObjectStore(libraryRoot, operations, objectReasons);
  if (objectReasons.length > 0) {
    fail("object store changed during upgrade", { reasons: objectReasons });
  }
  for (const [sha256, object] of objects) {
    const relative = objectRelativePath(sha256);
    const destination = path.join(stageRoot, ...relative.split("/"));
    ensureRegularDirectory(
      stageRoot,
      path.join("objects", "sha256", sha256.slice(0, 2)),
      operations,
    );
    copyProtectedFile(
      object.path,
      destination,
      { sha256, byteLength: object.byteLength },
      operations,
      "upgraded content-addressed object",
    );
  }

  const upgradedAt = now().toISOString();
  for (const publication of inspection.verification.publications) {
    const { descriptor, manifest, manifestHash, manifestFile } = publication;
    const relativeDirectory = path.relative(libraryRoot, descriptor.directory);
    const destination = path.join(stageRoot, relativeDirectory);
    ensureRegularDirectory(
      stageRoot,
      path.relative(stageRoot, path.dirname(destination)),
      operations,
    );
    operations.mkdirSync(destination, { recursive: false });

    for (const entry of manifest.files) {
      const object = {
        destination: path.join(
          stageRoot,
          ...objectRelativePath(entry.sha256).split("/"),
        ),
      };
      createIndependentView(
        destination,
        {
          originalPath: entry.originalPath,
          identity: {
            sha256: entry.sha256,
            byteLength: entry.byteLength,
          },
        },
        object,
        operations,
      );
    }

    let manifestBytes;
    if (manifest.schema === VISUAL_EVIDENCE_LEGACY_SCHEMA) {
      manifestBytes = jsonBytes(
        upgradedManifest(manifest, manifestHash, upgradedAt),
      );
    } else {
      manifestBytes = operations.readFileSync(manifestFile);
    }
    const upgradedManifestHash = hashBytes(manifestBytes);
    operations.writeFileSync(
      path.join(destination, "manifest.json"),
      manifestBytes,
      { flag: "wx" },
    );
    const sidecarBytes = Buffer.from(`${upgradedManifestHash}\n`, "utf8");
    operations.writeFileSync(
      path.join(destination, "manifest.sha256"),
      sidecarBytes,
      { flag: "wx" },
    );
    protectStoredFile(
      path.join(destination, "manifest.json"),
      { sha256: upgradedManifestHash, byteLength: manifestBytes.byteLength },
      operations,
      "upgraded publication manifest",
    );
    protectStoredFile(
      path.join(destination, "manifest.sha256"),
      { sha256: hashBytes(sidecarBytes), byteLength: sidecarBytes.byteLength },
      operations,
      "upgraded publication manifest sidecar",
    );
  }

  const stagedVerification = verifyVisualEvidenceLibrary(
    { libraryRoot: stageRoot },
    { operations, now },
  );
  if (!stagedVerification.valid) {
    fail("staged visual-evidence upgrade failed verification", {
      reasons: stagedVerification.reasons,
    });
  }
  return stagedVerification;
}

function rollbackUpgradeSwap(paths, operations, primaryError) {
  const failedStage = `${paths.stage}.failed`;
  try {
    if (pathExists(paths.libraryRoot, operations)) {
      operations.renameSync(paths.libraryRoot, failedStage);
    }
    operations.renameSync(paths.backup, paths.libraryRoot);
    operations.rmSync(failedStage, { recursive: true, force: true });
  } catch (rollbackError) {
    fail("visual-evidence upgrade rollback failed", {
      primaryError: primaryError?.message ?? String(primaryError),
      rollbackError: rollbackError?.message ?? String(rollbackError),
      libraryRoot: paths.libraryRoot,
      backup: paths.backup,
      failedStage,
    });
  }
}

export function upgradeVisualEvidenceLibrary(options, dependencies = {}) {
  const operations = dependencies.operations ?? fs;
  const now = dependencies.now ?? (() => new Date());
  const libraryRoot = path.resolve(options.libraryRoot);
  const generated = upgradeControlPaths(libraryRoot);
  const paths = { ...generated, libraryRoot };
  assertSafeUpgradeSibling(
    libraryRoot,
    paths.claim,
    "upgrade claim",
    operations,
  );
  assertSafeUpgradeSibling(
    libraryRoot,
    paths.stage,
    "upgrade stage",
    operations,
  );
  assertSafeUpgradeSibling(
    libraryRoot,
    paths.backup,
    "upgrade backup",
    operations,
  );

  const initialInspection = inspectUpgradeableLibrary(
    libraryRoot,
    operations,
    now,
  );
  if (initialInspection.legacy.length === 0) {
    const verification = verifyVisualEvidenceLibrary(
      { libraryRoot },
      { operations, now },
    );
    if (!verification.valid) {
      fail("current visual-evidence library failed verification", {
        reasons: verification.reasons,
      });
    }
    return Object.freeze({
      idempotent: true,
      libraryRoot,
      upgradedPublicationCount: 0,
      publicationCount: verification.publications.length,
      objectCount: verification.objects.count,
    });
  }

  operations.writeFileSync(
    paths.claim,
    jsonBytes({
      schema: VISUAL_EVIDENCE_UPGRADE_PLAN_SCHEMA,
      acquiredAt: now().toISOString(),
      processId: process.pid,
      libraryRoot,
    }),
    { flag: "wx" },
  );
  let originalMoved = false;
  let upgradedMoved = false;
  let result;
  let primaryError = null;
  try {
    const inspection = inspectUpgradeableLibrary(libraryRoot, operations, now);
    if (inspection.legacy.length === 0) {
      fail("upgrade state changed after the library claim was acquired");
    }
    const stagedVerification = buildUpgradedLibrary(
      libraryRoot,
      paths.stage,
      inspection,
      operations,
      now,
    );
    const finalSourceInspection = inspectUpgradeableLibrary(
      libraryRoot,
      operations,
      now,
    );
    if (
      upgradeInspectionIdentity(inspection) !==
      upgradeInspectionIdentity(finalSourceInspection)
    ) {
      fail("visual-evidence library changed while its upgrade was staged");
    }
    operations.renameSync(libraryRoot, paths.backup);
    originalMoved = true;
    try {
      operations.renameSync(paths.stage, libraryRoot);
      upgradedMoved = true;
    } catch (error) {
      rollbackUpgradeSwap(paths, operations, error);
      originalMoved = false;
      throw error;
    }
    const finalVerification = verifyVisualEvidenceLibrary(
      { libraryRoot },
      { operations, now },
    );
    if (!finalVerification.valid) {
      const error = new StructuralEvidenceError(
        "published visual-evidence upgrade failed final verification",
        { reasons: finalVerification.reasons },
      );
      rollbackUpgradeSwap(paths, operations, error);
      originalMoved = false;
      upgradedMoved = false;
      throw error;
    }
    operations.rmSync(paths.backup, { recursive: true, force: true });
    originalMoved = false;
    result = Object.freeze({
      idempotent: false,
      libraryRoot,
      upgradedPublicationCount: inspection.legacy.length,
      publicationCount: stagedVerification.publications.length,
      objectCount: stagedVerification.objects.count,
    });
  } catch (error) {
    primaryError = error;
  } finally {
    if (!upgradedMoved) {
      try {
        operations.rmSync(paths.stage, { recursive: true, force: true });
      } catch {
        // The unique sibling stage is named in any thrown error for recovery.
      }
    }
    if (originalMoved) {
      try {
        rollbackUpgradeSwap(paths, operations, primaryError);
      } catch (rollbackError) {
        primaryError = rollbackError;
      }
    }
    try {
      operations.unlinkSync(paths.claim);
    } catch (error) {
      if (!isMissing(error) && !primaryError) {
        primaryError = new StructuralEvidenceError(
          `visual-evidence upgrade claim could not be released: ${paths.claim}`,
          { error: error?.code ?? error?.message ?? String(error) },
        );
      }
    }
  }
  if (primaryError) {
    throw primaryError;
  }
  return result;
}

export function buildVisualEvidenceCatalog(options, dependencies = {}) {
  const now = dependencies.now ?? (() => new Date());
  const verification = verifyVisualEvidenceLibrary(options, dependencies);
  if (!verification.valid) {
    fail("visual-evidence library verification failed before cataloging", {
      reasons: verification.reasons,
    });
  }
  const entries = verification.publications
    .map(({ descriptor, manifest, manifestHash }) => ({
      kind: manifest.kind,
      namespace: manifest.namespace,
      producer: manifest.producer,
      runId: manifest.runId,
      publicationPath: manifest.publicationPath,
      publishedAt: manifest.publishedAt,
      status: manifest.result.status,
      exitCode: manifest.result.exitCode,
      certificationEligible: manifest.result.certificationEligible,
      head: manifest.source.repository.post.head,
      dirty: manifest.source.repository.post.dirty,
      manifestSha256: manifestHash,
      files: manifest.files.map((file) => ({
        originalPath: file.originalPath,
        role: file.role,
        mediaType: file.mediaType,
        byteLength: file.byteLength,
        sha256: file.sha256,
        viewPath: path.posix.join(manifest.publicationPath, file.viewPath),
      })),
      _sortPath: descriptor.directory,
    }))
    .sort((left, right) => {
      const byTime = String(left.publishedAt).localeCompare(
        String(right.publishedAt),
      );
      return (
        byTime || left.publicationPath.localeCompare(right.publicationPath)
      );
    })
    .map(({ _sortPath, ...entry }) => entry);
  return {
    schema: VISUAL_EVIDENCE_CATALOG_SCHEMA,
    generatedAt: now().toISOString(),
    libraryLabel: path.basename(path.resolve(options.libraryRoot)),
    publicationCount: entries.length,
    entries,
  };
}
