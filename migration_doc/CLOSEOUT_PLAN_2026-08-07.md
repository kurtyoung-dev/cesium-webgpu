# Campaign Close-Out Dispatch Plan — 2026-08-07 (Batch 899)

> **⚠ SNAPSHOT OF 2026-08-07 — SUBSTANTIALLY EXECUTED. QUEUE ROWS WIN.**
>
> _Banner added 2026-08-09 by the handover-readiness audit
> ([`HANDOVER_AUDIT_2026-08-09.md`](HANDOVER_AUDIT_2026-08-09.md) FIX 8)._
>
> Roughly a hundred batches have landed since this plan was written and much of it is
> **spent**. Specifically: **gate G2 PASSED its first run at Batch 905** (`ced8c1256f`),
> **gate G3's first run executed at Batch 934** (`4f6d3c9751`), **gate G4 CLOSED at Batch 984**
> (`943e13b571`, ninth run, first exit 0), and **every item in the §3 maintainer decision
> queue was ruled on 2026-08-10** as `R-2026-08-10-1..7`
> ([`MAINTAINER_RULINGS_2026-08-10.md`](MAINTAINER_RULINGS_2026-08-10.md)) — see the §3
> addendum below for the item-by-item mapping.
>
> **Lane E's owed-run order is stale and must not be trusted as current.** To rebuild the
> machine lane's queue, grep the campaign queues for `OWED`, order by **batch number**, and
> honour any recorded pre-registrations (`ORCHESTRATION_HANDBOOK.md` §9).
>
> This document remains a **dispatch grouping only**. On any status conflict the campaign
> queue row wins — that rule was always in force and the passage of time has only made it
> load-bearing.
>
> **CURRENT CROSS-CAMPAIGN ORDER:** use
> [`CAMPAIGN_PORTFOLIO_QUEUE.md`](CAMPAIGN_PORTFOLIO_QUEUE.md). It covers C11–C18,
> the split C15 lanes, current WIP/browser limits, and the feature-priority frontier.

Maintainer directive 2026-08-07: _"queue up the remaining work to close out the
open campaigns … get everything queued into organized batches and just keep
working at it."_ Executed under the Fable-orchestrator / Opus-worker pattern
(workers never commit; the orchestrator reviews, lands, and updates ledgers).

**THIS IS A DISPATCH SCHEDULE, NOT A STATUS LEDGER.** Row status lives in the
campaign queues (`QUEUE_2026-07-18_CAMPAIGN11.md`, `QUEUE_2026-07-19_CAMPAIGN12.md`,
`QUEUE_2026-07-23_CAMPAIGN13.md`, `QUEUE_2026-08-02_CAMPAIGN15.md`) and
`DEFERRED_WORK.md`, which remain the sole authorities. If this document and a
queue row disagree, the queue row wins. This document only records how the open
work is grouped into dispatch batches and in what order the lanes run.

## 0. Inventory basis

Five-reader Opus inventory at tip `181da204cb` (2026-08-07, workflow
`wf_67b6cf74-9d3`), each reader cross-checking row status against
`git log -160`: **411 honestly-open rows** — C11 215, C12 45, C13 42, C15 18,
deferred backlog 91. The readers found **12+ live doc-drift contradictions**
(stale "pending landing" cells for landed work, a false NOT-STARTED ledger row
for C11-149, discharged evidence not recorded on C11-90/184, self-contradictory
C15-G6 cell, stale C13-08 acceptance prose, and more) — batch CO-1 reconciles
them so no later batch plans against a stale premise.

## 1. Strategy

1. **Critical path = C12 completion.** Ruling R1 makes it the sole remaining
   Campaign-14 bar; ruling R4 holds aurora (C15-01..08) until C12 closes. The
   C12 gate state is worse than its row state: G1's baseline is stale and
   G2/G3/G4 have **no browser lane at all** — gate-lane construction is
   scheduled work, not an afterthought.
2. **C11 is the long grind, run in strict wave order** (W1 remainder → W2 → …
   → W8), certification HELD per R2 — no re-scoping, no quiet redefinition.
   The W1 environment trio (C11-132/133/134) goes first: until all three are
   complete, no spec/gate claim in the campaign is falsifiable.
3. **C13** runs its W0 tail (Gate A inputs C13-01/C13-02), then the W2 chain
   (C13-09 → 10 → 12 → 13) and probe-fleet hygiene. C13-16 is
   maintainer-blocked (§3). W6 rows are NOT auto-activated.
4. **C15 gsplat track** runs to its terminal gate G8 (G7 → probe extension →
   tower-variance investigation → G8). Aurora stays double-locked (R4 + no
   launch ruling).
5. **Machine lane** (orchestrator, one Edge at a time) burns down the owed
   acceptance stack — it is large enough that worker lanes must not create new
   owed-acceptance debt faster than the machine lane retires it: **any batch
   that lands with an owed Edge acceptance must name it in its ledger row.**

## 2. Lanes and batch groups

Waves within a lane are sequential; lanes run in parallel when they touch
disjoint files. Batch IDs here are groupings — landed commits keep the global
Batch numbering.

### Lane A — cross-campaign hygiene (first, cheap, unblocking)

- **CO-1 (worker, docs-only): drift reconciliation.** Fix every contradiction
  the inventory found, with dated UPDATE stamps and batch-number evidence:
  C11-149 false ledger row (landed B739); C11-178 stale REMAINING (verify
  `SkyBox.defaultVariant` at HEAD); C11-184 record the B845/849/850
  sun-shadow-gate discharge (globe-receive leg only); C11-90 record the B799
  LINE-family pixel discharge; mint `C11-214` for the unminted B699 shared
  diagnosis; C15 §6 ledger cells for G1/G4/G5 (landed B868/890/894+895) and
  the self-contradictory G6 cell (honest PARTIAL: mechanism fixed B889,
  written multi-frustum exit leg unexecuted); C13-41 row (landed B871, Edge
  owed, probe unauthored); C13-01 header (tour GREEN B790/794); C13-08 stale
  acceptance prose (stamp STALE, point at the B866 roster); C13 §1 add-only
  table gains rows for `C13-39B-CLOUD-SHADER-VARIANT-SPLIT` and the
  fog cheap-path arm (disambiguated subtitle — known ID collision);
  DEFERRED_WORK stale entries (tides datum landed B763; polar probe ran GREEN
  B874; semantic-key headline superseded B825/828; C11-149 prerequisite
  framing; the line-1374 vacuity status block vs its RESOLUTIONS block); C12
  queue "pending orchestrator landing" wording stamped with its established
  meaning (Edge owed, code landed) on C12-21/22/27/14/13 and C12-30.
- **CO-2 (worker): C11 W1 falsifiability tooling** — C11-132 (spec-bundle
  freshness), C11-134 (offline dependency isolation), C11-140 (GPU-timestamp
  unique-sample accounting), C11-146 (settle-window attribution rule).
  C11-133 (Karma launcher flakiness) is a machine-lane investigation — it
  unblocks ~12 downstream "C11-133 launcher" gates and is scheduled early on
  the machine lane.

### Lane B — C12 close-out (critical path)

- **CO-3 (worker, instruments): PRE-DR01 star-threshold re-scopes** (G1 Lane A
  in `probe-celestial-gates.mjs` + `probe-sky-twilight-range.mjs`, following
  the B848 pattern) **+ G2 lane construction** (bind the M4/M5 diagnostic
  metrics; both-backend identical pass required; do NOT tune G1 green).
- **CO-5 (worker): G3 lane construction** (four criteria from the C12 queue).
- **CO-6 (worker): sun cluster** — C12-18 first (absorbs C11-160 sunBloom
  wiring + C11-115 ALPHA_BLEND; self-contained), then C12-19 (true HDR sun,
  XL) in its own batch. No new ShaderDefine bits — runtime uniforms only
  (C12 exit condition 5).
- **CO-7 (worker): C12-28** (HDR default on HDR-capable displays) **+ C12-12**
  (skybox VRAM/streaming policy half; the KTX2-encode half stays
  tooling-blocked — see §3 maintainer items).
- **CO-8 (worker): G4 lane construction** after CO-6 lands (sun half) + the
  moon half binds the already-landed C12-21/22 work.
- **Machine (Lane E): the C12 owed-acceptance stack** ⚠ **STALE — see the header banner;
  rebuild by grepping the queues for `OWED` and ordering by batch number** — moon cluster
  (C12-21/22 + earthshine R5 rider), C12-27 glare, C12-33 calibration,
  **C12-36 star-pixel leg** *(corrected 2026-08-09: written here as "C12-34 pixel leg"; that
  row was renumbered to `C12-36` at Batch 967 / CO-37 because ruling `R-2026-08-10-3`
  assigned `C12-34` to the WebGPU sun-bloom mirror — the two `C12-34`s are different work)*,
  star-census live calibration, IBL PARITY_MAX re-baseline,
  C12-G1F2 re-measure **+ the shell-extent frustum measurement** (feeds the
  canonical-coverage decision), then the G1 gate re-run at HEAD once CO-3
  lands.
- **Closure tail:** C12-EXIT-2 class audit (cloud-occlusion half READ-ONLY
  against C13 HEAD), C12-EXIT-3 FEATURE_INVENTORY update, licensing/manifest
  conditions — after the gates exist and pass.

### Lane C — C13 (W0 tail → W2 → hygiene)

- **CO-9 (worker): C13-02** broad CPU/GPU observability counters (Gate A
  input) + the C13-01 residual bookkeeping.
- **CO-10 (worker): W2 head — C13-09** (reconstruction attachments), then
  C13-10, C13-12, C13-13 as sequential follow-on batches. The C13-39
  negative result binds: no new code into the shared ProceduralClouds module
  without the interleaved-A/B protocol; the only supported perf vector is
  **C13-39B** (variant split — its own batch after an ID row exists via CO-1).
- **CO-11 (worker): probe-fleet hygiene sweeps** — network-globe tail pinning
  (map/presets/inspector), the SHAPE-scoped sweep (the filename-glob miss),
  saturated-difference fleet sweep. Machine: ten-run acceptance + Gate A run
  when inputs close.
- **C13-16**: maintainer-blocked (§3). C13-14 (XL, W3 head) queues after the
  W2 chain per wave order.

### Lane D — C15 gsplat close-out

- **Machine first: C15-G7** (classification depth re-verify — unblocked now).
- **CO-12 (worker): parity-probe extension** required before G8 can gate
  honestly (its own gate text): three-azimuth/orbit lanes, the SH-off vacuity
  control, corrupted-covariance control; plus the two S splat rows
  (`NEW-SPLAT-PENDING-WORK-DRAWCOMMAND-PROXY`,
  `NEW-SPLAT-OIT-FALLBACK-UNUSABLE`) and
  `NEW-WEBGPU-COLLECTION-PASS-LITERAL-DRIFT` (stale Pass literals — latent on
  the DEFAULT path).
- **Machine: tower frame-variance investigation** (BRANCH B confirmed; blocks
  the tower leg of G8; do NOT widen the mutant-pinned 0.050% bar) and the G6
  multi-frustum leg (needs a tower+globe multi-frustum scene — worker prep,
  machine run).
- **Machine: C15-G8 terminal gate** last — also formally closes
  `NEW-WEBGPU-SPLAT-DATA-PRODUCER`, `C10-04-SPLAT-ASYNC-SORT`, and triggers
  the splat-demo re-audit (demo wave 2 hold).

### Lane E — machine lane (orchestrator, one Edge at a time)

Order: **demo wave-1 browser verification + thumbnails** (owed since B898) →
C12 acceptance stack (above) → **C11-01 + C11-11** checkpoint-gating W1
diagnoses → **C15-G7** → first-run owed probes (`probe-cold-optics-hq`,
`probe-logdepth-payoff` at `PROBE_BASE=http://localhost:8080`) → C13-41 Edge
(after CO-13 authors its probe) + fog-arm acceptance → C11-133 launcher
investigation → globe-absent flake diagnosis → ten-run weather acceptance.

### Lane F — C11 body (after CO-2; strict wave order)

- **CO-13 (worker): W1 cheap-rider batch** — C11-16/17/19/22/24/25/41/51 +
  C11-13/14/15/159 (each S/M, disjoint subsystems, one concern per slice
  within the batch's commits).
- **CO-14 (worker): stale-premise reconciliation slice** —
  C11-109/111/113/156/153 premise-verify (several likely DOC-CLOSE).
- **CO-15+ (worker): W1 tail worker rows** — C11-186, C11-188, C11-189/190/191
  (shadow coverage family), C11-193/194/195 residuals, C11-196/197/198 (each
  carries its own attribution-first instruction), C11-206/207/209/210,
  C11-20 remainder, C11-60 remainder, C11-76 remainder. Grouped by subsystem,
  ~3–5 rows per batch, dependencies respected.
- Then W2 (pick fleet C11-02..10 + C11-78, minus maintainer-blocked C11-07/08)
  → W3 (submit-residency) → W4 (tiles/models) → W5 (RTE/TAA — **requires the
  orchestrator-authored rte-taa cluster guide first**, per queue) → W6 → W7 →
  W8 Gate-D. Hard sequencing constraints from the queue (C11-50 before
  C11-43/49; never two of C11-32/33/34 concurrently; C11-117 opens the
  post-process cluster; C11-64 first in S10) bind every dispatch.

### Lane G — deferred-backlog burndown (fills worker capacity between lane batches)

Fleet sweeps (scene-extraction audit gap, verdict-names-failing-predicate,
watchdog-anchor spec, vacuity items 4–5), the GLSL compile gate +
GlobeFS derivative-uniformity sweep (one batch, same subsystem), the fog rows
(MS-scale guard; per-column datum needs a browser run — pairs with machine
lane), the S6 environment batch (Moon/Sun BVs, panorama swap/ordering,
deterministic destroy), UP144 snap residuals, demo wave-1 companion probes.

## 3. Maintainer decision queue

Blocking decisions, ranked by scheduling impact (everything else keeps moving):

1. **C12-29 scope vs. the C12 exit gate** — none of G1–G4 measures eclipse.
   Close C12 with the seven-lane S5 certification matrix open (literal §5
   reading), or treat the matrix as a de-facto fifth gate? **This decision
   alone determines whether Campaign 14 unblocks in weeks or months** (R1).
2. **C13-16 carve-before-erosion pair sign-off** (B896/897): clears every
   anisotropy gate with the coverage floor at 29% margin; the residual
   frontier is the +4.4%/−10.2% opacity trade. Nothing ships without sign-off.
3. **Ratify (or reject) the closure-audit recommendation** to defer C12-26
   (airglow) and C12-32 (shared ephemeris → C14 W0) out of C12 closure scope.
4. **C13-11 STBN provenance** — stays blocked until a license-clean
   generation/import path is approved (Gate C may close naming it).
5. **PROBE-FLEET-EXIT3-CONTRACT-ADOPTION** — one ruling adopting the 0/1/2/3
   contract fleet-wide beats 20 per-probe patches.
6. **Celestial Light Transport & Eye Adaptation epic** (maintainer-requested
   2026-08-07, researched + queued in
   [CELESTIAL_LIGHT_TRANSPORT_PLAN_2026-08-07.md](CELESTIAL_LIGHT_TRANSPORT_PLAN_2026-08-07.md)).
   ⚠ **IDENTITY RESOLVED 2026-08-10 by `R-2026-08-10-7`: CLT is proposed
   Campaign 17, NOT Campaign 16.** Campaign 16 is Comment Remediation &
   Attribution; the "proposed Campaign 16" reading below is superseded and
   the epic remains **PROPOSED, not launched**. *(Stamped 2026-08-09,
   handover audit FIX 8.)* Original text follows:
   launch/identity decision (proposed Campaign 16; recommended hold until C12
   closes, per the R4 principle) plus the six embedded rulings in that doc's
   §7. Its §2 bug list (night-lights sentinel no-op that voids C11-159, the
   0.5 terminator-alpha backend divergence, the untoggleable WebGPU-only
   terminator glow, two homeless sun/limb divergences) is dispatchable NOW
   under Lanes F/G without launching the epic.
7. Lower-stakes, recorded: base-height-fog default flip;
   channels-metric saturation scene change; toggle-resolver conventions
   (lighting-registry facade split); shell-extent canonical coverage (after
   the machine-lane measurement); C12-13 t3 provenance; C11-163 star-source
   choice; C12-31-A fog `darken` gate ruling; C11-145 Gate-A closure;
   C11-205 ledger-vs-certification tension; weather constant-fill seam
   contract; MOON-ALBEDO-KTX2 encoder install.

### §3 addendum — every decision-queue item is SPENT (added 2026-08-09, handover audit FIX 8)

The blocking decisions above were ruled on 2026-08-10 and recorded verbatim, with every
alternative preserved and a revisit trigger per option, in
[`MAINTAINER_RULINGS_2026-08-10.md`](MAINTAINER_RULINGS_2026-08-10.md). **Do not re-file any
of them.** (Dating: the rulings landed 2026-08-08 per `git log`; the `2026-08-10` label is
retained for ruling-ID stability — order by batch number.)

| §3 item | Ruling | What was ruled | Landed |
| --- | --- | --- | --- |
| 1. C12-29 scope vs. the C12 exit gate | `R-2026-08-10-1` | **Option B, maximal gate** — C12 stays open until every C12-29 slice lands **including S3**, canonically owned by `C13-41`. Consequence: `C13-41` is the **C14 critical path**. | Batch 957 stamp in the C12 queue |
| 2. C13-16 carve-before-erosion pair sign-off | `R-2026-08-10-7` | **Signed off**, with CIRRUS carried as the named residual; W3 rows may build on the pair. | Batch 957 |
| 3. Defer C12-26 (airglow) + C12-32 (shared ephemeris) out of C12 closure | `R-2026-08-10-7` | **Adopted.** C12-26 defers out as its own future row; **C12-32 defers INTO C14 W1** (not W0 as written here) — rider stamped in `OCEAN_DYNAMICS_PLAN_2026-07-24.md` §5. | Batch 957 |
| 4. C13-11 STBN provenance | `R-2026-08-10-5` | **Option A — generate our own**, in-repo void-and-cluster/simulated-annealing generator with hash-pinned output + Fourier validation. Part 1 LANDED Batch 961 (`b288bfc7bb`); Part 2 (cloud consumption) is a named open row. | B961 |
| 5. `PROBE-FLEET-EXIT3-CONTRACT-ADOPTION` | `R-2026-08-10-7` | **Adopted fleet-wide:** STRUCTURAL exits are **yellow**, each carrying a named reason; any structural line older than **30 batches** (first-pass number, revisable) escalates to the maintainer queue. | Batch 957 |
| 6. Celestial Light Transport epic | `R-2026-08-10-7` | **CLT renumbers to proposed Campaign 17** (C16 = Comment Remediation). Still **PROPOSED, not launched**; the §2 bug list stays dispatchable under Lanes F/G. | Batch 957 |
| 7. Lower-stakes recorded items | mixed | The star-map arm is `R-2026-08-10-4` (**4096/face re-bake + G3 re-run ordered, NOT YET EXECUTED**); the §5 limb band is `R-2026-08-10-2` (re-ratified **disc-only**, condition discharged at Batch 962/CO-35); WebGL sun-bloom parity is `R-2026-08-10-3` (**mirror it** — `C12-34`, landed Batch 967). The remaining items in this bullet are still open and stay in their owning queues. | B962/B967 |

**Not covered by the ruling set and still open** (surfaced by the 2026-08-09 handover audit as
maintainer asks, not doc edits): the quiet-hours history question; **CLT-D10 (shell-extent
canonicity), which blocks C12's gate G1 while its owning campaign C17 is unlaunched**; the
in/out-of-gate calls owed on `C11-79` and `C12-31` FOLLOWUP-A/B/C; and branch/stash inventory.

### §3b addendum — executed CO assignments (added 2026-08-09, handover audit FIX 8)

`CO-*` labels are stamped through four campaign queues and `DEFERRED_WORK.md` with no index
anywhere, so a successor reading "CO-24" in a C12 row had no way to resolve it. This table is
built from commit subjects (`git log`), which carry the label verbatim. **Note the numbering
drifted:** this plan's Lane-A/B labels `CO-4`…`CO-8` were never used as commit labels — the
work landed under later CO numbers, mapped below.

| CO | Batch | Hash | What landed |
| --- | --- | --- | --- |
| CO-1 | 901 | `123d809d25` | Docs-drift reconciliation — 19 items verified against git/HEAD, `C11-214` minted |
| CO-2 | 903 | `d9a8e39eeb` | C11 W1 falsifiability tooling (`C11-132`/`134`/`140`/`146`) — label defined in Lane A, not in the subject |
| CO-3 | 904 | `c810dbace2` | C12 gate instruments: PRE-DR01 star re-scope + **G2 lane construction** |
| CO-4 | — | — | **Never defined** — this plan's Lane B skips from CO-3 to CO-5 |
| CO-5 | → CO-24 | — | G3 lane construction; executed under label **CO-24** |
| CO-6 | 906 / 937 | `ca964bc1da` / `794ece043a` | Sun cluster: `C12-18` (B906) then `C12-19` (B937, landed under label **CO-26**) |
| CO-7 | → CO-22 | — | `C12-28` + `C12-12`; executed under label **CO-22** |
| CO-8 | → CO-27 | — | G4 lane construction; executed under label **CO-27** |
| CO-9 | 907 | `ec2c6e9801` | `C13-02` observability counters + the `C13-41` acceptance probe finally EXISTS |
| CO-10 | 909 | `1970806a59` | Eclipse deck 2.937 was an isolation artefact; ambient mechanism REFUTED |
| CO-11 | 912 | `8419471a33` | Aerial addend real and dimmed; the deck's own Reinhard swallows the eclipse dim |
| CO-12 | 914 | `6e9c997287` | WebGPU collection picking dispatched by nothing + the three lanes that arm G8 |
| CO-13 | 913 | `a4bf558f1b` | `nightIntensity` sentinel collision fixed; terminator-law probe ships |
| CO-14 | 917 | `b1cea3e371` | B914's broken shape fixed; the real pick blocker was a B739 pipeline-key mismatch |
| CO-15 | 920 | `679cbf5173` | WebGPU day/night term reads a real per-fragment analytic geocentric normal |
| CO-16 | 923 | `f443ee71db` | Both filed pick candidates REFUTED with file:line; SHAPE fix closes three defects |
| CO-17 | 922 | `be6b477f04` | Shadow band does not move; the tonemap entry closes NEGATIVE, ruling ask withdrawn |
| CO-18 | 927 | `3d1c397af4` | Day/night ramp law RECONCILED; the ×0.30 derived in closed form |
| CO-19 | 925 | `3e8f265659` | Eclipse fifth-run discriminator legs — two verdict shapes differing by one predicate |
| CO-20 | 928 | `5aec156b93` | Five probe-hygiene fleet sweeps; ratcheted watchdog allowlist |
| CO-21 | 930 | `016ed5d5dc` | The ×0.44 is NOT attributable from run 5; settled-twin control makes run 6 the discriminator |
| CO-22 | 932 | `0736c12f08` | `C12-28` HDR defaults + `C12-12` skybox VRAM policy (this plan's CO-7) |
| CO-23 | 935 | `3cb301e32d` | `C13-09` reconstruction attachments as honest scaffolding, SHA-256 pin on the march module |
| CO-24 | 933 | `4f6d3c9751` | **G3's first browser lane ever** (this plan's CO-5) |
| CO-25 | 939 | `f02d1cc3c0` | `C13-10` first slice — march emission variant |
| CO-26 | 937 | `794ece043a` | `C12-19` true HDR sun radiance as a DERIVED linear scale |
| CO-27 | 938 | `786d115487` | **G4 gate lane** — the last missing C12 lane (this plan's CO-8) |
| CO-28 | 945 | `4b933d57c2` | The five G4 fixes; the aim defect root-caused to `Camera.setView` gimbal-lock azimuth swap |
| CO-29 | 943 | `fdf04d59c9` | `C13-10` consume-legs probe with the interleaved A/B protocol built in |
| CO-30 | 947 | `33061e84ea` | The NaN black rectangle — B946's filing refuted, real B937 regression fixed at the builtin |
| CO-31 | 949 | `58f6cb25cb` | Two G4 follow-ups; earthshine census moved to rank with 250× mutant margin |
| CO-32 | 952 | `a1d73aeb5f` | Refresh-skip unification — one mechanism, three prior verdicts corrected |
| CO-33 | 954 | `cb8d1acbdd` | Pixel-inertness instrument: tri-state identity + in-run-calibrated tolerance bands |
| CO-34 | 960 | `21b7bb6354` | **`C16-00`** — comment standard, marker guard with warn-to-strict ratchet, comment-only-diff verifier |
| CO-35 | 962 | `99e6e0d5c0` | R-2's condition discharged; §5 band re-ratified **disc-only** at [0.5124, 0.5874] |
| CO-36 | 961 | `b288bfc7bb` | **`C13-11` part 1** — the in-repo STBN generator, certified against published spectra |
| CO-37 | 967 | `68bf6e78d4` | **`C12-34`** WebGPU sun-bloom mirror + the `C12-34`→`C12-36` renumber |
| CO-38 | 963 | `94d48e5132` | **`C16-01`** — 20 licence determinations, packaging defect fixed, 246 citation lines |
| CO-39 | 972 | `1d976e654f` | **`UX-01`** — viewer starts upstream-shaped, WebGPU default, fork chrome behind `?devUi=true` |
| CO-40 | 973 | `50b1b0aef8` | **`DOC-01`** — README overhaul, 39-row honest feature table, manifest-driven screenshots |

## 4. Process contract (unchanged, restated for workers)

Workers implement in orchestrator-created worktrees and **never run git
writes** (no commit/stash/checkout/restore — negative controls use file
copies). Binding gates per batch: offline `tsc --project
packages/engine/tsconfig.json --noEmit` (non-TS2307 = 0), `npx prettier
--check`, eslint **one file per invocation**, `node --test` on touched specs,
naga validation for WGSL. One Edge at a time, 5-minute watchdogs, probes
follow the pinning doctrine (`lib/weather-probe-pinning.mjs` shape: offline
globe, pinned clock, same-task capture, exit 0/1/2/3, watchdog + finally).
Every landed batch updates its queue-ledger row in the same commit.
~~Landed commits push as `kurtyoung-dev`.~~ **CORRECTED 2026-08-09 (handover audit FIX 8) —
author identity and push authentication are deliberately DIFFERENT things, and this line
conflated them.** **Commit author:** the dedicated agent identity
`cesium-webgpu-agent <cesium-webgpu-agent@users.noreply.github.com>`, in force since
Batch 977 (`a36672d50c`) and attested in [`AUTOMATION.md`](../AUTOMATION.md) policy 1 — do
not "fix" it back to a personal identity. **Push authentication:** the active `gh` account
must be **`kurtyoung-dev`**; a 403 on push means the wrong `gh` account is active
(`gh auth switch`), not a permission loss. `AUTOMATION.md` policy 2 also restates the
quiet-hours window as a machine-enforced policy.
