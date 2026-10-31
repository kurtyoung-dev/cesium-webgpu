// context-spine-clone-codex.spec.mjs — Codex config edits and clone seeding, one part of the Context Spine spec.
// @purpose Hermetic tests for Codex config edits and clone seeding, split out of context-spine.spec.mjs by concern; test names and bodies are unchanged and the shared fixture repo lives in fixtures/context-spine-support.mjs.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { withLaneTmp } from "../lib/lane-tmp.mjs";
import {
  CODEX_MCP_TABLE_HEADER,
  codexMcpAdd,
  codexMcpRemove,
} from "./codex-mcp-config.mjs";
import { detectActiveCesiumRoot } from "./mcp-server.mjs";
import {
  capsuleSpineRoot,
  seedCloneContextSpine,
  SPINE_DB_REL_PATH,
} from "./seed-clone.mjs";
import { createHermeticFixtureRepo } from "./fixtures/context-spine-support.mjs";

describe("Cesium Context Spine (SQLite FTS5 + R-Tree + Seams + Contracts + MCP) - Codex config and clone seeding", () => {
  it("idempotently edits Codex config.toml in tmpdir, enforces NODE_ENV=test guard, and detects clone roots", () =>
    withLaneTmp("context-spine-codex-cfg-", async (dir) => {
      const cfgPath = path.join(dir, "config.toml");
      fs.writeFileSync(
        cfgPath,
        [
          "model = 'gpt-5'",
          "",
          "[mcp_servers.node_repl]",
          "args = []",
          "command = 'node_repl.exe'",
          "",
          "[desktop]",
          "appearanceTheme = 'dark'",
        ].join("\r\n"),
        "utf8",
      );

      // Guard refuses paths outside tmpdir when NODE_ENV="test"
      assert.throws(
        () =>
          codexMcpAdd({
            configPath: path.resolve("F:/outside-tmpdir/config.toml"),
            nodeEnv: "test",
            tmpdir: dir,
          }),
        /outside os\.tmpdir\(\)/,
      );

      const fakeServer = path.join(
        dir,
        "Tools",
        "context-spine",
        "mcp-server.mjs",
      );
      const r1 = codexMcpAdd({
        configPath: cfgPath,
        serverScriptPath: fakeServer,
        nodeEnv: "test",
        tmpdir: dir,
      });
      assert.equal(r1.changed, true);

      const afterAdd = fs.readFileSync(cfgPath, "utf8");
      assert.ok(afterAdd.includes(CODEX_MCP_TABLE_HEADER));
      assert.ok(afterAdd.includes(`args = ['${path.resolve(fakeServer)}']`));
      assert.ok(afterAdd.includes("[desktop]"));

      // Second add is a no-op
      const r2 = codexMcpAdd({
        configPath: cfgPath,
        serverScriptPath: fakeServer,
        nodeEnv: "test",
        tmpdir: dir,
      });
      assert.equal(r2.changed, false);

      // Remove restores surrounding sections cleanly
      const r3 = codexMcpRemove({
        configPath: cfgPath,
        nodeEnv: "test",
        tmpdir: dir,
      });
      assert.equal(r3.changed, true);
      const afterRemove = fs.readFileSync(cfgPath, "utf8");
      assert.ok(!afterRemove.includes(CODEX_MCP_TABLE_HEADER));
      assert.ok(afterRemove.includes("[mcp_servers.node_repl]"));
      assert.ok(afterRemove.includes("[desktop]"));

      // Active clone root detection
      createHermeticFixtureRepo(dir);
      fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
      const subDir = path.join(dir, "packages/engine/Source/Scene");
      assert.equal(detectActiveCesiumRoot(subDir), path.resolve(dir));
    }));

  it("GWIP-6: clone seeding copies the spine DB and .mcp.json, writes nothing in the source and leaves no pointer into it", () =>
    withLaneTmp("context-spine-gwip-seed-", async (dir) => {
      const source = path.join(dir, "source");
      const clone = path.join(dir, "clone");
      const srcDb = path.join(source, SPINE_DB_REL_PATH);
      fs.mkdirSync(path.dirname(srcDb), { recursive: true });
      fs.mkdirSync(clone, { recursive: true });
      fs.writeFileSync(srcDb, "db-bytes");
      fs.writeFileSync(`${srcDb}-wal`, "wal-bytes");
      fs.writeFileSync(path.join(source, ".mcp.json"), "{}");
      const venvBin = path.join(
        source,
        ".cache/context-spine/py-venv/Scripts/graphify.exe",
      );
      fs.mkdirSync(path.dirname(venvBin), { recursive: true });
      fs.writeFileSync(venvBin, "");

      assert.equal(
        capsuleSpineRoot({ sourceRepo: clone, clonePath: clone }),
        null,
      );

      const midWrite = seedCloneContextSpine({
        sourceRepo: source,
        clonePath: clone,
      });
      assert.ok(midWrite.some((n) => /-wal sidecar/.test(n)));
      assert.ok(!fs.existsSync(path.join(clone, SPINE_DB_REL_PATH)));
      assert.equal(
        fs.readFileSync(`${srcDb}-wal`, "utf8"),
        "wal-bytes",
        "the source is untouched",
      );
      assert.ok(fs.existsSync(path.join(clone, ".mcp.json")));
      assert.equal(
        capsuleSpineRoot({ sourceRepo: source, clonePath: clone }),
        source,
      );

      fs.rmSync(`${srcDb}-wal`);
      // A clone's own .mcp.json is never overwritten by a later seeding.
      fs.writeFileSync(path.join(clone, ".mcp.json"), '{"clone":"own"}');
      const seeded = seedCloneContextSpine({
        sourceRepo: source,
        clonePath: clone,
      });
      assert.ok(seeded.some((n) => /seeded \.cache\/context-spine/.test(n)));
      assert.equal(
        fs.readFileSync(path.join(clone, ".mcp.json"), "utf8"),
        '{"clone":"own"}',
        "the clone's own .mcp.json is kept",
      );
      assert.equal(
        fs.readFileSync(path.join(clone, SPINE_DB_REL_PATH), "utf8"),
        "db-bytes",
      );
      assert.ok(
        !fs.existsSync(
          path.join(clone, ".cache/context-spine/graphify-bin.txt"),
        ),
        "no pointer to the source's venv",
      );
      assert.equal(
        capsuleSpineRoot({ sourceRepo: source, clonePath: clone }),
        clone,
      );
    }));
});
