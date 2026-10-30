# Context Spine, Graphify & Spatial Validation Graph Guide

**What this is.** The working reference guide to the repository's zero-dependency `node:sqlite` context spine, Graphify AST/Leiden bridge, and deterministic Spatial Validation Graph under `Tools/query-context.mjs` and `Tools/context-spine/`: what each module owns, every `npm run` script, CLI subcommand and MCP tool, how GIS binary headers and WGSL/CRS contracts are verified, and how Antigravity (Argon), Codex (Sol & Astra), and Claude (Fable & Opus) discover and use it across the seat and isolated worker clones. Written and verified against live disk bytes at `c7c7bc6d35` (Batch 1595) on 2026-10-29. Line numbers move; re-read cited lines at `HEAD` before relying on them (`CLAUDE.md` Principle 10; `GEMINI.md` §6).

**Why it exists.** Cold-start orientation across `migration_doc/` (~7.59M tokens across 376 files) and multi-thousand-line engine/shader hotspots (`GlobeTerrain.wgsl` at 9,619 lines, `WebGPUModelRenderer.ts` at 9,411 lines, `WebGPUContext.ts` at 7,988 lines, `Scene.js` at 6,854 lines) previously cost 40K–210K tokens per task while stock AST tools missed Cesium's four cross-boundary seams (`FeatureRendererKey`, 3-word `ShaderDefine`/`Hi`/`Ext` ↔ `//>>ifdef`, `ShaderSourceId`, and `GLSL↔WGSL` pairs). The Context Spine compiles code/shader symbols, Graphify tree-sitter `calls` + Leiden clusters, Charter §0.4 precedence-ranked rulings/ledgers, WGSL uniform/RTE/CRS contracts, and `R*Tree`-indexed Probe Kit rigs + binary-verified GIS datum assets into a single gitignored `.cache/context-spine/cesium-context.sqlite` file (~56 MB at `c7c7bc6d35`). An `impact` call from the CLI took 0.42–0.47 s wall time including Node start-up (lane GWIP, 2026-10-29); a pack is 3–17 KB of Markdown (about 0.8K–4.2K tokens at 4 characters per token).

**Keeping it true.** Pin changes with the hermetic 18-test suite (`R-2026-08-29-1`) and refresh the local SQLite spine after code or queue waves:

```bash
npm run test-context-spine       # 18 hermetic tests, ~7 s
npm run context-refresh          # SHA-256 --incremental refresh; 3.3-3.9 s with nothing changed (measured 2026-10-29)
npm run context-graphify         # re-run graphify --code-only with an installed graphify (never installs; see 2.1)
```

---

## 1. Architecture & Module Inventory

The spine uses Node's built-in `node:sqlite` (`DatabaseSync` + `FTS5` + `R*Tree`; Node `>= 22.13`, the first release that loads `node:sqlite` without `--experimental-sqlite`; measured on `v24.22.1`) with zero npm runtime dependencies, so it executes identically in the seat and in zero-install worker clones.

| Module | Home | What It Owns |
| --- | --- | --- |
| CLI entrypoint | [Tools/query-context.mjs](../Tools/query-context.mjs) | Deterministic CLI flag parser and command router (`build`, `stats`, `impact`, `symbol`, `slice`, `seam`, `ruling`, `ledger`, `spatial-rigs`, `contracts`, `capsule`, `import-graphify`). |
| SQLite schema & freshness guard | [Tools/context-spine/schema.mjs](../Tools/context-spine/schema.mjs) | `SCHEMA_VERSION` (`1`), `FTS5` + `spatial_rigs_rtree` tables, Charter §0.4 `AUTHORITY_RANK`, `readVerifiedSlice` live disk SHA-256 verification and symbol-relocation fallback, and `finalizeDatabaseForReadOnly` (`wal_checkpoint(TRUNCATE)` + `journal_mode = DELETE` so zero `-wal`/`-shm` sidecars exist). |
| Code, shader & seam extractor | [Tools/context-spine/extract-code-seams.mjs](../Tools/context-spine/extract-code-seams.mjs) | Indexes `.js`, `.ts`, `.mjs`, `.wgsl`, and `.glsl` symbols/structs/`@group/@binding` slots, filters `CESIUM_UTILITY_NAMES` hub noise, resolves `FeatureRendererKey`, `ShaderSourceId`, 3-word `ShaderDefine`/`Hi`/`Ext` (`shader-registry-layout.json` owners + `//>>ifdef`), and `GLSL↔WGSL` pairs, and executes the `--incremental` SHA-256 delta fast-path. |
| WGSL uniform & CRS validator | [Tools/context-spine/uniform-crs-validator.mjs](../Tools/context-spine/uniform-crs-validator.mjs) | Exact WebGPU §13.4.1 uniform alignment analyzer (`wgslUniformTypeMetrics`, `analyzeWgslUniformStructs`: `mat3x3<f32>` 12-float stride, implicit 4-byte `vec3<f32>` alignment gaps), TypeScript `CAMERA_UNIFORM_FLOATS` / `TILE_UNIFORM_FLOATS` cross-checker, and `CRS_PATTERNS` (`crs_transition` / `crs_pipeline_step` edges). |
| Governance & ledger compiler | [Tools/context-spine/extract-ledger.mjs](../Tools/context-spine/extract-ledger.mjs) | Precedence-resolved compiler over `MAINTAINER_RULINGS_*.md` (Rank 1, marking superseded rulings `AMENDED` / `VACATED`) > `QUEUE_*.md` (Rank 2) > `CAMPAIGN_STATE.md` (Rank 3) > `CONSOLIDATED_REMEDIATION_BLUEPRINT_2026-10-08.md` (Rank 4) > `DEFERRED_WORK.md` (Rank 5, ordered by Batch number) > `FEATURE_INVENTORY.md` (Rank 6). |
| Spatial R-tree & rig cover | [Tools/context-spine/extract-spatial.mjs](../Tools/context-spine/extract-spatial.mjs) | Bowring ECEF→WGS84 geodetic converter, UTC solar-elevation classifier, planetary singularity regime tagger, `spatial_rigs_rtree` indexer, greedy minimal set-cover selector (`selectMinimalRigCover`), and canonical regime-gap detector (`findSpatialCoverageGaps`). |
| Spatial v2 (indirect rigs & binary GIS) | [Tools/context-spine/spatial-v2.mjs](../Tools/context-spine/spatial-v2.mjs) | `extractIndirectRigCoordinates` geolocating `camera: null` rigs (`218 / 243` R-tree indexed at `c7c7bc6d35`; `25` synthetic/globe-hidden harnesses excluded) via `dials`, 3D Tileset `tileset.json` regions/transforms, HTML, `cameraTrack`, and default `CesiumViewer` extents (the default home view is used only for a rig with no camera and no stations of its own); `inspectLiveGisAssets` parsing live binary/XML/JSON headers (`EGM1`, `GBT1`, `LWM2`, `NE1R`, TMS XML, `IAU2006_XYS`, `Moon`, `approximateTerrainHeights.json`) and wiring `gis_consumes` / `gis_verified_by` edges. |
| Safe Graphify AST/Leiden bridge | [Tools/context-spine/graphify-bridge.mjs](../Tools/context-spine/graphify-bridge.mjs) | Isolates Python/`graphifyy` inside gitignored `.cache/context-spine/py-venv` (with `TEMP`/`TMP`/`PIP_CACHE_DIR` confined to `.cache/context-spine/tmp`), runs `graphify extract --code-only` on `packages/engine/Source` without touching governance files or `.husky`, and merges `21,801` `calls`/`inherits`/`implements` edges + `7,913` Leiden `community_id`s via `importGraphifyJson`. |
| Query engine & capsule builder | [Tools/context-spine/query-engine.mjs](../Tools/context-spine/query-engine.mjs) | `buildContextSpine` (auto-reusing cached `graph.json` on full rebuilds), `openOrBuildSpine` (with `:memory:` fallback inside read-only `EPERM`/`EACCES`/`EROFS` sandboxes), `buildImpactPack`, `formatImpactPackMarkdown`, and `generateContextCapsule`. |
| Stdio MCP server | [Tools/context-spine/mcp-server.mjs](../Tools/context-spine/mcp-server.mjs) | Zero-dependency JSON-RPC 2.0 stdio MCP server (`Content-Length` + NDJSON framing) exposing 6 tools and `detectActiveCesiumRoot(startDir)` so a single global Codex config binds automatically to any active worker clone. |
| Codex TOML MCP installer | [Tools/context-spine/codex-mcp-config.mjs](../Tools/context-spine/codex-mcp-config.mjs) | Idempotent, atomic `[mcp_servers.cesium_context_spine]` editor (`codexMcpAdd` / `codexMcpRemove`) using single-quoted TOML literal strings for Windows backslashes and refusing targets outside `os.tmpdir()` under `NODE_ENV=test` or `--dry-run`. |
| Clone seeding | [Tools/context-spine/seed-clone.mjs](../Tools/context-spine/seed-clone.mjs) | Copies the source's spine DB and `.mcp.json` into a worker clone for `provision-worker-clone.mjs`; skips a source DB that has a `-wal` sidecar (mid-write) instead of checkpointing it, writes nothing in the source, and leaves no pointer to the source's Python venv. |
| Hermetic spec suite | [Tools/context-spine/context-spine.spec.mjs](../Tools/context-spine/context-spine.spec.mjs) | 18 tests: unit, staleness-mutation, Charter §0.4 precedence, R-tree set-cover, Graphify merge, `--incremental` WAL-free finalization, binary GIS header, WGSL uniform layout, Codex TOML guard, and stdio MCP integration tests, plus the six GWIP tests that pin the 2026-10-29 repairs (`npm run test-context-spine`). |

---

## 2. `npm` Scripts & CLI Subcommands

### 2.1 Root `package.json` Scripts

| Script | Example Invocation | Purpose |
| --- | --- | --- |
| `npm run context-impact` | `npm run context-impact -- GlobeTerrain.wgsl` | Emit an Impact Pack (3–17 KB measured; line-anchored symbols + Leiden clusters, Cesium/CRS/GIS seams with engine sources ranked before `Tools/`, Graphify `calls`, active Charter §0.4 rulings/queues, WGSL/RTE contracts, minimal Probe Kit rigs, and `test-*` gates). A `FeatureRendererKey` / `ShaderDefine*` / `ShaderSourceId` target is anchored on the key itself, not on its registry file; a target the index does not hold opens with **TARGET NOT FOUND** and the rest of the pack is inferred from its name only. |
| `npm run spatial-rag` | `npm run spatial-rag -- --for GeoidUndulationGrid.js` | Query the SQLite `R*Tree` rig index (`--for`, `--bbox minLon,minLat,maxLon,maxLat`, `--regime`, `--tag`), minimal Edge-slot rig set-cover, and overlapping binary-verified GIS datum assets. |
| `npm run spatial-contracts` | `npm run spatial-contracts -- --severity hazard` | Query 64-bit RTE, log-depth (`_logDepthEncodeNearFar` vs `currentFrustum`), `CameraUniforms.previousViewProjection` tail, `@group/@binding`, and WebGPU uniform byte/float offset contracts (`--category uniform-layout`). A scoping lead, not a gate: always exits 0 (§4.3). |
| `npm run context-refresh` | `npm run context-refresh` | Incremental SHA-256 delta update (3.3–3.9 s with no file changed, measured 2026-10-29), updating only modified files while keeping existing Graphify `calls` edges and Leiden `community_id`s intact. |
| `npm run context-graphify` | `npm run context-graphify` | Run `graphify extract packages/engine/Source --code-only` with a graphify already installed (`.cache/context-spine/py-venv`, `GRAPHIFY_BIN` or `PATH`) and merge AST call edges + Leiden clusters into SQLite. It never installs anything: the one-time install is `node Tools/query-context.mjs build --with-graphify --bootstrap-graphify --graphify-version <x.y.z>`, which downloads exactly `graphifyy==<x.y.z>` from the default Python package index into the gitignored venv and refuses without the pin. |
| `npm run context-build` | `npm run context-build` | Full SQLite rebuild, 21–25 s measured 2026-10-29 (94–109 s before lane GWIP bounded the import-clause regex), automatically re-importing cached `.cache/context-spine/graphify/graphify-out/graph.json` when present on disk. |
| `npm run context-query` | `npm run context-query -- ruling C13-41` | General entrypoint forwarding any subcommand and flags to `Tools/query-context.mjs`. |
| `npm run test-context-spine` | `npm run test-context-spine` | Run `Tools/context-spine/context-spine.spec.mjs` (18 tests). |

### 2.2 Complete `Tools/query-context.mjs` Subcommand Reference

```bash
# 1. Build or refresh the SQLite database
node Tools/query-context.mjs build [--incremental] [--with-graphify] [--bootstrap-graphify --graphify-version <x.y.z>] [--db <path>]

# 2. Database summary counts & spatial regime coverage gaps
node Tools/query-context.mjs stats [--json]

# 3. One-shot Cross-Seam Impact Pack (~1.5K-2.5K tokens)
node Tools/query-context.mjs impact <file|symbol|define> [--slice] [--json]

# 4. Symbol & WGSL/GLSL lookup (with optional live SHA-256 disk-verified snippet)
node Tools/query-context.mjs symbol <query> [--slice] [--kind <kind>] [--limit <n>] [--json]

# 5. Exact SHA-256-verified line slice (auto-relocates if symbol shifted on disk)
node Tools/query-context.mjs slice <relPath> <startLine> <endLine> [--symbol <name>] [--json]

# 6. Traverse FeatureRendererKey, 3-word ShaderDefine/ifdef, ShaderSourceId, GLSL<->WGSL, CRS & GIS seams
node Tools/query-context.mjs seam <target> [--json]

# 7. Charter §0.4 precedence-ranked Maintainer Rulings & Campaign Ledgers
node Tools/query-context.mjs ruling <query> [--all] [--limit <n>] [--json]
node Tools/query-context.mjs ledger <query> [--all] [--kind <docKind>] [--limit <n>] [--json]

# 8. Spatial R-tree rig selection & live GIS datum query
node Tools/query-context.mjs spatial-rigs [--for <target>] [--bbox minLon,minLat,maxLon,maxLat] [--regime <r1,r2>] [--tag <t1,t2>] [--json]

# 9. Coordinate-frame, RTE 64-bit, log-depth & WGSL uniform alignment contracts
node Tools/query-context.mjs contracts [--file <path>] [--category <cat>] [--severity <hazard|review|positive>] [--json]

# 10. Pre-compiled role-sliced Markdown capsule for worker/reviewer clones
node Tools/query-context.mjs capsule <target1[,target2...]> [--role <worker|reviewer|orchestrator>] [--out <path>] [--json]

# 11. Merge an existing Graphify --code-only graph.json
node Tools/query-context.mjs import-graphify <graphJsonPath> [--prefix <scanPrefix>]
```

---

## 3. MCP Server (`cesium-context-spine` / `cesium_context_spine`)

[Tools/context-spine/mcp-server.mjs](../Tools/context-spine/mcp-server.mjs) speaks standard MCP JSON-RPC 2.0 over `stdio` (accepting both `Content-Length` headers and newline-delimited JSON) and exposes eight tools. They never write to tracked files; the first call in a tree with no DB builds `.cache/context-spine/cesium-context.sqlite` (a full build, about 25 s) or, in a read-only sandbox, an in-memory DB:

| MCP Tool Name | Equivalent CLI Surface | Key Parameters |
| --- | --- | --- |
| `cesium_impact_pack` | `impact <target>` | `target` (required), `includeSlices` (`boolean`) |
| `cesium_query_symbol` | `symbol` / `slice` | `query` (required), `kind`, `includeSlice` (`boolean`), `limit` |
| `cesium_query_ledger` | `ruling` / `ledger` | `query` (required), `docKind`, `includeHistorical` (`boolean`), `limit` |
| `cesium_spatial_rigs` | `spatial-rigs` | `forTarget`, `bbox` (`[minLon, minLat, maxLon, maxLat]`), `regimes`, `tags`, `renderer` |
| `cesium_check_contracts` | `contracts` | `filePath`, `category`, `severity` (`hazard` \| `review` \| `positive`), `limit` |
| `cesium_context_capsule` | `capsule` | `targets` (`string[]`, required), `role` (`worker` \| `reviewer` \| `orchestrator`) |
| `cesium_query_seams` | `seam` | `target` (required), `limit` |
| `cesium_dead_exports` | — | `prefix`, `includePublicJsDefaults` (`boolean`), `limit` |

**Read-only sandbox & multi-clone guarantees:**

1. **Zero WAL/SHM sidecar requirement:** Every build ends with `finalizeDatabaseForReadOnly(db)` (`PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;`), allowing `codex mcp-server` under `sandbox_mode="read-only"` to open `.cache/context-spine/cesium-context.sqlite` with `{ readOnly: true }` without `SQLITE_CANTOPEN` sidecar failures. If no `.sqlite` file exists inside a locked read-only sandbox, `openOrBuildSpine` transparently builds in `:memory:`.
2. **Automatic worker-clone root detection:** `detectActiveCesiumRoot(process.cwd())` walks upward for `packages/engine/Source` + `Tools/query-context.mjs`, so a single global `~/.codex/config.toml` registration automatically queries whichever clone (`F:/Dev/GH/cesium-astra-*` or `F:/Dev/GH/cesium-lane-*`) the agent was launched inside.

---

## 4. Spatial Validation Graph, Live GIS Assets & WGSL/CRS Contracts

### 4.1 Probe Kit `R*Tree` Coverage & Minimal Edge-Slot Set-Cover

Because browser verification serializes through the single `.edge-slot.lock` ([PROBE_KIT_GUIDE.md](PROBE_KIT_GUIDE.md)), running redundant scenes wastes GPU wall-clock time. Indexing [Tools/visual-regression/rigs/](../Tools/visual-regression/rigs) into `spatial_rigs_rtree` (`218 / 243` geographic rigs indexed at `c7c7bc6d35`; `25` synthetic or `hide: ["globe"]` local-tangent harnesses intentionally excluded from geographic bboxes) tags each rig with regimes from `CANONICAL_SPATIAL_REGIMES` (19 names, `Tools/context-spine/extract-spatial.mjs`). The thresholds as coded in `analyzeRigSpatialEnvelope`:

- `north_pole` / `south_pole` (`lat >= 80°` / `lat <= -80°`), `high_latitude` (`|lat| >= 60°`), `equatorial` (`|lat| <= 15°`), `antimeridian_seam` (`|lon| >= 170°`), `prime_meridian_seam` (`|lon| <= 2°`)
- `sub_ellipsoid_or_underground` (`height < 0 m` or an underground/subsurface description), `near_surface` (`0–2,000 m`), `cloud_deck_altitude` (`2–18 km`, or a `cloud` tag), `stratospheric_or_limb` (`18–250 km`), `orbital` (`> 250 km`, or the `orbital-ladder` tag)
- `grazing_terminator` (`solarElevationDeg` in `[-8°, +10°]`), `night_lit` (`solarElevationDeg < -8°`), `coastal_or_water`, plus the asset- and harness-derived names (`2d_or_columbus`, `voxel_volume`, `inland_lake_or_river`, `antimeridian_coast_sdf`, `sub_ellipsoid_ocean_bathy`)

`selectMinimalRigCover(rigs, requiredTargets)` runs greedy set-cover preferring dual-renderer (`webgl+webgpu`) rigs so `npm run spatial-rag -- --for <target>` returns the smallest 2–4 rig cover exercising all required regimes.

### 4.2 Binary- & Metadata-Verified GIS Datum Assets (`11` Assets)

Rather than trusting hand-typed metadata, `inspectLiveGisAssets` in [Tools/context-spine/spatial-v2.mjs](../Tools/context-spine/spatial-v2.mjs) parses the shipped binary headers (`EGM1`, `GBT1`, `LWM2`, `NE1R`), TMS `tilemapresource.xml`, and JSON tables directly on disk and links each asset to its engine consumers (`gis_consumes`) and `.spec.mjs` / probe gates (`gis_verified_by`):

| Asset ID | Builder / Source | Shipped Asset Inspected | Verified Format & Vertical Datum |
| --- | --- | --- | --- |
| `egm2008-geoid` | [Tools/build-geoid-undulation-grid.mjs](../Tools/build-geoid-undulation-grid.mjs) | `packages/engine/Source/Assets/Geoid/egm2008-0p5deg.i16` | `EGM1` `721x361` `0.5°` `i16` (`520,594 B`); EGM2008 MSL → WGS84 ellipsoid (`GeoidUndulationGrid.js`) |
| `global-bathymetry-tensor` | [Tools/build-global-bathymetry-tensor.mjs](../Tools/build-global-bathymetry-tensor.mjs) | `packages/engine/Source/Assets/WaterMask/globalBathymetryTensor.bin` | `GBT1` `720x360` `0.5°` RGBA8 (`1,036,812 B`); depth below MSL |
| `ne50m-coastline-lwm2` | [Tools/build-coastline-water-mask.mjs](../Tools/build-coastline-water-mask.mjs) | `packages/engine/Source/Assets/WaterMask/ne50mCoastlines.bin` | `LWM2` coastline water mask (`7,897` rings, `1,869,180 B`); MSL shoreline |
| `ne10m-lakes-lwm2` | [Tools/build-lake-water-mask.mjs](../Tools/build-lake-water-mask.mjs) | `packages/engine/Source/Assets/WaterMask/ne10mLakes.bin` | `LWM2` inland lake mask (`4,421` polygons, `962,372 B`); orthometric/WGS84 lake height |
| `ne10m-rivers-ne1r` | [Tools/build-global-river-binary.mjs](../Tools/build-global-river-binary.mjs) | `packages/engine/Source/Assets/WaterMask/ne10mRivers.bin` | `NE1R` river polylines + Strahler width (`1,993` rivers, `1,182,648 B`); terrain-draped |
| `eot20-ocean-tides` | [Tools/build-eot20-constituent-grid.mjs](../Tools/build-eot20-constituent-grid.mjs) | [packages/engine/Source/Core/TideConstituentGrid.js](../packages/engine/Source/Core/TideConstituentGrid.js) | EOT20 harmonic amplitude/phase constituent grid; MSL tidal displacement |
| `cloud-weather-tex-packer` | [Tools/build-cloud-tiled-hydrography.mjs](../Tools/build-cloud-tiled-hydrography.mjs) | [packages/engine/Source/Scene/Weather/WeatherTexPacker.ts](../packages/engine/Source/Scene/Weather/WeatherTexPacker.ts) | Equirectangular RGBA weather field; WGS84 surface + cloud shell altitudes |
| `approximate-terrain-heights` | [packages/engine/Source/Core/ApproximateTerrainHeights.js](../packages/engine/Source/Core/ApproximateTerrainHeights.js) | `packages/engine/Source/Assets/approximateTerrainHeights.json` | Level `0..6` geographic quadtree min/max heights (`10,922` tiles); WGS84 ellipsoid |
| `black-marble-night-lights` | [Tools/bake-black-marble-pyramid.mjs](../Tools/bake-black-marble-pyramid.mjs) | `packages/engine/Source/Assets/Textures/BlackMarble` | Geodetic `EPSG:4326` TMS pyramid (`tilemapresource.xml`, levels `0..3`) |
| `iau2006-xys-precession` | [Tools/derive-lunar-eclipse-circumstances.mjs](../Tools/derive-lunar-eclipse-circumstances.mjs) | `packages/engine/Source/Assets/IAU2006_XYS` | `28` ICRF → ITRF/WGS84 Earth-fixed `f64` precession-nutation ephemeris chunks |
| `lola-lroc-moon-dem` | [Tools/moon-albedo-bake/bake-lola-normals.mjs](../Tools/moon-albedo-bake/bake-lola-normals.mjs) | `packages/engine/Source/Assets/Textures/Moon` | Selenographic tangent-space normal (`679,782 B`) + albedo; IAU Moon sphere (`1,737.4 km`) |

### 4.3 Coordinate-Frame (`CRS`) Edges & WGSL Uniform Layout Contracts

[Tools/context-spine/uniform-crs-validator.mjs](../Tools/context-spine/uniform-crs-validator.mjs) links files across nine canonical coordinate-frame nodes (`crs:EPSG:4326_Geographic`, `crs:EPSG:3857_WebMercator`, `crs:EGM2008_Orthometric_MSL`, `crs:ICRF_J2000_Inertial`, `crs:WGS84_Ellipsoidal_Height`, `crs:WGS84_ECEF_f64`, `crs:RTE_EyeRelative_f32x2`, `crs:ENU_LocalTangent`, `crs:Clip_WebGPU_Z01_LogDepth`) via `crs_transition` and `crs_pipeline_step` edges, and audits five static GPU contract families:

1. **`precision_rte`** (`AGENTS.md` §1), from [Tools/context-spine/extract-code-seams.mjs](../Tools/context-spine/extract-code-seams.mjs): `DIRECT_HIGH_PLUS_LOW_HAZARD` is a `hazard` only where a `High + Low` sum (in either order) is the argument of a projection (`mvp` / `modelViewProjection` / `viewProjection` `* vec4(...)`) in shader source: `.wgsl`, `.glsl` and WGSL template strings in `.ts`. Every other shader sum is `review`, because it reconstructs an absolute position in f32 (about 0.5 m at Earth radius), which is fine for a direction or a LUT altitude but not for projection. Plain JS/TS arithmetic is f64 and is never reported. `RAW_MVP_POSITION_HAZARD` flags a raw `mvp * vec4(position, 1.0)` without a `RelativeToEye` matrix. `positionHigh`/`posHigh`/`encodedCameraHigh` reads and `translateRelativeToEye` calls are recorded as positives. At `c7c7bc6d35` the rule reports 0 hazards and 51 review rows.
2. **`depth_encoding`**: distinguishes global `_logDepthEncodeNearFar` (`recordLogDepthEncoder`) from per-slice `currentFrustum` encoding hazards.
3. **`camera_uniform_tail`** (`AGENTS.md` §1): flags `CAMERA_PREVIOUS_VP_MID_STRUCT` when fields trail `previousViewProjection: mat4x4<f32>` inside `CameraUniforms`.
4. **`uniform-layout`** (WebGPU §13.4.1): computes exact byte/float offsets for `var<uniform>` WGSL structs, flagging `UNIFORM_MAT3X3_VEC4_STRIDE` (`mat3x3<f32>` = 12 floats / 48 bytes, not 9), `UNIFORM_IMPLICIT_VEC3_PAD` (4-byte implicit gap after an unpadded `vec3<f32>`), and `UNIFORM_SIZE_MISMATCH` / `UNIFORM_LAYOUT_VERIFIED` against TypeScript `CAMERA_UNIFORM_FLOATS` and `TILE_UNIFORM_FLOATS` constants.
5. **`bind_group_layout`**: indexes `@group(G) @binding(B)` declarations across all `.wgsl` shaders.

**Contracts and hazard output is a scoping lead, not a gate.** It has no runner home, and `node Tools/query-context.mjs contracts` always exits 0 (the CLI prints this in its header). This covers the CLI, `npm run spatial-contracts`, MCP `cesium_check_contracts` and the contracts section of an impact pack. A hazard row, or the absence of one, is never acceptance evidence. Re-read the cited line at `HEAD` and decide whether the value reaches clip space. On 2026-10-29 the pre-retune rule labelled 57 rule-conformant lines as `AGENTS.md` §1 violations, and two Antigravity water lanes edited engine shaders from that output: in one (w1c) the edit made the camera altitude in `PrimitiveMatWaterFlat.wgsl` 286-610 m less precise, a regression; in the other (w1a) the edit at `WebGPUGlobeSurfaceShaders.ts:538` was a small, benign precision gain whose comment overclaimed it.

---

## 5. Multi-Agent Discovery, Clone Provisioning & IDE Profile Hygiene

| Agent / Environment | Active Discovery & Wiring Surfaces |
| --- | --- |
| **Antigravity / Gemini (Argon)** | `GEMINI.md` §10 + `AGENTS.md` §10; `npm run context-impact` / `spatial-rag` / `spatial-contracts`. **IDE Profile Trim:** keep `chrome-devtools-plugin`, `modern-web-guidance-plugin`, and `google_maps_platform` enabled; keep unrelated heavy global plugins (`science`, `data-agent-kit-plugin`, `flutter`, `firebase`, `android-cli-plugin`, `gemini-api`, `google-antigravity-sdk` — 123 skills & 13 cloud MCPs) disabled during Cesium waves via Antigravity Customizations (`JetboxWriteState`) to save ~15K–25K system-prompt tokens per turn (the Antigravity session's own estimate; not measured in this repository, and not a rule). |
| **Codex (Sol & Astra)** | Global `~/.codex/config.toml` `[mcp_servers.cesium_context_spine]` managed via `node Tools/context-spine/codex-mcp-config.mjs --install` (`--uninstall` to remove); `AGENTS.md` §10 & Part Two router; [CODEX_SOL_OPERATING_BRIEF.md](CODEX_SOL_OPERATING_BRIEF.md) §8; [ORCHESTRATION_HANDBOOK.md](ORCHESTRATION_HANDBOOK.md) §0 step 8. |
| **Claude Code (Fable & Opus)** | Gitignored repo-root `.mcp.json` (`cesium-context-spine`); `CLAUDE.md` Principle 13 & Key Reference Files; [.agents/skills/run-cesium-campaign-lane/SKILL.md](../.agents/skills/run-cesium-campaign-lane/SKILL.md) §2; [.agents/skills/audit-cesium-certification/SKILL.md](../.agents/skills/audit-cesium-certification/SKILL.md) §2. |
| **Worker & Reviewer Clones** | [Tools/provision-worker-clone.mjs](../Tools/provision-worker-clone.mjs) automatically copies `.cache/context-spine/cesium-context.sqlite` and `.mcp.json` into `<clone>`, optionally writes `<clone>/_review/context-capsule.md` via `--capsule <target1,target2> [--capsule-role worker\|reviewer]`, and supports `--codex-mcp` / `--codex-unmcp`. |

**Standard worker/reviewer provisioning recipe:**

```bash
git clone --no-hardlinks F:/Dev/GH/cesium-webgpu F:/Dev/GH/cesium-lane-example
node Tools/provision-worker-clone.mjs F:/Dev/GH/cesium-lane-example \
  --codex-trust \
  --capsule WebGPUGlobeSurfaceCameraUB.ts,GlobeTerrain.wgsl \
  --capsule-role worker
```

---

## 6. Guardrails & Maintenance Discipline

1. **Never commit generated caches:** `.cache/`, `graphify-out/`, `_lane-out/`, `_review/`, and `.mcp.json` stay gitignored (`.gitignore`, `.prettierignore`, `eslint.config.js`).
2. **Graphify runs `--code-only` only:** Never run `graphify claude/gemini/codex/hook install` (which mutates governance files and `.git/hooks`), and never run LLM semantic extraction over `migration_doc/**` (which flattens `VACATED` / `AMENDED` history into false-live triples).
3. **`HEAD` bytes remain the sole authority (`GEMINI.md` §6):** `readVerifiedSlice` checks each file's live SHA-256 on disk and relocates moved symbols automatically, but every agent must still verify cited `file:line` spans at `HEAD` before editing code or writing review citations.
4. **`TOOLING_CATALOG.md` regeneration at stage time:** Because [Tools/generate-tooling-catalog.mjs](../Tools/generate-tooling-catalog.mjs) reads candidate `.mjs` files from the git index, stage new or modified `Tools/context-spine/*.mjs` files first, then run `npm run generate-tooling-catalog` and stage [TOOLING_CATALOG.md](TOOLING_CATALOG.md) so `npm run verify-tooling-catalog` exits `0`.
