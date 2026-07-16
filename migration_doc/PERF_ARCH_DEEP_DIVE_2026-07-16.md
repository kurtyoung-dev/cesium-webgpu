# Performance / Architecture Deep-Dive Register — 2026-07-16

**Independent pass, 2026-07-16**, live tree post-Batch-673 (`main` @ `a54cc06b2a` + working set).
Eleven read-only strata (S1–S11) audited in parallel; every finding below was **deduped against
Sol's register, the 2026-07-11 performance investigation, and the Campaign 9 backlog**
([QUEUE_2026-07-15_CAMPAIGN9.md](QUEUE_2026-07-15_CAMPAIGN9.md), C9-00..29 + FAR-003/107/200/
203/204/208/300/303/306/309/401/405/408/409/503/706/707, and the FIXED/done list). Findings are
tagged **NEW** (not in any register) or **DEEPER-ON-KNOWN** (a known owner exists; this adds
unrecorded mechanics/magnitude). All line anchors were verified against the live tree during the
pass.

Relationship to the active plans: this register **feeds** — does not replace —
[FORK_PERFORMANCE_RTE_VISIBILITY_REMEDIATION_PLAN_2026-07-15.md](FORK_PERFORMANCE_RTE_VISIBILITY_REMEDIATION_PLAN_2026-07-15.md)
and the Campaign 9 queue. §13 lists paste-ready C9 rows; §14 lists next-campaign seeds; §15 is the
reversed-Z (FAR-707) decision dossier verdict; §16 is the TTFF budget + ordered fix plan; §17
flags findings that contradict a current C9 assumption.

**Totals: 70 findings across 11 strata** (S1:6, S2:6, S3:7, S4:7, S5:4, S6:7, S7:7, S8:7, S9:5,
S10:9, S11:5) — 47 NEW, 23 DEEPER-ON-KNOWN.

---

## 1. Ranked top findings (impact-weighted; NEW before DEEPER-ON-KNOWN at equal impact)

| # | Finding | Stratum | Novelty | Kind | Impact | Owner |
|---|---------|---------|---------|------|--------|-------|
| 1 | Every 3D Tiles batch-table primitive emits a **second full-geometry TRANSLUCENT command every frame** (100 % fragment discard); WebGL gates on `styleCommandsNeeded`. Command list ~doubles for tilesets; ~2× triangle throughput; translucent pass never empty | S11-1 | NEW | per-frame | HIGH | NEW → proposed `C9-34` |
| 2 | Three **BV-less environment commands** (SkyAtmosphere/Sun/StarField) force a permanent **2-frustum floor** on every default 3D frame; WebGL runs 1. ×2 on the whole frustum scaffold, altitude-independent, days-scale fix, zero shaders | S7-1 | NEW | per-frame | HIGH | NEW → proposed `C9-30` (pre-slice of FAR-707) |
| 3 | **MSAA-4-by-default × ~10 pass segments** = ~1.6 GB/frame attachment traffic @1080p (7–10× WebGL), incl. ~8 wasted eager per-segment MSAA resolves (~330 MB/frame). Hardware bandwidth ceiling no CPU-side backlog item touches | S4-1/2 | NEW + DEEPER (FAR-405/706) | per-frame | HIGH | FAR-405/706 + NEW containment → proposed `C9-35` |
| 4 | **Gaussian-splat depth sort is a synchronous main-thread JS comparator sort** per ~0.5° of rotation (1M splats ⇒ 1–4 s frozen frame); WebGL uses the async WASM radix worker that already ships in the bundle | S6-1 / S11-2 | NEW | scale-dep | HIGH | NEW → proposed `C9-37` |
| 5 | **Model path has no mipmapping end-to-end**: 30 mip-0-locked material samples + `mipLevelCount:1` textures — ~100× bandwidth waste on minified tiles + visible shimmer; exact bug the globe fixed in Batch 57 | S3-1 | NEW | per-frame | HIGH | NEW → proposed `C9-31` |
| 6 | **TTFF triad**: prewarm still a comment-only no-op + fully serialized boot waterfall + 132-sync/5-async pipeline compile wall ⇒ measured +150–200 ms first frame (5/5 reps) and 2.6× settle iterations | S8-1/2/3 | NEW | load-time | HIGH | NEW → proposed `C9-36` (+`C9-33` for model compile) |
| 7 | **Shared-frontend CPU floor ~4–5 ms avg / 8–10 ms p95 with only ~20 commands** — no reuse tier between skip-frame and recompute-everything; caps the ≥2× goal on CPU-bound hosts at p95 | S1-6 | NEW | per-frame | HIGH | NEW (next-campaign seed; coordinates C9-02/11/17) |
| 8 | **Entity scale is structurally capped on both backends**: dynamic lane = O(N×~35 property calls)/frame, and enabling clustering **forfeits the entire bulk static lane** (the fork's 50–1400× win and clustering are mutually exclusive by construction) | S10-1/8 (+S1-4) | NEW | per-frame | HIGH | NEW (S10-A/S10-F; next-campaign seeds) |
| 9 | **TAA velocity prev-buffers re-upload the whole instance array from CPU every frame** even for static content (1M splats + TAA = 64 MB/frame ≈ caps near 30 fps); a GPU `copyBufferToBuffer` costs zero CPU | S6-2 | NEW | per-frame | HIGH (TAA lanes) | NEW → rider on C9-25/C9-28 → proposed `C9-38` |
| 10 | **ModelPBRComplete is a runtime-flag uber-shader**: 70 `hasFlag` branches, 39-binding group, occupancy set by the clearcoat+sheen+CSM+IBL superset a base-color b3dm never runs; WebGL specializes per material | S3-4 | NEW | per-frame | HIGH | NEW → proposed `C9-32` |
| 11 | Complete **render-in-worker (OffscreenCanvas) stack (1,600+ LOC) exists and the production Viewer cannot reach it** — the only shipped mechanism that structurally raises the main-thread CPU ceiling | S5-3 | NEW | strategic | HIGH | NEW (next-campaign seed) |
| 12 | **Model FR rebuilds the entire command graph per primitive per frame** (~8–12 heap objects/~250 stores; hidden-class re-fork; dictionary-mode string caches); at tiles scale ≈ 2,600 writeBuffers + ~1.7 MB + ~1,000 bind-group builds/frame. WebGL pushes retained commands by reference | S9-1 + S11-4 | DEEPER (C9-17/FAR-309) | per-frame | HIGH | C9-17 (scope extension) |
| 13 | **Default-on log depth writes `frag_depth` in 72 producer WGSL files**, disabling early-Z/Hi-Z on effectively every opaque draw — the real GPU-side content of FAR-707; a pick-fleet stream is currently ADDING log depth to ~15 more producers | S7-3 | DEEPER (FAR-707/H22) | per-frame | HIGH | FAR-707 (spike now, §15) |
| 14 | **Triple geometry residency + double GPU upload** for all model/tile geometry: orphaned loader stub GPUBuffers + forced CPU typedArray retention + FR re-upload at first visible frame (unbudgeted, in-frame) | S11-3 | DEEPER (item 89/FAR-204) | memory + load | HIGH | FAR-204 extension (next-campaign seed) |
| 15 | **Globe tile commands set `dirty=true` every frame**, defeating the Scene derived-command gate: ~600–1,800 shallowClones (~50 K field writes)/frame on the WebGL lane + both lanes' pick frames | S1-1 | DEEPER (C9-11/FAR-309) | per-frame | HIGH-MED | C9-11/FAR-309 (WebGL-lane extension) |
| 16 | **Settle-window attribution**: WebGPU's +1.3–1.7 s to tile-stable is a 2.6× per-frame load-window cost with **zero** main-thread long tasks — main-thread-only fixes will not move `navigationToStableMs`; submit-traffic reduction will | S8-7 | DEEPER (C9-12A/FAR-200) | load-time | HIGH | C9-12A primary / FAR-200 |

Secondary highlights not in the top table: eager MSAA `TEXTURE_BINDING|COPY_SRC` usage flags
defeating framebuffer compression (S4-3), globe-depth RGBA8 pack ×3/frustum incl. the
unconditional DP-H45 repack (S4-5, S7-4), atmosphere 16×4 Nishita march per fragment with LUT
fast-path hard-disabled (S3-2), shadow cast-list second full-commandList sweep (S1-2), FAR-303
ring with exactly one consumer (S6-3), 5/7 WASM bridges dead (S5-2), effects bind-group hit-path
string machinery per tile/model (S9-2), per-primitive 864 B light UB duplication (S11-5).

---

## 2. S1 — Shared frontend CPU (above the backend split) — 6 findings

Measured framing (existing artifact `Tools/visual-regression/output/performance/altitude-track-exact-current-clean-2026-07-15.json`,
canonical moving-altitude track, 19–21 draw commands, i7-3770K): WebGL 3.75–4.99 ms avg / 5.3–8.2 ms
p95 CPU; WebGPU 4.55–4.91 ms avg / 8.5–9.8 ms p95. With ~20 commands the floor is **stage
overhead, not per-command work**.

### S1-1 (DEEPER-ON-KNOWN · per-frame · HIGH-MED) — Globe tile commands set `dirty=true` every frame, defeating the Scene derived-command gate (WebGL lane + pick lanes)
- **Location:** `Scene/GlobeSurfaceTileProviderRendering.js:1929` (dirty), `:1459-1477` (free-list
  recycling root cause); `Scene.js:3269-3323, 5533-5623` (regen); `View.js:524` (trigger);
  `DerivedCommand.js:258-287, 351-393`.
- **Mechanism:** the WebGL globe recycles DrawCommand objects across tiles frame-over-frame, so it
  sets `command.dirty = true` unconditionally; `insertIntoBin` then runs full derived-command
  regeneration for EVERY globe command EVERY frame: logDepth shallowClone + recursive pass + 2
  depth-only shallowClones (~4 clones × ~30 field writes + shader-cache lookups per command).
  ~150 tiles × 3 imagery layers ≈ 1,800 shallowClones (~50 K field writes)/frame; shadows add
  `createCastDerivedCommand` per command per frame; pick mini-frames pay it again. Makes the dirty
  gate decorative for the largest command family and blocks any settled-frame reuse above the split.
- **Fix:** extend C9-11 retained per-tile command identity to the WebGL lane so `dirty` can key off
  tile/imagery/shader revision; or scope regeneration so BV/uniform-value updates don't re-clone
  derived commands. **Owner:** C9-11 / FAR-309 (scope extension to the shared/WebGL lane).

### S1-2 (NEW · scale-dependent · MED) — Shadow cast-list building is a second full-commandList sweep per shadow map per frame, unconditional for both backends since Batch 296
- **Location:** `Scene/SceneRenderer.js:782-864`; `ViewportExecutor.js:46-71`.
- **Mechanism:** with shadows on, every frame loops the ENTIRE commandList again per shadow map:
  duplicate `scene.updateDerivedCommands` call (already run in `insertIntoBin`), per-call
  `shadowedPasses` array literal + `.includes` scan, 1 shadow-volume test + up to 4 cascade
  `isVisible` tests per caster. Duplicates work the PVS sweep already did (which even computes
  shadowNear/Far at `View.js:273-286`). N = 3–5 K commands ⇒ ~15–25 K plane tests + 3–5 K
  redundant derived dirty-checks per frame with one CSM map.
- **Fix:** fold cast-candidate collection into the single `createPotentiallyVisibleSet` sweep with
  a persistent `castShadows` sublist maintained by revision; hoist `shadowedPasses`; drop the
  duplicate `updateDerivedCommands`. **Owner:** NEW (adjacent FAR CSM lanes).

### S1-3 (NEW · per-frame · MED) — Per-moving-frame globe-height plumbing rebuild
- **Location:** `Scene.js:4048-4051, 3984-4004, 3880-3968`; `SceneUtilities.js:45-81`;
  `QuadtreePrimitive.js:205-229, 474-497, 1203` (+2.0 ms time-slice at `:91`).
- **Mechanism:** every camera-moved frame (= 100 % of the canonical campaign): synchronous
  recursive primitive-tree height walk (tileset `getHeight` = collision/BVH query when
  `enableCollision`) + `globe.getHeight` tile descent + teardown/rebuild of the `updateHeight`
  callback web (≥5 closures, walk over all primitives, 2 collection listeners added/removed,
  per-tileset re-registration); the quadtree then propagates one add AND one remove through
  `levelZeroTiles.find` + recursive `tile.updateCustomData` every frame, and `updateHeights`
  re-interpolates under a 2 ms/frame budget. Identical on both backends; part of the 4–5 ms floor.
- **Fix:** persistent camera-height registration updated in place; threshold-gate recompute on
  cartographic delta / containing-tile change; cache last height + tile revision. **Owner:** NEW.

### S1-4 (NEW · scale-dependent · HIGH for entity workloads) — Entity/DataSource visualizers full-poll every clock tick with no constant/dynamic split
- **Location:** `DataSources/DataSourceDisplay.js:302-336`; `BillboardVisualizer.js:~100-195`
  (pattern repeats across ~13 visualizer types); driven from `Widget/CesiumWidget.js:1410`.
- **Mechanism:** every clock tick, every visualizer re-evaluates ~10–20 Property `getValue` chains
  per visualized entity regardless of `ConstantProperty` status. 5 K billboard entities ≈ 75 K+
  property evaluations/frame = multiple ms on both backends, before any backend work. No C9/FAR
  item touches it; invisible on the current benchmark scene (no entities). **See S10-1 for the
  full 10 k-entity mechanics** — this is the same territory surfaced independently; S10 carries
  the deeper record.
- **Fix:** retained dirty-set visualizers — partition entities into constant (re-poll only on
  `definitionChanged`) vs time-dynamic sets; walk only dynamic + dirtied sets per tick. **Owner:** NEW.

### S1-5 (NEW · per-frame, mode-scoped · LOW) — SCENE2D wrap-split frames run the entire shared frontend twice
- **Location:** `ViewportExecutor.js:355-363` (commandList zeroed + full
  `updateAndRenderPrimitives` re-run on second half); `:252/268, :282/299, :314/331`.
- **Mechanism:** command generation is viewport-invariant (only frustum left/right differ per
  half), yet all primitive `update()`s, tileset traversal, globe render, shadow-map update,
  scheduler binning, PVS and derived machinery execute twice on every antimeridian-wrap 2D frame —
  a clean 2× multiplier on every other S1 cost in the fork's weakest mode.
- **Fix:** generate commands once per frame; re-run only culling volume + bin + execute per
  viewport half. **Owner:** NEW.

### S1-6 (NEW · per-frame · HIGH) — No intermediate reuse tier between skip-whole-frame and recompute-everything: ~4–5 ms command-count-independent frontend floor
- **Location:** `Scene.js:4022-4215` (render), `:3342` (updateFrameState), `:3622`
  (updateEnvironment), `:5643` (prePassesUpdate); `ViewportExecutor.js:74-95`; `View.js:193-349`;
  `Renderer/UniformState.js:806-987`; evidence: altitude-track artifact above.
- **Mechanism:** the only gate is the boolean `shouldRender`; once true, a camera-only 2 m move
  re-runs tile selection, environment updates (moon/sun/sky/starfield/specular), height plumbing,
  PVS, preload passes, and ephemeris/uniform work exactly like a content-mutation frame.
  C9-11/C9-17/C9-12 retain *backend* artifacts only; nothing above the split has a revision
  system. At p95 the shared frontend alone exceeds an 8.3 ms 120 Hz budget — backend wins cannot
  buy this back, capping the ≥2× goal on CPU-bound machines.
- **Fix:** frame-delta classification above the split (cameraDelta tier × contentRevision tier):
  camera-only frames reuse environment commands, skip height/preload re-registration and
  re-binning when frustum set + command list are revision-identical; stages become incremental —
  the S1 complement without which retained backend packets are still re-requested from scratch
  every frame. **Owner:** NEW (coordinates with C9-02/C9-11/C9-17). §14 seed.

**S1 clean checks (do not re-audit):** WebGPU command families early-out of
`updateDerivedCommands` (no `derivedCommands` property); FrameState is persistent/reset-by-length;
snapshot/VPT services are O(1) no-ops when disabled; scheduler sort-ids owned by C9-08; no
per-frame listener storm; clock/JulianDate churn is noise.

---

## 3. S2 — Allocation / GC architecture — 6 findings

**Stratum verdict:** the core command loop is allocation-disciplined (executor, sorters, uniform
packers, module-cache keys, PP single-pass stages all verified clean). Residual churn concentrates
in (a) feature-renderer `update()` frontends that rebuild closure/option/identity plumbing every
frame even when settled, and (b) two cache designs that allocate on hits.

### S2-1 (NEW · per-frame · MED) — Collection renderers rebuild resolver closures, options objects, entry arrays, and identity strings every frame even when settled
- **Location:** `WebGPUCollectionCameraUB.js:141-262, 321-336`;
  `WebGPUBillboardRenderer.js:1224-1235, 1275-1289`; `WebGPULabelRenderer.js:1121-1133`;
  `WebGPUPointPrimitiveRenderer.js:1124`; `WebGPUPolylineRenderer.js:488-492` (×material type);
  `WebGPUCloudRenderer.ts:1277`.
- **Mechanism:** `makeResolver` is documented call-once-per-update (per frame). Each call
  allocates the opts literal, a fresh pack arrow closure capturing frameState/modelMatrix, a
  4-element extraEntries array of entry literals, the returned resolver closure, and
  `_keyForExtras` string-builds an identity key via `+=` template concatenation — the same
  identity-string pattern C9-13 bans on terrain. It also unconditionally repacks the full camera
  UB CPU-side with no revision gate. ~16 allocations (~1 KB) per collection per frame
  (~4,800/sec at 60 fps for a 5-collection scene) — the settled-collection zero-work contract
  stops one line above the resolver rebuild.
- **Fix:** cache resolver+opts keyed by the existing `_gen` identity token; numeric-id compare
  instead of the key string (`_idOf` already yields ints); revision-gate the repack. Scope the
  interim fix to not conflict with C9-27's view ring, which deletes the mechanism long-term.
  **Owner:** C9-27-COLLECTION-VIEW-RING-RTE / FAR-309 (add S2 allocation acceptance clause).

### S2-2 (NEW · scale-dependent · MED with shadows) — Shadow cast path builds extraEntries arrays/objects per model command per frame BEFORE the bind-group cache check; CSM ×cascades
- **Location:** `WebGPUShadowMapRenderer.js:1311-1328` (guard at 1333-1338);
  `WebGPUCSMCastPass.ts:516-537` (guard at 544-545); label string per cascade at `:410`.
- **Mechanism:** for every cast command with `extraBindings` (all glTF model casters), the loop
  unconditionally allocates an extraEntries array + `{binding, resource:{buffer}}` pairs, then
  checks the cached `cmd._shadowCastBindGroup(s)` — on the steady-state hit path the fresh array
  and objects are pure garbage. 4-cascade CSM with 100 model casters ≈ 500 arrays + ~1,500
  objects/frame (~120 K allocations/sec).
- **Fix:** hoist the cache check above the field walk; build extraEntries only on miss. One-screen
  change in both files, zero behavior change. **Owner:** NEW (nearest home: C9-17 rider).

### S2-3 (NEW · per-frame · MED with effects) — `WebGPUBindGroupCache` constructs its string key on every lookup including hits; six post-process effects pay caller-side entries arrays + key strings per frame by design
- **Location:** `WebGPUBindGroupCache.ts:182-208`; consumers `WebGPUBloomEffect.ts:285-345`,
  `WebGPUAmbientOcclusionEffect.ts:289-456`, `WebGPUDepthOfFieldEffect.ts:133-173`,
  `WebGPUAutoExposure.ts:316`, `WebGPUGodRayEffect.ts:115`, `WebGPUHeatShimmerEffect.ts:94`; flaw
  self-documented at `WebGPUGlobeBindGroupCache.ts:56-67`.
- **Mechanism:** the cache dedupes the GPUBindGroup but not the key computation: every
  `getOrCreate` allocates a keyParts string array, one template string per entry, a `join("|")`,
  plus the caller builds a 3–6-entry object-literal array just to compute the key on a hit; hits
  also do a delete+set Map reinsertion. The in-repo globe cache docstring explicitly cites this
  contract flaw as why the globe path could not reuse this cache — the effects fleet still runs on
  it. Full stack ≈ 200–450 objects+strings/frame — surfaces exactly on the effects-on lanes where
  WebGPU is meant to differentiate. Distinct from Sol's fixed `WebGPUEffectsStateCache` finding.
- **Fix:** adopt the globe-cache contract for effects: caller-held slot handle or compact key;
  simplest is per-effect cached bind group keyed on (sourceView identity, generation) invalidated
  on resize — the `_executeSinglePassStage` pattern (`WebGPUPostProcessPipeline.ts:1886-1902`).
  **Owner:** NEW (C9-23 rider; consolidation with `WebGPUGlobeBindGroupCache` invited by its own docstring).

### S2-4 (NEW · per-frame · MED-LOW) — TAA resolve creates an uncached GPUBindGroup every frame despite a 2-state parity input tuple
- **Location:** `WebGPUTAAEffect.ts:664-678`; per-frame `Uint32Array` view at `:622`.
- **Mechanism:** every TAA frame builds an 8-entry array + entry objects and calls
  `device.createBindGroup` with no caching. Inputs alternate only with history ping-pong parity —
  exactly two distinct tuples at stable viewport. Verbatim the anti-pattern the fork's own
  `WebGPUBindGroupCache` docstring calls "the dominant memory growth class", un-applied to TAA.
  60 driver-side bind-group allocations/sec + ~12 JS objects + 1 typed-array view/frame.
- **Fix:** two-slot parity cache (`_taaBindGroups[frameIndex & 1]`) invalidated on
  resize/history-realloc/placeholder swap; hoist the Uint32Array view. ~20 lines.
  **Owner:** NEW (S2 rider on C9-29 / item-15 natural-frustum TAA contract).

### S2-5 (DEEPER-ON-KNOWN · per-frame · MED) — Every scene-FB pass reopen rebuilds attachment descriptor arrays twice (map + spread + MRT append) across 16 reopen sites × frustums; plus per-frustum GPUTextureView minting
- **Location:** `WebGPURenderTarget.ts:313-331`; `WebGPUSceneRenderer.ts:1909-1930, 1997-2016`;
  `WebGPUSceneRendererPassRedirect.ts:143-201`; `WebGPUSceneRendererFrustumLoop.ts:301-307, 344-377`.
- **Mechanism:** pass fragmentation is known (FAR-405/706); the un-measured allocation dimension:
  `getColorAttachments` allocates via `.map()` + fresh clearValue object per call, then
  `_resumeScenePass`/`_clearDepthStencil` re-`.map()` with `{...a}` spread per attachment and
  `[...arr, slot1]` MRT append — 2 arrays + 2N objects + closure + descriptor literal per reopen;
  ~6–15 reopens per 2–3-frustum frame ⇒ ~60–180 transient objects/frame just to re-describe
  identical attachments with loadOp flipped to `"load"`. Also `packedDepth.createView()` mints a
  fresh GPUTextureView per frustum per frame, and the 3D-tile depth-update hook closure is
  recreated per frustum per frame. Survives even after FAR-405 reduces reopen count.
- **Fix:** cache one frozen load-variant descriptor pair per framebuffer generation, invalidated
  on resize/MSAA/MRT change; reopen sites pass the stored reference. C9-09's attachment demand
  registry is the natural owner. **Owner:** FAR-405/706 (parent), C9-09, C9-07 sibling.

### S2-6 (NEW · per-pass · LOW) — `executeBatchIndirect` allocates `commands.slice()` per homogeneous run
- **Location:** `WebGPUSceneRenderer.ts:636`.
- **Mechanism:** the indirect fast path (tile-policy gated, default off) copies each homogeneous
  command run into a fresh array purely to pass to `manager.submitBatch(slice)` — garbage created
  by the batching optimization itself; hot the moment FAR-706 default-enables the path.
- **Fix:** change `submitBatch` to take `(commands, start, end)` range indices. Do it before
  FAR-706 promotes indirect batching. **Owner:** FAR-706.

---

## 4. S3 — WGSL shader economics — 7 findings

Surface scale: `GlobeTerrain.wgsl` = 4,513 lines (33 samples, 149 `if`, 28 ifdef blocks);
`ModelPBRComplete.wgsl` = 4,115 lines (63 sample sites, 182 `if`, 70 runtime `hasFlag()`).

### S3-1 (NEW · per-frame · HIGH) — Model path has no mipmapping end-to-end: all material samples mip-0-locked and model textures allocated with `mipLevelCount=1`
- **Location:** `Shaders/WebGPU/Model/ModelPBRComplete.wgsl:2478` (census: 53 `textureSampleLevel`
  — 30 explicit `0.0` LOD — / 10 `textureSampleCompareLevel` / **0** implicit or grad samples);
  `WebGPUModelRenderer.ts:1985-1999` (createTexture without mipLevelCount).
- **Mechanism:** every minified textured model/3D-Tiles fragment gathers from full-res mip 0 with
  near-zero texture-cache locality across up to ~25 sampled textures per fragment; ~2 orders of
  magnitude more DRAM traffic than trilinear from the correct mip, plus visible shimmer. Samplers
  even declare `mipmapFilter:"linear"` (`WebGPUModelPipelineCache.ts:2083`) but textures have 1
  mip and the shader forces LOD 0 (required by non-uniform discards at `:2494/:3469` — the same
  constraint the globe solved in Batch 57 with entry-hoisted gradients + `textureSampleGrad`; the
  model shader never got that fix).
- **Fix:** allocate full mip chains + run the existing MipmapBlit at upload (through the
  ResourcePlan/FAR-200 submit authority per the C9-12A precedent); hoist `dpdx/dpdy(texCoord0/1)`
  at `fragmentMain` entry and convert the ~30 mip-0 material samples to `textureSampleGrad`
  (Batch-57 pattern). Byte-identical for magnified texels.
  **Owner:** NEW → proposed `C9-31-MODEL-TEXTURE-MIP-CHAIN` (distinct from imagery-only C9-12A).

### S3-2 (DEEPER-ON-KNOWN · per-frame · HIGH) — Atmosphere transcendental budget: always-per-fragment 16×4 Nishita march on globe + duplicate unread vertex march + sky march with LUT fast-path hard-disabled
- **Location:** `GlobeTerrain.wgsl:1024-1143` (march; consts `:957-958`), `:4116-4143` (FS
  always-per-fragment call), `:1377-1399` (VS duplicate march feeding `v_atmosphere*` varyings the
  FS never reads); `Environment/SkyAtmosphere.wgsl:372-373, 499-560` + `:59-67` (`useLut=0`
  unconditionally since Batch 247).
- **Mechanism:** whenever fog OR ground atmosphere is enabled (both default-on), every globe
  fragment runs the double-nested ray march (16 primary × 4 light steps at orbit, 4×2 inside
  atmosphere) with per-step ray-sphere sqrt and exp; WebGL only marches per-fragment above ~10 Mm
  and per-vertex below (`PER_FRAGMENT_GROUND_ATMOSPHERE`). The VS additionally runs the identical
  march per vertex for varyings production never consumes (C9-14). Sky-shell pixels run the same
  16×4 march because the inscatter-LUT fast path is packed `useLut=0` (sun-relative re-bake
  deferred: `NEW-ATMOSPHERE-LUT-SUN-RELATIVE`); the globe LUT is consulted only for fog color; the
  analytic fallback can run *in addition* when the LUT sample is near-zero (`:4087-4098`).
- **Quantification:** ~208 scalar exp + 17 sqrt per fragment at orbit, ~36 exp + 5 sqrt near
  ground; at 1080p full-globe ~2.07 M fragments → ~75 M exp/frame near ground, up to ~430 M at
  limb views; vs WebGL near-ground per-vertex cost of ~0.2–0.6 M invocations total (~500×
  multiplier near ground).
- **Fix:** C9-14 fixes the duplication; additionally reintroduce the WebGL distance gate
  (per-vertex below ~10 Mm) and revive the compute inscatter LUT (sun-relative azimuth axis) so
  sky shell + orbit drape become 1–2 LUT samples — `Compute/AtmosphereLUT.wgsl` (816 lines)
  already exists and is dispatched but unconsumed by the two hottest consumers.
  **Owner:** C9-14 (duplication) + NEW sub-item → proposed `C9-14B-ATMOSPHERE-LUT-CONSUMPTION`.

### S3-3 (NEW · per-frame + load-time · MED) — 20 debug-sentinel visualization blocks + 7 bypass predicates compiled into the production globe fragment shader
- **Location:** `GlobeTerrain.wgsl` `fragmentMain` (`:3164-3288, :3675-3683, :4327-4357,
  :4447-4467`; bypass predicate `:3088-3090`).
- **Mechanism:** runtime `tile.time` range checks (not `//>>ifdef`-stripped) keep ~20 early-return
  visualization paths, ~17 extra MRT-writing return sites, and debug-only texture samples resident
  in the compiled binary of the most-executed fragment shader. Uniform branches skip execution but
  not register allocation: peak register pressure and ISA/icache footprint rise, occupancy drops,
  Tint→DXC compile time grows for every globe pipeline variant. WebGL's equivalent debug modes are
  preprocessor-stripped.
- **Fix:** wrap all sentinel blocks under one new ShaderDefine bit (`GLOBE_DEBUG_SENTINELS`) via
  the existing preprocessor; pipeline cache flips the define only when
  `CesiumDebug.globeFragmentDebug` engages. **Owner:** NEW (adjacent to C9-18 in spirit; C9-18 is
  CPU-side only).

### S3-4 (NEW · per-frame · HIGH) — ModelPBRComplete is a runtime-flag uber-shader: 70 `hasFlag` branches, only ~10 compile-time defines, 39-binding monolithic material group — occupancy set by the superset path
- **Location:** `ModelPBRComplete.wgsl:396-448` (39 bindings incl. 25 textures), 70 `hasFlag()`
  sites (`:2474-3475`), runtime skinning/morph/instancing in VS (`:892, :930, :963`).
- **Mechanism:** Tint fully inlines; the backend compiles the union of base PBR + clearcoat +
  sheen + iridescence + anisotropy + transmission/volume + spec-gloss + 9-tap 2-cascade PCF CSM +
  point-light cube shadows + punctual-light loop + Fdez-Aguera IBL/SH/parallax + edge overlay into
  one ISA blob and allocates registers for the worst path. A base-color-only b3dm fragment (the
  majority of any city tileset) runs at the occupancy ceiling of features it never executes. WebGL
  builds per-material specialized GLSL via ShaderBuilder. Secondary: any texture-ready event
  recreates/rebinds the full 39-entry group (widens C9-17 churn).
- **Fix:** promote ~8 highest-separation axes to ShaderDefine bits through the existing
  preprocessor/module cache (`HAS_NORMAL_TEXTURE`, per-KHR-extension bits,
  `HAS_SKINNING/MORPH/INSTANCING` in VS, shadow mode, IBL mode); keep runtime flags for scalar
  factors; secondary relief via `enable f16` for the BRDF core (f16 currently exists only as
  default-off PostProcess variants — zero adoption in the two dominant shaders). **Must land with
  S3-6/async pipelines** (specializing without async multiplies compile events).
  **Owner:** NEW → proposed `C9-32-MODEL-SHADER-SPECIALIZATION-AXES`.

### S3-5 (NEW · scale-dependent · MED) — Always-on TAA/velocity tax in model VS + always-on material varyings in globe VS
- **Location:** `ModelPBRComplete.wgsl:1012-1067` (prev-frame morph→skin→instance chain +
  `previousClipPos`/`currentClipPosForVelocity`, locations 8-9 at `:1501-1502`; no
  `MODEL_HAS_VELOCITY` define exists); `GlobeTerrain.wgsl:1409-1435` (slope/aspect/height
  acos/cross chain + locations 9-11 always emitted; `MATERIAL_APPLY` gates only the FS at `:3701`).
- **Mechanism:** every model vertex re-runs the previous-frame deformation chain (second 4×mat4 =
  256 B storage fetch per skinned vertex, prev morph loop, prev instance transform) and
  interpolates 8 extra scalars regardless of whether TAA/motion vectors are enabled. Globe VS
  always computes 2 acos + 2 cross + 3 normalize + 3 varyings for globe materials unbound by
  default. Combined with the unread `v_atmosphere*` varyings the globe carries 13 interpolant
  locations (~30 scalars) vs WebGL's ~14 scalars default. Terrain: 0.4–0.9 M vertices/frame.
- **Fix:** add `MODEL_HAS_VELOCITY` set only when TAA/motion consumers are active (pipelines
  already rebuild on TAA toggle); extend `MATERIAL_APPLY` to strip the globe VS producer +
  locations 9-11; strip `v_atmosphere*` under C9-14. **Owner:** NEW; adjacent C9-25 + C9-14.

### S3-6 (NEW · load-time + hitches · MED-HIGH) — Model pipeline compilation fully synchronous on the JS thread: 132 sync `createRenderPipeline` sites vs 5 async, on 4 K-line uber-modules
- **Location:** `WebGPUModelPipelineCache.ts:900, 1017, 1091, 1192, 1249` (12 sync sites, zero
  async); repo census 132 sync vs 5 async; the central async cache exists
  (`WebGPURenderPipelineCache.ts:531`) and the globe already uses it
  (`WebGPUGlobeSurfacePipelines.ts:600-620`).
- **Mechanism:** every first-seen variant of the 4,115-line model module (first
  textured/skinned/alpha-masked model, pick/pickHover/metadata-pick/velocity/classification
  entries, HDR/format flips) triggers a full Tint→DXC compile synchronously mid-frame; tileset
  load bursts compile several variants back-to-back — TTFF inflation + the p95/p99 spikes the
  moving-altitude campaign measures. Coupling: S3-4 specialization without async would regress TTFF.
- **Fix:** route model pipelines through the existing central async cache (globe pattern:
  tolerate one-frame null/reuse while cooking) + init-time prewarm of the known-hot variant set
  (module prewarm exists but only compiles shader modules, not pipelines).
  **Owner:** NEW → proposed `C9-33-ASYNC-MODEL-PIPELINES` (see also S5-1, S8-3 — same axis
  surfaced by three strata).

### S3-7 (NEW · per-frame + descriptor width · MED) — Globe imagery layout shaped for the 16-layer worst case on all capable devices
- **Location:** `GlobeTerrain.wgsl:402-429` (16 dayTexture bindings), `:3455-3668` (16
  hand-unrolled composite blocks each inlining the full `applyImageryLayer` effect chain);
  `WebGPUGlobeSurfaceRenderer.ts:280-292` (narrow `GLOBE_IMAGERY_REDUCED` variant selected only by
  device limit, never by scene state).
- **Mechanism:** desktop GPUs always get the 16-wide layout though the default scene has 1 imagery
  layer: (a) 16 inlined copies of the per-layer effect chain (~200+ lines each) compound the
  register-pressure ceiling from S3-2/S3-3 on the same entry point; (b) every tile bind group
  carries 16 texture-view entries (15 identical placeholders), multiplying the per-tile descriptor
  cost C9-11 targets and the 513× realization blast radius C9-12A measured; (c) the effect chain
  runs per fragment even at all-default scalars, which WebGL compiles out per-layer via defines.
- **Fix:** select layout tranche (1/4/16 slots) by revision-keyed scene state (the CPU multi-pass
  slicer already caps layerCount per pass), or move imagery to `texture_2d_array` per level-stack;
  add a `LAYER_EFFECTS` define compiling out the chain at default scalars.
  **Owner:** NEW; feeds C9-11/C9-12A (retained descriptors get 16× narrower).

**S3 clean checks:** globe group-0 UBs already use dynamic offsets; globe imagery LOD correct
since Batch 57; ocean wave-normal mip-0 lock minor (small tiled texture); clipping loops zero-work
when off.

---

## 5. S4 — Pass / bandwidth topology — 7 findings

Structural baseline: `Scene.js:488` defaults `msaaSamples = 4`; the WebGPU scene FB is 4×
multisampled `bgra8unorm` + `depth24plus-stencil8` with `depthSamplable:true`
(`WebGPUSceneFramebuffer.ts:325-333`); **~10 scene-FB pass segments/frame on a plain globe view,
13–19 with tiles + classification**; every resume reloads color+depth+stencil.

### S4-1 (NEW · per-frame · HIGH) — Eager MSAA resolve attached to every scene-pass segment (~8 redundant full-frame resolves/frame)
- **Location:** `WebGPURenderTarget.ts:316-330` (resolveTarget baked into `getColorAttachments`);
  consumed by `WebGPUSceneRendererPassRedirect.ts:143`, `WebGPUSceneRenderer.ts:1907-1912`
  (`_resumeScenePass`), `:1995-2000` (`_clearDepthStencil`).
- **Mechanism:** `getColorAttachments()` unconditionally sets resolveTarget when MSAA is on, and
  all three scene-pass open paths use it. WebGPU executes a full multisample resolve at every
  `pass.end()`; with ~10 segments/frame the frame performs ~10 full-frame MSAA resolves of which
  at most 2 are consumed (refraction capture, post-process input). ~8 wasted resolves ×
  (33.2 MB read + 8.3 MB write) ≈ **330 MB/frame** @1080p SDR MSAA4 default; 500+ MB on tile scenes.
- **Fix:** add a `resolve:boolean` parameter to `getColorAttachments()`; intermediate segments use
  `storeOp:"store"` without resolveTarget; attach the resolve only on segments preceding a
  resolved-color consumer. Zero visual change. **Owner:** FAR-405/706 lane — new sub-item (→ `C9-35`).

### S4-2 (DEEPER-ON-KNOWN · per-frame · HIGH) — MSAA-4-by-default turns every pass boundary into a ~150 MB round trip: ~1.6 GB/frame attachment traffic at 1080p (7–10× WebGL)
- **Location:** `Scene.js:488`; `WebGPUSceneRenderer.ts:1403-1413` (bridge), `:1909-1919` (resume
  loads color+depth+stencil); `WebGPURenderTarget.ts:353-380` (store defaults);
  `WebGPUSceneFramebuffer.ts:325-333` (`depthSamplable:true` forces depth store).
- **Mechanism:** pass fragmentation is known (FAR-405/706) as a boundary-*count* problem; the
  unregistered multiplier is that WebGPU runs 4× MSAA by default with depth storeOp:store and
  stencil store/load defaults of store, so each of the ~10 boundaries is a full multisampled round
  trip: 33.2 MB MSAA color store + 33.2 MB reload + 41.5 MB D24S8@4× store + 41.5 MB reload +
  eager resolve. WebGL pays none of this (mid-frame `gl.clear(DEPTH)` is an in-pass fast-clear;
  one resolve/frame). Budget table (full version in the S4 section file): **≈1,640 MB/frame raw
  @1080p ⇒ ~49 GB/s at 30 fps**; WebGL equivalent ~150–250 MB/frame; quadratic in resolution
  (~6.6 GB/frame at 4K). Survives every CPU-side C9 fix untouched.
- **Fix (layered):** (1) FAR-405 boundary reduction now saves ~150 MB each — raises its priority;
  (2) containment: default WebGPU `msaaSamples` to 1 until pass consolidation lands (one line,
  release-noted); (3) `depthStoreOp/stencilStoreOp:"discard"` on the final scene segment
  (consumers read the packed RGBA copy / r16float resolve); (4) stencil-less depth format on
  frames with no classification/stencil commands.
  **Owner:** FAR-405/706 + NEW containment item (→ `C9-35`); not covered by C9-24..29.

### S4-3 (NEW · per-frame · MED-HIGH) — MSAA color textures allocated with `TEXTURE_BINDING|COPY_SRC` — worst-case layout; the correct transient discipline exists in-repo but the scene FB never uses it
- **Location:** `WebGPURenderTarget.ts:135-139` (single usage mask), `:162-168` (applied to the
  sampleCount:4 texture); correct pattern unused by scene FB at
  `WebGPUFramebufferManager.ts:285-297, 378-389`.
- **Mechanism:** COPY_SRC on MSAA is unusable in WebGPU and TEXTURE_BINDING on 4× scene color is
  never exercised; declaring them forces sample/copy-compatible layouts that on several drivers
  disable or degrade framebuffer compression on the attachment — multiplying EVERY draw's color
  traffic, not just boundary traffic (potential 1.5–2× compression loss, driver-dependent).
- **Fix:** per-texture usage in `createTextures()`: multisampled color gets RENDER_ATTACHMENT only
  (+transient once topology allows discard); TEXTURE_BINDING|COPY_SRC only on the single-sample
  resolve texture. Mechanical. **Owner:** NEW (FAR-405 companion; → `C9-35`).

### S4-4 (NEW · per-frame · MED) — Unconditional per-frame fullscreen MSAA depth resolve with no consumer gating, funneled through r16float
- **Location:** `WebGPUSceneRendererPostFrustumChain.ts:114-121` (ungated dispatch +
  `endCurrentRenderPass`); `WebGPURenderTarget.ts:259-277, 291-305`.
- **Mechanism:** because MSAA is default-on, every frame dispatches a fullscreen pass reading
  sample 0 of 4× depth into a 2.07 Mpx r16float target plus one pass boundary — yet all consumers
  of the resolved view (env effects, AO, DoF, deferred G-buffer) are opt-in and off by default:
  ~12 MB/frame + a ~75 MB boundary producing an unread texture on the default path. Secondary:
  r16float (10-bit mantissa) quantizes depth for AO/DoF/SSR when consumers ARE on — a baked-in
  quality ceiling.
- **Fix:** gate the dispatch on the consumer set (the `_anyEnvEffectEnabled` pattern at
  `PostFrustumChain.ts:222-255`); longer term resolve to depth32float + `textureLoad` consumers.
  **Owner:** NEW (adjacent C9-09/10 philosophy, different pass; → `C9-35`).

### S4-5 (NEW · per-frame · MED) — Globe-depth RGBA8 pack chain runs up to 3× per frustum, each costing two scene-pass boundaries
- **Location:** `WebGPUSceneRendererFrustumLoop.ts:278-309` (post-globe), `:343-378` (post-tiles),
  `:447-468` (post-OPAQUE DP-H45 repack — fires when OPAQUE>0 or VOXELS>0 or `clearGlobeDepth`,
  and `scene._picking` exists — essentially always); `WebGPUGlobeDepth.ts:377-416`;
  `FrustumLoop.ts:307` (per-frustum createView churn).
- **Mechanism:** on a 3-frustum tile scene the frame records up to 9 fullscreen depth→RGBA8 pack
  passes and 18 boundary crossings (each bracketed by end+resume, each a ~150 MB S4-2 round trip),
  feeding a packed texture of which only the final state per frustum is consumed. The post-OPAQUE
  repack exists solely for pickPosition but runs regardless of any pick demand. WebGL does 1–2
  copies/frustum with no boundary penalty and no post-opaque repack (samples live depth).
- **Fix:** make the post-OPAQUE repack demand-driven (arm only when pickPosition/sampleHeight ran
  within N frames — `PickDepth._pendingReadback` plumbing exists); coalesce copy+update into one
  pack/frustum when no mid-frustum classification consumer; hoist createView to resize.
  **Owner:** NEW; touches FAR-107 (demand signal) + FAR-405 (boundary count). See S7-4 for the
  pick-semantics hazard on any count-based gate.

### S4-6 (NEW · per-frame · LOW-MED) — Post-process tail always appends an identity blit even when the final stage could target the canvas directly (SDR)
- **Location:** `WebGPUPostProcessPipeline.ts:1722-1737` (unconditional final `_executeCopyStage`),
  `:740/828/900` (stages compiled against `_intermediateFormat`), `:1636-1643` (comment
  acknowledging the over-call).
- **Mechanism:** in SDR `_intermediateFormat === canvasFormat`, so the last stage (e.g. FXAA)
  could write destView directly, but the chain always routes ping-pong + identity blit: +16.6 MB
  r/w per frame @1080p SDR (+25 MB HDR) whenever any stage is enabled — with FXAA on, a fixed
  +40 % post-process bandwidth tax vs WebGL's direct-to-backbuffer FXAA.
- **Fix:** compile a canvas-format variant for the terminal SDR stage (key `_compileStage` on
  is-terminal); keep the blit for HDR mismatch and the zero-stage copy path. **Owner:** NEW.

### S4-7 (NEW · memory · LOW) — Full-resolution ID render target (rgba8 + private D24S8 depth) allocated unconditionally with zero consumers
- **Location:** `WebGPUSceneFramebuffer.ts:336-343` (allocation), `:264-266` (`idFramebuffer`
  getter — no callers repo-wide), `:349-364` (`clear()` — also uncalled on the WebGPU path).
- **Mechanism:** `update()` always creates the ID target mirroring WebGL SceneFramebuffer
  scaffolding, but no WebGPU pass ever targets or reads it: ~17 MB resident @1080p / ~66 MB @4K,
  reallocated on every resize/HDR/MSAA recreate. Distinct from the known C9-09/10 G-buffer accounting.
- **Fix:** lazy-allocate on first `idTarget/idFramebuffer` access (preserves the Principle-7
  scaffold contract at zero resident cost); cross-check FEATURE_INVENTORY pick-via-ID futures
  before removal. **Owner:** NEW; adjacent C9-15.

**S4 clean checks:** velocity rg16float lazily allocated + pass skipped without velocity commands;
TAA history ping-pong clean; OIT double-gated off; snapshot copy correctly consumer-gated; HDR
prefers rg11b10ufloat when renderable; tonemap/FXAA/auto-exposure defaults correct.

---

## 6. S5 — Workers / async architecture — 4 findings

**Baseline verdict:** the upstream TaskProcessor worker architecture is intact and correctly
extended (terrain decode, KTX2, Draco/I3S/MVT/splat-sorter pools, geometry workers, GPU imagery
reprojection). The "fork broke the worker story" hypothesis is FALSE — three of the four findings
are "the async/off-thread architecture exists in the tree and the hot path doesn't use it".

### S5-1 (NEW · scale-dependent + TTFF · HIGH) — Model/3D-Tiles pipelines and 207 KB WGSL modules compile synchronously at first draw, bypassing the fork's own async pipeline cache
- **Location:** `WebGPUModelPipelineCache.ts:3056-3115` (sync miss path;
  `device.createRenderPipeline` at `:900`, sync module create via `_getOrCreateShaderModule`
  `:2443`); per-model cache instantiation at `WebGPUModelRenderer.ts:3776`; correct async pattern
  already at `WebGPURenderPipelineCache.ts:344-419` (used by the globe).
- **Mechanism:** ~130 sync `createRenderPipeline` sites in 58 files (+~52 sync compute in 25)
  vs 2 subsystems consuming the async cache. The model path compiles a preprocessed variant of
  `ModelPBRComplete.wgsl` (**207,067 bytes**) synchronously inside the draw-command build on every
  cache miss; the first submit referencing it stalls on the GPU-process Tint compile (tens of ms
  per new define-set). The pipeline cache is **per-model**, so streaming N tile contents
  multiplies JS descriptor build + IPC + validation + error-scope per tile. Lands directly in the
  p95/p99 CPU metric Campaign 9's gate measures, on frames already paying tile-arrival costs.
  Documented sync exceptions (capture pass) stay.
- **Fix:** route misses through the central async cache (draw skipped or previous variant reused
  while cooking + AsyncResourceMonitor wakeup, as the globe does); prewarm the model's actual
  variant matrix at model-resources-ready time. **Owner:** NEW → `C9-33` (same axis as S3-6/S8-3).

### S5-2 (NEW · missed acceleration + dead bundle bytes · MED) — WASM acceleration layer is 5/7 dead: full Rust implementations + JS bridges shipped with zero call sites while their target hot paths run pure JS
- **Location (zero importers, verified by import graph):** `Scene/WasmCullBridge.js` (SIMD 6-plane
  frustum cull, threshold=500), `WasmSortBridge.js`, `WasmHeightmapBridge.js`,
  `WasmQuantizedMeshBridge.js`, `WasmMatrixBridge.js`; Rust impls in
  `packages/wasm/src/{frustum_cull,radix_sort,heightmap_tessellator,quantized_mesh,matrix_batch}.rs`;
  barrel exports `packages/engine/index.js:972-978`. Active: WasmRTEBridge, WasmPointCloudBridge.
- **Mechanism:** `WasmCullBridge` was built for the per-command per-frustum cull in the shared
  globe-quadtree/commandList hot path the 2026-07-15 remediation plan names as the regression
  center — never called; the terrain decode workers stay pure JS despite the two terrain bridges
  existing for that exact work. ~1,535 LOC of bridge JS ships un-tree-shakeable in all three
  bundle variants; `WasmArenaSlots` reserves slots 1–4/6 for them.
- **Fix (Principle 7 — do not silently delete):** per-bridge decision — wire WasmCullBridge into
  command/quadtree culling behind its threshold; move heightmap/quantized-mesh bridges inside the
  existing terrain workers; give WasmSortBridge a consumer or retire against the GPU sort
  dispatcher; demote the remainder from the public barrel. **Owner:** NEW (relates to the deferred
  WASM-traversal epic in QUEUE §13; actionable now without it). §14 seed.

### S5-3 (NEW · strategic · HIGH) — Complete render-in-worker (OffscreenCanvas) stack exists — 1,600+ LOC — and the production Viewer cannot reach it
- **Location:** `Workers/RendererWorker.js` (774 LOC: in-worker Scene + RAF + device-loss
  recovery), `Services/WorkerSceneHost.js` (835 LOC) + `WorkerSceneProtocol.js`; sole consumer
  `Apps/WebGPUTest/worker-renderers.html`.
- **Mechanism:** the fork's measured cap is main-thread CPU in `Scene.render` (campaign profile
  artifact, 8-thread i7-3770K host). A fully-built worker-thread renderer would remove
  DOM/widget/input contention from the encode thread and add real parallelism — the only shipped
  mechanism that structurally raises the CPU ceiling rather than shaving per-site costs — but no
  Viewer/widgets integration path exists (grep of packages/widgets + Apps/CesiumViewer: empty), so
  it delivers zero benefit and will drift as Scene APIs evolve.
- **Fix:** first add a worker lane to the moving-altitude benchmark harness to quantify the delta;
  if it holds, productize as opt-in `Viewer({useWorkerRenderer:true})` with a documented feature
  subset; either way stop the drift by exercising it in CI/probes. **Owner:** NEW. §14 seed.

### S5-4 (DEEPER-ON-KNOWN · scale-dependent · LOW-MED) — Per-tile terrain post-processing re-does worker-computable scans on the render thread
- **Location:** `WebGPUGlobeSurfaceTileBuffers.ts:185-187` (Uint8→Uint16 index up-conversion),
  `:205-208` and `:277-280` (two full max-index scans per tile build);
  `WebGPUGlobeSurfaceTextures.ts:504-508` (water-mask row-flip loop).
- **Mechanism:** every tile-buffer cache miss runs 2× O(indexCount) JS scans plus a possible
  O(indexCount) copy on the main thread for stride validation the terrain workers could precompute
  and ship as scalars on the mesh; WebGL consumes worker output into VertexArray without
  re-scanning. ~25–40 K indices standard, 100 K+ dense; dozens of tile builds/sec during descent —
  spikes on exactly the frames already paying C9-11/C9-12 and S5-1 costs. Distinct data-scan
  mechanism, not previously recorded under C9-11.
- **Fix:** compute maxIndex/corrected stride in the terrain workers or at TerrainFillMesh build;
  up-convert Uint8 indices at TerrainFillMesh creation; fold the water-mask flip into worker-side
  mask handling. **Owner:** C9-11 (extend claim boundary) or a small standalone slice.

**S5 minor/clean:** MVT decoder's non-transferred input + sync fallback is a documented tradeoff;
AutoExposure readback ring correct; Naga transpiler lazy + scoped.

---

## 7. S6 — Upload / streaming paths — 7 findings

Census: `writeBuffer` 324×/104 files; `writeTexture` 73×/38; `copyExternalImageToTexture` 58×/24;
`mappedAtCreation` used nowhere live; ~60 `queue.submit` sites. Texture-path verdict: structurally
sound (ImageBitmap fast paths, GPU reprojection, no 256-byte row repack waste). **No additional
always-on per-frame GPU→CPU readback exists beyond the known set.** The problems are buffer-side.

### S6-1 (NEW · scale-dependent · HIGH) — Gaussian splat depth sort is a synchronous main-thread JS comparator sort (WebGL uses a WASM worker)
- **Location:** `WebGPUGaussianSplatRenderer.ts:906-979` (`maybeSortSplats`; comparator sort
  `:974`, upload `:979`); WebGL parity path `Scene/GaussianSplatSorter.js:58-68`.
- **Mechanism:** Batch 288 re-sorts splat indices with `Array.prototype.sort` + JS comparator
  inside the render loop every ~0.5° of camera rotation, plus a fresh `Float64Array(count)` per
  sort and a full count×4 B index re-upload. Upstream/WebGL runs the identical job off-thread via
  GaussianSplatSorter (TaskProcessor worker + WASM radix). The in-tree
  `WebGPUGPUSortKeysDispatcher` is not consumed by the splat renderer; `sortRequestPending` async
  scaffolding exists unused. 1 M splats: ~20–40 M comparator invocations per re-sort
  (~300–1000 ms+ main-thread stall) + 8 MB alloc, re-fired continuously during orbit; 100 K splats
  still ~100–300 ms. Secondary: the full 64 B/splat CPU `splatData` copy is retained permanently
  (64 MB at 1 M) solely to feed the sort. Directly produces the "WebGPU 30 fps while WebGL coasts"
  shape — actually per-rotation *hitches*, worse than an fps cap.
- **Fix:** consume the existing GaussianSplatSorter worker (one-frame-stale result into
  `sortedIndexBuffer`, fills the `sortRequestPending` scaffolding) or a GPU radix/bitonic sort
  writing `sortedIndexBuffer` on-device (no readback — the consumer is the VS); at minimum reuse
  the depth array + key-packed TypedArray sort. **Owner:** NEW → proposed `C9-37`
  (adjacent FAR-003/503 GPU-sort infra; WebGL parity asset already in-tree). = S11-2.

### S6-2 (NEW · per-frame, TAA-gated · HIGH at scale) — TAA velocity prev-buffers re-upload the entire instance array from CPU every frame, even for provably static content
- **Location:** `WebGPUPointCloudRenderer.ts:1736-1744` and `:2082-2090` (40 B/point);
  `WebGPUGaussianSplatRenderer.ts:1644-1652` (64 B/splat); `WebGPUCloudRenderer.ts:1421-1429`
  (68 B/instance).
- **Mechanism:** the Batch 143/148/168/172 velocity pattern writeBuffers the full prev CPU mirror
  each TAA frame with no identity/version skip; the code's own comments state
  `prevInstanceData === instanceData` for static content, so identical bytes (already
  GPU-resident) are memcpy'd through the queue staging heap every frame. A GPU
  `copyBufferToBuffer(curr→prev)` or ping-pong swap would cost zero CPU bandwidth.
  Billboard/Label/Point migrated to dirty-range `WebGPUResidentInstanceBuffer`; these three never
  did. 1 M splats + TAA: **64 MB/frame (~3.8 GB/s at 60 fps, ~6–13 ms main-thread memcpy — alone
  caps near 30 fps)**; 1 M-point PNTS: 40 MB/frame. TAA defaults false so default benchmarks miss
  it, but any "≥2× with TAA" claim on point/splat content hits this wall.
- **Fix:** skip upload when prev reference+revision unchanged (static → zero uploads after first
  seed); animated content records `copyBufferToBuffer` into the main encoder or double-buffer
  swap. Ride the C9-25/C9-28 velocity/RTE rewrites which touch these exact paths.
  **Owner:** NEW → proposed `C9-38` (fold-in candidate: C9-25/FAR-306 + C9-28).

### S6-3 (DEEPER-ON-KNOWN · per-frame · MED) — FAR-303 staged uniform ring has exactly one consumer (globe camera UB); the rest of the frame fans out 100–500+ individual per-object writeBuffer calls
- **Location:** ring `WebGPUContext.ts:4654-4666`, flush `:2185`; sole consumer
  `WebGPUGlobeSurfaceCameraUB.ts:1046`. Fan-out: `WebGPUPrimitiveCommands.ts:1563-1660` (per-command
  per-frame camera UB writes at `:1595/:1651/:1660`), polyline `:2100/:2602`;
  `WebGPUGaussianSplatRenderer.ts:1383-1435` (5 offset-writes to one UBO/frame).
- **Mechanism:** `updateWebGPUCommandUniforms` is documented "called every frame" and issues one
  208–352 B writeBuffer + full RTE matrix pack per Primitive draw command per frame; every
  collection/effect adds 1–2 more. Each writeBuffer costs ~1–3 µs Dawn validation + staging copy +
  fence tracking; none of it is coalesced by the ring whose proven 87 %-fewer-writes win stopped
  at terrain. 200 geometry primitives ≈ 0.4–1 ms CPU/frame before drawing; busy scenes 500+ calls
  (~1–2 ms).
- **Fix:** extend the ring + dynamic-offset bind pattern (proven on terrain) to Primitive/Polyline
  camera UBs and collection/effect uniforms; fold multi-offset writes into single ranged writes.
  **Owner:** C9-12 / FAR-303 (extension beyond terrain — candidate new sub-item).

### S6-4 (NEW · memory, latent · LOW-MED) — `WebGPUBufferMapper` staging/readback cache never repopulates: every call leaks a GPUBuffer and issues a private mid-frame submit; PerformanceManager call site silently drops its offset arg
- **Location:** `WebGPUBufferMapper.ts:235-277` (caches only drained, never pushed), `:282-294`,
  `:156/:189` (submit per call); `WebGPUPerformanceManager.ts:686` (numeric offset passed as
  options object → destOffset undefined → writes land at 0); `WebGPUBuffer.ts:147`
  (`mappedAtCreation`+data silently drops data).
- **Mechanism:** the designated efficient large-upload/readback path allocates a fresh
  MAP_WRITE/MAP_READ buffer per call that lives until context destroy; today near-unwired
  scaffolding (only PerformanceManager reaches it) so live impact is low, but it is the API future
  streaming work will adopt and it fails exactly at scale.
- **Fix:** return buffers to the caches after unmap (or retire the class after a Principle-7
  check); fix the PerformanceManager arg shape; make `mappedAtCreation`+data write or throw.
  **Owner:** NEW (adjacent FAR-200).

### S6-5 (NEW · scale-dependent · LOW-MED) — EntityCluster GPU grid pays CPU-zero-fill buffer clears, a private mid-frame submit, and a double-copy 3-buffer readback per clustering dispatch
- **Location:** `WebGPUEntityClusterDispatcher.ts:280-299` (writeBuffer of zeroed CPU arrays as
  clears), `:343` (private submit), `:351-369` (3× mapAsync + double Uint32Array copy); cadence
  `EntityCluster.js:699-709`.
- **Mechanism:** clears grid buffers by uploading CPU-zeroed arrays instead of
  `encoder.clearBuffer()`; dispatches on a dedicated encoder+submit splitting the frame command
  stream; decodes each mapped range with a redundant second copy. Rides the busiest interaction
  path (camera motion) alongside the pick mini-frame and imagery churn. 50 K points on a 128×64
  grid: ~260 KB readback + ~65 KB zero-fill upload + 1 extra command buffer per dispatch.
- **Fix:** clearBuffer; record compute into the main frame encoder; single-copy decode.
  **Owner:** NEW (folds into FAR-200 consolidation).

### S6-6 (NEW · load/streaming-time · MED for voxels) — Voxel tile streaming does per-tile CPU RGBA expansion + scalar DataView half-float conversion on the main thread, re-paid on every LRU re-entry
- **Location:** `WebGPUVoxelDataUpload.ts:385-402` (`expandToRGBA` fresh alloc), `:408-428`
  (`toHalfFloat` DataView per element), call sites `:541, :772-780, :1083-1090`.
- **Mechanism:** every streamed voxel tile allocates 1–2 full-tile arrays and, on devices without
  float32-filterable, converts every channel via a DataView setFloat32/getUint32 round-trip — the
  slowest f32→f16 path — serialized inside the renderer's per-frame update. LRU retains only raw
  metadata, so re-demanded tiles re-pay the full conversion. Padded 64³ tile ≈ 1.05 M float writes
  + 1.05 M DataView round-trips ≈ 10–30 ms main-thread per tile; deep-octree zooms stream dozens →
  visible hitching the WebGL megatexture path avoids.
- **Fix:** reuse tile-sized scratch; bit-twiddling/Float16Array conversion or upload f32 + small
  compute pack; optionally cache converted payloads for LRU re-entries. **Owner:** NEW (voxel epic
  family; no C9 row owns upload CPU cost).

### S6-7 (DEEPER-ON-KNOWN · per-frame, feature-gated · LOW-MED) — FAR-200 submit-site classification: only three per-frame mid-frame private submitters remain, all feature-gated (Ocean FFT, Weather, EntityCluster)
- **Location:** `WebGPUOceanRenderer.ts:848` (~35 compute passes/frame in a private submit);
  `WebGPUWeatherRenderer.ts:373-396`; `WebGPUEntityClusterDispatcher.ts:343`; contrast fixed
  main-encoder patterns at `WebGPUSSREffect.ts:303-325`, `WebGPUNPROutlineEffect.ts:213-234`,
  `WebGPUVolumetricFogRenderer.ts:1282-1290`, `WebGPUProceduralCloudRenderer.ts:2578-2580`.
- **Mechanism:** classified all ~60 submit sites: the Batch 127/420 main-encoder consolidation
  genuinely fixed the default path; remaining per-frame private submits are Ocean, Weather, and
  the cluster dispatcher. Everything else is init/rare, on-demand, or known (C9-12A). Also
  verified clean: no additional always-on per-frame readback beyond the known set.
- **Fix:** move Ocean/Weather/Cluster onto the main frame encoder (fog/clouds pattern) before
  FAR-200's timeline authority lands; leave init-time submits alone. **Owner:** FAR-200.

**S6 clean checks:** resident-instance dirty-range coalescing healthy;
`WebGPUVertexArrayFacade` has zero importers (scaffolding, left per Principle 7).

---

## 8. S7 — Multi-frustum tax & reversed-Z (FAR-707 dossier) — 7 findings

> **Dossier verdict is in §15.** This section carries the findings. Note: S7 was re-verified in a
> second pass that **corrected the first draft's "already single-frustum" conclusion** (it used
> pre-override frustum defaults 1.0/5e8 and pick-pass-only "frustum 0" labels; the live override
> `Scene.js:1419-1422` sets 0.1/1e10 and the main-loop passes carry no frustum index).

### S7-1 (NEW · per-frame · HIGH) — Three BV-less WebGPU environment commands (SkyAtmosphere, Sun, StarField) force a permanent 2-frustum floor on every default 3D render frame; WebGL runs 1
- **Location:** `WebGPUSkyAtmosphereRenderer.js:1340-1354`; `WebGPUEnvironmentRenderer.js:612-621`;
  `WebGPUStarFieldRenderer.ts:617-626`; `Scene/View.js:291-298, 449`; `Scene/Scene.js:1419-1422`.
- **Mechanism:** the fork's env feature renderers push commands into `frameState.commandList`
  (Batch 247 dual-path convention) without `boundingVolume`. `createPotentiallyVisibleSet`'s no-BV
  branch widens near/far to the log-depth camera range [0.1, 1e10] (the Scene.js override, which
  the pushes survive to reach — commandList is only cleared in updateFrameState, before
  updateEnvironment), giving ratio 1e11 > `farToNearRatio` 1e9 → **numFrustums = 2 at EVERY
  altitude** of the canonical route (content alone would give 1: horizon cap ~4.6e7 m). WebGL
  executes the same commands via environmentState, unbinned → 1 frustum. The far band [1e8, 1e10]
  contains only sky commands but pays the full per-frustum scaffold. In-tree precedent: Batch 268
  fixed the identical mechanism for globe tiles in SCENE2D
  (`GlobeSurfaceTileProviderRendering.js:941-961`). Note: 3 frusta are unreachable in 3D log-depth
  (needs ratio > 1e18) — "2 vs 3" resolves to "2 vs 1".
- **Quantification:** ×2 on the entire frustum-loop scaffold: +~6 full-target pass boundaries,
  +2 fullscreen depth-pack draws (~2.1 M pack fragments @1080p), +1 aux 65 K-object GPU culler
  (2.8 MB + dispatch + readback), +1 duplicate camera-UB write + bind group per visible
  collection, +1 pick-loop frustum walk — per frame, altitude-independent, WebGPU-only.
- **Fix:** exclude `Pass.ENVIRONMENT` / BV-less-by-design commands from the near/far accumulation
  (with `numFrustums = max(1, …)` fallback for sky-only views), or attach honest bounding volumes
  (atmosphere shell = 1.025× ellipsoid BS). Zero shader changes; days-scale. Add a `numFrustums`
  route-telemetry counter to guard the invariant thereafter.
  **Owner:** NEW → proposed `C9-30` (pre-slice of FAR-707; multiplies FAR-405/C9-07 value).

### S7-2 (DEEPER-ON-KNOWN · per-frame · HIGH) — Per-frustum fixed pass scaffold: ~6 full-target pass boundaries + 2 content-ungated fullscreen depth packs per frustum, paid twice under the 2-frusta floor including for the sky-only far band
- **Location:** `WebGPUSceneRendererFrustumLoop.ts:251-309, 324-329, 447-468`;
  `WebGPUSceneRenderer.ts:1900-2029`; `WebGPUGlobeDepth.ts:377-416`.
- **Mechanism:** the globe-depth pack is gated only on `useGlobeDepthFramebuffer`, not on the
  frustum's globe command count; the `clearGlobeDepth` second clear and DP-H45 post-opaque re-pack
  are frame-level-flag gated and `clearGlobeDepth` defaults TRUE. Each clear/resume rebuilds full
  descriptors and re-attaches rgba16float color + MRT slot-1 + depth24plus-stencil8. WebGL's
  per-frustum equivalent is `gl.clear` + one copyDepth; DP-H45 has no WebGL counterpart.
  **~12 scene-FB pass boundaries + 4 fullscreen RGBA8 depth packs per default frame from the loop
  alone** (≈4.1 M pack-fragment invocations @1080p, 16.6 M @4K); ~25–40 MB attachment traffic per
  boundary ⇒ ~300–480 MB/frame from loop structure, half bought by the empty far band. Render
  bundles (FAR-405/706) cannot recover pass boundaries.
- **Fix:** gate the globe-depth pack on per-frustum globe command count; fold the clearGlobeDepth
  clear into the next natural boundary's `depthLoadOp:"clear"`; DP-H45 via depth-version tracking
  (S7-4); S7-1 halves the remainder. **Owner:** FAR-405/FAR-401 (HP-03), S7-1 as multiplier fix.

### S7-3 (DEEPER-ON-KNOWN · per-frame · HIGH) — Default-on log depth writes `@builtin(frag_depth)` in 72 producer WGSL sources, disabling hardware early-Z/Hi-Z on effectively every opaque draw — the real GPU-side content of FAR-707
- **Location:** `GlobeTerrain.wgsl:3016-3018, 3132-3136`;
  `chunks/functions/csm_writeLogDepth.js:17-20`; `WebGPULogDepth.ts:22-30` (Batch 251 master switch).
- **Mechanism:** the LOG_DEPTH ifdef variant is the production variant in **72 WGSL files**
  (globe, ModelPBRComplete, ~60 primitive material variants, all collections, ocean, moon,
  splats). frag_depth output plus the contract-required near/far discard forfeits early-Z, Hi-Z
  rejection, and depth compression — the GPU shades every occluded fragment; GlobeTerrain samples
  up to 16 imagery layers per fragment, and horizon-oblique views (where fork FPS is weakest) have
  peak overdraw. WebGL pays the same (`gl_FragDepth`) but has no escape; WebGPU's reversed-Z + f32
  + greater-compare escape makes this a ≥2×-goal lever. **Sequencing hazard:**
  `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH` (QUEUE C9 rows 121/134-135) is currently ADDING log frag_depth
  to ~15 more pick producers — the same surface a reversed-Z migration must convert back; no
  document connects the two streams (§17).
- **Fix:** run the cheap half of FAR-707 first: one probe scene compiled with `defines=0` (the
  `//>>else` branch exists everywhere), reversed-Z infinite-far projection, depth32float,
  greater-equal; measure fragment-invocation delta with existing gpuPassCost timestamps BEFORE the
  pick-fleet conversion lands. **Owner:** FAR-707/H22 (owned, unscheduled, unquantified).

### S7-4 (DEEPER-ON-KNOWN · per-frame · MED) — DP-H45 post-opaque depth re-pack fires every frame on the DEFAULT globe because `clearGlobeDepth` defaults true — and a naive count-gate fix would change pick semantics
- **Location:** `WebGPUSceneRendererFrustumLoop.ts:447-468`; `Scene/Scene.js:3740-3743`.
- **Mechanism:** the gate's third disjunct (`config.clearGlobeDepth && !debugDepthViz`) is
  constitutively true at defaults (`depthTestAgainstTerrain=false`), so the end-pass → fullscreen
  pack → resume chain runs per frustum with zero opaque/voxel commands, including the sky-only far
  band. **Semantic trap:** the re-pack runs AFTER the mid-frustum clear + depth-plane redraw, so
  the packed texture pickDepth consumes holds cleared+depth-plane depth; the loop's own comment
  (`:453-455`) tracks a "shared packed-depth lifetime issue" — skipping the pack when counts are
  zero would change pick behavior.
- **Fix:** depth-version tracking (FAR-408 shadow-graph vocabulary): monotone version bumped by
  any depth write incl. clears; `executeCopyDepth/executeUpdateDepth` no-op when the packed
  version matches. **Owner:** FAR-408-C0 / `NEW-PICK-WEBGPU-MULTIFRUSTUM-PACKED-DEPTH`
  (normal-frame scope added).

### S7-5 (NEW · per-frame + memory · MED) — Multi-frustum contract machinery paid for identical slice contents: byte-duplicate per-slice camera UBs for every collection renderer + a 65 K-object aux GPU culler per extra frustum
- **Location:** `WebGPUCollectionCameraUB.js:141-262`; `WebGPUContextCullerPool.ts:159-217`;
  `WebGPUGPUCuller.ts:254-316`.
- **Mechanism:** in 3D `repackPerSlice=false`, so slice-N camera-UB content is byte-identical to
  slice-0; distinct buffers exist only for writeBuffer-vs-encoder ordering. Every visible
  collection (Point/Billboard/Label/Polyline/Cloud/GroundPrimitive/Vector3DTile) therefore uploads
  a duplicate UB + bind group per extra frustum per frame, packs the camera twice even
  single-frustum (static bake + slice copy), and runs a resolver closure per draw. Separately,
  frustum idx ≥1 gets a dedicated 65,536-object GPU culler (≈2.8 MB VRAM) with its own dispatch +
  readback — always allocated under the S7-1 floor for a band holding only sky commands (the
  FAR-003/503 readback finding never counted the per-frustum instance pool).
- **Fix:** S7-1 collapses to the static-bake fallback and removes the aux culler; independently,
  reuse the static buffer when `repackPerSlice===false` and size/skip aux cullers by the band's
  actual command count. **Owner:** NEW (adjacent C9-17 and FAR-003/503, different mechanisms).

### S7-6 (NEW · scale-dependent · MED) — The modes where frustum count genuinely multiplies (SCENE2D uniform bands up to ~16; orthographic 3D at 3 bands) are exactly the modes reversed-Z cannot help
- **Location:** `View.js:438-446`; `Scene.js:3377-3382`; `WebGPUSceneRendererFrustumLoop.ts:183-214`.
- **Mechanism:** SCENE2D uses a uniform 1.75e6-m band split; any BV-less binned command collapses
  near to `frustum.near` and pushes the count toward ~16 at full-earth zoom (Batch 268 observed
  1→9 from one BV-less producer), and each band pays a FULL `uniformState.update` (unique to 2D) +
  the entire per-frustum scaffold + per-band collection-UB repack (`repackPerSlice=true`).
  Ortho 3D force-disables log depth → farToNearRatio=1000 → 3 bands, with band-spanning commands
  re-encoded per band. Reversed-Z redistributes nothing under linear depth, so the frustum loop
  and per-slice machinery can never be *deleted* by FAR-707 — only bypassed in 3D perspective.
  2D worst case ≈ 70+ render passes + ~32 fullscreen packs/frame.
- **Fix:** skip fixed blocks for bands with empty command bins; tight command-extent near/far fit
  for ortho; audit which fork commands still bin BV-less in 2D/CV (ride along with S7-1).
  **Owner:** NEW (C9-02B covered only the depth-plane ring; nothing owns band-count cost).

### S7-7 (DEEPER-ON-KNOWN · per-frame · HIGH) — Reversed-Z (FAR-707) decision dossier: biggest unowned GPU-side lever ONLY after the frustum-count claim is carved out as the cheap S7-1 slice; full blast radius counted
- **Migration surface (counted live):** 140 `depthCompare` flips / 47 files + depth clearValue
  1→0 (pipeline-cache-wide invalidation); 72 producer WGSL surfaces; ~14 consumer families +
  42 `_logDepthEncodeNearFar` JS sites / 18 files + `PickDepth.js:70-260` CPU decode; RGBA8
  fixed-point pack cannot represent reversed-Z far-field (~1e-7 quanta) → pick/classification
  depth moves to r32float or direct sampling; scene FB is depth24plus-stencil8 and classification
  stencil is load-bearing → needs `depth32float-stencil8` (optional feature) with a fallback story
  (a partial fleet = the forbidden dual permanent architecture, plan L906); all-or-nothing landing
  (the pick-fleet mixed-encoding lesson binds equally); TAA `previousViewProjection` convention
  (DP-H41); 2D/CV/ortho carve-out (S7-6).
- **Precision resolved:** reversed-Z f32 with infinite far ≈ 2⁻²⁴·eyeZ → ~2 cm at 350 km, ~0.6 m
  at 10,000 km — equal or better than log depth's own quoted 0.42 m/quantum at 350 km. Precision
  is not the blocker; the contract surface is.
- **The un-owned prize:** with monotone f32 depth the entire RGBA8 pack chain becomes deletable —
  `executeCopyDepth/executeUpdateDepth` collapse to `copyTextureToTexture` or direct depth
  sampling, removing 2–3 fullscreen pack passes/frame + most surrounding boundaries. No FAR/C9
  item currently attributes this to FAR-707.
- **Verdict + sequencing:** see §15. **Owner:** FAR-707 (enriched brief) + NEW pre-slice (S7-1).

---

## 9. S8 — Load-time / TTFF — 7 findings

Measured baseline (repo artifacts, not re-run):
`campaign9-deterministic-offline-boot-edge-r1-2026-07-15.json` — rendererReady→firstFrame
**WebGL 18.1 ms vs WebGPU 163.8 ms (9.1×)**; setupToStable 1139 vs 2718 ms (2.39×).
Corroborated 5 reps (`campaign9-gate-a-clean-r5-2026-07-15.json`): first frame +150–200 ms in
5/5 reps; setupToStable 1102–1306 ms vs 2468–2830 ms; per-settle-iteration 22–25 vs 58–66 ms
(2.6×); long tasks WebGL 7/~800 ms vs **WebGPU 0/0 ms in all 5 reps**.

### S8-1 (NEW · load-time · HIGH) — Pipeline prewarm is still a no-op: `_warmUpPipelines` is comment-only, `preloadBatch` has zero callers, and the 2×239 KB GlobeTerrain shader compile lands inside the first render frame
- **Location:** `WebGPUContext.ts:1084, 1108-1147`; `WebGPURenderPipelineCache.ts:765` (0 callers);
  `WebGPUShaderCache.ts:194` (0 callers); `WebGPUGlobeSurfaceShaders.ts:84-110`;
  `GlobeSurfaceTileProviderRendering.js:857-865`.
- **Mechanism:** context init has an idle async window (device negotiated, terrain/imagery I/O in
  flight, Scene JS still constructing) during which the GPU process is idle. Because
  `_warmUpPipelines` does nothing and the built preloadBatch machinery was never wired, every
  deterministic boot pipeline (PP identity/tonemap/FXAA/auto-exposure, sky, depth plane, globe
  depth) plus two Tint compiles of the **238,857-byte** GlobeTerrain.wgsl land in frame 1; the
  first `queue.submit` waits on the sum of that compile chain. Its own comment claims first-frame
  stutter is imperceptible — falsified by measurement (above). Boot sync set ≈ 6–8 pipelines
  offline, ~14–20 with the default viewer.
- **Fix:** implement fix-path (a) from the comment itself: `warmUpGlobeRenderer(context)` seeding
  `_webgpuGlobeRenderers` + `initialize()` at context init; wire `preloadBatch` for the
  deterministic boot set as one fire-and-forget batch so the GPU process compiles in parallel
  during the init window. **Owner:** NEW → proposed `C9-36` TTFF lane (nearest hook
  `NEW-PERF-DETERMINISTIC-VIEWER-BOOT` is measurement-only).

### S8-2 (NEW · load-time · HIGH) — Fully serialized boot waterfall: 3 MB WebGPU chunk import → requestAdapter → requestDevice → nested inline dynamic import → dead awaits → only then Scene/Globe construction; zero overlap
- **Location:** `ContextFactory.ts:103-107`; `WebGPUContext.ts:967, 1030-1035, 1074-1079`;
  `WebGPUDevicePool.ts:745-793`; `Widget/CesiumWidget.js:770-782`;
  `Build/Cesium/chunks/WebGPUContext-HJWWORRR.js` (797,790 B + 27 chunk imports incl.
  `chunk-NTB6DPQ4.js` 2,251,055 B); `Build/CesiumUnminified/Cesium.js:402953`.
- **Mechanism:** `await import(WebGPUContext)` (ESM: ~3.05 MB minified fetch/parse/eval; IIFE:
  one synchronous tick executing 205 renderer + 322 WGSL-string module initializers) completes
  BEFORE requestAdapter starts; adapter→device completes before a second nested
  `await import(WebGPUPrimitiveIndexUtils)` mid-init; two awaited no-op shader inits follow; and
  Scene/Globe construction (100–300 ms of device-independent main-thread JS) only starts after all
  of it. WebGL starts Scene construction immediately. GPU-process, network, and main-thread lanes
  are concatenated instead of overlapped. Stage 1 (50–250 ms) + stage 2 (30–120 ms) are all
  hideable under Scene construction — the largest recoverable non-compile slice.
- **Fix:** prefetch `requestAdapter` concurrently with the chunk import (Promise.all in
  `defaultCreationHooks.createWebGPU`, or an adapter-prefetch cache in RendererType); hoist the
  inline import; delete the two dead awaits; longer-term construct Scene against a
  deferred-context handle; emit modulepreload hints for the WebGPU chunk set. **Owner:** NEW
  (→ `C9-36`; no FAR/C9 ID owns boot concurrency).

### S8-3 (NEW · load-time + hitches · HIGH) — First-frame synchronous pipeline-compile wall: 132 sync createRenderPipeline sites vs 5 async; post-process stages bypass the central cache and fully recompile sync on every HDR toggle
- **Location:** repo census (132 sync/58 files render, 54 sync/25 files compute);
  `WebGPUModelPipelineCache.ts` (12 sync/0 async); `WebGPUPostProcessPipeline.ts:678, 1975, 2061`;
  `WebGPUSceneRendererEnsureResources.ts:444-450, 453-508`; `WebGPUSkyAtmosphereRenderer.js:241`.
- **Mechanism:** the async pattern that fixed globe was never propagated: PP stages
  (`_compileStage`), model pipelines, mipmap/reprojection, sky all create synchronously on first
  demand, so frame 1's submit blocks on the sum of their backend compiles, and every later variant
  crossing (first model — compiled from the 215,428 B ModelPBRComplete monolith, first
  translucent, HDR toggle which destroys and sync-recompiles the entire PP stage set) is a
  mid-session hitch. Also scale-dependent, not just boot.
- **Fix:** make the central async cache the mandatory path with tolerate-one-frame fallback
  (pattern proven at `resolveGlobePipelineEntry` incl. sync escape hatch for must-render passes);
  priority: model cache, PP stages, mipmap/reprojection, environment; prewarm the new-format PP
  set before teardown on HDR toggle; pair with S8-1 so the deterministic set never hits the lazy
  path. **Owner:** NEW (→ `C9-33` + `C9-36`; complements FAR-405/706 which needs stable cached
  pipelines).

### S8-4 (DEEPER-ON-KNOWN · load-time · MED) — Eager renderer graph: 41 eager vs 11 lazy feature-renderer registrations; ~91 % of the 6.6 MB / 172 K-LOC renderer source plus ModelPBRComplete (215 KB) and VolumetricFog (65 KB) WGSL strings ride the boot chunk
- **Location:** `WebGPUFeatureRenderers.ts:244` ff (41 eager vs 11 lazy; 43 unique import
  sources); `WebGPUContext.ts` (54 static imports); build-output confirmation above.
- **Mechanism:** the 11-loader lazy seam already exists and works (voxel/splat/ocean/…), but 41
  renderers — including Model with its 215 KB shader string, Vector3DTile ×3, ShadowMap,
  VolumetricFog, StarField, HiZ, GPUSortKeys, ComputeInstance, EntityCluster,
  DynamicEnvironmentMap — are eager, so backend selection evaluates ~91 % of renderer source
  (6.62 MB / 172,227 lines; lazy modules total 584 KB) regardless of scene content. ESM: 3.05 MB+
  in the awaited boot chunk; IIFE: 527 module initializers in one synchronous tick (~50–150 ms on
  mid CPU dev-unminified) plus retained WGSL-string heap; also the residual fat in the 6.4 MB
  webgpu-only variant.
- **Fix:** mechanical conversion of the ~15 cold registrations to `registerFeatureRendererLoader`;
  target eager set = globe + imagery + sky + post-process + picking + primitive/collection cores;
  biggest single win is lazifying Model. **Owner:** NEW (build/TTFF lane; → `C9-36` rider or §14).

### S8-5 (NEW · load-time + scale-dependent · MED-HIGH) — Monolithic uber-WGSL sources make every define-variant pay the full monolith compile: GlobeTerrain 238,857 B and ModelPBRComplete 215,428 B re-Tint end-to-end per variant
- **Location:** the two monoliths; `WebGPUShaderModuleCache.ts:117-118` (preprocess per variant);
  `WebGPUGlobeSurfaceShaders.ts:100-109, 147+`.
- **Mechanism:** WGSL has no separate compilation; module granularity is the only lever. The
  `//>>ifdef` preprocessor selects branches but the shared body dominates, so every variant
  submits ~200 KB+ to Tint — compile time scales with total feature surface, not features used.
  Every feature added to globe/model WGSL makes boot slower even when disabled; the corpus
  (319 files, 4.9 MB) grows every campaign, structurally eroding the TTFF axis of the ≥2× goal.
  A single ~6.6 K-line compile is plausibly 30–80 ms of GPU-process time on the campaign host.
- **Fix:** split per-pass entry points into separate sources (pipeline cache already keys
  per-pass); dead-function elimination in the preprocessor for the selected entry point
  (chunk-injection machinery exists); pass `compilationHints` with the pipeline layout at
  `createShaderModule`. **Owner:** NEW (§14 seed; neither C9-11 nor C9-12 owns compile granularity).

### S8-6 (NEW · load-time · LOW) — State check: `createShaderModule`→`getCompilationInfo` monkeypatch still installed unconditionally in production (acceptable as-is)
- **Location:** `WebGPUContext.ts:1015, 2295-2350` (fire-and-forget getCompilationInfo at `:2310`).
- **Mechanism:** every shader module spawns a getCompilationInfo() promise; warning branch is
  pragma-stripped but the wrapper, promise, and error branch ship in release — one promise + one
  GPU-process round trip per module (~40–60 on a full default boot). Micro, not structural; does
  not block pipeline creation.
- **Fix:** leave as-is, or pragma-gate the wrapper + pushErrorScope coverage in the two central
  caches; if S8-1 lands, batch info reads behind `queue.onSubmittedWorkDone`. **Owner:** fold into
  whichever TTFF batch touches that file region.

### S8-7 (DEEPER-ON-KNOWN · load-time · HIGH) — Settle-window attribution: the +1.3–1.7 s to tile-stable is a 2.6× per-frame load-window cost with ZERO WebGPU main-thread long tasks — main-thread-only fixes will not move `navigationToStableMs`
- **Location:** `campaign9-gate-a-clean-r5-2026-07-15.json` (longTasks + startup blocks, all 10
  runs); `run-performance-campaign.mjs:1453-1481, 1667-1684`.
- **Mechanism:** known owners (C9-11 terrain churn, C9-12A imagery 513×/171 MiB + 4,104 mip passes
  + 513 private submits, C9-15) cover the *what*; this adds the *where*. WebGPU settle iterations
  average 58–66 ms vs WebGL 22–25 ms (2.6×) yet WebGPU recorded 0 long tasks in all 5 reps vs
  WebGL's 7×~120 ms — the cost is spread per-frame (CPU + device-timeline stalls behind private
  submits/uploads), not main-thread blocking. The load-window multiplier (2.6×) is ~7× worse than
  the steady-state multiplier (1.37×, C9-00): load-path churn dominates the stable-time gap, and
  **submit batching (FAR-200/C9-12A), not closure-churn fixes, is what this metric responds to.**
  WebGL settle is itself main-thread-bound, so the relative bar may rise after WebGL fixes.
- **Fix:** prioritize GPU-submit-traffic reduction (coalesce the 513 private mip submits into
  frame encoders, batch tile uploads) for any fix claiming stable-time credit; add a
  first-complete-frame metric (tiles rendered == tiles selected) since async-null tile skips make
  frameNumber>0 under-report perceived TTFF. **Owner:** C9-12A (primary), FAR-200, C9-11/C9-15.

**S8 clean checks:** LUT/IBL/BRDF bakes all lazy and demand-gated (they just belong in the S8-1
prewarm batch); device-pool internals inherently sequential, not the problem; the two
`initPrimitive/CollectionShaders` awaits confirmed dead.

---

## 10. S9 — JS-engine smells in per-frame paths — 5 findings

Per-frame multiplier baseline: 300–2,000 `executeWebGPUCommand` dispatches/frame on a default
globe scene. **Cross-cutting root cause: the WebGPU frontend treats commands as frame-transient
values while WebGL treats them as retained objects** — GC pressure, hidden-class forking,
megamorphic executors, and useless cache-key rebuilds all flow from that inversion, which is also
the gating prerequisite for FAR-405/706 render bundles and for `executeBatchIndirect` ever finding
stable homogeneous runs.

### S9-1 (DEEPER-ON-KNOWN · per-frame · HIGH) — Model FR rebuilds the entire command graph (2–4 WebGPUDrawCommand + descriptor/spread literals + material-info object + string keys) per primitive per frame
- **Location:** `WebGPUModelRenderer.ts:3707` (updateWebGPUModel), `:4610-4612` (primKey loop),
  `:5361-5388` (args+primary cmd), `:5521-5546` (pick spread), `:5750-5772` (velocity),
  `:5801-5809` (IDL spread); `ModelMaterialInfo.js:75` called at `:4744`; string-keyed dicts with
  `delete` at `:3765-3767, :4622-4629, :4740`.
- **Mechanism:** every frame, every visible model primitive (and every 3D Tiles tile content is a
  Model) allocates ~8–12 heap objects / ~250 property stores: fresh WebGPUDrawCommand instances
  (~45 ctor field stores each) for primary + pick (+hover/precise/metadata) + velocity,
  spread-cloned option literals, derivedCommands literals, a ~40-field material-info object, and a
  `` `${nodeIdx}_${primIdx}` `` string key probed against dictionary-mode (delete-mutated) plain
  objects. Post-construction stamping of undeclared fields (derivedCommands, velocityCommand,
  `_shadowCast*`, `_oitPipeline`) re-forks hidden classes on the fresh instances every frame,
  keeping every IC in executeBatch/selectCommandVariant/execute polymorphic (4–8 command maps).
  300–800 visible tile-primitives → ~3–8 K objects (~0.5–1 MB)/frame → 15–30 MB/s allocation →
  V8 scavenge every ~0.5–1 s with 1–5 ms render-thread pauses. Also defeats
  `executeBatchIndirect` identity grouping and per-frame loses `_oitPipeline` stamps. WebGL caches
  ModelDrawCommand once and pushes by reference.
- **Fix:** persistent per-primitive command cache (WebGL ModelDrawCommand parity): build
  primary/pick/velocity commands once per cache generation, mutate volatile fields in place;
  declare ALL stamped fields on the WebGPUDrawCommand class; replace string-keyed dictionary
  caches with `Map` keyed `nodeIdx<<16|primIdx`. Prerequisite for FAR-405/706 bundles.
  **Owner:** C9-17 (extend scope from bind groups to command objects). See S11-4 for the
  tiles-scale totals.

### S9-2 (DEEPER-ON-KNOWN · per-frame · MED-HIGH with effects) — `createEffectsBindGroup` runs its full 22-segment WeakMap-id string key + DataView alloc + 480 B scratch repack per tile/model per frame even on cache hits; per-frustum `createView()` defeats the cache per-model in edge mode
- **Location:** `WebGPUEffectsBindGroup.js:1198-1199` (fill), `:1244` (new DataView per call),
  `:1536-1558` (resKey/ownerKey); `WebGPUGlobeSurfaceRenderer.ts:1229` (per-tile call);
  `WebGPUModelRenderer.ts:4215` (per-model), `:4164/4188-4201` (edgesPayload view);
  `WebGPUSceneRendererFrustumLoop.ts:307`; `WebGPUEffectsStateCache.js:56-92` (linear slot scan).
- **Mechanism:** invoked per terrain tile and per model per frame whenever any effects feature is
  active (atmosphere LUT, shadows, CSM, clipping, clustered lighting). Even on 100 %-hit frames
  each call fills a 480 B scratch, allocates a DataView, does ~22 WeakMap identity lookups, builds
  a ~40-intermediate-string cache key, and linear-scans slots with 120-word Uint32Array compares —
  300–600 invocations/frame; tens of thousands of string/WeakMap ops to conclude "nothing
  changed". Separately, the frustum loop mints a fresh globe-depth GPUTextureView every frustum
  every frame; the model effects path keys on that view identity, so with inline edges armed the
  resKey never repeats → **new GPUBindGroup + UBO slot per model per frame** (the Batch-139
  texture-identity fix was applied to collections only).
- **Fix:** memoize the resolved effects tuple per (owner, frameNumber) fast path; hoist the
  DataView; cache the globe-depth view per texture at the frustum-loop publish site (Billboard
  Batch-139 pattern). **Owner:** C9-11 (per-tile) / C9-17 (model side).

### S9-3 (NEW · per-frame · MED-LOW each, ×1000s) — Per-command try/catch plus megamorphic duck-typed dispatch in the command executor
- **Location:** `WebGPUSceneRenderer.ts:506-523` (try/catch per command; duplicated `:577-594`),
  `:299-333` (duck-typing `.isWebGPUDrawCommand/.pipeline/._pipeline/.execute`), `:197-297`
  (selectCommandVariant optional-chain walks); divergent execute arities at
  `WebGPUContext.ts:2596-2606` + `WebGPUViewportQuad.ts:509-574`; `WebGPUDrawCommand.ts:527-529`
  (context passed as `dynamicStateOverride`).
- **Mechanism:** the hottest loop wraps every command execution in try/catch (warn-once intent
  needs one try around the batch), then duck-types each command across genuinely different shapes;
  the execute call site and the 8–15 optional-chained derivedCommands loads run megamorphic on
  every command every pass every frustum — compounding with S9-1's per-frame map forking. Latent
  quirk: the executor passes context into `dynamicStateOverride` — currently harmless, two wasted
  polymorphic lookups per draw, and a foot-gun.
- **Fix:** single canonical command shape or integer commandType tag + switch; hoist try/catch out
  of the loop; unify the viewport-quad execute signature; stop passing context as
  dynamicStateOverride. **Owner:** NEW (feeds C9-17; precondition for FAR-405 bundles paying off).

### S9-4 (DEEPER-ON-KNOWN · scale-dependent · LOW-MED) — GPU-cull feed side re-extracts every bounding sphere into a fresh Float32Array and re-uploads spheres+planes every frustum every frame
- **Location:** `WebGPUSceneRenderer.ts:3708` (new Float32Array(count*4)), `:3710-3739`
  (extraction + upload), `:3873+` (translucent duplicate); output pool exists at `:3779`.
- **Mechanism:** FAR-003/503 cover the readback/indirect side; the untracked feed side allocates a
  fresh sphere array and walks every command's boundingVolume per frustum per frame above the
  384-command gate, re-uploading data that rarely changes. 1,000 commands × 2 frustums ≈ 32 KB
  fresh typed-array + 2,000 sphere reads + repeated uploads/frame, exactly in the dense scenes
  where the gate activates. The output was pooled in Batch 213; the input never was.
- **Fix:** grow-only pooled sphere array versioned by a command-list generation counter; skip
  extraction+upload when unchanged. **Owner:** FAR-003.

### S9-5 (NEW · per-frame · LOW-MED) — Collection renderers rebuild WebGPUDrawCommands and resolver closures per collection per frame instead of mutating cached commands
- **Location:** `WebGPUBillboardRenderer.js:1330` (colorCommand new per frame), `:1512`
  (pickCommand), `:1362-1363` (velocityCommand), `:1224-1235` (makeResolver churn); same pattern
  in Label/Point/Polyline renderers.
- **Mechanism:** the resident-instance work fixed the instance-data side, but each collection
  still constructs 2–3 fresh WebGPUDrawCommand instances plus resolver option literals,
  extraEntries arrays, and pack closures every update, though pipelines/buffers/layouts are
  already cached — the same retained-vs-transient inversion as S9-1 at a per-collection
  multiplier; churns the same hidden classes. Entity-heavy scenes (per-datasource collections ×
  clustering) pay ~5–10 allocations × dozens of collections/frame.
- **Fix:** build the color/pick/velocity commands once per cache generation (reuse the existing
  `forceFullRebuild` trigger at `:1258-1263`), mutate instanceCount/renderState/BV in place;
  persistent options object for makeResolver. **Owner:** NEW (C9-17-successor "collections
  command reuse").

**S9 clean checks:** pipeline-cache key strings cold-path only (entry-slot memoization verified);
core executor/sorters allocation-free; AutoUniforms scaffolding unconsumed; viewport-quad
per-execute smell has no live per-frame consumer.

---

## 11. S10 — Entity/DataSource scale (the 10 k-entity story) — 9 findings

**Context:** the fork's bulk-static work (BulkPoint/Billboard/LabelVisualizer, default-wired) is
genuinely good — the "10 k parked markers" story is settled O(changed). What still breaks at 10 k,
structurally, is everything dynamic-adjacent — and F1+F3 are backend-shared main-thread costs
upstream of the renderer entirely that will cap the ≥2× goal on entity scenes even after the full
C9 backlog lands.

### S10-1 (NEW · per-frame · HIGH ≥5 k dynamic · both backends) — Dynamic fallback lane is O(N × ~10–35 megamorphic Property reads) per frame with no dirty-tracking; any dynamic position or terrain clamp forfeits the bulk lane
- **Location:** `PointVisualizer.js:89-238`; `BillboardVisualizer.js:97-249` (14 getValue-family
  sites verified); `LabelVisualizer.js`; `BulkPointVisualizer.js:45-84` (static gate); driven from
  `CesiumWidget.js:1476-1496`.
- **Mechanism:** bulk static lanes require EVERY consumed property constant incl. position and
  `heightReference===NONE`; the canonical 10 k-mover / clamped-marker workloads fail categorically
  and land in the legacy visualizers, which re-read the full property tree (isShowing walk +
  isAvailable interval search + 10–17 getValueOrDefault + setter equality checks) per entity per
  frame, on the main thread, on both backends. 10 k dynamic entities ≈ ~110 K (points) to ~350 K
  (billboards+labels) property-system calls per frame ≈ 3–15 ms/frame CPU floor shared by both
  backends. Aggravator: clamped markers can never be bulk even when every property is constant.
- **Fix:** third lane "static-except-position" (write constant style attributes once, stream only
  position + availability show); definitionChanged-driven per-property memoization;
  SampledPositionProperty segment-cursor cache (avoid per-frame binary search); clamped-static
  sub-lane. **Owner:** NEW (S10-A; FAR-300-adjacent producer side, no existing row). §14 seed.

### S10-2 (NEW · per-frame · HIGH · both backends) — EntityCluster: any dynamic-position entity forces a FULL declutter rebuild every frame; GPU cluster path only replaced the KDBush term
- **Location:** `PointVisualizer.js:118-120` / `BillboardVisualizer.js:128` /
  `LabelVisualizer.js:132` (per-frame `_clusterDirty`); `EntityCluster.js:243-250, 528-574,
  580-761`; `EntityClusterGPU.js:126-151, 241-284`.
- **Mechanism:** visualizers set `cluster._clusterDirty=true` every frame for every
  non-constant-position entity (no displacement gate); each declutter pass removeAll()s/recreates
  the 3 cluster collections (glyph re-layout per cluster label), projects ALL N items
  world→window on CPU with a fresh `{index,collection,clustered,coord}`+Cartesian2 object per
  point, builds a fresh KDBush; the fork's GPU grid path keeps all the O(N) CPU work and adds a
  pack + upload + mapAsync readback + per-pass Map re-bucketing. 10 k clustered markers + 1 mover:
  ~10 k projections + ~20–30 K heap allocations + index build + collection rebuild per frame, 60×/s.
- **Fix:** gate `_clusterDirty` on actual screen-space displacement threshold; incremental
  declutter reusing cluster billboards/labels in place; persistent points array/occluder; finish
  deferred `NEW-ENTITYCLUSTER-GPU-MERGE` with GPU-side projection so CPU never touches N.
  **Owner:** NEW (extends NEW-ENTITYCLUSTER-GPU in DEFERRED_WORK). §14 seed.

### S10-3 (NEW · per-frame while clustering · HIGH) — Enabling clustering structurally FORFEITS the entire bulk static lane
- **Location:** `BulkPointVisualizer.js:420-424` (`_classify` clusteringEnabled gate; same in
  BulkBillboard/BulkLabel).
- **Mechanism:** `_classify` routes EVERY entity to the legacy fallback while
  `cluster.enabled===true` because the legacy lane owns the cluster's collections — the feature
  users enable precisely at 10 k+ markers reverts the whole catalog to the O(N×10–20 reads)/frame
  lane, stacking with S10-2. The forfeiture is an ownership artifact, not a data requirement:
  static entities' data does not change under clustering, only clusterShow. **The fork's
  headline 50–1400× bulk win and clustering are mutually exclusive by construction** — 10 k
  clustered static markers + 1 mover = S10-1 + S10-2 simultaneously, a guaranteed 30 fps-class
  scene on both backends.
- **Fix:** decouple storage from clustering: keep static entities in flat-buffer collections,
  register constant positions with the cluster once, drive only per-item `clusterShow` bits from
  declutter; exclude entities from the fast lane only while represented by a cluster proxy.
  **Owner:** NEW (S10-F; prerequisite for S10-2's fix to matter at scale). §14 seed.

### S10-4 (NEW · load-time + memory · HIGH at 10 k) — GeometryUpdaterSet constructs 10–11 geometry updaters + ~13 Events/subscriptions per entity for EVERY entity, geometry or not
- **Location:** `GeometryUpdaterSet.js:16-27, 36-58, 60-70`; `GeometryVisualizer.js:196-200,
  294-309`; `PolylineVisualizer.js:259`.
- **Mechanism:** GeometryVisualizer + PolylineVisualizer instantiate per-entity updater sets
  unconditionally: 10 updater objects (Box..Wall) each with own Event + eventHelper subscription
  + 1 definitionChanged subscription, drained in a single un-timesliced update loop on load. 10 k
  point-only entities: ~110 K updater objects + ~120–130 K Events/subscriptions/closures
  (~50–100 MB retained), **~200–500 ms synchronous TTFF stall** on source load; steady-state an
  11-way updater dispatch per property write multiplies CZML update storms.
- **Fix:** lazy updater instantiation keyed by which graphics slots are actually defined; budget
  time-slice the added-entity drain. **Owner:** NEW (S10-B; FAR-209-adjacent in spirit, out of its
  written scope). §14 seed.

### S10-5 (NEW · per-frame · MED · WebGPU-only) — WebGPU collection renderers run an O(N) per-frame define scan over every billboard/point/label glyph even when the collection is fully settled
- **Location:** `WebGPUBillboardRenderer.js:815-908` (scan) + `:999` (per-frame call);
  `WebGPULabelRenderer.js:331-416` (scans glyph billboards); same in WebGPUPointPrimitiveRenderer.
- **Mechanism:** `computeDefinesForFrame` walks the entire collection every frame to derive 6 gate
  bits; early-break fires only when ALL six are set, so the common default collection scans all
  N×6 probes forever; labels scan per-glyph (N = summed text length). 10 k billboards + 10 k
  labels ≈ 80–150 K+ probes/frame ≈ 0.3–1.0 ms on the WebGPU frontend only, despite the
  resident-instance manager already carrying an exact dirty signal.
- **Fix:** cache `currentDefines`; rescan only when dirtyCount>0 (dirty items with per-bit
  population counts so clears are detectable) or on forceFullRebuild. **Owner:** NEW (S10-C;
  natural sibling of C9-17, distinct site).

### S10-6 (DEEPER-ON-KNOWN · scale-dependent · MED-HIGH with hover picking) — Pick pass re-allocates and re-packs the FULL instance array per collection per pick frame; one show-toggle forces full resident-buffer rebuild
- **Location:** `WebGPUBillboardRenderer.js:335-370` + `:1482`;
  `WebGPUPointPrimitiveRenderer.js:261-323` + `:1400`; `WebGPUResidentInstanceBuffer.ts:195-292`.
- **Mechanism:** DEEPER on FAR-107/409 (which cover the pick mini-frame + readback, not this):
  `buildPickInstanceData` allocates a fresh `Float32Array(N×44)` and re-packs all N instances
  (incl. EncodedCartesian3 splits) on every pick-pass frame per collection — per mouse-move under
  hover picking (10 k billboards = 1.76 MB alloc + repack + writeBuffer per pick per collection);
  separately the resident manager treats any visibility flip as structural (`_needsFullRebuild`)
  so one show toggle re-packs/re-uploads all N×176 B — a blinking billboard re-uploads 1.76 MB at
  its blink rate.
- **Fix:** resident pick mirror via the same partial-write manager, or single resident buffer +
  separate 4-float pick-ID side buffer (no repack); pack a show flag instead of compacting slots
  so show-toggles become 16-byte partial writes. **Owner:** FAR-107/FAR-409 (extend scope).

### S10-7 (NEW · scale-dependent · MED-HIGH for CZML/edit) — Static geometry batching: one geometry-changed entity re-inserts 10 updaters across 47 batches and re-combines the WHOLE batch Primitive (O(N²) streaming adds)
- **Location:** `GeometryVisualizer.js:50-55, 148-186` (47 batches), `:262-281` (changed
  remove+insert), `:424-431` (all-batch probe); `StaticGeometryColorBatch.js:89, 116, 137-183`
  (`geometries.slice()` full rebuild).
- **Mechanism:** any geometry-affecting change (via `updater.geometryChanged`; verified
  `_onCollectionChanged` at `GeometryVisualizer.js:509` ignores generic changed entities) does
  removeUpdater (47-batch probe × 10 updaters ≈ 470 probes) then re-insert, marking the batch
  `createPrimitive=true` → a brand-new Primitive is built re-combining EVERY instance in the batch
  (worker tessellation + full upload + old-primitive double-buffer memory spike). Streaming 5 k
  polygons one-per-tick ≈ 12.5 M cumulative instance re-combines; one edit in a 10 k-instance
  batch = 10 k-instance re-tessellation + full GPU upload. Both backends.
- **Fix:** batch sharding with size cap (rebuild the shard, not the world); updater→batch
  back-pointer to kill the 470-probe scan; sub-range re-upload for shape-preserving changes.
  **Owner:** NEW (S10-D; FAR-209-shaped incremental preparation applied to entity geometry). §14 seed.

### S10-8 (NEW · per-frame · HIGH for tracking apps) — PathVisualizer re-subsamples every path every frame AND any path's sample-count change rebuilds vertex arrays for the ENTIRE shared PolylineCollection
- **Location:** `PathVisualizer.js:845-851` (shared collection), `:889-1199`, `:983-991`
  (`positions.slice()` per frame), `:1004`; `Scene/PolylineCollection.js:446-449`
  (POSITION_SIZE_INDEX → createVertexArrays), `:458-472` (O(buckets) for-in per polyline).
- **Mechanism:** per path per frame the full lead/trail window is re-interpolated
  (O(window/resolution) getValues) into a freshly sliced array plus new JulianDates; downstream,
  all paths in a reference frame share ONE PolylineCollection and any polyline's position-COUNT
  change triggers `createVertexArrays`, which re-encodes and re-uploads EVERY polyline in the
  collection — sliding windows change counts near-continuously, so the collection-wide rebuild
  lands almost every frame. 500 paths × 120-sample windows: 60 K interpolations + 500 array
  clones/frame; each count-change frame re-encodes ~60 K positions × 4 verts × ~13 floats ≈ 12 MB
  CPU + GPU buffer recreation. **WebGPU regresses harder than WebGL here** (buffer re-creation
  churns bind groups).
- **Fix:** ring-buffer incremental trail (append head/trim tail, cache interior); pre-allocate
  per-path vertex capacity so counts never change (degenerate-vert padding) turning updates into
  sub-range writeBuffer; polyline→offset back-pointer instead of the bucket for-in scan.
  **Owner:** NEW (S10-E; FAR-209-adjacent). §14 seed.

### S10-9 (NEW · per-frame · MED) — ModelVisualizer has no static lane: ~25 Property reads + model-matrix recompute per model entity per frame, unconditionally
- **Location:** `ModelVisualizer.js:100-260+` (per-frame loop, Matrix4.clone at `:195`).
- **Mechanism:** every model entity pays isShowing + isAvailable + computeModelMatrix (orientation
  getValue + Matrix4 compose) + ~25 getValueOrDefault reads + node-transformation/articulation
  sub-loops per frame even when fully constant; the bulk/Sol classification precedent was never
  extended to models. 1 k static model entities ≈ 25 K property dispatches + 1 K matrix
  composes/clones per frame (~1–3 ms) — upstream of, and invisible to, C9-17's renderer-side work.
- **Fix:** reuse the `isStatic*Entity` classification pattern: constant-graphics model entities
  write Model state once and are skipped; dynamic ones keep the legacy loop. **Owner:** NEW
  (S10-G; complements C9-17 without overlap).

**S10 clean checks:** DataSourceDisplay fixed overhead cheap when settled; EntityCollection event
aggregation properly batched; bulk `_classify` O(changed); resident-instance partial-write
architecture genuinely good (settled collections upload 0 bytes) — the holes are exactly S10-5/6.

---

## 12. S11 — 3D Tiles + model streaming CPU architecture — 5 findings

**Headline:** traversal/selection/request-scheduling is upstream-identical and backend-neutral
(verified by grep + git history) — **there is no C9 lever in traversal; the entire WebGPU-vs-WebGL
3D Tiles gap is downstream of selection**, in per-tile-content command generation and load
realization.

### S11-1 (NEW · per-frame · HIGH) — Unconditional dual-class draw command: every 3D Tiles batch-table primitive emits a second full-geometry TRANSLUCENT command every frame (WebGL gates on `styleCommandsNeeded`)
- **Location:** `WebGPUModelRenderer.ts:5966-6107` (gate + emission);
  `WebGPUModelFeatureId.js:287-297, 513-516` (forced batch texture → HAS_BATCH_TABLE always
  true); `ModelPBRComplete.wgsl:3465-3472` (per-fragment discard); WebGL comparison:
  `Cesium3DTileBatchTable.js:479-562, 980-990`; `Model.js:2380`.
- **Mechanism:** WebGPU never consults `styleCommandsNeeded`/`translucentFeaturesLength` (zero
  grep hits in Renderer/WebGPU). It force-creates the batch texture (opaque-white fill) for every
  feature-table primitive, making FLAG_HAS_BATCH_TABLE unconditionally true, so every
  b3dm/glTF-tile primitive emits a second WebGPUDrawCommand into Pass.TRANSLUCENT each frame:
  second 768 B packMaterialUniforms+writeBuffer, second merged group-1 bind-group build, full
  second VS+raster with 100 % fragment discard (discard also kills early-Z). Knock-ons: the
  TRANSLUCENT pass is never empty for tilesets (defeats the landed empty-pass skips, keeps
  OIT/alpha machinery alive), all phantom commands enter the per-frame back-to-front JS sort
  (`WebGPUSceneRendererTranslucentPass.ts:302`), `Cesium3DTile.update` opts them into
  translucent-tile-classification depth machinery, and command-list length for tileset scenes
  ~doubles, inflating every downstream per-command loop.
- **Quantification:** 400 tiles × ~1.5 prims ⇒ +600 commands/frame, +450 KB/frame redundant UB
  writes, +600 bind-group builds/frame, ~2× triangle throughput for all tile geometry
  (1 M-tri view ⇒ ~2 M tri/frame).
- **Fix:** consume `model.styleCommandsNeeded` (already maintained by scene code) or
  `batchTexture.translucentFeaturesLength` in the FR; emit the translucent-class command only for
  OPAQUE_AND_TRANSLUCENT; stop force-allocating `_batchValues` (lazy batch texture on first style
  mutation with a dynamic FLAG_HAS_BATCH_TABLE define flip, as already done for model
  color/split). Retain the dual-command machinery; gate it.
  **Owner:** NEW → proposed `C9-34` (adjacent C9-17 but outside its text: command-count economics
  + forced batch-texture realization, not bind-group reuse).

### S11-2 (NEW · scale-dependent · HIGH) — Gaussian-splat depth sort: synchronous main-thread JS comparator sort per ~0.5° of camera rotation; WebGL uses an async WASM radix sort in a worker
Same finding as **S6-1** (surfaced independently by both strata); S11 adds: WebGL comparison
anchors `GaussianSplatPrimitive.js:1543, 1601, 1635` (`GaussianSplatSorter.radixSortIndexes`,
async worker), the permanent 64 B/splat CPU `splatData` retention (64 MB at 1 M splats), and the
1–4 s frozen-frame quantification at 1 M splats. **Owner:** NEW → `C9-37`.

### S11-3 (DEEPER-ON-KNOWN · load-time + memory · HIGH) — Triple geometry residency + double GPU upload for all model/tile geometry: orphaned loader-side stub GPUBuffers + forced permanent CPU typedArrays + FR-owned re-uploaded GPUBuffers
- **Location:** `GltfLoader.js:1432-1453` (forced typedArray retention AND loadBuffer=true);
  `Stubs/WebGLStubBuffer.ts:29, 63, 266-355` (stub allocates+writes real GPUBuffers);
  `WebGPUModelRenderer.ts:2471, 2010-2022, 2707-2724` (FR builds a second GPUBuffer set from
  typedArrays at first rendered frame); consumption proof: `:5151-5186` binds only primCache buffers.
- **Mechanism:** during tile PROCESSING the loader uploads every vertex attribute + index buffer
  into a stub-backed real GPUBuffer the model FR never binds; the CPU typedArray is force-retained
  for all attributes on WebGPU; then at the tile's first visible frame the FR creates and uploads
  a second GPUBuffer set from those typedArrays **inside the render loop with no budget**
  (all vertex buffers, index buffer, pick IDs, property textures — a direct popping-hitch/TTFF
  contributor; WebGL finishes GPU resources during PROCESSING). Geometry exists 2× on GPU + 1× on
  JS heap and crosses the bus twice per tile: ~500 MB resident tile geometry ⇒ ~1 GB GPU buffers
  (half never bound) + ~500 MB JS heap. The ledger (item 89 `NEW-PNTS-TYPEDARRAY-RETENTION-RECORD`
  + DEFERRED_WORK GltfLoader entry) records only the CPU-retention leg; the orphaned stub GPU
  copy, the double upload, and the unbudgeted first-frame FR build are unledgered.
- **Fix:** single canonical GPU copy — either the FR adopts the stub GPUBuffers (usage flags
  already VERTEX|INDEX|COPY_DST) or WebGPU suppresses the loadBuffer leg (typedArray-only load)
  and the FR buffer build moves into budgeted content processing, releasing typedArrays after
  build except documented readers (edge visibility, 2D, picking).
  **Owner:** FAR-204 / item-89 extension (GPU-dedupe scope effectively NEW); subsystem-distinct
  from C9-15. §14 seed.

### S11-4 (DEEPER-ON-KNOWN · per-frame · HIGH) — Quantified C9-11-equivalent for 3D Tiles: per-selected-tile full frontend re-execution every frame (~2,600 writeBuffer calls, ~1.7 MB uploads, ~1,800 transient allocs per frame at 400 tiles), including two unledgered sub-costs
- **Location:** `WebGPUModelRenderer.ts:4102-4132` (camera 320 B write + effects UB 272 B +
  `createBindGroup` EVERY frame per model — self-admitted hotspot comment: *"If this becomes a
  hotspot with many models, cache a scene-wide effects bind group"*), `:4504-4511` (per-node
  camera), `:5022, 5095-5111` (unconditional material 768 B + light 864 B writes per primitive),
  `:5080, 5151, 5361-5388, 5750, 6068, 6351` (per-frame DataView/array/command allocs); WebGL
  comparison: `ModelSceneGraph.js:183, 602` (commands built once, pushed by reference); routing:
  `Model.js:2827-2843`.
- **Mechanism:** every selected tile content is a Model whose FR re-packs and re-uploads
  camera/effects/material/light UBs, rebuilds merged bind groups, and allocates fresh
  command/args/DataView/vertexBuffers objects per primitive per frame; pick mini-frames re-run all
  of it (setting the magnitude FAR-107 multiplies). Two unledgered sub-costs: the per-model
  per-frame **effects bind-group rebuild** (group-3 — tile scenes are exactly the many-models case
  its own TODO warns about, ~400 creations/frame) and the **ungated 768 B material write** (the
  landed material-upload-versions work covers collections, not this path). 400 tiles ×~1.5 prims,
  TAA on, batch tables: ~2,600 writeBuffer calls (~3–8 ms CPU at 1–3 µs each) + ~1.7 MB/frame
  CPU→GPU + ~1,000 bind-group builds + ~1,800 transient objects/frame. WebGL steady state: pushing
  ~600 retained command references.
- **Fix:** terrain-C9-11-shaped retained packets for model primitives: persist command objects
  keyed on (content, pipeline generation, mode, effects generation); dirty-gate material via
  existing revision plumbing; coalesce camera writes into ring pages; scene-wide effects bind
  group per the code's own TODO. **Owner:** C9-17 / FAR-309 (adds the tiles-scale quantification
  plus the two sub-costs not named in its text).

### S11-5 (DEEPER-ON-KNOWN · per-frame + memory · MED) — Scene-level light data (864 B) packed and uploaded once per PRIMITIVE per frame instead of one shared scene light UB
- **Location:** `WebGPUModelRenderer.ts:814` (LIGHT_UNIFORM_SIZE=864), `:1821-1900`
  (packLightUniforms), `:4912-4917` (per-primitive lightBuffer), `:5104-5111` (per-primitive
  per-frame write).
- **Mechanism:** sun/ambient/punctual scene lighting is packed into a per-primitive 864 B uniform
  buffer and re-uploaded every frame per primitive; for tile content (which essentially never
  carries KHR_lights_punctual) the bytes are identical across all primitives of all tiles — 600
  tile prims ⇒ ~518 KB/frame redundant upload + 600 writeBuffer calls + ~518 KB duplicated GPU
  residency. WebGL sources this from UniformState automatic uniforms (one CPU-side state).
- **Fix:** one shared per-scene/per-context light UB written once per frame and bound for all
  models without glTF lights; per-model UB only for the rare KHR_lights_punctual case. A
  static/dynamic consolidation in the C9-12 mold, distinct from C9-17's caching language.
  **Owner:** C9-17 (explicit sub-item; not named in its current text).

**S11 clean checks:** traversal/scheduling upstream-identical; style evaluation dirty-driven
(the problem is creation-time forcing, S11-1, not the update path); group-1 bind churn already
C9-17; pick mini-frame already FAR-107/409.

---

## 13. (a) Proposed Campaign 9 rows — paste-ready (wave-table format)

Rows follow the QUEUE_2026-07-15_CAMPAIGN9.md wave-table shape
(`| n | ID / related | rung | acceptance summary |`); row numbers left as `—` for the maintainer
to slot. All are high-impact and fit existing gates (moving-altitude campaign CPU p50/p95/p99,
byte/allocation acceptance counters, off-path byte-identical proof, no feature degradation).

| — | `C9-30-ENV-COMMAND-FRUSTUM-BINNING` / pre-slice of `FAR-707` | R2 | Stop BV-less environment commands (SkyAtmosphere, Sun, StarField) from feeding the near/far accumulator in `View.createPotentiallyVisibleSet` (skip `Pass.ENVIRONMENT`, `numFrustums = max(1, ...)` fallback) or attach honest bounding volumes. Default 3D frames run exactly ONE frustum at every route waypoint; sky-only views keep one frustum; SCENE2D/CV/ortho behavior byte-identical; add a `numFrustums` route-telemetry counter guarding the invariant. Expected: −~6 pass boundaries, −2 fullscreen depth packs, −1 aux GPU culler (2.8 MB), −1 duplicate collection camera-UB write per collection, per frame. |
| — | `C9-31-MODEL-TEXTURE-MIP-CHAIN` | R2 | Allocate full mip chains for glTF/3D-Tiles model textures + run the existing MipmapBlit at upload through the FAR-200/ResourcePlan submit authority (C9-12A precedent, no private submits); hoist `dpdx/dpdy(texCoord0/1)` at `fragmentMain` entry and convert the ~30 mip-0 `textureSampleLevel` material samples to `textureSampleGrad` (globe Batch-57 pattern). Magnified texels byte-identical; minified tiles lose shimmer and ~100× sample bandwidth; probe on a city tileset at distance vs WebGL. |
| — | `C9-32-MODEL-SHADER-SPECIALIZATION-AXES` | R2/R3 | Promote ~8 highest-separation ModelPBRComplete axes to ShaderDefine bits through the existing preprocessor + module cache (HAS_NORMAL_TEXTURE, per-KHR-extension bits, HAS_SKINNING/MORPH/INSTANCING in VS, shadow mode, IBL mode; add MODEL_HAS_VELOCITY gating the prev-frame VS chain + 2 varyings). Runtime flags stay for scalar factors; module count bounded by per-primitive-stable bits. MUST land with (or after) C9-33 async pipelines — specialization without async compile scheduling regresses TTFF. |
| — | `C9-33-ASYNC-MODEL-PIPELINES` / `FAR-405/706` enabler | R2 | Route `WebGPUModelPipelineCache` misses (12 sync sites) plus post-process `_compileStage`, mipmap/reprojection, and environment pipelines through the central async `WebGPURenderPipelineCache` with the globe's tolerate-one-frame null/reuse fallback (sync escape hatch only for documented must-render passes, e.g. capture); prewarm each model's actual variant matrix at model-resources-ready time; prewarm the new-format PP set before teardown on HDR toggle. Acceptance: zero synchronous createRenderPipeline on the draw path for models/PP; p99 tile-arrival frame spikes drop on the moving-altitude descent. |
| — | `C9-34-TILES-STYLE-COMMAND-ECONOMICS` | R2 | Consume `model.styleCommandsNeeded` / `batchTexture.translucentFeaturesLength` in the WebGPU model FR: emit the translucent-class command only for OPAQUE_AND_TRANSLUCENT; create the batch texture lazily on first style mutation with a dynamic FLAG_HAS_BATCH_TABLE define flip (model color/split precedent). Unstyled tilesets emit ONE command per primitive; styled/translucent parity byte-identical (style probes: setColor alpha, show, conditions); command-count route telemetry proves the halving; translucent-pass empty-skip re-activates for tilesets. |
| — | `C9-35-MSAA-BOUNDARY-BYTES-CONTAINMENT` / `FAR-405/706` companion | R1/R2 | (1) `getColorAttachments(resolve:boolean)` — eager MSAA resolve only on segments preceding a resolved-color consumer; (2) default WebGPU `msaaSamples` to 1 until FAR-405 pass consolidation lands (release-noted, user-overridable); (3) per-texture usage split (MSAA color = RENDER_ATTACHMENT only; TEXTURE_BINDING/COPY_SRC on the resolve texture only); (4) gate the fullscreen MSAA depth resolve on its actual consumer set; (5) depth/stencil storeOp discard on the final scene segment. Zero visual change at defaults; measure attachment-traffic proxy (gpuPassCost) before/after. |
| — | `C9-36-TTFF-BOOT-CONCURRENCY-AND-PREWARM` | R1/R2 | (i) Prefetch `requestAdapter` concurrent with the WebGPU chunk import; hoist the inline `WebGPUPrimitiveIndexUtils` import; delete the two dead awaited no-op shader inits. (ii) Implement `warmUpGlobeRenderer(context)` + wire `WebGPURenderPipelineCache.preloadBatch` for the deterministic boot set (PP identity/tonemap/FXAA/auto-exposure, sky, depth plane, globe depth, 2 GlobeTerrain variants) fire-and-forget at context init. (iii) Optional rider: lazify the ~15 cold eager feature-renderer registrations (Model's 215 KB shader string first). Gate: rendererReady→firstFrame delta vs WebGL on the deterministic-offline-boot profile (currently 9.1×) plus the 5-rep Gate-A first-frame spread. |
| — | `C9-37-SPLAT-ASYNC-SORT` / `FAR-003/503` adjacency | R2 | Replace the main-thread comparator sort in `WebGPUGaussianSplatRenderer.maybeSortSplats` with the existing backend-agnostic `GaussianSplatSorter.radixSortIndexes` worker (one-frame-stale into `sortedIndexBuffer`, filling the unused `sortRequestPending` scaffolding) or the shipped GPU sort dispatcher writing the index buffer on-device; drop the per-sort `Float64Array` alloc and (if GPU path) the permanent 64 B/splat CPU mirror. Acceptance: zero main-thread sort stalls during a continuous-orbit splat probe; ordering parity with WebGL within one frame of staleness. |
| — | `C9-38-VELOCITY-PREV-BUFFER-GPU-COPY` / rider on `C9-25`/`C9-28`/`FAR-306` | R1 | PointCloud/GaussianSplat/Cloud velocity prev-buffers: skip the full-array `writeBuffer` when the prev reference + content revision are unchanged (static content = zero uploads after first seed); animated content records `copyBufferToBuffer(curr→prev)` into the main frame encoder or ping-pong swap. Acceptance: TAA-on static splat/PNTS scenes upload 0 velocity bytes/frame (counter); motion-vector output byte-identical. |
| — | `C9-39-SHADOW-CAST-SINGLE-SWEEP` | R1 | Fold shadow cast-candidate collection into the single `createPotentiallyVisibleSet` sweep (persistent `castShadows` sublist maintained by revision); hoist the `shadowedPasses` literal; drop the duplicate `updateDerivedCommands` call in `insertShadowCastCommands`. Hoist the shadow-cast/CSM `extraEntries` build below the bind-group cache hit test (S2-2). Shadowed-scene visuals byte-identical; commandList sweep count per frame drops from 1+maps to 1. |

**Scope-extension riders for existing C9 rows (append to their acceptance text, no new IDs):**

- `C9-11` — extend retained tile-command identity across the split to the WebGL lane so
  `GlobeSurfaceTileProviderRendering.js:1929` stops re-dirtying every command (S1-1); absorb the
  per-tile max-index scans/up-conversions into worker-shipped scalars (S5-4); frame-stamp fast
  path for `createEffectsBindGroup` per-tile calls + cached per-texture globe-depth view (S9-2).
- `C9-17` — extend from bind groups to **command objects** (persistent per-primitive commands,
  declared stamped fields, Map keys — S9-1); add the scene-wide effects bind group its own TODO
  names and the dirty-gated 768 B material write (S11-4); add shared scene light UB (S11-5);
  collection command reuse (S9-5) as a sibling slice.
- `C9-27` — add the S2 acceptance clause: "settled collections create no per-frame
  closures/options/identity strings" (S2-1).
- `C9-29` — TAA two-slot parity bind-group cache rider (S2-4).
- `C9-12`/`FAR-303` — extend the uniform ring + dynamic offsets beyond terrain to
  Primitive/Polyline/collection/effect UBs (S6-3).
- `C9-14` — add `C9-14B-ATMOSPHERE-LUT-CONSUMPTION` sub-item: WebGL-parity distance gate
  (per-vertex below ~10 Mm) + sun-relative inscatter LUT consumption by sky shell + orbit drape (S3-2).
- `FAR-200` — move Ocean/Weather/EntityCluster onto the main frame encoder (S6-7, S6-5).
- `FAR-003` — pool + revision-gate the GPU-cull sphere feed (S9-4).
- `FAR-107`/`FAR-409` — per-collection pick-instance repack + show-toggle compaction mechanics (S10-6).
- `FAR-408-C0` — depth-version tracking that makes the DP-H45 repack demand-correct without
  changing pick semantics (S7-4, S4-5).

---

## 14. (b) Next-campaign seeds (too big for C9, or gated on C9 outcomes)

1. **Reversed-Z migration proper (FAR-707 slice b)** — gated on C9-30 landing first and on the
   days-scale early-Z spike (§15). Weeks-scale, all-or-nothing, needs the
   `depth32float-stencil8` fallback story resolved.
2. **S1 frame-delta classification tier** (S1-6 + S1-3): revision system above the backend split
   (cameraDelta × contentRevision) so camera-only frames reuse environment commands and skip
   height/preload/binning. Gated on C9-11/C9-17 retained packets existing to be reused.
3. **Entity-at-scale campaign** (S10-A/B/C/D/E/F/G + S1-4): dynamic
   "static-except-position" lane, clustering/bulk-lane decoupling, declutter displacement gating +
   incremental clusters, lazy geometry updaters + time-sliced drain, batch sharding, path ring
   buffers + fixed-capacity polylines, ModelVisualizer static lane. A coherent multi-batch arc
   with its own 10 k-entity benchmark lane (current campaign scenes have no entities — build the
   lane first).
4. **Retained-command executor unification** (S9-3 + S9-1 residue): single canonical command
   shape / integer type tag, monomorphic executor, batch-level try/catch — sequenced after C9-17's
   command retention so the shapes stabilize first.
5. **Worker-renderer productization** (S5-3): benchmark lane first, then opt-in
   `Viewer({useWorkerRenderer})`. Structural main-thread ceiling raise.
6. **WGSL module-granularity program** (S8-5 + S3-7): per-pass entry-point splitting,
   dead-function elimination in the preprocessor, compilationHints; imagery `texture_2d_array` /
   scene-keyed layout tranches. Compounds with C9-33/C9-36.
7. **Geometry residency dedupe** (S11-3, FAR-204 extension): single canonical GPU copy for
   model/tile geometry + budgeted first-frame FR resource build + typedArray release policy.
8. **WASM bridge disposition** (S5-2): wire WasmCullBridge into command/quadtree cull;
   terrain bridges into the terrain workers; retire-or-consume WasmSortBridge; demote the rest
   from the public barrel. Explicit per-bridge decision item (Principle 7).
9. **2D/CV/ortho band economics** (S1-5 + S7-6): single command generation for wrap frames,
   empty-band block skips, ortho near/far fit, 2D BV-less audit.
10. **Voxel upload path** (S6-6) + **BufferMapper repair-or-retire** (S6-4) + **PP terminal-stage
    canvas targeting** (S4-6) + **lazy ID target** (S4-7) — small-slice cleanup wave.
11. **Globe debug-sentinel define strip** (S3-3) — could also ride any C9 batch touching
    GlobeTerrain.wgsl; listed here so it does not get lost.

---

## 15. (c) Reversed-Z (FAR-707) decision dossier — verdict

**VERDICT: GO for a two-slice sequence; NO-GO for reversed-Z as a monolithic Campaign-9 item.**

1. **Slice (a) — ship now, independent of reversed-Z (proposed `C9-30`, days, zero shader
   changes):** the frustum-count claim inside FAR-707 is a *binning bug*, not a depth-encoding
   problem. Three BV-less environment commands force 2 frusta on every default 3D frame (S7-1;
   WebGL runs 1; "2 vs 3" resolves to "2 vs 1" — 3 is unreachable under log depth). Fixing the
   binning collapses 3D to a single frustum, halves the per-frustum scaffold (S7-2), deletes the
   per-extra-frustum collection-UB duplication + 65 K aux culler (S7-5), and halves the pick-loop
   frustum walk — a risk-free structural ×2 on the frustum machinery. **Booking this inside
   FAR-707 would delay a cheap fix behind an expensive experiment.**
2. **Slice (b) — reversed-Z proper (weeks, behind the FAR-707 gate, next campaign):** after (a),
   reversed-Z remains the single biggest **unowned GPU-side lever**, and its real deliverables
   are: (i) restoration of hardware early-Z/Hi-Z on the 72 log-depth producer WGSL surfaces
   (S7-3 — every opaque draw currently shades all occluded fragments; GlobeTerrain samples up to
   16 imagery layers per fragment at peak horizon overdraw); (ii) deletion of the RGBA8
   depth-pack ecosystem via direct f32 depth sampling (removes 2–3 fullscreen pack passes/frame +
   surrounding boundaries — currently attributed to no owner); (iii) one depth convention
   end-to-end, killing the mixed-encoding bug class that burned C9-02B.
3. **Precision objection resolved:** reversed-Z f32 with infinite far ≈ 2⁻²⁴·eyeZ → ~2 cm at
   350 km — equal or better than log depth's quoted 0.42 m/quantum. Precision is NOT the blocker.
4. **Blast radius (counted):** 140 depthCompare flips / 47 files + clearValue 0
   (pipeline-cache-wide invalidation); 72 producer WGSL files; ~14 consumer families + 42
   `_logDepthEncodeNearFar` JS sites / 18 files + PickDepth CPU decode; RGBA8 pack cannot
   represent reversed-Z far-field (~1e-7 quanta) so pick/classification depth moves to r32float
   or direct sampling; needs `depth32float-stencil8` (optional feature) with a real fallback
   story — a partial fleet is the "second permanent architecture" the FAR plan forbids;
   **all-or-nothing landing** (the pick-fleet mixed-encoding lesson binds equally); TAA
   `previousViewProjection` convention must carry the flip; 2D/CV/ortho are NOT helped (linear
   depth — S7-6) so the frustum loop and per-slice machinery survive in those modes regardless.
5. **Sequencing hazard (act this campaign):** `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH` (QUEUE rows
   121/134-135) is actively ADDING log frag_depth to ~15 more pick producers — the exact surface
   slice (b) must convert back. **Run the cheap spike first** (one probe scene, `defines=0`
   //>>else branches + reversed-Z infinite-far projection + depth32float + greater-equal; measure
   fragment-invocation delta with existing gpuPassCost timestamps) BEFORE that conversion lands,
   and record the connection in both work items.
6. **Promotion metric for slice (b):** measured early-Z fragment-rejection rate on
   horizon-oblique globe + dense-tiles probes, plus pack-pass elimination count, plus no
   pick/classification regression at horizon ranges. If the spike shows <20–30 % fragment-work
   reduction on the weak-FPS views, reversed-Z stays parked and only (a) + content-gating
   (S7-2/S7-4) proceed.

---

## 16. (d) TTFF budget + fix plan (S8)

Measured: rendererReady→firstFrame **WebGPU 163.8 ms vs WebGL 18.1 ms (9.1×)** offline-core;
**+150–200 ms in 5/5 Gate-A reps**; setupToStable +1.4–1.6 s (settle iterations 58–66 ms vs
22–25 ms, 2.6×); WebGPU long tasks: **zero** (cost is spread per-frame, §S8-7).

| # | Stage | Serial today? | Est. cost | Finding |
|---|-------|---------------|-----------|---------|
| 1 | WebGPU chunk fetch + parse/eval (~91 % of 6.6 MB renderer source + eager WGSL strings; ESM ≈3.05 MB minified; IIFE = 527 module initializers in one tick) | yes — before adapter | 50–250 ms | S8-4 |
| 2 | requestAdapter → negotiate → requestDevice | yes — before scene build | 30–120 ms | S8-2 |
| 3 | Context init tail (inline dynamic import, default textures, dead awaits) | yes | 5–20 ms | S8-2 |
| 4 | Scene/Globe JS construction (`new CesiumWidget`) | yes — after 1–3 | 100–300 ms (device-independent; WebGL starts immediately) | S8-2 |
| 5 | Frame 1: sync pipeline wall + 2×239 KB GlobeTerrain module compiles | yes | **measured +146 ms vs WebGL** (offline core; more with imagery/sun/moon/FXAA) | S8-1/3/5 |
| 6 | Settle window: async pipeline arrivals, per-variant compiles, imagery realization + 513 private mip submits | — | **measured +1,579 ms vs WebGL to stable** | S8-7 + C9-12A/FAR-200 |

**Ordered fix plan (leverage/effort):**

1. **S8-2(i–iii)** — adapter prefetch concurrent with the chunk import + hoist the inline
   `WebGPUPrimitiveIndexUtils` import + delete the two dead awaits. Small; overlaps stages 1–3
   under stage 4.
2. **S8-1** — real prewarm at init (`warmUpGlobeRenderer` + `preloadBatch` for the deterministic
   boot set). Moves the stage-5 compile wall into the stage-1–4 idle window; fire-and-forget.
3. **S8-3** — async-pipeline-cache adoption, model cache first (`C9-33`); PP-set prewarm on HDR
   toggle. Kills the residual frame-1 wall AND the mid-session variant hitches the p99 gate sees.
4. **S8-4** — lazify the ~15 cold eager feature-renderer registrations (Model's 215 KB WGSL
   string is the single biggest win); shrinks stage 1 and the webgpu-only bundle.
5. **S8-5** — WGSL module splitting / dead-function elimination / compilationHints. Long-pole;
   compounds with everything above and future-proofs the growing 319-file corpus.
6. **Settle-window rule (S8-7):** any fix claiming `navigationToStableMs` credit must reduce
   GPU-submit traffic (coalesce the 513 private mip submits, batch tile uploads — C9-12A/FAR-200),
   not main-thread closures; add a first-complete-frame metric (tiles rendered == tiles selected)
   to the harness.

Items 1–4 are packaged as proposed row `C9-36`; item 3 doubles as `C9-33`.

---

## 17. Findings that CONTRADICT a current C9/plan assumption

1. **"WebGPU already renders single-frustum in 3D."** FALSE — the default frame runs 2 frusta at
   every altitude, forced by the fork's own BV-less env commands (S7-1). Any C9 telemetry or cost
   model normalized per-frustum under-counts the fixed scaffold by ×2. (This also corrects the
   earlier S7 draft itself.)
2. **"Settle-time improvements will come from main-thread churn fixes."** Measurement says no:
   WebGPU recorded ZERO long tasks across all Gate-A reps while paying 2.6× per settle iteration —
   the stable-time gap responds to submit/upload batching (C9-12A/FAR-200), not closure work
   (S8-7). C9-18-style wins should not book stable-time credit.
3. **"Backend CPU wins can deliver the ≥2× goal by themselves."** Two independent ceilings say
   otherwise: the ~4–5 ms avg / 8–10 ms p95 shared-frontend floor above the split (S1-6), and the
   ~1.6 GB/frame MSAA boundary bandwidth ceiling (S4-2) — neither is touched by any current C9 row.
4. **"The empty-pass skip optimization holds for tile scenes."** Defeated: the phantom translucent
   command (S11-1) makes the TRANSLUCENT pass non-empty for every tileset frame, keeping
   OIT/alpha machinery and the back-to-front sort alive.
5. **"The Scene derived-command dirty gate prevents needless regeneration."** Decorative for the
   largest command family: globe tile commands re-dirty every frame by design (free-list
   recycling, S1-1).
6. **"Log depth is uniformly the right production default for WebGPU."** It costs early-Z on 72
   producer surfaces and WebGPU (unlike WebGL) has a sanctioned escape; meanwhile
   `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH` is expanding the log-depth surface that a reversed-Z
   migration must convert back — the two streams pull opposite directions and no document connects
   them (S7-3, §15.5).
7. **"A zero-command frustum can safely skip the DP-H45 depth re-pack."** A naive count gate
   CHANGES pick semantics — the packed texture holds cleared+depth-plane depth at defaults;
   correctness requires depth-version tracking (S7-4). Guards any FAR-405/C9 batch touching the
   frustum loop.
8. **"The FAR-303 ring win generalizes as-shipped."** It has exactly one consumer (globe camera
   UB); the Primitive/Polyline/collection/effect layer still fans out 100–500+ per-object
   writeBuffer calls per frame (S6-3) — the "87 % fewer writes" claim boundary is terrain-only.
9. **"prewarm exists" / "first-frame stutter is imperceptible"** (the `_warmUpPipelines` comment):
   the prewarm is a no-op with zero preloadBatch callers, and the stutter is measured at
   +146–200 ms in 6/6 artifacts (S8-1).
10. **"The bulk-visualizer win covers the 10 k-marker story."** Only while clustering is OFF and
    everything (incl. position + clamp) is constant; enabling clustering forfeits the entire bulk
    lane by construction (S10-3), and clamped/dynamic entities never qualify (S10-1).

---

*Section sources: full per-stratum evidence files were produced under the session scratchpad
(`perfdive/S1..S11*.md`); this register preserves their technical content. Anchors are live-tree
line numbers as of 2026-07-16 and will drift — treat file:line as a locator hint, symbol names as
the durable reference.*
