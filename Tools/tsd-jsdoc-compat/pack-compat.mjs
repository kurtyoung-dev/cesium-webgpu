import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { runBoundedCommand } from "../lib/bounded-command.mjs";
import { createImmutableEvidence } from "../visual-regression/lib/build-source-identity.mjs";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const root = fs.realpathSync(path.resolve(packageRoot, "../.."));
const expectedArchiveFiles = [
  "LICENSE",
  "PROVENANCE.md",
  "README.md",
  "dist/Dictionary.js",
  "dist/Dictionary.js.map",
  "dist/Emitter.js",
  "dist/Emitter.js.map",
  "dist/PropTree.js",
  "dist/PropTree.js.map",
  "dist/assert_never.js",
  "dist/assert_never.js.map",
  "dist/create_helpers.js",
  "dist/create_helpers.js.map",
  "dist/doclet_utils.js",
  "dist/doclet_utils.js.map",
  "dist/logger.js",
  "dist/logger.js.map",
  "dist/plugin.js",
  "dist/plugin.js.map",
  "dist/publish.js",
  "dist/publish.js.map",
  "dist/type_resolve_helpers.js",
  "dist/type_resolve_helpers.js.map",
  "npm-shrinkwrap.json",
  "package.json",
].sort();

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function ordinaryDirectory(directory) {
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Directory is outside the repository: ${directory}`);
  }
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      fs.realpathSync(current) !== current
    ) {
      throw new Error(`Nonordinary directory: ${current}`);
    }
  }
}

function fingerprintInputs() {
  return expectedArchiveFiles.map((relative) => {
    const file = path.join(packageRoot, relative);
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error(`Nonregular package input: ${relative}`);
    }
    const bytes = fs.readFileSync(file);
    const after = fs.lstatSync(file);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error(`Package input changed during read: ${relative}`);
    }
    return { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
  });
}

function archiveFiles(tgz) {
  const tar = zlib.gunzipSync(tgz, { maxOutputLength: 8 * 1024 * 1024 });
  const files = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (
        offset + 1024 > tar.length ||
        !tar
          .subarray(offset + 512, offset + 1024)
          .every((byte) => byte === 0) ||
        !tar.subarray(offset + 1024).every((byte) => byte === 0)
      ) {
        throw new Error("Packed archive has an incomplete terminator");
      }
      requireUniqueArchivePaths(files);
      return files.sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );
    }
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString()
        .replace(/\0.*$/s, "");
    const octal = (start, length, label) => {
      const value = field(start, length).trim();
      if (!/^[0-7]+$/u.test(value)) throw new Error(`Invalid ${label} field`);
      return Number.parseInt(value, 8);
    };
    const recordedChecksum = octal(148, 8, "checksum");
    let computedChecksum = 0;
    for (let index = 0; index < header.length; index++) {
      computedChecksum += index >= 148 && index < 156 ? 32 : header[index];
    }
    if (recordedChecksum !== computedChecksum)
      throw new Error("Packed header checksum mismatch");
    const prefix = field(345, 155);
    const name = `${prefix ? `${prefix}/` : ""}${field(0, 100)}`;
    const type = String.fromCharCode(header[156] || 48);
    const size = octal(124, 12, "size");
    if (type !== "0" || !name.startsWith("package/")) {
      throw new Error(`Unsupported packed entry: ${name} (${type})`);
    }
    const relative = name.slice("package/".length);
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`Unsafe packed entry: ${name}`);
    }
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (!Number.isSafeInteger(size) || dataEnd > tar.length) {
      throw new Error(`Packed member exceeds archive: ${name}`);
    }
    const bytes = tar.subarray(dataStart, dataEnd);
    files.push({ path: relative, bytes: size, sha256: sha256(bytes) });
    const paddedEnd = dataStart + Math.ceil(size / 512) * 512;
    if (
      paddedEnd > tar.length ||
      !tar.subarray(dataEnd, paddedEnd).every((byte) => byte === 0)
    ) {
      throw new Error(`Invalid packed member padding: ${name}`);
    }
    offset = paddedEnd;
  }
  throw new Error("Packed archive has no complete terminator");
}

function requireUniqueArchivePaths(files) {
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error("Duplicate packed entry");
  }
}

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--npm-cli" || argv[2] !== "--run-dir") {
    throw new Error(
      "Usage: node pack-compat.mjs --npm-cli <npm-cli.js> --run-dir <new-directory>",
    );
  }
  return { npmCli: path.resolve(argv[1]), runDir: path.resolve(argv[3]) };
}

function ordinarySuccessfulResult(raw) {
  return (
    raw?.completed === true &&
    raw.completion?.reason === "child-close" &&
    raw.native?.spawned === true &&
    raw.native?.spawnError === null &&
    raw.native?.childError === null &&
    raw.native?.close?.observed === true &&
    raw.native.close.exitCode === 0 &&
    raw.native.close.signal === null &&
    raw.timeout?.expired === false &&
    raw.timeout?.forced === false &&
    raw.streamDrain?.completed === true &&
    raw.streamDrain?.timedOut === false &&
    [raw.stdout, raw.stderr].every(
      (stream) =>
        stream?.available === true &&
        stream.ended === true &&
        stream.truncated === false &&
        stream.error === null &&
        stream.droppedBytes === 0,
    )
  );
}

async function main() {
  const { npmCli, runDir } = parseArgs(process.argv.slice(2));
  const npmStat = fs.lstatSync(npmCli);
  if (!npmStat.isFile() || npmStat.isSymbolicLink()) {
    throw new Error("npm CLI is not a regular file");
  }
  ordinaryDirectory(path.dirname(runDir));
  // Containment, not a specific lane path: the run directory only ever receives
  // throwaway pack evidence, so it must be new and inside this repository. The
  // ordinary-directory walk above already refuses symlinked or non-canonical
  // parents. An earlier revision pinned one 2026-09-08 lane tmp path, which made
  // the recipe unrunnable for every later reader of the landed package.
  if (
    runDir === root ||
    !runDir.startsWith(root + path.sep) ||
    fs.existsSync(runDir)
  ) {
    throw new Error("Run directory must be new and inside the repository");
  }
  fs.mkdirSync(runDir);
  const before = fingerprintInputs();
  const npmCliBytes = fs.readFileSync(npmCli);
  const records = [];
  const expectedName = "tsd-jsdoc-2.5.0-cesium.1.tgz";
  for (const label of ["a", "b"]) {
    const destination = path.join(runDir, `pack-${label}`);
    fs.mkdirSync(destination);
    const argv = [
      process.execPath,
      npmCli,
      "pack",
      packageRoot,
      "--ignore-scripts",
      "--offline",
      "--audit=false",
      "--fund=false",
      "--json",
      `--pack-destination=${destination}`,
    ];
    const result = await runBoundedCommand({
      argv,
      cwd: root,
      artifactPath: path.join(runDir, `npm-pack-${label}.jsonl`),
      timeoutMs: 30_000,
      terminationGraceMs: 2_000,
      streamDrainTimeoutMs: 2_000,
      hardCompletionMs: 35_000,
      stdoutMaxBytes: 256 * 1024,
      stderrMaxBytes: 256 * 1024,
      startIdentity: {
        purpose: "reproducible local tsd-jsdoc compatibility tarball",
        npmCli: {
          path: npmCli,
          bytes: npmCliBytes.length,
          sha256: sha256(npmCliBytes),
        },
        inputs: before,
      },
    });
    if (
      !ordinarySuccessfulResult(result.raw) ||
      result.raw.stderr.receivedBytes !== 0
    ) {
      throw new Error(`npm pack ${label} did not complete cleanly`);
    }
    const archive = path.join(destination, expectedName);
    const bytes = fs.readFileSync(archive);
    const files = archiveFiles(bytes);
    if (JSON.stringify(files) !== JSON.stringify(before)) {
      throw new Error(
        `Packed member content differs from inputs in pass ${label}`,
      );
    }
    records.push({ label, archive, bytes, files, sha256: sha256(bytes) });
  }
  if (!records[0].bytes.equals(records[1].bytes)) {
    throw new Error("Independent npm pack passes were not byte-reproducible");
  }
  const after = fingerprintInputs();
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("Package inputs changed while packing");
  }
  const output = path.join(packageRoot, expectedName);
  if (fs.existsSync(output)) {
    const existing = fs.readFileSync(output);
    if (!existing.equals(records[0].bytes)) {
      throw new Error(`Existing repository tarball differs: ${output}`);
    }
  } else {
    createImmutableEvidence(output, records[0].bytes);
  }
  createImmutableEvidence(
    path.join(runDir, "pack-summary.json"),
    `${JSON.stringify(
      {
        passed: true,
        output,
        bytes: records[0].bytes.length,
        sha256: records[0].sha256,
        npmCli: {
          path: npmCli,
          bytes: npmCliBytes.length,
          sha256: sha256(npmCliBytes),
        },
        files: records[0].files,
        inputs: before,
      },
      null,
      2,
    )}\n`,
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
