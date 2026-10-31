// context-spine-graphify-mcp.spec.mjs — Graphify import and bootstrap, and MCP stdio framing, one part of the Context Spine spec.
// @purpose Hermetic tests for Graphify import and bootstrap, and MCP stdio framing, split out of context-spine.spec.mjs by concern; test names and bodies are unchanged and the shared fixture repo lives in fixtures/context-spine-support.mjs.
// @status ACTIVE

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { withLaneTmp } from "../lib/lane-tmp.mjs";
import {
  graphifyPipRequirement,
  importGraphifyJson,
  resolveGraphifyBinary,
} from "./graphify-bridge.mjs";
import { buildContextSpine, querySymbols } from "./query-engine.mjs";
import { openContextDatabase } from "./schema.mjs";
import { createHermeticFixtureRepo } from "./fixtures/context-spine-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.join(__dirname, "mcp-server.mjs");

describe("Cesium Context Spine (SQLite FTS5 + R-Tree + Seams + Contracts + MCP) - Graphify and MCP", () => {
  it("imports Graphify --code-only graph.json communities and call edges while dropping utility hub noise", () =>
    withLaneTmp("context-spine-graphify-", async (dir) => {
      createHermeticFixtureRepo(dir);
      const dbRel = ".cache/context-spine/test.sqlite";
      await buildContextSpine({ repoRoot: dir, dbPath: dbRel });

      const graphJsonPath = path.join(dir, "mock-graphify.json");
      fs.writeFileSync(
        graphJsonPath,
        JSON.stringify({
          nodes: [
            {
              id: "n_model_update",
              label: "Model",
              source_file: "Scene/Model.js",
              source_location: "L2",
              community: 42,
            },
            {
              id: "n_renderer",
              label: "WebGPUModelRenderer",
              source_file: "Renderer/WebGPU/WebGPUModelRenderer.ts",
              source_location: "L4",
              community: 42,
            },
            {
              id: "n_defined",
              label: "defined()",
              source_file: "Core/defined.js",
              source_location: "L1",
              community: 1,
            },
          ],
          links: [
            {
              source: "n_model_update",
              target: "n_renderer",
              relation: "calls",
              confidence: "EXTRACTED",
              source_file: "Scene/Model.js",
              source_location: "L4",
            },
            {
              source: "n_model_update",
              target: "n_defined",
              relation: "calls",
              confidence: "EXTRACTED",
              source_file: "Scene/Model.js",
              source_location: "L3",
            },
          ],
        }),
        "utf8",
      );

      const writable = openContextDatabase(path.join(dir, dbRel), {
        readOnly: false,
      });
      try {
        const res = importGraphifyJson(writable, graphJsonPath, dir, {
          scanPrefix: "packages/engine/Source",
        });
        assert.equal(res.importedEdges, 1);
        assert.equal(res.skippedUtilityEdges, 1);
        assert.ok(res.updatedSymbolCommunities >= 2);

        const hits = querySymbols(writable, dir, "WebGPUModelRenderer");
        const cls = hits.find((h) => h.kind === "class");
        assert.equal(cls.communityId, 42);
      } finally {
        writable.close();
      }
    }));

  it("serves JSON-RPC 2.0 MCP initialize, tools/list, and tools/call over stdio", () =>
    withLaneTmp("context-spine-mcp-", async (dir) => {
      createHermeticFixtureRepo(dir);
      const dbRel = ".cache/context-spine/test.sqlite";
      await buildContextSpine({ repoRoot: dir, dbPath: dbRel });

      const child = spawn(
        process.execPath,
        [MCP_SERVER_PATH, "--repo", dir, "--db", dbRel],
        { stdio: ["pipe", "pipe", "pipe"] },
      );

      const responses = [];
      let stdoutBuf = "";
      const waitForCount = (expected) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new Error(`Timed out waiting for ${expected} MCP responses`),
              ),
            5000,
          );
          const onData = (chunk) => {
            stdoutBuf += chunk.toString("utf8");
            let idx;
            while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
              const line = stdoutBuf.slice(0, idx).trim();
              stdoutBuf = stdoutBuf.slice(idx + 1);
              if (line) responses.push(JSON.parse(line));
            }
            if (responses.length >= expected) {
              clearTimeout(timer);
              child.stdout.off("data", onData);
              resolve();
            }
          };
          child.stdout.on("data", onData);
        });

      try {
        const waitAll = waitForCount(3);
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`,
        );
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
        );
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "cesium_impact_pack", arguments: { target: "WebGPUModelRenderer.ts" } } })}\n`,
        );

        await waitAll;
        assert.equal(
          responses[0].result.serverInfo.name,
          "cesium-context-spine",
        );
        assert.equal(responses[1].result.tools.length, 8);
        const toolNames = responses[1].result.tools.map((t) => t.name);
        assert.ok(toolNames.includes("cesium_query_seams"));
        assert.ok(toolNames.includes("cesium_dead_exports"));
        assert.equal(responses[2].result.isError, false);
        assert.match(
          responses[2].result.content[0].text,
          /Impact Pack: `WebGPUModelRenderer\.ts`/,
        );
      } finally {
        const exited =
          child.exitCode !== null
            ? Promise.resolve()
            : new Promise((resolve) => child.once("close", resolve));
        child.stdin.end();
        child.kill();
        await exited;
      }
    }));

  it("GWIP-5: the Graphify bootstrap refuses an unpinned install before creating or spawning anything", () =>
    withLaneTmp("context-spine-gwip-graphify-", async (dir) => {
      assert.equal(graphifyPipRequirement("0.4.2"), "graphifyy==0.4.2");
      for (const bad of [undefined, "", "latest", ">=0.4", "0.4.2; rm"]) {
        assert.throws(() => graphifyPipRequirement(bad), /exact version pin/);
      }
      const spawned = [];
      const spy = (...args) => {
        spawned.push(args);
        return { status: 1, stdout: "", stderr: "spy" };
      };
      assert.throws(
        () =>
          resolveGraphifyBinary(dir, {
            bootstrapVenv: true,
            pathProbe: false,
            spawnSyncImpl: spy,
          }),
        /exact version pin/,
      );
      assert.equal(spawned.length, 0, "nothing spawned without a pin");
      assert.ok(!fs.existsSync(path.join(dir, ".cache/context-spine/py-venv")));
      assert.ok(!fs.existsSync(path.join(dir, ".cache/context-spine/tmp")));

      // With a pin the install names exactly that version.
      resolveGraphifyBinary(dir, {
        bootstrapVenv: true,
        graphifyVersion: "0.4.2",
        pathProbe: false,
        spawnSyncImpl: (cmd, args) => {
          spawned.push([cmd, args]);
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      const pip = spawned.find(([, args]) => args.includes("pip"));
      assert.ok(pip && pip[1].includes("graphifyy==0.4.2"));

      const pkg = JSON.parse(
        fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"),
      );
      assert.doesNotMatch(
        pkg.scripts["context-graphify"],
        /--bootstrap-graphify/,
        "no npm script installs from the network",
      );
    }));
});
