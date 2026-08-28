// verify-orientation-mirror.spec.mjs — contract for orientation-mirror checks.
// @purpose Prove the orientation-mirror verifier compares closed-vocabulary statuses, fails closed on unresolved references, honors reasoned allowlisting, and behaves identically on LF and CRLF inputs.
// @status ACTIVE
//
// Run: node --test Tools/verify-orientation-mirror.spec.mjs
//
// WHY BOTH LEGS MATTER. Agreement and disagreement fixtures differ only in
// their status tokens; unresolved-row and unresolved-status fixtures each keep
// a valid queue authority present. This prevents an always-green comparator or
// an always-red input loader from looking useful.
//
// MUTATION STANDARD. Each load-bearing behavior has an absence mutant and an
// inertness mutant. Mutants are copies in temporary directories and execute
// through the real CLI. The inertness form still computes the finding but
// blocks its aggregation with an unreachable branch. A syntax error or runtime
// error never counts as a caught mutant.
//
// CRLF STANDARD. Every newline-sensitive disagreement assertion runs over an
// LF fixture and its CRLF twin. The retained reports must be identical, so a
// replacement that silently misses CRLF bytes cannot manufacture a green run.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = process.env.ORIENTATION_MIRROR_TOOL
  ? path.resolve(process.env.ORIENTATION_MIRROR_TOOL)
  : path.join(HERE, "verify-orientation-mirror.mjs");
const DEFAULT_MIRROR = "migration_doc/CAMPAIGN_PORTFOLIO_QUEUE.md";
const DEFAULT_ALLOWLIST = "Tools/orientation-mirror-allowlist.json";
const EMPTY_ALLOWLIST = Object.freeze({ version: 1, entries: [] });

function normalizeEol(text, eol) {
  return text.replace(/\r\n|\r|\n/g, eol);
}

function writeFixtureFile(root, relative, text, eol) {
  const absolute = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, normalizeEol(text, eol), "utf8");
  return absolute;
}

function queueFile(campaign, body) {
  return {
    doc: `migration_doc/QUEUE_2026-01-01_CAMPAIGN${campaign}.md`,
    body,
  };
}

function queueBody(rows) {
  return [
    "| Row | Description | Status |",
    "| --- | --- | --- |",
    ...rows.map(
      ({ rowId, status }) =>
        `| \`${rowId}\` | Synthetic authority row. | **${status}** |`,
    ),
    "",
  ].join("\n");
}

function createFixture(
  root,
  {
    mirrorDoc = DEFAULT_MIRROR,
    mirrorBody = "",
    writeMirror = true,
    queues = [],
    allowlist = EMPTY_ALLOWLIST,
    writeAllowlist = true,
    eol = "\n",
  },
) {
  mkdirSync(path.join(root, "migration_doc"), { recursive: true });
  mkdirSync(path.join(root, "Tools"), { recursive: true });
  if (writeMirror) {
    writeFixtureFile(root, mirrorDoc, mirrorBody, eol);
  }
  for (const queue of queues) {
    writeFixtureFile(root, queue.doc, queue.body, eol);
  }
  if (writeAllowlist) {
    writeFixtureFile(
      root,
      DEFAULT_ALLOWLIST,
      `${JSON.stringify(allowlist, null, 2)}\n`,
      eol,
    );
  }
  return { root, mirrorDoc, eol };
}

function withFixture(options, callback) {
  let root = null;
  try {
    root = mkdtempSync(path.join(tmpdir(), "orientation-mirror-"));
    options.afterRootCreated?.(root);
    const fixture = createFixture(root, options);
    return callback(fixture);
  } finally {
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

function runCli(
  fixture,
  {
    tool = TOOL,
    mirrors = [fixture.mirrorDoc],
    allowlist = DEFAULT_ALLOWLIST,
    extra = [],
  } = {},
) {
  const result = spawnSync(
    process.execPath,
    [
      tool,
      "--repo",
      fixture.root,
      "--mirror",
      ...mirrors,
      "--allowlist",
      allowlist,
      "--json",
      ...extra,
    ],
    {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, `CLI terminated by ${result.signal}`);
  assert.notEqual(result.status, null, "CLI did not publish an exit code");
  assert.notEqual(
    result.stdout.trim(),
    "",
    `empty JSON report: ${result.stderr}`,
  );

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    assert.fail(
      `CLI output was not JSON (${error.message}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    report,
  };
}

function assertPass(run, agreements) {
  assert.equal(run.status, 0, run.stdout);
  assert.equal(run.report.exitCode, 0);
  assert.equal(run.report.verdict, "pass");
  assert.equal(run.report.summary.agreements, agreements);
  assert.deepEqual(run.report.findings, []);
}

function assertOneFinding(run, { verdict, rowId, mirrorStatus, queueStatus }) {
  assert.equal(run.status, 1, run.stdout);
  assert.equal(run.report.exitCode, 1);
  assert.equal(run.report.verdict, "fail");
  assert.equal(run.report.findings.length, 1, run.stdout);
  const finding = run.report.findings[0];
  assert.equal(finding.verdict, verdict);
  assert.equal(finding.rowId, rowId);
  if (mirrorStatus !== undefined) {
    assert.equal(finding.mirror.status, mirrorStatus);
  }
  if (queueStatus !== undefined) {
    assert.equal(finding.queue.status, queueStatus);
  }
  assert.equal(finding.mirror.doc.startsWith("migration_doc/"), true);
  assert.equal(Number.isInteger(finding.mirror.line), true);
  assert.equal(finding.queue.doc.startsWith("migration_doc/QUEUE_"), true);
  return finding;
}

const G2_CONFIG = Object.freeze({
  mirrorDoc: "migration_doc/CAMPAIGN_STATE.md",
  mirrorBody: "- `C11-2` is **COMPLETE**.\n",
  queues: [queueFile(11, queueBody([{ rowId: "C11-2", status: "REOPENED" }]))],
});

const G4_CONFIG = Object.freeze({
  mirrorBody: "1. **C11-4 — COMPLETE:** synthetic mirror claim.\n",
  queues: [
    queueFile(11, queueBody([{ rowId: "C11-404", status: "COMPLETE" }])),
  ],
});

const G5_CONFIG = Object.freeze({
  mirrorBody: "1. **C11-5 — FROBNICATED:** synthetic unknown claim.\n",
  queues: [queueFile(11, queueBody([{ rowId: "C11-5", status: "COMPLETE" }]))],
});

const DIRECT_STATUS_CONFIG = Object.freeze({
  mirrorDoc: "migration_doc/CAMPAIGN_STATE.md",
  mirrorBody: "- `C11-22` COMPLETE.\n",
  queues: [queueFile(11, queueBody([{ rowId: "C11-22", status: "REOPENED" }]))],
});

const FENCED_QUEUE_CONFIG = Object.freeze({
  mirrorBody: "1. **C11-23 — COMPLETE:** synthetic mirror claim.\n",
  queues: [
    queueFile(
      11,
      [
        "```md",
        "| Row | Description | Status |",
        "| --- | --- | --- |",
        "| `C11-23` | Fenced example. | **COMPLETE** |",
        "```",
        "",
      ].join("\n"),
    ),
  ],
});

const STRUCK_QUEUE_CONFIG = Object.freeze({
  mirrorBody: "1. **C11-24 — COMPLETE:** synthetic mirror claim.\n",
  queues: [
    queueFile(
      11,
      [
        "| Row | Description | Status |",
        "| --- | --- | --- |",
        "| `C11-24` | Synthetic authority row. | ~~**COMPLETE**~~ **REOPENED** |",
        "",
      ].join("\n"),
    ),
  ],
});

const MULTILINE_STATUS_CONFIG = Object.freeze({
  mirrorDoc: "migration_doc/CAMPAIGN_STATE.md",
  mirrorBody: "- `C11-25`\n  REOPENED.\n",
  queues: [queueFile(11, queueBody([{ rowId: "C11-25", status: "COMPLETE" }]))],
});

const MIXED_DUPLICATE_CONFIG = Object.freeze({
  mirrorBody: "1. **C11-26 — COMPLETE:** synthetic mirror claim.\n",
  queues: [
    queueFile(
      11,
      queueBody([
        { rowId: "C11-26", status: "COMPLETE" },
        { rowId: "C11-26", status: "FROBNICATED" },
      ]),
    ),
  ],
});

test("G1 agreement exits 0 and counts the resolved row", () => {
  withFixture(
    {
      mirrorBody: "1. **C11-1 — COMPLETE:** synthetic mirror claim.\n",
      queues: [
        queueFile(11, queueBody([{ rowId: "C11-1", status: "COMPLETE" }])),
      ],
    },
    (fixture) => {
      assertPass(runCli(fixture), 1);
    },
  );
});

test("G2 disagreement exits 1 and reports both statuses", () => {
  withFixture(G2_CONFIG, (fixture) => {
    const finding = assertOneFinding(runCli(fixture), {
      verdict: "disagree",
      rowId: "C11-2",
      mirrorStatus: "COMPLETE",
      queueStatus: "REOPENED",
    });
    assert.equal(finding.mirror.line, 1);
    assert.equal(finding.queue.line, 3);
    assert.equal(finding.queueCandidates.length, 1);
  });
});

test("G3 negated status disagrees with COMPLETE and agrees with NOT COMPLETE", () => {
  const mirrorBody =
    "1. **C11-3 — NOT COMPLETE:** synthetic negated mirror claim.\n";
  withFixture(
    {
      mirrorBody,
      queues: [
        queueFile(11, queueBody([{ rowId: "C11-3", status: "COMPLETE" }])),
      ],
    },
    (fixture) => {
      assertOneFinding(runCli(fixture), {
        verdict: "disagree",
        rowId: "C11-3",
        mirrorStatus: "NOT COMPLETE",
        queueStatus: "COMPLETE",
      });
    },
  );
  withFixture(
    {
      mirrorBody,
      queues: [
        queueFile(11, queueBody([{ rowId: "C11-3", status: "NOT COMPLETE" }])),
      ],
    },
    (fixture) => {
      assertPass(runCli(fixture), 1);
    },
  );
});

test("G4 absent canonical row is unresolvable-row, not an input error", () => {
  withFixture(G4_CONFIG, (fixture) => {
    const finding = assertOneFinding(runCli(fixture), {
      verdict: "unresolvable-row",
      rowId: "C11-4",
      mirrorStatus: "COMPLETE",
      queueStatus: "<unresolved>",
    });
    assert.equal(finding.queue.line, null);
    assert.equal(runCli(fixture).report.summary["unresolvable-row"], 1);
  });
});

test("G5 vocabulary is closed on both mirror and queue sides", () => {
  withFixture(G5_CONFIG, (fixture) => {
    assertOneFinding(runCli(fixture), {
      verdict: "unresolvable-status",
      rowId: "C11-5",
      mirrorStatus: "FROBNICATED",
      queueStatus: "COMPLETE",
    });
  });
  withFixture(
    {
      mirrorBody: "1. **C11-5 — COMPLETE:** synthetic mirror claim.\n",
      queues: [
        queueFile(11, queueBody([{ rowId: "C11-5", status: "FROBNICATED" }])),
      ],
    },
    (fixture) => {
      const finding = assertOneFinding(runCli(fixture), {
        verdict: "unresolvable-status",
        rowId: "C11-5",
        mirrorStatus: "COMPLETE",
        queueStatus: "<unresolved>",
      });
      assert.deepEqual(finding.queue.statusTerms, null);
    },
  );
});

test("G6 portfolio reference without a status claim is ignored", () => {
  withFixture(
    {
      mirrorBody: "1. **C18-V2:** synthetic reference without a claim.\n",
      queues: [
        queueFile(18, queueBody([{ rowId: "C18-V2", status: "COMPLETE" }])),
      ],
    },
    (fixture) => {
      const run = runCli(fixture);
      assertPass(run, 0);
      assert.equal(run.report.allowlistHitCount, 0);
      assert.equal(
        run.report.findings.some((finding) => finding.rowId === "C18-V2"),
        false,
      );
    },
  );
});

test("G7 a reasoned allowlist entry suppresses one disagreement visibly", () => {
  const reason =
    "The mirror is retained as a deliberately stale training fixture.";
  withFixture(
    {
      mirrorBody: "1. **C11-7 — COMPLETE:** synthetic mirror claim.\n",
      queues: [
        queueFile(11, queueBody([{ rowId: "C11-7", status: "REOPENED" }])),
      ],
      allowlist: {
        version: 1,
        entries: [
          {
            rowId: "C11-7",
            mirror: DEFAULT_MIRROR,
            reason,
          },
        ],
      },
    },
    (fixture) => {
      const run = runCli(fixture);
      assertPass(run, 0);
      assert.equal(run.report.allowlistHitCount, 1);
      assert.equal(run.report.summary.allowlisted, 1);
      assert.equal(run.report.allowlistedFindings.length, 1);
      assert.equal(run.report.allowlistedFindings[0].verdict, "disagree");
      assert.equal(run.report.allowlistedFindings[0].allowlistReason, reason);
    },
  );
});

test("G8 an allowlist entry without a human reason exits 2", () => {
  withFixture(
    {
      mirrorBody: "1. **C11-8 — COMPLETE:** synthetic mirror claim.\n",
      queues: [
        queueFile(11, queueBody([{ rowId: "C11-8", status: "REOPENED" }])),
      ],
      allowlist: {
        version: 1,
        entries: [{ rowId: "C11-8", mirror: DEFAULT_MIRROR }],
      },
    },
    (fixture) => {
      const run = runCli(fixture);
      assert.equal(run.status, 2, run.stdout);
      assert.equal(run.report.exitCode, 2);
      assert.match(run.report.errors[0], /requires a human reason string/u);
    },
  );
});

test("G9 missing mirror and missing owning queue each exit 2", () => {
  withFixture(
    {
      writeMirror: false,
      queues: [
        queueFile(11, queueBody([{ rowId: "C11-9", status: "COMPLETE" }])),
      ],
    },
    (fixture) => {
      const run = runCli(fixture);
      assert.equal(run.status, 2, run.stdout);
      assert.match(
        run.report.errors[0],
        /mirror document is missing or unreadable/u,
      );
    },
  );
  withFixture(
    {
      mirrorBody: "1. **C11-9 — COMPLETE:** synthetic mirror claim.\n",
      queues: [
        queueFile(12, queueBody([{ rowId: "C12-9", status: "COMPLETE" }])),
      ],
    },
    (fixture) => {
      const run = runCli(fixture);
      assert.equal(run.status, 2, run.stdout);
      assert.match(
        run.report.errors[0],
        /queue document is missing for campaign 11/u,
      );
    },
  );
});

test("G10 conflicting canonical queue rows are unresolvable-status", () => {
  withFixture(
    {
      mirrorBody: "1. **C11-10 — COMPLETE:** synthetic mirror claim.\n",
      queues: [
        queueFile(
          11,
          queueBody([
            { rowId: "C11-10", status: "COMPLETE" },
            { rowId: "C11-10", status: "REOPENED" },
          ]),
        ),
      ],
    },
    (fixture) => {
      const finding = assertOneFinding(runCli(fixture), {
        verdict: "unresolvable-status",
        rowId: "C11-10",
        mirrorStatus: "COMPLETE",
        queueStatus: "COMPLETE <> REOPENED",
      });
      assert.deepEqual(
        finding.queueCandidates.map((candidate) => [
          candidate.line,
          candidate.status,
        ]),
        [
          [3, "COMPLETE"],
          [4, "REOPENED"],
        ],
      );
    },
  );
});

test("G11 LF and CRLF disagreement fixtures produce identical findings", () => {
  let lfReport;
  withFixture({ ...G2_CONFIG, eol: "\n" }, (fixture) => {
    const run = runCli(fixture);
    assertOneFinding(run, {
      verdict: "disagree",
      rowId: "C11-2",
      mirrorStatus: "COMPLETE",
      queueStatus: "REOPENED",
    });
    lfReport = {
      findings: run.report.findings,
      summary: run.report.summary,
    };
  });

  withFixture({ ...G2_CONFIG, eol: "\r\n" }, (fixture) => {
    const run = runCli(fixture);
    assertOneFinding(run, {
      verdict: "disagree",
      rowId: "C11-2",
      mirrorStatus: "COMPLETE",
      queueStatus: "REOPENED",
    });
    const bytes = readFileSync(
      path.join(fixture.root, ...fixture.mirrorDoc.split("/")),
    );
    let crlf = 0;
    let loneLf = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] === 10) {
        if (bytes[index - 1] === 13) {
          crlf += 1;
        } else {
          loneLf += 1;
        }
      }
    }
    assert.equal(crlf > 0, true);
    assert.equal(loneLf, 0);
    assert.deepEqual(
      { findings: run.report.findings, summary: run.report.summary },
      lfReport,
    );
  });
});

test("B-P0-1 fenced and indented code cannot assert mirror or queue status", () => {
  withFixture(
    {
      mirrorBody: [
        "```md",
        "1. **C11-23 — COMPLETE:** fenced mirror example.",
        "```",
        "    1. **C11-23 — COMPLETE:** indented mirror example.",
        "",
      ].join("\n"),
      queues: [
        queueFile(11, queueBody([{ rowId: "C11-23", status: "COMPLETE" }])),
      ],
    },
    (fixture) => {
      assertPass(runCli(fixture), 0);
    },
  );

  withFixture(
    {
      ...FENCED_QUEUE_CONFIG,
      queues: [
        queueFile(
          11,
          [
            "| Row | Description | Status |",
            "| --- | --- | --- |",
            "~~~md",
            "| `C11-23` | Fenced example. | **COMPLETE** |",
            "~~~",
            "    | `C11-23` | Indented example. | **COMPLETE** |",
            "",
          ].join("\n"),
        ),
      ],
    },
    (fixture) => {
      assertOneFinding(runCli(fixture), {
        verdict: "unresolvable-row",
        rowId: "C11-23",
        mirrorStatus: "COMPLETE",
        queueStatus: "<unresolved>",
      });
    },
  );
});

test("B-P0-2 struck queue status cannot outrank its live replacement", () => {
  withFixture(STRUCK_QUEUE_CONFIG, (fixture) => {
    assertOneFinding(runCli(fixture), {
      verdict: "disagree",
      rowId: "C11-24",
      mirrorStatus: "COMPLETE",
      queueStatus: "REOPENED",
    });
  });
});

test("B-P0-3 mixed resolved and unresolved duplicate rows are unresolvable", () => {
  withFixture(MIXED_DUPLICATE_CONFIG, (fixture) => {
    const finding = assertOneFinding(runCli(fixture), {
      verdict: "unresolvable-status",
      rowId: "C11-26",
      mirrorStatus: "COMPLETE",
      queueStatus: "COMPLETE <> <unresolved>",
    });
    assert.deepEqual(
      finding.queueCandidates.map((candidate) => candidate.status),
      ["COMPLETE", "<unresolved>"],
    );
  });
});

test("B-P0-4 direct-status state bullets are authoritative claims", () => {
  withFixture(DIRECT_STATUS_CONFIG, (fixture) => {
    assertOneFinding(runCli(fixture), {
      verdict: "disagree",
      rowId: "C11-22",
      mirrorStatus: "COMPLETE",
      queueStatus: "REOPENED",
    });
  });
});

test("B-P0-5 multiline status claims resolve and incomplete claims fail closed", () => {
  withFixture(MULTILINE_STATUS_CONFIG, (fixture) => {
    assertOneFinding(runCli(fixture), {
      verdict: "disagree",
      rowId: "C11-25",
      mirrorStatus: "REOPENED",
      queueStatus: "COMPLETE",
    });
  });

  withFixture(
    {
      mirrorDoc: "migration_doc/CAMPAIGN_STATE.md",
      mirrorBody: "- `C11-27` is\n  REOPENED.\n",
      queues: [
        queueFile(11, queueBody([{ rowId: "C11-27", status: "COMPLETE" }])),
      ],
    },
    (fixture) => {
      assertOneFinding(runCli(fixture), {
        verdict: "disagree",
        rowId: "C11-27",
        mirrorStatus: "REOPENED",
        queueStatus: "COMPLETE",
      });
    },
  );

  withFixture(
    {
      mirrorBody: "1. **C11-28 —\n  REOPENED:** synthetic multiline heading.\n",
      queues: [
        queueFile(11, queueBody([{ rowId: "C11-28", status: "COMPLETE" }])),
      ],
    },
    (fixture) => {
      assertOneFinding(runCli(fixture), {
        verdict: "disagree",
        rowId: "C11-28",
        mirrorStatus: "REOPENED",
        queueStatus: "COMPLETE",
      });
    },
  );

  withFixture(
    {
      mirrorDoc: "migration_doc/CAMPAIGN_STATE.md",
      mirrorBody: "- `C11-29` is\n",
      queues: [
        queueFile(11, queueBody([{ rowId: "C11-29", status: "COMPLETE" }])),
      ],
    },
    (fixture) => {
      assertOneFinding(runCli(fixture), {
        verdict: "unresolvable-status",
        rowId: "C11-29",
        mirrorStatus: "<missing>",
        queueStatus: "COMPLETE",
      });
    },
  );
});

test("B-P0-6 contradictory status sets are unresolvable", () => {
  withFixture(
    {
      mirrorBody:
        "1. **C11-30 — COMPLETE / NOT COMPLETE:** contradictory mirror claim.\n",
      queues: [
        queueFile(
          11,
          queueBody([{ rowId: "C11-30", status: "NOT COMPLETE / COMPLETE" }]),
        ),
      ],
    },
    (fixture) => {
      assertOneFinding(runCli(fixture), {
        verdict: "unresolvable-status",
        rowId: "C11-30",
        mirrorStatus: "COMPLETE / NOT COMPLETE",
        queueStatus: "<unresolved>",
      });
    },
  );
});

test("B-P0-7 format-only allowlist reasons exit 2", () => {
  withFixture(
    {
      mirrorBody: "1. **C11-31 — COMPLETE:** synthetic mirror claim.\n",
      queues: [
        queueFile(11, queueBody([{ rowId: "C11-31", status: "REOPENED" }])),
      ],
      allowlist: {
        version: 1,
        entries: [
          {
            rowId: "C11-31",
            mirror: DEFAULT_MIRROR,
            reason: "\u200B",
          },
        ],
      },
    },
    (fixture) => {
      const run = runCli(fixture);
      assert.equal(run.status, 2, run.stdout);
      assert.match(run.report.errors[0], /visible letter or number/u);
    },
  );
});

test("B-P1-1 allowlist row IDs require exact canonical spelling", () => {
  for (const rowId of ["c12-29 s3", "C12-29   S3"]) {
    withFixture(
      {
        mirrorBody: "1. **C12-29 S3 — COMPLETE:** synthetic mirror claim.\n",
        queues: [
          queueFile(
            12,
            queueBody([{ rowId: "C12-29 S3", status: "REOPENED" }]),
          ),
        ],
        allowlist: {
          version: 1,
          entries: [
            {
              rowId,
              mirror: DEFAULT_MIRROR,
              reason: "A visible synthetic reason.",
            },
          ],
        },
      },
      (fixture) => {
        const run = runCli(fixture);
        assert.equal(run.status, 2, `${rowId}\n${run.stdout}`);
        assert.match(run.report.errors[0], /canonical uppercase single-space/u);
      },
    );
  }
});

test("B-P1-2 slice references resolve explicit slice status and owner grammar", () => {
  const sliceQueue = queueFile(
    12,
    [
      "- `C12-29` synthetic slice authority. Slice state: **S3 REOPENED — its canonical owner `C13-41`**; **S4 COMPLETE / EDGE VERIFIED**.",
      "",
    ].join("\n"),
  );
  withFixture(
    {
      mirrorBody:
        "1. **C12-29 S3 — COMPLETE:** synthetic slice mirror claim.\n",
      queues: [sliceQueue],
    },
    (fixture) => {
      const run = runCli(fixture);
      const finding = assertOneFinding(run, {
        verdict: "disagree",
        rowId: "C12-29 S3",
        mirrorStatus: "COMPLETE",
        queueStatus: "REOPENED",
      });
      assert.equal(finding.queueCandidates[0].owner, "C13-41");
    },
  );
  withFixture(
    {
      mirrorBody:
        "1. **C12-29 S4 — COMPLETE / EDGE VERIFIED:** synthetic slice mirror claim.\n",
      queues: [sliceQueue],
    },
    (fixture) => {
      assertPass(runCli(fixture), 1);
    },
  );
  withFixture(
    {
      mirrorBody:
        "1. **C12-29 S3 — COMPLETE:** ambiguous synthetic slice claim.\n",
      queues: [
        queueFile(
          12,
          [
            "- `C12-29` synthetic slice authority. Slice state: **S3 COMPLETE**.",
            "- `C12-29` duplicate slice authority. Slice state: **S3 REOPENED**.",
            "",
          ].join("\n"),
        ),
      ],
    },
    (fixture) => {
      assertOneFinding(runCli(fixture), {
        verdict: "unresolvable-status",
        rowId: "C12-29 S3",
        mirrorStatus: "COMPLETE",
        queueStatus: "COMPLETE <> REOPENED",
      });
    },
  );
});

test("only tables with a Status or State header term supply canonical candidates", () => {
  withFixture(
    {
      mirrorBody: "1. **C13-41 — COMPLETE:** synthetic mirror claim.\n",
      queues: [
        queueFile(
          13,
          [
            "| ID | Canonical task | Pri |",
            "| --- | --- | --- |",
            "| `C13-41` | Status and next diagnostic in the ledger row. | P1 |",
            "",
            "| ID(s) | Seeded status | Evidence / next action |",
            "| --- | --- | --- |",
            "> Synthetic explanatory interruption.",
            "",
            "| `C13-41` (synthetic ledger row) | **REOPENED** | Synthetic ledger authority. |",
            "",
          ].join("\n"),
        ),
      ],
    },
    (fixture) => {
      const finding = assertOneFinding(runCli(fixture), {
        verdict: "disagree",
        rowId: "C13-41",
        mirrorStatus: "COMPLETE",
        queueStatus: "REOPENED",
      });
      assert.equal(finding.queueCandidates.length, 1);
      assert.equal(finding.queueCandidates[0].status, "REOPENED");
    },
  );
});

test("non-status tables admit only positively parsed status cells", () => {
  withFixture(
    {
      mirrorBody:
        "1. **C12-37 — COMPLETE / EDGE VERIFIED:** synthetic mirror claim.\n",
      queues: [
        queueFile(
          12,
          [
            "| ID | Item | Effort |",
            "| --- | --- | --- |",
            "| `C12-37` | **`SYNTHETIC-TITLE` — RESOLVED / LANDED / EDGE VERIFIED** | S |",
            "",
          ].join("\n"),
        ),
      ],
    },
    (fixture) => {
      const finding = assertOneFinding(runCli(fixture), {
        verdict: "disagree",
        rowId: "C12-37",
        mirrorStatus: "COMPLETE + EDGE VERIFIED",
        queueStatus: "RESOLVED + LANDED + EDGE VERIFIED",
      });
      assert.equal(finding.queueCandidates.length, 1);
    },
  );
});

test("B-P2-1 setup-time exceptions cannot leak a fixture root", () => {
  let createdRoot;
  try {
    assert.throws(
      () =>
        withFixture(
          {
            afterRootCreated(root) {
              createdRoot = root;
              throw new Error("synthetic setup failure");
            },
          },
          () => assert.fail("fixture callback must not run"),
        ),
      /synthetic setup failure/u,
    );
    assert.equal(existsSync(createdRoot), false, createdRoot);
  } finally {
    if (createdRoot) {
      rmSync(createdRoot, { recursive: true, force: true });
    }
  }
});

test("finding order is mirror, numeric line, then byte-wise row ID", () => {
  withFixture(
    {
      mirrorBody:
        "1. **C11-20 / C11-19 — COMPLETE:** synthetic shared claim.\n",
      queues: [
        queueFile(
          11,
          queueBody([
            { rowId: "C11-20", status: "REOPENED" },
            { rowId: "C11-19", status: "REOPENED" },
          ]),
        ),
      ],
    },
    (fixture) => {
      const run = runCli(fixture);
      assert.equal(run.status, 1, run.stdout);
      assert.deepEqual(
        run.report.findings.map((finding) => finding.rowId),
        ["C11-19", "C11-20"],
      );
    },
  );
});

test("a backticked queue title may prefix a closed status without becoming one", () => {
  withFixture(
    {
      mirrorBody:
        "1. **C11-21 — RESOLVED / LANDED:** synthetic mirror claim.\n",
      queues: [
        queueFile(
          11,
          queueBody([
            {
              rowId: "C11-21",
              status: "`SYNTHETIC-TITLE` — RESOLVED / LANDED",
            },
          ]),
        ),
      ],
    },
    (fixture) => {
      assertPass(runCli(fixture), 1);
    },
  );
});

test("--help documents usage, defaults, authorities, and exits", () => {
  const result = spawnSync(process.execPath, [TOOL, "--help"], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage:/u);
  assert.match(result.stdout, /CAMPAIGN_PORTFOLIO_QUEUE\.md/u);
  assert.match(result.stdout, /QUEUE_\*_CAMPAIGN\*\.md/u);
  assert.match(result.stdout, /2 {2}Cannot determine/u);
});

function mutateRecorder(source, recorder, mode) {
  const pattern = new RegExp(
    `function ${recorder}\\(findings, finding\\) \\{\\r?\\n  findings\\.push\\(finding\\);\\r?\\n\\}`,
    "g",
  );
  const matches = [...source.matchAll(pattern)];
  assert.equal(
    matches.length,
    1,
    `mutation anchor for ${recorder} must occur exactly once`,
  );
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  let replacement;
  if (mode === "absence") {
    replacement = `function ${recorder}(findings, finding) {${eol}}`;
  } else if (mode === "inertness") {
    replacement = [
      `function ${recorder}(findings, finding) {`,
      "  if (false) {",
      "    findings.push(finding);",
      "  }",
      "}",
    ].join(eol);
  } else {
    throw new Error(`unknown mutation mode: ${mode}`);
  }
  const mutated = source.replace(pattern, replacement);
  assert.notEqual(mutated, source, `${recorder} ${mode} mutation was inert`);
  return mutated;
}

function requireMutationRed(t, fixture, recorder, mode, expected) {
  const control = runCli(fixture);
  assertOneFinding(control, expected);

  const source = readFileSync(TOOL, "utf8");
  const mutant = mutateRecorder(source, recorder, mode);
  const mutantPath = path.join(
    fixture.root,
    "Tools",
    `mutant-${recorder}-${mode}.mjs`,
  );
  writeFileSync(mutantPath, mutant, "utf8");
  const run = runCli(fixture, { tool: mutantPath });

  assert.equal(
    run.status,
    0,
    `mutant did not execute normally:\n${run.stdout}`,
  );
  assert.equal(run.report.exitCode, 0);
  assert.deepEqual(run.report.findings, []);

  let observed;
  try {
    assertOneFinding(run, expected);
  } catch (error) {
    if (error?.name === "AssertionError") {
      observed = error;
    } else {
      throw error;
    }
  }
  assert.ok(
    observed,
    `${mode.toUpperCase()} MUTANT STAYED GREEN for ${recorder}`,
  );
  t.diagnostic(
    `actual: RED — ${recorder} ${mode} returned 0 with no finding; fixture expected exit 1 + ${expected.verdict}`,
  );
}

function replaceUnique(source, pattern, replacement, label) {
  const matches = [...source.matchAll(pattern)];
  assert.equal(matches.length, 1, `${label} mutation anchor must occur once`);
  const mutated = source.replace(pattern, replacement);
  assert.notEqual(mutated, source, `${label} mutation was inert`);
  return mutated;
}

function mutateParserBehavior(source, behavior, mode) {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  if (behavior === "direct") {
    if (mode === "absence") {
      const pattern =
        /function stateDirectStatusPattern\(\) \{[\s\S]*?\r?\n\}\r?\n\r?\n(?=function appendStateClaims)/gu;
      return replaceUnique(
        source,
        pattern,
        [
          "function stateDirectStatusPattern() {",
          "  return /$(?!)/gu;",
          "}",
          "",
        ].join(eol),
        behavior,
      );
    }
    const pattern =
      / {2}claims\.push\(\.\.\.collectDirectStateClaims\(activeLine, lineNumber\)\);/gu;
    return replaceUnique(
      source,
      pattern,
      [
        "  const directClaims = collectDirectStateClaims(activeLine, lineNumber);",
        "  if (directClaims.length < 0) {",
        "    claims.push(...directClaims);",
        "  }",
      ].join(eol),
      behavior,
    );
  }

  if (behavior === "fence") {
    if (mode === "absence") {
      const pattern =
        /function sanitizeMarkdownLines\(text\) \{[\s\S]*?\r?\n\}\r?\n\r?\n(?=function joinLogicalBlock)/gu;
      const replacement = [
        "function sanitizeMarkdownLines(text) {",
        "  const lines = stripStrikethrough(text).split(/\\r?\\n/u);",
        "  return lines.map((line, index) => ({ text: line, line: index + 1 }));",
        "}",
        "",
      ].join(eol);
      return replaceUnique(source, pattern, replacement, behavior);
    }
    const pattern =
      / {2}return lines\.map\(\(line, index\) => \(\{ text: line, line: index \+ 1 \}\)\);/gu;
    return replaceUnique(
      source,
      pattern,
      [
        "  const sanitized = lines.map((line, index) => ({",
        "    text: line,",
        "    line: index + 1,",
        "  }));",
        "  void sanitized;",
        "  return stripStrikethrough(text)",
        "    .split(/\\r?\\n/u)",
        "    .map((line, index) => ({ text: line, line: index + 1 }));",
      ].join(eol),
      behavior,
    );
  }

  if (behavior === "strike") {
    const pattern =
      /function stripStrikethrough\(text\) \{[\s\S]*?\r?\n\}\r?\n\r?\n(?=function sanitizeMarkdownLines)/gu;
    if (mode === "absence") {
      return replaceUnique(
        source,
        pattern,
        ["function stripStrikethrough(text) {", "  return text;", "}", ""].join(
          eol,
        ),
        behavior,
      );
    }
    return replaceUnique(
      source,
      pattern,
      [
        "function stripStrikethrough(text) {",
        "  const stripped = text.replace(/~~[\\s\\S]*?~~/gu, (span) =>",
        '    span.replace(/[^\\r\\n]/gu, " "),',
        "  );",
        "  void stripped;",
        "  return text;",
        "}",
        "",
      ].join(eol),
      behavior,
    );
  }

  if (behavior === "multiline") {
    const pattern =
      /function joinLogicalBlock\(parts\) \{\r?\n {2}return parts\.join\(" "\);\r?\n\}/gu;
    if (mode === "absence") {
      return replaceUnique(
        source,
        pattern,
        ["function joinLogicalBlock(parts) {", "  return parts[0];", "}"].join(
          eol,
        ),
        behavior,
      );
    }
    return replaceUnique(
      source,
      pattern,
      [
        "function joinLogicalBlock(parts) {",
        '  const joined = parts.join(" ");',
        "  void joined;",
        "  return parts[0];",
        "}",
      ].join(eol),
      behavior,
    );
  }

  if (behavior === "mixed-duplicate") {
    const pattern =
      / {2}if \(!everyCandidateResolved \|\| keys\.size !== 1\) \{/gu;
    const replacement =
      mode === "absence"
        ? "  if (keys.size !== 1) {"
        : "  if ((false && !everyCandidateResolved) || keys.size !== 1) {";
    return replaceUnique(source, pattern, replacement, behavior);
  }

  throw new Error(`unknown parser behavior: ${behavior}`);
}

function requireParserMutationRed(t, fixture, mutation) {
  const control = runCli(fixture);
  assertOneFinding(control, mutation.expected);

  const source = readFileSync(TOOL, "utf8");
  const mutant = mutateParserBehavior(source, mutation.behavior, mutation.mode);
  const mutantPath = path.join(
    fixture.root,
    "Tools",
    `mutant-${mutation.behavior}-${mutation.mode}.mjs`,
  );
  writeFileSync(mutantPath, mutant, "utf8");
  const run = runCli(fixture, { tool: mutantPath });

  assert.equal(
    run.status,
    0,
    `mutant did not execute normally:\n${run.stdout}`,
  );
  assert.equal(run.report.exitCode, 0);
  assert.deepEqual(run.report.findings, []);

  let observed;
  try {
    assertOneFinding(run, mutation.expected);
  } catch (error) {
    if (error?.name === "AssertionError") {
      observed = error;
    } else {
      throw error;
    }
  }
  assert.ok(
    observed,
    `${mutation.mode.toUpperCase()} MUTANT STAYED GREEN for ${mutation.behavior}`,
  );
  t.diagnostic(
    `actual: RED — ${mutation.behavior} ${mutation.mode} returned 0 with no finding; fixture ${mutation.fixtureName} expected exit 1 + ${mutation.expected.verdict}`,
  );
}

const MUTATIONS = [
  {
    name: "status comparison ABSENCE",
    recorder: "recordDisagreement",
    mode: "absence",
    fixture: G2_CONFIG,
    expected: {
      verdict: "disagree",
      rowId: "C11-2",
      mirrorStatus: "COMPLETE",
      queueStatus: "REOPENED",
    },
  },
  {
    name: "status comparison INERTNESS",
    recorder: "recordDisagreement",
    mode: "inertness",
    fixture: G2_CONFIG,
    expected: {
      verdict: "disagree",
      rowId: "C11-2",
      mirrorStatus: "COMPLETE",
      queueStatus: "REOPENED",
    },
  },
  {
    name: "unresolvable-row ABSENCE",
    recorder: "recordUnresolvableRow",
    mode: "absence",
    fixture: G4_CONFIG,
    expected: {
      verdict: "unresolvable-row",
      rowId: "C11-4",
      mirrorStatus: "COMPLETE",
      queueStatus: "<unresolved>",
    },
  },
  {
    name: "unresolvable-row INERTNESS",
    recorder: "recordUnresolvableRow",
    mode: "inertness",
    fixture: G4_CONFIG,
    expected: {
      verdict: "unresolvable-row",
      rowId: "C11-4",
      mirrorStatus: "COMPLETE",
      queueStatus: "<unresolved>",
    },
  },
  {
    name: "unresolvable-status ABSENCE",
    recorder: "recordUnresolvableStatus",
    mode: "absence",
    fixture: G5_CONFIG,
    expected: {
      verdict: "unresolvable-status",
      rowId: "C11-5",
      mirrorStatus: "FROBNICATED",
      queueStatus: "COMPLETE",
    },
  },
  {
    name: "unresolvable-status INERTNESS",
    recorder: "recordUnresolvableStatus",
    mode: "inertness",
    fixture: G5_CONFIG,
    expected: {
      verdict: "unresolvable-status",
      rowId: "C11-5",
      mirrorStatus: "FROBNICATED",
      queueStatus: "COMPLETE",
    },
  },
];

for (const mutation of MUTATIONS) {
  test(`mutation: ${mutation.name} is caught by ${mutation.expected.verdict}`, (t) => {
    withFixture(mutation.fixture, (fixture) => {
      requireMutationRed(
        t,
        fixture,
        mutation.recorder,
        mutation.mode,
        mutation.expected,
      );
    });
  });
}

const PARSER_MUTATIONS = [
  {
    fixtureName: "B-P0-4 direct-status state bullet",
    behavior: "direct",
    fixture: DIRECT_STATUS_CONFIG,
    expected: {
      verdict: "disagree",
      rowId: "C11-22",
      mirrorStatus: "COMPLETE",
      queueStatus: "REOPENED",
    },
  },
  {
    fixtureName: "B-P0-1 fenced queue row",
    behavior: "fence",
    fixture: FENCED_QUEUE_CONFIG,
    expected: {
      verdict: "unresolvable-row",
      rowId: "C11-23",
      mirrorStatus: "COMPLETE",
      queueStatus: "<unresolved>",
    },
  },
  {
    fixtureName: "B-P0-2 struck queue status",
    behavior: "strike",
    fixture: STRUCK_QUEUE_CONFIG,
    expected: {
      verdict: "disagree",
      rowId: "C11-24",
      mirrorStatus: "COMPLETE",
      queueStatus: "REOPENED",
    },
  },
  {
    fixtureName: "B-P0-5 multiline state claim",
    behavior: "multiline",
    fixture: MULTILINE_STATUS_CONFIG,
    expected: {
      verdict: "disagree",
      rowId: "C11-25",
      mirrorStatus: "REOPENED",
      queueStatus: "COMPLETE",
    },
  },
  {
    fixtureName: "B-P0-3 mixed resolved and unresolved duplicates",
    behavior: "mixed-duplicate",
    fixture: MIXED_DUPLICATE_CONFIG,
    expected: {
      verdict: "unresolvable-status",
      rowId: "C11-26",
      mirrorStatus: "COMPLETE",
      queueStatus: "COMPLETE <> <unresolved>",
    },
  },
].flatMap((mutation) =>
  ["absence", "inertness"].map((mode) => ({ ...mutation, mode })),
);

for (const mutation of PARSER_MUTATIONS) {
  test(`mutation: ${mutation.behavior} ${mutation.mode.toUpperCase()} is caught by ${mutation.fixtureName}`, (t) => {
    withFixture(mutation.fixture, (fixture) => {
      requireParserMutationRed(t, fixture, mutation);
    });
  });
}
