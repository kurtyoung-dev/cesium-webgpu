// @purpose Shared provenance helpers: safe git HEAD, build/shader fingerprinting, and the STRUCTURAL build-absent reason evidence shards bind to.
// @status ACTIVE

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Commit the evidence boundary was captured at, or `undefined` when git cannot
 * answer.
 *
 * `undefined` rather than `null` is deliberate: it means "this helper produced
 * no value", which is distinct from the JSON `null` several artifact schemas
 * record for "the run had no commit". Callers that serialize the result into an
 * artifact spell that adaptation themselves (`safeGitHead(root) ?? null`), so
 * the wire format stays a property of the schema instead of leaking into the
 * helper — the ambiguity that let six copy-pasted versions of this function
 * drift into two different absent-values.
 *
 * @param {string} cwd Repository working directory to interrogate.
 * @returns {string|undefined} The 40-character commit, or undefined.
 */
export function safeGitHead(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Named STRUCTURAL reason for a run or a check that had no build to look at.
 *
 * Evidence shards bind themselves to `Build/CesiumUnminified` and to the shader
 * modules the build generates beside their `.glsl`/`.wgsl` sources. A tree
 * without those is not a tree where the product failed — it is a tree where the
 * lane could not see its subject, which the 0/1/2/3 contract calls STRUCTURAL.
 * Reading it any other way is how a bare `ENOENT` on `index.js.map` came to be
 * counted as a product FAIL, and how a check asserting a truncated-component
 * diagnostic ended up asserting against filesystem-error text instead.
 */
export const BUILD_ABSENT_REASON =
  "structural: the run has no build to bind to";

/** Read failures that mean an artifact is absent rather than unreadable. */
const BUILD_ABSENCE_CODES = new Set(["ENOENT", "ERR_MODULE_NOT_FOUND"]);

/**
 * Named STRUCTURAL reason for a build-absence failure, or `undefined` when the
 * failure is a genuine integrity fault that must keep failing.
 *
 * The distinction is deliberately narrow: only "the file is not there" is
 * absence. A permission error, a wrong file type, or a malformed source map is
 * a build that exists and cannot be trusted, which is a real red.
 *
 * @param {unknown} error Caught read/import failure.
 * @returns {string|undefined} The reason, or undefined.
 */
export function buildAbsenceReason(error) {
  const code = error?.code;
  if (typeof code !== "string" || !BUILD_ABSENCE_CODES.has(code)) {
    return undefined;
  }
  const target = error?.path ?? error?.url ?? error?.message ?? "";
  return `${BUILD_ABSENT_REASON}: ${String(target)}`;
}

/**
 * Fingerprint one local file without allowing an absent input to masquerade as
 * an empty file. Evidence callers retain the failure in their RUNNING/ERROR
 * artifact instead of losing the identity boundary to an exception string.
 *
 * @param {string} file
 * @param {typeof fs} operations
 * @returns {object}
 */
export function fingerprintEvidenceFile(file, operations = fs) {
  try {
    const bytes = operations.readFileSync(file);
    return {
      file,
      exists: true,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    };
  } catch (error) {
    return {
      file,
      exists: false,
      byteLength: null,
      sha256: null,
      error: error?.code ?? error?.message ?? String(error),
    };
  }
}

/**
 * Accept a readable fingerprint or a genuine ENOENT absence. Permission,
 * wrong-type, and synthetic read failures are integrity failures, never an
 * alternate spelling of "no prior evidence".
 *
 * @param {object} evidence
 * @param {string} label
 * @returns {object}
 */
export function assertEvidenceReadableOrAbsent(evidence, label) {
  if (evidence?.exists === true) {
    if (
      Number.isInteger(evidence.byteLength) &&
      evidence.byteLength > 0 &&
      /^[0-9a-f]{64}$/u.test(evidence.sha256 ?? "")
    ) {
      return evidence;
    }
    throw new Error(`${label} readable fingerprint is malformed`);
  }
  if (evidence?.exists === false && evidence.error === "ENOENT") {
    return evidence;
  }
  throw new Error(
    `${label} integrity is unverifiable: ${String(evidence?.error ?? "invalid fingerprint")}`,
  );
}

/**
 * Capture a named set of source/map/probe/policy bytes at one evidence
 * boundary. Object keys are part of the contract and are compared at the end.
 *
 * @param {Record<string, string>} files
 * @param {typeof fs} operations
 * @returns {Record<string, object>}
 */
export function snapshotEvidenceFiles(files, operations = fs) {
  return Object.fromEntries(
    Object.entries(files).map(([name, file]) => [
      name,
      fingerprintEvidenceFile(file, operations),
    ]),
  );
}

/**
 * Require exact start/end bytes for every named local evidence input.
 *
 * @param {Record<string, object>} start
 * @param {Record<string, object>} end
 * @returns {{ok: boolean, reasons: Array<string>}}
 */
export function compareEvidenceFileSnapshots(start, end) {
  const reasons = [];
  const startNames = Object.keys(start ?? {}).sort();
  const endNames = Object.keys(end ?? {}).sort();
  if (JSON.stringify(startNames) !== JSON.stringify(endNames)) {
    reasons.push(
      `start/end evidence keys differ: ${startNames.join(",")} vs ${endNames.join(",")}`,
    );
  }
  for (const name of new Set([...startNames, ...endNames])) {
    const before = start?.[name];
    const after = end?.[name];
    if (before?.exists !== true || after?.exists !== true) {
      reasons.push(`${name}: required local evidence file is absent`);
      continue;
    }
    if (
      before.byteLength !== after.byteLength ||
      before.sha256 !== after.sha256
    ) {
      reasons.push(`${name}: local evidence bytes changed during the run`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Bind every fresh browser context to the exact local entry module measured at
 * probe start. Labels are required exactly once, so dropping a failed session
 * cannot silently shrink the provenance set.
 *
 * @param {object} options
 * @param {Array<object>} options.entries
 * @param {Array<string>} options.expectedLabels
 * @param {object} options.localEntry
 * @returns {{ok: boolean, reasons: Array<string>}}
 */
export function validateServedEntryIdentities(options) {
  const entries = Array.isArray(options?.entries) ? options.entries : [];
  const expectedLabels = Array.isArray(options?.expectedLabels)
    ? options.expectedLabels
    : [];
  const localEntry = options?.localEntry;
  const reasons = [];
  const counts = new Map();

  if (
    localEntry?.exists !== true ||
    !(localEntry.byteLength > 0) ||
    !/^[0-9a-f]{64}$/u.test(localEntry.sha256 ?? "")
  ) {
    reasons.push("local runtime entry identity is absent or invalid");
  }

  for (const entry of entries) {
    const label = entry?.sessionLabel;
    counts.set(label, (counts.get(label) ?? 0) + 1);
    if (!expectedLabels.includes(label)) {
      reasons.push(`unexpected served-entry session ${String(label)}`);
    }
    if (entry?.ok !== true || entry?.status !== 200) {
      reasons.push(
        `${String(label)}: served runtime entry returned ${String(entry?.status)}`,
      );
    }
    if (
      !(entry?.byteLength > 0) ||
      !/^[0-9a-f]{64}$/u.test(entry?.sha256 ?? "")
    ) {
      reasons.push(
        `${String(label)}: served runtime entry identity is invalid`,
      );
    }
    if (
      localEntry?.exists === true &&
      (entry?.byteLength !== localEntry.byteLength ||
        entry?.sha256 !== localEntry.sha256)
    ) {
      reasons.push(
        `${String(label)}: served runtime entry differs from the local start entry`,
      );
    }
  }

  for (const label of expectedLabels) {
    if ((counts.get(label) ?? 0) !== 1) {
      reasons.push(
        `${label}: expected exactly one served runtime identity, received ${counts.get(label) ?? 0}`,
      );
    }
  }
  if (entries.length !== expectedLabels.length) {
    reasons.push(
      `expected ${expectedLabels.length} served runtime identities, received ${entries.length}`,
    );
  }
  return {
    ok: reasons.length === 0,
    reasons,
    expectedLabels: [...expectedLabels],
    observedLabels: entries.map((entry) => entry?.sessionLabel ?? null),
  };
}

/** Atomically replace the mutable canonical artifact through a unique temp. */
export function atomicReplaceEvidence(file, bytes, operations = fs) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    operations.writeFileSync(temporary, bytes, { flag: "wx" });
    operations.renameSync(temporary, file);
  } finally {
    try {
      operations.unlinkSync(temporary);
    } catch {
      // Preserve the original write/rename error; cleanup is best effort.
    }
  }
}

/** Create a run archive whose UUID-named bytes may never be replaced. */
export function createImmutableEvidence(file, bytes, operations = fs) {
  operations.writeFileSync(file, bytes, { flag: "wx" });
}

/** Apply the write-once first-red policy and fingerprint the retained bytes. */
export function preserveFirstRedEvidence(
  file,
  bytes,
  operations = fs,
  fingerprint = fingerprintEvidenceFile,
) {
  let retained;
  try {
    createImmutableEvidence(file, bytes, operations);
    retained = fingerprint(file, operations);
    assertEvidenceReadableOrAbsent(retained, "new first-red artifact");
    if (retained.exists !== true) {
      throw new Error("new first-red artifact disappeared after creation");
    }
    return { written: true, ...retained };
  } catch (error) {
    if (error?.code === "EEXIST") {
      retained = fingerprint(file, operations);
      assertEvidenceReadableOrAbsent(retained, "retained first-red artifact");
      if (retained.exists !== true) {
        throw new Error(
          "retained first-red artifact disappeared after EEXIST",
          { cause: error },
        );
      }
      return { written: false, ...retained };
    }
    throw error;
  }
}

/**
 * Strips a `file://` (or any other) URL scheme from one source-map `sources`
 * entry and normalises path separators to `/`, so a Windows drive-letter URL
 * (`file:///F:/Dev/...`) and a plain filesystem path both reduce to the same
 * comparable form for {@link relativeSuffixMatches}.
 *
 * @param {string} rawEntry One `sourceMap.sources[i]` value, as written by
 * the bundler — an absolute filesystem path, a relative path, or a `file://`
 * URL, all observed in the wild across bundler/OS combinations.
 * @returns {string} The normalised form, forward-slash-separated.
 */
function normalizeSourceMapEntryForSuffixMatch(rawEntry) {
  let value = String(rawEntry ?? "");
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    value = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
    // `file:///F:/Dev/...` becomes `/F:/Dev/...` once the scheme+authority is
    // stripped; peel the leading slash in front of a Windows drive letter so
    // it lines up with a plain filesystem path (`F:/Dev/...`).
    if (/^\/[a-zA-Z]:\//.test(value)) {
      value = value.slice(1);
    }
    try {
      value = decodeURIComponent(value);
    } catch {
      // Leave percent-escapes intact rather than fail an otherwise-usable path.
    }
  }
  return value.replace(/\\/g, "/");
}

/**
 * True when a source map entry names the same file as `relativeSource` —
 * either because it IS that repository-relative path, or because it is an
 * absolute (or foreign-rooted) path that ENDS with it at a path boundary.
 * The trailing-`/` requirement is what keeps `SomeOtherFixture.js` from
 * matching a search for `Fixture.js`.
 *
 * @param {string} rawEntry One `sourceMap.sources[i]` value.
 * @param {string} relativeSource Forward-slash-separated path, relative to
 * the repository root, e.g. `packages/engine/Source/Scene/Foo.js`.
 * @returns {boolean}
 */
function relativeSuffixMatches(rawEntry, relativeSource) {
  if (relativeSource.length === 0) {
    return false;
  }
  const normalizedEntry = normalizeSourceMapEntryForSuffixMatch(rawEntry);
  return (
    normalizedEntry === relativeSource ||
    normalizedEntry.endsWith(`/${relativeSource}`)
  );
}

/**
 * Compare current source bytes with the exact `sourcesContent` bytes embedded
 * in one JavaScript source map. This is intentionally stricter than marker or
 * mtime checks: a build may contain every expected marker and still predate an
 * unrelated source edit that changes the evidence boundary.
 *
 * Two independent ways for a `sources` entry to identify a tracked file:
 *   - an EXACT absolute-path match against the map's own directory — the
 *     build was produced against the same tree this check runs in;
 *   - a repository-relative SUFFIX match (`relativeSuffixMatches`) — the map
 *     was produced against a different absolute root (a worker clone built
 *     under its own path, then served to a check running against a
 *     different clone or the main repo) but embeds the same repo-relative
 *     path. Q-153 (2026-09-02): a build's source map rooted every entry at
 *     `file:///F:/Dev/GH/cesium-webgpu/...` while the tree being checked was
 *     an Edge clone under a different absolute path; every one of 18 tracked
 *     files reported "absent from build source map" even though the map's
 *     own embedded `sourcesContent` was byte-identical to the clone's files
 *     — the build was current, and the exact-match-only check simply could
 *     not see it. Currency is still decided ONLY by the `sourcesContent`
 *     hash comparison below, run against whichever tree's bytes the caller
 *     passed as `sources` — never by the suffix match itself, which only
 *     locates the entry.
 *
 * @param {object} options
 * @param {object} options.sourceMap Parsed source-map object.
 * @param {string} options.sourceMapPath Path used to resolve source entries.
 * @param {Array<{file: string, bytes: Buffer|string}>} options.sources Current
 * source bytes.
 * @param {string} [options.repoRoot] Repository root each `source.file` is
 * resolved against (for both the absolute-match and the relative-suffix
 * match). Relative `source.file` values resolve against it directly;
 * absolute ones are used as given. Defaults to `process.cwd()`.
 * @returns {{ok: boolean, entries: Array<object>, reasons: Array<string>}}
 */
export function compareBuildSourceIdentity(options) {
  const { sourceMap, sourceMapPath, sources, repoRoot } = options;
  const reasons = [];
  const entries = [];
  const mapSources = Array.isArray(sourceMap?.sources) ? sourceMap.sources : [];
  const contents = Array.isArray(sourceMap?.sourcesContent)
    ? sourceMap.sourcesContent
    : [];
  const mapDirectory = path.dirname(path.resolve(sourceMapPath));
  const root = repoRoot !== undefined ? path.resolve(repoRoot) : process.cwd();

  if (mapSources.length === 0) {
    reasons.push("source map has no sources");
  }
  if (contents.length !== mapSources.length) {
    reasons.push(
      `source map sourcesContent length ${contents.length} does not match sources length ${mapSources.length}`,
    );
  }

  for (const source of sources) {
    const absoluteSource =
      repoRoot !== undefined
        ? path.resolve(root, source.file)
        : path.resolve(source.file);
    const relativeSource = path
      .relative(root, absoluteSource)
      .replace(/\\/g, "/");
    const matches = [];
    const matchKinds = [];
    for (let index = 0; index < mapSources.length; index++) {
      const rawEntry = mapSources[index];
      const isAbsoluteMatch =
        path.resolve(mapDirectory, rawEntry) === absoluteSource;
      const isSuffixMatch =
        !isAbsoluteMatch && relativeSuffixMatches(rawEntry, relativeSource);
      if (isAbsoluteMatch || isSuffixMatch) {
        matches.push(index);
        matchKinds.push(isAbsoluteMatch ? "absolute" : "suffix");
      }
    }

    if (matches.length !== 1) {
      const reason =
        matches.length === 0
          ? "source is absent from build source map"
          : `source resolves to ${matches.length} build source-map entries`;
      reasons.push(`${source.file}: ${reason}`);
      entries.push({
        file: source.file,
        sourceMapEntry: null,
        matchedBy: null,
        currentSha256: sha256(source.bytes),
        embeddedSha256: null,
        exact: false,
        reason,
      });
      continue;
    }

    const index = matches[0];
    const matchedBy = matchKinds[0];
    const embedded = contents[index];
    if (typeof embedded !== "string") {
      const reason = "build source-map entry has no embedded sourcesContent";
      reasons.push(`${source.file}: ${reason}`);
      entries.push({
        file: source.file,
        sourceMapEntry: mapSources[index],
        matchedBy,
        currentSha256: sha256(source.bytes),
        embeddedSha256: null,
        exact: false,
        reason,
      });
      continue;
    }

    const currentBytes = Buffer.isBuffer(source.bytes)
      ? source.bytes
      : Buffer.from(source.bytes);
    const embeddedBytes = Buffer.from(embedded);
    const exact = currentBytes.equals(embeddedBytes);
    const entry = {
      file: source.file,
      sourceMapEntry: mapSources[index],
      matchedBy,
      currentByteLength: currentBytes.byteLength,
      embeddedByteLength: embeddedBytes.byteLength,
      currentSha256: sha256(currentBytes),
      embeddedSha256: sha256(embeddedBytes),
      exact,
      reason: exact
        ? null
        : "current source bytes differ from built sourcesContent",
    };
    entries.push(entry);
    if (!exact) {
      reasons.push(`${source.file}: ${entry.reason}`);
    }
  }

  return { ok: reasons.length === 0, entries, reasons };
}

/**
 * Read and compare a source map from disk, preserving the hashes needed to bind
 * a browser report to the exact build artifact it inspected. Reads current
 * source bytes from the tree actually being checked — `repoRoot` joined with
 * each (typically repo-relative) entry in `sourceFiles` — independent of
 * `process.cwd()`, so currency is proven against the served tree even when
 * the caller runs from elsewhere.
 *
 * @param {object} options
 * @param {string} options.sourceMapPath
 * @param {Array<string>} options.sourceFiles
 * @param {string} [options.repoRoot] Forwarded to
 * {@link compareBuildSourceIdentity} and used to resolve `sourceFiles`
 * entries before reading their bytes. Defaults to `process.cwd()`.
 * @returns {object}
 */
export function inspectBuildSourceIdentity(options) {
  const sourceMapBytes = fs.readFileSync(options.sourceMapPath);
  const sourceMap = JSON.parse(sourceMapBytes.toString("utf8"));
  const { repoRoot } = options;
  const resolveSourceFile = (file) =>
    repoRoot !== undefined ? path.resolve(repoRoot, file) : file;
  const compared = compareBuildSourceIdentity({
    sourceMap,
    sourceMapPath: options.sourceMapPath,
    sources: options.sourceFiles.map((file) => ({
      file,
      bytes: fs.readFileSync(resolveSourceFile(file)),
    })),
    repoRoot,
  });
  return {
    ...compared,
    sourceMapPath: options.sourceMapPath,
    sourceMapByteLength: sourceMapBytes.byteLength,
    sourceMapSha256: sha256(sourceMapBytes),
  };
}
