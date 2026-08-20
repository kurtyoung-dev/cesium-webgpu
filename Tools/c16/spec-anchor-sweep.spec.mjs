// spec-anchor-sweep.spec.mjs — observable CLI contract for the C16 anchor sweep.

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TOOL = fileURLToPath(new URL("./spec-anchor-sweep.mjs", import.meta.url));

async function runSweep({ specs, sources }) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "c16-spec-anchor-sweep-"),
  );
  try {
    const specFiles = [];
    for (const [name, source] of Object.entries(specs)) {
      const file = path.join(directory, name);
      await fs.writeFile(file, source, "utf8");
      specFiles.push(file);
    }

    const sourceFiles = [];
    for (const [name, source] of Object.entries(sources)) {
      const file = path.join(directory, name);
      await fs.writeFile(file, source, "utf8");
      sourceFiles.push(file);
    }

    const result = spawnSync(
      process.execPath,
      [TOOL, "--json", "--spec", ...specFiles, "--source", ...sourceFiles],
      { cwd: directory, encoding: "utf8", timeout: 5000 },
    );
    assert.equal(
      result.status,
      0,
      `sweep failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    return {
      report: JSON.parse(result.stdout),
      specFiles,
      sourceFiles,
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("a six-character regex tracker id is reported as Class A", async () => {
  const { report, specFiles, sourceFiles } = await runSweep({
    specs: {
      "regex-anchor.spec.mjs":
        "const src = sourceText;\nassert.match(src, /C13-39/);\n",
    },
    sources: {
      "subject.js":
        "const ready = true;\n// C13-39 recorded the original constraint.\n",
    },
  });

  const findings = report.findings.filter((finding) => finding.class === "A");
  assert.deepEqual(findings, [
    {
      class: "A",
      className: "grammar anchor",
      specFile: specFiles[0],
      line: 2,
      literal: "/C13-39/",
      literalKind: "regex",
      sourceFile: sourceFiles[0],
      markerRuleIds: ["campaign-row-id"],
    },
  ]);
});

test("a six-character string tracker id is reported as Class A", async () => {
  const { report, specFiles, sourceFiles } = await runSweep({
    specs: {
      "string-anchor.spec.mjs":
        'const tracker =\n  "C13-39";\nassert.ok(tracker);\n',
    },
    sources: {
      "subject.ts":
        "// C13-39 recorded the original constraint.\nconst ready = true;\n",
    },
  });

  const findings = report.findings.filter((finding) => finding.class === "A");
  assert.deepEqual(findings, [
    {
      class: "A",
      className: "grammar anchor",
      specFile: specFiles[0],
      line: 2,
      literal: '"C13-39"',
      literalKind: "string",
      sourceFile: sourceFiles[0],
      markerRuleIds: ["campaign-row-id"],
    },
  ]);
});

test("Class B requires a comment match and no code match in that source", async () => {
  const { report, specFiles, sourceFiles } = await runSweep({
    specs: {
      "comment-anchor.spec.mjs":
        'assert.equal(anchor, "comment-only sentinel");\n',
    },
    sources: {
      "comment-only.js": "// comment-only sentinel\nconst ready = true;\n",
      "also-code.js":
        '// comment-only sentinel\nconst label = "comment-only sentinel";\n',
    },
  });

  const findings = report.findings.filter((finding) => finding.class === "B");
  assert.deepEqual(findings, [
    {
      class: "B",
      className: "comment-text anchor",
      specFile: specFiles[0],
      line: 1,
      literal: '"comment-only sentinel"',
      literalKind: "string",
      sourceFile: sourceFiles[0],
    },
  ]);
  assert.equal(
    findings.some((finding) => finding.sourceFile === sourceFiles[1]),
    false,
  );
});

test("an indexOf comment locator is reported as Class C", async () => {
  const { report, specFiles, sourceFiles } = await runSweep({
    specs: {
      "locator.spec.mjs":
        'const sourceText = src;\nconst start = sourceText.indexOf("// some comment");\n',
    },
    sources: {
      "subject.wgsl": "// some comment\nlet ready = true;\n",
    },
  });

  const findings = report.findings.filter((finding) => finding.class === "C");
  assert.deepEqual(findings, [
    {
      class: "C",
      className: "containment locator",
      specFile: specFiles[0],
      line: 2,
      literal: '"// some comment"',
      literalKind: "string",
      sourceFile: sourceFiles[0],
      verb: "indexOf",
    },
  ]);
});

test("code identifiers and unmatched literals produce zero findings", async () => {
  const { report } = await runSweep({
    specs: {
      "negative.spec.mjs": [
        'const location = src.indexOf("codeIdentifier");',
        'assert.equal(value, "nothing-matches-this");',
        "",
      ].join("\n"),
    },
    sources: {
      "subject.js": "const codeIdentifier = 1;\n// unrelated prose\n",
    },
  });

  assert.deepEqual(report.counts, { A: 0, B: 0, C: 0, total: 0 });
  assert.deepEqual(report.findings, []);
});
