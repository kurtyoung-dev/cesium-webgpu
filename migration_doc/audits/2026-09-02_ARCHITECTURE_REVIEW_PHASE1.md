# Architecture Review 2026-09-02 — Phase 1 synthesis

> **PARTIAL AND UNRELIABLE — a lead list, not evidence. Do not cite as a premise.**
> Two of the plan's eighteen lenses produced verified output; the other sixteen produced none, so §4 generalises from what two lenses saw, and every unlisted lens needs a pass rather than reading as clean. Four of this document's anchors were re-derived at HEAD on 2026-09-03 and do not support their claims:
>
> - **`GEOMETRY-PRIMITIVES-1`** (§1.2, "one colour uniform, hard-coded red") cites `WebGPUGroundPrimitiveRenderer.js:2132`. At HEAD `:2132` is a pick-ID comment, and `:1798-1801` packs the per-instance classification colour. Per-instance colour landed at **Batch 1389 (`e337646ea4`)**; the headline no longer holds.
> - **`GEOMETRY-PRIMITIVES-2`** (§1.2) cites `WebGPUPrimitiveCommands.ts:3002-3014` for "bakes only `color`/`depthFailColor`". That block reads the batch table today. Whether the `show` / `offset` / `distanceDisplayCondition` half survives is **undetermined**.
> - **§2 and Appendix A ("a failed pipeline swaps to an explicit magenta ErrorPipeline")** cite `WebGPUModelRenderer.ts:3513-3557`. There are zero `ErrorPipeline` hits in that range — the symbol lives in `WebGPUModelPipelineCache.ts`, and `:3513` is `function getCustomShaderEntries(`. This is a **claim of health**, so its falsity means the behaviour is unverified, not that it is broken.
> - **§2 ("the shadow-cast path reproduces the skinned VS rather than casting from the rest pose")** cites `WebGPUPrimitiveShadowCast.ts:277-283`. That 290-line file contains no `skin` reference at all. Also a claim of health, and likewise unverified.
>
> Two of the four are findings that overstate a defect and two are unverified claims that a path is correct — the register errs in both directions, which is why nothing here may be briefed without re-derivation. The review authority is [`../ARCHITECTURE_REVIEW_2026-09-02.md`](../ARCHITECTURE_REVIEW_2026-09-02.md); its §6.1 records this disposition. Running the sixteen missing lenses is the outstanding work.


**Plan:** [`../ARCHITECTURE_REVIEW_PLAN_2026-09-02.md`](../ARCHITECTURE_REVIEW_PLAN_2026-09-02.md).
**Rules measured against:** [`../FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md`](../FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md)
§2 invariants (2.1–2.4) and ADR-1..ADR-8 (§3), plus the CLAUDE.md principles named per row.
**Status of this document:** read-only synthesis. Findings are leads until a lane re-derives them
(plan, "Rules the review runs under"). Nothing here de-scores a measured red or reopens a closed row.

**Coverage disclosure.** The plan lists eighteen lenses. The verified inputs delivered to this
synthesis come from **two**: `gltf-models` and `geometry-primitives` (six surviving findings, six
dropped, two healthy paragraphs). The remaining sixteen lenses (globe & imagery, 3D Tiles,
collections, entity/datasource, picking, shadows/lighting, post-process, performance & compute,
architecture/build, ownership-lifetime, frame-graph, shader-composition, precision-parity,
async-and-readiness, testability-observability, planned-work-fit) had no verified output in the
synthesis input. §4 (cross-cutting) is therefore derived only from what the two lenses saw and is
explicitly labelled as such; the completeness critic should treat every unlisted lens as needing a
pass, not as clean.

**Survival rule applied:** a finding survives with at least one CONFIRMED and fewer than two REFUTED
votes. Five candidates (GLTF-MODELS-1..5) carry **no recorded vote** and therefore fail the bar
without having been refuted; they are listed in Appendix A with that exact reason and are the first
candidates for a second verification pass.

---

## 1. Executive verdict

1. Against ADR-1/ADR-2 the two lenses found the Scene seam **intact**: Model.js resolves the MODEL feature renderer once per update (Model.js:785-786) and gates on FR presence, not `isWebGPU` (:790-795); all twenty primitive-family Scene files scanned carry zero `Renderer/WebGPU` imports and zero `isWebGPU`/`rendererType` branches.
2. Against §2.1 (documented Primitive/Entity behaviour) the WebGPU primitive family is **broken at its most common entry point**: per-instance colour, show, offset, distanceDisplayCondition and pick identity do not reach the GPU (GEOMETRY-PRIMITIVES-1, -2). This is the most consequential finding: every multi-entity clamped polygon batch renders one translucent red (WebGPUGroundPrimitiveRenderer.js:1798-1801, :2132) and `entity.show = false` on a static fill is a no-op (WebGPUPrimitiveCommands.ts:3002-3014).
3. Against §2.3 (every allocation has a destruction path) the same family **never tears down** its WebGPU caches: Primitive.destroy (Primitive.js:728-757) omits `_webgpuCache`, the PRIMITIVE FR registers no `destroy` (WebGPUFeatureRenderers.ts:380-386), and the registered ground destroy has no caller (GEOMETRY-PRIMITIVES-3). Second most consequential: unbounded GPU growth under datasource churn.
4. Against ADR-3/ADR-8 (device-scoped pipeline sharing; no hot-path pipeline creation after FAR-304) the primitive path **bypasses the central pipeline cache** at eight `createRenderPipeline` sites (WebGPUPrimitiveCommands.ts:2057-5245) with per-primitive bind-group layouts (GEOMETRY-PRIMITIVES-4). Third most consequential: it cannot join FAR-304 fingerprints or the async-compile prohibition until routed.
5. Against §2.1 ("absence never silently falls through") custom Fabric materials, `material.wgslShaderSource` and Appearance shader overrides **silently render as Color** on primitives (WebGPUPrimitiveShaders.js:709-712, :1029; GEOMETRY-PRIMITIVES-5).
6. Against §2.2 ("host-shareable offsets and CPU packing come from one schema") the model material contract is **hand-mirrored in three places** with literal-index UBO packing and no offset spec (GLTF-MODELS-6); FAR-302 covers the offsets on paper but is not active.
7. ADR-4/ADR-5 (one frame graph, semantic packets): neither lens found a packet contract in use; the primitive family still emits backend-specific commands built per file. Not measured by a frame-graph lens in this input — see §4.2.
8. ADR-6 (explicit async pick API): not exercised by these lenses beyond the first-instance pick-id defect in -1; no verdict from this input.
9. ADR-7: no finding; the KHR BRDF surface (four lobes with no WebGL reference) stands as additive WebGPU to preserve.
10. **Healthy, and not to be touched by any synthesis:** the FR dispatch shape on both lenses; RTE done in the split domain with previous-frame paths for skinning, morphing and node matrices (ModelPBRComplete.wgsl:923-960); the depth-sample classifier architecture, its async cache resolution with no-commands-this-frame retry (WebGPUGroundPrimitiveRenderer.js:2100-2104), and the GroundPolyline batch-table storage-buffer pattern (WebGPUGroundPolylineRenderer.js:46-50, :273-280) that -1 and -2 should copy; the add-only ShaderDefine bits, module-cache mask fold and the model pipeline-key boot assertion (WebGPUModelPipelineCache.ts:318-336).
11. Shape of the defects: all four HIGH/MEDIUM geometry findings sit in **two seams** — batch-table consumption and per-object teardown — not in layering. The fixes are bounded and share one pattern already present in the sibling renderer.
12. Recommended next: file the four proposed P0/P1 rows (§5), re-verify GLTF-MODELS-1..5 (unvoted, Appendix A), and run the sixteen missing lenses before any ADR is ruled changed or retired in Phase 2.

---

## 2. Register

Verifier votes are listed as C/R = CONFIRMED/REFUTED counts out of three.

### 2.1 DEFECT (violates a stated rule today)

| id | title | subsystem | file:line | rule/ADR | consequence | verifier votes | existing row or proposed row |
|---|---|---|---|---|---|---|---|
| GEOMETRY-PRIMITIVES-1 | WebGPU GroundPrimitive/ClassificationPrimitive is first-instance-only: one colour uniform (hard-coded red under PerInstanceColorAppearance), one pick id, one extents frame per primitive | Geometry Primitives / Classification | `packages/engine/Source/Renderer/WebGPU/WebGPUGroundPrimitiveRenderer.js:2132` (also :814, :855, :1798-1801, :2141-2146, :519-526) | §2.1; ADR-2 (wrapper owners propagate per-instance state); Principle 5; FEATURE_INVENTORY §A.4 | Every multi-entity clamped polygon batch renders translucent red; pick returns the first entity; textured multi-instance uses instance 0's UV frame | 3C/0R | Partial: C15-G7a (QUEUE_2026-08-02_CAMPAIGN15.md:692, wrong scope — gsplat); DEFERRED_WORK.md:6080 note, never filed. **Proposed:** NEW-WEBGPU-GROUNDPRIM-PER-INSTANCE-BATCH-TABLE (P0) |
| GEOMETRY-PRIMITIVES-2 | WebGPU Primitive path bakes only `color`/`depthFailColor` at command build; per-instance `show`, `offset`, `distanceDisplayCondition` never consumed; later attribute writes never reach the GPU | Geometry Primitives (Primitive, PerInstanceColorAppearance, StaticGeometry*Batch) | `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.ts:3002` (also :3014, :3549-3640) | §2.1; §2.3 (versioned mutable payloads); Principle 5; FEATURE_INVENTORY §A.4 | `entity.show=false` on static fills is a no-op; RELATIVE_TO_GROUND offsets sit at ellipsoid height; time-varying fill colours freeze; per-instance DDC never hides; `getGeometryInstanceAttributes(id).color = …` is a silent no-op | 3C/0R | Not tracked (grep of DEFERRED_WORK, FIX_QUEUE_2026-08-27, C11 queue, FEATURE_INVENTORY §C/§D, WEBGPU_DEBUGGING_LOG, 2026-07-01 parity report). **Proposed:** NEW-WEBGPU-PRIMITIVE-BATCH-TABLE-CONSUMER (P0) |
| GEOMETRY-PRIMITIVES-3 | Primitive/GroundPrimitive/ClassificationPrimitive.destroy never release WebGPU per-object caches; PRIMITIVE FR registers no destroy; the registered ground destroy has no caller | Geometry Primitives / resource lifetime | `packages/engine/Source/Scene/Primitive.js:728` (also :728-757; WebGPUFeatureRenderers.ts:380-386, :584, :659; WebGPUSceneRendererEnsureResources.ts:652-653) | §2.3 ("every allocation has an owner … destruction path"); ARCHITECTURE.md §3.1; C-R12 | Every removed entity batch, rebatch and user destroy leaks GPU buffers, pipelines and material textures until GC (permanently if referenced) | 3C/0R | Umbrella only: C11-20 / C-R12-PER-OBJECT-CACHES (QUEUE_2026-07-18_CAMPAIGN11.md:1639; DEFERRED_WORK.md:8360-8380) does not name this family; FIX_QUEUE fleet3 :1429 covers only the placeholder UB. **Proposed:** NEW-WEBGPU-PRIMITIVE-FAMILY-TEARDOWN (P1) |

### 2.2 DEBT (works, but blocks or taxes named planned work)

| id | title | subsystem | file:line | rule/ADR | consequence | verifier votes | existing row or proposed row |
|---|---|---|---|---|---|---|---|
| GEOMETRY-PRIMITIVES-4 | Every Primitive compiles its own BGLs and up to eight GPURenderPipelines synchronously, bypassing WebGPURenderPipelineCache | Geometry Primitives / pipeline realization | `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.ts:3231` (sites :2057, :2530, :3231, :3321, :3473, :4580, :4739, :5245; BGLs :3155-3172) | ADR-3; ADR-8; C-R7-RENDERER-MIGRATION; §2.4 | N identical-appearance primitives = N synchronous compiles (hitch on every datasource rebatch) and N× pipeline memory; blocks FAR-304 fingerprints and the ADR-8 async prohibition for this family | 3C/0R | Not as a row (C-R7 list at PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:183-200 omits it; FIX_QUEUE Q-74 :970 notes the bypass in passing). **Proposed:** C-R7-PRIMITIVE-PIPELINE-CACHE (P2) |
| GLTF-MODELS-6 | Model material contract hand-mirrored in three places (JS MaterialFlags, WGSL consts, renderer KHR mask); 192-float material UBO packed by literal index with no spec pinning either | glTF Models / materials | `packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts:1345` (also :1325-1352, :1255-1282, :2228-2262, :2385-2402; ModelMaterialInfo.js:20-58; ModelPBRComplete.wgsl:41-71, :120-297) | §2.2 ("offsets and CPU packing come from one schema") | A renumbered bit or shifted slot mis-lights silently; taxes GLTF-MODELS-2 (KHR texture transforms in the reserved floats 184-191) and the C11-81 per-family split | 3C/0R | Partial: FAR-302 (Phase 3, not active) covers offsets; flag triplication unnamed. **Proposed:** MODEL-MATERIAL-CONTRACT-PIN (P3, S) |

### 2.3 GAP (capability a globe engine needs and the fork lacks)

| id | title | subsystem | file:line | rule/ADR | consequence | verifier votes | existing row or proposed row |
|---|---|---|---|---|---|---|---|
| GEOMETRY-PRIMITIVES-5 | Primitive material/appearance extensibility closed on WebGPU: custom Fabric renders as Color, `material.wgslShaderSource` never consumed by the primitive path, Appearance VS/FS overrides ignored | Geometry Primitives / Appearances & Materials | `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveShaders.js:709` (also :709-712, :1015-1027, :1029-1035; Material.js:296-300; MaterialHelpers.js:221-290; Appearance.js:19-20, :55-56) | §2.1 ("absence never silently falls through"); Principle 9; FEATURE_INVENTORY §A.13 | Application-defined materials and custom appearance GLSL render flat Color with no production console signal; WGSL fabric investment unreachable from primitives; DebugAppearance unusable on WebGPU | 3C/0R | Partial: DEFERRED_WORK.md:9194-9210 scopes WGSL fabric to the globe only. **Proposed:** NEW-WEBGPU-PRIMITIVE-CUSTOM-MATERIAL-SURFACE (P2) |

### 2.4 DRIFT (docs or rules and the code disagree)

No DRIFT finding survived from the delivered lenses. GLTF-MODELS-5 (inventory / C11-88 / C-R4 KHR
coverage claims disagree with the loader) was the one DRIFT candidate; it is unvoted (Appendix A).

---

## 3. Per-subsystem evidence

### 3.1 Geometry Primitives (lens: geometry-primitives)

#### GEOMETRY-PRIMITIVES-1 — DEFECT, HIGH — first-instance-only classifier

**Mechanism.** The colour VS takes only `pH`/`pL` (WebGPUGroundPrimitiveRenderer.js:814
`@vertex fn colorVS(@location(0) pH, @location(1) pL)`) and emits `o.col = u.color` (:855). `u.color`
is packed from `primitive.appearance?.material?.uniforms?.color` (:2132) with the fallback
`data[24] = color?.red ?? 1.0; … ?? 0.0; … ?? 0.0; … alpha ?? 0.5` (:1798-1801). A
PerInstanceColorAppearance has no material, so every instance renders translucent red. Pick colour is
`findFirstGeometryInstancePickId(primitive)` (:2141-2146; WebGPUPickCommandHelpers.ts:91-103, whose
own comment reads "this renderer is explicitly first-geometry-only"). Textured extents read
`bt.getBatchedAttribute(0, …)` for all four attributes (:519-526, "multi-instance + per-instance
materials is a follow-up").

**Why it is the common path.** GroundPrimitive defaults to PerInstanceColorAppearance when instances
carry a colour attribute (GroundPrimitive.js:120-128); StaticGroundGeometryColorBatch builds ONE
GroundPrimitive from many entities with no appearance (StaticGroundGeometryColorBatch.js:108-113).

**Measured.** The C15-G7 run of 2026-09-02 (FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md:122): WebGL drew
the requested magenta [255,5,217]; WebGPU drew [255,10,11] — the fallback. The existing gate cannot
see it: probe-classifier-scenemode.mjs:104-106 requests Color(1.0,0.05,0.05,1.0) and counts red
pixels, so the red fallback passes as parity.

**Pattern to copy.** WebGPUGroundPolylineRenderer.js:46-50, :273-280 already mirrors the batch table
into a storage buffer indexed by batchId.

**Tracking.** C15-G7a (QUEUE_2026-08-02_CAMPAIGN15.md:692) is DISPATCHED with the right premise
("the per-instance colour does not reach classification shading") and the wrong scope (gsplat); the
defect is in the ground-primitive renderer for every GroundPrimitive/ClassificationPrimitive.
DEFERRED_WORK.md:6080 recorded "the renderer reads only appearance.material.uniforms.color" in
2026-05 and never filed it. First-instance pick and extents are untracked.

**Votes.** CONFIRMED ×3. Verifier 2 independently checked C15-G7a's backing probe and agreed the
scope is wrong; verifier 3 called the mechanism "real and total (not partial)".

#### GEOMETRY-PRIMITIVES-2 — DEFECT, HIGH — batch table baked once, never re-read

**Mechanism.** createWebGPUCommands reads `primitive._batchTableAttributeIndices?.color` (:3002) and
`.depthFailColor` (:3014) and bakes the resolved colour into the interleaved vertex buffer
(:3549-3640). Those are the only batch-table reads in the WebGPU primitive path (grep of
Renderer/WebGPU for `_batchTableAttributeIndices`; verifier 1 adds that the interface at :289-292
declares only `color` and `depthFailColor`). WebGL applies `show`
(`gl_Position *= czm_batchTable_show(batchId)`, PrimitiveShaderHelpers.js:118-135), `offset`
(:222-250) and distanceDisplayCondition from the batch-table texture every frame, re-uploaded on
`_batchValuesDirty` (BatchTable.js:247). Primitive.update only rebuilds commands on
appearance/material/translucency identity change or format/resource generation
(Primitive.js:559-600), so a `getGeometryInstanceAttributes(id).color = …` write (the documented
JSDoc example) sets the batch table and invalidates nothing.

**Entity dependence.** StaticGeometryColorBatch.js:355-375 (`showsUpdated` → `attributes.show`, no
rebuild), :335-337 (`attributes.offset` for terrain-relative heights), :245-252 (time-varying
`attributes.color`).

**Test coverage.** No probe or spec under Tools/visual-regression or Specs/Renderer/WebGPU references
`attributes.show` or `getGeometryInstanceAttributes` (grep).

**Tracking.** None. **Votes.** CONFIRMED ×3.

#### GEOMETRY-PRIMITIVES-3 — DEFECT, HIGH — no teardown path

**Mechanism.** Primitive.destroy (Primitive.js:728-757) destroys `_sp`, `_spDepthFail`, `_va`,
`_pickIds`, `_batchTable` and returns; `_webgpuCache` (vertex/index GPUBuffers, per-geometry camera
UBOs, material UBOs, pick UBOs, pipelines, bind groups, material textures) is never touched (grep
`_webgpuCache` in Primitive.js, PrimitiveCollection.js, GroundPrimitive.js, ClassificationPrimitive.js
= 0). The PRIMITIVE FR registration is
`{ createCommands, createMaterialCommands, updateCommandUniforms, updateMaterialCommandUniforms, updatePickCommandUniforms }`
(WebGPUFeatureRenderers.ts:380-386) — no `destroy`; WebGPUPrimitiveCommands.ts exports none
(:5760-5769) and only calls `.destroy()` on old buffers during a shader-change rebuild (:3769, :5372,
:5474). GroundPrimitive.destroy (GroundPrimitive.js:642-644) forwards to the inner Primitive;
`destroyWebGPUGroundPrimitiveResources` is registered (WebGPUFeatureRenderers.ts:584, :659) and
called by nothing in Scene/. Vector3DTilePrimitive.js:427-432 does it correctly
(`_lastFeatureRenderer.destroy?.(this)`). The only reachable clear is the device-loss walk
(WebGPUSceneRendererEnsureResources.ts:652-653), which nulls the slot without destroying buffers
(WebGPUBuffer.ts:454-460 has the destroy that is never reached).

**Why it matters.** StaticGeometryColorBatch and StaticGroundGeometryColorBatch recreate their
primitive on every add/remove (`primitives.remove(oldPrimitive)`) — churn is the normal case.

**Tracking.** C11-20 / C-R12 (QUEUE_2026-07-18_CAMPAIGN11.md:1639; DEFERRED_WORK.md:8360-8380) is
PARTIAL and names Point/Label teardown, tileset-owned models, clipping caches, label-cache variants
and the device-loss walk — not this family. FIX_QUEUE fleet3 :1429 = placeholder UB only.
**Votes.** CONFIRMED ×3; verifier 2: "the 'already tracked' defense does not hold".

#### GEOMETRY-PRIMITIVES-4 — DEBT, MEDIUM — pipeline cache bypass

**Mechanism.** Fresh `makeBindGroupLayout` camera/material/texture layouts per primitive on every
shader-signature change (WebGPUPrimitiveCommands.ts:3155-3172); direct `device.createRenderPipeline`
for colour, depth-fail twin, two twoPasses cull variants and pick (:3231, :3321, :3473); material
path likewise (:4580, :4739, :5245); grep `createRenderPipeline` = 8 sites (:2057, :2530, :3231,
:3321, :3473, :4580, :4739, :5245); grep `webgpuPipelineCache|getPipeline(` = 0. Distinct BGL
objects per primitive defeat dedupe even for identical descriptors. The sibling ground renderer
resolves through the cache asynchronously and returns no commands until ready
(WebGPUGroundPrimitiveRenderer.js:2100-2104). Per-file key bookkeeping is re-invented (Q-74's
local `materialBlendKey`; log-depth/format-generation flags at :3113-3130).

**Tracking.** C-R7 list (PE deep review :183-200) omits the file; FAR-304 (remediation plan
:644-651) assumes producers go through the cache. **Votes.** CONFIRMED ×3.

#### GEOMETRY-PRIMITIVES-5 — GAP, MEDIUM — closed extensibility

**Mechanism.** `const materialType = defined(material) ? material.type : "Color";` then a chain of
`if (materialType === "Image") … "Checkerboard" …` (WebGPUPrimitiveShaders.js:709-712); non-catalog
types fall to `// Color material (default)` (:1029-1035); only PolylineArrow/Dash/Glow/Outline warn,
and only under the debug pragma (:1015-1027). `material.wgslShaderSource` (Material.js:296-300;
MaterialHelpers.js:221-290) has zero references in WebGPUPrimitiveCommands.ts or
WebGPUPrimitiveShaders.js; `Appearance.vertexShaderSource`/`fragmentShaderSource` (Appearance.js:19-20,
:55-56) and DebugAppearance are never read (0 references) — shader selection is purely from geometry
attributes (selectWebGPUShader :287-310).

**Tracking.** DEFERRED_WORK.md:9194-9210 scopes the WGSL fabric consumer to the Globe and lists
"Error path for user-custom-without-WGSL" as globe step 6. **Votes.** CONFIRMED ×3.

#### What is healthy — Geometry Primitives (lens paragraph, verbatim)

The Scene seams in this area are in good shape and should not be touched by any synthesis: all twenty primitive-family Scene files scanned (Primitive, GroundPrimitive, ClassificationPrimitive, GroundPolylinePrimitive, EllipsoidPrimitive, the six Vector3DTile* classes, the appearances) use the FeatureRendererKey check and contain zero `Renderer/WebGPU` imports and zero `isWebGPU`/`rendererType` branches; shared scene logic runs before the branch (EllipsoidPrimitive's `_computedModelMatrix` ordering is explicit, ClassificationPrimitive gates its standalone dispatch on `_updateAndQueueCommandsFunction` so the GroundPrimitive wrapper owns emission and BOTH does not double-blend), and the three Vector3DTile classes call `_lastFeatureRenderer.destroy?.(this)` - the correct per-object teardown shape that the rest of the family should copy. Command construction forwards `appearance.renderState` to every WebGPU command (dynamic stencil/blend-constant/scissor state via applyPerEncoderState), the colour-target blend is derived from the appearance render state rather than a translucency guess (Q-74), the log-depth fleet is complete across basic/phong/material/pick/polyline primitive shaders with pick-log tracked as its own rebuild axis, HDR/MSAA format generations invalidate cached pipelines, and RTE discipline is uniform: computeRTEMatrices with modelMatrix-inverse camera encoding, positionHigh/Low in every vertex layout, and depth-clamped RTE in the classifier VS.

The classifier architecture is the strongest part of the lens. The depth-sample classifier is one architecture shared with WebGL (ShadowVolumeAppearanceFS semantics), resolves its depth source per frustum through bind-group resolvers without rebuilding commands, prefers packed translucent depth over globe depth, routes pick commands through `attachPickToColorCommand` so the pick pass is single-target-safe, emits per-pass command arrays for classificationType BOTH plus IGNORE_SHOW stencil commands for invert classification, carries mode-correct bounding volumes for multi-frustum distribution, and resolves its pipelines through the central WebGPURenderPipelineCache asynchronously with a no-commands-this-frame retry - exactly the readiness contract ADR-8 asks for. The GroundPolyline renderer already mirrors the batch table into a batchId-indexed storage buffer (the pattern findings 1 and 2 should adopt), the Vector3DTile primitive renderer re-uploads on `_batchTexture._batchValuesDirty` and carries per-feature pick colours, morphing is handled with a two-stream EC-space blend, TAA velocity commands exist for every classifier, CO-12 removed every numeric pass literal from the directory and pinned the known classifier pass-slot drift by value in a spec, and the probe fleet is broad (fourteen classification/ground probes, depth-fail, material-parity, polyline-appearance, pipeline-key-aliasing). The gaps found are concentrated in two seams - per-instance batch-table consumption and per-object teardown - not in the layering.

### 3.2 glTF Models (lens: gltf-models)

#### GLTF-MODELS-6 — DEBT, LOW — triple-mirrored material contract

**Mechanism.** `MaterialFlags` bits declared in ModelMaterialInfo.js:20-58, re-declared as WGSL
constants in ModelPBRComplete.wgsl:41-71, re-typed as raw integer literals in `FLAG_HAS_KHR_MASK`
(WebGPUModelRenderer.ts:1345-1352) and `FLAG_HAS_SKINNING`/`FLAG_HAS_INSTANCING` (:1325-1327). The
material UBO is packed by literal float index (`data[176]`, `data[181]`, `dataWords[104]` at
:2390-2402, :2246) against a comment-only layout map (:1255-1282) that must match
`struct MaterialUniforms` (wgsl:120-297) by hand. WebGPUModelMaterialDescriptorSpec.js has no offset
assertions; no spec references the flag values (grep for HAS_CLEARCOAT/524288 in Specs finds only the
WebGL MaterialPipelineStageSpec). The only structural guard is the pipeline-key boot assertion
(WebGPUModelPipelineCache.ts:318-336), which does not cover flag or offset drift.

**Consequence for planned work.** The reserved floats 184-191 already double as model.color and are
earmarked for KHR texture transforms (GLTF-MODELS-2, unvoted); the C11-81 per-family split pays the
three-edit tax on every extension.

**Tracking.** FAR-302 (one uniform schema and host-shareable layout generator; Phase 3, ledger status
not active) covers the offsets; the flag triplication is unnamed. **Votes.** CONFIRMED ×3; verifier
3 calls DEBT/LOW "defensible".

#### What is healthy — glTF Models (lens paragraph, verbatim)

The model path honours the fork's central rules where it matters most. The Scene seam is clean: Model.js resolves the MODEL feature renderer once per update (:785-786), the `legacyPickTextureDemand` gate is derived from FR presence rather than `isWebGPU` (:790-795), `buildDrawCommands` runs the shared semantic pipeline stages once and retains backend-neutral primitive descriptors instead of realizing ShaderPrograms/VertexArrays on WebGPU (Model.js:2569-2599, ModelSceneGraph.js:200-210, :805-840), and the dispatch decision is 'did the FR run?' (Model.js:2927-2934) - exactly the ADR-1/ADR-2 shape the remediation plan wants, with a `prepare()` admission boundary (WebGPUModelPreparationAdmission.ts) attached before any device resource exists. The renderer-agnostic extractors (ModelMaterialInfo, ModelPrimitiveGeometry, ModelSkinData) keep the 'what' on the Scene side and the 'how' behind the FR. RTE is done correctly in model space with the camera encoded high/low and the per-instance translation differenced in the split domain before the local position is added back (ModelPBRComplete.wgsl:923-960), and the previous-frame path is carried for skinning (prev joint palette at group 2 binding 4), morphing (previousMorphWeights at binding 5) and per-node model matrices, so TAA velocity for animated rigs is real rather than a phantom. Vertex deformation order is spec-correct (morph, then skin, then instance, then camera subtract, :860-960) and the shadow-cast path reproduces the skinned VS rather than casting from the rest pose (WebGPUPrimitiveShadowCast.ts:277-283).

The pipeline-variant machinery is sound and defended: the ShaderDefine bits are add-only and the module cache folds the full 32-bit mask plus a content salt for generated metadata/customShader chunks, the model pipeline key packs `alphaMode | doubleSided | md<<3` with a boot assertion that fails loudly if a bit ever shifts past 29 (WebGPUModelPipelineCache.ts:318-336), topology lives in one enforceable home (WebGPUModelTopology.ts) threaded through all twelve builders, the colour pipeline resolves through the central async cache behind a ready gate while pick/velocity/classification stay synchronous by deliberate design, and a failed pipeline swaps to an explicit magenta ErrorPipeline (:3513-3557) rather than silently drawing nothing. The KHR BRDF surface itself is broad and physically grounded (clearcoat second lobe with its own normal, Charlie sheen, Belcour analytical iridescence, thickness-coupled transmission with scene-colour refraction, Beer-Lambert volume, anisotropic IBL bent normal) - four of these have no WebGL reference at all, which is a strength to preserve under the 'never remove additive WebGPU' ruling. Device-shared model layouts/samplers/placeholders are already refcounted per device generation (WebGPUModelDeviceResources.ts), the merged four-group layout fits the spec `maxBindGroups` floor, and the probe fleet around models (probe-khr-extensions-parity, probe-model-scene-modes, probe-taa-model-skinned-velocity, probe-gltf-points-mode, the topology and metadata-variant-key specs) is dense enough that the findings above are all in corners those fixtures do not exercise (default-limit devices, non-zero KHR texCoords, >8 morph targets) rather than in the mainline.

---

## 4. Cross-cutting synthesis

Scope caveat: derived from two lenses; the dedicated ownership-lifetime, frame-graph,
shader-composition and async-and-readiness lenses have not reported into this input. Each
picture below names what the two lenses' evidence supports and what it cannot.

### 4.1 Coupling and ownership

- **The Scene → FR seam holds on both lenses** (Model.js:785-795, :2927-2934; twenty primitive Scene
  files with zero backend imports or branches). ADR-1/ADR-2's "did the FR run?" dispatch is the shape
  in use. No `ResourceOwnershipToken` or `ResourceOwnershipPolicy` (§2.1) was observed by either lens;
  ownership is still FR-presence, which ADR-2 says "alone is insufficient". Neither lens filed this as
  a finding because it is the FAR ledger's own open state, not new drift.
- **Ownership is asymmetric across the family.** Vector3DTile* owns and tears down through
  `_lastFeatureRenderer.destroy?.(this)` (Vector3DTilePrimitive.js:427-432); Model refcounts device
  resources per generation (WebGPUModelDeviceResources.ts); Primitive/GroundPrimitive/
  ClassificationPrimitive/GroundPolylinePrimitive own caches with no destructor path
  (GEOMETRY-PRIMITIVES-3). §2.3's "every allocation has an owner … destruction path" is met by two
  of the three families and not by the largest one.
- **Mutable payload versioning (§2.3) is present in one renderer and absent in its siblings.**
  Vector3DTile re-uploads on `_batchTexture._batchValuesDirty`; GroundPolyline mirrors the batch table
  (WebGPUGroundPolylineRenderer.js:46-50, :273-280); the Primitive path snapshots once
  (WebGPUPrimitiveCommands.ts:3002-3014) and the ground classifier reads row 0 only
  (WebGPUGroundPrimitiveRenderer.js:519-526). The fix for -1 and -2 is a pattern transplant, not a
  new design.
- **Contract mirroring instead of one schema** (§2.2): the model material contract exists three times
  (GLTF-MODELS-6). The same shape — a comment-only layout map beside literal-index packing — is the
  kind of coupling the shader-composition and ownership lenses should look for elsewhere.

### 4.2 Frame structure vs ADR-4 / ADR-5

- Neither lens observed a backend-neutral frame graph node or a semantic render packet in the paths
  it read. Both families still emit backend-specific command objects from per-file builders
  (WebGPUPrimitiveCommands.ts createWebGPUCommands; the twelve model builders threaded through
  WebGPUModelTopology.ts). ADR-5's "two divergent live schedulers are not retained" is not yet true for
  these paths; DrawCommand and WebGPUDrawCommand are both live.
- What ADR-4 wants from pass ownership is partly present in the classifier: per-frustum depth-source
  resolution through bind-group resolvers without rebuilding commands, per-pass command arrays for
  classificationType BOTH, and pick routed through `attachPickToColorCommand` (healthy paragraph, §3.1).
  That is pass-aware command emission, not a frame graph; the frame-graph lens must say which.
- The evidence this input can add to Phase 2's ADR-4/5 ruling: the primitive family's per-file
  re-invention of pipeline-key bookkeeping (Q-74 blend key; :3113-3130 rebuild flags) is exactly the
  duplication a packet contract would absorb, and GEOMETRY-PRIMITIVES-4 is a prerequisite either way.

### 4.3 Shader composition

- The variant machinery is healthy and defended on the model path: add-only ShaderDefine bits, the
  module cache's full-mask fold plus content salt for generated chunks, and the pipeline-key boot
  assertion (WebGPUModelPipelineCache.ts:318-336). The primitive family is outside that machinery: it
  compiles its own modules/pipelines (GEOMETRY-PRIMITIVES-4) and selects shaders from a fixed catalog
  (WebGPUPrimitiveShaders.js:709-712) with no composition hook.
- **Two shader languages, one extension point served.** The fork's WGSL fabric twin
  (`material.wgslShaderSource`, Material.js:296-300; MaterialHelpers.js:221-290) reaches the globe
  and not primitives (GEOMETRY-PRIMITIVES-5). The GLSL extension points (Fabric, Appearance
  VS/FS, DebugAppearance) have no WGSL twin on primitives. The cost of two languages shows here as an
  unreachable investment plus a silent fallback, not as duplicated shader text.
- Host-shareable layout is a schema on paper (FAR-302) and a comment in code (GLTF-MODELS-6). The
  shader-composition lens should measure how many other UBO structs are in the same state.

### 4.4 Asynchrony and readiness

- ADR-8's readiness contract is implemented **twice correctly and once not at all** in the primitive
  family: the ground classifier resolves through the central cache asynchronously with a
  no-commands-this-frame retry (WebGPUGroundPrimitiveRenderer.js:2100-2104); the model colour pipeline
  resolves through the async cache behind a ready gate with an explicit magenta ErrorPipeline on
  failure (WebGPUModelRenderer.ts:3513-3557), with pick/velocity/classification synchronous by
  deliberate design; the Primitive path compiles synchronously on the frame a batch becomes ready
  (GEOMETRY-PRIMITIVES-4). The "prohibition after FAR-304/FAR-600" cannot be enforced for a family
  that does not go through the cache.
- The model path has a `prepare()` admission boundary before any device resource exists
  (WebGPUModelPreparationAdmission.ts) — the ADR-8 preparation-graph shape in miniature. Nothing
  equivalent exists on the primitive path.
- ADR-6 (async pick API): the only pick evidence in this input is the first-instance pick id
  (WebGPUPickCommandHelpers.ts:91-103). That is a correctness defect in what the pick returns, not a
  finding about the async contract; the picking and async lenses must report separately.

---

## 5. Proposed rows for the research dispatch queue

Only findings with no existing row of correct scope. Tiers use the queue's §0.1 legend; sizes
S/M/L; every engineering row also owes the standing OPUS-REVIEW dispatch. These are proposals —
the queue does not launch, rule or fund a row, and Phase 2 decides which become rows.

| id | title | tier | size | dependency | source finding |
|---|---|---|---|---|---|
| NEW-WEBGPU-GROUNDPRIM-PER-INSTANCE-BATCH-TABLE | Give WebGPUGroundPrimitiveRenderer a batchId vertex attribute + batch-table storage buffer (reuse WebGPUGroundPolylineRenderer.js:46-50, :273-280) carrying per-instance colour, show, pick colour and planar/spherical extents; drop the red fallback (:1798-1801); emit per-instance pick ids; widen C15-G7a's premise to this row or make G7a depend on it. Acceptance: probe with ≥2 entities of distinct colours in one StaticGroundGeometryColorBatch asserting exact per-entity colour and pick identity on both backends; full bar | OPUS-JUDGMENT (engine, parity) | M | none; C15-G7a re-scoped to depend on it | GEOMETRY-PRIMITIVES-1 |
| NEW-WEBGPU-PRIMITIVE-BATCH-TABLE-CONSUMER | Stop baking batch-table values into the vertex buffer (WebGPUPrimitiveCommands.ts:3549-3640); carry batchId as a vertex attribute and bind a storage-buffer mirror of BatchTable re-uploaded on `_batchValuesDirty` under a monotonically increasing version (§2.3); implement show, offset/offset2D, distanceDisplayCondition and live colour/depthFailColor in basic/phong/material/pick shaders. Acceptance: probe toggling entity.show, mutating attributes.color after ready, RELATIVE_TO_GROUND extrusion, pixel-compared against WebGL; full bar | OPUS-JUDGMENT (engine, parity) | L | none (shares the storage-buffer pattern with the row above; sequence after it) | GEOMETRY-PRIMITIVES-2 |
| NEW-WEBGPU-PRIMITIVE-FAMILY-TEARDOWN | Add `destroyWebGPUPrimitiveResources(primitive)` to WebGPUPrimitiveCommands, register it as the PRIMITIVE FR `destroy` (WebGPUFeatureRenderers.ts:380-386), and call the owning FR's destroy from Primitive.destroy (Primitive.js:728-757), GroundPrimitive.destroy (:642-644), ClassificationPrimitive.destroy and GroundPolylinePrimitive.destroy in the Vector3DTilePrimitive.js:427-432 shape. Acceptance: Karma/Edge spec creating and destroying N primitives with the context's tracked buffer/texture counts and bytes returning to baseline (multi-metric); fold FIX_QUEUE fleet3 :1429 in; annotate C11-20 with the scope split | OPUS-JUDGMENT (engine) | M | none; C11-20 annotated, not blocked | GEOMETRY-PRIMITIVES-3 |
| C-R7-PRIMITIVE-PIPELINE-CACHE | Hoist the primitive family's BGLs to a per-device layout cache; build descriptors once per (shaderType, defines, translucent/blend, topology, cull, format generation, msaa); resolve through `context.webgpuPipelineCache` with the ground renderer's async skip-until-ready shape (WebGPUGroundPrimitiveRenderer.js:2100-2104). Acceptance: pipeline-key-aliasing spec extended to primitive descriptors plus a multi-metric probe (createRenderPipeline count, first-frame CPU ms, pipeline object count) over 200 identical-appearance primitives on both backends | OPUS-JUDGMENT (engine) + OPUS-EDGE-EXECUTOR (measurement) | M | after NEW-WEBGPU-PRIMITIVE-BATCH-TABLE-CONSUMER (shader inputs change once); prerequisite for FAR-304 coverage of this family | GEOMETRY-PRIMITIVES-4 |
| NEW-WEBGPU-PRIMITIVE-CUSTOM-MATERIAL-SURFACE | (a) permanent one-time console.warn for any non-catalog material type or appearance shader override on WebGPU (Principle 9) at WebGPUPrimitiveShaders.js:1029; (b) route `material.wgslShaderSource` through the primitive material path (generated-chunk keySalt per ARCHITECTURE §6.3.1, composed with PrimitiveMat*Flat/Lit as host); (c) file Appearance.vertexShaderSource/fragmentShaderSource and DebugAppearance as explicit WebGPU-unsupported rows in FEATURE_INVENTORY §D with the WGSL-twin path as the migration story | (a),(c) SOL-DIRECTED; (b) OPUS-JUDGMENT | (a) S, (b) M, (c) S | (b) after C-R7-PRIMITIVE-PIPELINE-CACHE (generated chunks need the cache's keySalt path); (a),(c) none | GEOMETRY-PRIMITIVES-5 |
| MODEL-MATERIAL-CONTRACT-PIN | Until FAR-302 lands: generate the WGSL flag constants (ModelPBRComplete.wgsl:41-71) and `FLAG_HAS_KHR_MASK` (WebGPUModelRenderer.ts:1345-1352) from `MaterialFlags` (ModelMaterialInfo.js:20-58) by injection into the module text as the metadata chunk already is; add a Node spec that packs a synthetic ModelMaterialInfo and asserts the byte offsets of every named slot against a table derived from `struct MaterialUniforms` (wgsl:120-297); register as a FAR-302 dependency row so the generator supersedes it | SOL-DIRECTED (spec) + SONNET-BOUNDED (injection) | S | superseded by FAR-302 when active; should precede GLTF-MODELS-2 work if that candidate survives a second pass | GLTF-MODELS-6 |

Rows with an existing owner needing only annotation (no new row): C15-G7a (scope widened by the
first row), C11-20 (scope split annotated by the third row), FIX_QUEUE fleet3 :1429 (folded into the
third row), DEFERRED_WORK.md:9194-9210 WGSL fabric (consumer list gains primitives via the fifth row).

---

## Appendix A — Dropped findings

Listed for honesty about what did not survive. "Reason" is the mechanical outcome under the survival
rule plus the verifier text available to the synthesis (vote texts arrived truncated; nothing is
inferred beyond them).

| id | title | votes | reason not carried |
|---|---|---|---|
| GLTF-MODELS-1 | Every model eagerly builds the full-KHR material layout, so on a default-limit (16 sampled textures) device every glTF throws and the render loop dies — the basic/full split protects nothing at the floor it was built for | none recorded | **Unvoted**, not refuted. Fails the "≥1 CONFIRMED" bar mechanically. The gltf-models healthy paragraph itself names "default-limit devices" as a corner the probe fleet does not exercise, so this is a first-priority second-pass candidate, ideally by a measurement (request a device with `maxSampledTexturesPerShaderStage` at the spec floor) rather than a re-read |
| GLTF-MODELS-2 | All 13 KHR-extension texture samples use the base-colour UV set and base-colour texture transform; per-texture texCoord and KHR_texture_transform only honoured for the five core slots | none recorded | **Unvoted**, not refuted. The surviving GLTF-MODELS-6 references this candidate's reserved-float plan (floats 184-191) as future tax, so its survival changes the size of MODEL-MATERIAL-CONTRACT-PIN; second-pass candidate with a non-zero-texCoord fixture |
| GLTF-MODELS-3 | WebGPU morph targets silently capped at 8 per primitive; WebGL sizes the weight array to the asset | none recorded | **Unvoted**, not refuted. Named in the healthy paragraph as an un-exercised corner (">8 morph targets"); a nine-target fixture would settle it |
| GLTF-MODELS-4 | Per-frame skinning path allocates a fresh joint-matrix Float32Array per skinned node every frame and uploads prev+current palettes unconditionally | none recorded | **Unvoted**, not refuted. If real it is a §2.4 settled-frame allocation finding; must be judged with a multi-metric measurement (allocation count, upload bytes, CPU ms), never a source read alone |
| GLTF-MODELS-5 | KHR-extension coverage claims in the inventory, the C11-88 row and the C-R4 ledger disagree with what the loader and the WebGL material stage implement | none recorded | **Unvoted**, not refuted. The only DRIFT candidate in the input; second pass should be a three-way table (inventory claim / C11-88 claim / loader line) rather than a narrative |
| GEOMETRY-PRIMITIVES-6 | Shared frontend PrimitiveCommandHelpers dispatches on WebGPU command-marker vocabulary (`_webgpuShaderType` prefixes, `_isPickCommand`) that the invariants say belongs behind the renderer interface | 1 CONFIRMED (LOW, "real-but-currently-latent") / 2 REFUTED | **Refuted by majority.** All three verifiers agreed the code is quoted accurately — PrimitiveCommandHelpers.js:456-474 duck-types `colorCommand._webgpuShaderType` and branches on `st.startsWith("mat") \|\| st.startsWith("pbr")` to choose between `updateMaterialCommandUniforms` and `updateCommandUniforms` (re-read for this synthesis: the comment at :456-457 says "Uses duck-typing … instead of backend type check"). Two verifiers did not accept that this constitutes a §2.1 "WebGPU command marker in shared frontend code" violation with a present consequence; the dissenting vote rated it LOW and latent. Not carried as a finding. Worth one line in the frame-graph lens's second pass: if ADR-5 packets land, this dispatch is the kind of marker they would absorb |

## Appendix B — Lenses with no verified output in this input

globe & imagery; 3D Tiles; collections; entity/datasource; picking; shadows/lighting; post-process;
performance & compute; architecture/build; ownership-lifetime; frame-graph; shader-composition;
precision-parity; async-and-readiness; testability-observability; planned-work-fit. The completeness
critic should treat each as unreviewed, not clean. The four cross-cutting pictures in §4 carry a
scope caveat for the same reason.
