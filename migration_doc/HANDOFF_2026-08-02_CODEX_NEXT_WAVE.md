# Codex next-wave handoff — campaign remainders + one open investigation

**Date:** 2026-08-02
**Repository state at the 2026-08-02 Codex audit:** the worktree was CLEAN and
`main == origin/main == 2805e7d36e` (Batch 818); branch/worktree inventory was
`main` only. **Correction:** two older safety stashes exist
(`codex-safety-s5-v8-main-2026-07-28T1142` and
`codex-safety-s5-v7-main-2026-07-26T1048`). Preserve them unless the maintainer
explicitly authorizes disposal. Everything described as landed below is in
main; see [`CODEX_PROGRESS_AUDIT_2026-08-02.md`](CODEX_PROGRESS_AUDIT_2026-08-02.md)
for the post-handoff code review and status corrections.
**Execution authority:** the three live campaign queues
([C11](QUEUE_2026-07-18_CAMPAIGN11.md), [C12](QUEUE_2026-07-19_CAMPAIGN12.md),
[C13](QUEUE_2026-07-23_CAMPAIGN13.md)) + [DEFERRED_WORK.md](DEFERRED_WORK.md).
**Campaign-number correction (2026-08-02): Dynamic Ocean & Wind already owns
the ratified Campaign 14 identity and remains blocked by O5 until Campaigns 11,
12, and 13 complete. Aurora + Space Weather is Campaign 15.** Its
[queue](QUEUE_2026-08-02_CAMPAIGN15.md) is research-verified with `C15-00`
complete, but runtime implementation is not launched. This document is the
entry map, not the ledger — update the queue rows as you work, not just this
file.

---

## 1. Where the fork is (progress through Batch 818)

Your previous pass (the 2026-07-31 stopping point) landed as **Batches 772-781**
after orchestrator review. Since then the orchestrator ran Batches 782-818:

- **v1.144 upstream merge** (`65a194d24e`) — 0 behind upstream.
- **All seven parked worktree branches audited, value-extracted, deleted**
  (Batch 803 extractions; branch inventory has been `main`-only since).
- **Pipeline-key aliasing closed end-to-end**: name-markers at 8 sites (803),
  `wrongModuleHits` counter (795), single key home (788), runtime probe PASS.
- **`NEW-WEBGPU-GLOBE-USE-LOG-DEPTH` fixed + pixel-proven** (807/809): the
  globe was the only depth producer ignoring `frameState.useLogDepth`; in
  2D/Columbus View it wrote log depth into hyperbolic buffers on both the
  color and pick axes. Fail-before/pass-after via the new Columbus View lanes
  in `probe-classifier-logdepth-flip.mjs` (pre-fix: ALL CV classification
  annihilated, lit=0; post-fix: 13,973 px == WebGL exactly).
- **`NEW-WEBGPU-OFFLINE-GLOBE-ZERO-FRUSTUMS` closed as a probe readiness race**
  (808/810) over the deliberate cold-pipeline-variant skip, with the cost
  measured: WebGPU 2,674 ms / 44 frames to first globe command vs WebGL
  771 ms / 13 frames. Engine follow-up filed, not scoped:
  `NEW-WEBGPU-GLOBE-COLD-VARIANT-FRUSTUM-COUPLING`.
- **C12-25 LOLA lunar normal map landed + Edge-verified** (811/813): SHA-pinned
  bake from NASA SVS `ldem_16.tif`, 1024×512 8-bit PNG, both backends perturb
  the lighting normal in the same model-space ENU basis. Probe: terminator
  relief 1.30% on both backends, cross-backend parity 0.00%.
- **C11-212 `Scene.snap` fixed-camera baseline landed + verified** (812/813):
  the two-phase occluder/payload mini-frame, RGBA32F payload, readback, and
  backend-neutral routing produced the same 24.8 m fixed-view hit on both
  backends. This is a partial surface baseline, not completion of the feature.
- **Two NEW defects surfaced by first-honest-run probes** (see §2 and §4).
- **Instrument doctrine additions**: same-aim center-box differentials for
  star counts; wall-clock (not frame-count) readiness budgets after
  master-switch flips; distinct colors for negative-control geometry so
  occlusion bleed can never pollute a subject count.

Fleet state at the original handoff: pure-Node spec fleet **1009/1009**; package tsc clean in the
built main tree; `probe-scene-snap`, `probe-moon-lola-relief`,
`probe-env-background-clear`, `probe-pipeline-key-aliasing` all PASS.
One probe remains **deliberately RED as the incomplete C12-11 seam signal** — do not "fix" its gate:
`probe-stars-catalog.mjs` (§4.2). The log-depth probe was corrected and is
green; see §2.

**2026-08-02 Codex execution update:** the narrowed unstaged C11-194 recovery
slice has passed independent review. Exact `(GPUDevice, resourceGeneration)`
ownership now covers model/shared/pipeline/compatibility resources and
environment-pool handles; candidate uploads and per-feature-pick replacement
are transactional; late pipeline/error-scope publication is lifecycle-epoch
guarded; and detach-first teardown drains every owner even when an old native
throws. Focused recovery/pool contracts pass 19/19 + 45/45 and package
TypeScript is clean. This is a GO for the bounded slice, not closure of the
campaign row: higher-level texture re-upload, nested IBL/clipping recovery,
multi-context arena partitioning, and live replacement-device evidence remain.
No decoded-source replay journal was retained.

**Current unstaged verification checkpoint (updated after C12-35):** engine
TypeScript, top-level `gulp build`, and `git diff --check` pass. The complete
visual-regression Node fleet is 1,227/1,227. Focused Moon Node is 75/75;
WebGL/WebGPU lifecycle Jasmine executes 8/8 + 9/9; Scene/CesiumWidget teardown
is 1/1 each; device pool/loss is 4/4 + 10/10. The schema-v2 real Edge C12-35
gate passes with zero console/page/GPU faults. Purpose-built Edge gates also
remain green for both-backend multi-frustum snap and C13-08 regional weather
tails; artifacts are named in §§3-5.

---

## 2. RESOLVED INSTRUMENT INCIDENT — Bug 814.1 second mechanism

`NEW-WEBGPU-MAT-LOGDEPTH-MULTI-PRIMITIVE-DEPTH-LOSS` (DEFERRED_WORK, filed
Batch 814, corrected after Batch 818). The pre-correction measurements below
are historical evidence from a non-deterministic scene, not an open renderer
defect:

- ONE Mat-pipeline primitive (green slab grid @5 m, 220 km nadir, solid globe,
  log depth ON) renders complete: 44,983 px, exactly matching the hyperbolic
  OFF reference.
- Adding a SECOND Mat primitive (below-ground grid @-3000 m, own
  `Primitive` + `MaterialAppearance`) costs the slab ~4,955 px to the GLOBE
  (void samples read the globe baseColor) in a stable, arrow-shaped contour.
  Log-ON only. Deterministic across re-renders and OFF→ON flips.
- **Batch 816 fixed the one real contract violation found** (`writeLogDepthTail`
  read live per-slice `currentFrustum` state instead of the frame-stable
  `_logDepthEncodeNearFar` stash — last producer off the depth-plane encode
  contract, now stash-first with a mutation-pinned spec) — **and the
  acceptance re-run after a full rebuild is byte-identical to pre-fix**
  (ON=39,039, ratio 0.868). The contract fix stands; the defect has a second
  mechanism.

**Authoritative rerun:** the viewer had started online world terrain, so a slab
5 m above the ellipsoid could legitimately lie below real terrain (or no globe
could render when Ion was blocked). The probe also required a -3000 m primitive
to be terrain-occluded while leaving `globe.depthTestAgainstTerrain` at its
default `false`, which deliberately clears globe depth before opaque draws.
The corrected scene uses `offline=true`, an explicit
`EllipsoidTerrainProvider`, `depthTestAgainstTerrain=true`, and asserts
`clearGlobeDepth=false`. It passes after a full build: ON foreground=44,813,
OFF=44,983, ratio=0.996 (green-only ratio=0.974 because 1,017 colocated
magenta reference pixels overwrite green), underground pixels=0, zero errors. Both flat-Mat tails and all 19
globe tails are bit-identical in the accepted frame. **Disposition:** no second
renderer mechanism exists in this reproducer; retain Batch 816's real
stash-first contract fix and the corrected gate, with no shader feature change.

---

## 3. Campaign 11 — remaining body

Certification of `C11-137` remains **HELD by maintainer ruling (2026-07-23)**
until the W2-W8 body executes. Landed-this-wave slices (`C11-212` snap,
`C11-181`, aliasing family) are stamped in the queue. The remaining items, by
value:

1. **`C11-205`** (P0, measurement blocker) — resident comparability evidence.
   Batch 784 already landed ready-tile count + dual stable identity hashes in
   the ordinary fingerprint, rejects incomplete/mismatched ready sets, and
   attributes the first divergent segment/tile. **Do not reimplement that
   slice.** The unstaged stable single-content request-ledger continuation is
   now reviewed GO: request/attempt serials, deferral, effective cancellation
   and reissue, terminal result, readiness, URL chronology, and byte knownness
   are fail-closed, with 77/77 focused contracts. The preserved July artifact
   remains a 15-request/zero-open exact match. The bounded versioned model-state
   packet is also independently reviewed GO in the worktree (7/7 focused
   contracts): sixteen broad tileset fields are compared once per active pass
   or nonempty processing queue and applied to each model only when immutable
   packet identity changes. Null/undefined light state is normalized; in-place
   light edits are value-snapshotted; listener-bearing `tileVisible`/`tileLoad`
   timing is preserved; and per-tile matrix, clipping, and environment ownership
   remain on their existing dynamic path. The independently reviewed schema-v2
   continuation now observes exact multiple-content slots/groups, discard/
   failure/cancellation/reissue, direct-model content, stale generations, and
   model/content/tile-ready event ordering; focused v2 is 57/57 and all 56
   legacy performance contracts remain green (113/113 combined). The packet
   module also now has the generated barrel's required default export without
   losing named exports; both builds pass. Open sub-items are a real
   multiple-content Edge fixture, focused browser mutation/performance evidence,
   and a fresh resident browser run. The tracker assumes one owner per JS
   realm. No traversal/hysteresis change is authorized. `C11-168`'s causal
   timing claim stays blocked behind the complete evidence gate and resident
   browser run.
2. **`C11-212` surface completion, then `UP144-SNAP-WEBGPU-EDGES`** — the
   active-encoder copy/submission lifecycle, immutable rendered-view/sample
   provenance (including the effective far plane), stale/overlap bounds,
   exception-safe cleanup, and snap-mini-frame-only command realization are
   implemented and independently reviewed. Renderer-neutral pick-frustum math
   now handles drawing-buffer viewport offsets, DPR/Y conversion, independent
   aperture dimensions, asymmetric perspective/orthographic planes, and
   frozen unprojection. Combined snap/projection contracts are 69/69.

   Both multi-frustum stale-payload mechanisms are corrected without a new
   pass or submission: WebGPU uses one query-scissored zero draw inside the
   loaded payload pass, while WebGL uses a snapless occluder derived command.
   The rebuilt real-Edge probe is green on both backends with TAA enabled:
   far model visible, nearer object in a distinct slice suppresses it, far
   model returns, and device/console/page errors are empty. Report:
   `Tools/visual-regression/output/snap-multifrustum-report.json`.

   The target-cost review rejected query-sized targets because they would
   change projection/culling/screen-space semantics. The safe slice changes
   only WebGPU's payload from RGBA32F to exact RG32Uint, retaining u32 key and
   f32 eye depth while packing the edge bit into depth's clear sign bit. At 4K
   this saves 63.28 MiB and reduces the full target set from 189.84 to 126.56
   MiB; snap's unused occluder color store is discarded, ordinary pick is
   unchanged, and a 25x25 staging row falls from 512 to 256 aligned bytes.

   The row remains partial. Open surface gates are forced SCENE2D slice-depth
   provenance; genuinely moving camera/cursor Edge lanes across DPR,
   asymmetric projection, split viewport, edge clipping, and RTE/culling
   boundaries; even-aperture/WebGL logical-padding defects; and a possible
   shared transient-target design. The edge emitter still carries no pick ID,
   so `UP144-SNAP-WEBGPU-EDGES` needs primitive pick color plus an RG32Uint snap
   fragment/pipeline variant. Classification and broader-producer riders stay
   open.
3. **`C11-213`** — vector-polyline draping WGSL (the second half of the
   Scene.snap/draping pair you seeded; its owner is independent of the still
   partial C11-212 snap row).
4. **`C11-90` tail** — strips/fans topology landed (Batch 799); the sandcastle
   visual gate is still owed (orchestrator machine lane, but a Sandcastle demo
   slice is fair game if you get there first).
5. **`NEW-WEBGPU-PIPELINE-KEY-DEFINE-AXIS-GENERAL`** — the durable fix for the
   aliasing class: fold the define mask into `generateCacheKey` itself (or
   whole-bitmask stamps everywhere), making the class structurally impossible.
   Until then every new define bit must be hand-checked against the rule.
6. **`C11-202` bounded native pick/edge-tax slice** — independently reviewed
   GO in the worktree. Native descriptor construction preserves every shared
   derivation stage and the Scene edge-MRT demand signal, while skipping only
   legacy `PickingPipelineStage`/`EdgeVisibilityPipelineStage`/
   `EdgeDetectionPipelineStage`; WebGL is unchanged and focused Node is 3/3.
   The row remains partial for moving-route allocation/timing proof, remaining
   frontend-tax audit, native edge RTE, renderer-owned selected-feature IDs,
   and browser/fallback/device-recovery coverage.
7. **W2-W8 wave body** per the queue's recorded wave order.

## 4. Campaign 12 — remaining body

1. **`C12-35` — COMPLETE / INDEPENDENT GO.** All L0-L5 ownership,
   WebGL/WebGPU parity, diagnostics, Node/Jasmine, real Edge transport/pixel/
   request-render/teardown, and zero-fault gates pass. Scene now
   deterministically destroys Moon, and expected pool/context GPUDevice
   destruction no longer emits false loss errors while external/genuine loss
   remains reported. Moving-camera seam/shimmer is explicitly reassigned to
   C12-33's mip/sampler/derivative gate; C12-35 owns static final-pixel and
   lifecycle integrity. The evidence and architecture are in
   [`C12_MOON_TEXTURE_LIFECYCLE_AUDIT_2026-08-02.md`](C12_MOON_TEXTURE_LIFECYCLE_AUDIT_2026-08-02.md).
2. **`C12-33` — IN PROGRESS.** Moon texture mip generation on both backends
   began in three bounded lanes after the C12-35 gate passed. The design audit
   corrected the old premise:
   WebGL mips are Moon-local now that C12-35 owns direct Texture realization;
   WebGPU uses the context's frame-owned shared texture-mip queue, never a
   private submit. Flatten the opaque front/back fragment selection to one
   color call and use implicit sampling so the differently sized albedo and
   normal maps each receive independent hardware LOD. Preserve WebGL1 NPOT
   fallback and test the equirectangular seam, limb, close view, and ~16 px
   shimmer. Land/certify mips before the one-flag 2K LOLA normal re-bake.
3. **`C12-11` starfield seam** — the Batch-815 near-redundancy measurement is
   real, but the follow-up audit found that DR-01 already settled the design:
   diffuse Milky Way light belongs to the cubemap and resolved stars belong to
   the 2,868-sprite catalog on both backends. `C12-10` deliberately shipped the
   unblurred reversal artifact before `C12-09`; the missing step is the
   diffuse-face switch plus M6/G3 and moving-camera alias/cost evidence. The
   hash-pinned source TIFF/diffuse outputs are not in this worktree, so do not
   approximate them by independently blurring the six JPEG faces. Keep
   `probe-stars-catalog` check (A) red until `C12-11` lands. See
   [`C12_STARFIELD_SEAM_DISPOSITION_2026-08-02.md`](C12_STARFIELD_SEAM_DISPOSITION_2026-08-02.md).
4. **`C12-34`** — sky-brightness twilight range.
5. **`C12-31` acceptance tail** (orchestrator machine lane): limb-halo
   rim-detector rebuild + `PARITY_MAX` re-derivation (isolated baseline
   14.64/14.81 vs the 12.0 placeholder).
6. **Star 6.0 one-flag deepen** (5,058 stars) — parked pending C12-11's
   diffuse/resolved seam plus moving-camera alias and both-backend frame-cost
   evidence. The design is settled and the 2,868-sprite renderer is healthy;
   do not deepen before its real marginal cost/quality is measured.

## 5. Campaign 13 — remaining body

Gate B: all five implementation rows are present and **the WebGPU
regional-placement pixel gate PASSED** (Batch 806: inside 0→0.118, outside
byte-flat, stats exact). The retained C13-08 worktree tails remain green: the
rebuilt Edge cyclic CoverageJSON lane passes east/west/seam/far continuity,
no-duplicate/no-wall, regional-pack-stat, procedural-fill, and clean-device gates;
the WebGL lane preserves non-vacuous billboards byte-for-byte with zero
volumetric publication. Ten PNGs were read. Manifest:
`Tools/visual-regression/output/weather-regional-tails/manifest.json`.

An independent promotion audit nevertheless keeps C13-08 and Gate B **IN
PROGRESS / NO-GO FOR COMPLETE promotion**. It found and fixed the regional
cell-registration edge defect: non-wrapped continuous source coordinates now
clamp before interpolation, so the west/north outer half-cells cannot
extrapolate or read a diagonally-opposite observation through a no-data corner.
The focused bounds suite is 31/31; cyclic parser + bounds is 38/38. The five
global ingest/source/channel/time probes, seam/poles, and the intended-behaviour
METAR probe have no post-Batch-797 evidence. All seven must rerun green after
this packer change before landing can promote the row or unblock `C13-41`.

1. **C13-08 tails — RETAINED ACCEPTANCE GREEN; COMPLETE PROMOTION NO-GO.** Run
   the seven browser regressions named in the Campaign 13 checklist after the
   packer correction, then perform landing review. The regional-tail probe must
   also rerun because its producer changed, even though its fixture is
   node-registered and the retained images remain valid evidence of the parser
   and antimeridian path.
2. **`C13-16`** — cirrus/genus morphology (the coverage-cutoff fix in
   `cloudEffectiveCoverage()` restored cirrus visibility; per-genus shape work
   remains).
3. **Fog cheap-path coverage gate** — the queue row's remaining arm.
4. Do NOT touch the cloud probes' watchdog-gated rows unless their watchdogs
   are green in the queue ledger.

## 6. Campaign 15 (NEW) — Aurora + space weather (Atmospheric-Effects Phase F)

Seeded in Batch 771 from the maintainer's 2026-07-26 ask ("northern lights +
trigger solar and magnetic storms + investigate open space-weather data") and
tracked as `EPIC-AURORA-SPACE-WEATHER`. The earlier draft accidentally reused
Campaign 14. That number belongs to the already-ratified Dynamic Ocean & Wind
plan under O5; it remains blocked until C11+C12+C13 complete and is neither
renamed nor launched here.

`C15-00` has now completed the research and authored
[`QUEUE_2026-08-02_CAMPAIGN15.md`](QUEUE_2026-08-02_CAMPAIGN15.md). Campaign 15
is **planned / research-verified / implementation not started**; do not call it
launched without a maintainer ruling. The queue is the full execution ledger.
Its corrected order is:

1. `C15-01` backend-neutral state packet + deterministic manual driver.
2. `C15-02` WMM2025 geomagnetic coordinates + synthetic oval.
3. `C15-03` shared RTE density/emission kernel + sample-local night gate.
4. `C15-04` feature-equivalent WebGL and WebGPU shell renderers.
5. `C15-05` OVATION/Kp ingest and source-authority policy.
6. `C15-06` replacement RTSW feeds + separate GOES flare state.
7. `C15-07` facade/demo/diagnostics/attribution.
8. `C15-08` visual, lifecycle, RTE, off-contract, and moving-perf
   certification.

Research corrections that must survive implementation:

- Use an analytic, layered **80–600 km** emission shell, with distinct
  427.8/557.7/630.0 nm altitude profiles, not one 100–400 km slab, a sky dome,
  or a post-process.
- WMM2025's centered-dipole axis is **9.21°** from the rotation axis; its north
  geomagnetic pole is **80.79°N geocentric (80.85°N geodetic), 72.76°W**.
  The oval is non-circular, noon/midnight asymmetric, and activity-dependent.
- Evaluate darkness at each shell sample or its ellipsoid footprint. The
  camera-local star fade cannot classify a globe-spanning/orbital volume.
- Valid live OVATION owns spatial extent/intensity. OVATION already consumes
  L1 solar wind/IMF and can fall back to Kp, so Kp/Bz must not multiply the
  live field a second time.
- Use the post-April-2026 replacement feeds
  [`rtsw_mag_1m.json`](https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json)
  and
  [`rtsw_wind_1m.json`](https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json),
  preserving source, active, and quality metadata. The legacy
  `/products/solar-wind/` family was scheduled for removal; see
  [NWS SCN 26-21](https://www.weather.gov/media/notification/pdf_2026/scn26-21_Data_Format_Changes_Impacting_SWPC_Products.pdf).
- GOES X-ray activity is a separate solar-flare channel, not an instantaneous
  geomagnetic-storm/oval multiplier.
- WDC Kyoto explicitly prohibits commercial applications of its geomagnetic
  indices. There is no built-in Kyoto Dst provider and no bundled Dst snapshot;
  only a caller-owned numeric override is in scope. See the
  [WDC Kyoto usage rules](https://wdc.kugi.kyoto-u.ac.jp/wdc/Sec3.html).
- Exact WMM, aurora, feed schema/lifecycle, and NWS data-use sources are pinned
  in the C15 queue. Do not infer blanket NOAA/JHU snapshot licensing from a
  public endpoint. Default OFF means zero passes, allocations, animation,
  jobs, requests, uploads, and bind-group churn.

Campaign 15 is independent of T/Td/RH weather ingest. Its shared dependency is
the night/sky-brightness definition, evaluated locally rather than reused as a
camera scalar. The synthetic/manual lane comes before every network lane.

## 7. Orchestrator-held lanes (do not duplicate)

Machine verification stays with the orchestrator: `probe-ellipsoidprim-logdepth`
re-baseline (blocked on §2), the C11-205 resident RUN itself (you build the
evidence tooling; the counterbalanced run is a machine lane), the sun-shadow
fleet probe (Batch 805 filed the gap + a real anomaly: WebGPU ground BRIGHTENS
~112/255 when the scene shadow map enables — that number is evidence to
explain, not noise), the C12-31 sweep, and the star-census frame-cost delta.
Certifications and queue-status promotions to COMPLETE are maintainer/
orchestrator calls.

## 8. Working rules (binding, learned the hard way this wave)

1. **Package tsc is the binding type gate**:
   `npm exec --package=typescript --offline -- tsc --project packages/engine/tsconfig.json --noEmit`.
   Root `npx tsc --noEmit` passing alone is NOT sufficient. In an unbuilt
   worktree, pre-existing `TS2307 ../Shaders/*.js` errors are the only
   tolerated class — the non-TS2307 count must be 0.
2. **Never `gulp build` from a worktree** (junctioned node_modules writes into
   the main tree). Building and browser probes are main-tree operations.
3. **Pure-Node spec fleet must stay green**: `node --test
   Tools/visual-regression/*.spec.mjs` (1009 at handoff). New mechanisms need
   specs with at least one MUTATION test that re-introduces the defect and
   requires detection.
4. **Probe rules**: pinned clocks; same-task capture; canvas-element PNGs;
   helpers INSIDE `page.evaluate`; wall-clock (not frame-count) readiness
   budgets after any pipeline-affecting flip (~1-2 s async compiles; measured
   2.7 s cold-variant); readiness = binned `Pass.GLOBE` commands, never
   `tilesLoaded` alone; distinct colors for negative-control geometry;
   `PROBE_BASE=http://localhost:8080` (several probes default to :8134);
   pipe exit codes lie — capture `EXIT=$?` on the command itself.
5. **Read the PNGs**. Twice this wave the numbers passed while the pixels
   held a finding (diagonal CV stripes; the arrow void). A gate result without
   eyes on the image is half a verification.
6. **Doc sync duties**: DEBUGGING_GUIDE probe inventory for any new probe or
   mode; DEFERRED_WORK for any gap you find or route around (Principle 9);
   queue ledger rows when a task changes state; move FEATURE_INVENTORY entries
   between §B/§C/§D when status changes.
7. **Leave your work uncommitted** in the main tree (or in your own worktree)
   and write a stopping-point report — the orchestrator reviews and lands, as
   with your 07-31 pass (8 defects were fixed pre-landing; that review layer
   is load-bearing). If you must commit in your own lane: `git status` before
   every commit, stage ONLY your own files, never `--no-verify`, never touch
   `main`'s push state.
8. One probe is deliberately RED (`probe-stars-catalog` check A). It is the
   valid incomplete-`C12-11` seam signal under DR-01, not a renderer failure or
   an open design question. The corrected log-depth probe is green and must
   stay green.

## 9. Suggested execution order

1. **DONE for the bounded slice:** stabilize and independently review the
   narrowed C11-194 exact-device/resource-generation model-cache recovery
   work. The implementation above is GO without a global decoded-texture
   replay journal; keep the row partial until higher-level re-upload, nested
   IBL/clipping, multi-context arena, and real browser recovery gates close.
2. **C15-00 queue authoring + research verification (§6) — COMPLETE.** The
   queue is planned but not launched; `C15-01` waits for a maintainer launch
   ruling. Campaign 14 remains Dynamic Ocean & Wind and blocked by O5.
3. **DONE for this C11-212 slice:** both-backend multi-frustum reset/erase,
   exact RG32Uint payload cost reduction, renderer-neutral projection fixes,
   and real-Edge acceptance. Continue later with SCENE2D and genuinely moving
   camera/cursor coverage, then `UP144-SNAP-WEBGPU-EDGES` (§3.2).
4. **C13-08 tails — RETAINED GREEN; PROMOTION NO-GO** (§5.1). Run the seven
   browser regressions plus the regional-tail probe after the cell-edge packer
   correction. Promote Gate B and unblock C13-41 only after those gates, review,
   and landing.
5. **DONE for the bounded C11-205 ledger, schema-v2, and versioned-state
   slices** (§3.1). Continue with a real multiple-content Edge fixture,
   focused browser mutation/performance, and resident-run evidence without
   duplicating Batch 784.
6. **DONE for the bounded C11-202 pick/edge-tax slice** (§3.6). Measure the
   allocation/timing effect and retain the broader RTE/browser/frontend audit.
7. **C12-35 COMPLETE / independent GO. Start C12-33 Moon mips** (§4.1) —
   retain the lifecycle gates, use only frame-owned submission, then run the
   moving seam/limb/close/shimmer acceptance before the 2K relief re-bake.
8. **DONE: starfield disposition audit.** DR-01 already owns the decision;
   execute `C12-11` when the hash-pinned 16K source/diffuse artifacts are
   available, then run M6/G3 and moving-camera cost/alias acceptance (§4.2).
9. Then the wave bodies (C11 W2-W8, C13-16, C12-34). After a maintainer launch
   ruling, Campaign 15 runs `C15-01 → C15-08` per its queue; this does not
   accelerate Campaign 14 past O5.
