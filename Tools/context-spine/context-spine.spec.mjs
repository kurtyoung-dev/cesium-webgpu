// context-spine.spec.mjs — Hermetic unit, mutation, and stdio MCP integration tests for Tools/context-spine.
// @purpose Verify code/WGSL/GLSL seam indexing, SHA-256 disk-staleness relocation, Charter §0.4 ruling precedence, SQLite R-tree spatial rig covers, RTE/CameraUniforms hazard guards, Graphify bridge, and MCP stdio framing.
// @status ACTIVE
//
// SPLIT BY CONCERN (the pattern of probe-landing-cells.spec.mjs and its parts): this file keeps indexing, seams, rulings, rig covers, incremental builds and impact packs; the other groups live in context-spine-spatial-hazards, -graphify-mcp and -clone-codex (.spec.mjs), which share fixtures/context-spine-support.mjs. Test names and bodies are unchanged; all four run under test-context-spine.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { ecefToWgs84 } from "./extract-spatial.mjs";
import { indexLedger } from "./extract-ledger.mjs";
import { openContextDatabase } from "./schema.mjs";
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

// A fixture ruling file per day. Together they hold every form a ruling takes
// in a MAINTAINER_RULINGS_*.md: bare id, `— title`, `(Dn) — title`, a
// provenance in parentheses (with nested parentheses) then a colon, a
// backticked id, and a table row.
const RULINGS_FIXTURE_FIRST_DAY = [
  "# Maintainer rulings — 2099-01-01",
  "",
  "Opening paragraph of the file: the seat recorded these, and the words in quotation marks are the maintainer's.",
  "",
  "## R-2099-01-01-1",
  "Bare heading body. Batch 11 cites `Tools/alpha.mjs`.",
  "",
  "## R-2099-01-01-2 — Dash title",
  "Dash body.",
  "",
  "## R-2099-01-01-3 (D3) — Paren then dash title",
  "Paren body.",
  "",
  "## `R-2099-01-01-4` — Backticked title",
  "Backticked body.",
  "",
  "## Notes after the rulings",
  "",
  "Closing note: this note amends R-2099-01-01-1 and cites Batch 7777 and `Tools/query-context.mjs`.",
  "",
].join("\n");

const RULINGS_FIXTURE_SECOND_DAY = [
  "# Maintainer rulings — 2099-01-02",
  "",
  "## Maintainer rulings of 2099-01-02 (R-2099-01-02-M1 … -M2)",
  "",
  "Opening paragraph of the day: M1 is quoted; M2 is recorded by the seat and is not quoted.",
  "",
  '### R-2099-01-02-M1 (maintainer, 2099-01-02 10:55 EST, quoted, on the proxy (M-3) and the clones): "Give me the details."',
  "",
  "Seat reading: M1 reading.",
  "",
  "#### A sub-heading inside M1",
  "",
  "Still M1's text, Batch 5.",
  "",
  "### R-2099-01-02-M2 (maintainer, 2099-01-02, recorded, not quoted): Words of M2.",
  "",
  "M2 reading. It vacates R-2099-01-02-T3.",
  "",
  "```sh",
  "# a comment line that is not a heading",
  "## R-2099-01-02-FENCED — not a ruling",
  "```",
  "",
  "Last line of M2.",
  "",
  "## Table rulings of 2099-01-02",
  "",
  "Opening paragraph of the table section: the rows below are the seat's index.",
  "",
  "| Ruling | Subject | Decision |",
  "| --- | --- | --- |",
  "| R-2099-01-02-T1 | First subject | First decision. |",
  "| `R-2099-01-02-T2` | Second subject | Supersedes R-2099-01-01-2. Amends R-2099-01-02-T1. Replaces R-2099-01-01-3. |",
  "| R-2099-01-02-T3 | Third subject | Third decision. |",
  "| R-2099-01-01-1 | an index row for a ruling that has its own heading | row only |",
  "",
].join("\n");

/**
 * Index the given `MAINTAINER_RULINGS_<name>.md` texts exactly as a build does
 * and return the open database.
 *
 * @param {string} dir a lane temp directory
 * @param {Record<string, string>} files day name -> file text
 */
function indexRulingFiles(dir, files) {
  fs.mkdirSync(path.join(dir, "migration_doc"), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(
      path.join(dir, "migration_doc", `MAINTAINER_RULINGS_${name}.md`),
      text.replace(/\n/g, "\r\n"),
    );
  }
  const db = openContextDatabase(":memory:");
  const stats = indexLedger(db, dir);
  return { db, stats };
}

/** The ledger entry with exactly this id, as the query returns it. */
function rulingEntry(db, id) {
  const hit = queryLedger(db, id, { activeOnly: false, docKind: "ruling" });
  return hit.find((row) => row.id === id);
}

/** The 1-based line of the first line that starts with `prefix`. */
function lineStartingWith(text, prefix) {
  const index = text.split("\n").findIndex((line) => line.startsWith(prefix));
  assert.ok(index >= 0, `fixture has a line starting ${prefix}`);
  return index + 1;
}

describe("Maintainer rulings: every ruling is a ledger entry", () => {
  it("makes an entry of every heading form and every table row, with the file, the line and the title", () =>
    withLaneTmp("context-spine-ruling-forms-", async (dir) => {
      const { db, stats } = indexRulingFiles(dir, {
        "2099-01-01": RULINGS_FIXTURE_FIRST_DAY,
        "2099-01-02": RULINGS_FIXTURE_SECOND_DAY,
      });
      try {
        const expected = [
          ["R-2099-01-01-1", "2099-01-01", "## R-2099-01-01-1", ""],
          ["R-2099-01-01-2", "2099-01-01", "## R-2099-01-01-2 —", "Dash title"],
          [
            "R-2099-01-01-3",
            "2099-01-01",
            "## R-2099-01-01-3 (D3)",
            "(D3) — Paren then dash title",
          ],
          [
            "R-2099-01-01-4",
            "2099-01-01",
            "## `R-2099-01-01-4`",
            "Backticked title",
          ],
          [
            "R-2099-01-02-M1",
            "2099-01-02",
            "### R-2099-01-02-M1",
            '(maintainer, 2099-01-02 10:55 EST, quoted, on the proxy (M-3) and the clones): "Give me the details."',
          ],
          [
            "R-2099-01-02-M2",
            "2099-01-02",
            "### R-2099-01-02-M2",
            "(maintainer, 2099-01-02, recorded, not quoted): Words of M2.",
          ],
          [
            "R-2099-01-02-T1",
            "2099-01-02",
            "| R-2099-01-02-T1",
            "First subject",
          ],
          [
            "R-2099-01-02-T2",
            "2099-01-02",
            "| `R-2099-01-02-T2`",
            "Second subject",
          ],
          [
            "R-2099-01-02-T3",
            "2099-01-02",
            "| R-2099-01-02-T3",
            "Third subject",
          ],
        ];
        for (const [id, day, linePrefix, titleRest] of expected) {
          const text =
            day === "2099-01-01"
              ? RULINGS_FIXTURE_FIRST_DAY
              : RULINGS_FIXTURE_SECOND_DAY;
          const entry = rulingEntry(db, id);
          assert.ok(entry, `${id} is a ledger entry`);
          assert.equal(
            entry.sourceFile,
            `migration_doc/MAINTAINER_RULINGS_${day}.md`,
            `${id}: its own file`,
          );
          assert.equal(
            entry.startLine,
            lineStartingWith(text, linePrefix),
            `${id}: its own line`,
          );
          assert.equal(
            entry.title,
            titleRest ? `${id} — ${titleRest}` : id,
            `${id}: what follows the id is carried in the title`,
          );
        }
        assert.equal(
          stats.rulingCount,
          expected.length,
          "a ruling inside a fenced block is no entry, and a table row for a ruling that has a heading is no second entry",
        );
        assert.equal(rulingEntry(db, "R-2099-01-02-FENCED"), undefined);

        const table = rulingEntry(db, "R-2099-01-02-T1");
        assert.equal(table.endLine, table.startLine, "a row is one line");
        assert.match(table.summary, /First decision\./, "decision is summary");

        const indexed = rulingEntry(db, "R-2099-01-01-1");
        assert.equal(
          indexed.sourceFile,
          "migration_doc/MAINTAINER_RULINGS_2099-01-01.md",
          "a later file's table row never replaces the ruling that has its own heading",
        );
      } finally {
        db.close();
      }
    }));

  it("ends a ruling at the next ruling or the next heading of its own level or higher", () =>
    withLaneTmp("context-spine-ruling-ends-", async (dir) => {
      const { db } = indexRulingFiles(dir, {
        "2099-01-01": RULINGS_FIXTURE_FIRST_DAY,
        "2099-01-02": RULINGS_FIXTURE_SECOND_DAY,
      });
      try {
        // The closing note under `## Notes after the rulings` is not part of
        // the ruling above it: it neither dates it nor cites for it, and the
        // ruling it says it amends is still active.
        const last = rulingEntry(db, "R-2099-01-01-4");
        assert.equal(
          last.endLine,
          lineStartingWith(RULINGS_FIXTURE_FIRST_DAY, "## Notes after") - 1,
          "the last ruling of a section ends before the next section heading",
        );
        assert.equal(last.batchNum, null, "Batch 7777 is the note's");
        assert.ok(
          !last.citedPaths.includes("Tools/query-context.mjs"),
          "the path the note cites is the note's",
        );
        assert.equal(
          rulingEntry(db, "R-2099-01-01-1").status,
          "ACTIVE",
          "the note's 'amends R-2099-01-01-1' is not the last ruling's",
        );

        // A deeper sub-heading stays inside its ruling; the next ruling of the
        // same level ends it; a section heading above ends the last one.
        const first = rulingEntry(db, "R-2099-01-02-M1");
        assert.equal(
          first.endLine,
          lineStartingWith(RULINGS_FIXTURE_SECOND_DAY, "### R-2099-01-02-M2") -
            1,
        );
        assert.equal(first.batchNum, 5, "the text under its own sub-heading");
        const second = rulingEntry(db, "R-2099-01-02-M2");
        assert.equal(
          second.endLine,
          lineStartingWith(RULINGS_FIXTURE_SECOND_DAY, "## Table rulings") - 1,
          "a comment line inside a fenced block does not end a ruling",
        );
      } finally {
        db.close();
      }
    }));

  it("a summary is the first line of the ruling's own body and carries nothing from the headings and paragraphs around it", () =>
    withLaneTmp("context-spine-ruling-intro-", async (dir) => {
      const { db } = indexRulingFiles(dir, {
        "2099-01-01": RULINGS_FIXTURE_FIRST_DAY,
        "2099-01-02": RULINGS_FIXTURE_SECOND_DAY,
      });
      try {
        const expected = {
          "R-2099-01-01-2": "Dash body.",
          "R-2099-01-01-3": "Paren body.",
          "R-2099-01-01-4": "Backticked body.",
          "R-2099-01-02-M1": "Seat reading: M1 reading.",
          "R-2099-01-02-T1": "First decision.",
          "R-2099-01-02-T3": "Third decision.",
        };
        for (const [id, own] of Object.entries(expected)) {
          const { summary } = rulingEntry(db, id);
          assert.ok(
            summary === own || summary.startsWith("["),
            `${id}: the summary is its own text (or that text after an amendment tag), got "${summary}"`,
          );
          assert.doesNotMatch(summary, / \|\| /, id);
          assert.doesNotMatch(summary, /Opening paragraph/, id);
        }
        assert.equal(
          rulingEntry(db, "R-2099-01-01-1").summary,
          "Bare heading body. Batch 11 cites `Tools/alpha.mjs`.",
        );
      } finally {
        db.close();
      }
    }));

  it("resolves amend / supersede / vacate for rulings that are table rows or have a parenthesis after the id", () =>
    withLaneTmp("context-spine-ruling-amend-", async (dir) => {
      const { db } = indexRulingFiles(dir, {
        "2099-01-01": RULINGS_FIXTURE_FIRST_DAY,
        "2099-01-02": RULINGS_FIXTURE_SECOND_DAY,
      });
      try {
        const amender = rulingEntry(db, "R-2099-01-02-T2");
        assert.deepEqual(
          amender.amendsIds,
          ["R-2099-01-01-2", "R-2099-01-02-T1", "R-2099-01-01-3"],
          "a table row's decision names the rulings it amends",
        );
        for (const id of [
          "R-2099-01-01-2",
          "R-2099-01-02-T1",
          "R-2099-01-01-3",
        ]) {
          const target = rulingEntry(db, id);
          assert.equal(target.status, "AMENDED", id);
          assert.match(target.summary, /^\[Amended by R-2099-01-02-T2\] /, id);
        }
        const vacated = rulingEntry(db, "R-2099-01-02-T3");
        assert.equal(
          vacated.status,
          "VACATED",
          "a ruling with a provenance heading vacates a table row",
        );
        assert.match(vacated.summary, /^\[Vacated by R-2099-01-02-M2\] /);
        // A lookup of the amended id answers with the amended ruling and with
        // the active ruling that amends it, the amender ahead of its target.
        const lookup = queryLedger(db, "R-2099-01-01-2", {
          docKind: "ruling",
        }).map((row) => row.id);
        assert.ok(lookup.includes("R-2099-01-01-2"), "the amended ruling");
        assert.ok(lookup.includes("R-2099-01-02-T2"), "its amender");
        assert.ok(
          lookup.indexOf("R-2099-01-02-T2") < lookup.indexOf("R-2099-01-01-2"),
        );
      } finally {
        db.close();
      }
    }));

  // The census runs on the real files: when a ruling is written in a form the
  // extractor does not read, this names it.
  it("the ledger holds every ruling heading and every ruling table row of the real MAINTAINER_RULINGS files", () => {
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    const docsDir = path.join(repoRoot, "migration_doc");
    const files = fs
      .readdirSync(docsDir)
      .filter((name) => /^MAINTAINER_RULINGS_.*\.md$/i.test(name))
      .sort();
    assert.ok(files.length >= 19, `ruling files found: ${files.length}`);

    const db = openContextDatabase(":memory:");
    try {
      indexLedger(db, repoRoot);
      const entries = new Map(
        db
          .prepare(
            "SELECT id, source_file, start_line, title FROM ledger_entries WHERE doc_kind = 'ruling'",
          )
          .all()
          .map((row) => [row.id, row]),
      );

      const idPattern = "R-\\d{4}-\\d{2}-\\d{2}-[A-Za-z0-9-]+";
      const headingRe = new RegExp(`^#{2,4}\\s+\`?(${idPattern})\`?(.*)$`);
      const rowRe = new RegExp(`^\\|\\s*\`?(${idPattern})\`?\\s*([^|]*)\\|`);
      const headings = [];
      const rows = [];
      for (const name of files) {
        const lines = fs
          .readFileSync(path.join(docsDir, name), "utf8")
          .split(/\r?\n/);
        let inFence = false;
        lines.forEach((line, index) => {
          if (/^\s*(?:```|~~~)/.test(line)) {
            inFence = !inFence;
            return;
          }
          if (inFence) return;
          const heading = line.match(headingRe);
          if (heading) {
            headings.push({
              id: heading[1],
              name,
              line: index + 1,
              rest: heading[2]
                .trim()
                .replace(/^[—–:-]\s*/, "")
                .trim(),
            });
            return;
          }
          const row = line.match(rowRe);
          if (row) {
            rows.push({
              id: row[1],
              name,
              line: index + 1,
              firstCellIsOnlyTheId: row[2].trim() === "",
            });
          }
        });
      }

      const headingIds = new Set(headings.map((h) => h.id));
      const headingCount = new Map();
      for (const h of headings) {
        headingCount.set(h.id, (headingCount.get(h.id) ?? 0) + 1);
      }

      const missing = [
        ...headings
          .filter((h) => !entries.has(h.id))
          .map((h) => `${h.name}:${h.line} ${h.id} (heading)`),
        ...rows
          .filter((r) => !entries.has(r.id))
          .map((r) => `${r.name}:${r.line} ${r.id} (table row)`),
      ];
      assert.deepEqual(
        missing,
        [],
        `headings and table rows that start with a ruling id and are not ledger entries (${missing.length})`,
      );

      for (const h of headings) {
        if (headingCount.get(h.id) !== 1) continue;
        const entry = entries.get(h.id);
        assert.equal(
          entry.source_file,
          `migration_doc/${h.name}`,
          `${h.id}: its file`,
        );
        assert.equal(entry.start_line, h.line, `${h.id}: its line`);
        assert.equal(
          entry.title,
          h.rest ? `${h.id} — ${h.rest}` : h.id,
          `${h.id}: what follows the id is carried in the title`,
        );
      }
      for (const r of rows) {
        if (headingIds.has(r.id) || !r.firstCellIsOnlyTheId) continue;
        const entry = entries.get(r.id);
        assert.equal(
          entry.source_file,
          `migration_doc/${r.name}`,
          `${r.id}: its file`,
        );
        assert.equal(entry.start_line, r.line, `${r.id}: its line`);
      }
      assert.ok(
        headings.length >= 63 + 168 && rows.length >= 33 + 29,
        `the census saw ${headings.length} headings and ${rows.length} rows`,
      );
    } finally {
      db.close();
    }
  });
});

// A flat rulings file: sitting headings and record headings stand at the level
// of the rulings. The fixture holds entries and their bodies: each ruling is its
// own lines, whatever stands above it.
const RULINGS_FIXTURE_FLAT = [
  "# Maintainer rulings — 2099-02-01",
  "",
  "Title paragraph: it describes the first sitting only.",
  "",
  "## R-2099-02-01-1 — Directly under the title",
  "Body one.",
  "",
  "## Second sitting, 10:00",
  "",
  "Second sitting paragraph: the sitting the next rulings belong to.",
  "",
  "## R-2099-02-01-2 — After a sitting heading of its own level",
  "Body two.",
  "",
  "## R-2099-02-01-3 — Second ruling of that sitting",
  "Body three.",
  "",
  "## Record only — a note that is not a section",
  "",
  "Record paragraph: a record, not the section of the ruling below it.",
  "",
  "## R-2099-02-01-4 — After a record heading of its own level",
  "Body four.",
  "",
  "## Deeper rulings",
  "",
  "Deeper paragraph: the paragraph of the level-3 rulings below.",
  "",
  "### R-2099-02-01-5 — One level below its heading",
  "Body five.",
  "",
  "### Sub-record at the ruling's level",
  "",
  "Sub-record paragraph: a sibling of the next ruling.",
  "",
  "### R-2099-02-01-6 — After a sibling heading",
  "Body six.",
  "",
  "## Index",
  "",
  "Index paragraph: the rows below.",
  "",
  "| Ruling | Subject | Decision |",
  "| --- | --- | --- |",
  "| R-2099-02-01-T1 | Row subject | Row decision. |",
  "",
  "## R-2099-02-01-7 — Only a heading",
  "## Closing sitting",
  "",
  "Closing sitting paragraph: the paragraph after the sibling heading.",
  "",
  "## R-2099-02-01-8 — One line",
  "Only line.",
  "## R-2099-02-01-9 — Next ruling directly",
  "Nine body.",
  "",
  "## Second index",
  "",
  "| Ruling | Subject | Decision |",
  "| --- | --- | --- |",
  "| R-2099-02-01-T2 | Second row subject | Second row decision. |",
  "",
].join("\n");

// Named rulings of the real files, each with the text its summary must not
// contain: the paragraph of a heading above it that describes some other
// sitting, record or file. Pinned here: the 38 rulings that stand under a
// sitting or record heading of their own level (a file title's paragraph, a
// "PROVISIONAL" caveat, the first sitting's paragraph, a "Record only" note,
// "No ruling is taken or implied"), and R-2026-08-24-12 to -16, taken in later
// sittings under the second sitting's heading, which no heading marks.
const RULINGS_MUST_NOT_CARRY = [
  ...[
    "R-2026-08-21-13",
    "R-2026-08-21-14",
    "R-2026-08-21-15",
    "R-2026-08-21-16",
    "R-2026-08-21-17",
    "R-2026-08-21-18",
    "R-2026-08-21-19",
    "R-2026-08-21-20",
    "R-2026-08-21-21",
    "R-2026-08-21-22",
    "R-2026-08-21-23",
    "R-2026-08-21-24",
  ].map((id) => [id, ["PROVISIONAL"]]),
  ...[
    "R-2026-08-28-3",
    "R-2026-08-28-4",
    "R-2026-08-28-5",
    "R-2026-08-28-6",
    "R-2026-08-28-7",
    "R-2026-08-28-8",
    "R-2026-08-28-9",
    "R-2026-08-28-10",
    "R-2026-08-28-11",
    "R-2026-08-28-11a",
    "R-2026-08-28-12",
    "R-2026-08-28-13",
    "R-2026-08-29-1",
    "R-2026-08-29-2",
    "R-2026-08-29-3",
  ].map((id) => [id, ["approximately 06:12 ET"]]),
  ...["R-2026-09-07-4", "R-2026-09-07-5", "R-2026-09-07-6"].map((id) => [
    id,
    ["Recorded from the maintainer's explicit reply"],
  ]),
  ...[
    "R-2026-09-18-1",
    "R-2026-09-18-2",
    "R-2026-09-18-3",
    "R-2026-09-18-4",
    "R-2026-09-18-5",
  ].map((id) => [id, ["Record only"]]),
  ["R-2026-09-26-23", ["No ruling is taken or implied"]],
  ["R-2026-10-23-M3", ["Appended 2026-10-24 by the records batch"]],
  ["R-2026-10-23-M4", ["Appended 2026-10-24 by the records batch"]],
  ...[
    "R-2026-08-24-12",
    "R-2026-08-24-13",
    "R-2026-08-24-14",
    "R-2026-08-24-15",
    "R-2026-08-24-16",
  ].map((id) => [id, ["These seven were taken", "16:35-16:40"]]),
];

const SECTION_MARK = /\|\| Section \(/;

/** The directory of the repository this spec belongs to, and its rulings files. */
function realRulingsFiles() {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const docsDir = path.join(repoRoot, "migration_doc");
  const names = fs
    .readdirSync(docsDir)
    .filter((name) => /^MAINTAINER_RULINGS_.*\.md$/i.test(name))
    .sort();
  return { repoRoot, docsDir, names };
}

/**
 * Index the given rulings files (day name -> text) as they are and with every
 * line outside every ruling's own lines replaced by a marker, and assert that
 * no ruling's summary, lines or status differ and none carries the marker.
 *
 * @param {string} dir a lane temp directory
 * @param {Record<string, string>} texts day name -> file text (LF)
 * @param {{ entries: number, replaced: number }} least counts the case must see
 */
function assertSummariesIgnoreOutsideLines(dir, texts, least) {
  const MARK = "OUTSIDE-LINE-MARKER";
  const readEntries = (db) =>
    db
      .prepare(
        "SELECT id, source_file, start_line, end_line, title, status, summary FROM ledger_entries WHERE doc_kind = 'ruling' ORDER BY id",
      )
      .all();

  const original = indexRulingFiles(path.join(dir, "original"), texts);
  const marked = {};
  let replaced = 0;
  let kept = 0;
  try {
    const entries = readEntries(original.db);
    assert.ok(entries.length >= least.entries, `entries: ${entries.length}`);
    assert.equal(
      new Set(entries.map((e) => e.id)).size,
      entries.length,
      "no ruling id is defined twice",
    );
    for (const [key, text] of Object.entries(texts)) {
      const sourceFile = `migration_doc/MAINTAINER_RULINGS_${key}.md`;
      const inside = new Set();
      for (const entry of entries) {
        if (entry.source_file !== sourceFile) continue;
        for (let n = entry.start_line; n <= entry.end_line; n += 1) {
          inside.add(n);
        }
      }
      const out = [];
      for (const [index, line] of text.split("\n").entries()) {
        const number = index + 1;
        if (inside.has(number) || /^\s*(?:```|~~~)/.test(line)) {
          kept += 1;
          out.push(line);
          continue;
        }
        replaced += 1;
        const heading = line.match(/^(#{1,6})\s/);
        out.push(
          heading ? `${heading[1]} ${MARK} ${number}` : `${MARK} ${number}`,
        );
      }
      marked[key] = out.join("\n");
    }
  } finally {
    original.db.close();
  }
  assert.ok(
    replaced > least.replaced,
    `lines outside every ruling: ${replaced}`,
  );
  assert.ok(kept > least.replaced, `lines inside a ruling or a fence: ${kept}`);

  const before = indexRulingFiles(path.join(dir, "again"), texts);
  const after = indexRulingFiles(path.join(dir, "marked"), marked);
  try {
    const was = readEntries(before.db);
    const now = new Map(readEntries(after.db).map((e) => [e.id, e]));
    assert.equal(now.size, was.length, "the same rulings are found");
    for (const entry of was) {
      const other = now.get(entry.id);
      assert.ok(other, `${entry.id} is still an entry`);
      assert.equal(other.start_line, entry.start_line, entry.id);
      assert.equal(other.end_line, entry.end_line, entry.id);
      assert.equal(other.status, entry.status, entry.id);
      assert.ok(
        !other.summary.includes(MARK),
        `${entry.id}: the summary carries a line from outside the ruling`,
      );
      assert.equal(
        other.summary,
        entry.summary,
        `${entry.id}: the summary depends on a line outside the ruling`,
      );
    }
  } finally {
    before.db.close();
    after.db.close();
  }
}

describe("Maintainer rulings: a summary is made of the ruling's own lines", () => {
  it("a ruling in a flat file is its own entry and its own body, whatever sitting or record heading stands above it", () =>
    withLaneTmp("context-spine-ruling-flat-", async (dir) => {
      const { db } = indexRulingFiles(dir, {
        "2099-02-01": RULINGS_FIXTURE_FLAT,
      });
      try {
        const expected = [
          ["R-2099-02-01-1", "## R-2099-02-01-1", "Body one."],
          ["R-2099-02-01-2", "## R-2099-02-01-2", "Body two."],
          ["R-2099-02-01-3", "## R-2099-02-01-3", "Body three."],
          ["R-2099-02-01-4", "## R-2099-02-01-4", "Body four."],
          ["R-2099-02-01-5", "### R-2099-02-01-5", "Body five."],
          ["R-2099-02-01-6", "### R-2099-02-01-6", "Body six."],
          ["R-2099-02-01-T1", "| R-2099-02-01-T1", "Row decision."],
          ["R-2099-02-01-7", "## R-2099-02-01-7", "Only a heading"],
          ["R-2099-02-01-8", "## R-2099-02-01-8", "Only line."],
          ["R-2099-02-01-9", "## R-2099-02-01-9", "Nine body."],
          ["R-2099-02-01-T2", "| R-2099-02-01-T2", "Second row decision."],
        ];
        for (const [id, linePrefix, summary] of expected) {
          const entry = rulingEntry(db, id);
          assert.ok(entry, `${id} is a ledger entry`);
          assert.equal(
            entry.startLine,
            lineStartingWith(RULINGS_FIXTURE_FLAT, linePrefix),
            `${id}: its own line`,
          );
          assert.equal(entry.summary, summary, `${id}: its own text only`);
        }
        const heading7 = rulingEntry(db, "R-2099-02-01-7");
        assert.equal(
          heading7.endLine,
          heading7.startLine,
          "a ruling that is only its heading is one line",
        );
        assert.equal(
          rulingEntry(db, "R-2099-02-01-8").endLine,
          lineStartingWith(RULINGS_FIXTURE_FLAT, "## R-2099-02-01-9") - 1,
          "a body whose first line is its last ends before the next ruling",
        );
        const rulingEnd = rulingEntry(db, "R-2099-02-01-1").endLine;
        assert.equal(
          rulingEnd,
          lineStartingWith(RULINGS_FIXTURE_FLAT, "## Second sitting") - 1,
          "a ruling ends before the sitting heading at its own level",
        );
      } finally {
        db.close();
      }
    }));

  it("each named ruling of the real files carries none of the text of the heading or paragraph above it", () => {
    const { repoRoot } = realRulingsFiles();
    assert.equal(RULINGS_MUST_NOT_CARRY.length, 43);
    assert.equal(
      new Set(RULINGS_MUST_NOT_CARRY.map(([id]) => id)).size,
      43,
      "no id twice",
    );
    const db = openContextDatabase(":memory:");
    try {
      indexLedger(db, repoRoot);
      const summaryOf = db.prepare(
        "SELECT summary FROM ledger_entries WHERE id = ? AND doc_kind = 'ruling'",
      );
      for (const [id, mustNotCarry] of RULINGS_MUST_NOT_CARRY) {
        const row = summaryOf.get(id);
        assert.ok(row, `${id} is a ledger entry`);
        for (const text of mustNotCarry) {
          assert.ok(
            !row.summary.includes(text),
            `${id} must not carry "${text}"`,
          );
        }
        assert.doesNotMatch(
          row.summary,
          SECTION_MARK,
          `${id}: no section text is carried`,
        );
      }
    } finally {
      db.close();
    }
  });

  // The class: every ruling of every rulings file. Each file is indexed as it
  // is, then again with every line outside every ruling's own lines replaced
  // (a heading keeps its level and its place, so a ruling still starts and ends
  // where it did; every other line becomes a marker). A ruling's own lines are
  // the start and end lines the ledger gave it the first time. A summary that
  // depends on anything outside them changes or carries the marker. It runs
  // over the real files, and over the fixtures, which hold the forms no real
  // file has: a ruling that is only its heading before a sibling heading and a
  // paragraph, a body whose first line is its last, a row directly under its
  // table's header.
  it("no summary of any ruling of the real files depends on a line outside the ruling's own lines", () =>
    withLaneTmp("context-spine-ruling-outside-", async (dir) => {
      const { docsDir, names } = realRulingsFiles();
      const texts = {};
      for (const name of names) {
        texts[name.replace(/^MAINTAINER_RULINGS_/i, "").replace(/\.md$/i, "")] =
          fs
            .readFileSync(path.join(docsDir, name), "utf8")
            .split(/\r?\n/)
            .join("\n");
      }
      assertSummariesIgnoreOutsideLines(dir, texts, {
        entries: 293,
        replaced: 1000,
      });
    }));

  it("no summary of any ruling of the fixtures depends on a line outside the ruling's own lines", () =>
    withLaneTmp("context-spine-ruling-outside-fixtures-", async (dir) => {
      assertSummariesIgnoreOutsideLines(
        dir,
        {
          "2099-01-01": RULINGS_FIXTURE_FIRST_DAY,
          "2099-01-02": RULINGS_FIXTURE_SECOND_DAY,
          "2099-02-01": RULINGS_FIXTURE_FLAT,
        },
        { entries: 20, replaced: 30 },
      );
    }));
});
