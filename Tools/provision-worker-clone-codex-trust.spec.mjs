/**
 * @purpose Behavioural spec for the --codex-trust / --codex-untrust line-based
 *   TOML editor in Tools/provision-worker-clone.mjs (R-2026-09-02-23 / DX-25):
 *   idempotent add, exact-two-line remove, unrelated-section preservation, and
 *   the os.tmpdir() write guard the destructive-test convention requires.
 * @status ACTIVE
 *
 * Every fixture lives under a freshly minted os.tmpdir() subdirectory, and its
 * location is asserted BEFORE any file is written (maintainer rule
 * 2026-08-31: a destructive-looking write must structurally prove its sandbox
 * before touching anything). No test in this file ever passes a configPath
 * outside os.tmpdir() to a function that would actually read or write it —
 * the "refused" and "inertness" cases exercise the guard in isolation, never
 * a real out-of-sandbox I/O attempt.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// F2 fix-round (Hirluin): `node --test` does not set NODE_ENV, so the
// os.tmpdir() guard's own default (`nodeEnv = process.env.NODE_ENV`) was
// live only because every call site below remembers to pass `nodeEnv:
// "test"` explicitly — a convention, not a structural guarantee. Node 22's
// test runner isolates each file into its own process by default, so
// setting this once here cannot leak into any other *.spec.mjs file in the
// same `node --test` invocation; it converts the convention into structure
// for this file without widening blast radius elsewhere.
process.env.NODE_ENV = "test";

function loadCodexTrustHelpers({ mutate } = {}) {
  const scriptPath = fileURLToPath(
    new URL("./provision-worker-clone.mjs", import.meta.url),
  );
  const script = fs.readFileSync(scriptPath, "utf8");
  const start = script.indexOf("// --- Codex trust helpers");
  const end = script.indexOf("export function provisionNodeModulesJunctions");
  assert.notEqual(start, -1, "codex trust helpers block start marker present");
  assert.notEqual(
    end,
    -1,
    "provisionNodeModulesJunctions boundary marker present",
  );
  assert.ok(
    start < end,
    "codex trust helpers block must precede provisionNodeModulesJunctions",
  );
  let declaration = script
    .slice(start, end)
    .replace(/^export function/gmu, "function");
  if (mutate) {
    const mutated = mutate(declaration);
    assert.notEqual(
      mutated,
      declaration,
      "mutate() must actually change the source text",
    );
    declaration = mutated;
  }
  const wrapped = `${declaration}\n({ toCodexTrustKey, resolveCodexConfigPath, assertCodexConfigTargetAllowed, codexTrustAdd, codexTrustRemove });`;
  return vm.runInNewContext(wrapped, { fs, os, path, process });
}

/** A fresh scratch directory, proven to be under os.tmpdir() before any write. */
function makeFixtureDir() {
  const realTmp = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-trust-spec-"));
  const realDir = fs.realpathSync(dir);
  assert.ok(
    realDir === realTmp || realDir.startsWith(realTmp + path.sep),
    `fixture directory must live under os.tmpdir(): ${realDir}`,
  );
  return dir;
}

// Representative of the real ~/.codex/config.toml shape (a leading comment
// block, four `[projects.'<path>']` tables — the narrowed 2026-09-02 trust
// set — then non-project tables). Not a copy of the real file: the lane rule
// forbids ever opening it. LF line endings throughout, trailing newline.
const FIXTURE_LINES = [
  "# Codex configuration (trust narrowed 2026-09-02).",
  "# Worker clones get their own [projects.'...'] entry when provisioned by",
  "# Tools/provision-worker-clone.mjs --codex-trust, and lose it at retirement",
  "# via --codex-untrust.",
  "",
  "[projects.'f:\\dev\\gh\\quest-league-llm-claude-be']",
  'trust_level = "trusted"',
  "",
  "[projects.'f:\\dev\\gh\\quest-league-llm-claude-pwa']",
  'trust_level = "trusted"',
  "",
  "[projects.'f:\\dev\\gh\\shared-types']",
  'trust_level = "trusted"',
  "",
  "[projects.'f:\\dev\\gh\\cesium-webgpu']",
  'trust_level = "trusted"',
  "",
  "[plugins.example-plugin]",
  "enabled = true",
  "",
  "[marketplaces.example]",
  'url = "https://example.invalid"',
  "",
];
const FIXTURE = FIXTURE_LINES.join("\n");

// F5 fix-round (Hirluin): the real config lives on Windows and CRLF is a
// realistic on-disk encoding for it, but nothing in the original 11 cases
// ever exercised detectEol against one. Same content, CRLF joins.
const CRLF_FIXTURE = FIXTURE_LINES.join("\r\n");

const NEW_CLONE_PATH = "F:/Dev/GH/Cesium-Lane-Test-Newclone-99990101";
const NEW_KEY = "f:\\dev\\gh\\cesium-lane-test-newclone-99990101";

// Manually authored expected result — independent of the algorithm under
// test — for "add lands at the end of the projects block, before [plugins.]".
const EXPECTED_AFTER_ADD = [
  ...FIXTURE_LINES.slice(0, 16), // through "trust_level" for cesium-webgpu
  `[projects.'${NEW_KEY}']`,
  'trust_level = "trusted"',
  ...FIXTURE_LINES.slice(16), // "" then [plugins.example-plugin] onward
].join("\n");

function writeFixture(dir) {
  const configPath = path.join(dir, "config.toml");
  fs.writeFileSync(configPath, FIXTURE, "utf8");
  return configPath;
}

test("add creates exactly the two lines at the end of the projects block, before [plugins.]", () => {
  const helpers = loadCodexTrustHelpers();
  const dir = makeFixtureDir();
  try {
    const configPath = writeFixture(dir);
    const result = helpers.codexTrustAdd({
      configPath,
      clonePath: NEW_CLONE_PATH,
      nodeEnv: "test",
    });
    assert.equal(result.changed, true);
    assert.equal(result.headerLine, `[projects.'${NEW_KEY}']`);
    const actual = fs.readFileSync(configPath, "utf8");
    assert.equal(actual, EXPECTED_AFTER_ADD);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("add is idempotent: a second run adds nothing and reports no change", () => {
  const helpers = loadCodexTrustHelpers();
  const dir = makeFixtureDir();
  try {
    const configPath = writeFixture(dir);
    const first = helpers.codexTrustAdd({
      configPath,
      clonePath: NEW_CLONE_PATH,
      nodeEnv: "test",
    });
    assert.equal(first.changed, true);
    const afterFirst = fs.readFileSync(configPath, "utf8");
    const second = helpers.codexTrustAdd({
      configPath,
      clonePath: NEW_CLONE_PATH,
      nodeEnv: "test",
    });
    assert.equal(second.changed, false);
    const afterSecond = fs.readFileSync(configPath, "utf8");
    assert.equal(afterSecond, afterFirst);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("untrust removes exactly the two lines for the target path, nothing else", () => {
  const helpers = loadCodexTrustHelpers();
  const dir = makeFixtureDir();
  try {
    const configPath = writeFixture(dir);
    helpers.codexTrustAdd({
      configPath,
      clonePath: NEW_CLONE_PATH,
      nodeEnv: "test",
    });
    assert.equal(fs.readFileSync(configPath, "utf8"), EXPECTED_AFTER_ADD);
    const result = helpers.codexTrustRemove({
      configPath,
      clonePath: NEW_CLONE_PATH,
      nodeEnv: "test",
    });
    assert.equal(result.changed, true);
    assert.equal(result.headerLine, `[projects.'${NEW_KEY}']`);
    // Round-trips exactly back to the untouched fixture — proof that add and
    // remove are each confined to their own two lines.
    assert.equal(fs.readFileSync(configPath, "utf8"), FIXTURE);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("untrust removes an existing mid-block entry without disturbing its neighbours", () => {
  const helpers = loadCodexTrustHelpers();
  const dir = makeFixtureDir();
  try {
    const configPath = writeFixture(dir);
    const result = helpers.codexTrustRemove({
      configPath,
      clonePath: "F:/Dev/GH/shared-types",
      nodeEnv: "test",
    });
    assert.equal(result.changed, true);
    const expected = [
      ...FIXTURE_LINES.slice(0, 11), // through the blank line before shared-types (index 10)
      // shared-types header (11) + trust_level (12) removed
      ...FIXTURE_LINES.slice(13),
    ].join("\n");
    assert.equal(fs.readFileSync(configPath, "utf8"), expected);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("untrust of a missing path is a no-op", () => {
  const helpers = loadCodexTrustHelpers();
  const dir = makeFixtureDir();
  try {
    const configPath = writeFixture(dir);
    const before = fs.readFileSync(configPath, "utf8");
    const result = helpers.codexTrustRemove({
      configPath,
      clonePath: "F:/Dev/GH/never-trusted-clone",
      nodeEnv: "test",
    });
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(configPath, "utf8"), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// F3 fix-round (Hirluin): a clone path containing an apostrophe used to
// write a TOML literal string the parser cannot close, corrupting every
// existing trust entry in the file, not just the new one. Refuse before any
// I/O — proved the same way the tmpdir guard is proved, with an fs stub
// that fails the test if touched at all.
test("codexTrustAdd refuses a clone path containing an apostrophe, before any read or write", () => {
  const helpers = loadCodexTrustHelpers();
  const untouchableFs = {
    readFileSync() {
      assert.fail(
        "must not read the config before the key-validation guard runs",
      );
    },
    writeFileSync() {
      assert.fail(
        "must not write the config before the key-validation guard runs",
      );
    },
    renameSync() {
      assert.fail("must not rename before the key-validation guard runs");
    },
  };
  assert.throws(
    () =>
      helpers.codexTrustAdd({
        configPath: path.join(os.tmpdir(), "irrelevant-config.toml"),
        clonePath: "F:/Dev/GH/cesium-lane-o'brien-20260902",
        nodeEnv: "test",
        fs: untouchableFs,
      }),
    /refusing to write an unrepresentable project key/u,
  );
});

test("codexTrustRemove also refuses a clone path containing an apostrophe, before any read or write", () => {
  const helpers = loadCodexTrustHelpers();
  const untouchableFs = {
    readFileSync() {
      assert.fail(
        "must not read the config before the key-validation guard runs",
      );
    },
    writeFileSync() {
      assert.fail(
        "must not write the config before the key-validation guard runs",
      );
    },
    renameSync() {
      assert.fail("must not rename before the key-validation guard runs");
    },
  };
  assert.throws(
    () =>
      helpers.codexTrustRemove({
        configPath: path.join(os.tmpdir(), "irrelevant-config.toml"),
        clonePath: "F:/Dev/GH/cesium-lane-o'brien-20260902",
        nodeEnv: "test",
        fs: untouchableFs,
      }),
    /refusing to write an unrepresentable project key/u,
  );
});

test("unrelated sections are byte-identical after add and after remove", () => {
  const helpers = loadCodexTrustHelpers();
  const dir = makeFixtureDir();
  try {
    const configPath = writeFixture(dir);
    const pluginsAndMarketplaces = FIXTURE_LINES.slice(16).join("\n");
    const leadingComment = FIXTURE_LINES.slice(0, 4).join("\n");
    helpers.codexTrustAdd({
      configPath,
      clonePath: NEW_CLONE_PATH,
      nodeEnv: "test",
    });
    const afterAdd = fs.readFileSync(configPath, "utf8");
    assert.ok(afterAdd.startsWith(leadingComment));
    assert.ok(afterAdd.endsWith(pluginsAndMarketplaces));
    helpers.codexTrustRemove({
      configPath,
      clonePath: NEW_CLONE_PATH,
      nodeEnv: "test",
    });
    const afterRemove = fs.readFileSync(configPath, "utf8");
    assert.ok(afterRemove.startsWith(leadingComment));
    assert.ok(afterRemove.endsWith(pluginsAndMarketplaces));
    assert.equal(afterRemove, FIXTURE);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveCodexConfigPath defaults to the user's real ~/.codex/config.toml", () => {
  const helpers = loadCodexTrustHelpers();
  const resolved = helpers.resolveCodexConfigPath({ args: [] });
  assert.equal(resolved, path.join(os.homedir(), ".codex", "config.toml"));
});

// F7 fix-round (Hirluin): before this fix, `--config` with no value fell
// back to the real config path, and `--config` followed by another flag
// took that flag's own text as the path. Both are now hard errors instead
// of silent behaviour a caller could trigger by accident.
test("resolveCodexConfigPath throws when --config has no following value, rather than falling back to the real config", () => {
  const helpers = loadCodexTrustHelpers();
  assert.throws(
    () => helpers.resolveCodexConfigPath({ args: ["--config"] }),
    /--config requires a path argument/u,
  );
});

test("resolveCodexConfigPath throws when --config is immediately followed by another flag, rather than treating it as the path", () => {
  const helpers = loadCodexTrustHelpers();
  assert.throws(
    () => helpers.resolveCodexConfigPath({ args: ["--config", "--dry-run"] }),
    /--config requires a path argument/u,
  );
  assert.throws(
    () => helpers.resolveCodexConfigPath({ args: ["--config", "--json"] }),
    /--config requires a path argument/u,
  );
  // A real path that merely starts with a dash-free segment is unaffected.
  const resolved = helpers.resolveCodexConfigPath({
    args: ["--config", "C:\\tmp\\config.toml"],
  });
  assert.equal(resolved, "C:\\tmp\\config.toml");
});

test("a target outside os.tmpdir() under NODE_ENV=test is refused before any read or write", () => {
  const helpers = loadCodexTrustHelpers();
  const outsideTmpdir = path.join(os.homedir(), ".codex", "config.toml");
  assert.throws(
    () =>
      helpers.assertCodexConfigTargetAllowed({
        configPath: outsideTmpdir,
        nodeEnv: "test",
        args: [],
      }),
    /refusing to touch/u,
  );
  // The guard must fire before codexTrustAdd/Remove ever call fs — prove it
  // with an fs stub that fails the test if touched at all.
  const untouchableFs = {
    readFileSync() {
      assert.fail("must not read the config before the tmpdir guard runs");
    },
    writeFileSync() {
      assert.fail("must not write the config before the tmpdir guard runs");
    },
    renameSync() {
      assert.fail("must not rename before the tmpdir guard runs");
    },
  };
  assert.throws(() =>
    helpers.codexTrustAdd({
      configPath: outsideTmpdir,
      clonePath: NEW_CLONE_PATH,
      nodeEnv: "test",
      fs: untouchableFs,
    }),
  );
  assert.throws(() =>
    helpers.codexTrustRemove({
      configPath: outsideTmpdir,
      clonePath: NEW_CLONE_PATH,
      nodeEnv: "test",
      fs: untouchableFs,
    }),
  );
});

test("--dry-run triggers the same tmpdir refusal as NODE_ENV=test, for an explicit --config target", () => {
  const helpers = loadCodexTrustHelpers();
  const outsideTmpdir = path.join(os.homedir(), ".codex", "config.toml");
  assert.throws(() =>
    helpers.assertCodexConfigTargetAllowed({
      configPath: outsideTmpdir,
      nodeEnv: "production",
      args: ["--dry-run"],
    }),
  );
  // Outside the guard (no test env, no --dry-run) the real config path is
  // exactly the intended target and must be allowed through untouched.
  assert.doesNotThrow(() =>
    helpers.assertCodexConfigTargetAllowed({
      configPath: outsideTmpdir,
      nodeEnv: "production",
      args: [],
    }),
  );
});

test("add and remove round-trip correctly against a CRLF-encoded config (the real config lives on Windows)", () => {
  const dir = makeFixtureDir();
  try {
    const configPath = path.join(dir, "config.toml");
    fs.writeFileSync(configPath, CRLF_FIXTURE, "utf8");
    const helpers = loadCodexTrustHelpers();
    const addResult = helpers.codexTrustAdd({
      configPath,
      clonePath: NEW_CLONE_PATH,
      nodeEnv: "test",
    });
    assert.equal(addResult.changed, true);
    const afterAdd = fs.readFileSync(configPath, "utf8");
    assert.equal(afterAdd, EXPECTED_AFTER_ADD.split("\n").join("\r\n"));
    assert.ok(
      !afterAdd.includes("\r\r") && !/[^\r]\n/u.test(afterAdd),
      "every line ending must be CRLF, never a bare LF or a doubled CR",
    );
    const removeResult = helpers.codexTrustRemove({
      configPath,
      clonePath: NEW_CLONE_PATH,
      nodeEnv: "test",
    });
    assert.equal(removeResult.changed, true);
    assert.equal(fs.readFileSync(configPath, "utf8"), CRLF_FIXTURE);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Index 12 of FIXTURE_LINES is the shared-types entry's trust_level line
// (see the fixture above: header at 11, trust_level at 12). A maintainer
// hand-edit of just that value is a plausible real-world config drift the
// remove path must refuse rather than guess past.
const HAND_EDITED_LINES = FIXTURE_LINES.slice();
HAND_EDITED_LINES[12] = 'trust_level = "untrusted"';
const HAND_EDITED_CONTENT = HAND_EDITED_LINES.join("\n");

test('untrust refuses to remove a header whose next line is not exactly trust_level = "trusted" (hand-edited config), and leaves the file untouched', () => {
  const dir = makeFixtureDir();
  try {
    const configPath = path.join(dir, "config.toml");
    fs.writeFileSync(configPath, HAND_EDITED_CONTENT, "utf8");
    const helpers = loadCodexTrustHelpers();
    assert.throws(
      () =>
        helpers.codexTrustRemove({
          configPath,
          clonePath: "F:/Dev/GH/shared-types",
          nodeEnv: "test",
        }),
      /refusing to remove/u,
    );
    assert.equal(fs.readFileSync(configPath, "utf8"), HAND_EDITED_CONTENT);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const EOL_INERTNESS_MUTANT =
  "detectEol is forced to always return LF, unpinning CRLF configs entirely";
test(`kills inertness mutant: ${EOL_INERTNESS_MUTANT}`, () => {
  const marker = 'return content.includes("\\r\\n") ? "\\r\\n" : "\\n";';
  const mutant = loadCodexTrustHelpers({
    mutate: (src) => {
      assert.ok(
        src.includes(marker),
        "detectEol marker text must exist verbatim in the current source",
      );
      return src.replace(marker, 'return "\\n"; // MUTANT: always LF');
    },
  });
  const real = loadCodexTrustHelpers();

  const realDir = makeFixtureDir();
  try {
    const configPath = path.join(realDir, "config.toml");
    fs.writeFileSync(configPath, CRLF_FIXTURE, "utf8");
    const result = real.codexTrustRemove({
      configPath,
      clonePath: "F:/Dev/GH/shared-types",
      nodeEnv: "test",
    });
    assert.equal(
      result.changed,
      true,
      "the real code finds and removes a pre-existing entry in a CRLF config",
    );
  } finally {
    fs.rmSync(realDir, { recursive: true, force: true });
  }

  const mutantDir = makeFixtureDir();
  try {
    const configPath = path.join(mutantDir, "config.toml");
    fs.writeFileSync(configPath, CRLF_FIXTURE, "utf8");
    const result = mutant.codexTrustRemove({
      configPath,
      clonePath: "F:/Dev/GH/shared-types",
      nodeEnv: "test",
    });
    // Forcing LF makes `content.split(eol)` split a CRLF file on bare "\n",
    // leaving a trailing "\r" baked into every original line. headerLine (no
    // trailing \r) then never equals lines[i] for any i, so
    // `lines.indexOf(headerLine)` is always -1 — the mutant silently reports
    // "not present" for an entry that plainly is, a false no-op that would
    // fail to revoke trust for the real (CRLF) config at retirement.
    assert.equal(
      result.changed,
      false,
      "the LF-forced mutant fails to find an existing entry in a CRLF config — proving detectEol is load-bearing",
    );
    assert.equal(
      fs.readFileSync(configPath, "utf8"),
      CRLF_FIXTURE,
      "consistent with reporting no change, the mutant also leaves the file untouched",
    );
  } finally {
    fs.rmSync(mutantDir, { recursive: true, force: true });
  }
});

const REFUSAL_INERTNESS_MUTANT =
  "the unexpected-trust_level-line refusal in codexTrustRemove is replaced with if (false)";
test(`kills inertness mutant: ${REFUSAL_INERTNESS_MUTANT}`, () => {
  const marker = 'if (!/^trust_level\\s*=\\s*"trusted"$/.test(trustLine)) {';
  const mutant = loadCodexTrustHelpers({
    mutate: (src) => {
      assert.ok(
        src.includes(marker),
        "refusal marker text must exist verbatim in the current source",
      );
      return src.replace(marker, "if (false) {");
    },
  });
  const real = loadCodexTrustHelpers();
  const dir = makeFixtureDir();
  try {
    const configPath = path.join(dir, "config.toml");
    fs.writeFileSync(configPath, HAND_EDITED_CONTENT, "utf8");
    assert.throws(
      () =>
        real.codexTrustRemove({
          configPath,
          clonePath: "F:/Dev/GH/shared-types",
          nodeEnv: "test",
        }),
      /refusing to remove/u,
      "the real refusal must throw for a hand-edited trust_level line",
    );
    assert.equal(
      fs.readFileSync(configPath, "utf8"),
      HAND_EDITED_CONTENT,
      "the real (correctly-refusing) call must not have modified the file",
    );
    const mutantResult = mutant.codexTrustRemove({
      configPath,
      clonePath: "F:/Dev/GH/shared-types",
      nodeEnv: "test",
    });
    assert.equal(
      mutantResult.changed,
      true,
      "the if(false) mutant deletes the wrong line instead of refusing — proving the check above is load-bearing",
    );
    assert.notEqual(fs.readFileSync(configPath, "utf8"), HAND_EDITED_CONTENT);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const GUARD_INERTNESS_MUTANT =
  "the tmpdir safety guard is made unconditionally inert (always returns, never throws)";
test(`kills inertness mutant: ${GUARD_INERTNESS_MUTANT}`, () => {
  const real = loadCodexTrustHelpers();
  const mutant = loadCodexTrustHelpers({
    mutate: (src) => {
      const eol = src.includes("\r\n") ? "\r\n" : "\n";
      const marker = `if (!guarded) {${eol}    return;${eol}  }`;
      assert.ok(
        src.includes(marker),
        "guard marker text must exist verbatim in the current source",
      );
      return src.replace(
        marker,
        `${marker}${eol}  return; // MUTANT: unconditionally inert — the throw below is unreachable`,
      );
    },
  });
  const outsideTmpdir = path.join(os.homedir(), ".codex", "config.toml");
  const probe = { configPath: outsideTmpdir, nodeEnv: "test", args: [] };
  assert.throws(
    () => real.assertCodexConfigTargetAllowed(probe),
    /refusing to touch/u,
    "the real guard must refuse an out-of-tmpdir target under test",
  );
  assert.doesNotThrow(
    () => mutant.assertCodexConfigTargetAllowed(probe),
    "the inert mutant must NOT refuse — proving the throw above is load-bearing",
  );
});

const INSERT_INERTNESS_MUTANT =
  "codexTrustAdd reports changed:true but the splice that inserts the entry is suppressed";
test(`kills inertness mutant: ${INSERT_INERTNESS_MUTANT}`, () => {
  const marker = "lines.splice(insertAt, 0, ...codexTrustEntryLines(key));";
  const mutant = loadCodexTrustHelpers({
    mutate: (src) => {
      assert.ok(
        src.includes(marker),
        "insertion marker text must exist verbatim in the current source",
      );
      return src.replace(marker, `/* MUTANT: suppressed */ void 0;`);
    },
  });
  const dir = makeFixtureDir();
  try {
    const configPath = writeFixture(dir);
    const result = mutant.codexTrustAdd({
      configPath,
      clonePath: NEW_CLONE_PATH,
      nodeEnv: "test",
    });
    // The mutant still claims success (it never re-checks what it wrote) —
    // that false claim is exactly the defect the exactness assertion below
    // would have caught on the real code path.
    assert.equal(result.changed, true);
    const actual = fs.readFileSync(configPath, "utf8");
    assert.notEqual(
      actual,
      EXPECTED_AFTER_ADD,
      "mutant must fail the exact-content assertion the real add test relies on",
    );
    assert.equal(
      actual,
      FIXTURE,
      "the mutant rewrote the file but inserted nothing",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// F1 fix-round (Hirluin): before this fix, --json combined with a trust
// flag wrote the human-readable trust line to stdout ahead of the JSON
// document, so JSON.parse(stdout) failed for every --json consumer. Proves
// the real CLI (not just the pure helpers) now emits one parseable document.
test("CLI: --json output remains valid JSON when combined with --codex-trust", () => {
  const dir = makeFixtureDir();
  try {
    const configPath = writeFixture(dir);
    const scriptPath = fileURLToPath(
      new URL("./provision-worker-clone.mjs", import.meta.url),
    );
    const cloneDir = path.join(dir, "json-clone");
    fs.mkdirSync(path.join(cloneDir, ".git"), { recursive: true });
    const childEnv = { ...process.env, NODE_ENV: "test" };
    const run = spawnSync(
      process.execPath,
      [
        scriptPath,
        cloneDir,
        "--verify-only",
        "--json",
        "--codex-trust",
        "--config",
        configPath,
      ],
      { encoding: "utf8", env: childEnv },
    );
    let parsed;
    assert.doesNotThrow(
      () => {
        parsed = JSON.parse(run.stdout);
      },
      `--json stdout must be valid JSON even when a trust flag ran; got: ${JSON.stringify(run.stdout)}`,
    );
    assert.ok(
      parsed.notes.some((n) => /codex trust: added/u.test(n)),
      "the trust outcome must still be reported, just inside the JSON document, not ahead of it",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// F4 fix-round (Hirluin): --codex-untrust must revoke trust for a clone
// whose directory is ALREADY GONE — that is the retirement case, and it is
// the one shape the pure-function tests above cannot exercise, because the
// .git-clone check the fix bypasses lives at CLI/process level, ahead of
// every exported helper. Spawns the real script as a subprocess, entirely
// inside this fixture's os.tmpdir() subtree (clone dir and --config both).
test("CLI: --codex-untrust revokes a retired clone whose directory has already been removed", () => {
  const dir = makeFixtureDir();
  try {
    const configPath = writeFixture(dir);
    const scriptPath = fileURLToPath(
      new URL("./provision-worker-clone.mjs", import.meta.url),
    );
    const cloneDir = path.join(dir, "retired-clone");
    fs.mkdirSync(path.join(cloneDir, ".git"), { recursive: true });
    const helpers = loadCodexTrustHelpers();
    const key = helpers.toCodexTrustKey(cloneDir);
    const headerLine = `[projects.'${key}']`;
    const childEnv = { ...process.env, NODE_ENV: "test" };

    // Step 1: trust the clone while it still exists (ordinary provisioning
    // shape). --verify-only keeps this call from touching anything besides
    // the config and the pre-existing .git marker.
    const trustRun = spawnSync(
      process.execPath,
      [
        scriptPath,
        cloneDir,
        "--verify-only",
        "--codex-trust",
        "--config",
        configPath,
      ],
      { encoding: "utf8", env: childEnv },
    );
    assert.match(
      trustRun.stdout,
      /codex trust: added/u,
      `trust step must report success; stderr: ${trustRun.stderr}`,
    );
    assert.ok(fs.readFileSync(configPath, "utf8").includes(headerLine));

    // Step 2: retire the clone — delete the directory the .git check would
    // otherwise require — then revoke trust for the same path string.
    fs.rmSync(cloneDir, { recursive: true, force: true });
    assert.ok(
      !fs.existsSync(cloneDir),
      "clone directory must actually be gone before exercising --codex-untrust",
    );
    const untrustRun = spawnSync(
      process.execPath,
      [scriptPath, cloneDir, "--codex-untrust", "--config", configPath],
      { encoding: "utf8", env: childEnv },
    );
    assert.equal(
      untrustRun.status,
      0,
      `untrust-only on a retired clone must exit 0, not the old "not a git clone" exit 2; ` +
        `stdout: ${untrustRun.stdout}; stderr: ${untrustRun.stderr}`,
    );
    assert.match(untrustRun.stdout, /codex trust: removed/u);
    const afterUntrust = fs.readFileSync(configPath, "utf8");
    assert.ok(!afterUntrust.includes(headerLine));
    assert.equal(
      afterUntrust,
      FIXTURE,
      "untrust must round-trip the config back to its pre-trust state",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
