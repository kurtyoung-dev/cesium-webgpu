#!/usr/bin/env node
/**
 * Append-only visual-evidence library CLI.
 *
 * Local `Tools/visual-regression/output` directories remain probe-owned
 * scratch/transaction space. This command runs only after a producer exits and
 * publishes stable bytes into an external content-addressed library.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  StructuralEvidenceError,
  archiveVisualEvidence,
  buildVisualEvidenceCatalog,
  collectRepositoryProvenance,
  deriveDefaultVisualEvidenceRoot,
  planVisualEvidenceLibraryUpgrade,
  planVisualEvidenceArchive,
  upgradeVisualEvidenceLibrary,
  verifyVisualEvidenceLibrary,
} from "./lib/visual-evidence-library.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, "..", "..");

export class VisualEvidenceUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "VisualEvidenceUsageError";
    this.code = "VISUAL_EVIDENCE_USAGE";
  }
}

function usage() {
  return `Usage:
  node Tools/visual-regression/visual-evidence-library.mjs archive [options]
  node Tools/visual-regression/visual-evidence-library.mjs import-legacy [options]
  node Tools/visual-regression/visual-evidence-library.mjs verify [options]
  node Tools/visual-regression/visual-evidence-library.mjs catalog [options]
  node Tools/visual-regression/visual-evidence-library.mjs upgrade [--apply] [options]

Common options:
  --source-root DIR       Worktree root (default: current script repository)
  --library-root DIR      Shared library root (default: external sibling derived
                          from the Git common directory)
  --guard-root DIR        Directory scanned for active *.lock files
  --help                  Show this help

archive options:
  --producer TOKEN        Stable probe/producer name (required)
  --run-id TOKEN          Immutable producer run identity (required)
  --status STATUS         PASS|FAIL|ERROR|STRUCTURAL|NON_CERTIFYING|UNKNOWN
  --exit-code N           Exact source process exit code, 0..255
  --artifact FILE         Authoritative final JSON artifact (required)
  --file FILE             Additional file; repeat as needed
  --directory DIR         Recursively include regular files; repeat as needed
  --command TEXT          Optional sanitized source command
  --dry-run               Check and fingerprint sources without writing anything

import-legacy options:
  --namespace TOKEN       Explicit legacy import namespace (required)
  --producer TOKEN        Stable source/probe name (required)
  --run-id TOKEN          Import identity (default: generated UUID)
  --reason TEXT           Why these older bytes are being retained (required)
  --file FILE             File to import; repeat as needed
  --directory DIR         Recursively include regular files; repeat as needed

upgrade options:
  --apply                 Build, verify, and atomically swap the upgraded store
                          (without this flag, upgrade is a read-only plan)

Exit: 0 success; 2 CLI/exception; 3 structural or integrity refusal.

Archival never changes a source verdict and never promotes a baseline.`;
}

function requireValue(values, index, option) {
  const value = values[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new VisualEvidenceUsageError(`${option} requires a value`);
  }
  return value;
}

export function parseVisualEvidenceArguments(argv) {
  const values = [...argv];
  const command = values.shift();
  if (!command || command === "--help" || command === "-h") {
    return { help: true, command: null };
  }
  if (
    !["archive", "import-legacy", "verify", "catalog", "upgrade"].includes(
      command,
    )
  ) {
    throw new VisualEvidenceUsageError(`unknown command ${command}`);
  }
  const options = {
    help: false,
    command,
    sourceRoot: REPOSITORY_ROOT,
    libraryRoot: null,
    guardRoot: null,
    producer: null,
    runId: null,
    status: null,
    exitCode: null,
    artifact: null,
    files: [],
    directories: [],
    sourceCommand: null,
    namespace: null,
    reason: null,
    dryRun: false,
    apply: false,
  };
  for (let index = 0; index < values.length; index++) {
    const argument = values[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--source-root") {
      options.sourceRoot = path.resolve(requireValue(values, index, argument));
      index++;
    } else if (argument === "--library-root") {
      options.libraryRoot = path.resolve(requireValue(values, index, argument));
      index++;
    } else if (argument === "--guard-root") {
      options.guardRoot = requireValue(values, index, argument);
      index++;
    } else if (argument === "--producer") {
      options.producer = requireValue(values, index, argument);
      index++;
    } else if (argument === "--run-id") {
      options.runId = requireValue(values, index, argument);
      index++;
    } else if (argument === "--status") {
      options.status = requireValue(values, index, argument);
      index++;
    } else if (argument === "--exit-code") {
      const value = requireValue(values, index, argument);
      if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
        throw new VisualEvidenceUsageError(
          "--exit-code must be a non-negative base-10 integer",
        );
      }
      options.exitCode = Number.parseInt(value, 10);
      index++;
    } else if (argument === "--artifact") {
      options.artifact = requireValue(values, index, argument);
      index++;
    } else if (argument === "--file") {
      options.files.push(requireValue(values, index, argument));
      index++;
    } else if (argument === "--directory") {
      options.directories.push(requireValue(values, index, argument));
      index++;
    } else if (argument === "--command") {
      options.sourceCommand = requireValue(values, index, argument);
      index++;
    } else if (argument === "--namespace") {
      options.namespace = requireValue(values, index, argument);
      index++;
    } else if (argument === "--reason") {
      options.reason = requireValue(values, index, argument);
      index++;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--apply") {
      options.apply = true;
    } else {
      throw new VisualEvidenceUsageError(`unknown option ${argument}`);
    }
  }
  return options;
}

function rejectOptions(options, names) {
  const present = names.filter((name) => {
    const value = options[name];
    return Array.isArray(value) ? value.length > 0 : value !== null;
  });
  if (present.length > 0) {
    throw new VisualEvidenceUsageError(
      `${options.command} does not accept ${present.join(", ")}`,
    );
  }
}

function validateCommandOptions(options) {
  if (options.help) {
    return;
  }
  if (options.command === "archive") {
    for (const [name, value] of [
      ["--producer", options.producer],
      ["--run-id", options.runId],
      ["--status", options.status],
      ["--artifact", options.artifact],
    ]) {
      if (!value) {
        throw new VisualEvidenceUsageError(`${name} is required for archive`);
      }
    }
    if (!Number.isInteger(options.exitCode)) {
      throw new VisualEvidenceUsageError(
        "--exit-code is required for archive and must be an integer",
      );
    }
    rejectOptions(options, ["namespace", "reason"]);
    if (options.apply) {
      throw new VisualEvidenceUsageError("--apply is accepted only by upgrade");
    }
  } else if (options.command === "import-legacy") {
    for (const [name, value] of [
      ["--namespace", options.namespace],
      ["--producer", options.producer],
      ["--reason", options.reason],
    ]) {
      if (!value) {
        throw new VisualEvidenceUsageError(
          `${name} is required for import-legacy`,
        );
      }
    }
    if (options.files.length === 0 && options.directories.length === 0) {
      throw new VisualEvidenceUsageError(
        "import-legacy requires --file or --directory",
      );
    }
    rejectOptions(options, ["status", "artifact", "sourceCommand"]);
    if (options.exitCode !== null) {
      throw new VisualEvidenceUsageError(
        "import-legacy does not accept --exit-code",
      );
    }
    if (options.apply) {
      throw new VisualEvidenceUsageError("--apply is accepted only by upgrade");
    }
  } else if (options.command === "upgrade") {
    rejectOptions(options, [
      "producer",
      "runId",
      "status",
      "artifact",
      "sourceCommand",
      "namespace",
      "reason",
    ]);
    if (
      options.exitCode !== null ||
      options.files.length > 0 ||
      options.directories.length > 0 ||
      options.guardRoot !== null
    ) {
      throw new VisualEvidenceUsageError(
        "upgrade accepts only --source-root, --library-root, and --apply",
      );
    }
  } else {
    rejectOptions(options, [
      "producer",
      "runId",
      "status",
      "artifact",
      "sourceCommand",
      "namespace",
      "reason",
    ]);
    if (
      options.exitCode !== null ||
      options.files.length > 0 ||
      options.directories.length > 0 ||
      options.guardRoot !== null
    ) {
      throw new VisualEvidenceUsageError(
        `${options.command} accepts only --source-root and --library-root`,
      );
    }
    if (options.apply) {
      throw new VisualEvidenceUsageError("--apply is accepted only by upgrade");
    }
  }
  if (options.dryRun && options.command !== "archive") {
    throw new VisualEvidenceUsageError("--dry-run is accepted only by archive");
  }
}

export function runVisualEvidenceCommand(options, dependencies = {}) {
  validateCommandOptions(options);
  if (options.help) {
    return { kind: "help", text: usage() };
  }
  const operations = dependencies.operations ?? fs;
  const now = dependencies.now ?? (() => new Date());
  const libraryRoot =
    options.libraryRoot ??
    deriveDefaultVisualEvidenceRoot(options.sourceRoot, operations);
  if (options.command === "verify") {
    return {
      kind: "verify",
      report: verifyVisualEvidenceLibrary({ libraryRoot }, { operations, now }),
    };
  }
  if (options.command === "catalog") {
    return {
      kind: "catalog",
      catalog: buildVisualEvidenceCatalog({ libraryRoot }, { operations, now }),
    };
  }
  if (options.command === "upgrade") {
    return options.apply
      ? {
          kind: "upgrade",
          result: upgradeVisualEvidenceLibrary(
            { libraryRoot },
            { operations, now },
          ),
        }
      : {
          kind: "upgrade-plan",
          plan: planVisualEvidenceLibraryUpgrade(
            { libraryRoot },
            { operations, now },
          ),
        };
  }
  const provenanceCollector =
    dependencies.provenanceCollector ??
    ((repositoryRoot) =>
      collectRepositoryProvenance(repositoryRoot, { operations, now }));
  if (options.command === "archive") {
    const archiveOptions = {
      kind: "run",
      sourceRoot: options.sourceRoot,
      libraryRoot,
      guardRoot: options.guardRoot,
      producer: options.producer,
      runId: options.runId,
      status: options.status,
      exitCode: options.exitCode,
      artifact: options.artifact,
      files: options.files,
      directories: options.directories,
      command: options.sourceCommand,
    };
    if (options.dryRun) {
      return {
        kind: "dry-run",
        plan: planVisualEvidenceArchive(archiveOptions, {
          operations,
          now,
          provenanceCollector,
        }),
      };
    }
    return {
      kind: "archive",
      result: archiveVisualEvidence(archiveOptions, {
        operations,
        now,
        provenanceCollector,
      }),
    };
  }
  return {
    kind: "import-legacy",
    result: archiveVisualEvidence(
      {
        kind: "legacy-import",
        sourceRoot: options.sourceRoot,
        libraryRoot,
        guardRoot: options.guardRoot,
        namespace: options.namespace,
        producer: options.producer,
        runId: options.runId ?? randomUUID(),
        reason: options.reason,
        status: "NON_CERTIFYING",
        exitCode: null,
        files: options.files,
        directories: options.directories,
      },
      { operations, now, provenanceCollector },
    ),
  };
}

function printCommandResult(result) {
  if (result.kind === "help") {
    console.log(result.text);
  } else if (result.kind === "verify") {
    console.log(JSON.stringify(result.report, null, 2));
    if (!result.report.valid) {
      process.exitCode = 3;
    }
  } else if (result.kind === "catalog") {
    console.log(JSON.stringify(result.catalog, null, 2));
  } else if (result.kind === "dry-run" || result.kind === "upgrade-plan") {
    console.log(JSON.stringify(result.plan, null, 2));
  } else if (result.kind === "upgrade") {
    console.log(
      JSON.stringify({ command: result.kind, ...result.result }, null, 2),
    );
  } else {
    console.log(
      JSON.stringify(
        {
          command: result.kind,
          publicationPath: result.result.manifest.publicationPath,
          status: result.result.manifest.result.status,
          manifestSha256: result.result.manifestSha256,
          files: result.result.manifest.files.length,
          objects: result.result.objectCount,
          reusedObjects: result.result.reusedObjectCount,
        },
        null,
        2,
      ),
    );
  }
}

export function main(argv = process.argv.slice(2), dependencies = {}) {
  const parsed = parseVisualEvidenceArguments(argv);
  const result = runVisualEvidenceCommand(parsed, dependencies);
  printCommandResult(result);
  return result;
}

const invokedAsScript =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (invokedAsScript) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exitCode =
      error instanceof StructuralEvidenceError
        ? 3
        : error instanceof VisualEvidenceUsageError
          ? 2
          : 2;
  }
}
