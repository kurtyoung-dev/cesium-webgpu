import { readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const TRACKED_SPEC_PATHS = [
  ":(glob)Tools/**/*.spec.mjs",
  ":(glob)scripts/**/*.spec.mjs",
  ":(glob)Specs/**/*.spec.mjs",
  ":(glob)packages/*/Specs/**/*.spec.mjs",
  ":(glob)packages/*/Specs/**/*Spec.mjs",
];

const STAR_PATTERN = "[^/]*";

function normalizeSlashes(value) {
  return String(value).replaceAll("\\", "/");
}

function toRepoRelative(value, cwd) {
  const normalized = normalizeSlashes(value);
  const nativePath =
    path.sep === "\\" ? normalized.replaceAll("/", "\\") : normalized;
  const absolutePath = path.isAbsolute(nativePath)
    ? nativePath
    : path.resolve(cwd, nativePath);

  return normalizeSlashes(path.relative(cwd, absolutePath)).replace(
    /^\.\//u,
    "",
  );
}

function isCensusSpecFile(file) {
  const normalized = normalizeSlashes(file);

  if (/^(?:Tools|scripts|Specs)\/.+\.spec\.mjs$/u.test(normalized)) {
    return true;
  }

  return /^packages\/[^/]+\/Specs\/.+(?:\.spec|Spec)\.mjs$/u.test(normalized);
}

export function listTrackedSpecFiles(cwd = process.cwd()) {
  const output = execFileSync(
    "git",
    ["ls-files", "--", ...TRACKED_SPEC_PATHS],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  );

  return [
    ...new Set(
      output
        .split(/\r?\n/u)
        .filter(Boolean)
        .map(normalizeSlashes)
        .filter(isCensusSpecFile),
    ),
  ].sort();
}

function escapeRegexCharacter(character) {
  return "\\^$+?.()|{}[]".includes(character) ? `\\${character}` : character;
}

function globToRegExp(glob) {
  const pattern = normalizeSlashes(glob);
  let source = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];

    if (character !== "*") {
      source += escapeRegexCharacter(character);
      continue;
    }

    if (pattern[index + 1] !== "*") {
      source += STAR_PATTERN;
      continue;
    }

    if (pattern[index + 2] === "/") {
      source += "(?:[^/]+/)*";
      index += 2;
    } else {
      source += ".*";
      index += 1;
    }
  }

  source += "$";
  return new RegExp(source, "u");
}

export function globMatches(glob, candidate) {
  return globToRegExp(glob).test(normalizeSlashes(candidate));
}

function tokenizeCommand(command) {
  const tokens = [];
  let value = "";
  let quote = null;
  let quoted = false;
  let started = false;

  const pushToken = () => {
    if (started) {
      tokens.push({ value, quoted });
    }
    value = "";
    quoted = false;
    started = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (quote !== null) {
      if (character === quote) {
        quote = null;
        continue;
      }

      if (
        quote === '"' &&
        character === "\\" &&
        (command[index + 1] === '"' || command[index + 1] === "\\")
      ) {
        value += command[index + 1];
        index += 1;
      } else {
        value += character;
      }

      started = true;
      continue;
    }

    if (/\s/u.test(character)) {
      pushToken();
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      quoted = true;
      started = true;
      continue;
    }

    if (
      character === "\\" &&
      index + 1 < command.length &&
      /\s/u.test(command[index + 1])
    ) {
      value += command[index + 1];
      index += 1;
      started = true;
      continue;
    }

    value += character;
    started = true;
  }

  pushToken();
  return tokens;
}

function parseNodeTestCommand(command) {
  if (
    typeof command !== "string" ||
    !/^\s*node\s+--test(?:\s|$)/u.test(command)
  ) {
    return null;
  }

  const tokens = tokenizeCommand(command);
  if (tokens[0]?.value !== "node" || tokens[1]?.value !== "--test") {
    return null;
  }

  const selectors = [];
  const shellOperators = new Set(["&", "&&", "|", "||", ";"]);

  for (const token of tokens.slice(2)) {
    if (shellOperators.has(token.value)) {
      break;
    }
    if (token.value === "--" || token.value.startsWith("-")) {
      continue;
    }
    selectors.push(token);
  }

  return selectors;
}

function selectorMatchesFile(selector, file, cwd) {
  const relativeSelector = toRepoRelative(selector.value, cwd);

  if (
    !relativeSelector ||
    relativeSelector === ".." ||
    relativeSelector.startsWith("../")
  ) {
    return false;
  }

  if (relativeSelector.includes("*")) {
    return globMatches(relativeSelector, file);
  }

  return relativeSelector === file;
}

export function proposedHomeFor(file) {
  const normalized = normalizeSlashes(file);
  const fileName = path.posix.basename(normalized).toLowerCase();

  if (normalized.startsWith("Tools/visual-regression/")) {
    if (
      fileName.startsWith("c12-29-") ||
      fileName.includes("replacement-device")
    ) {
      return "test-s5 (proposed new script)";
    }

    if (fileName.startsWith("sandcastle2-")) {
      return "test-sandcastle";
    }

    if (fileName.includes("readiness") || fileName.includes("pipeline")) {
      return "test-readiness";
    }

    if (fileName.includes("blend")) {
      return "test-blend-parity";
    }

    return "test-visual-regression-node (proposed new script)";
  }

  if (normalized.startsWith("Tools/c16/")) {
    return "test-c16";
  }

  if (
    normalized.startsWith("Tools/build-infra/") ||
    normalized.startsWith("scripts/__tests__/")
  ) {
    return "test-build-infra";
  }

  if (normalized.startsWith("Tools/readme-screenshots/")) {
    return "test-readme-screenshots (proposed new script)";
  }

  if (
    /^Tools\/(?:landing-rules|pre-push-guard|provision-worker-clone-junctions|verify-landing-compliance)\.spec\.mjs$/u.test(
      normalized,
    )
  ) {
    return "test-landing-rules";
  }

  if (
    /^Tools\/(?:inject-purpose-headers|generate-tooling-catalog)\.spec\.mjs$/u.test(
      normalized,
    )
  ) {
    return "test-tooling-catalog";
  }

  if (normalized.startsWith("packages/engine/Specs/Renderer/WebGPU/")) {
    return "test-model-webgpu";
  }

  if (normalized.startsWith("packages/engine/Specs/Scene/")) {
    return "test-scene-node";
  }

  if (normalized.startsWith("packages/sandcastle/Specs/")) {
    return "test-sandcastle";
  }

  if (normalized === "Specs/webgpuPolicy.spec.mjs") {
    return "test-webgpu-policy";
  }

  const packageMatch = /^packages\/([^/]+)\/Specs\//u.exec(normalized);
  if (packageMatch) {
    const packageName = packageMatch[1]
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-");
    return `test-${packageName}-node (proposed new script)`;
  }

  if (normalized.startsWith("Specs/")) {
    return "test-specs-node (proposed new script)";
  }

  if (normalized.startsWith("scripts/")) {
    return "test-scripts-node (proposed new script)";
  }

  return "test-tools-node (proposed new script)";
}

function parsePackageJson(packageJson) {
  if (typeof packageJson === "string") {
    return JSON.parse(packageJson);
  }

  if (packageJson && typeof packageJson === "object") {
    return packageJson;
  }

  throw new TypeError("packageJson must be an object or JSON string");
}

export function runCensus({
  packageJson,
  files,
  cwd = process.cwd(),
  strict = false,
} = {}) {
  const root = path.resolve(cwd);
  const parsedPackageJson = parsePackageJson(
    packageJson ?? readFileSync(path.join(root, "package.json"), "utf8"),
  );

  if (files !== undefined && !Array.isArray(files)) {
    throw new TypeError("files must be an array when supplied");
  }

  const inputFiles = files ?? listTrackedSpecFiles(root);
  const specFiles = [
    ...new Set(
      inputFiles
        .map((file) => toRepoRelative(file, root))
        .filter(isCensusSpecFile),
    ),
  ].sort();

  const runnerScripts = Object.entries(parsedPackageJson.scripts ?? {})
    .map(([name, command]) => ({
      name,
      selectors: parseNodeTestCommand(command),
    }))
    .filter((runner) => runner.selectors !== null);

  const specs = specFiles.map((file) => {
    const runners = runnerScripts
      .filter((runner) =>
        runner.selectors.some((selector) =>
          selectorMatchesFile(selector, file, root),
        ),
      )
      .map((runner) => runner.name)
      .sort();

    return { file, runners };
  });

  const orphanFiles = specs
    .filter((spec) => spec.runners.length === 0)
    .map((spec) => spec.file);

  const summary = {
    totalSpecs: specs.length,
    homed: specs.length - orphanFiles.length,
    orphaned: orphanFiles.length,
  };

  return {
    specs,
    summary,
    proposals: orphanFiles.map((file) => ({
      file,
      proposedHome: proposedHomeFor(file),
    })),
    exitCode: strict && orphanFiles.length > 0 ? 3 : 0,
  };
}

export function formatCensus(result) {
  const specHeading = "SPEC FILE";
  const runnerHeading = "RUNNER SCRIPT(S)";
  const renderedRows = result.specs.map((spec) => ({
    file: spec.file,
    runners: spec.runners.length > 0 ? spec.runners.join(", ") : "NONE",
  }));

  const specWidth = Math.max(
    specHeading.length,
    ...renderedRows.map((row) => row.file.length),
  );
  const runnerWidth = Math.max(
    runnerHeading.length,
    ...renderedRows.map((row) => row.runners.length),
  );

  const lines = [
    `${specHeading.padEnd(specWidth)}  ${runnerHeading.padEnd(runnerWidth)}`,
    `${"-".repeat(specWidth)}  ${"-".repeat(runnerWidth)}`,
    ...renderedRows.map(
      (row) =>
        `${row.file.padEnd(specWidth)}  ${row.runners.padEnd(runnerWidth)}`,
    ),
    "",
    `Summary: total specs ${result.summary.totalSpecs}, homed ${result.summary.homed}, orphaned ${result.summary.orphaned}`,
    "",
    "Proposed homes for orphans:",
  ];

  if (result.proposals.length === 0) {
    lines.push("- (none)");
  } else {
    for (const proposal of result.proposals) {
      lines.push(`- ${proposal.file} -> ${proposal.proposedHome}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function appendFileArgument(target, value) {
  const trimmed = value.trim();

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new TypeError("--files JSON must be an array");
    }
    target.push(...parsed.map(String));
    return;
  }

  target.push(
    ...value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function parseCliArguments(argv) {
  const options = {
    strict: false,
    json: false,
    files: undefined,
    packageJsonPath: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--strict") {
      options.strict = true;
      continue;
    }

    if (argument === "--json") {
      options.json = true;
      continue;
    }

    if (argument === "--package-json") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--package-json requires a path");
      }
      options.packageJsonPath = value;
      index += 1;
      continue;
    }

    if (argument.startsWith("--package-json=")) {
      options.packageJsonPath = argument.slice("--package-json=".length);
      continue;
    }

    if (argument === "--files") {
      options.files ??= [];
      const previousLength = options.files.length;

      while (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
        index += 1;
        appendFileArgument(options.files, argv[index]);
      }

      if (options.files.length === previousLength) {
        throw new Error("--files requires one or more paths");
      }
      continue;
    }

    if (argument.startsWith("--files=")) {
      options.files ??= [];
      const previousLength = options.files.length;
      appendFileArgument(options.files, argument.slice("--files=".length));
      if (options.files.length === previousLength) {
        throw new Error("--files requires one or more paths");
      }
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }

  const moduleUrl = new URL(import.meta.url);
  let modulePath = decodeURIComponent(moduleUrl.pathname);

  if (process.platform === "win32") {
    modulePath = moduleUrl.hostname
      ? `\\\\${moduleUrl.hostname}${modulePath.replaceAll("/", "\\")}`
      : modulePath.replace(/^\/([A-Za-z]:)/u, "$1").replaceAll("/", "\\");
  }

  const invokedPath = path.resolve(process.argv[1]);
  const resolvedModulePath = path.resolve(modulePath);

  return process.platform === "win32"
    ? invokedPath.toLowerCase() === resolvedModulePath.toLowerCase()
    : invokedPath === resolvedModulePath;
}

if (isMainModule()) {
  try {
    const cli = parseCliArguments(process.argv.slice(2));
    const packageJsonPath = path.resolve(
      cli.packageJsonPath ?? path.join(process.cwd(), "package.json"),
    );
    const cwd = path.dirname(packageJsonPath);
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const result = runCensus({
      packageJson,
      files: cli.files,
      cwd,
      strict: cli.strict,
    });

    if (cli.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(formatCensus(result));
    }

    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(
      `spec-runner-census: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}
