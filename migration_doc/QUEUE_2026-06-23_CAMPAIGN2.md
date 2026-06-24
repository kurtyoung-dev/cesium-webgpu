# WebGPU Work Queue — Campaign 2 (2026-06-23)

Successor to [`QUEUE_2026-06-22.md`](QUEUE_2026-06-22.md), which cleared Tiers 1–3
(correctness, picking, visual parity) and landed git Batches 355–369 — including
the cloud trilogy (363 shape / 365 grain / 366 size = WebGL parity), 367
compute-engine-wiring, 368 uniformstate-viewport, the 380/381 stale-doc
closures, and the 369 KTX2-IBL producer (built + verified but reverted, blocked
on the transcoder prereq — see Batch 1 below).

**Provenance.** Built by a 6-source parallel-extraction workflow
(`webgpu-next-campaign-extract`, 2026-06-23): the two halves of
`DEFERRED_WORK.md`, the prior queue's open tail + honorable mentions,
`FEATURE_INVENTORY.md` §C/§D, the migration backlog + audit trio, and an
epic-splitter — **129 raw → 116 unique candidates**, then manually de-duped,
status-verified against git, and sequenced into these 25 batches. The full
candidate set (the ~90 not selected) is the standing backlog; the honorable
mentions + likely-stale exclusions are listed at the bottom.

> **Re-verify each item vs `DEFERRED_WORK.md` + `git log` before starting it** —
> this queue is a snapshot and the tracking docs drift as batches land. Several
> extraction candidates were already shipped (see "Likely-stale exclusions").

> Git batch numbers continue from **370**. Batch labels below (C2-1 … C2-25) are
> the campaign execution order.

---

## Autonomous-run charter (carried forward, user-approved)

1. **Order:** top-down through the tiers; fully finish each batch (implement →
   `gulp build` → Playwright probe → **READ the PNGs** → commit + push as
   kurtyoung-dev) before the next.
2. **Stale items:** if already done (verify in code + git log), mark resolved +
   move on — no stop.
3. **Test assets:** if nothing local triggers the bug, AUTHOR a synthetic asset +
   keep it as a regression fixture.
4. **New bugs:** track in `DEFERRED_WORK.md` (Principle 9) + continue — don't
   rabbit-hole unless it blocks the current fix.
5. **Shared-infra / critical-path fixes:** proceed, but **baseline-isolate** AND
   add a "didn't-break-the-existing-scene" probe alongside the feature probe.
6. **Large (L) features:** each as its own focused batch, committed in verifiable
   increments (epics are pre-sliced below).
7. **Unverifiable / blocked fixes:** document precisely + DEFER (skip to next) —
   never ship unverified/broken code; keep the verified half as Principle-7
   scaffolding (cf. Batch 369's KTX2 producer).
8. **ONLY STOP FOR:** a destructive/irreversible action, a true architectural
   fork with no sensible default, or repeated unexplained failures.
9. **Always:** stay on `main`, push as kurtyoung-dev, never `--no-verify`,
   baseline-isolate every rendering claim.

---

## Tier 1 — Functional bugs + the KTX2-IBL unblock (do first)

> ✅ **TIER 1 COMPLETE (2026-06-24)** — all 5 batches landed + pushed, git Batches
> 370–374: C2-1 (370, ae21c21603), C2-2 (371, 9fae6c1c7e), C2-3 (372, 53b8d9b30d),
> C2-4 (373, 909a0a5ee7), C2-5 (374, 075824a871). Surfaced
> NEW-WEBGPU-ATMOSPHERE-LUT-BGL-INCOMPAT (tracked in DEFERRED). Next: Tier 2 (C2-6).

- **C2-1 · NEW-WEBGPU-KTX2-TRANSCODER-FORMATS** (M, high) — `loadKTX2()` throws
  `"supportedTargetFormats is required"` on a `WebGPUContext` for ANY KTX2 (even
  uncompressed): the transcoder's module-level supported-format set, populated
  during WebGL `Context` init from compressed-texture extensions, is never set up
  for WebGPU. **Fix:** register WebGPU `GPUFeatureName` → KTX2 format flags in
  `WebGPUContext` init (`texture-compression-bc/etc2/astc` → `setKTX2SupportedFormats`).
  Unblocks C2-2 + all WebGPU KTX2 consumers. **Probe:** `diag-ktx2-ibl-shape.mjs`
  (currently shows the throw → should show resolved buffers).
- **C2-2 · NEW-MODEL-IBL-KTX2-CUBEMAP-WEBGPU** (M, med) — authored
  `imageBasedLighting.specularEnvironmentMaps` KTX2 cube never readies on WebGPU
  (silent procedural fallback). The producer + FR lifecycle are **already built +
  verified** (`WebGPUSpecularEnvironmentCubeMap.ts` scaffolding from Batch 369);
  once C2-1 lands, re-wire `ensureWebGPUSpecularSource` in
  `WebGPUImageBasedLighting.ts` (the reverted Batch-369 diff). **Probe:**
  `probe-model-ktx2-ibl.mjs` (3-way: webgl-KTX2 / webgpu-KTX2 / webgpu-procedural).
- **C2-3 · NEW-WEBGPU-KHR-MATERIALS-UNLIT-BLACK** ✅ DONE (Batch 372) — **stale
  bug.** The WebGPU unlit path has shipped since git Batch 119; the B359 "black"
  was a DP-H37 (VEC3 COLOR_0) symptom (unlit outputs `baseColor·vertexColor`),
  fixed by DP-H37's B359 widen-to-RGBA. Verified + locked with a permanent
  regression probe (`probe-unlit-vertexcolor.mjs`) + asset
  (`unlit-vec3color-quad.gltf`): WebGPU renders the gradient (not black), matches
  WebGL within 11.1/channel (READ both PNGs). No code change.
- **C2-4 · NEW-MODEL-MORPH-TANGENT-DELTAS** (S, low) — WebGPU morph interleaves
  only POSITION+NORMAL deltas; a normal-mapped morphed mesh keeps its rest-pose
  tangent → tangent-space normal drifts as it deforms. Mirror the shipped
  NORMAL-delta change (DP-H35): stride 8→12, +TANGENT slot, 3 lockstep sites +
  the TAA prev-morph loop stride. **Probe needs a hand-authored asset**
  (morph-TANGENT + normal map — none ships); author it. Niche.
- **C2-5 · MATERIAL-UBO-FIELD-AUDIT** (M, high) — the material UBO field↔offset
  alignment between each JS packer and its WGSL struct is **unaudited** across
  ~25 material types → silent std140/std430 misalignment corrupts material
  params. Audit every `Material*.wgsl` struct vs its JS packer; add a layout
  unit test. Correctness across all materials.

## Tier 2 — Visual-parity holes

- **C2-6 · NEW-WEBGPU-EXAG-WATER-STREAKS** (M, med) — glacial-lake/water fragments
  render bright-blue on WebGPU under high vertical exaggeration where WebGL mutes
  them. Already investigated (Batch 365): water-color (`computeEnhancedOcean`) +
  WebGPU-side atmosphere ruled out — resume with the **2×2 webgl/webgpu × atmo-on/off**
  diagnostic to test whether WebGL's atmosphere/fog is the muting agent, then
  match the divergent globe-FS lighting/material water-fragment term.
  **Probe:** `probe-exaggeration-3d.mjs` + extend `diag-exag-water-streaks-source.mjs`.
- **C2-7 · NEW-LOG-DEPTH-POINTCLOUD-PRODUCER** (M, med) — the standalone
  `WebGPUPointCloudRenderer` (3D-Tiles PNTS / EDL) is the last opaque producer
  NOT writing log depth (grep-confirmed 0 `frag_depth`/`LOG_DEPTH`) → mis-sorts vs
  log geometry at FAR range. Apply the established producer recipe; the EDL
  neighbor-depth compare must reverse log first. **Probe:** PNTS at far range,
  WebGL-vs-WebGPU sort parity.
- **C2-8 · NEW-SUN-MOON-FIDELITY** (M, med) — sun/moon disc fidelity (glow, size,
  bloom interaction; moon divergence noted Batch 267) below WebGL parity;
  default-visible in any globe+sky scene. New sun/moon parity probe + WGSL
  disc/glow tuning.
- **C2-9 · NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION** ⏸️ **DEFERRED (verify-first,
  Batch 375) — narrow fix already wired + goal moot.** Two findings: (1) the
  `windowToEye` log-reverse this batch asks for ALREADY EXISTS
  (`WebGPUGroundPrimitiveRenderer.js:921`, gated on `logDepthActive`=TRUE since
  B251). (2) The far-corner *precision* goal is MOOT because
  `probe-classifier-textured-materials.mjs` shows the textured classification
  materials (Stripe/Checkerboard/Grid/Image) render **0px on WebGPU** (Color
  renders; READ PNG = blank) — even though DEFERRED claims B185/B198 shipped them.
  So either a regression since B185 or a probe-scene mismatch; either way the real
  gap is "textured GroundPrimitive classification renders nothing on WebGPU,"
  which is a separate, larger investigation than far-corner precision. Surfaced
  as **NEW-WEBGPU-GROUNDPRIM-TEXTURED-CLASSIFICATION-ZERO** (DEFERRED). No code
  shipped for C2-9 (no artifact to fix until textured classification renders).
- **C2-10 · NEW-WEBGPU-GRID-MATERIAL-PATTERN-MISSING** ✅ DONE (Batch 376) —
  ported `GridMaterial.glsl`'s derivative-based constant-PIXEL-width AA into both
  `PrimitiveMatGrid{Flat,Lit}.wgsl`. Verified `probe-grid-multizoom.mjs` (extruded
  Grid, 2 zooms): WebGPU matches WebGL (1263≈1260 line-runs, median width 3, zoom
  ratio 1.5), READ PNG = crisp AA grid; baseline-isolated safe (old≡new in the
  flat scene). Surfaced **NEW-WEBGPU-FLAT-MATAPPEARANCE-POLYGON-MATERIAL-SOLID**
  (flat height-0 polygon materials render solid on WebGPU — pre-existing st issue,
  both old+new shader; same class as C2-5/C2-9). Stripe/Checker/Dot = follow-up.

## Tier 3 — Polyline appearance completion (376 epic, sliced)

- **C2-11 · 376a — Polyline appearance PICK** (M, med) — COLOR (B343) + MATERIAL
  (B344) slices ship but both clear pickCommands → appearance polylines are
  unpickable. Add a pick VS+FS (per-instance pick color from the batch table) +
  a slot-0-only blend-stripped pick pipeline in
  `createPolyline*AppearanceCommands`.
- **C2-12 · 376b — Polyline appearance 2D/CV/Morph** (M, med) — 3D-only today.
  Plumb `position2DHigh/Low` + `morphTime` lerp into `csm_polylineCommon.wgsl`
  screen-space expansion (mirror `PolylineCommon.glsl` 2D path + the
  globe/billboard morph-lerp convention).
- **C2-13 · 376c — Polyline appearance effects + log-depth** (S, low) — appearance
  pipelines have no effects bind group (shadow-receive/clipping) and no log-depth
  write. Add the czm log-depth write + wire the shared effects bind group.
- **C2-14 · 376d — Textured polyline materials** (M, low) — the B344 material path
  is UB-only; `PolylineImageMaterial`/`DiffuseMap` render untextured. Add a
  texture+sampler bind group + a textured FS variant.

## Tier 4 — Volumetric cloud-layer fidelity (379 epic, sliced)

> The procedural raymarcher already SHIPS (Phases 6a-6d). These are the fidelity
> upgrade. Opt-in (`enableVolumetric=false` default) → low blast radius. NB: keep
> "multi-scatter" as the cheap Schneider approximation, not the research-grade
> froxel non-goal.

- **C2-15 · 379a — Perlin-Worley cloud noise** (M, med) — `ProceduralClouds.wgsl`
  uses only value-noise FBM (no Worley). Add the Schneider/Nubis Perlin-Worley
  remap: low-freq Perlin-Worley FBM base shape + high-freq Worley FBM edge
  erosion (reuse a `CloudNoise.wgsl` helper or inline).
- **C2-16 · 379b — Cloud weather-map coverage/type/density** (M, med) — coverage
  is a single scalar today. Add a procedural/sampled 2D weather map driving
  spatial coverage + cloud-type (stratus→cumulus height-gradient remap) + density
  so clouds vary across the sky.
- **C2-17 · 379c — Cloud lighting: dual-lobe HG + cheap multi-scatter** (S, med) —
  `hgPhase` is single-lobe + `beerPowder` single-octave. Add dual-lobe HG
  (forward+back, silver lining) + the cheap multi-octave multi-scatter
  approximation (N attenuated octaves).

## Tier 5 — Structural metadata + pickMetadata (DP-H46 epic, sliced)

- **C2-18 · DP-H46a — WGSL structural-metadata: property attributes** (M, med) —
  no `Metadata*.wgsl` exists; `MetadataPipelineStage`/`MetadataStage*FS.glsl` are
  GLSL-only. Port the simpler half: per-vertex property-ATTRIBUTE access (Metadata/
  MetadataClass WGSL structs + per-property accessors) into the WebGPU model shader.
- **C2-19 · DP-H46b — WGSL structural-metadata: property textures** (M, med;
  prereq C2-18) — the harder half: property-TEXTURE sampling (channel-packed).
  Upload property textures in the WebGPU model loader + sample/unpack in WGSL.
- **C2-20 · DP-H46c — pickMetadata producer** (M, med; prereq C2-18/19) — the
  original DP-H46 consumer. Orchestration/readback/decode are already
  backend-agnostic; build the WGSL metadata-pick variant + `derivedCommands.
  pickingMetadata.pickMetadataCommand` + `selectCommandVariant` routing.

## Tier 6 — Infrastructure leverage / perf / collections / headline

- **C2-21 · FORK-41-HIZ-CONSUME-FLIP** (M, med) — Batch 291 fixed 3 OcclusionTest
  bugs but `_hiZConsumeEnabled` stays false: the 4-corner max-Z sample reads
  far-plane background where a sphere rect overhangs un-drawn pixels → `hitRatio=0`.
  Sample the full footprint via a min/max Hi-Z mip loop (or "any background texel →
  visible"), verify the `ndcToUV` Y-flip, re-run `probe-fork41-occlusion.mjs` with
  `hiZConsume(true)` asserting `hitRatio>0` + **pixels unchanged**, then flip the default.
- **C2-22 · MAINT-ERROR-PIPELINE-FALLBACK** (M, med) — no `_createErrorPipeline`
  exists; a model with a failed PBR pipeline silently render-holes. Add a
  Three.js-style flat-magenta fallback returned by `getOrCreatePipeline` on
  async-reject. Small lift, big debugging/UX win for malformed assets.
- **C2-23 · DP-H18 — depthFailAppearance** (M, med) — no twin shader/pipeline/
  uniforms on WebGPU (grep: 0 `depthFailColor`/`fragmentDepthFail`) → see-through
  highlighting of occluded primitives is broken. Build the depth-fail pipeline
  variant (reversed depth test) + twin fragment + uniform wiring, mirroring the
  color-appearance twin pass.
- **C2-24 · WEBGPU-COLLECTIONS-FAR-SURFACE-DEPTH** (L, high) — after the B218-219
  close-camera fixes, FAR-camera billboard/point/label are still 0px: depth-test
  OCCLUSION (not clipping) — the collection writes a depth that doesn't match the
  globe's per-slice depth encoding at the same surface point. Mirror the globe's
  per-slice depth write/encode in the collection pipelines (OR formally document
  `disableDepthTestDistance` as the supported path). Multi-part. **Probe:**
  `probe-billboard-2d-debug.mjs` (3D mode).
- **C2-25 · NEW-DYNAMIC-ENVMAP-FULL-SCENE** (L, med — headline) — the procedural-sky
  env map ships, but reflections don't include real scene content (terrain, 3D
  Tiles, glTF). Add sky/space/sun renderers accepting arbitrary view matrices +
  per-face cubemap render passes + change-threshold trigger + post-capture IBL
  prefilter/republish + mipmap gen, wired through `DynamicEnvironmentMapManager.update`.
  ~250 LOC; the headline reflective-scene visual.

---

## Likely-stale exclusions (extraction candidates that appear already shipped — verify before re-queueing)

- **NEW-BILLBOARD-SIZE-PARITY** — RESOLVED Batch 275 (atlas sub-rect + glyph
  translate + HiDPI). The `WEBGPU-COLLECTIONS-2D-COPLANAR-DEPTH` residual is the
  remaining sliver.
- **NEW-SPLAT-MULTIFRUSTUM-DEPTH-COMPOSE** — marked done in QUEUE_2026-06-22's
  resume point; re-verify before re-queueing.
- **NEW-TAA-PIPELINE-ORDER-RECONCILE** — RESOLVED Batch 290; docs closed Batch 367.
- **DP-H48 / TEME star rotation** — STALE-RESOLVED (Batch 367 docs).
- **NEW-WEBGPU-CUBEMAP-HDR-DECODE** — the HDR faint-star fix was auto-exposure
  (Batch 364); this cubemap-decode TODO darkens faint pixels and is NOT the lever.

## Honorable mentions (strong, just outside the 25)

NEW-MATERIAL-PER-BACKEND-SHADER-SOURCE (last `isWebGPU` scene branch — but the
authored fix *relocates* rather than eliminates; needs a cleaner approach) ·
NEW-MODEL-WGSL-CUSTOM-SHADER (L) · 377a/b/c entity→GPU keyframe bridge (CZML
satellite tracks; kernel already ships) · NEW-GS-CLASSIFICATION-DEPTH (splat
translucent classify vs splat-depth) · NEW-GBUFFER-CONSUMER-CLUSTERED-LIGHTING
(blocked by maxBindGroups=4) · ARCH-CONTEXT-DECOMP / ARCH-SCENERENDERER-DECOMP /
NEW-TS-CONVERT-JS-RENDERERS (large-file decomposition) · FEAT-3DT2-02/03/05
(metadata/RTE/Draco-KTX2 3D-Tiles audits) · HDR-DISPLAY (wide-gamut canvas
output) · WGF-1-EXPAND (hardware clip-distances → Primitives/Models) ·
NEW-WEBGL-CV-POINT-ZERO (WebGL renders 0 CV points; WebGPU is the correct side) ·
MAINT-FORMATGEN-CONTRACT · the ~70 remaining audit/maintainability items.
