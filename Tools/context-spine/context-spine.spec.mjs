// context-spine.spec.mjs — Hermetic unit, mutation, and stdio MCP integration tests for Tools/context-spine.
// @purpose Verify code/WGSL/GLSL seam indexing, SHA-256 disk-staleness relocation, Charter §0.4 ruling precedence, SQLite R-tree spatial rig covers, RTE/CameraUniforms hazard guards, Graphify bridge, and MCP stdio framing.
// @status ACTIVE

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { withLaneTmp } from "../lib/lane-tmp.mjs";
import {
  CODEX_MCP_TABLE_HEADER,
  codexMcpAdd,
  codexMcpRemove,
} from "./codex-mcp-config.mjs";
import { ecefToWgs84, selectMinimalRigCover } from "./extract-spatial.mjs";
import {
  graphifyPipRequirement,
  importGraphifyJson,
  resolveGraphifyBinary,
} from "./graphify-bridge.mjs";
import { detectActiveCesiumRoot } from "./mcp-server.mjs";
import {
  auditGisAndAssetContracts,
  extractIndirectRigCoordinates,
  inspectLiveGisAssets,
} from "./spatial-v2.mjs";
import { analyzeWgslUniformStructs } from "./uniform-crs-validator.mjs";
import {
  buildContextSpine,
  buildImpactPack,
  formatImpactPackMarkdown,
  generateContextCapsule,
  openOrBuildSpine,
  queryContracts,
  queryDeadExports,
  queryLedger,
  querySeams,
  querySpatialValidation,
  querySymbols,
} from "./query-engine.mjs";
import { openContextDatabase } from "./schema.mjs";
import {
  SPINE_DB_REL_PATH,
  capsuleSpineRoot,
  seedCloneContextSpine,
} from "./seed-clone.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.join(__dirname, "mcp-server.mjs");

/**
 * Populate a compact hermetic Cesium-shaped repository inside `dir` (owned by `withLaneTmp`).
 *
 * @param {string} dir
 */
function createHermeticFixtureRepo(dir) {
  const write = (rel, content) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  };

  write(
    "package.json",
    JSON.stringify(
      {
        name: "cesium-fixture",
        type: "module",
        scripts: {
          "test-model-webgpu": "node --test Tools/model.spec.mjs",
          "test-water-regimes": "node --test Tools/water.spec.mjs",
        },
      },
      null,
      2,
    ),
  );

  write(
    "Tools/visual-regression/fixtures/shader-registry-layout.json",
    JSON.stringify({
      ranges: [
        { word: "ext", start: 0, end: 20, owner: "clouds", name: "cloud-ext" },
      ],
    }),
  );

  write(
    "packages/engine/Source/Renderer/FeatureRendererKey.js",
    `const FeatureRendererKey = Object.freeze({
  MODEL: 0,
  GLOBE_SURFACE: 1,
  COUNT: 2,
});
export default FeatureRendererKey;
`,
  );

  write(
    "packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts",
    `export const ShaderDefine = Object.freeze({
  HAS_NORMALS: 1 << 0,
} as const);
export const ShaderDefineExt = Object.freeze({
  CLOUD_SHADOWMAP: extDefineBit(4),
} as const);
export const ShaderSourceId = Object.freeze({
  MODEL_PBR: 7,
} as const);
`,
  );

  write(
    "packages/engine/Source/Scene/Model.js",
    `import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
export class Model {
  update(frameState) {
    const renderer = frameState.context.getFeatureRenderer(FeatureRendererKey.MODEL);
    return renderer;
  }
}
`,
  );

  write(
    "packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts",
    `import FeatureRendererKey from "../FeatureRendererKey.js";
import { ShaderDefineExt, ShaderSourceId } from "./WebGPUShaderDefines.js";

export class WebGPUModelRenderer {
  register(context) {
    context.registerFeatureRenderer(FeatureRendererKey.MODEL, this);
  }
  renderModel(uniformState) {
    const flagsExt = ShaderDefineExt.CLOUD_SHADOWMAP;
    const src = ShaderSourceId.MODEL_PBR;
    const nearFar = uniformState._logDepthEncodeNearFar;
    const sliceFar = uniformState.currentFrustum.far;
    const camHi = uniformState.encodedCameraPositionMCHigh;
    return { flagsExt, src, nearFar, sliceFar, camHi };
  }
}
`,
  );

  write(
    "packages/engine/Source/Shaders/WebGPU/ModelPBR.wgsl",
    `struct CameraUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  encodedCameraLow: vec3<f32>,
  previousViewProjection: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

//>>ifdef CLOUD_SHADOWMAP
fn sampleCloudShadow(posHigh: vec3<f32>, posLow: vec3<f32>) -> vec4<f32> {
  let rte = translateRelativeToEye(posHigh, posLow);
  return camera.mvpRelativeToEye * rte;
}
//>>endif

@fragment
fn fsMain() -> @location(0) vec4<f32> {
  let logDepth = 0.5;
  return vec4<f32>(logDepth);
}
`,
  );

  write(
    "packages/engine/Source/Shaders/ModelPBRFS.glsl",
    `void main() {
  gl_FragColor = vec4(1.0);
}
`,
  );

  // Planted RTE + CameraUniforms tail hazards to prove negative controls bite
  write(
    "packages/engine/Source/Shaders/WebGPU/BrokenHazard.wgsl",
    `struct BrokenCameraUniforms {
  previousViewProjection: mat4x4<f32>,
  trailingField: vec4<f32>,
}

@vertex
fn vsBroken(posHigh: vec3<f32>, posLow: vec3<f32>, position: vec3<f32>) -> @builtin(position) vec4<f32> {
  let badSum = posHigh + posLow;
  let projected = mvp * vec4<f32>(posHigh + posLow, 1.0);
  return mvp * vec4<f32>(position, 1.0) + vec4<f32>(badSum, 0.0) + projected;
}
`,
  );

  // Governance / Rulings / Queues / Blueprint / DEFERRED_WORK
  write(
    "migration_doc/MAINTAINER_RULINGS_2026-09-16.md",
    `# Maintainer rulings — 2026-09-16

## R-2026-09-16-8 — Old clean-list owner

Original owner for WebGPUModelRenderer.ts clean-list fold was cloud landing.
`,
  );

  write(
    "migration_doc/MAINTAINER_RULINGS_2026-09-17.md",
    `# Maintainer rulings — 2026-09-17

## R-2026-09-17-3 — Wave 0 clean-list fold

This amends \`R-2026-09-16-8\`: \`WebGPUModelRenderer.ts\` clean-list fold moves to wave 0.
`,
  );

  write(
    "migration_doc/QUEUE_2026-08-10_CAMPAIGN16.md",
    `# Campaign 16 Queue

| ID | Work | Size | Status |
| --- | --- | --- | --- |
| \`C16-08\` | Model PBR rewrite on \`WebGPUModelRenderer.ts\` | M | **DONE 2026-08-09** — landed cleanly. |
| \`C16-21\` | Instrument grammar scope on \`WebGPUModelRenderer.ts\` | S | **OPEN** — pending wave 0. |
`,
  );

  write(
    "migration_doc/CAMPAIGN_STATE.md",
    `# CAMPAIGN_STATE

### C12 — Celestial appearance

**Launched.** Initially thought closed.

*[**Status added 2026-09-19** by the batch that carries this line. **C12 is OPEN.** \`WebGPUModelRenderer.ts\` awaits Option C decision.]*
`,
  );

  write(
    "migration_doc/CONSOLIDATED_REMEDIATION_BLUEPRINT_2026-10-08.md",
    `# Blueprint

| Hotspot File | Findings Impacting File | Primary Epics | Systemic Vulnerability Summary |
|:---|:---:|:---:|:---|
| \`WebGPUModelRenderer.ts\` | **35** | EPIC-06, EPIC-05 | Per-slice log depth mismatch |

## EPIC-06: glTF PBR Shading & Material Cache (165 findings)

Consolidates \`WebGPUModelRenderer.ts\` and \`ModelPBR.wgsl\` material bindings.
`,
  );

  write(
    "migration_doc/DEFERRED_WORK.md",
    `# Deferred Work Inventory

### NEW-MODEL-OLDER-NOTE

\`WebGPUModelRenderer.ts\` older note recorded at Batch 900.

### NEW-MODEL-NEWER-NOTE

\`WebGPUModelRenderer.ts\` newer note recorded at Batch 1455.

### NEW-MODEL-SHIPPED-ITEM

**Status:** SHIPPED 2026-09-12 (Batch 1470) on \`WebGPUModelRenderer.ts\`.
`,
  );

  // Spatial Rigs (Probe Kit format)
  write(
    "Tools/visual-regression/rigs/arctic-svalbard.mjs",
    `export default Object.freeze({
  id: "arctic-svalbard",
  tags: ["cloud", "polar"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description: "Polar day stratus deck",
  camera: { lon: 20, lat: 82, height: 1500, heading: 0, pitch: 0, roll: 0 },
  clock: "2026-06-21T10:40:00Z",
  stations: [{ id: "pole", lon: 20, lat: 89.5, height: 12000 }],
  viewport: { width: 800, height: 600 },
  readiness: { kind: "settleFrames", frames: 8 },
});
`,
  );

  write(
    "Tools/visual-regression/rigs/pacific-antimeridian-water.mjs",
    `export default Object.freeze({
  id: "pacific-antimeridian-water",
  tags: ["wave-end", "globe", "water", "ssr"],
  url: "Apps/split.html",
  renderers: ["webgl", "webgpu"],
  description: "Equatorial ocean grazing sunset at antimeridian",
  camera: { lon: 179.4, lat: 1.2, height: 450, heading: 0, pitch: -0.2, roll: 0 },
  clock: "2026-03-20T06:05:00Z",
  viewport: { width: 800, height: 600 },
  readiness: { kind: "settleFrames", frames: 8 },
});
`,
  );

  write(
    "Tools/visual-regression/rigs/voxel-underground-pit.mjs",
    `export default Object.freeze({
  id: "voxel-underground-pit",
  tags: ["voxel", "c11"],
  page: null,
  renderers: ["webgl", "webgpu"],
  description: "Subsurface excavated pit inside-camera voxel harness",
  camera: null,
  clock: null,
  viewport: { width: 800, height: 600 },
  readiness: { kind: "settleFrames", frames: 8 },
});
`,
  );
}

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

  it("geolocates indirect rigs (dials, 3D Tilesets, HTML) and parses binary GIS headers (EGM1, GBT1, LWM2, NE1R)", () =>
    withLaneTmp("context-spine-spatial-v2-", async (dir) => {
      createHermeticFixtureRepo(dir);

      // Create synthetic binary GIS headers (`EGM1`, `GBT1`, `LWM2`, `NE1R`)
      const geoidDir = path.join(dir, "packages/engine/Source/Assets/Geoid");
      const wmDir = path.join(dir, "packages/engine/Source/Assets/WaterMask");
      fs.mkdirSync(geoidDir, { recursive: true });
      fs.mkdirSync(wmDir, { recursive: true });

      const egmBuf = Buffer.alloc(36);
      egmBuf.write("EGM1", 0, "ascii");
      egmBuf.writeUInt32LE(721, 8);
      egmBuf.writeUInt32LE(361, 12);
      egmBuf.writeInt32LE(-180000000, 16);
      egmBuf.writeInt32LE(90000000, 20);
      egmBuf.writeUInt32LE(500000, 24);
      fs.writeFileSync(path.join(geoidDir, "egm2008-0p5deg.i16"), egmBuf);

      const gbtBuf = Buffer.alloc(16);
      gbtBuf.write("GBT1", 0, "ascii");
      gbtBuf.writeUInt16LE(720, 4);
      gbtBuf.writeUInt16LE(360, 6);
      fs.writeFileSync(path.join(wmDir, "globalBathymetryTensor.bin"), gbtBuf);

      const lwmBuf = Buffer.alloc(12);
      lwmBuf.write("LWM2", 0, "ascii");
      lwmBuf.writeUInt32LE(7897, 4);
      fs.writeFileSync(path.join(wmDir, "ne50mCoastlines.bin"), lwmBuf);

      const ne1rBuf = Buffer.alloc(12);
      ne1rBuf.write("NE1R", 0, "ascii");
      ne1rBuf.writeUInt32LE(1993, 4);
      fs.writeFileSync(path.join(wmDir, "ne10mRivers.bin"), ne1rBuf);

      const gis = inspectLiveGisAssets(dir);
      const egm = gis.find((g) => g.id === "egm2008-geoid");
      const gbt = gis.find((g) => g.id === "global-bathymetry-tensor");
      const coast = gis.find((g) => g.id === "ne50m-coastline-lwm2");
      const riv = gis.find((g) => g.id === "ne10m-rivers-ne1r");
      assert.equal(egm.resolutionDeg, 0.5);
      assert.match(egm.crsTo, /721x361/);
      assert.equal(gbt.resolutionDeg, 0.5);
      assert.match(coast.crsTo, /7897 rings/);
      assert.match(riv.crsTo, /1993 rivers/);

      // Indirect rig coordinates from tileset.json `boundingVolume.region` + `dials.lookAt`
      const tilesetRel = "Apps/SampleData/test-tileset.json";
      const tilesetAbs = path.join(dir, tilesetRel);
      fs.mkdirSync(path.dirname(tilesetAbs), { recursive: true });
      fs.writeFileSync(
        tilesetAbs,
        JSON.stringify({
          root: {
            boundingVolume: {
              region: [
                (-75.5 * Math.PI) / 180,
                (39.9 * Math.PI) / 180,
                (-75.1 * Math.PI) / 180,
                (40.1 * Math.PI) / 180,
                0,
                120,
              ],
            },
          },
        }),
        "utf8",
      );

      const fromTileset = extractIndirectRigCoordinates(
        { id: "tileset-rig", camera: null, asset: tilesetRel },
        dir,
        ecefToWgs84,
      );
      assert.equal(fromTileset.lons.length, 2);
      assert.ok(Math.abs(fromTileset.lons[0] - -75.5) < 1e-4);

      const fromDials = extractIndirectRigCoordinates(
        {
          id: "polyline-2d",
          camera: null,
          dials: {
            sceneMode: "SCENE2D",
            lookAt: { lon: -73, lat: 35.5, height: 0, rangeMetres: 300000 },
          },
        },
        dir,
        ecefToWgs84,
      );
      assert.equal(fromDials.lons[0], -73);
      assert.ok(fromDials.extraRegimes.has("2d_or_columbus"));
    }));

  it("verifies WGSL uniform byte/float layouts (mat3x3 12-float stride, vec3 tail packing, TS size mismatch)", () =>
    withLaneTmp("context-spine-uniform-crs-", async (dir) => {
      createHermeticFixtureRepo(dir);

      const wgslLines = [
        "struct TestCameraUniforms {",
        "  mvpRelativeToEye: mat4x4<f32>,",
        "  encodedCameraHigh: vec3<f32>,",
        "  pixelRatio: f32,",
        "  unpaddedVec3: vec3<f32>,",
        "  eyeToEnu: mat3x3<f32>,",
        "  previousViewProjection: mat4x4<f32>,",
        "};",
        "@group(0) @binding(0) var<uniform> u_cam: TestCameraUniforms;",
      ];
      const { structs } = analyzeWgslUniformStructs("Test.wgsl", wgslLines);
      const st = structs.get("TestCameraUniforms");
      assert.ok(st);
      // mvp(16) + vec3+f32(4) + vec3+pad(4) + mat3x3(12) + prevVP(16) = 52 floats (208 bytes)
      assert.equal(st.floatCount, 52);
      assert.equal(st.byteSize, 208);
      assert.equal(st.mat3Fields.length, 1);
      assert.equal(st.mat3Fields[0].floatOffset, 24);
      assert.equal(st.unfilledVec3Pads.length, 1);
      assert.equal(st.unfilledVec3Pads[0].afterField, "unpaddedVec3");

      // Also verify TS CAMERA_UNIFORM_FLOATS mismatch detection via buildContextSpine
      fs.writeFileSync(
        path.join(dir, "packages/engine/Source/Shaders/WebGPU/MiniGlobe.wgsl"),
        [
          "struct CameraUniforms {",
          "  mvpRelativeToEye: mat4x4<f32>,",
          "  previousViewProjection: mat4x4<f32>,",
          "};",
          "@group(0) @binding(0) var<uniform> camera: CameraUniforms;",
        ].join("\n"),
        "utf8",
      );
      fs.writeFileSync(
        path.join(
          dir,
          "packages/engine/Source/Renderer/WebGPU/MiniGlobeTypes.ts",
        ),
        [
          "// Paired with MiniGlobe.wgsl",
          "import WebMercatorProjection from '../../Core/WebMercatorProjection.js';",
          "export const CAMERA_UNIFORM_FLOATS = 28;",
          "export const _proj = WebMercatorProjection;",
        ].join("\n"),
        "utf8",
      );

      const dbRel = ".cache/context-spine/test.sqlite";
      await buildContextSpine({ repoRoot: dir, dbPath: dbRel });
      const db = await openOrBuildSpine(dir, {
        dbPath: dbRel,
        autoBuild: false,
      });
      try {
        const mismatches = queryContracts(db, {
          filePath: "MiniGlobeTypes.ts",
          severity: "hazard",
        });
        assert.ok(
          mismatches.items.some(
            (c) => c.contract_type === "UNIFORM_SIZE_MISMATCH",
          ),
          "expected CAMERA_UNIFORM_FLOATS=28 vs 32 mismatch hazard",
        );
        const seams = querySeams(db, "MiniGlobeTypes.ts");
        assert.ok(
          seams.seamEdges.some((e) => e.relation === "crs_transition"),
          "expected EPSG:4326 <-> EPSG:3857 crs_transition edge",
        );
      } finally {
        db.close();
      }
    }));

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

  it("enforces domain-affinity rig set-cover (CS-1), Sandcastle2 default-home pose (CS-4), and GIS header offset hazards (CS-5)", () =>
    withLaneTmp("context-spine-cs145-", async (dir) => {
      createHermeticFixtureRepo(dir);

      const candidateRigs = [
        {
          id: "globe-coast-generic",
          tags: ["globe"],
          renderers: ["webgl", "webgpu"],
          regimes: ["coastal_horizon", "sea_level"],
        },
        {
          id: "water-coast-off",
          tags: ["water"],
          renderers: ["webgl", "webgpu"],
          regimes: ["coastal_horizon", "sea_level"],
        },
        {
          id: "water-coast-50km",
          tags: ["water"],
          renderers: ["webgl", "webgpu"],
          regimes: ["coastal_horizon", "sea_level"],
        },
      ];
      const cover = selectMinimalRigCover(
        candidateRigs,
        ["coastal_horizon", "sea_level"],
        { primaryDomainTag: "water" },
      );
      assert.equal(cover.selectedRigs.length, 1);
      assert.equal(cover.selectedRigs[0].id, "water-coast-50km");

      // Sandcastle2 gallery slug with Viewer and no explicit camera -> default-home pose
      const galleryMain = path.join(
        dir,
        "packages/sandcastle/gallery/test-viewer-demo/main.js",
      );
      fs.mkdirSync(path.dirname(galleryMain), { recursive: true });
      fs.writeFileSync(
        galleryMain,
        'import * as Cesium from "cesium";\nconst viewer = new Cesium.Viewer("cesiumContainer");\n',
        "utf8",
      );
      const fromGallery = extractIndirectRigCoordinates(
        {
          id: "sc2-default-home",
          camera: null,
          dials: { galleryId: "test-viewer-demo" },
        },
        dir,
        ecefToWgs84,
      );
      assert.equal(fromGallery.poseSource, "default-home");
      assert.deepEqual(fromGallery.lons, [-95, -70]);
      assert.ok(fromGallery.extraRegimes.has("orbital"));

      // GIS builder unoffset DataView hazard
      const out = { contracts: [] };
      const filesMap = new Map([
        [
          "Tools/build-global-bathymetry-tensor.mjs",
          "const geoidBuf = fs.readFileSync(GEOID_PATH);\nconst geoidView = new DataView(geoidBuf.buffer, geoidBuf.byteOffset, geoidBuf.byteLength);\n",
        ],
      ]);
      auditGisAndAssetContracts(dir, filesMap, out);
      assert.ok(
        out.contracts.some(
          (c) => c.contractType === "GIS_BUILDER_HEADER_OFFSET",
        ),
        "expected GIS_BUILDER_HEADER_OFFSET hazard on unoffset geoidBuf DataView",
      );
    }));

  it("audits RTE high+low & geocentric asin hazards (CS-2), nested ifdef uniforms & CameraUniforms packer families (CS-3), and multi-line imports, edited-file communities & dead exports (CS-6/CS-7)", () =>
    withLaneTmp("context-spine-cs2367-", async (dir) => {
      createHermeticFixtureRepo(dir);

      const write = (rel, content) => {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf8");
      };

      // CS-3: Nested ifdef uniform struct + PrimitiveLit packer-family CameraUniforms
      write(
        "packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveLit.wgsl",
        [
          "struct CameraUniforms {",
          "  viewMatrix: mat4x4<f32>,",
          "  projectionMatrix: mat4x4<f32>,",
          "  viewProjectionMatrix: mat4x4<f32>,",
          "  encodedCameraHigh: vec3<f32>,",
          "  pixelRatio: f32,",
          "  encodedCameraLow: vec3<f32>,",
          "  time: f32,",
          "  previousViewProjection: mat4x4<f32>,",
          "  inverseViewQuaternion: vec4<f32>,",
          "//>>ifdef LOG_DEPTH",
          "  logDepth: vec4<f32>,",
          "//>>endif",
          "};",
          "@group(0) @binding(0) var<uniform> u_camera: CameraUniforms;",
          "fn badWaterCamera(n: vec3<f32>) -> f32 {",
          "  let camWorld = u_camera.encodedCameraHigh.xyz + u_camera.encodedCameraLow.xyz;",
          "  let rteDiff = (vec3<f32>(0.0) - u_camera.encodedCameraHigh.xyz) + (vec3<f32>(0.0) - u_camera.encodedCameraLow.xyz);",
          "  let lat = asin(clamp(n.z, -1.0, 1.0));",
          "  return camWorld.x + rteDiff.x + lat;",
          "}",
        ].join("\n"),
      );

      write(
        "packages/engine/Source/Shaders/WebGPU/CustomBadCamera.wgsl",
        [
          "struct CameraUniforms {",
          "  mvpRelativeToEye: mat4x4<f32>,",
          "  previousViewProjection: mat4x4<f32>,",
          "  rogueTrailingField: vec4<f32>,",
          "};",
          "@group(0) @binding(0) var<uniform> u_cam: CameraUniforms;",
        ].join("\n"),
      );

      // CS-2 retune: only a projected High+Low sum in shader source is a hazard.
      write(
        "packages/engine/Source/Shaders/WebGPU/Probe.wgsl",
        [
          "struct Camera { mvp: mat4x4<f32>, encodedCameraHigh: vec3<f32>, encodedCameraLow: vec3<f32>, };",
          "@group(0) @binding(0) var<uniform> camera: Camera;",
          "@vertex",
          "fn vsProbe(input: VertexInput) -> @builtin(position) vec4<f32> {",
          "  let cameraWC = camera.encodedCameraHigh + camera.encodedCameraLow;",
          "  let clip = camera.mvp * vec4<f32>(input.positionHigh + input.positionLow, 1.0);",
          "  return clip + vec4<f32>(normalize(cameraWC), 0.0);",
          "}",
          "fn vsProbeSwapped(input: VertexInput) -> vec4<f32> {",
          "  return camera.mvp * vec4<f32>(input.positionLow + input.positionHigh, 1.0);",
          "}",
          "fn vsProbeOutside(input: VertexInput) -> vec4<f32> {",
          "  return camera.mvp * vec4<f32>(input.normal, 0.0) + vec4<f32>(camera.encodedCameraHigh + camera.encodedCameraLow, 0.0);",
          "}",
        ].join("\n"),
      );
      write(
        "packages/engine/Source/Shaders/ProbeVS.glsl",
        [
          "void main()",
          "{",
          "    v_positionMC = position3DHigh + position3DLow;",
          "    gl_Position = czm_modelViewProjection * vec4(position3DHigh + position3DLow, 1.0);",
          "}",
        ].join("\n"),
      );
      write(
        "packages/engine/Source/Renderer/WebGPU/ProbeTemplate.ts",
        [
          "export const probeWgsl = /* wgsl */ `",
          "fn vs(input: VertexInput) -> vec4<f32> {",
          "  let cameraWC = u.encodedCameraHigh + u.encodedCameraLow;",
          "  return u.modelViewProjection * vec4<f32>(input.positionHigh + input.positionLow, 1.0);",
          "}`;",
          "",
          "export function f64Center(out: { x: number }, positionHigh: number[], positionLow: number[]): void {",
          "  out.x = positionHigh[0] + positionLow[0];",
          "}",
          "export const probeInterp = /* wgsl */ `let p = ${",
          "  a.posHigh + a.posLow",
          "};`;",
        ].join("\n"),
      );
      write(
        "packages/engine/Source/Core/F64.js",
        [
          "export function f64Sum(out, positionsHigh, positionsLow) {",
          "  out.x = positionsHigh[0] + positionsLow[0];",
          "  return out;",
          "}",
        ].join("\n"),
      );

      // CS-6/CS-7: Multi-line Prettier import, dynamic import, @experimental vs dead export
      write(
        "packages/engine/Source/Scene/WaterHelper.js",
        [
          "export function usedWaterHelper() { return 1; }",
          "export function orphanedDeadExport() { return 2; }",
          "/**",
          " * @experimental",
          " */",
          "export function experimentalPublicHook() { return 3; }",
        ].join("\n"),
      );

      write(
        "packages/engine/Source/Scene/WaterConsumer.js",
        [
          "import {",
          "  usedWaterHelper,",
          '} from "./WaterHelper.js";',
          "export async function runWaterConsumer() {",
          '  const mod = await import("./Model.js");',
          "  return usedWaterHelper() + (mod ? 0 : 1);",
          "}",
        ].join("\n"),
      );
      // Reference WaterConsumer from a spec so only orphanedDeadExport is unreferenced
      write(
        "Tools/water.spec.mjs",
        'import { runWaterConsumer } from "../packages/engine/Source/Scene/WaterConsumer.js";\nrunWaterConsumer();\n',
      );

      const dbRel = ".cache/context-spine/test.sqlite";
      await buildContextSpine({ repoRoot: dir, dbPath: dbRel });

      // Seed Leiden community on WaterHelper.js, then edit WaterHelper.js and rebuild --incremental
      const graphJsonPath = path.join(dir, "graph.json");
      fs.writeFileSync(
        graphJsonPath,
        JSON.stringify({
          nodes: [
            {
              id: "wh1",
              label: "usedWaterHelper",
              source_file: "Scene/WaterHelper.js",
              source_location: "L1",
              community: 42,
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

      fs.appendFileSync(
        path.join(dir, "packages/engine/Source/Scene/WaterHelper.js"),
        "\n// benign comment edit to trigger incremental re-index of WaterHelper.js\n",
        "utf8",
      );
      const incr = await buildContextSpine({
        repoRoot: dir,
        dbPath: dbRel,
        incremental: true,
      });
      assert.equal(incr.code.changedFiles, 1);

      const db = await openOrBuildSpine(dir, {
        dbPath: dbRel,
        autoBuild: false,
      });
      try {
        // Community preserved on edited file
        const sym = querySymbols(db, dir, "usedWaterHelper")[0];
        assert.equal(sym.communityId, 42);

        // Multi-line + dynamic imports captured
        const seams = querySeams(db, "WaterConsumer.js");
        assert.ok(
          seams.callAndImportEdges.some(
            (e) =>
              e.relation === "imports" &&
              e.dst_id.endsWith("Scene/WaterHelper.js"),
          ),
          "expected multi-line import edge to WaterHelper.js",
        );
        assert.ok(
          seams.callAndImportEdges.some(
            (e) =>
              e.relation === "imports" && e.dst_id.endsWith("Scene/Model.js"),
          ),
          "expected dynamic import() edge to Model.js",
        );

        // Dead exports flags orphanedDeadExport but exempts @experimental and usedWaterHelper
        const dead = queryDeadExports(db, { scopePrefix: "Scene/WaterHelper" });
        const deadNames = dead.items.map((d) => d.name);
        assert.ok(deadNames.includes("orphanedDeadExport"));
        assert.ok(!deadNames.includes("usedWaterHelper"));
        assert.ok(!deadNames.includes("experimentalPublicHook"));

        // CS-2 & CS-3 contracts on PrimitiveLit.wgsl and CustomBadCamera.wgsl
        const litContracts = queryContracts(db, {
          filePath: "PrimitiveLit.wgsl",
        }).items;
        assert.ok(
          litContracts.some(
            (c) =>
              c.contract_type === "CAMERA_PREVIOUS_VP_TAIL" &&
              c.severity === "positive",
          ),
          "PrimitiveLit CameraUniforms family should pass as positive",
        );
        // A camera self-reconstruction is a review lead, not an AGENTS.md section 1 target, and
        // the post-subtraction rteDiff is not reported at all.
        assert.deepEqual(
          litContracts
            .filter((c) => c.contract_type === "DIRECT_HIGH_PLUS_LOW_HAZARD")
            .map((c) => [c.line, c.severity]),
          [[17, "review"]],
          "encodedCameraHigh.xyz + encodedCameraLow.xyz is review; rteDiff is not reported",
        );

        // The hazard fires only where a High+Low sum (either order) is the argument of a
        // projection in shader source: WGSL, GLSL and WGSL template text in .ts.
        const rteRows = (file) =>
          queryContracts(db, { filePath: file })
            .items.filter(
              (c) => c.contract_type === "DIRECT_HIGH_PLUS_LOW_HAZARD",
            )
            .map((c) => [c.line, c.severity])
            .sort((x, y) => x[0] - y[0]);
        assert.deepEqual(
          rteRows("Shaders/WebGPU/Probe.wgsl"),
          [
            [5, "review"],
            [6, "hazard"],
            [10, "hazard"],
            [13, "review"],
          ],
          "camera reconstruction = review; mvp * vec4(positionHigh + positionLow) and the Low+High order = hazard; a sum outside the projection's argument = review",
        );
        assert.deepEqual(
          rteRows("Shaders/ProbeVS.glsl"),
          [
            [3, "review"],
            [4, "hazard"],
          ],
          "GLSL: a model-coordinate reconstruction is review, a projected sum is hazard",
        );
        assert.deepEqual(
          rteRows("Renderer/WebGPU/ProbeTemplate.ts"),
          [
            [3, "review"],
            [4, "hazard"],
          ],
          "WGSL template text in .ts is shader source; the f64 TS sums at line 8 and inside the ${...} at line 11 are not reported",
        );
        assert.deepEqual(
          rteRows("Core/F64.js"),
          [],
          "plain f64 JavaScript never fires",
        );
        assert.ok(
          litContracts.some(
            (c) => c.contract_type === "GEOCENTRIC_ASIN_LATITUDE_HAZARD",
          ),
          "should flag asin(clamp(n.z, ...)) geocentric latitude hazard",
        );

        const badCamContracts = queryContracts(db, {
          filePath: "CustomBadCamera.wgsl",
          severity: "hazard",
        }).items;
        assert.ok(
          badCamContracts.some(
            (c) => c.contract_type === "CAMERA_PREVIOUS_VP_MID_STRUCT",
          ),
          "unauthorized trailing field after previousViewProjection must be hazard",
        );
        const qc = path.join(__dirname, "..", "query-context.mjs");
        const at = ["--repo", dir, "--db", dbRel];
        const cli = (f) =>
          spawnSync(process.execPath, [qc, "contracts", ...f, ...at]);
        const lead = /scoping lead, not a gate/;
        const text = cli([]);
        assert.equal(text.status, 0, "contracts always exits 0");
        assert.match(String(text.stdout).split("\n")[0], lead);
        assert.match(JSON.parse(String(cli(["--json"]).stdout)).note, lead);
      } finally {
        db.close();
      }
    }));

  // --- Lane GWIP round 1 (2026-10-29): assertions for the audit's repairs ---

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

  it("GWIP-3: a rig with its own camera on the CesiumViewer page is not lent the default home view's orbital regime", () =>
    withLaneTmp("context-spine-gwip-home-", async (dir) => {
      createHermeticFixtureRepo(dir);
      fs.writeFileSync(
        path.join(dir, "Tools/visual-regression/rigs/home-view-default.mjs"),
        'export default Object.freeze({\n  id: "home-view-default",\n  tags: ["globe"],\n  page: "Apps/CesiumViewer/index.html",\n  renderers: ["webgl", "webgpu"],\n  description: "The page opening view",\n  camera: null,\n  clock: null,\n  viewport: { width: 800, height: 600 },\n  readiness: { kind: "settleFrames", frames: 8 },\n});\n',
        "utf8",
      );
      const dbRel = ".cache/context-spine/test.sqlite";
      await buildContextSpine({ repoRoot: dir, dbPath: dbRel });
      const db = await openOrBuildSpine(dir, {
        dbPath: dbRel,
        autoBuild: false,
      });
      try {
        const rigs = querySpatialValidation(db, {}).rigs;
        const arctic = rigs.find((r) => r.id === "arctic-svalbard");
        const home = rigs.find((r) => r.id === "home-view-default");
        assert.ok(arctic && home);
        assert.ok(
          !arctic.regimes.includes("orbital"),
          `a 1,500-12,000 m rig is not orbital: ${arctic.regimes.join(", ")}`,
        );
        assert.ok(
          home.regimes.includes("orbital"),
          "the camera-null rig keeps the home view",
        );
      } finally {
        db.close();
      }
    }));

  it("GWIP-4: the rig cover prefers the rig covering more targets, and ledger ranks follow Charter section 0.4 kind by kind", () =>
    withLaneTmp("context-spine-gwip-rank-", async (dir) => {
      // Ids sort so that a cover blind to coverage would take the two narrow rigs.
      const cover = selectMinimalRigCover(
        [
          { id: "a-x-only", tags: [], renderers: ["webgpu"], regimes: ["x"] },
          { id: "b-y-only", tags: [], renderers: ["webgpu"], regimes: ["y"] },
          {
            id: "z-both",
            tags: [],
            renderers: ["webgpu"],
            regimes: ["x", "y"],
          },
        ],
        ["x", "y"],
      );
      assert.deepEqual(
        cover.selectedRigs.map((r) => r.id),
        ["z-both"],
      );

      createHermeticFixtureRepo(dir);
      // A later ACTIVE ruling that cites R-2026-09-17-3 and carries a higher
      // batch number: an id query must still answer with the ruling itself.
      fs.writeFileSync(
        path.join(dir, "migration_doc/MAINTAINER_RULINGS_2026-09-20.md"),
        "# Maintainer rulings — 2026-09-20\n\n## R-2026-09-20-1 — Wave 0 follow-up\n\nBatch 1500 carries out R-2026-09-17-3 for the clean-list fold.\n",
        "utf8",
      );
      const dbRel = ".cache/context-spine/test.sqlite";
      await buildContextSpine({ repoRoot: dir, dbPath: dbRel });
      const db = await openOrBuildSpine(dir, {
        dbPath: dbRel,
        autoBuild: false,
      });
      try {
        const byId = queryLedger(db, "R-2026-09-17-3");
        assert.ok(
          byId.some((r) => r.id === "R-2026-09-20-1"),
          "the citing ruling is a candidate",
        );
        assert.equal(byId[0].id, "R-2026-09-17-3", "the queried ruling leads");
        const amendedQuery = queryLedger(db, "R-2026-09-16-8");
        assert.equal(
          amendedQuery[0].id,
          "R-2026-09-17-3",
          "the superseding ruling still leads",
        );
        const rows = queryLedger(db, "WebGPUModelRenderer.ts", {
          activeOnly: true,
          limit: 20,
        });
        const rankOf = (id) => rows.find((r) => r.id === id)?.authorityRank;
        assert.equal(rankOf("R-2026-09-17-3"), 1, "maintainer ruling");
        assert.equal(rankOf("queue:C16-21"), 2, "campaign queue row");
        assert.equal(rankOf("campaign:C12"), 3, "CAMPAIGN_STATE");
        assert.equal(rankOf("hotspot:WebGPUModelRenderer.ts"), 4, "blueprint");
        assert.equal(
          rankOf("deferred-work:NEW-MODEL-NEWER-NOTE"),
          5,
          "DEFERRED_WORK",
        );
        assert.equal(rows[0].id, "R-2026-09-17-3", "the ruling leads");
      } finally {
        db.close();
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
