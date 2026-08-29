#!/usr/bin/env node
// @purpose Q-152 — close a multi-batch wave with served-build preflights, smoke/sweep/visual gates, and banked receipts.
// @status ACTIVE

import { promises as fs } from "node:fs";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

export const EXIT_CODES = Object.freeze({
  PASS: 0,
  FAIL: 2,
  REFUSED: 3,
});

export const REFUSAL_REASONS = Object.freeze({
  BAD_ARGUMENT: "BAD_ARGUMENT",
  MISSING_OPTION_VALUE: "MISSING_OPTION_VALUE",
  WAVE_REQUIRED: "WAVE_REQUIRED",
  INVALID_WAVE: "INVALID_WAVE",
  INVALID_PORT: "INVALID_PORT",
  INVALID_BUCKET_PORT: "INVALID_BUCKET_PORT",
  INVALID_RUNS: "INVALID_RUNS",
  PORT_8080_FORBIDDEN: "PORT_8080_FORBIDDEN",
  BASELINE_REASON_REQUIRED: "BASELINE_REASON_REQUIRED",
  ORIGIN_REWRITE_IMPORT_FAILED: "ORIGIN_REWRITE_IMPORT_FAILED",
  ORIGIN_REWRITE_EXPORTS_MISSING: "ORIGIN_REWRITE_EXPORTS_MISSING",
  SERVED_BUILD_PREFLIGHT_IMPORT_FAILED: "SERVED_BUILD_PREFLIGHT_IMPORT_FAILED",
  SERVED_BUILD_PREFLIGHT_FAILED: "SERVED_BUILD_PREFLIGHT_FAILED",
});

const WAVE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REQUIRED_PREFLIGHT_ARTIFACT_COUNT = 2;

export function makeRefusal(name, message) {
  return Object.freeze({
    name,
    message,
    exitCode: EXIT_CODES.REFUSED,
  });
}

export function parseArgs(argv) {
  const args = {
    wave: null,
    port: 8094,
    bucketPort: 8095,
    runs: 1,
    updateBaselines: false,
    reason: null,
    dryRun: false,
    argumentError: null,
  };

  const takeValue = (flag, index) => {
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      if (!args.argumentError) {
        args.argumentError = makeRefusal(
          REFUSAL_REASONS.MISSING_OPTION_VALUE,
          `${flag} requires a value.`,
        );
      }
      return { value: null, nextIndex: index };
    }

    return { value: argv[index + 1], nextIndex: index + 1 };
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    switch (token) {
      case "--wave": {
        const taken = takeValue(token, index);
        args.wave = taken.value;
        index = taken.nextIndex;
        break;
      }

      case "--port": {
        const taken = takeValue(token, index);
        args.port = taken.value === null ? Number.NaN : Number(taken.value);
        index = taken.nextIndex;
        break;
      }

      case "--bucket-port": {
        const taken = takeValue(token, index);
        args.bucketPort =
          taken.value === null ? Number.NaN : Number(taken.value);
        index = taken.nextIndex;
        break;
      }

      case "--runs": {
        const taken = takeValue(token, index);
        args.runs = taken.value === null ? Number.NaN : Number(taken.value);
        index = taken.nextIndex;
        break;
      }

      case "--reason": {
        const taken = takeValue(token, index);
        args.reason = taken.value?.trim() || null;
        index = taken.nextIndex;
        break;
      }

      case "--update-baselines":
        args.updateBaselines = true;
        break;

      case "--dry-run":
        args.dryRun = true;
        break;

      default:
        if (!args.argumentError) {
          args.argumentError = makeRefusal(
            REFUSAL_REASONS.BAD_ARGUMENT,
            `Unknown argument: ${token}`,
          );
        }
        break;
    }
  }

  return args;
}

function isValidPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function decideArgumentRefusal(args) {
  if (args.argumentError) {
    return args.argumentError;
  }

  if (!args.wave) {
    return makeRefusal(
      REFUSAL_REASONS.WAVE_REQUIRED,
      "--wave <id> is required.",
    );
  }

  if (!WAVE_PATTERN.test(args.wave)) {
    return makeRefusal(
      REFUSAL_REASONS.INVALID_WAVE,
      "--wave must contain only letters, digits, dots, underscores, and hyphens.",
    );
  }

  if (!isValidPort(args.port)) {
    return makeRefusal(
      REFUSAL_REASONS.INVALID_PORT,
      "--port must be an integer from 1 through 65535.",
    );
  }

  if (!isValidPort(args.bucketPort)) {
    return makeRefusal(
      REFUSAL_REASONS.INVALID_BUCKET_PORT,
      "--bucket-port must be an integer from 1 through 65535.",
    );
  }

  if (args.port === 8080 || args.bucketPort === 8080) {
    return makeRefusal(
      REFUSAL_REASONS.PORT_8080_FORBIDDEN,
      "Port 8080 is forbidden for the wave-end gate.",
    );
  }

  if (!Number.isInteger(args.runs) || args.runs < 1) {
    return makeRefusal(
      REFUSAL_REASONS.INVALID_RUNS,
      "--runs must be a positive integer.",
    );
  }

  if (args.updateBaselines && !args.reason) {
    return makeRefusal(
      REFUSAL_REASONS.BASELINE_REASON_REQUIRED,
      '--update-baselines requires --reason "<text>".',
    );
  }

  return null;
}

export function decideOriginRewriteRefusal(moduleNamespace) {
  if (
    typeof moduleNamespace?.installOriginRewrite !== "function" ||
    typeof moduleNamespace?.createGuardedPage !== "function"
  ) {
    return makeRefusal(
      REFUSAL_REASONS.ORIGIN_REWRITE_EXPORTS_MISSING,
      "Tools/visual-regression/lib/sandcastle2-origin-rewrite.mjs must export installOriginRewrite and createGuardedPage.",
    );
  }

  return null;
}

function quoteCommandArgument(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:@-]+$/.test(text) ? text : JSON.stringify(text);
}

function formatNodeCommand(file, args) {
  return ["node", file, ...args].map(quoteCommandArgument).join(" ");
}

export function buildStepPlan(args) {
  const servedUrl = `http://localhost:${args.port}`;

  const sweepEnvironment = {
    PORT: String(args.port),
    CESIUM_PORT: String(args.port),
    CESIUM_SERVER_PORT: String(args.port),
    SANDCASTLE2_PORT: String(args.port),
    BUCKET_PORT: String(args.bucketPort),
    SANDCASTLE_BUCKET_PORT: String(args.bucketPort),
    SANDCASTLE2_BUCKET_PORT: String(args.bucketPort),
  };

  const definitions = [
    {
      name: "variant-smoke-test",
      file: "Tools/variant-smoke-test.mjs",
      args: ["--url", servedUrl],
      env: {},
    },
    {
      name: "sandcastle2-sweep-webgl",
      file: "Tools/sandcastle2-sweep-probe.mjs",
      args: ["--renderer", "webgl", "--runs", String(args.runs)],
      env: sweepEnvironment,
    },
    {
      name: "sandcastle2-sweep-webgpu",
      file: "Tools/sandcastle2-sweep-probe.mjs",
      args: ["--renderer", "webgpu", "--runs", String(args.runs)],
      env: sweepEnvironment,
    },
    {
      name: "visual-regression",
      file: "Tools/visual-regression/capture-and-diff.mjs",
      args: args.updateBaselines
        ? [
            "--update",
            "--confirm-baseline-promotion",
            "--update-rationale",
            args.reason,
            "--reviewed-by",
            `wave-end-gate:${args.wave}`,
          ]
        : [],
      env: {},
    },
  ];

  return definitions.map((definition) => ({
    ...definition,
    command: formatNodeCommand(definition.file, definition.args),
  }));
}

export function verdictFromExitCodes(exitCodes) {
  return exitCodes.every((exitCode) => exitCode === 0) ? "PASS" : "FAIL";
}

export function buildReceipt({
  wave,
  startedAt,
  finishedAt,
  tip,
  servedMd5,
  steps,
  updateBaselines,
  reason,
  verdict,
}) {
  return {
    wave,
    startedAt,
    finishedAt,
    tip,
    servedMd5: { ...servedMd5 },
    steps: steps.map(({ name, command, exitCode, wallMs }) => ({
      name,
      command,
      exitCode,
      wallMs,
    })),
    baselineUpdate: {
      requested: Boolean(updateBaselines),
      reason: updateBaselines ? (reason ?? null) : null,
    },
    verdict,
  };
}

export function decidePreflightRefusal(records) {
  if (
    !Array.isArray(records) ||
    records.length < REQUIRED_PREFLIGHT_ARTIFACT_COUNT
  ) {
    return makeRefusal(
      REFUSAL_REASONS.SERVED_BUILD_PREFLIGHT_FAILED,
      `Served-build preflight must verify at least ${REQUIRED_PREFLIGHT_ARTIFACT_COUNT} bundles.`,
    );
  }

  const failed = records.filter((record) => record.passed !== true);
  if (failed.length > 0) {
    const names = failed.map((record) => record.name).join(", ");
    return makeRefusal(
      REFUSAL_REASONS.SERVED_BUILD_PREFLIGHT_FAILED,
      `Served-build preflight failed for: ${names}.`,
    );
  }

  return null;
}

function artifactName(artifact, index) {
  if (typeof artifact === "string") {
    return artifact;
  }

  return (
    artifact?.name ??
    artifact?.label ??
    artifact?.servedPath ??
    artifact?.urlPath ??
    artifact?.pathname ??
    artifact?.diskPath ??
    `artifact-${index + 1}`
  );
}

function artifactText(artifact) {
  if (typeof artifact === "string") {
    return artifact;
  }

  try {
    return JSON.stringify(artifact);
  } catch {
    return String(artifact);
  }
}

function isBucketArtifact(artifact, index) {
  const text = artifactText(artifact).toLowerCase();
  return (
    text.includes("packages/engine/") ||
    text.includes("sandcastle2") ||
    text.includes("bucket") ||
    index > 0
  );
}

function findNamedValue(value, acceptedNames, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return undefined;
  }

  seen.add(value);

  for (const [key, child] of Object.entries(value)) {
    if (acceptedNames.has(key.toLowerCase())) {
      return child;
    }
  }

  for (const child of Object.values(value)) {
    const found = findNamedValue(child, acceptedNames, seen);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function containsExplicitFailure(value, seen = new Set()) {
  if (value === false) {
    return true;
  }

  if (value === null || typeof value !== "object" || seen.has(value)) {
    return false;
  }

  seen.add(value);

  const falseMeansFailure = new Set([
    "ok",
    "pass",
    "passed",
    "match",
    "matches",
    "matched",
    "md5matches",
  ]);

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();

    if (falseMeansFailure.has(normalizedKey) && child === false) {
      return true;
    }

    if (
      normalizedKey === "status" &&
      typeof child === "string" &&
      /^(fail|failed|failure|mismatch|refused|error)$/i.test(child)
    ) {
      return true;
    }

    if (normalizedKey === "error" && child) {
      return true;
    }

    if (containsExplicitFailure(child, seen)) {
      return true;
    }
  }

  return false;
}

function normalizePreflightRecord(artifact, index, result, error = null) {
  const servedMd5 = findNamedValue(
    result,
    new Set(["servedmd5", "fetchedmd5", "remotemd5"]),
  );
  const diskMd5 = findNamedValue(
    result,
    new Set(["diskmd5", "localmd5", "expectedmd5"]),
  );

  let passed = !error && !containsExplicitFailure(result);
  if (passed && typeof servedMd5 === "string" && typeof diskMd5 === "string") {
    passed = servedMd5 === diskMd5;
  }

  return {
    name: artifactName(artifact, index),
    passed,
    servedMd5: typeof servedMd5 === "string" ? servedMd5 : null,
    error: error ? String(error.message ?? error) : null,
  };
}

async function runServedBuildPreflights(
  preflightModule,
  { projectRoot, port, bucketPort },
) {
  const artifacts = preflightModule.DEFAULT_SERVED_BUILD_ARTIFACTS;
  if (!Array.isArray(artifacts)) {
    return [];
  }

  const records = [];

  for (const [index, artifact] of artifacts.entries()) {
    const selectedPort = isBucketArtifact(artifact, index) ? bucketPort : port;
    const origin = `http://localhost:${selectedPort}/`;

    const options = {
      artifacts: [artifact],
      origin,
      baseOrigin: origin,
      baseUrl: origin,
      serverOrigin: origin,
      servedOrigin: origin,
      port: selectedPort,
      rootDir: projectRoot,
      projectRoot,
      repositoryRoot: projectRoot,
      cwd: projectRoot,
      fetchImpl: globalThis.fetch,
    };

    try {
      const result =
        await preflightModule.preflightServedBuildArtifacts(options);
      records.push(normalizePreflightRecord(artifact, index, result));
    } catch (error) {
      records.push(normalizePreflightRecord(artifact, index, null, error));
    }
  }

  return records;
}

async function runStep(step, projectRoot) {
  const started = process.hrtime.bigint();

  const exitCode = await new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (!settled) {
        settled = true;
        resolve(code);
      }
    };

    const child = spawn(process.execPath, [step.file, ...step.args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...step.env,
      },
      stdio: "inherit",
      windowsHide: true,
    });

    child.once("error", () => finish(1));
    child.once("close", (code) => finish(Number.isInteger(code) ? code : 1));
  });

  const wallMs = Number((process.hrtime.bigint() - started) / 1_000_000n);

  return {
    name: step.name,
    command: step.command,
    exitCode,
    wallMs,
  };
}

async function readGitTip(projectRoot) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      windowsHide: true,
    });
    return stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function markdownCell(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}

export function buildMarkdownSummary(
  receipt,
  { refusal = null, dryRun = false, plannedSteps = [] } = {},
) {
  const lines = [
    `# Wave-end gate: ${receipt.wave}`,
    "",
    `- Verdict: **${receipt.verdict}**`,
    `- Started: ${receipt.startedAt}`,
    `- Finished: ${receipt.finishedAt}`,
    `- Git tip: \`${receipt.tip}\``,
    `- Baseline update requested: ${receipt.baselineUpdate.requested ? "yes" : "no"}`,
    `- Baseline reason: ${receipt.baselineUpdate.reason ?? "n/a"}`,
  ];

  if (refusal) {
    lines.push(
      `- Refusal: **${refusal.name}** — ${markdownCell(refusal.message)}`,
    );
  }

  if (dryRun) {
    lines.push(
      "- Dry run: child processes were not executed; commands below are the planned steps.",
    );
  }

  lines.push("", "## Served-build MD5", "");

  const md5Entries = Object.entries(receipt.servedMd5);
  if (md5Entries.length === 0) {
    lines.push("No served-build MD5 values were recorded.");
  } else {
    lines.push("| Artifact | Served MD5 |", "| --- | --- |");
    for (const [name, md5] of md5Entries) {
      lines.push(
        `| ${markdownCell(name)} | ${markdownCell(md5 ?? "unavailable")} |`,
      );
    }
  }

  lines.push("", "## Steps", "");

  const displayedSteps = dryRun
    ? plannedSteps.map((step) => ({
        name: step.name,
        command: step.command,
        exitCode: "not run",
        wallMs: "not run",
      }))
    : receipt.steps;

  if (displayedSteps.length === 0) {
    lines.push("No child steps were executed.");
  } else {
    lines.push(
      "| Step | Command | Exit code | Wall time (ms) |",
      "| --- | --- | ---: | ---: |",
    );
    for (const step of displayedSteps) {
      lines.push(
        `| ${markdownCell(step.name)} | \`${markdownCell(step.command)}\` | ${markdownCell(step.exitCode)} | ${markdownCell(step.wallMs)} |`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

async function writeReceiptFiles(toolsDir, receipt, summaryOptions = {}) {
  const outputDirectory = path.join(
    toolsDir,
    "visual-regression",
    "output",
    "wave-end",
    receipt.wave,
  );

  await fs.mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(outputDirectory, "receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8",
    ),
    fs.writeFile(
      path.join(outputDirectory, "summary.md"),
      buildMarkdownSummary(receipt, summaryOptions),
      "utf8",
    ),
  ]);
}

function servedMd5FromRecords(records) {
  return Object.fromEntries(
    records.map((record) => [record.name, record.servedMd5]),
  );
}

async function finishRefusal({
  args,
  refusal,
  startedAt,
  toolsDir,
  projectRoot,
  servedMd5 = {},
}) {
  const receipt = buildReceipt({
    wave: args.wave,
    startedAt,
    finishedAt: new Date().toISOString(),
    tip: await readGitTip(projectRoot),
    servedMd5,
    steps: [],
    updateBaselines: args.updateBaselines,
    reason: args.reason,
    verdict: "REFUSED",
  });

  if (typeof args.wave === "string" && WAVE_PATTERN.test(args.wave)) {
    await writeReceiptFiles(toolsDir, receipt, { refusal });
  }

  console.error(`REFUSED [${refusal.name}]: ${refusal.message}`);
  return EXIT_CODES.REFUSED;
}

export async function main(argv = process.argv.slice(2)) {
  const startedAt = new Date().toISOString();
  const args = parseArgs(argv);
  const toolsDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(toolsDir, "..");

  let refusal = decideArgumentRefusal(args);
  if (refusal) {
    return finishRefusal({
      args,
      refusal,
      startedAt,
      toolsDir,
      projectRoot,
    });
  }

  let originRewriteModule;
  try {
    originRewriteModule = await import(
      new URL(
        "./visual-regression/lib/sandcastle2-origin-rewrite.mjs",
        import.meta.url,
      )
    );
  } catch (error) {
    refusal = makeRefusal(
      REFUSAL_REASONS.ORIGIN_REWRITE_IMPORT_FAILED,
      `Could not import the Sandcastle2 origin-rewrite helper: ${error.message}`,
    );
    return finishRefusal({
      args,
      refusal,
      startedAt,
      toolsDir,
      projectRoot,
    });
  }

  refusal = decideOriginRewriteRefusal(originRewriteModule);
  if (refusal) {
    return finishRefusal({
      args,
      refusal,
      startedAt,
      toolsDir,
      projectRoot,
    });
  }

  let preflightModule;
  try {
    preflightModule = await import(
      new URL(
        "./visual-regression/lib/served-build-preflight.mjs",
        import.meta.url,
      )
    );
    if (typeof preflightModule.preflightServedBuildArtifacts !== "function") {
      throw new TypeError(
        "preflightServedBuildArtifacts is not exported as a function",
      );
    }
  } catch (error) {
    refusal = makeRefusal(
      REFUSAL_REASONS.SERVED_BUILD_PREFLIGHT_IMPORT_FAILED,
      `Could not import the served-build preflight: ${error.message}`,
    );
    return finishRefusal({
      args,
      refusal,
      startedAt,
      toolsDir,
      projectRoot,
    });
  }

  const preflightRecords = await runServedBuildPreflights(preflightModule, {
    projectRoot,
    port: args.port,
    bucketPort: args.bucketPort,
  });
  const servedMd5 = servedMd5FromRecords(preflightRecords);

  refusal = decidePreflightRefusal(preflightRecords);
  if (refusal) {
    return finishRefusal({
      args,
      refusal,
      startedAt,
      toolsDir,
      projectRoot,
      servedMd5,
    });
  }

  const plan = buildStepPlan(args);
  const steps = [];

  if (args.dryRun) {
    for (const step of plan) {
      console.log(step.command);
    }
  } else {
    for (const step of plan) {
      steps.push(await runStep(step, projectRoot));
    }
  }

  const verdict = verdictFromExitCodes(steps.map((step) => step.exitCode));
  const receipt = buildReceipt({
    wave: args.wave,
    startedAt,
    finishedAt: new Date().toISOString(),
    tip: await readGitTip(projectRoot),
    servedMd5,
    steps,
    updateBaselines: args.updateBaselines,
    reason: args.reason,
    verdict,
  });

  await writeReceiptFiles(toolsDir, receipt, {
    dryRun: args.dryRun,
    plannedSteps: plan,
  });

  return verdict === "PASS" ? EXIT_CODES.PASS : EXIT_CODES.FAIL;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(`REFUSED [UNEXPECTED_GATE_ERROR]: ${error.stack ?? error}`);
      process.exitCode = EXIT_CODES.REFUSED;
    });
}
