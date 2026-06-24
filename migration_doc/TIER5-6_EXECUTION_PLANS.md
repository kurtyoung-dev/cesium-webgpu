# Tier-5 / Tier-6 Execution Plans (Campaign 2)

Produced 2026-06-24 by two read-only investigation workflows (8 architect agents,
`tier5-6-investigate` + `…-rerun`). Each plan was re-verified against current code
+ `git log` for docs-drift. **Status snapshot at HEAD; re-verify before starting.**

**Recommended order (from synthesis):** C2-22 (quick win) → ~~C2-24~~ (done) →
C2-21 → C2-23 → DP-H46 epic (gate first). C2-25 is an L headline, sequence by appetite.

---

## ✅ C2-24 — WEBGPU-COLLECTIONS-FAR-SURFACE-DEPTH — CLOSED (already shipped)

Verified already shipped (Batches 249-251) + **green at HEAD** (`probe-collections-far-camera.mjs`
PASS: far markers @220km bb=7450/pt=5286 visible, below-ground red=0, 0 errors). Collection
shaders write log `frag_depth` matching the globe (`BillboardCollection.wgsl:639/777`,
`PointPrimitiveColor.wgsl`), `_logDepthWriteEnabled` defaults TRUE. Closed in the QUEUE.
Residual (low): the probe gates billboard+point, not the label leg (same SDF path).

---

## C2-22 — MAINT-ERROR-PIPELINE-FALLBACK (QUICK WIN — do first) — S/M, 1 session

**Still relevant:** YES (no `_createErrorPipeline`/`errorPipeline` in code or git history).

**Root cause (queue premise corrected):** model PBR pipelines build **synchronously** via
`device.createRenderPipeline` (`WebGPUModelPipelineCache.js:614`, returned through
`getPipeline` :1721 / `getDepthWritePipeline` :1764 / `getPickPipeline` :1809). Synchronous
`createRenderPipeline` does NOT throw on validation failure — it returns an *invalid* pipeline,
surfaced only via the device error scope. The renderer binds that invalid handle with zero
guarding → draw silently dropped → render-hole (no asset, no console hint).

**Mirror:** the `pushErrorScope("validation")` + `popErrorScope().then(...)` pattern is canonical
here — `WebGPUGlobeSurfaceShaders.ts:239-251/329-336`, `WebGPUSceneRenderer.ts:1701-1707`,
`WebGPURenderBundleManager.ts:402-411`.

**Files:**
- NEW `Shaders/WebGPU/Model/ErrorPipeline.wgsl` — minimal VS (position-only, camera `@group(0)`
  viewProjection) + FS returning `vec4(1,0,1,1)` magenta, with the **same `FragOutput` G-buffer
  shape** `makeSceneFBTargets(emitsGBuffer:true)` expects (slot-1 normal+roughness placeholder,
  mirror `createPipeline` :636) so it binds in any model pass without target-format mismatch.
- EDIT `WebGPUModelPipelineCache.js` — `_errorPipeline` field (ctor ~:1117), lazy
  `_getOrCreateErrorPipeline()` (same presentationFormat/depthFormat/sampleCount/targets as
  createPipeline), wrap `getPipeline`/`getDepthWritePipeline`/`getPickPipeline` create in the
  error scope; on detected error `console.error(...)` + cache the magenta pipeline.

**Approach:** push validation scope → createPipeline → `popErrorScope().then(err => { if (err)
{ log; this._pipelines.set(key, this._getOrCreateErrorPipeline()) } })`. `popErrorScope` is async
→ frame 0 returns the fresh (invalid) pipeline, the `.then` overwrites the cache so frame N+1
binds magenta. Add a force-error debug hook (`window.CesiumWebGPUForcePipelineError` → append a
`garbage_token` to `fullSource` in `_getOrCreateShaderModule`) to fire a real failure.

**Probe:** Edge :8080, load a single glTF model center-screen, run ≥3 frames. With the force flag:
magenta px (R>230,G<40,B>230) in the model bbox > 0. Without: 0 magenta (no regression). Assert
the console error logged.

**Risks:** error pipeline must satisfy the pass target+depth layout or it's invalid too (reuse
`makeSceneFBTargets`/`_depthFormat`/`_sampleCount`); 1-frame async lag (probe waits frames); keep
push/pop tightly paired; `npx gulp build` to gen `ErrorPipeline.js`.

**Blocking Q:** color pass only (MVP) or all variants (pick/velocity/classification)? → **recommend
color-only first.**

---

## C2-21 — FORK-41-HIZ-CONSUME-FLIP — S/M, 1-2 sessions

**Still relevant:** YES (`WebGPUSceneRenderer.ts:939 _hiZConsumeEnabled = false`, live gate :3486;
buggy 4-corner sample `OcclusionTest.wgsl:168-183`).

**Root cause:** the Hi-Z pyramid is a **MAX-depth** reduction (`HiZPyramid.wgsl:57`), depth clears to
FAR (`WebGPUContext.ts:675 _clearDepth=1.0`). The test samples the sphere rect's 4 corners and
takes `maxHiZ`; wherever a box rect overhangs un-drawn background, a corner texel = 1.0 → maxHiZ
pins to ~1.0 → `sphereNearZ > maxHiZ` never fires → `hitRatio=0`. Classic footprint-coverage
failure: a MAX pyramid folds empty-space far-depth into the footprint max. **The "ndcToUV Y-flip
suspicion" is a FALSE alarm** — `OcclusionTest.wgsl:65` matches the fork convention
(`BillboardCollection.wgsl:198`). The consume FLAG is independent: `_hiZLastInput/_hiZLastFiltered`
accumulate pre-gate (:3480), so the WGSL fix makes `hitRatio>0` measurable while the flag stays false.

**Files:** `OcclusionTest.wgsl` — replace the 4-corner sample with a bounded NxN (N=4) footprint
grid at a mip biased one finer (`max(0, computeMipLevel-1)`), tracking `footprintMax` + an
`anyBackground` flag (texel ≥ FAR_EPS=0.9999). New rule: `anyBackground → visible`; else
`sphereNearZ > footprintMax → occluded`; else visible (strictly cull provably-hidden geometry →
pixels unchanged). Then (gated 2nd step) flip `WebGPUSceneRenderer.ts:939` to true.

**Probe:** reuse `probe-fork41-occlusion.mjs` (3600 boxes, globe off). (A) default flag: existing
4 SAFE checks still pass + INFO hitRatio now >0. (B) consume-on variant: hitRatio>0 (back rows
dropped) AND mismatchPct ≤1.5% vs the no-cull baseline (PNGs identical). Read the 3 PNGs — a
false-cull shows as box-shaped regions in the diff.

**Risks:** FAR_EPS tuning (0.9999); 1-frame latency (HiZ consumes prior-frame readback) — keep the
conservative `anyBackground→visible` rule; mip-bias clamp [0, pyramidMips-1].

**Policy:** ship the WGSL math fix; flip the default ONLY if the consume-on probe proves
pixel-safe — else keep gated. (Default conservative per FORK-41 guidance.)

---

## C2-23 — DP-H18 depthFailAppearance — M, 1-2 sessions

**Still relevant:** YES (0 `depthFailColor`/`depthFail*` refs in WebGPU renderer/shaders;
`createWebGPUCommands`/`createWebGPUMaterialCommands` never read `primitive._depthFailAppearance`).

**Scope re-verified against live code 2026-06-24** (deferred for a fresh-context implementation —
it's a multi-edit in the critical, heavily-used `createWebGPUCommands` builder, not safe to rush
at tail-of-context): the clone source `PrimitiveBasicColor.wgsl` is a flat RTE-color VS + a
clip/atmosphere FS that returns the interpolated vertex `color` — the depth-fail twin keeps the
identical VS (so it reuses the main color command's vertex buffer) and only changes
`MaterialUniforms` to `{ depthFailColor: vec4 }` + the FS to return `material.depthFailColor`
(after the clip discard, with the LOG_DEPTH FragOut branch preserved). The per-instance depthFail
color is read from `batchTable.getBatchedAttribute(i, primitive._batchTableAttributeIndices.depthFailColor)`
(mirrors the existing main-color read). The depth-fail pipeline twin is the same descriptor as the
color pipeline with `depthStencil.depthCompare:'greater'` + `depthWriteEnabled:false`; emit one
depth-fail command per geometry right AFTER its main command, bound to `[camera, depthFailMaterialUB,
effects]`. `_depthFailAppearance` is set on the primitive (`Primitive.js:158/515`).

**Mirror (WebGL twin fully exists):** `PrimitiveCommandHelpers.js:40-82` (createRenderStates —
`depthTest.func=GREATER`, twoPasses front/back cull), `:84-143` (`_spDepthFail`), `:204-303`
(twin command emit, `*=2` multiplier), `PrimitiveShaderHelpers.js:141-184` (depthFailColor swap)
+ `:406-440` (depthClampVS/FS). `RenderStateToPipelineVariant.ts:103-126` already maps GREATER→'greater'.

**Files:** NEW `Shaders/WebGPU/Primitive/PrimitiveDepthFailColor.wgsl` (clone of PrimitiveBasicColor
VS, FS returns the depthFail color from a small depthFail material UB; reuse `csm_depthClamp`/
`csm_writeDepthClamp` chunks). EDIT `WebGPUPrimitiveCommands.js` — `createWebGPUCommands` (:2204):
detect `_depthFailAppearance`, read per-instance depthFailColor, build a `makeDepthFailPipeline`
variant (`depthCompare:'greater'`, `depthWriteEnabled:false`) + front/back-cull twins when
twoPasses, push the depth-fail command(s) AFTER the main in the same Pass (mirror WebGL interleave),
add `depthFailEnabled` to cache rebuild triggers. Mirror for `createWebGPUMaterialCommands` (:3577).
Keep LOG_DEPTH parity in the twin FS (globe writes log depth).

**Probe:** NEW `probe-depthfail-appearance.mjs`, both backends. Opaque blue box behind an opaque grey
occluder, globe hidden. PASS: occluded region shows RED depth-fail bleed-through; WebGPU redPx within
0.95-1.05 of WebGL (current = 0, hard FAIL); visible silhouette stays BLUE (main unregressed); 0
device errors; read PNGs. + a twoPasses (translucent) variant.

---

## C2-25 — NEW-DYNAMIC-ENVMAP-FULL-SCENE (L, headline) — 3-4 sessions

**Still relevant:** YES. `WebGPUDynamicEnvironmentMapManager.ts:211-222` builds `cache.faceViews`
(6 per-face views) but **nothing consumes them** — the only cube writer is the procedural-sky
compute `runProceduralSkyFill` (:347-522). No real geometry is rendered into the cube.

**Mirror:** `Scene/DynamicEnvironmentMapManager.js:632-762` (WebGL `updateRadianceMap` per-face loop:
ENU frame :664, `u_enuToFixedFrame`/`u_faceDirection`/`u_positionWC` per face via
`CubeMap.getDirection(face)`). Renderers are camera-coupled (`WebGPUSkyAtmosphereRenderer.js:562/632`
reads `frameState.camera.viewMatrix`) → plumbing override view/proj matrices is the bulk of the work.

**Slices:** (1) sky+globe → cube via 6 ENU-derived view/proj (90° FOV) render passes into
`faceViews`, then existing prefilter+SH; gate behind a `captureSceneContent` flag (default off, keep
procedural path). (2) add glTF model + 3D Tiles per-face. (3) change-threshold trigger (camera-moved
→ N km / sun-moved / every-K-frames, reuse `framesSinceUpdate` :299) + mipmap downsample compute +
perf. Likely needs cube `format` `rgba8unorm`→`rgba16float` (:184) for HDR (verify storage-write compat).

**Probe:** mirror-rough metallic glTF sphere (no explicit specularEnvironmentMaps) over terrain + a
tileset; reflection-region RGB stddev > threshold (non-uniform = scene content) vs the procedural-only
smooth-gradient baseline.

**Risks:** globe/model/tiles renderers are camera-coupled → override-matrix plumbing risks regressing
the main pass; RTE 64-bit must use the cube eye; HDR format change vs compute storage-write; 6 full
scene passes/refresh (perf).

**Blocking Q:** reuse `WebGPUSkyAtmosphereRenderer` for the cube sky, or keep compute
`runProceduralSkyFill` as sky + render only opaque geometry over it? → **latter is cheaper/lower-risk
for Slice 1.**

---

## Tier 5 — DP-H46 metadata epic (DP-H46a/b/c) — L, MULTI-DAY, GATE FIRST

**Architectural blocker (the key finding):** the GLSL metadata path is **dynamic** —
`MetadataPipelineStage.process` uses `ShaderBuilder` to synthesize per-model `Metadata`/`MetadataClass`
structs + accessors + `initializeMetadata()`. WebGPU model rendering uses ONE **static** hand-written
`ModelPBRComplete.wgsl` (3430 lines) selected by coarse `ShaderDefine` variants — **there is no
per-model WGSL codegen path.** So arbitrary per-model property names/types can't be struct-generated
the GLSL way without either (a) a WGSL per-model codegen path, or (b) a fixed-budget static carrier.
This should be scoped as a **NEW-WEBGPU-MODEL-STRUCTURAL-METADATA epic** with DP-H46c as its final consumer.

### DP-H46a — property ATTRIBUTES — M-plumbing / L-coupled, consumer-blocked
No `Metadata*.wgsl` exists. Property attributes are extra per-vertex attributes, but the vertex layout
already spans slots 0-8 and Edge caps `maxVertexBuffers=8` (`WebGPUModelPipelineCache.js:462`) → a
generic metadata slot collides. Closest mirror = the **featureId0 attribute path** (ModelPrimitiveGeometry
extract → WebGPUModelRenderer upload → conditional slot 8 → `//>>ifdef MODEL_HAS_FEATURE_ID_0`).
**Hard-blocked on a consumer** (CustomShader-on-WebGPU — `WebGPUModelRenderer.js:2127` warns it's
unsupported — OR the pickMetadata producer). No standalone pixel probe possible.
**Blocking Q:** generic single-slot `Metadata.metadataAttr0` carrier now (mirror featureId0), or wait for
the epic's codegen-vs-static-carrier decision? And which consumer drives it first?

### DP-H46b — property TEXTURES — M, 1.5-2 sessions, prereq DP-H46a
Good news: primitives exist — `csm_unpackTexture.wgsl` (csm_unpackTexture1..4) ports `czm_unpackTexture`,
and the FeatureId-texture path (group 1 bindings 26-32) is an exact mirror of "upload glTF metadata
texture + view + sampler + UBO into group 1" (property-texture bindings would start at 39). Need a
`csm_valueTransform.wgsl` chunk + a `WebGPUModelMetadata.js` (mirror `WebGPUModelFeatureId.js`) +
BGL/define plumbing. WGSL has no ShaderBuilder → codegen must be **templated at pipeline-build time**
(or a fixed metadataStage chunk parameterized by a small UBO: channel mask, offset/scale, normalize max).
Property textures MUST be `rgba8unorm` (linear, not srgb). **Blocking Q:** did DP-H46a land the Metadata
structs + initializeMetadata scaffold? If not, merge a+b into one slice.

### DP-H46c — pickMetadata producer — L, 1-2 sessions AFTER the prereq epic
Consumer half fully shipped + backend-agnostic (Picking.pickMetadata, `WebGPUPickFramebuffer.readCenterPixel`
Batch 285, SceneRenderer routing, MetadataPicking.decodeMetadataValues). **Producer absent:**
`DerivedCommand.createPickMetadataDerivedCommand` short-circuits WebGPU (`DerivedCommand.js:683-688`,
no `shaderProgram.id`); no WGSL metadata-pick variant. Mirror `MetadataPickingPipelineStage.js:39-94`
(the `metadataPickingStage(...)` + 6 `METADATA_PICKING_*` defines). WGSL has no string-replace define
mechanism → the per-pick specialization must be **data-driven** (uniform or pre-baked variant per
property), a real design departure from `getPickMetadataShaderProgram`. **Asset gap:** no zero-dependency
local `EXT_structural_metadata` asset exists (all demos use ion tiles) → needs a new test asset or ion creds.
**Blocking Q:** scope the prereq WGSL structural-metadata pipeline as a separate epic (DP-H46c deferred
until it lands), or plan+execute prereq+consumer as one large item? And is a local test asset in scope?

---

## Open decisions for the user (consolidated)

1. **C2-22:** color pass only (MVP) or all pipeline variants? (recommend color-only first)
2. **C2-21:** keep `_hiZConsumeEnabled` gated if the consume-on probe can't meet the ≤1.5% pixel budget?
   (recommend yes — ship the math fix, gate the flag)
3. **C2-25:** reuse SkyAtmosphereRenderer for the cube sky, or keep the compute sky + render geometry over it?
   (recommend keep compute for Slice 1)
4. **DP-H46:** scope as a NEW-WEBGPU-MODEL-STRUCTURAL-METADATA epic; pick the first consumer
   (CustomShader-on-WebGPU vs pickMetadata); decide WGSL per-model codegen vs fixed static carrier;
   provision a local `EXT_structural_metadata` test asset or use ion.
