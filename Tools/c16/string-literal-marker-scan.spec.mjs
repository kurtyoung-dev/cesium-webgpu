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
const LOCATOR_FIXTURE_NAME = "locator-fixture.ts";
const LOCATOR_SOURCE =
  'const lf = "ordinary";\n' +
  'const crlf = "still ordinary";\r\n' +
  'const later = "😀 Batch 47 and Session 65";\n';
const LOCATOR_FINDING = {
  file: LOCATOR_FIXTURE_NAME,
  line: 3,
  column: 19,
  excerpt: 'const later = "😀 Batch 47 and Session 65";',
  literalKinds: ["string"],
  ruleIds: ["batch-id", "session-id"],
  matches: ["Batch 47", "Session 65"],
};
const LOCATOR_REPORT = {
  filesScanned: 1,
  filesWithFindings: 1,
  findingLines: 1,
  findings: [LOCATOR_FINDING],
};

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

function assertUniqueAnchor(source, anchor, message) {
  assert.equal(source.split(anchor).length - 1, 1, message);
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
    const subject = path.join(directory, LOCATOR_FIXTURE_NAME);
    await fs.writeFile(subject, LOCATOR_SOURCE, "utf8");

    const textResult = runScanner(SCANNER, [LOCATOR_FIXTURE_NAME], directory);
    assert.equal(
      textResult.status,
      1,
      `mixed-newline fixture was missed\nstdout:\n${textResult.stdout}\nstderr:\n${textResult.stderr}`,
    );
    assert.equal(textResult.stderr, "");
    assert.equal(
      textResult.stdout,
      [
        `${LOCATOR_FIXTURE_NAME}:3:19 [batch-id,session-id] ${LOCATOR_FINDING.excerpt}`,
        "string-literal-marker-scan: 1 marker-bearing literal line in 1 file (1 scanned)",
        "",
      ].join("\n"),
    );

    const jsonResult = runScanner(
      SCANNER,
      [LOCATOR_FIXTURE_NAME, "--json"],
      directory,
    );
    assert.equal(
      jsonResult.status,
      1,
      `JSON scan lost the fixture marker\nstdout:\n${jsonResult.stdout}\nstderr:\n${jsonResult.stderr}`,
    );
    assert.equal(jsonResult.stderr, "");
    assert.equal(
      jsonResult.stdout,
      `${JSON.stringify(LOCATOR_REPORT, null, 2)}\n`,
    );
    assert.deepEqual(JSON.parse(jsonResult.stdout), LOCATOR_REPORT);
  });
});

test("mutation controls: canonical line lookup is reached through the adapter", async () => {
  await withTempDirectory(async (directory) => {
    const scannerSource = await fs.readFile(SCANNER, "utf8");
    const commentScannerSource = await fs.readFile(COMMENT_SCANNER, "utf8");
    const canonicalAnchor = "return low + 1;";
    const adapterAnchor = "return canonicalLineOf(starts, offset) - 1;";
    assertUniqueAnchor(
      commentScannerSource,
      canonicalAnchor,
      "the canonical line lookup mutation anchor must occur exactly once",
    );
    assertUniqueAnchor(
      scannerSource,
      adapterAnchor,
      "the line-index adapter mutation anchor must occur exactly once",
    );

    const mutantCommentScannerSource = commentScannerSource.replace(
      canonicalAnchor,
      "return low;",
    );
    const inertScannerSource = scannerSource.replace(
      adapterAnchor,
      [
        "let low = 0;",
        "  let high = starts.length;",
        "  while (low < high) {",
        "    const middle = (low + high) >>> 1;",
        "    if (starts[middle] <= offset) {",
        "      low = middle + 1;",
        "    } else {",
        "      high = middle;",
        "    }",
        "  }",
        "  return low - 1;",
      ].join("\n"),
    );

    const mutantScanner = path.join(directory, "canonical-mutant-scan.mjs");
    const inertScanner = path.join(directory, "inert-delegation-scan.mjs");
    const mutantLib = path.join(directory, "lib");
    await fs.mkdir(mutantLib);
    await Promise.all([
      fs.writeFile(mutantScanner, scannerSource, "utf8"),
      fs.writeFile(inertScanner, inertScannerSource, "utf8"),
      fs.writeFile(
        path.join(mutantLib, "comment-scanner.mjs"),
        mutantCommentScannerSource,
        "utf8",
      ),
      fs.copyFile(MARKER_GRAMMAR, path.join(mutantLib, "marker-grammar.mjs")),
      fs.writeFile(
        path.join(directory, LOCATOR_FIXTURE_NAME),
        LOCATOR_SOURCE,
        "utf8",
      ),
    ]);

    const corruptedReport = {
      ...LOCATOR_REPORT,
      findings: [
        {
          ...LOCATOR_FINDING,
          line: 2,
          column: 51,
          excerpt: 'const crlf = "still ordinary";',
        },
      ],
    };
    const mutant = runScanner(
      mutantScanner,
      [LOCATOR_FIXTURE_NAME, "--json"],
      directory,
    );
    assert.equal(
      mutant.status,
      1,
      `the canonical lookup mutant must preserve marker detection\n${mutant.stdout}${mutant.stderr}`,
    );
    assert.equal(mutant.stderr, "");
    assert.equal(
      mutant.stdout,
      `${JSON.stringify(corruptedReport, null, 2)}\n`,
    );
    assert.deepEqual(JSON.parse(mutant.stdout), corruptedReport);

    const inert = runScanner(
      inertScanner,
      [LOCATOR_FIXTURE_NAME, "--json"],
      directory,
    );
    assert.equal(
      inert.status,
      1,
      `the inert delegation control must preserve marker detection\n${inert.stdout}${inert.stderr}`,
    );
    assert.equal(inert.stderr, "");
    assert.equal(inert.stdout, `${JSON.stringify(LOCATOR_REPORT, null, 2)}\n`);
    assert.deepEqual(JSON.parse(inert.stdout), LOCATOR_REPORT);
    assert.notDeepEqual(
      JSON.parse(mutant.stdout),
      JSON.parse(inert.stdout),
      "the canonical mutant must affect only the scanner that uses the live adapter",
    );
  });
});

test("mutation control: the zero-based adapter offset determines locators", async () => {
  await withTempDirectory(async (directory) => {
    const scannerSource = await fs.readFile(SCANNER, "utf8");
    const adapterAnchor = "return canonicalLineOf(starts, offset) - 1;";
    assertUniqueAnchor(
      scannerSource,
      adapterAnchor,
      "the line-index adapter mutation anchor must occur exactly once",
    );
    const mutantSource = scannerSource.replace(
      adapterAnchor,
      "return canonicalLineOf(starts, offset) - 2;",
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
      fs.writeFile(
        path.join(directory, LOCATOR_FIXTURE_NAME),
        LOCATOR_SOURCE,
        "utf8",
      ),
    ]);

    const corruptedReport = {
      ...LOCATOR_REPORT,
      findings: [
        {
          ...LOCATOR_FINDING,
          line: 2,
          column: 51,
          excerpt: 'const crlf = "still ordinary";',
        },
      ],
    };
    const mutant = runScanner(
      mutantScanner,
      [LOCATOR_FIXTURE_NAME, "--json"],
      directory,
    );
    assert.equal(
      mutant.status,
      1,
      `the adapter mutant must preserve marker detection\n${mutant.stdout}${mutant.stderr}`,
    );
    assert.equal(mutant.stderr, "");
    assert.equal(
      mutant.stdout,
      `${JSON.stringify(corruptedReport, null, 2)}\n`,
    );
    assert.deepEqual(JSON.parse(mutant.stdout), corruptedReport);
    assert.notDeepEqual(
      JSON.parse(mutant.stdout),
      LOCATOR_REPORT,
      "the adapter mutant must corrupt the exact locator",
    );
  });
});

test("mutation control: canonical newline collection determines later locators", async () => {
  await withTempDirectory(async (directory) => {
    const scannerSource = await fs.readFile(SCANNER, "utf8");
    const commentScannerSource = await fs.readFile(COMMENT_SCANNER, "utf8");
    const mutationAnchor = "starts.push(i + 1);";
    assertUniqueAnchor(
      commentScannerSource,
      mutationAnchor,
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

    const subject = path.join(directory, LOCATOR_FIXTURE_NAME);
    await fs.writeFile(subject, LOCATOR_SOURCE, "utf8");

    const live = runScanner(
      SCANNER,
      [LOCATOR_FIXTURE_NAME, "--json"],
      directory,
    );
    assert.equal(
      live.status,
      1,
      `the live scanner must detect both markers\n${live.stdout}${live.stderr}`,
    );
    const mutant = runScanner(
      mutantScanner,
      [LOCATOR_FIXTURE_NAME, "--json"],
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
    assert.deepEqual(liveReport, LOCATOR_REPORT);
    assert.deepEqual(mutantReport, {
      ...LOCATOR_REPORT,
      findings: [
        {
          ...LOCATOR_FINDING,
          column: 18,
          excerpt: 'onst later = "😀 Batch 47 and Session 65";',
        },
      ],
    });
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
