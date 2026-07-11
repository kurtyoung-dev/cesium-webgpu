# Vegetation V1 — Scope Lock

**Status:** Scope-lock (doc-only; NO runtime code). Gate for `VEGETATION-V1-CORE`.
**Date:** 2026-07-11
**Campaign:** C7 batch #18 (`C7-VEGETATION-V1-SCOPE-LOCK`), queue row `migration_doc/QUEUE_2026-07-06_CAMPAIGN7.md:46`.
**Parents (SSOT):** `migration_doc/VEGETATION_SYSTEM_DESIGN.md` (the epic design doc, 540 lines, 2026-06-05) — this doc does not restate it, it *pins the V1 cutline and the open decisions* the design doc left to the scope-lock.
**Research input:** lane R-VEGETATION (`RESEARCH_R-VEGETATION_2026-07-06.md`; technique survey + verbatim CC0 license verification + fork-infra corroboration). All license verdicts and technique claims independently re-verified in that lane; folded in below.

This document de-risks the V1 slice of the vegetation epic. It (1) pins the V1 artifact list, (2) resolves the GPU-cull-gate routing decision (`Pass.OPAQUE` vs `Pass.CESIUM_3D_TILE`) with live-command-pipeline evidence, (3) confirms which reusable infra is live at HEAD with file evidence, and (4) folds in the R-VEGETATION research (license-clean assets + technique cutline). **V1-CORE implementation is not in this campaign** — no runtime code is written here.

---

## 0. Premise verification (done first, per charter)

The scope-lock premise is **live and unshipped** — verified against HEAD:

- No `VEGETATION`/`SCATTER` entry in `Renderer/FeatureRendererKey.js` (checked; highest key = `FLOW_FIELD: 52`, `COUNT: 53`).
- No `VegetationScatter` shader, no `VegetationScatterCollection`, no `WebGPUVegetationScatterRenderer`. The vegetation epic is design-only (`VEGETATION_SYSTEM_DESIGN.md` header: "no code shipped yet").
- The reusable infra the design doc *assumed* is all live at HEAD (§3 below) — the scope-lock's job is to confirm that and pin the routing decision, both done here.

Conclusion: premise is **not stale**. This is a genuine doc-only de-risk; the deliverable is this committed doc. No runtime change, no probe (doc-only acceptance).

---

## 1. V1 artifact list (LOCKED)

V1 = **one region, one draw path, deterministic, both backends, probe-verified.** Opt-in, default-OFF, byte-identical when off. The complete artifact set:

### 1.1 New Scene-layer API (backend-agnostic)
- `Scene/VegetationScatterCollection.js` — public API: `rectangle` (region), `densityTexture?` (optional; default = procedural fBm masked by terrain slope), `species[]` (≤4 entries `{url, weight, heightRange}`), `seed`, `maxInstances` (≤ **65,536** = exactly one culler batch). Opt-in: nothing scatters unless a collection is added; zero collections ⇒ byte-identical to today.
- Backend routing per CLAUDE.md Principle 2: shared "Scene Logic Extractor" runs BEFORE the `if (context.isWebGPU)` branch; WebGPU path via `context.getFeatureRenderer(FeatureRendererKey.VEGETATION_SCATTER)`, WebGL2 CPU-twin path as the default fallback after `if (fr) { fr.update(...); return; }`.

### 1.2 New registry entries (ADD-ONLY — never reorder)
- `FeatureRendererKey.VEGETATION_SCATTER = 53` (next free; bump `COUNT` 53→54). *(Verified next-free at HEAD.)*
- `ShaderSourceId.VEGETATION_SCATTER = 41` (compute) + `ShaderSourceId.VEGETATION_RENDER = 42` (draw), next-free after `POINT_CLOUD_EDL_BLEND: 39` → max 40. *(Verified.)* Both add-only per the CLAUDE.md ShaderSourceId rule (ID 0 reserved). No new `ShaderDefine` **bit** is required for V1 (wind/fade are always-on in the vegetation pipeline, not gated) — the first vegetation define bits (`VEGETATION_WIND`, etc.) land in V4 per design-doc §6.1. If a V1 define bit is added it must respect the 24-bit module-cache key mask (bits ≥24 need the Batch-476 keySalt pattern).

### 1.3 New WebGPU renderer
- `Renderer/WebGPU/WebGPUVegetationScatterRenderer.ts` — a **specialization of the `WebGPUComputeInstanceRenderer` pattern** (§3), NOT a from-scratch build: upload region/species/density params once → per-frame (or on-dirty) compute dispatch writes RTE high/low position per instance into a storage buffer → instanced vertex-pull draw. Add its path to `WEBGPU_COMPAT_EXEMPTIONS` in `scripts/bundleVariantPlugin.js` ONLY if it exports a backend-neutral API (it does not — it's WebGPU-only, so no exemption needed).

### 1.4 New compute shader
- `Shaders/WebGPU/Compute/VegetationScatter.wgsl` — jittered-grid scatter (§4), routed through the WGSL preprocessor + module cache. **Template = `Shaders/WebGPU/Compute/PointCloudLOD.wgsl`** (SOA layout + atomic compaction). **No Poisson-disk relaxation** — Ghost-of-Tsushima jittered grid (the shipped AAA recipe; cheaper, trivially deterministic).

### 1.5 Instance buffer layout (LOCKED — reserve all slots now)
48-byte SOA-packed record; ~50K instances ≈ 2.4 MB / region:

| Field | Bytes | Notes |
|---|---|---|
| `positionHigh` | 12 (3×f32) | RTE high part — **CPU-computed from region origin** (WGSL has no f64) |
| `positionLow` | 12 (3×f32) | RTE low part — f32 offset written by the compute kernel |
| `quatYaw` + `scale` | 8 | packed yaw + uniform scale from the instance hash |
| `speciesId` + `featureId` + `windPhase` + `flags` | 16 | `featureId = cellId` (stable pick ID — **never buffer index**, §6); `windPhase` from hash |

**RTE mandate (charter rule 5):** positions are `positionHigh`/`positionLow`, never a single `vec3<f32>`; the vertex path uses `mvpRelativeToEye * translateRelativeToEye(...)` exactly like `GlobeTerrain.wgsl`. The high part is computed on CPU (one per region origin); only the f32 offset is produced on GPU. Never split a double in WGSL.

### 1.6 CPU twin (WebGL2 path + determinism oracle)
- `Scene/VegetationScatterWorker.js` (or WASM) — runs the **byte-identical** decision tree (same PCG hash in JS) writing the same 48-byte layout. This is BOTH the WebGL2 fallback (no compute in WebGL2) AND the determinism cross-check in the probe.

### 1.7 Draw path
- Instanced draws emitted as **`Pass.OPAQUE`** commands (decision locked in §2) → inherits `gpuCullCommands()` (`CullMode.INDIRECT`) + `WebGPUIndirectDrawManager` on WebGPU; CPU frustum pre-filter + normal instanced draw on WebGL2. Honor the size-validation / index-overflow sentinel (clamp + `console.error`) per CLAUDE.md logging rules.

### 1.8 Wind (both backends, lockstep)
- Crysis **main-bend** only (GPU Gems 3 ch.16): `vNewPos.xy += wind.xy * (posUp² * bendScale)`, then length-preserving `normalize(vNewPos) * fLength` so the trunk base stays planted; per-instance phase from the instance hash. Grass cards add one sine band. WGSL + GLSL twins. No vertex-color channels (CC0 low-poly packs don't ship them — detail-bending is V4).

### 1.9 Distance fade
- Single fade band via the shipped `csm_stochasticDither.wgsl` (IGN noise, TAA-converging). No LOD tiers in V1.

### 1.10 Starter assets (CC0 — §5)
- Vendored under `Apps/SampleData/models/vegetation/` with a verbatim-license `LICENSES.md`: 3 Quaternius trees (conifer / broadleaf / dead-or-birch) + 1 grass clump (or 2 crossed quads built in-code). Total ≤ ~5 MB.

### 1.11 Verification
- `Tools/visual-regression/probe-veg-scatter.mjs`: fixed seed → (a) WebGL vs WebGPU pixel diff, (b) **GPU-vs-CPU-twin instance-buffer bit-equality** (sort by `featureId` first — atomic-compaction order is non-deterministic, §6), (c) two-run determinism. Plus a Sandcastle demo under `packages/sandcastle/gallery/webgpu-vegetation-scatter/`.

### 1.12 Off-gate (byte-identical)
- Zero `VegetationScatterCollection` instances ⇒ no feature-renderer dispatch, no compute pass, no draw commands ⇒ byte-identical output. Opt-in default-OFF is what preserves the fork charter's byte-identical guarantee.

---

## 2. Routing decision — `Pass.OPAQUE` (LOCKED, with live-code evidence)

**Decision: dispatch vegetation scatter draws as `Pass.OPAQUE` commands.** (Design-doc "LOD-C" open decision; queue-row #18 required resolution.)

### Evidence from the live command pipeline (verified at HEAD 2026-07-11)
- `gpuCullCommands()` — the GPU frustum-cull entry that writes `instanceCount=0` into indirect args for culled instances — is invoked **only** from inside `WebGPUSceneRenderer._executeOpaquePass()`. Confirmed: the sole live call site is `WebGPUSceneRenderer.ts:2075`, inside the method that begins at `WebGPUSceneRenderer.ts:1941` (`public _executeOpaquePass(...)`). (A second call at `:3608`, `gpuCullCommandsForTranslucent`, is the separate translucent path.)
- `_execute3DTilePasses()` (`WebGPUSceneRenderer.ts:1927`) is a **distinct** method and does **not** call `gpuCullCommands`. Grep for `gpuCullCommands` across the 3D-tile pass files (`WebGPUSceneRenderer3DTilePasses.ts` and siblings) returns **no hits** — the `Pass.CESIUM_3D_TILE` execution path bypasses the GPU culler entirely.

### Rationale
1. **Inherits the existing GPU-cull gate with zero new wiring.** OPAQUE-pass commands automatically flow through `gpuCullCommands()` (`CullMode.INDIRECT`) + `WebGPUIndirectDrawManager`. Routing through the 3D-tile pass would require adding a cull gate to `_execute3DTilePasses()` — +1 batch of risk against a regression-sensitive path (classification stenciling, CSM cast list, pick blit).
2. **Semantically correct.** Vegetation is not tile *content* — it is a scene primitive *draped over* the terrain/tiles, so `Pass.OPAQUE` is the right bucket (the same bucket ground primitives use).
3. **Avoids the 3D-tile execution path**, which the design doc §9 item 8 flags as coupled to translucent-classification (the known Batch-47 `WebGPUTranslucentTileclassification` multi-frustum gap) — use opaque LODs near classification.

### Accepted cost
Vegetation will not participate in 3D-tile-pass-specific behaviors (per-tile classification stenciling). Design-doc §9 item 8 already prescribes "use opaque canopy LODs near classification," so this is a documented, accepted limitation — not a regression.

### CSM cast-list caveat (carry to V1-CORE)
Scattered instances must be gathered into the shadow-cast pass or trees float shadowless. The shadow renderer is `Renderer/WebGPU/WebGPUShadowMapRenderer.js` (present at HEAD — note: `.js`, not `.ts` as some notes say). V1-CORE must confirm its cast-list gathering accepts OPAQUE-pass vegetation commands (design-doc §9 item 8). GoT excluded grass from shadow maps (dithered depth impostors instead) — so grass-card CSM exclusion is acceptable; trees must cast.

---

## 3. Reusable infra confirmed LIVE at HEAD (file evidence)

Every capability V1 leans on was verified present in the tree on 2026-07-11 (line counts as a liveness signal):

| Infra | File (verified LIVE) | V1 use |
|---|---|---|
| **GPU-resident instance substrate** | `Renderer/WebGPU/WebGPUComputeInstanceRenderer.ts` (1548 lines) | **The exact pattern V1 specializes** — Batch 231 "feature-agnostic GPU-resident instance system": per-instance params upload once → per-frame compute kernel writes **RTE high/low position** + color into a storage buffer → instanced vertex-pull draw; built-in per-frustum cull binding (`boundingSphere` contract), TAA velocity ping-pong (Batch 235), GPU picking (Batch 279, rasterized). Docstring lines 1-50 confirm the RTE split/write scaffold. |
| GPU frustum cull | `Renderer/WebGPU/WebGPUGPUCuller.ts` (583 lines) | `maxObjects` default 65,536; workgroup 256; `CullMode.{VISIBILITY,INDIRECT,COUNT}`; INDIRECT writes `instanceCount=0`; 2-buffer readback ring. Per-instance frustum cull via the `Pass.OPAQUE` gate (§2). |
| Indirect draw | `Renderer/WebGPU/WebGPUIndirectDrawManager.ts` (422 lines) | `maxDrawCalls` default 4,096; stride 5 u32 (indexed) / 4. One `drawIndexedIndirect` per (species × tier). |
| Hi-Z occlusion | `Renderer/WebGPU/WebGPUHiZOcclusionDispatcher.ts` (1132 lines) | r32float pyramid + SOA sphere test. **Defer to V5** (GoT found occlusion "marginal" for grass). |
| Scatter compute template | `Shaders/WebGPU/Compute/PointCloudLOD.wgsl` (LIVE) + `FrustumCull.wgsl` (LIVE) | SOA + atomic-compaction template for `VegetationScatter.wgsl`. |
| Stochastic dither | `Shaders/WebGPU/chunks/functions/csm_stochasticDither.wgsl` (LIVE) | Distance fade (V1); its docstring already lists "Future: foliage." |
| Model instancing | `Renderer/WebGPU/WebGPUModelInstancing.js` (468 lines) | 64 B/instance storage buffer → `@builtin(instance_index)`; draws the tree meshes. |
| GPU sort keys | `Renderer/WebGPU/WebGPUGPUSortKeysDispatcher.ts` (999 lines) | Material/depth batching — **V6, do not gate V1** (JS faster <50K). |
| Render bundles | `Renderer/WebGPU/WebGPURenderBundleManager.ts` (494 lines) | Static far-tier tiles — **V6**. |
| Clustered lighting | `Renderer/WebGPU/WebGPUClusteredLightingDispatcher.ts` (624 lines) | Trees inherit point lights via the model/PBR path — **free, no vegetation-specific work**. |
| Shadow (CSM) cast | `Renderer/WebGPU/WebGPUShadowMapRenderer.js` (present) | Cast-list gathering for scattered trees (§2 caveat). |
| RTE precision | `Core/EncodedCartesian3` + `translateRelativeToEye` shader pattern | Instance positions high/low (mandatory). |

**V1's genuinely-new code** (everything else above is reuse): the scatter compute kernel + region lifecycle + the Scene collection API + the CPU twin + the wind VS + the probe. This is why V1 is tractable — ~80% of the hard infra is already shipped.

---

## 4. Deterministic scatter algorithm (LOCKED — from GoT §1.1 + HZD §1.2)

Per region, in `VegetationScatter.wgsl`, one thread per candidate cell:

1. `cellId = globalInvocationId.xy` over an N×N grid of the region rectangle. **256×256 = 65,536 candidates = exactly one culler batch** (the V1 cap).
2. `h = pcg3d(cellId.x, cellId.y, seed)` — **PCG/xorshift integer hash, never runtime RNG state** (HZD determinism rule). All downstream randomness (jitter, species, scale, yaw, wind phase, threshold) derives from `h`.
3. Position = cell center + `jitter(h) × cellSize` (GoT jittered grid — **no Poisson relaxation**).
4. Sample density texture (R8) at cell UV → `accept if density > threshold(h)` (HZD dither-threshold; V1 threshold = hash-uniform, one-line upgrade to tiled blue-noise later).
5. Sample heightmap → height + finite-difference slope; reject slope > `maxSlope` (default 30°) or altitude out of range.
6. Species pick = weighted from `h` (V1: fixed ≤4-species weights on the collection).
7. Emit via `atomicAdd` compaction into the 48-byte SOA buffer (§1.5).
8. CPU twin runs the byte-identical tree (same PCG in JS) → WebGL2 path + the probe's determinism oracle.

---

## 5. License-clean starter assets (VERIFIED CC0)

All three candidate sources re-verified **verbatim** in the R-VEGETATION lane (two independent passes). **All CC0 (public-domain-equivalent): no copyleft, no share-alike, no attribution obligation, redistribution permitted — all safe to vendor and redistribute inside the fork.**

- **Quaternius — PRIMARY PICK.** "All models are under the CC0 License" / usable "even for commercial purposes" without attribution (quaternius.com/faq.html). Ships **glTF natively** → zero conversion for Cesium's Model loader. **Stylized Nature MegaKit** (110+ models: 40 trees, 35 plants, grass, bushes) or **Ultimate Stylized Nature Pack** (60+, explicitly ships glTF + normal maps). *(Caveat: the Ultimate **Nature** Pack — 150 models — is FBX/OBJ/Blend only, no glTF; use the two Stylized packs.)*
- **Kenney — low-poly backup.** "all game assets on the asset pages are public domain licensed (CC0)" (kenney.nl/support). Nature Kit = 330 low-poly models. Verify glTF presence in the downloaded zip (some kits ship OBJ/FBX only; OBJ→glTF is trivial).
- **Poly Haven — texture-only upgrade path.** "licensed as CC0, which is effectively Public Domain" / commercial OK / no attribution / redistribution OK (polyhaven.com/license). **BUT its tree MODELS are 150K–17.4M-poly photoscans — unusable for instanced scatter.** Use only its CC0 ground/grass **textures** for the far-field detail-albedo tier (V2+).

**V1 starter set (≤5 MB, `Apps/SampleData/models/vegetation/` + verbatim `LICENSES.md`):** 1 conifer + 1 broadleaf + 1 dead/birch tree (the dead tree doubles as the "no-alpha-test = early-Z control" perf reference) + 1 grass clump (or 2 crossed in-code quads with a Poly Haven CC0 grass albedo — the zero-asset-risk fallback). **Re-verify the license file *inside* each downloaded zip at vendor time** and quote it in `LICENSES.md` as the artifact of record.

*(Rejected: Poly Haven tree models (polycount); SpeedTree samples (proprietary EULA); Sketchfab "free" (mixed CC-BY/NC); OpenGameArt (mixed license, mirror-provenance risk). wojtekpil Godot Octahedral Impostors is MIT — safe to study if/when impostor code is ported in V3.)*

---

## 6. Pitfalls (carry into the V1-CORE brief)

1. **Determinism leaks:** any f32 transcendental mismatch between WGSL and the JS twin breaks bit-equality. Keep the twin to hash + multiply-add (PCG is integer-exact). Do height sampling on CPU-prepared data, or accept position-only bit-equality and diff height with an epsilon.
2. **RTE encode in compute:** WGSL has no f64. High part on CPU (region origin), only the f32 offset on GPU. Never split doubles in the shader.
3. **Atomic-compaction order is non-deterministic** — instance *order* differs run-to-run even when the *set* is identical. Key `featureId` off `cellId`, never buffer index; the probe's bit-equality oracle must **sort by featureId first**.
4. **Alpha-test discard disables early-Z** on some tilers — keep grass cards in a **separate pipeline** from opaque trunks; the dead-tree (no alpha-test) species is the perf control.
5. **CSM cast list** — register scattered instances in `WebGPUShadowMapRenderer.js` cast gathering or trees float shadowless (grass-card exclusion is fine, GoT precedent).
6. **`maxObjects` vs density** — 65,536 candidates over 256² at 1 km² = ~3.9 m spacing: right for trees, far too sparse for per-blade grass. V1 grass = clumps as a "species" sharing tree scatter; dense per-blade grass is V5.

---

## 7. Scope cutline — what is OUT of V1 (deferred, with owners)

Deferred per CLAUDE.md Principle 9 (name each explicitly as future work; already tracked in `VEGETATION_SYSTEM_DESIGN.md` §8 and `FEATURE_INVENTORY.md`):

- **Mesh-LOD chain + hysteresis** → V2.
- **Octahedral impostor bake/sample** (`FEAT-GAP-07`) → V3 (study wojtekpil MIT baker + Shaderbits 3-frame parallax blend).
- **Bézier-blade grass** (GoT 15/7-vert cubic-Bézier, G0 tier) → V5.
- **Hi-Z occlusion wiring** → V5.
- **VegetationPBR shader define bits** (`VEGETATION_WIND`/`_TRANSLUCENCY`/`_AO`/`_IMPOSTOR`/`_A2C`), two-sided leaf translucency, detail-bending wind → V4.
- **Footprint-class suppression, palette JSON, biome/landcover datasets** (ESA WorldCover, Köppen), GeoJSON overrides, tile-lifecycle scatter, `3DTILES_vegetation_scatter` namespace → V2+ / data-pipeline.
- **GPU sort + render bundles** → V6.
- **Per-instance pick plumbing beyond stable featureIds** → V2 (but reserve the `featureId` slot in the V1 layout now — done, §1.5).

**Inventory move when V1-CORE starts:** `FEATURE_INVENTORY.md` §D → §C for the vegetation-scatter row (`FEAT-SURVEY-43` partial).

---

## 8. Scope-lock checklist (all resolved)

| # | Decision | Verdict |
|---|---|---|
| 1 | GPU-cull-gate routing | **`Pass.OPAQUE`** — inherits `gpuCullCommands()` (live-code evidence §2). |
| 2 | V1 instance cap | **65,536** = one `WebGPUGPUCuller` batch (no multi-dispatch). |
| 3 | Scatter algorithm | **Jittered grid + PCG hash + dither-threshold. NOT Poisson.** |
| 4 | Starter set + vendoring | 3 Quaternius CC0 trees + 1 grass under `Apps/SampleData/models/vegetation/` + verbatim `LICENSES.md`. |
| 5 | Probe design | pixel-diff + GPU-vs-CPU-twin bit-equality (sort by featureId) + two-run determinism. |
| 6 | Substrate | Specialize `WebGPUComputeInstanceRenderer` (live, 1548 lines) — not from scratch. |
| 7 | Off-gate | Opt-in default-OFF ⇒ byte-identical (zero collections = zero dispatch). |

**V1-CORE is unblocked.** All open decisions are pinned; all assumed infra is confirmed live; the asset licenses are clean. Implementation is NOT part of this campaign (queue: "only implement V1-CORE if the campaign commits to vegetation").
