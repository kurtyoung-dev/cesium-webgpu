# Verification — `audits/2026-04-30_FORK_FEATURE_INVENTORY.md`

**Document under review:** `migration_doc/audits/2026-04-30_FORK_FEATURE_INVENTORY.md` (Batch 116 snapshot, 2026-04-30)
**Prior judgement verified:** `2026-04-30_FORK_FEATURE_INVENTORY.judgement.json` (58 items; 3 STILL-VALID, 10 PARTIAL, 45 RESOLVED/SUPERSEDED/STALE)
**Verifier:** Atanatar
**Date:** 2026-09-03 (tree at Batch 1390, `532463ae35`)

## Counts

| Outcome                | Count |
| ---------------------- | ----- |
| CONFIRMED              | 6     |
| CORRECTED              | 5     |
| REFUTED                | 2     |
| UNADJUDICATED          | 0     |
| Spot-checks performed  | 5     |
| Spot-check reversals   | 1     |

Every STILL-VALID and PARTIAL item was reached and adjudicated. All line numbers below were read in
this session against HEAD; the judgement's citations were treated as leads, not premises.

## 1. Still-valid / partial items

| id  | title                                                                                     | verdict       | current file:line                                                                                                                                                                                                                                                     | owning row                                                                                                | migrate text                                                                                                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D4  | RenderCommand adopted by 3 Scene files vs 25 constructing DrawCommand — migrate or deprecate | **CONFIRMED** | `Scene/RenderCommand.js` consumed only by `ClassificationPrimitive.js`, `GroundPrimitive.js`, `QuadtreePrimitive.js`; 25 Scene files call `new DrawCommand(`; `FEATURE_INVENTORY.md:512` tags it SCAFFOLDED / UNUSED                                                     | none — `C11-24` (`QUEUE_2026-07-18_CAMPAIGN11.md:2450`, `DEFERRED_WORK.md:10145`) fixed only the pass slot | As judged. No row decides migrate-vs-deprecate; the frame-graph lens should rule rather than let both command paths persist.                                                                                                                                                                                                                                        |
| D5  | Residual `context.isWebGPU` branches in Scene                                               | **CORRECTED** | exactly four: `GlobeSurfaceShaderSet.js:1117`, `OceanSurfacePrimitive.js:384` and `:502`, `ViewportQuad.js:144` (plus the `Scene.js:2793` getter and debug-only sites)                                                                                                  | **yes** — `DEFERRED_WORK.md:4867` and `:4868`                                                             | see §2                                                                                                                                                                                                                                                                                                                                                             |
| I4  | Shader-module prewarm gaps; Model outside the shared module cache                           | **CORRECTED** | prewarm callers: `WebGPUBillboardRenderer.js:628`/`:635`, `WebGPUGlobeSurfaceShaders.ts:129`, `WebGPULabelRenderer.js:442`, `WebGPUPointPrimitiveRenderer.js:691`/`:697`, `WebGPUPolylineRenderer.js:978`/`:982`, `WebGPUSceneRendererEnsureResources.ts:535`/`:554`/`:567` | `FEATURE_INVENTORY.md:1212` (Phase-8a shader-variant strategy + prewarm)                                  | see §2                                                                                                                                                                                                                                                                                                                                                             |
| B1  | Build-variant exemption-list drift; BUILD-VAR-MEASURE stale                                 | **CORRECTED** | `scripts/bundleVariantPlugin.js:276-286` lists **five** exemptions; `CLAUDE.md:437` still says four                                                                                                                                                                     | `WEBGPU_MIGRATION_BACKLOG.md:319`, `FEATURE_INVENTORY.md:1129`                                            | see §2                                                                                                                                                                                                                                                                                                                                                             |
| B3  | Pragma linter exists but is not a gate                                                      | **REFUTED**   | `.github/workflows/dev.yml:80-81` runs `npm run lint-debug-pragmas` in the `guards` job (Batch 1211, `e9fdca9838`)                                                                                                                                                      | the CI `guards` job                                                                                       | see §2                                                                                                                                                                                                                                                                                                                                                             |
| R1  | Globe renderer 3,933 lines with no decomposition row; FEAT-GAP-09 LUT rollout                | **CORRECTED** | `WebGPUGlobeSurfaceRenderer.ts` = **3,080** lines; `QUEUE_2026-08-29_RESEARCH_DISPATCH.md:952` (`DX-10`) names "globe surface after the `Q120` owner"                                                                                                                   | **yes** — `DX-10` (HELD)                                                                                  | see §2                                                                                                                                                                                                                                                                                                                                                             |
| R2  | KHR extension bodies + Model outside the central caches; doc conflict                        | **CONFIRMED** | `ModelPBRComplete.wgsl` (4,325 lines) carries clearcoat/specular/anisotropy/iridescence/sheen/volume/transmission branches; `DEFERRED_WORK.md:5210-5236` closes `C-R4-GLTF-KHR` while `FORK_OVERVIEW.md:101`/`:153`/`:248` and `FEATURE_INVENTORY.md:1245-1248` gate them | `DX-07` for the split; `FEAT-SURVEY-02/03/04` for the bodies; **no row owns the drift**                   | The `C-R4-GLTF-KHR` closure and the `FEAT-SURVEY-02/03/04` + `FORK_OVERVIEW` §5.3 gating statements contradict each other at HEAD; the glTF lens must reconcile which is current. A second drift in the same sentence: `FORK_OVERVIEW.md:153` sizes `WebGPUModelRenderer` at "~2300 LOC" against 9,284 lines today.                                                    |
| R7  | TAA residuals untracked (tiles pop-in NaN motion, CSM+TAA verification)                     | **REFUTED**   | `FEATURE_INVENTORY.md:1021` tracks the 3D-Tiles pop-in motion-vector NaN reject; `:1078` tracks CSM+TAA shadow-edge motion verification; `:1056` tracks pick un-jitter; `Scene.js:1321` still defaults `taaEnabled` false                                                | all three are TAA-DESIGN rows in `FEATURE_INVENTORY.md`                                                   | see §2                                                                                                                                                                                                                                                                                                                                                             |
| R8  | f16 tonemap "auto-fallback" does not exist; the error scope wraps nothing                    | **CONFIRMED** | `WebGPUPostProcessPipeline.ts:2119-2122` creates the f16 module, `:2124-2126` push/pop a validation scope with no GPU work between, `:2136-2141` only logs; `fallbackWgslCode` appears at `:2096` and `:2124` only                                                      | none                                                                                                      | The f16 auto-fallback claim was refuted by the 2026-06-11 review (A8.8) and is still wrong at HEAD. `_compileStage` creates the f16 shader module **before** `pushErrorScope('validation')` and pops the scope immediately, so a rejected module is only logged; `fallbackWgslCode` is a truthiness gate and the f32 source is never compiled or selected. File as a DEFECT (opt-in feature, low severity), or fix by selecting f32 up front when the device lacks `shader-f16`. |
| R14 | PointCloud translucent classification residue                                               | **CONFIRMED** | `WebGPUPointCloudRenderer.ts` contains no classification handling at all; the residue survives only inside struck ledger text at `DEFERRED_WORK.md:7581`                                                                                                                | none — `C18-P2` covers colour-format decode/translucency, not classification depth-write                  | The depth-sampling classifier shipped (Batches 80-85) but translucent PointCloud tiles still have no classification depth-write variant. The mechanism now exists — `WebGPUDrawCommand.ts:240`/`:394`/`:627` carries `classificationDepthPipeline` and `WebGPUGaussianSplatRenderer.ts:2838` consumes it — so this is a wiring gap, not an architecture gap. Confirm with a probe or file under C18 Wave P. |
| R16 | Vector3DTilePrimitive residual gaps                                                         | **CONFIRMED** | `WebGPUVector3DTilePrimitiveRenderer.js:37-49` — pick containment (`:37-44`), SCENE2D/CV stencil coverage (`:45-46`), normal-from-depth-derivative + textured appearance (`:47`), `debugWireframe` LINES variant (`:48-49`)                                              | none (renderer docstring only)                                                                            | As judged, plus a **fourth** item the judgement missed: pick containment — the pick path uses the depth-sample `pickFS`, so a pick hits the inflated projected silhouette rather than the stencil-clipped surface∩volume region. File all four; the docstring is the only record.                                                                                    |
| R17 | Vector3DTileClampedPolylines single depth source per frame                                  | **CONFIRMED** | `WebGPUVector3DTileClampedPolylinesRenderer.js:40-44` (docstring), single `globeDepthTex` binding at `:168`, resolver at `:1258-1261` and `:1296`                                                                                                                        | none (renderer docstring only)                                                                            | As judged, plus a second residual in the same docstring: the CESIUM_3D_TILE command "currently binds `Pass.CESIUM_3D_TILE`" instead of the intended `Pass.CESIUM_3D_TILE_CLASSIFICATION`. Confirm with a mixed terrain+tileset probe and file both.                                                                                                                  |
| X1  | Central pipeline cache half-adopted; Model module dedup partial                             | **CORRECTED** | `WebGPUModelPipelineCache.ts:2150-2155` and `:3449` route only the on-screen colour pipeline through the central cache; **13** direct `device.createRenderPipeline` hatches remain (`:979` … `:1977`)                                                                    | `FEATURE_INVENTORY.md:1128` (already says "re-scope this row before working it")                          | see §2                                                                                                                                                                                                                                                                                                                                                             |

## 2. Corrected and refuted items — the corrected text

**D5 — CORRECTED.** The four branches are confirmed at HEAD, but "no live row for the four residual
sites" is wrong. `DEFERRED_WORK.md:4868` (`NEW-MATERIAL-PER-BACKEND-SHADER-SOURCE`) owns
`ViewportQuad.js:144` explicitly and names the fix (a per-backend `Material.getShaderSource` /
`getUniformMap` virtual); `:4867` (`NEW-CAPABILITY-GETTER-CODIFY`, Batch 303) codifies the
convention and classifies the permitted categories. The live finding is a different one: **that
row's own verification claim is stale.** It asserts "grep of `Source/Scene` shows no remaining
`isWebGPU`/`rendererType===` branch in rendering logic except the ViewportQuad blocker", yet
`GlobeSurfaceShaderSet.js:1117` (forces the non-parallel shader path on WebGPU) and
`OceanSurfacePrimitive.js:384`/`:502` (WebGPU-only primitive no-ops on WebGL) exist today. Migrate
as: re-verify `NEW-CAPABILITY-GETTER-CODIFY`, and either sanction the two re-accreted sites as
capability gates or convert them.

**I4 — CORRECTED.** The prewarm gap is real: Cloud, Voxel, VolumetricFog, PointCloud and Model all
still compile on first use, and only the five collection renderers plus the deterministic
depth-plane prewarm. But the premise that Model "keeps its own module Map outside
`WebGPUShaderModuleCache`" is wrong. `WebGPUModelPipelineCache.ts:190-202` holds a per-`GPUDevice`
`WebGPUShaderModuleCache` in a `WeakMap`, and `:2808` resolves every module through its
`getOrCreate`; the `_shaderModuleCache` `Map` at `:2067`/`:2801-2823` is a local memo in front of
it, keyed by `composed.moduleKey`. **This is the universal pattern in the codebase** — twenty
renderers construct their own per-device `WebGPUShaderModuleCache` the same way
(`WebGPUCollectionRendererBase.ts:477`, `WebGPUGaussianSplatRenderer.ts:1019`,
`WebGPUPointCloudRenderer.ts:72`, and seventeen more). There is no shared central instance for
Model to be outside of. Migrate only the prewarm half, and correct the FI citation to `:1212`.

**B1 — CORRECTED.** The drift is confirmed: `scripts/bundleVariantPlugin.js:276-286` lists five
exemptions (adding `WebGPUModelMetadata`, Batch 457) while `CLAUDE.md:437` still names four. But
"the BUILD-VAR-MEASURE row should close" overreaches. `WEBGPU_MIGRATION_BACKLOG.md:319` asks for
minified **and gzipped** sizes for `Cesium.js` (IIFE), `index.js` (ESM entry) **and each split
chunk** across all three variants; CLAUDE.md records only the minified IIFE figures
(7.1 / 5.6 / 6.4 MB). The row is partially satisfied, not closeable. Migrate as: file the CLAUDE.md
exemption-list drift, and re-scope BUILD-VAR-MEASURE to the measurements CLAUDE.md does not carry.

**B3 — REFUTED.** The claim "not wired into lint-staged or any pre-commit/CI step at HEAD" is
false. `.github/workflows/dev.yml:80-81` runs `npm run lint-debug-pragmas` as a step of the
`guards` job — landed at Batch 1211 (`e9fdca9838`, "nine guards that were green for months without
CI ever running one get a job"). The prior auditor grepped only `lint-staged.config.js` and
`.husky/`. Pragma discipline **is** mechanically enforced. The only surviving nuance, which does not
need this document to record it: `Tools/lint-debug-pragmas.mjs:27-34` scans
`packages/engine/Source/Renderer/WebGPU` only, so Scene-side sites are out of scope — already held
as `FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md` fleet1 rows.

**R1 — CORRECTED, twice.** (a) `WebGPUGlobeSurfaceRenderer.ts` is 3,080 lines, but the claim that no
DX row covers it is wrong: `DX-10` (`QUEUE_2026-08-29_RESEARCH_DISPATCH.md:952`) is "decompose the
pipeline cache + six remaining >1,000-line renderers", HELD, "one row per file", and its disposition
names "globe surface after the `Q120` owner" verbatim. (b) The FEAT-GAP-09 figure is materially
stale in the **inventory**, not just in this audit. Counted at HEAD: **34 of 60**
`Shaders/WebGPU/Primitive/*.wgsl` live-consume the LUT (branching on
`effects.atmosphereLutControl.x > 0.5`), against `FEATURE_INVENTORY.md:932`/`:1082`, which still say
"12 of ~44 … ~32 remaining" and list as remaining several shaders that are wired today
(`PrimitiveMatAspectRampFlat`, `PrimitiveMatCheckerFlat`, `PrimitiveMatAlphaMapFlat`,
`PrimitiveMatElevRampFlat`, and others). The genuine remainder is 20 files: 7 `Polyline*`,
`PrimitiveDepthFailColor`, and 12 `Mat*Lit` variants; the 6 `PrimitivePick*` shaders are excluded by
design. Migrate as: refresh `FEATURE_INVENTORY.md:932`/`:1082` to the measured 34/60 and decide
whether the `Mat*Lit` tail is an accepted end state.

**R7 — REFUTED.** Both "no row" claims are false. `FEATURE_INVENTORY.md:1021` — "3D Tiles tile
pop-in motion-vector NaN reject for TAA disocclusion deferred to TAA Slice 4 (TAA-DESIGN)".
`FEATURE_INVENTORY.md:1078` — "TAA Slice 4 CSM+TAA shadow-edge motion correctness verification
pending (TAA-DESIGN)". The closed half is confirmed (`Scene/ViewTemporalHistory.js:105-127`
teleport / mode / projection invalidation → `UniformState.js:875-894` → `Scene.js:6541-6548`
`taa.resetHistory()`), and `Scene.js:1321` still defaults `taaEnabled` to false. Nothing in this
item needs migrating.

**X1 — CORRECTED.** The pipeline-cache half is confirmed and already owned: only the on-screen
colour pipeline resolves through the central cache (`WebGPUModelPipelineCache.ts:2150-2155`,
`:3449`), with 13 deliberate `device.createRenderPipeline` hatches for the snap/pick/velocity
variants — which is exactly what `FEATURE_INVENTORY.md:1128` already records, including the
instruction to re-scope the row before working it. The module-dedup half is **refuted** for the
reason given under I4. Nothing unique survives here.

## 3. Spot-checks of the RESOLVED / SUPERSEDED / STALE bucket

Five items were selected for the cost of their being wrong: correctness or parity claims, claimed
fixes resting on a ledger row rather than on code, and a "superseded by" pointing at a document that
had to be read to confirm it says what was claimed.

| id  | prior status | why selected                                                                                                                                              | verdict                                     |
| --- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| R24 | RESOLVED     | Hi-Z occlusion **consumer wiring** — a correctness/perf claim resolved on a ledger row, while the live dispatch queue lists FORK-41 as an open dependency  | **REVERSAL — see §4**                       |
| R23 | SUPERSEDED   | SSR sampling an uninitialized normal placeholder — a rendering-correctness claim                                                                            | **UPHELD**, with a confirmed comment defect |
| R15 | RESOLVED     | "polylines on terrain invisible on WebGPU" — a WebGL-parity visual-correctness claim                                                                       | **UPHELD**                                  |
| I9  | RESOLVED     | translucent model pick missing — a picking-parity claim                                                                                                    | **UPHELD**                                  |
| T2  | SUPERSEDED   | the composite-scaffold "must NOT be removed" instruction that CLAUDE.md §7 says inverted the ledger; the pointer document had to be read                    | **UPHELD**                                  |

**R23 — upheld.** `Shaders/WebGPU/PostProcess/ScreenSpaceReflections.wgsl:204-228` reconstructs the
surface normal from neighbour-pixel view positions whenever `ssr.flags.x < 0.5`, so the uninitialized
placeholder is never sampled; the real G-buffer is forwarded only under `useDeferredLighting`
(`WebGPUSceneRenderer.ts:3343-3346`). The judgement's own residual-drift note is **confirmed**:
`WebGPUSSREffect.ts:205-224` still carries a comment and a user-facing `console.warn` telling
operators that "SSR will sample an uninitialized placeholder and produce noise" — text that no longer
describes runtime behaviour. That is a Principle-10 comment defect worth filing; it does not restore
the original finding.

**R15 — upheld.** `WebGPUGroundPolylineRenderer.js:1311` documents and applies
`depthCompare: "always"`; the viewport / `metersPerPixel` NaN guard is described in the renderer's
own docstring at `:13-15` and enforced by `max(0.0, metersPerPixel(...))` at `:505`, `:608`, `:989`,
`:1007`, `:1140`. `DEFERRED_WORK.md:7666-7676` records the three-bug resolution at Batch 116/117. The
miter-joint hypothesis in the 2026-04-30 audit was never the cause.

**I9 — upheld.** `Scene.js:5187` `pickHoverAsync` and `:5224` `pickPreciseAsync` are both live and
documented as the dual path; `DEFERRED_WORK.md:7906` records Batch 186 (BLEND depth-write +
alpha-discard) and Batch 192 (the dual-path API, plus the architectural finding that a parallel
pick-OIT pipeline is not directly implementable in WebGPU). The original framing is superseded, not
merely closed.

**T2 — upheld, and the pointer checks out.** `WebGPUTranslucentTileClassification.ts:20-27` now
states the accumulation target and composite pipeline are retained deliberately and that "their
removal is a separate scoped cleanup" — the file agrees with the ledger's remove-later disposition,
not with the audit's "must NOT be removed".
`DX15_TRANSLUCENT_CLASSIFICATION_COMPOSITE_SCAFFOLD_REMOVAL_PREREGISTRATION_2026-08-30.md:1-30`
exists and says exactly what was claimed: an add-only alias for canonical `C11-107`, preregistration
only, HELD on an explicit Principle-7 sign-off — matching
`QUEUE_2026-08-29_RESEARCH_DISPATCH.md:174`.

## 4. REVERSALS

**One reversal, on R24 (Hi-Z occlusion consumer path).**

The judgement marked R24 RESOLVED, citing `DEFERRED_WORK.md:5338` — "FORK-41 — Hi-Z occlusion:
RESOLVED (C2-21, 2026-06-24) … command-drop now **DEFAULT ON**, verified". The code says otherwise:

- `WebGPUSceneRenderer.ts:1189` — `private _hiZConsumeEnabled: boolean = false;`
- `WebGPUSceneRenderer.ts:1191-1196` — "It remains disabled until result identity is tied to the
  producing frame, frustum, and command list."
- `WebGPUSceneRenderer.ts:4195-4198` — "Do not drop commands by default until each result identifies
  its producing frustum, frame, and command generation." followed by
  `if (!this._hiZConsumeEnabled) return commands;`

So the 2026-04-30 finding — Hi-Z occlusion is Alpha, the consumer path is not wired, the JS fallback
is authoritative — is **still true at HEAD in its operative sense**: no command is dropped by Hi-Z on
the default path.

Two consequences, and they point in different directions:

1. **The finding is tracked, so it does not by itself save this document.**
   `QUEUE_2026-07-18_CAMPAIGN11.md:1770` (`C11-98`, FORK-41, W7) owns it, and
   `QUEUE_2026-08-29_RESEARCH_DISPATCH.md:727-729` states the ownership explicitly — "FORK-41's Hi-Z
   consumer fix is **not** re-filed here … whoever lands FORK-41 discharges the prerequisite for
   both" (`MS-12` and `C18-A5`).
2. **A live ledger row is wrong, and that is the real finding.** `DEFERRED_WORK.md:5338` asserts a
   default-ON state that HEAD contradicts, while `QUEUE_2026-08-29_RESEARCH_DISPATCH.md:605`
   independently verified the opposite on 2026-08-29 ("Three containment switches, all default-off,
   all verified 2026-08-29: … FORK-41 Hi-Z command drop `WebGPUSceneRenderer.ts:1181`
   `_hiZConsumeEnabled = false`"). The `:5338` heading is the stale one; the superseded `:5365`
   PARTIAL entry below it describes the actual state better. **`DEFERRED_WORK.md:5338` should be
   corrected regardless of what happens to this audit** — it is exactly the kind of row a future
   brief would cite as a premise, which is the failure CLAUDE.md Principle 10 was written against.

## 5. Document verdict

**REMOVE-AFTER-MIGRATION** — with the corrected migrate texts in §1 and §2, not the judgement's
originals.

Reason: all thirteen still-valid/partial items are adjudicated and five of the resolved items were
re-derived against code. No section of this document is a live authority nothing else holds — its
maturity grades are folded into `FORK_OVERVIEW.md:4`/`:142`, its findings into
`ISSUES_AND_FIXED_BUGS.md:2`, and every inbound reference in the judgement's `inbound_refs` is a
supersession note, a historical line-anchored citation, or a `CLAUDE.md` / `README.md` pointer that
repoints to `FORK_OVERVIEW` §5 / `FEATURE_INVENTORY` §C-§D / the 2026-09-02 review. The document
defines no ids and nothing links to a section anchor inside it.

The content that must actually survive removal is narrower than the judgement claimed — B3, R7 and
half of X1 carry nothing, and D5, I4, B1, R1 need their corrected texts — but four findings are
genuinely orphaned and must be filed before this file goes:

- **R8** — the f16 tonemap fallback is a validation scope wrapping no work
  (`WebGPUPostProcessPipeline.ts:2119-2142`). No row.
- **R14** — translucent PointCloud classification has no depth-write variant; the mechanism exists
  and is unwired. No row.
- **R16** — four unshipped Vector3DTilePrimitive behaviours recorded only in a renderer docstring.
- **R17** — one depth source per frame for both classification passes, plus a pass-enum drift,
  recorded only in a renderer docstring.

Five corrections belong with them, none of which needs this document to survive: the `CLAUDE.md:437`
exemption-list drift (B1); the `FEATURE_INVENTORY.md:932`/`:1082` FEAT-GAP-09 undercount (R1); the
`C-R4-GLTF-KHR` versus `FORK_OVERVIEW` / `FEAT-SURVEY-02..04` conflict plus the "~2300 LOC" size
claim at `FORK_OVERVIEW.md:153` (R2); the `DEFERRED_WORK.md:5338` default-ON error (§4); and the
`WebGPUSSREffect.ts:205-224` stale warning (R23).
