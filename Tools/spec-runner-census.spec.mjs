import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runCensus } from "./spec-runner-census.mjs";

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
      const sourceUrl = new URL("./spec-runner-census.mjs", import.meta.url);
      const source = await readFile(sourceUrl, "utf8");
      const marker = 'const STAR_PATTERN = "[^/]*";';
      const replacement = 'const STAR_PATTERN = "(?!)";';

      assert.equal(
        source.split(marker).length - 1,
        1,
        "mutation marker must occur exactly once",
      );

      const mutatedSource = source.replace(marker, replacement);
      const temporaryDirectory = await mkdtemp(
        path.join(tmpdir(), "spec-runner-census-mutant-"),
      );
      const mutantPath = path.join(
        temporaryDirectory,
        "spec-runner-census.mjs",
      );

      try {
        await writeFile(mutantPath, mutatedSource, "utf8");
        const mutantModule = await import(
          `${pathToFileURL(mutantPath).href}?mutant=${Date.now()}`
        );
        const mutantResult = mutantModule.runCensus({
          packageJson,
          files,
        });

        assert.deepEqual(
          findSpec(mutantResult, "packages/demo/Specs/nested/globbed.spec.mjs")
            .runners,
          [],
        );
        assert.equal(mutantResult.summary.orphaned, 2);
      } finally {
        await rm(temporaryDirectory, {
          recursive: true,
          force: true,
        });
      }
    },
  );
});
