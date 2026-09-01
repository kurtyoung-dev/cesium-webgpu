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

test("mixed newlines and UTF-16 offsets have stable locator output", async () => {
  await withTempDirectory(async (directory) => {
    const fixtureName = "locator-fixture.ts";
    const subject = path.join(directory, fixtureName);
    const source =
      'const lf = "ordinary";\n' +
      'const crlf = "still ordinary";\r\n' +
      'const later = "😀 Batch 47 and Session 65";\n';
    await fs.writeFile(subject, source, "utf8");

    const expectedFinding = {
      file: fixtureName,
      line: 3,
      column: 19,
      excerpt: 'const later = "😀 Batch 47 and Session 65";',
      literalKinds: ["string"],
      ruleIds: ["batch-id", "session-id"],
      matches: ["Batch 47", "Session 65"],
    };
    const expectedReport = {
      filesScanned: 1,
      filesWithFindings: 1,
      findingLines: 1,
      findings: [expectedFinding],
    };

    const textResult = runScanner(SCANNER, [fixtureName], directory);
    assert.equal(
      textResult.status,
      1,
      `mixed-newline fixture was missed\nstdout:\n${textResult.stdout}\nstderr:\n${textResult.stderr}`,
    );
    assert.equal(textResult.stderr, "");
    assert.equal(
      textResult.stdout,
      [
        `${fixtureName}:3:19 [batch-id,session-id] ${expectedFinding.excerpt}`,
        "string-literal-marker-scan: 1 marker-bearing literal line in 1 file (1 scanned)",
        "",
      ].join("\n"),
    );

    const jsonResult = runScanner(SCANNER, [fixtureName, "--json"], directory);
    assert.equal(
      jsonResult.status,
      1,
      `JSON scan lost the fixture marker\nstdout:\n${jsonResult.stdout}\nstderr:\n${jsonResult.stderr}`,
    );
    assert.equal(jsonResult.stderr, "");
    assert.equal(
      jsonResult.stdout,
      `${JSON.stringify(expectedReport, null, 2)}\n`,
    );
    assert.deepEqual(JSON.parse(jsonResult.stdout), expectedReport);
  });
});

test("mutation control: canonical newline collection determines later locators", async () => {
  await withTempDirectory(async (directory) => {
    const scannerSource = await fs.readFile(SCANNER, "utf8");
    const commentScannerSource = await fs.readFile(COMMENT_SCANNER, "utf8");
    const mutationAnchor = "starts.push(i + 1);";
    assert.equal(
      commentScannerSource.split(mutationAnchor).length - 1,
      1,
      "the canonical newline mutation anchor must occur exactly once",
    );
    const mutantCommentScannerSource = commentScannerSource.replace(
      mutationAnchor,
      'starts.push(i + (source[i - 1] === "\\r" ? 2 : 1));',
    );

    const mutantScanner = path.join(
      directory,
      "string-literal-marker-scan.mjs",
    );
    const mutantLib = path.join(directory, "lib");
    await fs.mkdir(mutantLib);
    await Promise.all([
      fs.writeFile(mutantScanner, scannerSource, "utf8"),
      fs.writeFile(
        path.join(mutantLib, "comment-scanner.mjs"),
        mutantCommentScannerSource,
        "utf8",
      ),
      fs.copyFile(MARKER_GRAMMAR, path.join(mutantLib, "marker-grammar.mjs")),
    ]);

    const fixtureName = "locator-fixture.ts";
    const subject = path.join(directory, fixtureName);
    await fs.writeFile(
      subject,
      'const lf = "ordinary";\n' +
        'const crlf = "still ordinary";\r\n' +
        'const later = "😀 Batch 47 and Session 65";\n',
      "utf8",
    );

    const live = runScanner(SCANNER, [fixtureName, "--json"], directory);
    assert.equal(
      live.status,
      1,
      `the live scanner must detect both markers\n${live.stdout}${live.stderr}`,
    );
    const mutant = runScanner(
      mutantScanner,
      [fixtureName, "--json"],
      directory,
    );
    assert.equal(
      mutant.status,
      1,
      `the locator mutant must preserve marker detection\n${mutant.stdout}${mutant.stderr}`,
    );
    assert.equal(mutant.stderr, "");

    const liveReport = JSON.parse(live.stdout);
    const mutantReport = JSON.parse(mutant.stdout);
    assert.deepEqual(liveReport.findings, [
      {
        file: fixtureName,
        line: 3,
        column: 19,
        excerpt: 'const later = "😀 Batch 47 and Session 65";',
        literalKinds: ["string"],
        ruleIds: ["batch-id", "session-id"],
        matches: ["Batch 47", "Session 65"],
      },
    ]);
    assert.deepEqual(mutantReport.findings, [
      {
        file: fixtureName,
        line: 3,
        column: 18,
        excerpt: 'onst later = "😀 Batch 47 and Session 65";',
        literalKinds: ["string"],
        ruleIds: ["batch-id", "session-id"],
        matches: ["Batch 47", "Session 65"],
      },
    ]);
    assert.notDeepEqual(
      mutantReport,
      liveReport,
      "the canonical newline mutant must corrupt the exact locator",
    );
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
