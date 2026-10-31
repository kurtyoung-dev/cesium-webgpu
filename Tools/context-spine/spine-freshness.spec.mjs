// spine-freshness.spec.mjs — Hermetic tests for the context spine's freshness guards: the incremental build never resets, a reset refuses a held database, and clone seeding refreshes a stale DB.
// @purpose Verify that `build --incremental --with-graphify` keeps existing rows, that `openContextDatabase` refuses a reset with a clear message when another process holds the DB (nothing deleted), and that `seedCloneContextSpine` runs the clone's incremental build exactly when the seeded DB's head_sha differs from the clone's HEAD.
// @status ACTIVE

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { buildContextSpine } from "./query-engine.mjs";
import { openContextDatabase } from "./schema.mjs";
import { SPINE_DB_REL_PATH, seedCloneContextSpine } from "./seed-clone.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.resolve(__dirname, "..");
const REFUSAL =
  "the cesium-context-spine MCP server holds the database; use the incremental build or close the session's MCP server";
const GIT_IDENTITY = [
  "-c",
  "user.name=spec",
  "-c",
  "user.email=spec@example.invalid",
];

function writeFile(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function createMiniRepo(dir) {
  writeFile(dir, "package.json", JSON.stringify({ name: "spine-fixture" }));
  writeFile(
    dir,
    "packages/engine/Source/Scene/Model.js",
    "export class Model {\n  update() {\n    return 1;\n  }\n}\n",
  );
}

function metaValue(dbFile, key) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value;
  } finally {
    db.close();
  }
}

function setMeta(dbFile, key, value) {
  const db = new DatabaseSync(dbFile);
  try {
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(
      key,
      value,
    );
  } finally {
    db.close();
  }
}

function git(dir, ...args) {
  const res = spawnSync("git", ["-C", dir, ...GIT_IDENTITY, ...args], {
    encoding: "utf8",
  });
  assert.equal(res.status, 0, `git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

async function withGraphifyEnv(binPath, body) {
  const previous = process.env.GRAPHIFY_BIN;
  process.env.GRAPHIFY_BIN = binPath;
  try {
    return await body();
  } finally {
    if (previous === undefined) {
      delete process.env.GRAPHIFY_BIN;
    } else {
      process.env.GRAPHIFY_BIN = previous;
    }
  }
}

describe("spine freshness: incremental build", () => {
  it("keeps existing rows through an incremental build with graphify; a full build drops them", () =>
    withLaneTmp("spine-fresh-incr-", async (dir) => {
      createMiniRepo(dir);
      const dbFile = path.join(dir, SPINE_DB_REL_PATH);
      await buildContextSpine({ repoRoot: dir });
      setMeta(dbFile, "spec_sentinel", "alive");

      // `node extract <target> --code-only --out <dir>` stands in for graphify.
      const graphifyDir = path.join(dir, ".cache", "context-spine", "graphify");
      fs.mkdirSync(graphifyDir, { recursive: true });
      fs.writeFileSync(
        path.join(graphifyDir, "extract"),
        `const fs = require("node:fs");
const path = require("node:path");
const out = process.argv[process.argv.indexOf("--out") + 1];
fs.mkdirSync(path.join(out, "graphify-out"), { recursive: true });
fs.writeFileSync(
  path.join(out, "graphify-out", "graph.json"),
  JSON.stringify({
    nodes: [{ id: "n1", label: "Model", source_file: "packages/engine/Source/Scene/Model.js" }],
    links: [],
  }),
);
`,
      );

      const stats = await withGraphifyEnv(process.execPath, () =>
        buildContextSpine({
          repoRoot: dir,
          incremental: true,
          withGraphify: true,
        }),
      );
      assert.equal(stats.graphify?.executed, true);
      assert.ok(metaValue(dbFile, "graphify_imported_at"));
      assert.equal(metaValue(dbFile, "spec_sentinel"), "alive");

      // Control: the sentinel assertion can go red.
      await buildContextSpine({ repoRoot: dir });
      assert.equal(metaValue(dbFile, "spec_sentinel"), undefined);
    }));
});

describe("spine freshness: a reset refuses a held database", () => {
  it("throws the named message with the original code, deleting nothing", () =>
    withLaneTmp("spine-fresh-refuse-", async (dir) => {
      createMiniRepo(dir);
      const dbFile = path.join(dir, SPINE_DB_REL_PATH);
      await buildContextSpine({ repoRoot: dir });
      setMeta(dbFile, "spec_sentinel", "alive");

      const busy = Object.assign(new Error("resource busy"), { code: "EPERM" });
      let caught;
      try {
        openContextDatabase(dbFile, {
          reset: true,
          removeFile: () => {
            throw busy;
          },
        });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, "reset must refuse");
      assert.ok(caught.message.includes(REFUSAL), caught.message);
      assert.equal(caught.code, "EPERM");
      assert.equal(caught.cause, busy);
      assert.ok(fs.existsSync(dbFile));
      assert.equal(metaValue(dbFile, "spec_sentinel"), "alive");
    }));

  it(
    "a real held file refuses the CLI full build and still allows the incremental build",
    { skip: process.platform !== "win32" },
    () =>
      withLaneTmp("spine-fresh-held-", async (dir) => {
        createMiniRepo(dir);
        const dbFile = path.join(dir, SPINE_DB_REL_PATH);
        await buildContextSpine({ repoRoot: dir });
        setMeta(dbFile, "spec_sentinel", "alive");

        const cli = path.join(TOOLS_DIR, "query-context.mjs");
        const run = (...flags) =>
          spawnSync(process.execPath, [cli, "build", ...flags, "--repo", dir], {
            encoding: "utf8",
            timeout: 120000,
          });
        const held = new DatabaseSync(dbFile);
        try {
          held.prepare("SELECT count(*) FROM meta").get();
          const full = run();
          assert.equal(full.status, 1, full.stdout + full.stderr);
          assert.ok(full.stderr.includes(REFUSAL), full.stderr);
          assert.ok(fs.existsSync(dbFile));

          const incremental = run("--incremental");
          assert.equal(incremental.status, 0, incremental.stderr);
        } finally {
          held.close();
        }
        assert.equal(metaValue(dbFile, "spec_sentinel"), "alive");
      }),
  );
});

describe("spine freshness: clone seeding refreshes a stale DB", () => {
  const SHA_DB = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const SHA_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  function seedWith(dir, { dbSha, headSha, run, refreshSpine }) {
    const clonePath = path.join(dir, "clone");
    const dbFile = path.join(clonePath, SPINE_DB_REL_PATH);
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    fs.writeFileSync(dbFile, "placeholder");
    const calls = [];
    const notes = seedCloneContextSpine({
      sourceRepo: path.join(dir, "source"),
      clonePath,
      refreshSpine,
      readDbHeadSha: () => dbSha,
      readCloneHead: () => headSha,
      runIncrementalBuild: (c) => {
        calls.push(c);
        run?.(c);
      },
    });
    return { notes, calls, clonePath };
  }

  it("runs nothing when the DB is at the clone's HEAD", () =>
    withLaneTmp("spine-fresh-same-", (dir) => {
      const { notes, calls } = seedWith(dir, {
        dbSha: SHA_HEAD,
        headSha: SHA_HEAD,
      });
      assert.equal(calls.length, 0);
      assert.ok(
        notes.some((n) => n.includes("current") && n.includes("bbbbbbbbbb")),
        notes.join("\n"),
      );
    }));

  it("runs the build exactly once in the clone when the SHAs differ", () =>
    withLaneTmp("spine-fresh-diff-", (dir) => {
      const { notes, calls, clonePath } = seedWith(dir, {
        dbSha: SHA_DB,
        headSha: SHA_HEAD,
      });
      assert.deepEqual(calls, [clonePath]);
      const note = notes.find((n) => n.includes("aaaaaaaaaa"));
      assert.ok(note?.includes("bbbbbbbbbb"), notes.join("\n"));
      assert.match(note, /\d+\.\d+s/);
      assert.ok(!notes.some((n) => n.startsWith("WARNING:")));
    }));

  it("treats a DB without head_sha as stale", () =>
    withLaneTmp("spine-fresh-nosha-", (dir) => {
      const { calls } = seedWith(dir, { dbSha: null, headSha: SHA_HEAD });
      assert.equal(calls.length, 1);
    }));

  it("runs nothing when refreshSpine is false", () =>
    withLaneTmp("spine-fresh-off-", (dir) => {
      const { calls } = seedWith(dir, {
        dbSha: SHA_DB,
        headSha: SHA_HEAD,
        refreshSpine: false,
      });
      assert.equal(calls.length, 0);
    }));

  it("reports a failed refresh as a WARNING naming both SHAs without throwing", () =>
    withLaneTmp("spine-fresh-fail-", (dir) => {
      const { notes, calls } = seedWith(dir, {
        dbSha: SHA_DB,
        headSha: SHA_HEAD,
        run: () => {
          throw new Error("boom");
        },
      });
      assert.equal(calls.length, 1);
      const warning = notes.find((n) => n.startsWith("WARNING:"));
      assert.ok(warning, notes.join("\n"));
      assert.ok(
        warning.includes("aaaaaaaaaa") && warning.includes("bbbbbbbbbb"),
      );
      assert.ok(warning.includes("stale"));
      assert.ok(warning.includes("boom"));
    }));

  it("end to end: the clone's own incremental build moves a real DB from commit A to commit B", () =>
    withLaneTmp("spine-fresh-e2e-", async (dir) => {
      const clonePath = path.join(dir, "clone");
      createMiniRepo(clonePath);
      // The clone carries its own copy of the tool; the default runner runs it.
      fs.cpSync(
        path.join(TOOLS_DIR, "context-spine"),
        path.join(clonePath, "Tools", "context-spine"),
        { recursive: true, filter: (src) => !src.endsWith(".spec.mjs") },
      );
      fs.copyFileSync(
        path.join(TOOLS_DIR, "query-context.mjs"),
        path.join(clonePath, "Tools", "query-context.mjs"),
      );
      writeFile(clonePath, ".gitignore", ".cache/\n");
      git(clonePath, "init", "-q");
      git(clonePath, "add", "-A");
      git(clonePath, "commit", "-q", "-m", "A");
      const commitA = git(clonePath, "rev-parse", "HEAD");
      await buildContextSpine({ repoRoot: clonePath });
      const dbFile = path.join(clonePath, SPINE_DB_REL_PATH);
      assert.equal(metaValue(dbFile, "head_sha"), commitA);

      writeFile(
        clonePath,
        "packages/engine/Source/Scene/Other.js",
        "export class Other {}\n",
      );
      git(clonePath, "add", "-A");
      git(clonePath, "commit", "-q", "-m", "B");
      const commitB = git(clonePath, "rev-parse", "HEAD");
      assert.notEqual(commitA, commitB);

      const notes = seedCloneContextSpine({
        sourceRepo: path.join(dir, "no-source"),
        clonePath,
      });
      assert.equal(metaValue(dbFile, "head_sha"), commitB, notes.join("\n"));
      assert.ok(!notes.some((n) => n.startsWith("WARNING:")), notes.join("\n"));
      assert.ok(notes.some((n) => n.includes(commitB.slice(0, 10))));

      // A second seed finds the DB current and runs nothing.
      const again = seedCloneContextSpine({
        sourceRepo: path.join(dir, "no-source"),
        clonePath,
      });
      assert.ok(
        again.some((n) => n.includes("current")),
        again.join("\n"),
      );
    }));
});
