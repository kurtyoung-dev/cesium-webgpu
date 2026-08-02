# Codex next-wave handoff — campaign remainders + one open investigation

**Date:** 2026-08-02
**Repository state:** CLEAN. `origin/main` = `c2ac350bde` (Batch 817), branch
inventory is `main` only, no stashes, no worktrees. Everything described below
is LANDED — unlike the 2026-07-31 handoff there is no uncommitted work to
inherit.
**Execution authority:** the three live campaign queues
([C11](QUEUE_2026-07-18_CAMPAIGN11.md), [C12](QUEUE_2026-07-19_CAMPAIGN12.md),
[C13](QUEUE_2026-07-23_CAMPAIGN13.md)) + [DEFERRED_WORK.md](DEFERRED_WORK.md).
**Campaign 14 (aurora + space weather, §6) has NO queue file yet — authoring
it is C14's first task.** This document is the entry map, not the ledger —
update the queue rows as you work, not just this file.

---

## 1. Where the fork is (progress through Batch 817)

Your previous pass (the 2026-07-31 stopping point) landed as **Batches 772-781**
after orchestrator review. Since then the orchestrator ran Batches 782-817:

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
- **C11-212 `Scene.snap` on WebGPU landed + verified** (812/813): two-phase
  occluder/payload snap mini-frame (RGBA32F payload, shared depth), full
  readback, backend-agnostic routing. Probe: identical 24.8 m hit distance on
  both backends; all four gates PASS.
- **Two NEW defects surfaced by first-honest-run probes** (see §2 and §4).
- **Instrument doctrine additions**: same-aim center-box differentials for
  star counts; wall-clock (not frame-count) readiness budgets after
  master-switch flips; distinct colors for negative-control geometry so
  occlusion bleed can never pollute a subject count.

Fleet state: pure-Node spec fleet **1009/1009**; package tsc clean in the
built main tree; `probe-scene-snap`, `probe-moon-lola-relief`,
`probe-env-background-clear`, `probe-pipeline-key-aliasing` all PASS.
Two probes are **deliberately RED as flags** — do not "fix" their gates:
`probe-logdepth-zfight.mjs` (§2) and `probe-stars-catalog.mjs` (§4.2).

---

## 2. TOP PRIORITY — open investigation: Bug 814.1 second mechanism

`NEW-WEBGPU-MAT-LOGDEPTH-MULTI-PRIMITIVE-DEPTH-LOSS` (DEFERRED_WORK, filed
Batch 814, updated 817). The measured facts:

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

**Your next diagnostic is already scoped** (fix report §6.3, recorded in the
DEFERRED_WORK entry): in the two-primitive scene, dump the slab's camera-UB
log-depth tail (FLAT floats 40-43) AND the globe's tail values at capture
time. If they AGREE, the mechanism is non-uniform — suspects, in order:
per-instance depth path, vertex-side clip-z clamp interaction
(`csm_updatePositionDepth`), or the second primitive altering shared
depth-attachment state. `mat-logdepth-encode-stash.spec.mjs`'s depth-compare
oracle then bounds where the curves diverge. Acceptance instrument:
`probe-logdepth-zfight.mjs` check (2) ≥ 0.9 with checks (1)/(2g)/(3)/(3g)/(4)/(5)
green. Do not weaken the gate; do not disable Mat log depth to pass it.

---

## 3. Campaign 11 — remaining body

Certification of `C11-137` remains **HELD by maintainer ruling (2026-07-23)**
until the W2-W8 body executes. Landed-this-wave rows (`C11-212` snap,
`C11-181`, aliasing family) are stamped in the queue. The remaining items, by
value:

1. **`C11-205`** (P0, measurement blocker) — resident comparability evidence.
   The Batch 779 prototype landed; open sub-items: ready-tile identities in the
   ordinary fingerprint, ordinary ready-set rejection, stable cross-leg request
   serials, model readiness transitions, multiple-content coverage, the
   versioned model state packet. Smallest safe slice (from your own 07-31
   analysis, still correct): add ready-tile count + dual stable identity hashes
   to the ordinary post-measurement fingerprint and reject resident comparisons
   on any disagreement. Tooling-only; no traversal/hysteresis changes.
   `C11-168`'s causal timing claim stays blocked behind this.
2. **`UP144-SNAP-WEBGPU-EDGES`** (new, filed 812) — the WebGPU edge emitter's
   line pipeline carries no pick ID, so every snap hit is `isEdge:false` and
   `selectBestHit`'s edge preference is inert. Needs: primitive pick color in
   `WebGPUEdgeVisibilityEmitter`, a snap fragment entry, an RGBA32F variant.
   Surface snapping already works — this is the edge tier only.
3. **`C11-213`** — vector-polyline draping WGSL (the second half of the
   Scene.snap/draping pair you seeded; C11-212 is done).
4. **`C11-90` tail** — strips/fans topology landed (Batch 799); the sandcastle
   visual gate is still owed (orchestrator machine lane, but a Sandcastle demo
   slice is fair game if you get there first).
5. **`NEW-WEBGPU-PIPELINE-KEY-DEFINE-AXIS-GENERAL`** — the durable fix for the
   aliasing class: fold the define mask into `generateCacheKey` itself (or
   whole-bitmask stamps everywhere), making the class structurally impossible.
   Until then every new define bit must be hand-checked against the rule.
6. **W2-W8 wave body** per the queue's recorded wave order.

## 4. Campaign 12 — remaining body

1. **`C12-33`** — moon texture mip generation (both backends). This is what
   holds the LOLA bake at 1K; the re-bake to 2K is one `--width 2048` flag
   after it lands. Also owed: watch for sprite shimmer at the ~16 px disc.
2. **`C12-STARFIELD-SPRITE-VS-CUBEMAP-REDUNDANCY`** (new, filed 815, needs a
   DESIGN disposition — bring options to the maintainer rather than picking):
   the 2,868-sprite catalog adds ~3 px over the procedural cubemap's baked
   stars at default exposure. Options recorded in the entry: (a) sprites are
   the HDR/bloom bright-star layer → measure in HDR terms; (b) magnitude-band
   split (bake faint, sprites own the bright end); (c) sprites redundant →
   value lives in the bake. Cross-reference the celestial-appearance research
   doc's sky-layering section first. `probe-stars-catalog` check (A) stays RED
   as the flag until ruled.
3. **`C12-34`** — sky-brightness twilight range.
4. **`C12-31` acceptance tail** (orchestrator machine lane): limb-halo
   rim-detector rebuild + `PARITY_MAX` re-derivation (isolated baseline
   14.64/14.81 vs the 12.0 placeholder).
5. **Star 6.0 one-flag deepen** (5,058 stars) — parked pending the redundancy
   disposition; pointless to deepen a layer whose visibility is unresolved.

## 5. Campaign 13 — remaining body

Gate B: all five rows implemented and probe-verified; **the regional-placement
pixel gate PASSED** (Batch 806: inside 0→0.118, outside byte-flat, stats
exact). Remaining:

1. **C13-08 tails** — the antimeridian-straddle lane and the WebGL regression
   sweep of the weather-field bounds work.
2. **`C13-16`** — cirrus/genus morphology (the coverage-cutoff fix in
   `cloudEffectiveCoverage()` restored cirrus visibility; per-genus shape work
   remains).
3. **Fog cheap-path coverage gate** — the queue row's remaining arm.
4. Do NOT touch the cloud probes' watchdog-gated rows unless their watchdogs
   are green in the queue ledger.

## 6. Campaign 14 (NEW) — Aurora + space weather (Atmospheric-Effects Phase F)

**This is the next campaign.** Seeded Batch 771 from the maintainer's
2026-07-26 ask ("northern lights + trigger solar and magnetic storms +
investigate open space-weather data"); tracked as `EPIC-AURORA-SPACE-WEATHER`
in DEFERRED_WORK and scoped in
[ATMOSPHERIC_EFFECTS_ROADMAP.md](ATMOSPHERIC_EFFECTS_ROADMAP.md) Phase F
(read that section in full before starting — it is scoping-to-verify, not
findings). Phases A-E are all shipped, so F is the only unbuilt phase. No
QUEUE_CAMPAIGN14 file exists yet — **authoring it is C14's first task.**

Work breakdown (derive the queue rows from these, keeping the roadmap's
constraints):

1. **C14-00 — Queue + research verification.** Author
   `QUEUE_2026-08-XX_CAMPAIGN14.md` from the Phase F section; verify its
   scoping claims (emission lines, oval geometry, SWPC product URLs/formats)
   before building. The roadmap explicitly SUPERSEDES the old scattered
   "procedural sky-dome shader, 2-3 days" backlog entries — do not re-scope
   from those; they are pre-globe-orbit assumptions.
2. **C14-01 — Volumetric aurora shell renderer (the core).** A 100-400 km
   emission shell that stands above the limb from orbit and overhead from the
   ground — a sibling of the volumetric raymarchers, NOT a screen-space
   post-process or sky-dome texture. Emissive, additive, unlit, depth-tested
   against the globe, night-gated. Fixed line-emission palette: 557.7 nm green
   (dominant, ~100-150 km), 630.0 nm red crown (>200 km, strong storms),
   427.8 nm N2+ blue/violet lower edge. Curtains/rays follow geomagnetic field
   lines via a tilted-dipole approximation (oval centred on the geomagnetic
   pole, ~11 deg off geographic — a geographic oval is visibly wrong). Both
   backends per Principle 5; RTE rules apply to the shell geometry.
3. **C14-02 — Storm-state driver.** One scalar (Kp) drives oval latitude
   (~67 deg magnetic quiet → ~50 deg severe), intensity, and red-crown
   fraction; manual override + optional data source, mirroring `effects.auto`.
   Optional flourishes: substorm onset brightening/poleward surge, curtain
   turbulence. **A synthetic/manual driver ships FIRST** — demonstrable and
   testable with zero network calls.
4. **C14-03 — SWPC space-weather ingest (public domain, licence-clean).**
   Candidates to verify: Kp JSON (the storm scalar), OVATION Prime
   aurora-probability grid (near drop-in for the oval — sampled like
   `weatherTex`), DSCOVR/ACE solar wind (speed/density/Bz), GOES X-ray flux
   (flare class, the *solar* half of the ask). **Dst (Kyoto WDC) requires a
   licence check — NOT US-federal public domain; Kp from SWPC is the safe
   default.** House rules: nothing bundled without a LICENSE.md Bundled
   Engine Assets entry; the renderer consumes normalized scalars so live,
   baked-historical, and synthetic drivers are interchangeable.
5. **C14-04 — `effects.aurora` facade + auto-master wiring** in the same
   hierarchy Phases A-E established (default OFF, byte-neutral when off), +
   Sandcastle demo (new gallery format: `packages/sandcastle/gallery/<kebab>/`).
6. **C14-05 — Probe + measurement doctrine.** Known trap, pre-recorded in the
   roadmap: a faint additive signal over a large band is INVISIBLE to a
   band-mean statistic (the eclipse star-reveal lesson) — gate on
   point/structure metrics or isolated-component differences, never a mean.
   Night-gating must reuse the star field's solar-elevation edge
   (`computeStarDayFade` / the SkyBrightness sun term), not a new gate.

**Prerequisite note from the roadmap:** C14's real dependency is a trustworthy
night-side gate (shared with the star field), not the T/Td/RH weather ingest —
it does NOT queue behind weather Phases 1-2.

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
8. Two probes are deliberately RED (`probe-logdepth-zfight`,
   `probe-stars-catalog` check A). They are flags on open questions, not
   broken gates. Fixing the underlying issue is the only way to green them.

## 9. Suggested execution order

1. §2 Bug 814.1 second-mechanism diagnostic (highest-value open defect; the
   scoped tail-dump discriminates uniform vs non-uniform in one run).
2. C11-205 smallest safe slice (§3.1) — unblocks the fork's headline
   performance claim.
3. **C14-00 queue authoring + research verification (§6.1)** — launches
   Campaign 14 while the C11/C12/C13 remainders execute; C14-01's synthetic
   aurora shell can start as soon as the queue's scoping is verified.
4. UP144-SNAP-WEBGPU-EDGES (§3.2) — completes the snap feature tier.
5. C12-33 moon mips (§4.1) — unlocks the 2K relief re-bake and closes the
   shimmer caveat.
6. C13-08 tails (§5.1) — closes Campaign 13's Gate B checklist entirely.
7. Starfield disposition options memo (§4.2) — maintainer decision prep.
8. Then the wave bodies (C11 W2-W8, C13-16, C12-34) and the C14 build rows
   (C14-01 → C14-05) per queue order.
