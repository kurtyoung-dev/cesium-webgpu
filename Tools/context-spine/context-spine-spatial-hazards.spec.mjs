// context-spine-spatial-hazards.spec.mjs — GIS and indirect rigs, WGSL uniform layouts, set-cover and the RTE / CameraUniforms hazard audits, one part of the Context Spine spec.
// @purpose Hermetic tests for GIS and indirect rigs, WGSL uniform layouts, set-cover and the RTE / CameraUniforms hazard audits, split out of context-spine.spec.mjs by concern; test names and bodies are unchanged and the shared fixture repo lives in fixtures/context-spine-support.mjs.
// @status ACTIVE

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { ecefToWgs84, selectMinimalRigCover } from "./extract-spatial.mjs";
import {
  auditGisAndAssetContracts,
  extractIndirectRigCoordinates,
  inspectLiveGisAssets,
} from "./spatial-v2.mjs";
import { analyzeWgslUniformStructs } from "./uniform-crs-validator.mjs";
import {
  buildContextSpine,
  openOrBuildSpine,
  queryContracts,
  queryDeadExports,
  queryLedger,
  querySeams,
  querySpatialValidation,
  querySymbols,
} from "./query-engine.mjs";
import { createHermeticFixtureRepo } from "./fixtures/context-spine-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("Cesium Context Spine (SQLite FTS5 + R-Tree + Seams + Contracts + MCP) - spatial and hazard guards", () => {
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
});
