// context-spine.spec.mjs — Hermetic unit, mutation, and stdio MCP integration tests for Tools/context-spine.
// @purpose Verify code/WGSL/GLSL seam indexing, SHA-256 disk-staleness relocation, Charter §0.4 ruling precedence, SQLite R-tree spatial rig covers, RTE/CameraUniforms hazard guards, Graphify bridge, and MCP stdio framing.
// @status ACTIVE
//
// SPLIT BY CONCERN (the pattern of probe-landing-cells.spec.mjs and its parts): this file keeps indexing, seams, rulings, rig covers, incremental builds and impact packs; the other groups live in context-spine-spatial-hazards, -graphify-mcp and -clone-codex (.spec.mjs), which share fixtures/context-spine-support.mjs. Test names and bodies are unchanged; all four run under test-context-spine.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { ecefToWgs84 } from "./extract-spatial.mjs";
import {
  buildContextSpine,
  buildImpactPack,
  formatImpactPackMarkdown,
  generateContextCapsule,
  openOrBuildSpine,
  queryContracts,
  queryLedger,
  querySeams,
  querySpatialValidation,
  querySymbols,
} from "./query-engine.mjs";
import { createHermeticFixtureRepo } from "./fixtures/context-spine-support.mjs";

describe("Cesium Context Spine (SQLite FTS5 + R-Tree + Seams + Contracts + MCP)", () => {
  it("converts ECEF coordinates to WGS84 lon/lat/height accurately", () => {
    const eq = ecefToWgs84(6378137.0, 0, 0);
    assert.ok(Math.abs(eq.lon - 0) < 1e-6);
    assert.ok(Math.abs(eq.lat - 0) < 1e-6);
    assert.ok(Math.abs(eq.height - 0) < 1e-3);

    const northPole = ecefToWgs84(0, 0, 6356752.314245179 + 1000.0);
    assert.equal(northPole.lat, 90);
    assert.ok(Math.abs(northPole.height - 1000.0) < 1e-2);
  });

  it("indexes JS/TS/WGSL/GLSL seams, detects live SHA-256 disk drift, and relocates moved symbols", () =>
    withLaneTmp("context-spine-seams-", async (dir) => {
      createHermeticFixtureRepo(dir);
      const dbRel = ".cache/context-spine/test.sqlite";
      const stats = await buildContextSpine({ repoRoot: dir, dbPath: dbRel });

      assert.ok(stats.code.fileCount >= 6);
      assert.equal(stats.spatial.rigCount, 3);
      assert.equal(stats.spatial.geoIndexedCount, 2);

      const db = await openOrBuildSpine(dir, {
        dbPath: dbRel,
        autoBuild: false,
      });
      try {
        // 1. FeatureRendererKey bridge: Scene/Model.js <-> frkey:MODEL <-> WebGPUModelRenderer.ts
        const modelSeams = querySeams(db, "Model.js");
        const hasConsumer = modelSeams.seamEdges.some(
          (e) =>
            e.relation === "consumes_feature_renderer" &&
            e.dst_id === "frkey:MODEL",
        );
        const hasRegistration = modelSeams.counterpartEdges.some(
          (e) =>
            e.relation === "registers_feature_renderer" &&
            e.src_id === "frkey:MODEL" &&
            e.dst_id.endsWith("WebGPUModelRenderer.ts"),
        );
        assert.ok(hasConsumer, "expected Model.js to consume frkey:MODEL");
        assert.ok(
          hasRegistration,
          "expected counterpart registration in WebGPUModelRenderer.ts",
        );

        // 2. ShaderDefineExt + WGSL //>>ifdef + GLSL<->WGSL parity bridge
        const defineSeams = querySeams(db, "CLOUD_SHADOWMAP");
        assert.equal(defineSeams.defineDetails.length, 1);
        assert.match(
          defineSeams.defineDetails[0].signature,
          /ext\[bit 4\] CLOUD_SHADOWMAP — owner: clouds/,
        );
        assert.ok(
          defineSeams.seamEdges.some(
            (e) =>
              e.relation === "ifdef_guards" &&
              e.src_id.endsWith("ModelPBR.wgsl"),
          ),
        );
        assert.ok(
          defineSeams.seamEdges.some(
            (e) =>
              e.relation === "reads_shader_define" &&
              e.src_id.endsWith("WebGPUModelRenderer.ts"),
          ),
        );

        const pbrSeams = querySeams(db, "ModelPBR.wgsl");
        assert.ok(
          pbrSeams.seamEdges.some(
            (e) =>
              e.relation === "glsl_wgsl_parity" &&
              e.dst_id.endsWith("ModelPBRFS.glsl"),
          ),
        );

        // Verify fresh slice before mutating disk
        const beforeHits = querySymbols(db, dir, "renderModel", {
          includeSlice: true,
        });
        assert.equal(beforeHits.length, 1);
        assert.equal(beforeHits[0].slice.fresh, true);
        assert.equal(beforeHits[0].slice.relocated, false);
        const origLine = beforeHits[0].startLine;

        // Mutate WebGPUModelRenderer.ts on disk by prepending 7 lines WITHOUT rebuilding SQLite
        const rendererAbs = path.join(
          dir,
          "packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts",
        );
        const origText = fs.readFileSync(rendererAbs, "utf8");
        const prefix = Array.from(
          { length: 7 },
          (_, i) => `// shift ${i}`,
        ).join("\n");
        fs.writeFileSync(rendererAbs, `${prefix}\n${origText}`, "utf8");

        const afterHits = querySymbols(db, dir, "renderModel", {
          includeSlice: true,
        });
        assert.equal(afterHits[0].slice.fresh, false);
        assert.equal(afterHits[0].slice.relocated, true);
        assert.equal(afterHits[0].startLine, origLine + 7);
        assert.match(afterHits[0].slice.snippet, /renderModel\(uniformState\)/);

        const stalePack = buildImpactPack(db, dir, "WebGPUModelRenderer.ts");
        assert.equal(stalePack.fileFreshness.fresh, false);
        assert.match(
          formatImpactPackMarkdown(stalePack),
          /STALE_INDEX_WARNING/,
        );
      } finally {
        db.close();
      }
    }));

  it("enforces Charter §0.4 authority order, marks amended rulings, and orders DEFERRED_WORK by Batch number", () =>
    withLaneTmp("context-spine-ledger-", async (dir) => {
      createHermeticFixtureRepo(dir);
      const dbRel = ".cache/context-spine/test.sqlite";
      await buildContextSpine({ repoRoot: dir, dbPath: dbRel });
      const db = await openOrBuildSpine(dir, {
        dbPath: dbRel,
        autoBuild: false,
      });

      try {
        const activeRows = queryLedger(db, "WebGPUModelRenderer.ts", {
          activeOnly: true,
          limit: 20,
        });

        // Superseded ruling R-2026-09-16-8, DONE queue row C16-08, and SHIPPED deferred item must NOT pollute activeOnly results
        const ids = activeRows.map((r) => r.id);
        assert.ok(ids.includes("R-2026-09-17-3"));
        assert.ok(!ids.includes("R-2026-09-16-8"));
        assert.ok(ids.includes("queue:C16-21"));
        assert.ok(!ids.includes("queue:C16-08"));
        assert.ok(ids.includes("campaign:C12"));
        assert.ok(ids.includes("hotspot:WebGPUModelRenderer.ts"));
        assert.ok(!ids.includes("deferred-work:NEW-MODEL-SHIPPED-ITEM"));

        // Verify strict Charter §0.4 rank monotonicity (1 <= 2 <= 3 <= 4 <= 5)
        for (let i = 1; i < activeRows.length; i += 1) {
          assert.ok(
            activeRows[i].authorityRank >= activeRows[i - 1].authorityRank,
            `authority rank out of order: ${activeRows[i - 1].id} (${activeRows[i - 1].authorityRank}) vs ${activeRows[i].id} (${activeRows[i].authorityRank})`,
          );
        }

        // Within DEFERRED_WORK (rank 5), Batch 1455 must rank ahead of Batch 900
        const idxNewer = ids.indexOf("deferred-work:NEW-MODEL-NEWER-NOTE");
        const idxOlder = ids.indexOf("deferred-work:NEW-MODEL-OLDER-NOTE");
        assert.ok(idxNewer !== -1 && idxOlder !== -1 && idxNewer < idxOlder);

        // CAMPAIGN_STATE summary prioritizes the latest `Status added 2026-09-19` addendum
        const c12 = activeRows.find((r) => r.id === "campaign:C12");
        assert.match(c12.summary, /Status added 2026-09-19/);

        // Direct ID lookup on the superseded ruling surfaces both the ACTIVE superseding ruling and the AMENDED target
        const amended = queryLedger(db, "R-2026-09-16-8");
        assert.equal(amended.length, 2);
        assert.equal(amended[0].id, "R-2026-09-17-3");
        assert.equal(amended[0].status, "ACTIVE");
        assert.equal(amended[1].id, "R-2026-09-16-8");
        assert.equal(amended[1].status, "AMENDED");
        assert.match(amended[1].summary, /\[Amended by R-2026-09-17-3\]/);
      } finally {
        db.close();
      }
    }));

  it("queries SQLite R-tree bboxes, computes minimal Probe Kit rig covers, and flags RTE/CameraUniforms hazards", () =>
    withLaneTmp("context-spine-spatial-", async (dir) => {
      createHermeticFixtureRepo(dir);
      const dbRel = ".cache/context-spine/test.sqlite";
      await buildContextSpine({ repoRoot: dir, dbPath: dbRel });
      const db = await openOrBuildSpine(dir, {
        dbPath: dbRel,
        autoBuild: false,
      });

      try {
        // High-Arctic bbox hits only arctic-svalbard via spatial_rigs_rtree
        const arctic = querySpatialValidation(db, {
          bbox: [10, 75, 30, 90],
        });
        assert.equal(arctic.rigs.length, 1);
        assert.equal(arctic.rigs[0].id, "arctic-svalbard");
        assert.ok(arctic.rigs[0].regimes.includes("north_pole"));

        // Minimal cover across north_pole + coastal_or_water + voxel_volume picks all 3 distinct rigs
        const coverRes = querySpatialValidation(db, {
          regimes: ["north_pole", "coastal_or_water", "voxel_volume"],
        });
        assert.equal(coverRes.minimalCover.selectedRigs.length, 3);
        assert.equal(coverRes.minimalCover.uncoveredTargets.length, 0);
        assert.ok(coverRes.fleetCoverageGaps.includes("south_pole"));

        // Contract check catches all 3 planted hazards and validates CameraUniforms tail positive
        const hazards = queryContracts(db, { severity: "hazard" });
        const hazardTypes = new Set(hazards.items.map((h) => h.contract_type));
        assert.ok(hazardTypes.has("DIRECT_HIGH_PLUS_LOW_HAZARD"));
        assert.ok(hazardTypes.has("RAW_MVP_POSITION_HAZARD"));
        assert.ok(hazardTypes.has("CAMERA_PREVIOUS_VP_MID_STRUCT"));

        const tailPos = queryContracts(db, {
          filePath: "ModelPBR.wgsl",
          category: "camera_uniform_tail",
        });
        assert.equal(tailPos.items.length, 1);
        assert.equal(tailPos.items[0].contract_type, "CAMERA_PREVIOUS_VP_TAIL");
        assert.equal(tailPos.items[0].severity, "positive");

        // Context capsule writes role-sliced SHA-stamped markdown
        const capPath = path.join(dir, "_review", "context-capsule.md");
        const cap = generateContextCapsule(db, dir, {
          targets: ["WebGPUModelRenderer.ts"],
          role: "worker",
          outPath: capPath,
        });
        assert.ok(fs.existsSync(capPath));
        assert.match(cap.markdown, /Context Capsule \(WORKER\)/);
        assert.match(cap.markdown, /test-model-webgpu/);
      } finally {
        db.close();
      }
    }));

  it("supports --incremental hash-diff updates, preserves Leiden communities, and finalizes DB without WAL sidecars", () =>
    withLaneTmp("context-spine-incr-", async (dir) => {
      createHermeticFixtureRepo(dir);
      const dbRel = ".cache/context-spine/test.sqlite";
      const dbAbs = path.join(dir, dbRel);

      const first = await buildContextSpine({ repoRoot: dir, dbPath: dbRel });
      assert.equal(first.code.incremental, false);
      assert.equal(fs.existsSync(`${dbAbs}-wal`), false);
      assert.equal(fs.existsSync(`${dbAbs}-shm`), false);

      // Seed a Leiden community_id via Graphify JSON
      const graphJsonPath = path.join(dir, "graph.json");
      fs.writeFileSync(
        graphJsonPath,
        JSON.stringify({
          nodes: [
            {
              id: "n1",
              label: "WebGPUModelRenderer",
              source_file: "Renderer/WebGPU/WebGPUModelRenderer.ts",
              source_location: "L10",
              community: 77,
            },
          ],
          links: [],
        }),
        "utf8",
      );
      await buildContextSpine({
        repoRoot: dir,
        dbPath: dbRel,
        incremental: true,
        graphifyJsonPath: "graph.json",
      });

      // Zero-change incremental build fast path
      const second = await buildContextSpine({
        repoRoot: dir,
        dbPath: dbRel,
        incremental: true,
      });
      assert.equal(second.code.incremental, true);
      assert.equal(second.code.changedFiles, 0);
      assert.equal(second.code.deletedFiles, 0);

      // Single-file edit triggers incremental delta update of 1 file while keeping untouched communities
      const sceneModelAbs = path.join(
        dir,
        "packages/engine/Source/Scene/Model.js",
      );
      fs.appendFileSync(
        sceneModelAbs,
        "\nexport function addedHelperForIncrementalTest() { return 1; }\n",
        "utf8",
      );

      const third = await buildContextSpine({
        repoRoot: dir,
        dbPath: dbRel,
        incremental: true,
      });
      assert.equal(third.code.incremental, true);
      assert.equal(third.code.changedFiles, 1);

      const db = await openOrBuildSpine(dir, {
        dbPath: dbRel,
        autoBuild: false,
      });
      try {
        const added = querySymbols(db, dir, "addedHelperForIncrementalTest");
        assert.equal(added.length, 1);
        const preserved = querySymbols(db, dir, "WebGPUModelRenderer").find(
          (s) => s.kind === "class",
        );
        assert.equal(preserved.communityId, 77);
      } finally {
        db.close();
      }
    }));

  it("GWIP-1: a re-export after an export declaration is recorded at its own line, line counts match wc -l, and stored counts are reported", () =>
    withLaneTmp("context-spine-gwip-imports-", async (dir) => {
      createHermeticFixtureRepo(dir);
      fs.mkdirSync(path.join(dir, "packages/engine/Source/Core"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(dir, "packages/engine/Source/Core/ReExporter.js"),
        'export function first() {\n  return 1;\n}\nexport const second = 2;\nexport { Model } from "../Scene/Model.js";\n',
        "utf8",
      );
      // Two nested helpers share the id `<file>::helper`: the store keeps one.
      fs.writeFileSync(
        path.join(dir, "packages/engine/Source/Core/DuplicateIds.js"),
        "function helper() {\n  return 1;\n}\nfunction helper() {\n  return 2;\n}\nexport default helper;\n",
        "utf8",
      );
      const dbRel = ".cache/context-spine/test.sqlite";
      await buildContextSpine({ repoRoot: dir, dbPath: dbRel });
      const db = await openOrBuildSpine(dir, {
        dbPath: dbRel,
        autoBuild: false,
      });
      try {
        const edges = db
          .prepare(
            "SELECT line, detail FROM edges WHERE src_id = ? AND dst_id = ? AND relation = 'imports'",
          )
          .all(
            "file:packages/engine/Source/Core/ReExporter.js",
            "file:packages/engine/Source/Scene/Model.js",
          );
        assert.equal(edges.length, 1);
        assert.equal(
          edges[0].line,
          5,
          "the re-export is on line 5, not at the first export",
        );
        assert.match(edges[0].detail, /^re-export \{ Model \}$/);

        const row = db
          .prepare("SELECT line_count FROM files WHERE path = ?")
          .get("packages/engine/Source/Core/ReExporter.js");
        assert.equal(
          row.line_count,
          5,
          "five lines ending in a newline are five lines",
        );

        const meta = Object.fromEntries(
          db
            .prepare("SELECT key, value FROM meta")
            .all()
            .map((r) => [r.key, r.value]),
        );
        const storedSymbols = db
          .prepare("SELECT COUNT(*) AS n FROM symbols")
          .get().n;
        const dupRows = db
          .prepare("SELECT COUNT(*) AS n FROM symbols WHERE id = ?")
          .get("packages/engine/Source/Core/DuplicateIds.js::helper").n;
        assert.equal(dupRows, 1);
        assert.equal(Number(meta.symbols), Number(storedSymbols));
      } finally {
        db.close();
      }
    }));

  it("GWIP-2: an impact pack on a registry key is anchored on the key, and an unknown target says it was not found", () =>
    withLaneTmp("context-spine-gwip-impact-", async (dir) => {
      createHermeticFixtureRepo(dir);
      // Twelve probe-side readers of the key, each on line 1: before the
      // engine-first ordering they filled the pack's ten seam rows and pushed
      // the engine's own registration out of it.
      for (let i = 0; i < 12; i += 1) {
        fs.writeFileSync(
          path.join(dir, `Tools/visual-regression/probe-model-${i}.mjs`),
          "const key = C.FeatureRendererKey.MODEL;\nexport default key;\n",
          "utf8",
        );
      }
      const dbRel = ".cache/context-spine/test.sqlite";
      await buildContextSpine({ repoRoot: dir, dbPath: dbRel });
      const db = await openOrBuildSpine(dir, {
        dbPath: dbRel,
        autoBuild: false,
      });
      try {
        const pack = buildImpactPack(db, dir, "MODEL");
        assert.equal(pack.resolved, true);
        assert.equal(pack.registryAnchor, true);
        assert.ok(pack.fileOutline.length > 0);
        assert.ok(
          pack.fileOutline.every((s) => s.name === "FeatureRendererKey.MODEL"),
          `outline must be the key, not the registry file: ${pack.fileOutline.map((s) => s.name).join(", ")}`,
        );
        assert.ok(
          pack.fileOutline.every(
            (s) =>
              s.file_path ===
              "packages/engine/Source/Renderer/FeatureRendererKey.js",
          ),
          "each registry-key outline row names the file the key is in",
        );
        assert.match(
          formatImpactPackMarkdown(pack),
          /`packages\/engine\/Source\/Renderer\/FeatureRendererKey\.js:L\d+-L\d+` \(feature-renderer-key\)/,
        );
        // The ledger leg queries the key itself, not the registry file's name.
        const ledgerIds = (q) =>
          queryLedger(db, q, { activeOnly: true, limit: 10 }).map((r) => r.id);
        assert.notDeepEqual(
          ledgerIds("MODEL"),
          ledgerIds("FeatureRendererKey.js"),
          "the fixture tells the key from the registry file name",
        );
        assert.deepEqual(
          pack.ledger.map((r) => r.id),
          ledgerIds("MODEL"),
          "the registry-key pack's ledger is the key's ledger",
        );
        const seamEdges = [
          ...pack.seams.seamEdges,
          ...pack.seams.counterpartEdges,
        ];
        assert.ok(
          seamEdges.some(
            (e) =>
              e.dst_id === "frkey:MODEL" &&
              e.src_id === "file:packages/engine/Source/Scene/Model.js",
          ),
          "the key's consumer is in the pack",
        );
        assert.ok(
          !seamEdges.some((e) => e.dst_id === "frkey:GLOBE_SURFACE"),
          "another key's seams are not",
        );
        const shown = pack.seams.seamEdges.slice(0, 10);
        assert.ok(
          shown.some(
            (e) =>
              e.relation === "registers_feature_renderer" &&
              e.file_path ===
                "packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts",
          ),
          `the engine registration is among the ten rows the pack prints: ${shown.map((e) => e.file_path).join(", ")}`,
        );

        const absent = buildImpactPack(db, dir, "NoSuchShaderAnywhere.wgsl");
        assert.equal(absent.resolved, false);
        assert.match(formatImpactPackMarkdown(absent), /TARGET NOT FOUND/);
        assert.doesNotMatch(formatImpactPackMarkdown(pack), /TARGET NOT FOUND/);
      } finally {
        db.close();
      }
    }));
});
