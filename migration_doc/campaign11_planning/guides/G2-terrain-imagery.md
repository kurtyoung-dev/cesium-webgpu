# Campaign-11 Cluster Guide G2 — `terrain-imagery` (11 items) + `submit-residency` (4 items)

**Author:** C11 cluster-guide author (read-only sweep) · **Date:** 2026-07-18
**Anchors verified against HEAD `5b98ab9698` (Batch 699, `main`).** The register was cut at
`aef553d592` (Batch 698); one batch has landed since (C10-02, `WebGPUModelRenderer.ts` +
tiles-side files — relevant drift is called out per item). At verification time the engine
source directories (`packages/engine/Source/{Renderer,Scene,Shaders}`) were **clean** in the
working tree, so working-tree greps == HEAD; C10 workers are still active, so **every worker
must re-grep anchors by symbol at execution time** — symbols are authoritative, line numbers
are hints.

**Register:** `scratchpad/c11/C11_CANDIDATE_REGISTER.md` §5 (`terrain-imagery`) + §10
(`submit-residency`). Items are referred to ONLY by their register names — the orchestrator
assigns campaign numbers at assembly.

**Charter rules that bind every item here (no exceptions):** no feature degradation for a
metric; rule-3 conservatism (unknown demand stays conservative); probe-first (Principle 8);
premise-verify-first (many register rows are stale — each item below carries a premise
stamp); one concern per slice; perf evidence = moving-altitude campaign only
(`DEBUGGING_GUIDE.md` canonical route), never idle-soak.

**Cross-cutting trap — the landed Batches 683–699 changed the measurement floor.** Every
C9-01-era magnitude quoted in the source docs (descriptors/frame, packs/frame, staging
bytes/route) was measured under the **2-frustum** default. Batch 693 (C10-01) collapsed the
default 3D frame to **1 frustum**; Batch 697 (C10-03) made the scene-color resolve
demand-driven; Batch 699 (C10-02) halved unstyled tile command counts. **Every item below
must re-capture its own PRE baseline at current HEAD before claiming any delta** — quoting a
C9-01 number as the live PRE is an automatic audit finding.

---

## Cluster item map (execution-order recommendation)

| # | Register item | Pri | Effort | Premise @ 5b98ab9698 | Model tier |
|---|---|---|---|---|---|
| 1 | NEW-WEBGPU-OCEANNORMAL-PER-CALL-REUPLOAD | P1 | S–M | **CONFIRMED** | opus-or-sol |
| 2 | Streamed-imagery never-shared prompt-retire verification lane (B686 F2a) | P2 | S–M | **CONFIRMED** (no probe exists) | opus-or-sol |
| 3 | C9-11-RETAINED-TERRAIN-DESCRIPTORS / FAR-309 remainder | P1 | L–XL | **CONFIRMED** (store absent) | fable (design) → opus (slices) |
| 4 | C9-12-TERRAIN-STATIC-DYNAMIC-UPLOAD-SPLIT / FAR-303 Option A | P1 | XL | **CONFIRMED** (gated on #3) | fable (WGSL slice) + opus (packers) |
| 5 | C9-15-TERRAIN-GPU-RESIDENCY-BUDGET / FAR-203 / FAR-208 | P1 | L | **CONFIRMED + new structural finding** | opus-or-sol |
| 6 | C-R1-GLOBE-RENDERSTATE | P1 | M | **CONFIRMED** | fable (audit) → opus |
| 7 | S5-4 — per-tile worker-computable scans | P2 | S | **CONFIRMED** (line drift) | opus-or-sol |
| 8 | S3-3 — GlobeTerrain debug-sentinel stripping | P2 | S–M | **CONFIRMED** (count unverified) | opus |
| 9 | S1-1 — WebGL-lane globe derived-command regen | P2 | M | **PARTIAL** (shadow sub-claim stale post-B695) | fable |
| 10 | S6-3 — uniform-ring fan-out beyond terrain | P2 | M | **CONFIRMED** | fable (scoping) → opus |
| 11 | DP-H19-SHADER-DECODE-RUNTIME | P2 | M | **CONFIRMED** (bit never flipped) | opus |
| 12 | FAR-200-S1-PHYSICAL-QUEUE-TIMELINE | P1 | M | **CONFIRMED** (no timeline exists) | opus-or-sol |
| 13 | FAR-200 private-submit consolidation (S6-7 + S6-5) | P1 | M–L | **CONFIRMED** (all 3 sites live) | opus-or-sol (3 sub-slices) |
| 14 | Geometry-residency dedupe (S11-3 / FAR-204 / item-89) | P1 | L | **CONFIRMED** | fable (decision) → opus |
| 15 | NEW-PICK-ID-OWNERSHIP-MODEL | P2 | M | **PREMISE-PARTIAL** (eagerness unconfirmed) | fable |

---

# PART 1 — `terrain-imagery`

## 1. NEW-WEBGPU-OCEANNORMAL-PER-CALL-REUPLOAD (P1 · S–M · perf, correctness-adjacent)

### What + why (evidence trail)

Filed 2026-07-17 as a Batch-685 C9-12A reconciliation spinoff; premise CONFIRMED then by
**runtime instrumentation** (20,155 `Globe oceanNormal` mip-prep enqueues over 540 rendered
frames on the GridImagery 3-altitude route ≈ **37/frame**, ≈ per tile per frame) and by code
inspection. Source: `DEFERRED_WORK.md` ~line 21 (full filing); C10Q §4 lists it as an
**unowned W1 cheap-rider** with a "clear on/off oracle (job-count counter)". Every call to
the water/ocean group-2 bind-group builder re-uploads the ocean normal map: a fresh
`GPUTexture` + `copyExternalImageToTexture` + a 9-level mip chain per tile per pass, and the
fresh **view identity** then defeats the group-2 bind-group cache key next frame
(self-perpetuating churn). Orphaned overwritten cache entries decay GC-paced (VRAM churn, no
explicit destroy on the overwrite path). **Pre-existing, not a C9-12A regression** — C9-12A
merely coalesced the formerly-private mip submits into the frame-owned
`"ImageryMipPreparation"` submit.

### Architecture today (verified at 5b98ab9698)

- `WebGPUGlobeSurfaceRenderer.createTileCommands` rebuilds `bindGroup2Final` via
  `_createWaterOceanMaterialBindGroup` on **both** the material and no-material branches —
  call sites now at **:1762 / :1769** (DW said ~1734–1748; drifted ~15 lines, symbols intact).
- `_createWaterOceanMaterialBindGroupInner` (**:2088**): the oceanNormal block at
  **:2110–2135** resolves `onm._webgpuSource ?? onm._source ?? onm.image` (the
  NS-WEBGPU-OCEAN-BRIGHT-NO-WAVES fix — do not disturb) and calls
  `uploadImageSourceHelper(this, source, "oceanNormal", this._oceanNormalMapCache)` with
  **no cache-hit guard**.
- Contrast the guarded pattern **in the same file**: `_resolveOrUploadMaterialTexture`
  checks `cached.source === value → return cached.view` at **:2073–2074** before uploading.
  That is the exact memo shape the fix mirrors.
- `uploadImageSource` (`WebGPUGlobeSurfaceTextures.ts:758`) **never checks its cache before
  creating a texture** — callers own the guard (by design; confirmed by reading the function).
- Cache slot: `_oceanNormalMapCache: Map<string, ImageryGPUTexture>` at **:261**; renderer
  destroy path iterates + clears it at **:2647–2654** (Batch-686 F7: those destroys are
  `noteInlineTextureDestroy`-stamped — keep that stamping on any new invalidation path).
- Mip jobs route through `ctx.enqueueImageryMipGeneration`
  (`WebGPUGlobeSurfaceTextures.ts:708`; context method `WebGPUContext.ts:2421`) into the
  frame-owned `"ImageryMipPreparation"` encoder.

### Implementation walkthrough

0. **Re-verify premise (10 min):** run any water-mask terrain scene (e.g.
   `probe-lake-water-mask.mjs` route or a `createWorldTerrain`-style route with
   `oceanNormalMap` bound) with the debug counter for mip enqueues; confirm ~per-tile-per-frame
   `Globe oceanNormal` jobs still occur. If the count is already ~1/session, STOP — someone
   landed the guard; report premise-dead.
1. Add a source-identity memo on the oceanNormal path: before calling
   `uploadImageSourceHelper`, check the single cache entry (`_oceanNormalMapCache.get("oceanNormal")`
   or a dedicated `{source, view}` field mirroring `_materialTextureCache`) and return the
   cached view when `cached.source === source`.
2. Explicit invalidation when `tileProvider.oceanNormalMap` / `_webgpuSource` **identity**
   changes: on miss-with-existing-entry, retire the old texture via
   `ctx.scheduleTextureDestroy` (NOT a bare `.destroy()` — a pending frame-owned mip job may
   still reference it; that is exactly the race Batch-686 F7 closed) and upload the new one.
3. Keep the resolver chain and the `instanceof` gate byte-identical — the placeholder
   fallback (`_placeholderView`) semantics must not change (flat-ocean regression class).
4. Add a debug-pragma'd counter (`_oceanNormalUploads`) readable beside the existing
   imagery counters so the oracle is scriptable.

**Invariants:** (a) ocean waves KEEP ANIMATING — the wave animation is driven by
`TIME_OFFSET` uniforms, not by re-upload, but "frozen ocean" is the named failure class if
anything about the source resolution changes; (b) group-2 bind-group cache hit-rate must
RISE (stable view identity restores the key); (c) zero behavior change with no
`oceanNormalMap` bound.

### Traps

- **Do not key on the string alone** — the cache key `"oceanNormal"` is a single slot; the
  guard must compare SOURCE identity, or a provider swap (new terrain provider mid-session)
  would keep serving the stale map.
- The B694 (C10-09) revision-skip pattern is the in-tree precedent for "identity → skip";
  cite it, don't reinvent a frame-counter heuristic.
- `_createWaterOceanMaterialBindGroupInner` also feeds wireframe/env-capture paths through
  the same group-2 builder — verify those still validate (placeholder UBO path :2137–2169).
- Do not fold in a group-2 bind-group cache change — the hit-rate recovery must come purely
  from stable view identity (one concern per slice).

### Verification recipe

- **On/off job-count oracle (the named acceptance):** instrumented run PRE = ~37 mip-job
  enqueues/frame labeled `Globe oceanNormal`; POST = 1 per source identity (first frame),
  then 0. Off-gate: with the guard disabled (temporary internal flag or PRE build), counts
  return to ~37 — on/off/restored.
- **Wave-animation oracle:** two WebGPU captures N≥30 frames apart on an ocean view must
  DIFFER in the water region (phase moved); a byte-identical pair = frozen ocean = FAIL.
- **Probes:** `probe-daytime-ocean-brightness.mjs`, `probe-lake-water-mask.mjs`,
  `probe-large-lake-water.mjs`, `probe-water-mask-coast-aa.mjs`, `probe-exag-water-streaks.mjs`
  (both backends where applicable) — all must stay green. `probe-fft-ocean.mjs` is the C6
  FFT ocean (a DIFFERENT feature) — run it as a no-regression gate only.
- **New probe:** `probe-oceannormal-reupload.mjs` — water-mask route, asserts the job-count
  oracle + wave-phase oracle + group-2 bind-group create counts
  (`CesiumDebug.globeBindGroups()` / `__webgpuGlobeBindGroupCache`) settle to ~0
  creates/frame.
- `capture-and-diff` globe-default band 0.43–0.77% crossBackend unchanged.
- Promotion stance: perf claim is named-stage (upload/mip work eliminated); whole-route
  CPU-p95 promotion only if the moving-altitude lane (with a water-mask terrain!) clears
  ≥5%/3× noise — the default campaign route may not bind an oceanNormalMap, so an honest
  "named-stage win, no route banner" outcome is acceptable (B694 precedent).

**Model tier:** opus-or-sol — fully specified, small blast radius. Land EARLY: it de-risks
group-2 measurements for items 3/4.

---

## 2. Streamed-imagery never-shared prompt-retire verification lane — B686 F2a (P2 · S–M · tooling)

### What + why

C10Q §4 intake row: the Batch-686 F2a path — **unique per-tile ImageBitmap realizations
retire promptly at zero refs** — has NO probe route exercising it. The B686 verification
lane used two GridImagery layers, and GridImagery **shares** tiles (realizations dedupe to
one per layer); the never-shared/owned retirement path was verified by review + types only.
This is a latent-leak sentinel: if prompt retirement silently breaks, real-imagery sessions
(every production stack) grow VRAM unbounded while the shared-lane counters stay green.
C10Q pairs this lane with the C10-30 feature-loss check.

### Architecture today (verified at 5b98ab9698)

- `WebGPUSharedImageryRealizations.ts`: diagnostics struct carries `zeroRefBytes` (**:79**);
  the zero-ref pool sweep + `BYTE_BUDGET` grace-LRU at **:200–221**; the never-shared
  semantics comment at **:166** ("a never-shared …").
- `WebGPUGlobeSurfaceTileBuffers.ts` `removeImageryTexture` (**:472+**): the Batch-686 F1
  hardening — shared entries `table.release(...)` with `ctx.scheduleTextureDestroy` deferred
  destroy; **never-shared entries retire promptly through the live context's deferred
  destroy (F2a)**; owned (`logicalOwner === "imagery"`) entries bump
  `imageryOwnedRetirements` / decrement `imageryOwnedLiveTextures` counters.
- Counters: `host._logicalCounters` (`imageryRealizationsCreated`,
  `imageryRealizationRetirements`, `imageryRealizationLiveBytes`, `imageryOwnedRetirements`,
  `imageryOwnedLiveTextures`) + `table.getDiagnostics()`.
- **No committed probe touches any of this:** repo-wide grep for
  `imageryRealization|zeroRefBytes` under `Tools/` hits only output JSONs from the C9-12A/C9-30
  API runs. Premise CONFIRMED.

### Implementation walkthrough

1. **Build the lane, not a fix** — this item is tooling; zero engine-code change (counters
   already exist; if a needed counter is missing, adding a debug-pragma'd counter is in
   scope, nothing else).
2. New probe `probe-imagery-neverShared-retire.mjs` (name it consistently with the
   `probe-*` inventory; suggested canonical: `probe-imagery-realization-retire.mjs`):
   - Route: a **real-imagery direct-upload lane** — a custom `ImageryProvider` whose
     `requestImage` returns a **unique per-tile ImageBitmap/canvas** (e.g. tile-coordinate
     text baked into each canvas), guaranteeing `shares === 0` and unique source identities →
     every realization is never-shared/owned.
   - Phase A (accumulate): load a view, record `imageryRealizationsCreated`, liveBytes.
   - Phase B (evict): move the camera far away / zoom so the quadtree releases tiles; assert
     `imageryOwnedRetirements` (or realization retirements for the owned lane) **advance
     promptly** (within a bounded number of frames — the deferred-destroy window is small,
     assert ≤ N frames, N from `scheduleTextureDestroy` batching), `zeroRefBytes` stays
     bounded (≤ `BYTE_BUDGET`), and `liveBytes` **plateaus** over a repeat A→B loop
     (2–3 loops; the C9-15 altitude-loop plateau oracle in miniature).
   - Assert zero console/validation/device errors throughout.
3. Wire it into the standing gate list (README of `Tools/visual-regression` + the
   DEBUGGING_GUIDE probe inventory — **the guide MUST be updated**, per its own sync rule).

### Traps

- GridImagery is explicitly the WRONG provider here (shares tiles) — that is the entire
  point of the lane.
- Don't assert exact byte values — assert **slope/plateau and bounds**; realization byte
  accounting varies with tile size/format.
- `requestRenderMode` invalidates idle observation — drive the camera (moving-altitude
  charter rule applies to probes too).
- If retirement does NOT happen promptly, that is a REAL BUG (F2a regression or gap) — file
  it per Principle 9, do not tune the probe thresholds until green.

### Verification recipe

The probe IS the deliverable. Acceptance: probe green at HEAD 3 consecutive runs; probe RED
when F2a is deliberately broken (mutation test: temporarily comment the owned-retirement
branch in a scratch build → probe must fail — prove the oracle has teeth, then restore).
Also run `capture-and-diff globe-default` to show the lane added no engine change.

**Model tier:** opus-or-sol. Effort S–M. Good W1-style opener; also a prerequisite
confidence-builder for item 5 (C9-15), which extends the same plateau-oracle shape to
terrain buffers.

---

## 3. C9-11-RETAINED-TERRAIN-DESCRIPTORS / FAR-309 — the remainder (P1 · L–XL · perf, multi-batch)

### What + why (evidence trail)

`DEFERRED_WORK.md` ~5229 (full design), C9Q §3.2/§6 W2-29. FAR-309 is "the campaign's
biggest single hot-path lever." **Landed core (Batch 682, byte-identical):** both globe-tile
`execute` closures were hoisted to ONE module-level function — that half is DONE and is a
regression gate now. **The remainder (this item):** retain the `TileDrawDescriptor`
objects, the command-wrapper objects, and the per-tile `readyLayers`/`commands`/`passLayers`
scratch across warm frames, keyed by an **exact revision tuple**, with per-frame in-place
refresh of dynamic offsets + non-3D BoundingSphere + derived pick/translucency commands.
Magnitude honesty (Batch-683 correction, repeated because it was mis-claimed once already):
the ~39,300 allocation figure is the **route TOTAL over 1,189 frames ≈ 33/frame**, not
per-frame. The win is real but modest per-frame; the strategic value is that the
revision-keyed packet store is **the prerequisite C9-12 consumes** (its static-slab
write-gate needs the "this tile's static bytes are unchanged" signal).

### Architecture today (verified at 5b98ab9698)

- Hoisted executor: `executeWebGPUGlobeTileCommand` at
  `Scene/GlobeSurfaceTileProviderRendering.js:56`, consumed by reference at **:1108** (color)
  and **:1161** (pick). It reads only
  `this._pipeline/_bindGroups/_bindGroup0DynamicOffsets/_vertexBuffer/_indexBuffer/_indexFormat/_indexCount`
  (dynamic-offsets branch at :62–66).
- Wrapper objects still built fresh per pass per tile: `_bindGroup0DynamicOffsets:
  cmdDesc.bindGroup0DynamicOffsets` at **:1065** (color) and **:1156** (pick).
- Descriptor production: `WebGPUGlobeSurfaceRenderer.createTileCommands` returns
  `TileDrawDescriptor[]` (**:926**, array minted at **:1143**, per-pass descriptor builder
  at **:1849**).
- **The retention store does NOT exist:** repo-wide grep for
  `TileRenderPacket|_useRetainedPackets` = 0 hits. Premise CONFIRMED — nothing landed since
  the deferral.
- Already-retained layers the remainder must NOT disturb: pipeline cache, tile-buffer cache
  (`_tileBufferCache`), the B241/B292 bind-group cache (group-0 keyed on ring-page identity
  + dynamic offsets, 99.66% hit), the B677 effects handle (`_getOrCreateFrameEffectsBindGroup`).

### Implementation walkthrough (S1 of the DW phasing; S2+ belong to item 4)

0. **Premise re-verify:** grep `TileRenderPacket` again at execution HEAD (a C10/C11 sibling
   may have started it); re-capture the allocation PRE on the 9-waypoint route at current
   HEAD (post-B693 single-frustum — expect DIFFERENT numbers than C9-01).
1. Build a per-(renderer-instance = per-device) `TileRenderPacket` store keyed by the exact
   revision tuple from the DW entry — reproduce it verbatim in the brief: mesh `vertices`
   identity; ordered per-layer texture-view identity + TS/rect bytes + ready count; material
   type + WGSL source identity; scene mode; water-mask identity + TS + gates; clipping
   enabled/len/union + useClipDistances; shadow/CSM/cloud-shadow view identities;
   translucency structure; `_scenePipelineFormatGeneration` **AND** `_logDepthEnabled`
   **separately**; debug flags; device generation; skirt gate.
2. Per-frame in-place refresh on packet hit: `_bindGroup0DynamicOffsets` (new ring slice
   every frame — this field is WHY naive retention was deferred), non-3D fresh
   `BoundingSphere`, derived pick/translucency command staleness.
3. Fallback lanes (legacy per-frame path): MORPHING, any active debug mode, translucent
   globe.
4. Counters: `retainedPacketHits/Misses/Invalidations` (debug-pragma'd), surfaced via a
   `CesiumDebug` accessor + DEBUGGING_GUIDE sync.

### Traps

- **Multi-view offset clobber (the reason it was deferred):** the same tile rendered into
  two same-device views/cameras within one frame must not share a mutated wrapper — the
  store must be per-view or the per-frame fields must be written immediately before each
  view's execute. Acceptance matrix REQUIRES the split-screen multi-view lane.
- **Format-generation flips:** HDR/MSAA (`_scenePipelineFormatGeneration`) and log-depth
  are SEPARATE axes in the tuple — merging them recreates the stale-pipeline hazard.
  Interacts with the standing-red NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION (`standing-reds`
  cluster): a retained packet must not extend the 1–2-frame stale-pipeline window that bug
  already exposes.
- **Pick mini-frames advance the ring** → scene-frame ring offsets are DEAD inside pick
  frames; dynamic slices MUST be re-allocated per pass type (DW verbatim).
- **B699 (C10-02) precedent:** translucent-twin gating changed tile command counts on the
  MODEL side, not globe — but if the C10-02 pattern migrates to globe commands, the
  translucency-structure tuple axis covers it. Keep the axis.
- Do not claim the C9-01 magnitude as PRE (B683 correction; single-frustum changed it again).
- One concern per slice: the S1 store lands with the LEGACY packers untouched — byte-for-byte
  staging behavior unchanged; only object allocation changes. The upload split is item 4.

### Verification recipe

- **Off-gate:** internal `_useRetainedPackets` A/B — off = byte-identical to today (this is
  the on/off/restored oracle).
- New probe `probe-retained-terrain-descriptors.mjs` (DW-projected name): asserts packet
  hit-rate ≥ threshold at settled camera, invalidation fires on imagery add/remove/reorder,
  alpha-fade mid-flight, water on/off, clipping mutate, exaggeration change, HDR/MSAA flip,
  2D/CV/morph fallback engages, and pixel parity per phase.
- Full acceptance matrix (DW verbatim, non-negotiable): `capture-and-diff` all scenes
  pixel-identical; split-screen both halves; 2D/CV/MORPH; imagery mutations; globe
  translucency; clipping; shadows+CSM; exaggeration; msaaSamples+HDR flip; LAKE water mask
  AND animating ocean; wireframe + fragment debug; pick/classification-pick; device-loss /
  multi-context; C9-02 terrain-ownership lanes; 9-waypoint `probe-camera-track` all green.
- Perf: moving-altitude lane, ≥5% CPU-p95 in the named stage or >3× noise; no route-segment
  regression. Given the ≈33/frame magnitude, expect a NAMED-STAGE claim, not a route banner
  — say so honestly up front.

**Model tier:** fable for Slice-design + the revision-tuple/multi-view design review (the
ambiguity and the correctness risk live there); opus-or-sol for the mechanical execution
slices once the store design is pinned. Multi-batch: do NOT attempt in one session (that is
exactly the honest-partial the C9 run recorded).

---

## 4. C9-12-TERRAIN-STATIC-DYNAMIC-UPLOAD-SPLIT / FAR-303 Option A (P1 · XL · perf, the cluster headline — HARD-GATED on item 3)

### What + why (evidence trail)

`DEFERRED_WORK.md` ~5231 (the fullest design in the cluster), C9Q W2-30, C10Q §4 seed with
explicit disposition: **"dedicated multi-batch slice family; do not open inside a wave."**
Both group-0 packers stage the FULL uniform width per tile per imagery pass through the ring
every frame: camera 232 floats (928 B → 1024 aligned) + tile 484 floats (1936 B → 2048
aligned) = **3072 B staged/tile/pass**; C9-01 measured ≈ **115.1 MiB aligned staging over
the 1,189-frame route**, coalesced by the ring into ~112.9 KB of `writeBuffer`/frame.
The intended lever (Option A) splits the WGSL group-0 structs into `ViewUniforms`
(once/frame) + `TileDynamicUniforms` (~128–256 B ring — the irreducible f64
`view × mesh.center` RTE product) + `TileStaticUniforms` (persistent slab, written ONLY on a
per-tile revision miss) = **~12× per-tile staging cut**.

**The rejected option (reproduce so no worker re-derives it):** Option B — per-tile
persistent FULL buffers with no WGSL change — is **FORBIDDEN**: the B292 group-0 bind-group
cache keys on (camera-page, tile-page) buffer IDENTITY with byte offsets as dynamic offsets;
one buffer per tile = one bind-group create per tile = regressing the 99.66%-hit cache the
campaign relies on ("never regress a working path for a metric").

### Architecture today (verified at 5b98ab9698)

- `WebGPUGlobeSurfaceTypes.ts`: `CAMERA_UNIFORM_FLOATS = 232` (**:166**),
  `TILE_UNIFORM_FLOATS = 484` (**:228**).
- Packer call sites in `WebGPUGlobeSurfaceRenderer.ts` — **drifted from the DW's :1348/:1358**:
  main path now **:1430 / :1440**; wireframe path **:2324 / :2334**; env-capture path
  **:2479 / :2489** (all three consume `createCameraUniformBufferHelper` /
  `createTileUniformBufferHelper` — the split must cover ALL THREE, plus pick vertex-stage).
- Ring: `WebGPUGlobeSurfaceCameraUB.ts` routes through
  `allocator.allocateAndWrite(uploadData, bufferSize)` at **:1054–1055** (allocator =
  `WebGPURingBufferAllocator.allocateAndWrite` :307; context flush sites
  `WebGPUContext.ts:2556/:3350`).
- No static/dynamic split, no persistent slab, no revision-keyed skip exists (grep confirms;
  both packs run unconditionally every pass).
- WGSL: `GlobeTerrain.wgsl` (~3300+ lines) single group-0 `CameraUniforms`+`TileUniforms`;
  BGL 0 in `WebGPUGlobeSurfaceLayouts.ts`; `_getOrCreateBindGroup0` shared by color,
  wireframe (`createWireframeTileCommands`), env-capture (`getOrCreateCaptureTileCommands`).

### Implementation walkthrough (the DW S0–S4 phasing — each phase lands green + byte-identical off-path)

- **S0** — DONE (B677 effects handle). Consume, don't rebuild.
- **S1** — item 3 above (the revision-keyed packet store). **HARD GATE: without it there is
  no correct "static bytes unchanged" signal, and a wrong signal is silent visual corruption**
  (stale imagery UV transforms, frozen ocean if `TIME_OFFSET` is misclassified static, stale
  exaggeration/clipping).
- **S2** — THE atomic WGSL slice: split into `ViewUniforms` / `TileDynamicUniforms` /
  `TileStaticUniforms`; pack ViewUniforms once/frame **preserving the
  `uniformState._logDepthEncodeNearFar` stash side-effect every frame** (depth-plane +
  classifiers depend on it); TileStatic to a persistent slab (fixed 256-B slots, free-list,
  grow-by-page, slot lifetime tied to the `_tileBufferCache` entry, deferred-destroy ≥3
  frames) written only on packet miss. Touches: `GlobeTerrain.wgsl` group-0 declarations +
  EVERY field access, `WebGPUGlobeSurfaceLayouts.ts` BGL 0, every pipeline layout,
  `_getOrCreateBindGroup0`, wireframe + env-capture + pick vertex paths. **One atomic
  revert-unit commit, pixel-identical across all scenes.**
- **S3** — fold the TileUniforms static list into the slab; detect function-valued imagery
  `alpha/brightness/…` at pack time → per-frame fallback for that tile; keep
  `TIME_OFFSET`/fog/exaggeration/split/HSB/translucency-rect per-view (EXCEPT the
  antimeridian-clipped `localizedTranslucencyRect` — per-tile-static-per-translucency-revision).
- **S4** — residual allocation sweep + counters (`staticTileBytesWritten`,
  `dynamicBytesWritten`) + DEBUGGING_GUIDE sync.

### Traps

- **NEVER** buy the byte drop with precision loss: no f32 planetary ECEF reconstruction of
  `view × center` — RTE stays CPU-f64 (charter + CLAUDE.md RTE section).
- **NEVER** skip the per-frame `_logDepthEncodeNearFar` stash.
- Pick mini-frames advance the ring — dynamic slices re-allocated per pass (same trap as
  item 3, doubled here because ViewUniforms is "once/frame" — define "frame" as
  scene-render-pass, and re-pack for pick mini-frames).
- The slab is ONE buffer identity with dynamic offsets — anything else re-breaks the B292
  cache (that's Option B through the back door).
- Item 1 (oceanNormal) should land FIRST — its fresh-view churn pollutes group-2 bind-group
  metrics you'll be watching during S2/S3 bring-up.
- S6-3 (item 10) is the same packer/ring family for NON-globe consumers — do not let a
  worker "helpfully" extend the ring to primitives inside this family (separate item,
  separate acceptance).
- C10 concurrency: if a C10 worker is in `WebGPUGlobeSurfaceRenderer.ts` when this opens,
  serialize — this family rewrites the file's spine.

### Verification recipe

DW-verbatim matrix (same as item 3's, PLUS): imagery function-valued alpha fade;
`probe-terrain-upload-split.mjs` (new, DW-projected name) asserting API-lane
`writeBuffer` bytes/frame drop materially from the **re-measured** Gate-A-successor baseline
on settled frames AND that static-slab writes are zero-work with no revision change /
byte-identical with one; moving-altitude lane ≥5% CPU-p95 named-stage or >3× noise, no
route-segment regression. Off-gate: `_useRetainedPackets`-style A/B + the S2 WGSL slice must
be pixel-identical BEFORE any write-gating lands (staging split with gate disabled = same
bytes every frame = byte-identical proof, THEN enable gating).

**Model tier:** fable leads S2 (the atomic WGSL slice — highest-risk change in the whole
cluster); opus-or-sol executes S3/S4 under the fable-pinned spec. **Effort XL, dedicated
multi-batch family — the orchestrator must schedule it as its own arc, not a wave rider.**

---

## 5. C9-15-TERRAIN-GPU-RESIDENCY-BUDGET / FAR-203 / FAR-208 (P1 · L · perf/lifecycle)

### What + why (evidence trail)

C9Q §8 row 47 (+§3.1 owner row): "Budget bytes, not entry count. Active/leased resources are
pinned; zero-lease resources enter grace LRU; retire once per frame after traversal and
destroy after last-use serial. Repeat altitude loops until live/high-water/retired byte
slope plateaus; avoid per-resource `onSubmittedWorkDone`." C9-01 measured **509 net
entries / 5.51 MiB with zero retirement** on the route. The imagery half was fixed by C9-12A
(byte-budgeted grace LRU in the realization table); the TERRAIN buffer half has no
production byte-budget/retirement owner.

### Architecture today (verified at 5b98ab9698) — with a NEW structural finding

- Tile GPU buffers: created per cache miss in `WebGPUGlobeSurfaceTileBuffers.ts`
  (`Terrain VB/IB ${tileKey}` at :248–273), stored in `_tileBufferCache`.
- **Retirement machinery EXISTS but is UNWIRED:** `evictStaleResources(host, activeTileKeys)`
  (`WebGPUGlobeSurfaceTileBuffers.ts:457`) destroys entries not in the active set and
  records `recordTileResourcesRetired` — but repo-wide grep finds **zero production
  callers**. The only call is the renderer's own destroy path
  (`WebGPUGlobeSurfaceRenderer.ts:2612`, with an EMPTY set, commented "Route final
  destruction through the same helper as production eviction"). The public method
  `evictStaleResources` (**:2537**) is never invoked by any Scene/quadtree code. **The
  "zero retirement measured" is therefore structural, not incidental** — this materially
  changes the item's shape: step 1 is wiring + policy, not inventing mechanism.
- Precedent to mirror: `WebGPUSharedImageryRealizations.ts` `BYTE_BUDGET` + zero-ref pool
  (:200–221) — the imagery half's shipped shape.
- Blocker per the register: FAR-200-S1 serial authority (retire only after last-use
  completion serial). Deferred-destroy interim exists for TEXTURES
  (`ctx.scheduleTextureDestroy` :2395) but there is **no buffer equivalent** — a
  `scheduleBufferDestroy` (or FAR-200-S1 serials) is needed before destroying buffers that
  the current frame's recorded-but-unsubmitted commands reference.

### Implementation walkthrough

0. Re-verify: confirm `evictStaleResources` still has no production caller; re-measure the
   byte slope at HEAD over 2–3 altitude loops (extend the item-2 probe pattern).
1. **Slice A (cheap, correctness-flavored):** wire an active-tile-keys collection (from the
   traversal's rendered-tile set) + once-per-frame post-traversal call — but ONLY with a
   safe destroy: entries evicted this frame may be referenced by commands already recorded
   this frame → route destruction through a deferred mechanism (frame-end batch like
   `scheduleTextureDestroy`, or hold N≥3 frames — the DW slab pattern uses ≥3).
2. **Slice B:** byte accounting (creation-time byteSize is already computable from
   `vbSize`/`ibAlignedSize`) + budget policy: pinned = active/leased (in the current
   traversal), grace-LRU for zero-lease, retire once/frame after traversal.
3. **Slice C (post-FAR-200-S1):** upgrade "hold N frames" to "destroy after last-use serial."
   Do NOT block slices A/B on FAR-200-S1 — the N-frame hold is the sanctioned interim
   (matches C9-12A's shipped deferred destroy); record the upgrade as the FAR-200-S3
   consumer.
4. Counters + `CesiumDebug` surface + DEBUGGING_GUIDE sync.

### Traps

- **Do not evict by entry count** — bytes only (the queue row's first sentence).
- Never per-resource `onSubmittedWorkDone` (explicit anti-pattern in the row; it's also the
  FAR-208 finding).
- The tile-buffer cache key feeds the shadow UB (`shadowCastUB` destroyed alongside) and the
  wireframe path (`WebGPUGlobeSurfaceWireframe.ts` references eviction in its docs) — evict
  through the helper ONLY, never inline destroys (Batch-686 F7 discipline).
- Item 4's S2 slab ties static-slot lifetime to `_tileBufferCache` entries — if both items
  are open, the eviction policy must free slab slots too; sequence C9-15 slices A/B BEFORE
  the slab lands, or coordinate the lifetime hook explicitly.
- The C9-12A imagery LRU is the shape to mirror, but imagery realizations are TEXTURES with
  a shared/owned split; terrain buffers are single-owner — do not import the refcount
  machinery wholesale.

### Verification recipe

- **Plateau oracle (the named acceptance):** repeated altitude loops (orbit→ground→orbit ×3)
  on the moving-altitude route: live bytes, high-water bytes, retired-count slopes must
  plateau by loop 2; PRE at HEAD shows monotone growth (re-confirm).
- New probe `probe-terrain-residency-budget.mjs`: drives the loop, reads the counters,
  asserts plateau + zero validation errors + pixel parity at each revisited waypoint
  (re-created buffers must render identically — the eviction must never evict a PINNED
  visible tile: assert no mid-view flicker via consecutive-frame diff at settled camera).
- Full re-run: 9-waypoint `probe-camera-track`, `capture-and-diff` globe scenes,
  water/exaggeration probes (tile rebuilds cross those paths), device-loss lane
  (destroy-path already routes through the helper — keep it green).
- On/off/restored: budget disabled (Infinity) = today's behavior byte-identical.

**Model tier:** opus-or-sol — the design is fully specified by the queue row + this
walkthrough; escalate to fable only if the plateau oracle misbehaves (hidden retainers).

---

## 6. C-R1-GLOBE-RENDERSTATE (P1-in-register · M · correctness)

### What + why

FEATURE_INVENTORY §C.1 (:777): "GlobeSurfaceRenderer builds variants from hardcoded state
instead of upstream `command.renderState`." Any upstream per-pass render-state change
(depth function tweak, blend change, cull toggle from `GlobeSurfaceTileProvider`) is
**silently ignored** on the fork's highest-traffic draw path. This is a WIP entry of
long standing — the risk is drift-on-upstream-merge, not a today-visible artifact.

### Architecture today (verified at 5b98ab9698)

- `WebGPUGlobeSurfaceRenderer.ts` contains **zero** references to `renderState` (grep = 0
  hits). Premise CONFIRMED.
- Pipeline state is derived internally in `WebGPUGlobeSurfacePipelines.ts`: `cullMode`
  computed at **:394** (from `disableCulling`-style inputs, ", noCull" label at :414),
  `depthWriteEnabled` at **:415**, with deliberate variant families documented at :140–142
  (blend FAR side, depthOnlyBackFace B177, translucentBackFace B182).
- Upstream's per-tile render states are built in `GlobeSurfaceTileProvider` and ride
  `command.renderState` on the WebGL lane.

### Implementation walkthrough

1. **Audit slice FIRST (fable):** enumerate every render-state field upstream actually
   varies on globe commands (blending, depthTest func, cull, depthMask, stencil for
   classification) vs what the WGPU pipeline variants hardcode; produce a divergence table.
   Many fields may be provably constant → document them as constants WITH the table as
   evidence; only genuinely-varying fields need plumbing.
2. **Plumb slice:** thread the varying fields from the tile provider's renderState into the
   pipeline-variant key + descriptor. **This grows the pipeline cache key** — do it through
   the named-axes mechanism and cross-fix awareness of BUG-GLOBE-PIPELINE-NAME-AXES
   (`standing-reds` cluster: the key ALREADY omits strideBytes/hasWebMercatorT/geodetic
   normals/LOG_DEPTH/`_sampleCount`). Landing new axes without folding the known-missing
   ones is acceptable (one concern per slice) but the worker must not COLLIDE with a
   standing-reds worker doing the same key surgery — orchestrator sequencing point.

### Traps

- The hardcoded variants encode REAL fork decisions (translucency two-pass, back-face
  ordering) — consuming upstream state must not flatten those; map upstream state INTO the
  variant selection, don't replace it.
- Byte-identical default expectation: at defaults the divergence table should predict ZERO
  visual change — if plumbing changes pixels at defaults, the audit missed a field that was
  masking an upstream behavior; STOP and reconcile.

### Verification recipe

Audit slice: doc artifact only (divergence table into the item's brief/DEFERRED_WORK).
Plumb slice: `capture-and-diff` all globe scenes byte-identical at defaults; globe
translucency probes (`probe-globe-translucency.mjs`), underground
(`probe-globe-underground.mjs`), classification probes (shared depth/stencil); a targeted
mutation test — change one upstream renderState field in a scratch build, assert the WebGPU
output now TRACKS it (that is the feature being bought).

**Model tier:** fable for the audit (ambiguity high, cheap); opus for the plumb under the
table. Effort M total.

---

## 7. S5-4 — Per-tile worker-computable scans (P2 · S · perf)

### What + why

PR §6 S5-4: every tile-buffer cache miss runs 2× O(indexCount) max-index scans + a possible
Uint8→Uint16 index up-conversion + (imagery side) a water-mask row-flip loop on the render
thread — work the terrain workers could ship as scalars. ~25–40 K indices standard;
dozens of tile builds/sec during descent — spikes on exactly the frames already paying
C9-11/C9-12 costs. WebGL consumes worker output without re-scanning.

### Architecture today (verified at 5b98ab9698 — register lines drifted)

- `WebGPUGlobeSurfaceTileBuffers.ts`: Uint8→Uint16 up-convert at **:193–197** (register said
  :185–187); stride-validation max-index scan #1 at **:213–217** (register :205–208); final
  safety-net max-index scan #2 at **:285–289** (register :277–280). Both scans + the
  documented fill-tile stride-correction rationale (:207–244) are live.
- Water-mask row flip: `WebGPUGlobeSurfaceTextures.ts` — bitmap path uses GPU `flipY: true`
  at **:624**; the CPU row-flip loop (`flipped = new Uint8Array(width*height)`) at **:649**
  runs for non-bitmap masks.

### Implementation walkthrough

1. Ship `maxIndex` (and where cheap, corrected stride) as scalars from the terrain worker
   mesh outputs / `TerrainFillMesh` build; up-convert Uint8 indices at `TerrainFillMesh`
   creation (`TerrainFillMesh.js:1236` is the documented Uint8 source).
2. Render-thread consumption: prefer the shipped scalar when present, **keep the scan as
   fallback** for meshes from paths that didn't ship it (third-party terrain providers,
   older cached meshes) — additive protocol, never a hard requirement.
3. Water-mask: fold the CPU flip into worker-side mask handling or convert the non-bitmap
   path to the GPU `flipY` upload where format permits.

### Traps

- Terrain workers are SHARED with WebGL — additions must be additive fields; WebGL output
  consumption byte-identical (never break WebGL).
- The stride-correction logic exists because fill-tile encodings LIE (inherited from parent)
  — a worker-shipped stride must be computed at fill-mesh build from the ACTUAL written
  layout, or you re-introduce the black-line/invisible-globe bug the comment documents
  (:187–192). Keep the safety-net scan #2 permanently (it is a permanent sentinel per the
  logging rules, cheap relative to correctness).
- Uint8 up-convert at TerrainFillMesh creation doubles that mesh's index memory for WebGL
  too (<256-vert fill tiles — tiny); if that offends, gate on a WebGPU-consumer flag
  (`requiresVertexTypedArrayRetention`-style capability getter precedent, GltfLoader:1417–1423).

### Verification recipe

Descent-heavy segment of the moving-altitude route: named-stage CPU (tile-build stage via
`CesiumDebug.cpuPassCost`) on/off/restored; `probe-camera-track` descent waypoints green;
`capture-and-diff` byte-identical; fill-tile coverage — a route crossing terrain-provider
seams (fill meshes) must render identically (the Sierra descent waypoint covers this).
Propose `probe-tile-build-scans.mjs` only if the existing route can't isolate the stage —
prefer instrumented counters on the existing route.

**Model tier:** opus-or-sol. Effort S. Natural rider AFTER item 3's PRE re-measure (same
frames, same counters).

---

## 8. S3-3 — GlobeTerrain debug-sentinel stripping (P2 · S–M · perf)

### What + why

PR §4 S3-3: ~20 runtime `tile.time`-gated debug-visualization blocks + 7 bypass predicates
+ ~17 extra MRT-writing return sites are compiled into the PRODUCTION globe fragment shader
(runtime-gated, not `//>>ifdef`-stripped). Uniform branches skip execution but not register
allocation: register pressure, ISA/icache footprint, and Tint→DXC compile time all rise for
EVERY globe pipeline variant. WebGL's equivalents are preprocessor-stripped.

### Architecture today (verified at 5b98ab9698)

- Predicates confirmed live in `GlobeTerrain.wgsl`: `tile.time ∈ [13.5e9, 15.5e9]` gate at
  **:1396** (`perVertexAtmoDebugActive`), `select(tile.time, 0.0, tile.time > 1.0e9)` at
  **:2320**, "Always taken in production (tile.time < 1e6)" at **:2439**, plus the :659/:1386
  commentary. The register's block ranges (:3164–3288 etc.) NOT individually recounted —
  worker re-counts at step 0 (the guide H1 discipline: recount, don't trust).
- Preprocessor + module cache infrastructure: `WebGPUShaderPreprocessor.ts` /
  `WebGPUShaderModuleCache.ts` per CLAUDE.md; `ShaderDefine` registry occupies bits 0–30 —
  **exactly one bit (31) is free in the current Uint32**; `GLOBE_DEBUG_SENTINELS` would
  consume it.

### Implementation walkthrough

0. Recount the sentinel blocks + bypass predicates at HEAD; produce the block inventory.
1. Add `GLOBE_DEBUG_SENTINELS` to `ShaderDefine` (add-only, document consumers) — **flag the
   last-bit consumption to the orchestrator** (the `build-boot` cluster owns define-width
   expansion; consuming bit 31 here forces that work for the NEXT define).
2. Wrap each sentinel block in `//>>ifdef GLOBE_DEBUG_SENTINELS` / `//>>else` / `//>>endif`
   such that **defines=0 emits byte-identical production WGSL** (the else-branch carries the
   production path). The `select(...)`-style mid-expression gates (:2320) need careful
   restructuring — the else branch must collapse to the plain production expression, not a
   `select` against a constant.
3. Flip the define in the globe pipeline cache ONLY when `CesiumDebug.globeFragmentDebug`
   engages; **the define must join the pipeline cache key** — this is the same key surgery
   family as BUG-GLOBE-PIPELINE-NAME-AXES (standing-reds): do not repeat the missing-axis
   mistake with the NEW axis, and coordinate if that item is concurrently open.
4. DEBUGGING_GUIDE sync (its own hard rule): every `globeFragmentDebug` mode must still
   engage — now via a define-flip recompile (first-use hitch is acceptable for a debug mode;
   note it in the guide).

### Traps

- ShaderDefine registry is ADD-ONLY, never reorder (CLAUDE.md hard rule).
- The preprocessed variant is a NEW module-cache entry — prewarm is NOT wanted here
  (debug-only variant; lazily compile on first debug engage).
- Verify the WGSL still compiles in BOTH define states for every globe variant
  (quantized/non-quantized × webmercT × material × logdepth …) — the ifdef blocks sit
  inside variant-conditional code.
- This changes ZERO behavior at defaults by construction — any capture delta = a wrapping
  mistake.

### Verification recipe

`capture-and-diff` all scenes byte-identical (defines=0 path); each
`CesiumDebug.globeFragmentDebug(name)` mode from the DEBUGGING_GUIDE table visually engages
(scripted probe: cycle modes, assert non-trivial pixel delta per mode, then restore →
byte-identical again — on/off/restored); `CesiumDebug.pipelineStatus()` healthy; compile-time
delta (Tint/DXC) is nice-to-have evidence via pipeline-creation timing counters, not a gate.
Propose `probe-globe-fragment-debug-modes.mjs` if no existing probe cycles the modes
(inventory check at execution time; `diag-globe-belowsurface-decomp.mjs` is adjacent).

**Model tier:** opus — mechanical but detail-dense WGSL surgery with a crisp oracle.

---

## 9. S1-1 — WebGL-lane globe derived-command regen (P2 · M · perf) — **PREMISE-PARTIAL**

### What + why

PR §2 S1-1: the WebGL globe recycles DrawCommand objects across tiles
(free-list, `GlobeSurfaceTileProviderRendering.js:1459–1477` per register), so it sets
`command.dirty = true` unconditionally every frame → `insertIntoBin` runs full
derived-command regeneration for EVERY globe command EVERY frame (~4 shallowClones × ~30
field writes + shader-cache lookups per command; ~1,800 shallowClones/frame at 150 tiles ×
3 layers), re-paid by pick mini-frames. Register status: DEEPER-ON-KNOWN, C9-11/FAR-309
scope-extension rider to the WebGL lane.

### Architecture today (verified at 5b98ab9698 — one sub-claim stale)

- `command.dirty = true` confirmed at `GlobeSurfaceTileProviderRendering.js:1931` (register
  said :1929 — 2-line drift).
- Free-list recycling site NOT re-verified line-precisely (worker step 0: confirm the
  recycling rationale at ~:1459–1477 and that per-tile identity is genuinely absent).
- **STALE SUB-CLAIM:** "shadows add `createCastDerivedCommand` per command per frame" was
  written pre-B695. Batch 695 (C10-10) folded cast-candidate collection into the single PVS
  walk and dropped the duplicate `updateDerivedCommands`. The dirty-driven regen itself is
  untouched (different mechanism), but the shadow-side magnitude changed — **PREMISE-PARTIAL:
  the worker must re-derive the shadow interaction post-B695 before quoting it.**

### Implementation walkthrough

0. Premise re-verify BOTH sub-claims + re-measure PRE shallowClone counts at HEAD on the
   WebGL lane (instrument `DerivedCommand` clone paths, debug-pragma'd).
1. Preferred fix (register): extend retained per-tile command identity to the WebGL lane so
   `dirty` keys off tile/imagery/shader revision — i.e., stop recycling command objects
   across DIFFERENT tiles, or carry a revision stamp that survives recycling.
2. Alternative (smaller): scope regeneration — BV/uniform-value updates don't re-clone
   derived commands; only shader/renderState/pass changes do.

### Traps

- **This is the WebGL lane** — the fork's never-break-WebGL rule applies at full strength:
  byte-identical WebGL captures are the gate, and upstream Specs
  (`MultifrustumSpec.js`, derived-command specs) must pass unmodified.
- The C10-10 follow-up (frame-delta cluster: revision-MAINTAINED caster sublist) is blocked
  on the retained-commandList tier — S1-1's revision stamp is a STEP toward that tier;
  coordinate so the two don't invent incompatible revision schemes (orchestrator note).
- Pick mini-frames re-run regen — the fix must cover the pick lane's dirty handling too or
  the claim halves.
- Perf evidence: WebGL-lane moving-altitude run (the campaign runs both backends); the
  C10-30 noise-budget seed (WebGL seg5 p99 GC-tail, frame-delta cluster P3) suspects
  allocation pressure in this exact territory — a win here may also shrink that noise;
  measure seg5 p99 before/after and report it either way.

### Verification recipe

WebGL `capture-and-diff` all scenes byte-identical; Jasmine derived-command/multifrustum
specs unmodified-green; instrumented shallowClone counter on/off/restored (expect ~1,800/frame
→ near-0 settled, spikes on real change); WebGL-lane moving-altitude CPU-p95 named-stage;
pick probes (pick regen shares the path). Propose `probe-webgl-derived-regen.mjs`
(API-instrumented counter probe, WebGL lane).

**Model tier:** fable — shared-lane surgery with a stale sub-claim and a cross-cluster
revision-scheme dependency; the diagnosis/scoping IS the work.

---

## 10. S6-3 — Uniform-ring fan-out beyond terrain (P2 · M · perf)

### What + why

PR §7 S6-3: the FAR-303 staged ring has EXACTLY ONE consumer (globe camera UB) while the
rest of the frame fans out 100–500+ individual per-object `writeBuffer` calls (~1–3 µs Dawn
validation + staging copy + fence tracking each; 200 geometry primitives ≈ 0.4–1 ms
CPU/frame; busy scenes ~1–2 ms). The proven "87% fewer writes" ring win stopped at terrain.
Register blocker: coordinate with the blocked C9-12 remainder (same WGSL+packer+BG-cache
family).

### Architecture today (verified at 5b98ab9698)

- Sole consumer confirmed: repo-grep for `allocateAndWrite` outside the allocator finds only
  `WebGPUGlobeSurfaceCameraUB.ts` (**:1054–1055**).
- Fan-out writers confirmed by symbol in `WebGPUPrimitiveCommands.ts`:
  `updateWebGPUCommandUniforms` (file-header :8 "per-frame camera matrix updates"),
  `writeRTEUniformsFlat` (**:1081**), `writeRTEUniformsLit` (**:1150**),
  `writeRTEUniformsPolyline` (**:1271**). (Register's :1563–1660 write-site lines not
  re-pinned — symbols are the anchor.)
- Ring lifecycle: `WebGPUContext._uniformAllocator` beginFrame :1895/:1998, flush
  :2556/:3350, endFrame :2608.

### Implementation walkthrough

1. Scope slice (fable): pick ONE consumer family (Primitive camera UBs is the register's
   first) and enumerate its BGL/bind-group identity implications — converting a per-command
   UBO to (ring page + dynamic offset) changes the BGL (dynamic:true) and the bind-group key
   (page identity instead of per-command buffer identity) — this is EXACTLY the B292 globe
   conversion, which is the precedent to copy (including its cache-key consequences).
2. Convert family-by-family (Primitive → Polyline → collection/effect uniforms), each its
   own slice with its own probes; fold the splat renderer's 5-offset-writes-to-one-UBO into
   a single ranged write as the cheap opener.
3. Counters: per-family writeBuffer counts (API-instrumented probes exist as precedent —
   `probe-c10-09-prev-buffer-upload.mjs` pattern).

### Traps

- **Same family as item 4:** if the C9-12 arc is open, this item WAITS (the ring/packer
  layer is single-owner). If C9-12 stays seeded, this can proceed independently — it touches
  primitive files, not the globe spine. State which regime applies at brief time.
- Pick mini-frames + the ring: same dead-offset rule as items 3/4.
- Dynamic-offset alignment (256 B) inflates small UBOs — the win is fewer CALLS, not fewer
  bytes; don't claim bytes.
- C9-27 view-ring (rte-taa/entity clusters) eventually DELETES per-collection repack
  mechanisms — the register's S2-1 row warns interim fixes must not conflict; check whether
  the collection-uniform sub-slice overlaps C9-27's plan before opening it.

### Verification recipe

Per-family: API-instrumented writeBuffer count/frame on/off/restored (expect N per-object
writes → ~1 ring write + N dynamic-offset binds); `capture-and-diff` primitive/polyline
scenes byte-identical; `probe-all-materials.mjs`, polyline probes, RTE precision probes
(`probe-buffer-logdepth-zfight.mjs`, far-camera waypoints — RTE packing must be
bit-preserved); moving-altitude named-stage CPU-p95. Propose
`probe-uniform-ring-fanout.mjs` for the counters.

**Model tier:** fable for the scoping slice (BGL identity blast radius); opus-or-sol per
conversion family after.

---

## 11. DP-H19-SHADER-DECODE-RUNTIME (P2 · M · perf)

### What + why

FEATURE_INVENTORY §C.1 (:783): GPU compressed-vertex decode scaffold landed (Batch 27); the
runtime flip + per-shader expansion remain — quantized `compressedAttributes` are still
decoded on the **CPU**, re-expanding `normal`/`st`/`tangent` to full Float32Arrays and
forfeiting the VRAM/bandwidth win compression exists for (upload bandwidth + memory on
primitive hot paths).

### Architecture today (verified at 5b98ab9698)

- Define exists: `ShaderDefine.COMPRESSED_VERTICES = 1 << 3`
  (`WebGPUShaderDefines.ts:100`).
- WGSL ifdef blocks exist in `PrimitivePhongColor.wgsl` (**:17, :190, :222** area) — and, per
  grep, ONLY there among WGSL shaders (the per-shader expansion is real remaining work).
- **The bit is NEVER flipped:** `WebGPUPrimitiveCommands.ts:2888` —
  `const shaderDefines = logDepthActive ? ShaderDefine.LOG_DEPTH : 0;` — COMPRESSED_VERTICES
  is never OR'd in. The adjacent comment (:2875–2882) states the design: "The compressed
  opt-in flips the bit in a follow-up wire-up step that also swaps the vertex buffer packer
  to emit `compressedAttributes` directly." Premise CONFIRMED.
- CPU decode lives at `WebGPUPrimitiveCommands.ts:486–524` (DP-H19 block; consults
  `geometry._compressedAttributesMeta`, falls back to inference + one-time warning).

### Implementation walkthrough

1. Slice A (the flip, PhongColor-only): when the geometry arrives compressed AND the shader
   is the PhongColor family, skip CPU decode, emit the `compressedAttributes` vertex buffer
   directly, OR `ShaderDefine.COMPRESSED_VERTICES` into `shaderDefines`, and extend the
   pipeline-cache identity accordingly (the module cache keys on defines already; the
   PIPELINE cache entry must too — same key-axes discipline as items 6/8).
2. Slice B+ (per-shader expansion): add ifdef blocks to the next shader family
   (textured/lit/material variants) one at a time; the `_compressedAttributesMeta` layout
   doc at :508–515 is the packing contract for the WGSL decode.
3. Keep the CPU decode as the permanent fallback for meta-less geometry (the :517–522
   fallback path) — never a hard cutover.

### Traps

- Vertex-layout change = bind-group/pipeline identity change per variant — the shader
  variant explosion the original comment feared is bounded by the module cache, but the
  worker must verify pick + material + logDepth cross-products all compile in both define
  states.
- `defines=0` must remain byte-identical (the else-branches ARE the current path — the
  preprocessor contract guarantees it; don't restructure else-branch code while adding
  blocks).
- Normal/tangent oct-decode precision: GPU decode must match the CPU decode bit-behavior
  closely enough that lighting is visually identical — capture-diff catches it; the
  perturbNormal NaN memory (tangentless models) says guard the tangent path defensively.

### Verification recipe

`probe-all-materials.mjs` + primitive scenes in `capture-and-diff` (compressed is the
DEFAULT for Primitive — coverage is automatic) in a ≤0.1%-class band vs PRE;
`probe-buffer-logdepth-zfight.mjs` + far-camera RTE waypoints (vertex path changed);
upload-bytes counter on/off (the claimed win: no expanded Float32Array upload); VRAM census
by buffer label. Propose `probe-compressed-vertex-decode.mjs` asserting define engaged +
pixel parity + upload-bytes drop on a compressVertices-heavy scene.

**Model tier:** opus for Slice A (well-specified, in-file precedent); fable if Slice B
uncovers meta/layout mismatches across the material matrix.

---

# PART 2 — `submit-residency`

## 12. FAR-200-S1-PHYSICAL-QUEUE-TIMELINE (P1 · M · infra)

### What + why

C9Q §5 row 12A (R4/shadow): "Establish and test ONE monotonic serial authority per physical
queue/device generation, including submit, abandon, pool, failure, loss, and completion, but
migrate no production caller. This explicit shadow prerequisite does not cross production
submission authority." It is the sanctioned pre-Gate-B exception and the gateway to the
whole residency/retirement family (FAR-200 S2 row 45 / S3 row 46, C9-15 slice C,
FAR-209/210) and to packed-depth pick (pick cluster). Nothing depends on it being big;
everything depends on it being EXACT.

### Architecture today (verified at 5b98ab9698)

- **No timeline/serial service exists:** grep for
  `completionSerial|submissionSerial|queueSerial` = 0 production hits.
- Completion signaling today: `WebGPUSync.ts` wraps `queue.onSubmittedWorkDone` (:49);
  `WebGPUContext.endFrame` uses one per-frame `onSubmittedWorkDone` (:2589) to free the
  deferred-destroy batch (`scheduleTextureDestroy` :2395, `noteInlineTextureDestroy` :2443).
- Submit census (S6-7, re-verified): ~60 sites; per-frame private submitters = exactly three
  feature-gated ones (item 13); the rest init/rare/on-demand.
- **No numeric device generation exists:** device loss/recovery swaps the device object
  (`WebGPUContext.ts` ~:6020–6036 prose) — the timeline must MINT its own generation counter
  keyed on recovery events.

### Implementation walkthrough

1. New `WebGPURenderer/WebGPUQueueTimeline.ts` (name per FAR convention): per
   (physical device object, minted generation) — monotonic `nextSerial`; API:
   `recordSubmit(owner, source) → serial`, `recordAbandon/Failure`, `currentGeneration`,
   `completedThrough` (advanced by BATCHED `onSubmittedWorkDone` — one in-flight completion
   probe at a time, never per-resource, per the C9-15 row's anti-pattern), and
   `onGenerationInvalidated` for loss.
2. Shadow wiring: the frame's main submit + endFrame path REPORT into the timeline (a
   record call is not a behavior change); private submitters may report too — but **migrate
   no caller's submission authority** (S2's job, row 45's static allowlist).
3. Spec-first: this is headless-testable — a Jasmine spec
   (`Specs/Renderer/WebGPUQueueTimelineSpec.js`-style) driving mock submit/complete/loss
   sequences is the primary oracle (spec strategy is REQUIRED here; probes are secondary).
4. Multi-context: one timeline per physical device; `ContextRegistry` lists contexts —
   contexts sharing a device share a timeline (design note; today contexts own devices 1:1,
   keep the map keyed on device identity so the invariant is structural).

### Traps

- Do not wrap or reorder actual `queue.submit` calls — recording is observational. Any
  behavior delta = wrong task.
- Serial monotonicity must survive generation bumps (either serials restart per generation
  with (gen, serial) tuple ordering, or run global-monotonic with a generation stamp —
  pick ONE, document it, the retirement family consumes it verbatim).
- `onSubmittedWorkDone` resolves in submission order per spec, but batches must tolerate
  rejection on device loss (the :2600 precedent handles this — copy it).
- Charter: R4/shadow means byte-identical rendering by construction — run one
  `capture-and-diff` anyway (cheap proof the shadow is a shadow).

### Verification recipe

Jasmine spec matrix: submit→complete ordering, interleaved abandons, failure paths,
loss/regeneration (serials from gen N never satisfy waits from gen N+1), pool reuse
sequencing. Runtime: `capture-and-diff globe-default` byte-identical; zero new
console/validation errors on the 9-waypoint route; counters visible via a
`CesiumDebug` accessor (+ DEBUGGING_GUIDE sync). No perf claim (infra item — promotion
stance: mechanics-green lands it).

**Model tier:** opus-or-sol — a well-specified contract with a spec-first oracle. Effort M.

---

## 13. FAR-200 private-submit-timeline consolidation — S6-7 + S6-5 (P1 · M–L · infra/perf, 3 independent sub-slices)

### What + why

C10Q §6 seed (both C10-09 and C10-05 explicitly left it as "the separate concern"); PR §7
S6-7 (submit-site classification) + S6-5 (cluster-dispatch hygiene). Only THREE per-frame
mid-frame private submitters remain, all feature-gated: **Ocean FFT** (~35 compute passes),
**Weather** (3 compute passes), **EntityCluster dispatcher** (grid compute + readback).
Register sequencing rule: **land these moves BEFORE FAR-200's submit-timeline authority**
(fewer submission sources for S1/S2 to cover). Plus cluster hygiene: CPU-zeroed uploads
instead of `clearBuffer`, and a redundant double-copy readback decode.

### Architecture today (verified at 5b98ab9698)

- Ocean: `WebGPUOceanRenderer.ts:848` — `device.queue.submit([enc.finish()])` closing a
  private encoder that records the spectrum/ifft ladder (4 × LOG2N ifft loops + merge; read
  :820–848). Feature = the opt-in C6 FFT ocean (B654).
- Weather: `WebGPUWeatherRenderer.ts:396` — private `"Weather compute"` encoder, 3 passes
  (reset/update/emit, :373–396). Opt-in weather particles.
- EntityCluster: `WebGPUEntityClusterDispatcher.ts:343` submit; CPU-zero-fill clears via
  `writeBuffer` of `_clearCounts`/`_clearRep` arrays (**:279–299**); triple `mapAsync` +
  double-copy decode (`new Uint32Array(new Uint32Array(getMappedRange(...)))`) at
  **:351–366**; cadence driven by `EntityCluster.js` (register: :699–709).
- The fixed main-encoder precedent patterns to copy: `WebGPUVolumetricFogRenderer.ts`
  (~:1282–1290) and `WebGPUProceduralCloudRenderer.ts` (~:2578–2580) (S6-7's own contrast
  list; re-pin at execution).
- Frame-owned enqueue precedent for work that must survive "no frame encoder open":
  `WebGPUContext.enqueueImageryMipGeneration` (:2421) + the `"ImageryMipPreparation"`
  endFrame encoder (C9-12A).

### Implementation walkthrough (three sub-slices, each independently revertable)

- **Slice O (Ocean):** record the FFT ladder into the main frame encoder at the fog/clouds
  hook point, BEFORE the scene passes that sample the ocean displacement outputs.
  **Ordering invariant:** today the private submit executes before the scene submit → the
  displacement texture is same-frame-fresh; recording into the main encoder ahead of scene
  passes preserves that exactly. Verify the globe material samples the SAME texture views
  (no ping-pong index skew across the move).
- **Slice W (Weather):** identical shape, 3 passes, same hook.
- **Slice C (Cluster):** (a) replace CPU-zero `writeBuffer` clears with
  `encoder.clearBuffer()` (buffers need no extra usage for clearBuffer; sizes already ×4);
  (b) single-copy decode — `new Uint32Array(getMappedRange).slice()` or copy once into a
  pooled array (the current double-construction copies twice); (c) the dispatch runs on an
  ASYNC cadence (awaited readback) possibly outside a frame — either enqueue the compute
  into the next frame-owned encoder (mip-prep precedent) with the mapAsync chained after
  that frame's submit, or — if the latency contract can't tolerate next-frame — keep the
  private submit for the off-frame case as an honest documented fallback and route the
  in-frame case through the main encoder. Do NOT silently change clustering latency by a
  frame without flagging it (feature behavior).

### Traps

- All three are FEATURE-GATED → **no default-path perf claim is possible**; the promotion
  stance is submit-count reduction (named-stage) + mechanics-green (the B694 "truthful miss
  + green mechanics = VALID COMPLETE" precedent).
- Ocean cache ping-pong: `cache.frameNumber++` after submit (:849) — moving the record point
  must keep the increment aligned with actual execution order.
- Cluster readback: `mapAsync` on buffers whose copies were recorded into the MAIN encoder
  can only resolve after the main submit — the await point moves; ensure the consumer
  (`EntityCluster.js`) tolerates resolution later in the same frame or next tick (it already
  awaits — verify no re-entrancy guard assumes same-tick resolution;
  `_readbackInFlight` :349 suggests it's guarded — keep it).
- Do not fold FAR-200-S1 recording INTO these slices (sequencing: moves first, timeline
  after — but each slice can leave a `// FAR-200-S2 adoption point` comment).
- EntityCluster behavior is LOCKED by the B679 cert (register: clustered zero-light row) —
  the dispatcher's output must be byte-stable across the move (readback values identical).

### Verification recipe

- Per-slice submit-count oracle: instrumented `queue.submit` count/frame with the feature ON
  — PRE = main+1 (per feature), POST = main only; off/on/restored.
- Ocean: `probe-fft-ocean.mjs` green + wave-phase animation oracle (two captures differ);
  pixel parity vs PRE build.
- Weather: weather-inspector Sandcastle route; propose `probe-weather-particles.mjs` if the
  inventory has none at execution time (check first — Principle 8 requires the repro probe
  regardless).
- Cluster: `probe-clustered-dispatcher.mjs` + `probe-clustered-per-frame.mjs` (both exist)
  — cluster assignments byte-identical PRE/POST (readback decode equality is the oracle for
  hygiene sub-slice (b)); zero validation errors.
- All: `capture-and-diff globe-default` untouched (features off at defaults — byte-identical
  by construction; run it anyway).

**Model tier:** opus-or-sol; three separate briefs (one concern per slice). Effort M–L
total, S–M each.

---

## 14. Geometry-residency dedupe — S11-3 / FAR-204 / item-89 extension (P1 · L · memory+load)

### What + why

PR §12 S11-3 (HIGH) + C10Q §6 seed + C9Q §11 row 89 (the PNTS retention ledger half). ALL
model/tile geometry is resident **3×** and crosses the bus **2×**: (1) during tile
PROCESSING the loader uploads every vertex/index buffer into a **stub-backed real
GPUBuffer** the model FR never binds; (2) the CPU typedArray is **force-retained** for all
attributes on WebGPU; (3) at first visible frame the FR creates and uploads a **second**
GPUBuffer set from those typedArrays **inside the render loop with no budget** (popping
hitch + TTFF contributor; WebGL finishes GPU resources during PROCESSING). ~500 MB resident
tile geometry ⇒ ~1 GB GPU (half never bound) + ~500 MB JS heap. The ledger records only the
CPU-retention leg; the orphaned stub GPU copy + double upload + unbudgeted first-frame build
are the effectively-NEW scope.

### Architecture today (verified at 5b98ab9698)

- Forced retention: `GltfLoader.js` — `loadTypedArrayForWebGPU =
  frameState.context.requiresVertexTypedArrayRetention === true` (**:1441–1442**), OR'd into
  `outputTypedArray` (**:1448–1454**); `loadBuffer` still true on the non-post-processing
  path (**:1462**). The 2026-04-30 rationale block (:1425–1440) documents WHY (no
  `getBufferData` on WebGPU; `extractPrimitiveGeometry` needs arrays). Documented
  typed-array READERS enumerated in the surrounding block: 2D projection, picking,
  classification, BENTLEY edge-visibility (:1400–1423).
- Stub leg: `Stubs/WebGLStubBuffer.ts` — `createBuffer` stubs allocate REAL GPUBuffers
  (:63) and `writeBuffer` real bytes (:266/:283/:340/:355).
- FR second build: `WebGPUModelRenderer.ts` — `cache.primitives[primKey]` guard at
  **:2531–2532**, then per-attribute `createVertexBuffer` builds (position :2580, normal
  :2588, tangent :2597, uv :2606, uv1 :2620, color :2652, joints :2667, weights :2677,
  featureId :2692 …) — in the render loop. (S11-3's :2471/:2707 line hints drifted after
  B698/B699 landed in this file — symbols above re-pinned at 5b98ab9698.)
- item-89: PNTS typedArray sites live in `Scene/Model/PntsLoader.js` (:217–:332 attribute
  records; register's ":441" is stale — file moved/drifted; symbol = the `typedArray:`
  attribute constructions).

### Implementation walkthrough

0. **Decision slice (fable) — adoption vs suppression:**
   (A) FR adopts the stub GPUBuffers (usage already VERTEX|INDEX|COPY_DST) — zero new
   upload, but the FR must accept loader-owned buffer lifetime + the stub registry's
   ownership semantics; or (B) WebGPU suppresses the `loadBuffer` leg (typedArray-only load)
   and the FR build moves into **budgeted content processing** (out of the render loop),
   releasing typedArrays after build EXCEPT documented readers. The decision needs the
   Principle-7 audit: `WebGLStubBuffer` is load-bearing stub architecture — check
   `WEBGPU_COMPAT_EXEMPTIONS` + `WebGLStubPipelineExtractor` consumers before suppressing
   anything.
1. Execute the chosen leg for ONE content type first (b3dm/glTF tiles), behind a flag,
   with the release-policy table (which attributes stay retained for which reader) written
   INTO the code comment block that already documents the readers.
2. Budgeted build: move first-frame buffer creation into the content-PROCESSING phase (align
   with WebGL's lifecycle) or a per-frame byte-budgeted queue (C9-15-shaped) — either kills
   the popping-hitch leg.
3. Extend to PNTS (item-89 fold) + instanced content after the tile vertical proves out.

### Traps

- **typedArray release policy must preserve documented readers** (register verbatim): edge
  visibility, 2D, picking, classification — the flags at GltfLoader:1448–1453 are the
  authoritative list; releasing arrays those flags requested is a correctness break, not a
  perf win.
- **B688 revision tokens (C9-17 Slice B):** loader-owned geometry revision tokens now drive
  O(1) validation (240/240 settled fast-path) — the dedupe must keep the token SOURCE
  identity stable across the residency change or the fast path degrades to re-validation
  (probe `probe-model-instance-bg-cache.mjs` guards this — run it).
- **B687 group-1 caching + B698 mip-chain + B699 twin-gate** all landed in
  `WebGPUModelRenderer.ts` — heavy drift zone; re-grep every symbol; coordinate with any
  open C10/C11 model-frontend worker (this file is the shared spine of two clusters).
- Subsystem-distinct from C9-15 (terrain buffers) — do not merge briefs; but the byte-census
  tooling can be shared.
- Model destroy path: `destroyPickIds`/cache teardown (:6901 area) must handle whichever
  buffer-ownership regime wins without double-destroy.

### Verification recipe

- Byte census oracle: instrumented `createBuffer` totals by label class (loader-stub vs FR
  primCache) on a city-tileset route — PRE shows ~2× GPU + retained JS heap; POST shows
  single GPU copy + released arrays (heap delta via `performance.memory` trend, honest
  noise bands).
- TTFF/hitch: first-visible-frame time distribution on tile load (named-stage; the
  moving-altitude route's descent/city segments).
- Correctness matrix: `probe-b3dm-render-edge.mjs` (edge-visibility reader),
  `probe-c-r9-webgl-vs-webgpu.mjs` + model pick probes (picking reader), 2D/CV probes
  (`probe-2d-cv-modes.mjs`) (2D reader), classification probes, `capture-and-diff` model
  scenes byte-identical, `probe-model-instance-bg-cache.mjs` (revision-token fast path),
  device-loss lane.
- Promotion: memory/TTFF claims are named-stage; route CPU-p95 only if the census route
  clears the bar.

**Model tier:** fable for the decision slice (architecture judgment + Principle-7 audit);
opus for the executed vertical. Effort L, multi-slice.

---

## 15. NEW-PICK-ID-OWNERSHIP-MODEL (P2 · M · perf) — **PREMISE-PARTIAL**

### What + why

C9Q §8 row 50 (R2/R4): "Consolidate model/model-instance/feature IDs without eager no-pick
WebGPU IDs/textures. Preserve Entity, 3D Tiles, node/primitive, instance, feature, mutation,
eviction, destruction, and loss results." Register adds: fold-target for the PNTS
typedArray retention record (item 89); prerequisite for contiguous pick-ID ranges (C9Q row
56 / FAR-205). The claim: never-picked frames currently pay pick-ID allocation.

### Architecture today (verified at 5b98ab9698 — eagerness NOT fully confirmed)

- Pick-ID allocation is delegated: `ensurePickId` imported at `WebGPUModelRenderer.ts:122–123`,
  called in the command-build path at **:5311** (model-level, comment at :5301 "primitive
  pick ID allocation delegated to ensurePickId"), pickColor consumed at :5332;
  `ensurePerFeaturePickIds` referenced at **:5403**; `destroyPickIds` on teardown at
  **:6901**.
- **PREMISE-UNVERIFIED PART:** whether `ensurePickId` runs unconditionally on never-picked
  frames (vs gated on `allowPicking`/pick pass). It sits in command build (suggesting eager),
  but the worker's step 0 MUST read `ensurePickId`'s implementation + call conditions and
  instrument a no-pick route (pick-ID create count on a scene where `pick` is never called
  and `allowPicking` defaults) before ANY design work. If allocation is already lazy, the
  remaining scope is consolidation-only (smaller) — report honestly.
- Related-but-separate: `WebGPUModelFeatureId` batch-texture force-create is the
  `model-frontend` cluster's S11-1 remainder — DO NOT absorb it here (explicit "separate
  slice" carve-out in the register).

### Implementation walkthrough

0. Premise instrumentation (above). 1. Define the ownership model: one owner module for
model/instance/feature ID lifetime (today model-level + per-feature are separate paths);
IDs/textures allocated on FIRST pick demand (generation-tagged so the async-pick readiness
contract — pick cluster — can await them); eviction/destruction/loss parity preserved.
2. Fold the PNTS retention record's pick-leg into the same owner (item-89 instruction).
3. Leave contiguous-ranges (row 56) OUT — this item is its prerequisite, not its delivery.

### Traps

- Cross-cluster: the pick fleet (FAR-107 contract, packed-depth) is `pick`-cluster-owned —
  this item must not change pick RESULTS or timing semantics; lazy allocation must be
  invisible through the readiness contract (a first-pick `undefined` regression here would
  collide with NEW-WEBGPU-ASYNC-PICK-PIPELINE-READINESS-CONTRACT; coordinate).
- "No eager IDs" must not break `pickAsync` cold-start correctness — allocation-on-demand
  inside the pick mini-frame must complete same-frame or defer through the readiness
  contract, never return a false miss.
- Device-loss: lazy resources need the same C-R12 invalidation coverage the eager ones get
  (standing-reds C-R12 row notes model `_webgpuCache` is ALREADY missed by the loss walk —
  don't add a second miss).

### Verification recipe

No-pick route: pick-ID/texture create count == 0 (the item's headline oracle, on/off).
Pick correctness matrix: model/instance/feature pick probes
(`probe-pickposition-model-webgpu.mjs`, `probe-c-r9-*`, feature-pick probes), mutation +
eviction + destroy + loss lanes, `pickAsync` cold-start (first public call returns the
right object). Propose `probe-model-pickid-lazy.mjs` combining the no-pick census with a
then-pick-succeeds assertion.

**Model tier:** fable — the eagerness premise is unconfirmed and the ownership-model design
interacts with the pick cluster's contract work. Effort M.

---

# OPEN QUESTIONS for the orchestrator

1. **Does C11 OPEN the C9-11→C9-12 family or keep it seeded?** Both C10 dispositions say
   "dedicated multi-batch family; do not open inside a wave." Opening it consumes a fable
   lane for multiple sessions (items 3→4 are strictly sequential). If C10-30's attribution
   names the terrain upload path, priority rises; if it names model-frontend (C9-17 Slice D
   STOP-gate), the S9/S6-3 family competes for the same effort. **Decision needed before
   wave assembly.**
2. **C10-30 outcome dependency:** items 3/4/10 PRE baselines and the promotion bars assume
   the post-C10 checkpoint numbers. If C10-30 has not closed when G2 items launch, workers
   must self-baseline at their HEAD — confirm that is acceptable evidence for the ledger.
3. **FAR-200 ordering:** the register says land item-13 submitter moves BEFORE item-12's
   timeline authority; the C9 queue sanctions S1 as a shadow anytime. Both are defensible —
   pick one ordering for the queue (recommendation: item 13 slices O/W/C first, S1
   immediately after; S1's census then has exactly ONE per-frame submitter class to model).
4. **C9-15 interim wiring (new finding):** `evictStaleResources` is UNWIRED in production —
   does the maintainer want the cheap Slice-A wiring (bounded-lifetime correctness) landed
   ahead of the full byte-budget epic, or held so the epic lands as one coherent policy?
   Slice A alone changes eviction behavior (destroys leave-view tiles) — a
   visible-on-revisit re-upload cost appears where today VRAM just grows; that is a
   behavior trade the maintainer should bless (charter: containment vs feature-degradation
   judgment call).
5. **ShaderDefine bit 31 (item 8):** consuming the LAST free define bit forces the
   define-width expansion (`build-boot` cluster, C10-08b family) for the next define after
   it. Confirm the spend, or sequence define-width first.
6. **S1-1 WebGL-lane appetite:** touching the shared/WebGL derived-command lane is
   higher-blast-radius than anything else in this cluster; confirm the maintainer wants
   WebGL-lane perf surgery in C11 at all (it also shrinks the C10-30 WebGL seg5 p99 noise
   seed — an argument FOR).
7. **Sequencing inside terrain-imagery:** recommended order = 1 (oceanNormal) → 2 (F2a
   lane) → 5 (C9-15 A/B) → 3 → 4, with 7/8/11 as independent riders and 6/9/10 as
   fable-scoped openers that can run any time. Items 3/4/5 all touch
   `WebGPUGlobeSurfaceRenderer.ts`/tile-buffer lifetime — never two of them concurrently.
8. **Weather probe gap:** if no `probe-weather-*` exists at execution time (none found in
   the inventory grep), item 13 Slice W needs its repro probe built first — small scope
   add, flagging so it lands in the brief.
9. **Item 15 scope fork:** if step-0 instrumentation shows pick-ID allocation is already
   demand-gated, the item collapses to consolidation-only — pre-authorize the smaller scope
   so the worker doesn't stall on a premise pivot.
