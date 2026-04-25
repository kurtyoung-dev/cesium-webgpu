# Migration Oversight Audit — 2026-04-25

**Reviewer posture:** Read-only oversight on the parallel C-R7/C-R9/C-R10/C-R11 workstreams. Spot-checks against the principal review (`PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md`), `REVIEW_FIX_PROGRESS.md` (Batches 1–52), and live source under `packages/engine/Source/Renderer/WebGPU/`.

---

## 1. Truthful state assessment

**Honest closures (verified against code):**

- **C-R2 (derived-command dispatcher)** — `selectCommandVariant` exists in `WebGPUSceneRenderer.ts` and is wired into both `executeWebGPUCommand` and `_executePickBatch`. Matches the documented FIXED status.
- **C-R3 (translucent back-to-front sort)** — Grep for `CommandSorter|backToFront` returns `WebGPUSceneRenderer.ts` only; the documented import + delegation is in place.
- **C-R7 infrastructure** — `WebGPUContext.webgpuPipelineCache` getter at lines 3924–3937 lazy-instantiates and subscribes to `onDeviceInvalidated`; `_clearAllCaches` calls `.clear()` at line 4140. Matches Batch 52's status correction.
- **C-R8 (scene passes + edges + translucent tile classification first cut)** — `WebGPUTranslucentTileClassification.ts` exists; `WebGPUEdgeComposite.ts` is deleted (verified `ls` failure); `applyEdgeOverlay` appears in `ModelPBRComplete.wgsl` (5 grep hits). Matches the cumulative FIXED status from Batches 35–51.
- **C-R12 (device-loss invalidation event)** — `onDeviceInvalidated` virtual on `GraphicsContext.ts` + subscriber registry on `WebGPUContext.ts`. Matches FIXED.
- **C-R13 (destroy order)** — Code review against the cited line range confirms subsystem destroy moved before `_device.destroy()`.

**Stale "OPEN" claims (the Batch 52 pattern, repeating):**

- **C-R9-MODEL-PICK is effectively done in code, but the principal review still says it is open and "needs KHR feature-ID integration."** `WebGPUModelRenderer.js:1062` allocates a `CesiumPickId` per primitive; `:1254-1265` builds a pick command via `pipelineCache.getPickPipeline(alphaMode, doubleSided)` and wires it onto `cache.command.derivedCommands.picking.pickCommand`. `WebGPUModelPipelineCache.js:622` defines `getPickPipeline`. The "C-R9-MODEL-FEATURE-PICK" comment in the source acknowledges that *per-feature* pick (one target per `EXT_mesh_features` feature) is the **larger** workstream, but per-primitive pick — which is what `scene.pick()` returns — is shipping. The principal review entry C-R9 (lines 213–231) still treats Model pick as a multi-session blocker. **This is the Batch 52 problem repeating.**
- **C-R9-VOXEL-PICK has 14 references to `createPickId`/`pickColor` in `WebGPUVoxelRenderer.ts`**, including a "Batch 53" provenance comment at line 480. That suggests work landed past the documented Batch 52. The principal review still lists Voxel pick as open.
- **C-R7-RENDERER-MIGRATION partial progress** — `WebGPUShaderModuleCache` is consumed by 5 renderers (`WebGPUPolylineRenderer.js`, `WebGPUPointPrimitiveRenderer.js`, `WebGPUBillboardRenderer.js`, `WebGPULabelRenderer.js`, `WebGPUGlobeSurfaceRenderer.ts`). The collection-renderer half of the migration is well underway, but the doc still reads as if no renderer routes through shared infra.

**Honest deferrals (no code change, doc accurate):**

- **C-R1 per-renderer renderState fan-out** — `command.renderState` grep returns 3 files (`WebGPUModelRenderer.js`, `RenderStateToPipelineVariant.ts`, `WebGPURenderPipelineCache.ts`); the foundation is in place, but per-renderer adoption is partial.
- **C-R4 glTF KHR extensions, C-R5 imagery layer count, C-R10 receive shader** — accurately reported as open.

---

## 2. Risk inventory

**Highest-impact unfixed correctness bug:** **C-R5 (imagery layer cap fixed at 4).** `GlobeTerrain.wgsl:86` still hard-codes `layers: array<ImageryLayer, 4>`. Apps that mix Bing + labels + weather + political-boundary overlays silently drop layer #5 with no console warning. Combined with the missing per-layer hue/gamma/split/cutout uniforms, this is a class of "looks fine, is wrong" output that costs the migration parity claim. Bounded fix (widen to 16, add the 5 missing uniforms). High user surface area, low engineering risk.

**Highest-impact unfixed performance issue:** **C-R11-EFFECTS-BGL-COLLECTION-CACHE (per-tile clipping plane bind groups).** `WebGPUEffectsBindGroup.js:776–790` creates a fresh 304-byte `GPUBuffer` and a fresh `GPUBindGroup` on every call. With 200 globe tiles × 60 Hz this is ≈ 12,000 buffers/sec + 12,000 bind groups/sec when clipping planes are active. The Batch 31/32 identity cache cannot apply (UBO content varies per tile), so this is the dominant outstanding allocation hot path — well above the Bloom/AO/DoF lines that Batches 31–32 already fixed. Active C-R11-EFFECTS-BGL-COLLECTION-CACHE work is the right priority.

**Longest-running quietly-piling-up debt:** **C-R4 glTF KHR extensions** (deferred 2026-04-16, still untouched 9 days later). `KHR_texture_transform` alone is in nearly every production glTF; `ModelPBRComplete.wgsl` still uses raw `texCoord0` at the cited 10 sample sites. Six orphaned `Model*Stage.wgsl` files sit on disk imported by nothing — code-hygiene smell that gives a false impression of coverage. This is a multi-session workstream that nobody is currently picking up while easier C-R items get attention.

---

## 3. Cross-cutting issues

**Shader module sharing (C-R7-SHADER-MODULE-DEDUP).** Already partially landed — `WebGPUShaderModuleCache` is a real module consumed by 5 collection/globe renderers. It does NOT block per-renderer pipeline-cache routing (Batches 31/32 already prove the identity-cache pattern works against per-renderer pipeline maps). The dedup wins are real but not on the critical path.

**`any` ban (CLAUDE.md):** **One violation found.** `WebGPUPointCloudRenderer.ts` line 625 has a `: any` type annotation. This needs a typed-interface follow-up.

**Pragma stripping discipline:** **Unwrapped per-tile diagnostic console.log block at `WebGPUGlobeSurfaceRenderer.ts:1265–1310`.** The `BUG-11 imagery probe` block is gated behind `frameState.debugShowImageryProbe === true` (off by default) but is **not** wrapped in `//>>includeStart('debug', pragmas.debug)`. Per CLAUDE.md, per-tile diagnostics MUST be pragma-wrapped because the runtime cost (string interpolation, `.toFixed()`, object stringification) reaches production builds. Same file does pragma-wrap correctly elsewhere (lines 282, 2065, 2101, 2497, 2552, 2578), so this is a localized lapse. Fix: wrap lines 1259 (the `if (probeOn && this._diagTileCount <= 4)` block) through 1311 in the pragma pair.

**Backend-agnosticism:** **Clean.** Grep for `from "../Renderer/WebGPU/"` from `Scene/` returns zero hits. The 6 files that read `context.isWebGPU` (`Scene.js`, `CesiumDebug.js`, `Model.js:3142`, `ViewportQuad.js:135`, `SceneDebug.js`, `FramebufferOrchestrator.js`) are either justified backend selection points (FramebufferOrchestrator picks render-target shape based on backend), debug-label-only (SceneDebug, CesiumDebug), or legacy guards (Model.js gates the legacy `pushDrawCommands` path). No new violations.

---

## 4. Documentation health

**Inconsistencies between docs and code:**

- `PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md` C-R9 entry (lines 213–231) is stale — Model pick is shipping in code; Voxel pick has a "Batch 53" provenance comment in the source that doesn't appear anywhere in `REVIEW_FIX_PROGRESS.md` (which stops at Batch 52).
- `WEBGPU_MIGRATION_BACKLOG.md` last-updated header reads "April 18, 2026 (Sessions 33 + 34 + ..., Principal-engineer review Batches 6-27 landed)". The actual progress log goes through Batch 52 with substantial C-R8/C-R9/C-R11 work. The backlog top-line is one full architectural session out of date.
- `WEBGPU_MIGRATION_STATUS.md` last-updated header reads "April 19, 2026 (Session 35 landed)" — also stale. The principal-engineer review-fix work between Batches 28 and 52 (over 25 batches, 9 days) has not been rolled up.
- `NEXT_SESSION_HANDOFF.md` is from 2026-04-20; not yet refreshed for the Batch 28–52 review-fix work or the 5 active parallel agents.

**No stale references to deleted files** — `WebGPUEdgeComposite` mentions in `migration_doc/` are all historical (Batch 44 creation, Batch 50 deletion). Clean.

**Recommendation:** A single doc-rollup pass (≤30 min) updating the three "last updated" headers + adding a Batch 28–52 cumulative summary to `WEBGPU_MIGRATION_STATUS.md` would close the gap. The Batch 52 audit pattern (verify code matches doc claims, correct the doc) should be applied to C-R9 before the next migration claim is published.

---

## 5. Recommended priorities (next 3 batches)

1. **Doc reconciliation + C-R9 audit-correction.** Apply the Batch 52 pattern to C-R9: verify Model pick + Voxel pick end-to-end (the code is there; the test is whether `scene.pick()` actually round-trips against a glTF model and a voxel primitive in a Sandcastle demo). Update the principal review entry to reflect "MOSTLY FIXED" with Model per-feature pick (`C-R9-MODEL-FEATURE-PICK`) as the only remaining open item. Update the three migration doc headers. Estimated 1–2 hours; high information value, zero risk.

2. **C-R5 imagery layer cap widen (4 → 16).** Single shader edit + CPU packer + 5 missing per-layer uniforms (hue/gamma/split/cutout/colorToAlpha). Bounded; the WebGPU minimum guarantee for `maxSampledTexturesPerShaderStage = 16` makes 16 the correct target. Closes a "looks fine, is wrong" class of bug that hits real production tilesets. Estimated 1–2 days.

3. **C-R11-EFFECTS-BGL-COLLECTION-CACHE (per-tile clipping plane cache).** This is the largest remaining allocation hot path — ≈ 12k bind groups/sec when clipping is active. Two-tier cache: per-collection UBO (one per `ClippingPlaneCollection`, written once per frame with the camera pose) + per-(collection, tile) BG. Already on the active-agent list; just confirming priority order. Estimated 2–3 hours.

A natural fourth slot if capacity allows: **the `WebGPUPointCloudRenderer.ts:625` `any` violation** + **the `WebGPUGlobeSurfaceRenderer.ts:1265–1310` unwrapped-pragma block.** Trivial fixes, prevents the patterns from spreading.

---

## 6. Discoveries

**Pattern needing extracting into shared infrastructure:** Multiple feature renderers now follow the **same pick-pattern recipe** — UBO `pickColor: vec4<f32>` slot, `fragmentPickMain` WGSL entry, pick pipeline sharing layout + VS, `createPickId` lifecycle with id-change invalidation, derivedCommands.picking.pickCommand wiring. Ellipsoid (Batch 30), Ground + Splat (Batch 31), Voxel (Batch 53?), Model (undocumented batch). This is a **codified pattern** that should live in a shared helper file (`WebGPUPickCommandHelpers.ts`) rather than getting copy-pasted into each renderer. Five copies of effectively the same lifecycle code is the threshold where extraction pays for itself.

**Architecture decision that should be documented:** The **identity-based vs content-based bind-group cache split** (Batch 31/32 vs the deferred per-tile EffectsBindGroup work) is a non-obvious lesson — identity caches work for stable inputs, content caches need a different shape entirely. This belongs in CLAUDE.md or a dedicated `WEBGPU_CACHE_PATTERNS.md` so future renderer authors reach for the right tool.

**Risk not currently tracked:** **Per-tile UBO buffer pressure.** Even after C-R11-EFFECTS-BGL-COLLECTION-CACHE lands, the `WebGPUEffectsBindGroup.js:425` `csmParamsPlaceholder` and `:776` per-call effects UBO are separate allocations. If the migration hits a tileset with 1000+ visible tiles per frame, the cumulative driver-side allocation cost may exceed 60 Hz capacity even with the bind-group cache. Worth a one-off measurement against `Tools/visual-regression` after Batch 53 lands.

**Documentation drift cadence concern:** Batch 52 explicitly called out C-R7 doc drift; Batch 53 (undocumented in `REVIEW_FIX_PROGRESS.md` but referenced in source) appears to have shipped C-R9 Model + Voxel pick without a corresponding doc update. This is becoming a **systematic** problem — work landing in code faster than the doc roll-up cadence. Consider a per-batch lightweight checkpoint (a 2-line addition to `REVIEW_FIX_PROGRESS.md` even when no full writeup is feasible) so the doc-vs-code gap stays bounded.

---

## Appendix: spot-check verifications

| Claim | Verified by | Result |
|---|---|---|
| C-R3 sort wired | `Grep CommandSorter` in `Renderer/WebGPU/` | 1 file (`WebGPUSceneRenderer.ts`) — matches doc |
| C-R2 dispatcher wired | `Grep selectCommandVariant\|derivedCommands\.X` | 3 files — dispatcher + 2 consumers — matches doc |
| `webgpuPipelineCache` instantiated | `Grep webgpuPipelineCache` in `WebGPUContext.ts` | Lines 312/3924/3925/3933/3936/4140 — matches Batch 52 |
| `WebGPUEdgeComposite` deleted | `ls WebGPUEdgeComposite.ts` | File not found — matches Batch 50 |
| `applyEdgeOverlay` in model FS | `Grep applyEdgeOverlay` in `ModelPBRComplete.wgsl` | 5 hits — matches Batch 48 |
| C-R9 Model pick | `Grep _pickId\|createPickId\|getPickPipeline` in `WebGPUModelRenderer.js` | 4 hits including `pickPipeline` builder + `derivedCommands.picking.pickCommand` wire — **doc says open, code says closed** |
| C-R9 Voxel pick | `Grep createPickId\|_pickId\|pickColor` in `WebGPUVoxelRenderer.ts` | 14+ hits incl. "Batch 53" provenance — **doc says open, code says closed** |
| `any` ban | `Grep ": any\b"` in `Renderer/WebGPU/*.ts` | 1 violation in `WebGPUPointCloudRenderer.ts:625` |
| Pragma discipline | Read `WebGPUGlobeSurfaceRenderer.ts:1259–1311` | Unwrapped per-tile probe — violation |
| Scene → WebGPU import | `Grep "from .Renderer/WebGPU/" Scene/` | Zero hits — clean |
| Scene `isWebGPU` branches | `Grep isWebGPU` in `Scene/` | 6 files; all justified |

*Audit completed 2026-04-25 by oversight agent. Methodology: read principal review + Batches 28–52 of REVIEW_FIX_PROGRESS in order; spot-check 11 specific claims against current source via Grep + Read; report mismatches.*
