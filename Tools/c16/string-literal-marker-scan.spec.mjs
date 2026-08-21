// string-literal-marker-scan.spec.mjs — observable contract and mutation
// control for the C16 string/template-literal scanner.
// @purpose Proves the string-literal marker scanner sees planted markers, excludes non-literal text, and depends on the shared marker grammar.
// @status ACTIVE

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCANNER = fileURLToPath(
  new URL("./string-literal-marker-scan.mjs", import.meta.url),
);
const COMMENT_SCANNER = fileURLToPath(
  new URL("./lib/comment-scanner.mjs", import.meta.url),
);
const MARKER_GRAMMAR = fileURLToPath(
  new URL("./lib/marker-grammar.mjs", import.meta.url),
);

function runScanner(scanner, args, cwd = ROOT) {
  return spawnSync(process.execPath, [scanner, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
}

async function withTempDirectory(run) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "c16-string-literal-scan-"),
  );
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("the scanner self-test is green", () => {
  const result = runScanner(SCANNER, ["--self-test"]);
  assert.equal(
    result.status,
    0,
    `self-test failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stdout, /self-test passed/);
});

test("a planted marker inside a string literal is detected", async () => {
  await withTempDirectory(async (directory) => {
    const subject = path.join(directory, "planted-marker.ts");
    await fs.writeFile(
      subject,
      'const warning = "Track NEW-FOO-BAR before release.";\n',
      "utf8",
    );

    const result = runScanner(SCANNER, [subject]);
    assert.equal(
      result.status,
      1,
      `planted marker was missed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /deferred-work-id/);
    assert.match(result.stdout, /NEW-FOO-BAR/);
    assert.match(result.stdout, /1 marker-bearing literal line/);
  });
});

test("a clean file stays clean while comments and regex anchors are excluded", async () => {
  await withTempDirectory(async (directory) => {
    const subject = path.join(directory, "clean-file.js");
    await fs.writeFile(
      subject,
      [
        "// Batch 47 remains visible to the separate comment guard.",
        "const anchor = /Session 65/;",
        'const explanation = "Avoid applying display gamma twice.";',
        "",
      ].join("\n"),
      "utf8",
    );

    const result = runScanner(SCANNER, [subject]);
    assert.equal(
      result.status,
      0,
      `clean file was over-reported\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /clean — 1 file scanned/);
  });
});

test("mutation control: a scanner whose grammar check is false misses the planted marker", async () => {
  await withTempDirectory(async (directory) => {
    const scannerSource = await fs.readFile(SCANNER, "utf8");
    const mutationAnchor = "const markerMatches = findMarkers(raw);";
    assert.equal(
      scannerSource.split(mutationAnchor).length - 1,
      1,
      "the mutation anchor must occur exactly once",
    );
    const mutantSource = scannerSource.replace(
      mutationAnchor,
      "const markerMatches = false ? findMarkers(raw) : [];",
    );

    const mutantScanner = path.join(
      directory,
      "string-literal-marker-scan.mjs",
    );
    const mutantLib = path.join(directory, "lib");
    await fs.mkdir(mutantLib);
    await Promise.all([
      fs.writeFile(mutantScanner, mutantSource, "utf8"),
      fs.copyFile(COMMENT_SCANNER, path.join(mutantLib, "comment-scanner.mjs")),
      fs.copyFile(MARKER_GRAMMAR, path.join(mutantLib, "marker-grammar.mjs")),
    ]);

    const subject = path.join(directory, "mutation-subject.js");
    await fs.writeFile(subject, 'const label = "Batch 47";\n', "utf8");

    const live = runScanner(SCANNER, [subject]);
    assert.equal(
      live.status,
      1,
      `the live scanner must detect the control marker\n${live.stdout}${live.stderr}`,
    );

    const mutant = runScanner(mutantScanner, [subject], directory);
    assert.equal(
      mutant.status,
      0,
      `the false-check mutant unexpectedly detected the marker\n${mutant.stdout}${mutant.stderr}`,
    );
    assert.match(mutant.stdout, /clean — 1 file scanned/);
    assert.notEqual(
      mutant.status,
      live.status,
      "the spec must observe the planted marker disappearing under mutation",
    );
  });
});
