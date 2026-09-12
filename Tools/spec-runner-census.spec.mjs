import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  formatCensus,
  isQuarantineRunner,
  parseNodeTestCommand,
  runCensus,
} from "./spec-runner-census.mjs";

const packageJson = {
  scripts: {
    "test-explicit": "node --test Tools/explicit.spec.mjs",
    "test-glob": 'node --test "packages/demo/Specs/**/*.spec.mjs"',
    "not-a-test-runner": "node Tools/unlisted.spec.mjs",
  },
};

const files = [
  "Tools/explicit.spec.mjs",
  "packages/demo/Specs/nested/globbed.spec.mjs",
  "Tools/unlisted.spec.mjs",
];

function findSpec(result, file) {
  const spec = result.specs.find((candidate) => candidate.file === file);
  assert.ok(spec, `missing census row for ${file}`);
  return spec;
}

async function importMutatedCensus(t, marker, replacement) {
  const sourceUrl = new URL("./spec-runner-census.mjs", import.meta.url);
  const source = await readFile(sourceUrl, "utf8");

  assert.equal(
    source.split(marker).length - 1,
    1,
    "mutation marker must occur exactly once",
  );

  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "spec-runner-census-mutant-"),
  );
  const mutantPath = path.join(temporaryDirectory, "spec-runner-census.mjs");

  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await writeFile(mutantPath, source.replace(marker, replacement), "utf8");

  return import(`${pathToFileURL(mutantPath).href}?mutant=${Date.now()}`);
}

test("spec-runner census resolves explicit paths, globs, and orphans", async (t) => {
  const result = runCensus({ packageJson, files });

  assert.deepEqual(findSpec(result, "Tools/explicit.spec.mjs").runners, [
    "test-explicit",
  ]);
  assert.deepEqual(
    findSpec(result, "packages/demo/Specs/nested/globbed.spec.mjs").runners,
    ["test-glob"],
  );
  assert.deepEqual(findSpec(result, "Tools/unlisted.spec.mjs").runners, []);

  assert.deepEqual(result.summary, {
    totalSpecs: 3,
    homed: 2,
    quarantined: 0,
    orphaned: 1,
  });
  assert.equal(result.exitCode, 0);

  const strictResult = runCensus({
    packageJson,
    files,
    strict: true,
  });
  assert.equal(strictResult.exitCode, 3);

  await t.test(
    "glob-matcher mutant leaves the globbed spec orphaned",
    async () => {
      const marker = 'const STAR_PATTERN = "[^/]*";';
      const replacement = 'const STAR_PATTERN = "(?!)";';
      const mutantModule = await importMutatedCensus(t, marker, replacement);
      const mutantResult = mutantModule.runCensus({ packageJson, files });

      assert.deepEqual(
        findSpec(mutantResult, "packages/demo/Specs/nested/globbed.spec.mjs")
          .runners,
        [],
      );
      assert.equal(mutantResult.summary.orphaned, 2);
    },
  );
});

const portableAndListPackageJson = {
  scripts: {
    "typecheck-tooling": "node scripts/typecheck-tooling.mjs",
    "test-direct": "node --test Tools/direct.spec.mjs",
    "test-chain":
      'npm run typecheck-tooling && node --test Tools/direct.spec.mjs "packages/demo/Specs/**/*.spec.mjs"',
    "test-adjacent":
      "npm run typecheck-tooling&&node --test Tools/direct.spec.mjs",
    "test-nested-home": "node --test Tools/nested.spec.mjs",
    "test-no-recursion": "npm run test-nested-home",
    "test-mixed":
      "npm run test-nested-home && node --test Tools/direct.spec.mjs",
    "test-missing": "npm run absent && node --test Tools/direct.spec.mjs",
    "test-self": "npm run test-self && node --test Tools/direct.spec.mjs",
    "test-quoted-selector": 'node --test "Tools/quoted&&name.spec.mjs"',
    "quoted-operator": 'echo "&&" node --test Tools/nested.spec.mjs',
    "echo-only": "echo node --test Tools/nested.spec.mjs",
    "redirect-target": "node --test > Tools/operand.spec.mjs",
    "flag-operand": "node --test --test-name-pattern Tools/operand.spec.mjs",
    "newline-boundary":
      "npm run typecheck-tooling\nnode --test Tools/operand.spec.mjs",
    "or-branch":
      "npm run typecheck-tooling || node --test Tools/operand.spec.mjs",
    pipeline: "node --test Tools/operand.spec.mjs | more",
    "single-ampersand":
      "npm run typecheck-tooling & node --test Tools/operand.spec.mjs",
    sequence: "npm run typecheck-tooling; node --test Tools/operand.spec.mjs",
    "quoted-prefix": '"node" --test Tools/operand.spec.mjs',
    "quoted-test-flag": 'node "--test" Tools/operand.spec.mjs',
    "partially-quoted-selector": 'node --test Tools/"operand".spec.mjs',
    "unquoted-glob": "node --test packages/demo/Specs/**/*.spec.mjs",
    "unmatched-quote": 'node --test "Tools/operand.spec.mjs',
  },
};

const portableAndListFiles = [
  "Tools/direct.spec.mjs",
  "Tools/nested.spec.mjs",
  "Tools/operand.spec.mjs",
  "Tools/quoted&&name.spec.mjs",
  "packages/demo/Specs/nested/globbed.spec.mjs",
];

test("spec-runner census recognizes only portable direct AND-list homes", async (t) => {
  const result = runCensus({
    packageJson: portableAndListPackageJson,
    files: portableAndListFiles,
  });

  assert.deepEqual(findSpec(result, "Tools/direct.spec.mjs").runners, [
    "test-adjacent",
    "test-chain",
    "test-direct",
    "test-mixed",
  ]);
  assert.deepEqual(findSpec(result, "Tools/nested.spec.mjs").runners, [
    "test-nested-home",
  ]);
  assert.deepEqual(findSpec(result, "Tools/quoted&&name.spec.mjs").runners, [
    "test-quoted-selector",
  ]);
  assert.deepEqual(
    findSpec(result, "packages/demo/Specs/nested/globbed.spec.mjs").runners,
    ["test-chain"],
  );
  assert.deepEqual(findSpec(result, "Tools/operand.spec.mjs").runners, []);
  assert.deepEqual(result.summary, {
    totalSpecs: 5,
    homed: 4,
    quarantined: 0,
    orphaned: 1,
  });
  assert.equal(result.exitCode, 0);

  const strictResult = runCensus({
    packageJson: portableAndListPackageJson,
    files: portableAndListFiles,
    strict: true,
  });
  assert.equal(strictResult.exitCode, 3);

  await t.test("later-segment traversal is load-bearing", async (t) => {
    const mutantModule = await importMutatedCensus(
      t,
      "for (const part of parts) {",
      "for (const part of parts.slice(0, 1)) {",
    );
    const mutantResult = mutantModule.runCensus({
      packageJson: portableAndListPackageJson,
      files: portableAndListFiles,
    });

    assert.deepEqual(findSpec(mutantResult, "Tools/direct.spec.mjs").runners, [
      "test-direct",
    ]);
  });

  await t.test("quoted operator shielding is load-bearing", async (t) => {
    const mutantModule = await importMutatedCensus(
      t,
      "    if (quoted) {",
      "    if (false) {",
    );
    const mutantResult = mutantModule.runCensus({
      packageJson: portableAndListPackageJson,
      files: portableAndListFiles,
    });

    assert.deepEqual(
      findSpec(mutantResult, "Tools/quoted&&name.spec.mjs").runners,
      [],
    );
  });

  await t.test("npm prechecks must name declared scripts", async (t) => {
    const mutantModule = await importMutatedCensus(
      t,
      "    scriptNames.has(scriptName) &&",
      "    true &&",
    );
    const mutantResult = mutantModule.runCensus({
      packageJson: portableAndListPackageJson,
      files: portableAndListFiles,
    });

    assert.ok(
      findSpec(mutantResult, "Tools/direct.spec.mjs").runners.includes(
        "test-missing",
      ),
    );
  });

  await t.test("npm prechecks cannot invoke their own runner", async (t) => {
    const mutantModule = await importMutatedCensus(
      t,
      "    scriptName !== runnerName",
      "    true",
    );
    const mutantResult = mutantModule.runCensus({
      packageJson: portableAndListPackageJson,
      files: portableAndListFiles,
    });

    assert.ok(
      findSpec(mutantResult, "Tools/direct.spec.mjs").runners.includes(
        "test-self",
      ),
    );
  });
});

test("spec-runner census confines portable selectors", async (t) => {
  const syntheticRoot = path.join(
    tmpdir(),
    "spec-runner-census-synthetic-root",
  );
  const absoluteSelector = path
    .join(syntheticRoot, "Tools", "confined.spec.mjs")
    .replaceAll("\\", "/");
  const packageJson = {
    scripts: {
      "test-relative": "node --test Tools/confined.spec.mjs",
      "test-native-absolute": `node --test "${absoluteSelector}"`,
      "test-posix-absolute": "node --test /Tools/confined.spec.mjs",
      "test-drive-absolute": "node --test C:/Tools/confined.spec.mjs",
      "test-unc": "node --test //server/share/Tools/confined.spec.mjs",
      "test-backslash": "node --test Tools\\confined.spec.mjs",
      "test-traversal": "node --test Tools/../Tools/confined.spec.mjs",
      "test-question": "node --test Tools/confined?.spec.mjs",
    },
  };
  const result = runCensus({
    packageJson,
    files: ["Tools/confined.spec.mjs"],
    cwd: syntheticRoot,
  });

  assert.deepEqual(findSpec(result, "Tools/confined.spec.mjs").runners, [
    "test-relative",
  ]);
  assert.deepEqual(result.summary, {
    totalSpecs: 1,
    homed: 1,
    quarantined: 0,
    orphaned: 0,
  });

  assert.equal(
    parseNodeTestCommand("node --test ~/Tools/confined.spec.mjs"),
    null,
  );
  assert.deepEqual(
    parseNodeTestCommand('node --test "~/Tools/confined.spec.mjs"').map(
      (selector) => selector.value,
    ),
    ["~/Tools/confined.spec.mjs"],
  );

  const confinementMutants = [
    {
      name: "unquoted tilde",
      marker: '    (!token.quoted && value.startsWith("~")) ||',
      replacement: "    false ||",
      command: "node --test ~/Tools/confined.spec.mjs",
    },
    {
      name: "backslash path",
      marker: '      character === "\\\\" ||',
      replacement: "      false ||",
      command: "node --test Tools\\confined.spec.mjs",
    },
    {
      name: "question-mark path",
      marker: '    value.includes("?") ||',
      replacement: "    false ||",
      command: "node --test Tools/confined?.spec.mjs",
    },
    {
      name: "POSIX and UNC absolute paths",
      marker: "    path.posix.isAbsolute(value) ||",
      replacement: "    false ||",
      command: "node --test //server/share/Tools/confined.spec.mjs",
    },
    {
      name: "drive-qualified path",
      marker: "    /^[A-Za-z]:/u.test(value) ||",
      replacement: "    false ||",
      command: "node --test C:/Tools/confined.spec.mjs",
    },
    {
      name: "parent traversal",
      marker: '    value.split("/").includes("..")',
      replacement: "    false",
      command: "node --test Tools/../Tools/confined.spec.mjs",
    },
  ];

  for (const mutant of confinementMutants) {
    await t.test(`${mutant.name} predicate is load-bearing`, async (t) => {
      const mutantModule = await importMutatedCensus(
        t,
        mutant.marker,
        mutant.replacement,
      );

      assert.notEqual(mutantModule.parseNodeTestCommand(mutant.command), null);
    });
  }
});

test("strict census returns zero when every spec is homed", async (t) => {
  const options = {
    packageJson: {
      scripts: {
        "test-all": "node --test Tools/all-homed.spec.mjs",
      },
    },
    files: ["Tools/all-homed.spec.mjs"],
    strict: true,
  };
  const result = runCensus(options);

  assert.deepEqual(result.summary, {
    totalSpecs: 1,
    homed: 1,
    quarantined: 0,
    orphaned: 0,
  });
  assert.equal(result.exitCode, 0);

  const mutantModule = await importMutatedCensus(
    t,
    "    exitCode: strict && orphanFiles.length > 0 ? 3 : 0,",
    "    exitCode: strict ? 3 : 0,",
  );
  assert.equal(mutantModule.runCensus(options).exitCode, 3);
});

test("spec-runner census does not execute opaque npm prechecks", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "spec-runner-census-inertness-"),
  );
  const sentinelPath = path.join(temporaryDirectory, "unexpected-sentinel");
  const sentinelCommand = `node -e "require('node:fs').writeFileSync(process.argv[1], 'ran')" -- "${sentinelPath.replaceAll("\\", "/")}"`;

  try {
    const result = runCensus({
      packageJson: {
        scripts: {
          "typecheck-tooling": sentinelCommand,
          "test-chain":
            "npm run typecheck-tooling && node --test Tools/direct.spec.mjs",
        },
      },
      files: ["Tools/direct.spec.mjs"],
    });

    assert.deepEqual(findSpec(result, "Tools/direct.spec.mjs").runners, [
      "test-chain",
    ]);
    assert.equal(existsSync(sentinelPath), false);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("isQuarantineRunner recognizes the suffix convention, not one fixed name", () => {
  assert.equal(isQuarantineRunner("test-cloud-c13-quarantine"), true);
  assert.equal(isQuarantineRunner("test-anything-else-quarantine"), true);
  assert.equal(isQuarantineRunner("test-cloud"), false);
  assert.equal(isQuarantineRunner("quarantine"), false);
  assert.equal(isQuarantineRunner(undefined), false);
});

// A runner named to match the seat's real quarantine plus a second, ordinary
// runner - three specs cover the three homing shapes a census row can take:
// quarantine-only, quarantine-AND-normal, and normal-only. Only the first is
// "quarantined": the whole risk here is that a quarantine home silently reads
// as "healthy", so anything with an ordinary home besides must not be flagged.
const quarantinePackageJson = {
  scripts: {
    "test-cloud-c13-quarantine":
      "node --test Tools/cloud-red.spec.mjs Tools/cloud-both.spec.mjs",
    "test-cloud":
      "node --test Tools/cloud-both.spec.mjs Tools/cloud-normal.spec.mjs",
  },
};

const quarantineFiles = [
  "Tools/cloud-red.spec.mjs",
  "Tools/cloud-both.spec.mjs",
  "Tools/cloud-normal.spec.mjs",
];

test("a spec homed only by a quarantine runner is homed AND quarantined, never orphaned", () => {
  const result = runCensus({
    packageJson: quarantinePackageJson,
    files: quarantineFiles,
  });

  const quarantineOnly = findSpec(result, "Tools/cloud-red.spec.mjs");
  assert.deepEqual(quarantineOnly.runners, ["test-cloud-c13-quarantine"]);
  assert.equal(quarantineOnly.quarantined, true);

  assert.deepEqual(result.summary, {
    totalSpecs: 3,
    homed: 3,
    quarantined: 1,
    orphaned: 0,
  });
});

test("a spec homed by BOTH a quarantine runner and a normal one is not quarantined", () => {
  const result = runCensus({
    packageJson: quarantinePackageJson,
    files: quarantineFiles,
  });

  const both = findSpec(result, "Tools/cloud-both.spec.mjs");
  assert.deepEqual(both.runners, ["test-cloud", "test-cloud-c13-quarantine"]);
  assert.equal(both.quarantined, false);
});

test("a spec homed only by a normal runner is not quarantined", () => {
  const result = runCensus({
    packageJson: quarantinePackageJson,
    files: quarantineFiles,
  });

  const normalOnly = findSpec(result, "Tools/cloud-normal.spec.mjs");
  assert.deepEqual(normalOnly.runners, ["test-cloud"]);
  assert.equal(normalOnly.quarantined, false);
});

test("formatCensus names the quarantine count and marks quarantined rows when non-zero", () => {
  const result = runCensus({
    packageJson: quarantinePackageJson,
    files: quarantineFiles,
  });
  const formatted = formatCensus(result);

  assert.match(
    formatted,
    /Summary: total specs 3, homed 3 \(1 quarantined\), orphaned 0/u,
  );

  const redRow = formatted
    .split("\n")
    .find((line) => line.startsWith("Tools/cloud-red.spec.mjs"));
  assert.ok(redRow, "expected a table row for the quarantine-only spec");
  assert.match(redRow, /quarantine\s*$/u);

  const normalRow = formatted
    .split("\n")
    .find((line) => line.startsWith("Tools/cloud-normal.spec.mjs"));
  assert.ok(normalRow, "expected a table row for the normal-only spec");
  assert.doesNotMatch(normalRow, /quarantine\s*$/u);
});

test("formatCensus is byte-identical to today's format when nothing is quarantined", () => {
  const soloPackageJson = {
    scripts: {
      "test-solo": "node --test Tools/solo.spec.mjs",
    },
  };
  const result = runCensus({
    packageJson: soloPackageJson,
    files: ["Tools/solo.spec.mjs"],
  });

  assert.equal(result.summary.quarantined, 0);

  const specWidth = "Tools/solo.spec.mjs".length;
  const runnerWidth = "RUNNER SCRIPT(S)".length;
  const expected =
    `${"SPEC FILE".padEnd(specWidth)}  ${"RUNNER SCRIPT(S)".padEnd(runnerWidth)}\n` +
    `${"-".repeat(specWidth)}  ${"-".repeat(runnerWidth)}\n` +
    `${"Tools/solo.spec.mjs".padEnd(specWidth)}  ${"test-solo".padEnd(runnerWidth)}\n` +
    "\n" +
    "Summary: total specs 1, homed 1, orphaned 0\n" +
    "\n" +
    "Proposed homes for orphans:\n" +
    "- (none)\n";

  assert.equal(formatCensus(result), expected);
});

test("quarantine classification is unreachable under an inertness mutant, and the fixture proves it isn't just broken", async (t) => {
  const mutantModule = await importMutatedCensus(
    t,
    'return typeof name === "string" && name.endsWith("-quarantine");',
    "return false;",
  );

  const mutantResult = mutantModule.runCensus({
    packageJson: quarantinePackageJson,
    files: quarantineFiles,
  });
  // Under the mutant, isQuarantineRunner never fires, so nothing is ever
  // "every runner is a quarantine runner" and the count collapses to 0.
  assert.equal(mutantResult.summary.quarantined, 0);
  assert.equal(
    findSpec(mutantResult, "Tools/cloud-red.spec.mjs").quarantined,
    false,
  );

  // The other half of inertness: prove the fixture and the real module still
  // detect the same case, so the mutant result above is a real behavior
  // change and not an artifact of a fixture that never exercised the code.
  const realResult = runCensus({
    packageJson: quarantinePackageJson,
    files: quarantineFiles,
  });
  assert.equal(realResult.summary.quarantined, 1);
  assert.equal(
    findSpec(realResult, "Tools/cloud-red.spec.mjs").quarantined,
    true,
  );
});
