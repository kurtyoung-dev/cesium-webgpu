// @purpose Records one authorized Node source spec with explicit input identities and durable raw command facts.
// @status ACTIVE

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runBoundedCommand } from "../lib/bounded-command.mjs";
import {
  compareEvidenceFileSnapshots,
  createImmutableEvidence,
  snapshotEvidenceFiles,
} from "./lib/build-source-identity.mjs";
import { ProbeRefusal } from "./lib/probe-refusal.mjs";
import { S5_STATUS_EXIT_CODES } from "./lib/verdict-exit-gate.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const ownPath = fileURLToPath(import.meta.url);

function repoPath(cwd, name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("input paths must be nonempty strings");
  }
  const absolute = path.resolve(cwd, name);
  const relative = path.relative(cwd, absolute);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new TypeError(`input must be inside the repository: ${name}`);
  }
  return absolute;
}

export function sourceCheckExit(raw, comparison) {
  if (
    comparison?.ok !== true ||
    raw == null ||
    typeof raw !== "object" ||
    Array.isArray(raw)
  ) {
    return S5_STATUS_EXIT_CODES.STRUCTURAL;
  }
  // Raw native status is retained separately; the public result describes
  // whether this measurement was valid before folding its source-test result.
  const code = raw.native?.close?.exitCode;
  if (
    raw?.completed !== true ||
    raw?.completion?.reason !== "child-close" ||
    raw?.native?.close?.observed !== true ||
    !Number.isInteger(code) ||
    code < 0 ||
    raw?.native?.close?.signal != null ||
    raw?.native?.childError != null ||
    raw?.native?.spawnError != null ||
    raw?.timeout?.expired !== false ||
    raw?.timeout?.forced !== false ||
    raw?.streamDrain?.timedOut !== false ||
    raw?.streamDrain?.completed !== true ||
    [raw?.stdout, raw?.stderr].some(
      (stream) =>
        stream?.available !== true ||
        stream?.ended !== true ||
        stream?.truncated !== false ||
        stream?.error != null,
    )
  ) {
    return S5_STATUS_EXIT_CODES.ERROR;
  }
  return code === 0 ? S5_STATUS_EXIT_CODES.PASS : S5_STATUS_EXIT_CODES.FAIL;
}

// The caller owns authorization and completeness of the dependency list. This
// adapter records that boundary; it does not infer a transitive source closure.
export async function captureSourceCheck(
  plan,
  artifactDirectory,
  dependencies = {},
) {
  const cwd = dependencies.cwd ?? root;
  const snapshot = dependencies.snapshot ?? snapshotEvidenceFiles;
  const recordCommand = dependencies.recordCommand ?? runBoundedCommand;
  const writeImmutable = dependencies.writeImmutable ?? createImmutableEvidence;
  const spec = repoPath(cwd, plan?.spec);
  if (!spec.endsWith(".spec.mjs") || !Array.isArray(plan?.inputs)) {
    throw new TypeError(
      "plan requires one .spec.mjs and an explicit inputs array",
    );
  }
  const files = Object.fromEntries(
    [
      ...new Set([
        plan.spec,
        ...plan.inputs,
        "package.json",
        "package-lock.json",
      ]),
    ]
      .sort()
      .map((name) => [name, repoPath(cwd, name)]),
  );
  files.$node = process.execPath;
  files.$adapter = ownPath;
  files.$recorder = fileURLToPath(
    new URL("../lib/bounded-command.mjs", import.meta.url),
  );
  files.$identity = fileURLToPath(
    new URL("./lib/build-source-identity.mjs", import.meta.url),
  );
  files.$refusal = fileURLToPath(
    new URL("./lib/probe-refusal.mjs", import.meta.url),
  );
  files.$verdict = fileURLToPath(
    new URL("./lib/verdict-exit-gate.mjs", import.meta.url),
  );
  const before = snapshot(files);
  const readable = compareEvidenceFileSnapshots(before, before);
  if (!readable.ok) {
    throw new ProbeRefusal(
      "source-inputs-unavailable",
      `required inputs unavailable: ${readable.reasons.join("; ")}`,
    );
  }
  const summaryPath = path.join(artifactDirectory, "source-check.json");
  const result = await recordCommand({
    argv: [
      process.execPath,
      "--test",
      "--test-concurrency=1",
      "--experimental-test-isolation=none",
      "--test-timeout=30000",
      spec,
    ],
    cwd,
    artifactPath: path.join(artifactDirectory, "command.jsonl"),
    timeoutMs: 120000,
    terminationGraceMs: 2000,
    streamDrainTimeoutMs: 2000,
    stdoutMaxBytes: 4 * 1024 * 1024,
    stderrMaxBytes: 1024 * 1024,
    startIdentity: { nodeVersion: process.version, inputs: before },
  });
  const after = snapshot(files);
  const comparison = compareEvidenceFileSnapshots(before, after);
  const raw = result?.raw;
  const exitCode = sourceCheckExit(raw, comparison);
  const summary = {
    spec: plan.spec,
    exitCode,
    sourceOnly: true,
    dependencyClosure: "caller-enumerated",
    rawArtifact: result?.artifactPath ?? null,
    before,
    after,
    comparison,
    native: raw?.native ?? null,
    timeout: raw?.timeout ?? null,
  };
  // The recorder has already closed its raw artifact. A failure here cannot
  // discard stdout, stderr or the child's observed exit status.
  writeImmutable(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === ownPath) {
  try {
    if (process.argv.length !== 4) {
      throw new Error(
        "usage: node run-source-check.mjs <plan.json> <new-artifact-directory>",
      );
    }
    const plan = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    // mkdir without recursive is a collision check, not a cleanup operation.
    const directory = path.resolve(process.argv[3]);
    fs.mkdirSync(directory);
    const summary = await captureSourceCheck(plan, directory);
    console.log(
      JSON.stringify({
        spec: summary.spec,
        exitCode: summary.exitCode,
        directory,
      }),
    );
    process.exitCode = summary.exitCode;
  } catch (error) {
    console.error(error);
    process.exitCode =
      error instanceof ProbeRefusal
        ? error.exitCode
        : S5_STATUS_EXIT_CODES.ERROR;
  }
}
