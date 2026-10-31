# Maintainer rulings, 2026-10-22 (cloud + water landing program)

Seat: Gandalf. Each ruling answers a maintainer question (MQ-C*) in
`cloud-cartography/CLOUD_WATER_LANDING_PLAN_2026-10-21.md` or a decision the seat raised. The maintainer's words are
quoted where they add a condition. These rulings govern every lane of the program; a brief cites them by id. A tracked
copy belongs in `migration_doc/MAINTAINER_RULINGS_2026-10-22.md` in the first docs batch of the program.

| id | subject | ruling |
|---|---|---|
| R-2026-10-22-1 | landing order (Decision 1) | WATER FIRST: fold the two unprefixed water commits into Batch 1586 (same tree), land the reviewed water batch, then land the cloud core R3 tuple on top via the authors' worktree-overlay form, verified by the seat's own hash check of the 13 landed blobs against the authors' freeze (the Araman re-check stands in for their verifier). |
| R-2026-10-22-2 | define registry pre-claim (MQ-C6) | Option A with a condition: "make sure the words and bits actually get well organized. Nothing relies on this tech yet so we are free to change it currently, we just need the end result to be organized and fairly future proof." The core landing lane proposes a documented layout (lo word untouched; hi word and the new third word partitioned into named ranges per subsystem with owners; source ids likewise), applies it in the re-freeze, pins it with a spec, and shows the table in the packet. A reserved bit with no consumer may be renumbered before first use. |
| R-2026-10-22-3 | default moves (MQ-C7) | Option A plus performance: a default move lands as a default only when the three Edge cells (orbital full disc, flight, ground) complete base vs tip with same-build repeat controls, no new device error or loss and "no worse than base" on the contact sheet, AND a multi-metric performance leg (frame-time distribution, per-pass GPU cost, startup and shader-compile time against the under-2-second requirement, GPU memory) reads no worse than base within pre-registered bands. Otherwise the unit lands re-cut behind a default-off dial. "not only prove things work but prove they are performant before being defaulted on." |
| R-2026-10-22-4 | public surface (MQ-C8) | A and B: a whitelisted core set of user-facing dials lands on the public cloud volumetrics object with JSDoc and "WebGPU only"; everything else lands under an explicit experimental namespace tagged "may change without notice" with a release note; no new barrel exports in this program (3454 and 3552 re-cut without the build-script change); numeric sample-count dials are experimental until a quality-budget mechanism lands. The seat proposes the split per wave. |
| R-2026-10-22-5 | data and binaries (MQ-C9, MQ-C16, MQ-C3) | Option A, provenance or it does not ship: the 12 MB ISCCP JSON is not tracked (on-demand fetch into a gitignored cache, pinned sha256, licence recorded; the h5wasm tarball download replaced by the pinned npm dependency or a licence-checked vendored file); the water binaries are tracked only with a reproducible builder pinning source URLs and hashes plus a licence note per source; the 19.5 MB sky-box JPEGs are split out of 1586 into their own batch that pushes only after source and licence are confirmed; no identity in any fetch. Roadmap note: a lightweight local data set for offline use is wanted later. |
| R-2026-10-22-6 | WebGL fallback (MQ-C10) | Option A: 3490 is re-cut into WebGPU-only 3490a (lands in its wave) and WebGL 3490b; 3490b and the WebGL hunks of 3494/3534/3553 go to the single WebGL owner lane with WebGL capture-and-diff baselines on the three cells and WebGL frame timing; the parity gap is recorded in DEFERRED_WORK and FEATURE_INVENTORY §C until that lane lands. |
| R-2026-10-22-7 | audit documents (MQ-C4) | Option A: the five audit docs stay in Batch 1586 and are indexed in `migration_doc/README.md` as dated snapshots by the water batch; Argon's cloud audit `CLOUD_DEEP_DIVE_AUDIT_AND_REMEDIATION_2026-10-19.md` lands the same way, marked as a snapshot whose causal claims are the author's. |
| R-2026-10-22-8 | seat-owned files (R-7, package.json, guide) | Option A: lanes supply shared-file changes as data (runner tokens, seatbelt rows to drop with proof ESLint is green without them, guide paragraphs); the seat writes `package.json` (the hot `test-cloud-c13` line rewritten once per wave from the wave's union), `eslint.seatbelt.tsv` (shrink-only, each drop re-verified on the landed tree) and the guide appends at landing. |
| R-2026-10-22-9 | agent-doc section 10 (MQ-C15) | Option A: the water batch leaves `AGENTS.md`/`GEMINI.md` untouched; a separate governance batch adopts the prompt-injection-defence rule once (CLAUDE.md as authority, mirrors in AGENTS.md and GEMINI.md) and reconciles the provisioner-injected section to the same text; the maintainer reviews the wording. |
| R-2026-10-22-10 | author roles (MQ-C17) | Option B: the seat's lanes (Opus leads, Sonnet workers) own all fixes and regenerate units from the frozen patches; no Codex regeneration handoffs ("lets just fix the issues"); Sol or Argon may be used as workers only where useful (Gemini is out of usage; the Codex MCP is not reachable from the seat session). |
| R-2026-10-22-11 | governing rulings (MQ-C1) | Option A: the 2026-10-21 directive supersedes R-2026-09-26-8 and closes the 10-08 MQ-A1/MQ-A2 for this program; the object is the 122-unit stack on the current tip, the old frozen stack and the 09-27 chain are archived; R-4, R-6, R-7, R-1/F-14, R-10, R-11 and D9c keep governing; R-12's slot rule is restated for the 196-float cloud layout with the same intent. |
| R-2026-10-22-12 | test contracts (MQ-C11) | Option A: a stale source-shape assertion in 3463/3464/3470 may be replaced only by a behaviour contract written by the seat's reviewer lane; an inertness mutant must kill it; numeric budget checks are never waived; the old assertion stays until its replacement is green in the same batch. |
| R-2026-10-22-13 | unit 3528 (MQ-C12) | Option A, split: the comment-guard cleanup and grandfather-pair removal land as a small seat batch before W8b; the global texture-retirement reroute in `WebGPUContext.ts` lands only with a dedicated device-loss Edge leg (three cells plus the texture-lifetime resize/swap rig, same-build repeats, device-loss gate 0 before and after). |
| R-2026-10-22-14 | unit 3462 (MQ-C13) | Option A: re-cut so the sky LUT invalidation and the new bake-ready condition apply only while volumetric clouds are active; with clouds off the sky path is byte-identical to base, proven by a sky-only scene cell vs base in that wave. |
| R-2026-10-22-15 | red runners (MQ-C14) | Option A: no wave lands a red runner; every touched runner runs at base and tip; a spec a wave registers is green on the landed tree or fixed in the wave; a move into `test-cloud-c13-quarantine` only by maintainer ruling, per spec, recorded in the ledger and named in the packet; the quarantine runner runs in CI but is not a landing gate. |
| (MQ-C5) | freeze Argon | Resolved by the maintainer closing the Antigravity session on 2026-10-22 00:0x EDT ("Argon is done editing until we can get things into main"); the live set is banked under `argon-water-snapshot/` and applied in `cesium-lane-taniquetil-20261021`. |

Earlier decisions the same night: the maintainer also ruled that the seat takes the seat back from Argon and that everything
fully reviewed and tested is to be committed and landed ("If everything is solid lets commit and land"). Quiet hours
(weekday 07:00-19:00 ET) still govern commits and pushes unless lifted per day.

## Rulings of 2026-10-23/24

*(Appended 2026-10-24 by the records batch after the landings of Batches 1585-1594.)* The maintainer rulings
R-2026-10-23-M1..M4 below are copied verbatim from the program's archive file
(`cesium-webgpu-worker-archive/lanes-2026-10-21/MAINTAINER_RULINGS_2026-10-22.md`, lines 31-57; its lines 1-29 are this file's lines 1-29); the only
change is the heading level, one step down so the sections sit under this one. The seat rulings that follow are
one line each with their source; the archive file and the banked seat notes remain the text of record.

### Addendum 2026-10-23 (maintainer, ~08:5x EDT)

| id | ruling (maintainer's words quoted where given) | effect |
|---|---|---|
| R-2026-10-23-M1 | "For the levels lets go with the recommendation." = the seat's proof-bar recommendation: opt-in cloud waves carry ONE wave-group Edge job (the wave-end gate of R-2026-08-29-2) instead of a per-batch Edge leg; the full E11 (three cells + the multi-metric performance leg, R-2026-10-22-3) is reserved for DEFAULT moves. Node specs, inertness mutants and the adversarial Opus review stay per batch. | The Edge slot stops pacing the cloud waves; per-batch Edge legs in the plan's wave rows collapse into one job per wave group. |
| R-2026-10-23-M2 | "Feel free to use the Codex or Antigravity APIs/CLIs however you'd like or need to help stretch usage and capacity." | Supersedes R-2026-10-22-10's "seat lanes own all fixes" to the extent that Codex (Sol) and Antigravity (Gemini) may run BOUNDED lanes as tier-3 workers in their own clones, under the standing rules: Opus reviewer behind every batch, never the seat, never Edge, never git writes, no builds during an announced Edge job, never the maintainer's identity in any request. The seat (Fable) remains the only landing authority. |

### R-2026-10-23-M3 (maintainer, 2026-10-23 23:1x EDT, quoted): "Lets go with the recommendation: (a) Land tonight with the residual recorded and a follow-up lane to measure at ten runs and evaluate code-splitting the water modules."
- The water landing (round 9 cut: 1585 tree 1b57bfbc, 1586 tree 9e6bcfb7; Edge round 5 Calenhad HOLDS) lands tonight.
- The PF-3 WebGL startup residual (round 2 +6..13 %, round 4 +234.9 ms, round 5 +198.0 ms p=0.345 on E-D; E-H +67.4 ms; the two attributions
  finding no cut-side JavaScript) is recorded as NEW-WATER-STARTUP-COST in the ledger with its data.
- Follow-up lane: measure PF-3 at TEN interleaved runs on a quiet machine (BEFORE vs the landed tip) and evaluate code-splitting the water
  modules (lazy import of the water classification / bathymetry / facade modules) as the remedy if the residual is real.
- Opt-in residuals recorded, not gates: NEW-WATER-COAST-PARITY-RESIDUAL (2a 2.30 % vs 1.0 %), the great-lakes WebGPU black-frame candidate
  (1 of 4 pages), the E-T teardown proof open until F-4 lands in the same wave.

### R-2026-10-23-M4 (maintainer, 2026-10-23 23:4x EDT, quoted): "Let Codex continue on its original branch for new cloud work while the seat re-lands the stack with Opus leads. Faster for Codex today, but every new unit lands on a stale registry and adds to the re-base bill. Landing is taking forever and if we are going to do it piece by piece we might as well let Codex continue to work"
- Codex (Astra) works in its own workspace/branch (`cesium-astra-20260926` lineage) on NEW cloud work; the seat does not dispatch Codex onto
  the landing waves any more. The seat re-lands the banked 138-unit stack wave by wave (W2..W12) with Opus leads, Sonnet gate runners and
  Opus reviewers, per the plan.
- The re-base bill is accepted: new Codex units written against the pre-W1 registry are re-generated by the seat's waves later (the same
  cartography + regeneration method as W2 round 1).
- Coordination that stays: one build at a time on the machine and no builds during a seat Edge job (R-M2); the seat announces its builds and
  Edge jobs to Codex through the output-folder note; Codex's packet folder stays read-only to the seat.
- The candidate clone `cesium-codex-cloud-20261023` (water r9 + W0 + W1 + Codex's W2 round-1 regeneration) becomes the seat's W2 lane clone
  (Opus lead Mirrormere, reviewer Himling); Codex's round-1 work there is the lead's starting point, credited in the packet.


### Seat rulings S1-S11 (seat, 2026-10-22 to 2026-10-24)

Where a source below is under the gitignored `Tools/visual-regression/output/wave-end/`, its durable copy is named next to
it; `seat-scratchpad/` there is `cesium-webgpu-worker-archive/lanes-2026-10-21/seat-scratchpad/`, where the seat's
`SEAT_RULINGS_R2.md` and `SEAT_RULINGS_R3.md` are banked as `SEAT_RULINGS_R2-20261023.md` and `SEAT_RULINGS_R3-20261023.md`
with the same line numbers. The round-1 verifier file has no durable copy.

| id | ruling, in one sentence | source |
|---|---|---|
| R-2026-10-22-S1 | Round 1's leg-1 cells 1a/1b/1e read NOT RUN, not PASS, because the historical gates were NON_CERTIFYING; it rules on the round-1 verifier's B3. | finding: `Tools/visual-regression/output/wave-end/water-landing/VERIFY_CALENHAD.md:41`; ruling: `cesium-webgpu-worker-archive/lanes-2026-10-21/seat-scratchpad/SEAT_RULINGS_S1_20261022.md:7` (banked 2026-10-24 from the seat's record) |
| R-2026-10-22-S2 | For capture-and-diff legs, which emit no `servedBuildAssertion`, the executor's served-build preflight is admitted as the substitute when every artifact matches within 15 s of launch and the md5s equal the seat instructions, and the receipt names it. | first ruled 2026-10-22: `cesium-webgpu-worker-archive/lanes-2026-10-21/seat-scratchpad/SEAT_RULINGS_S1_20261022.md:7`; restated 2026-10-23: `seat-scratchpad/SEAT_NOTE_NIMRAIS_R2_20261023.md:26-28`; met in round 2: `Tools/visual-regression/output/wave-end/water-landing-r2/SEAT_RULINGS_R2.md:6-8` (durable `seat-scratchpad/SEAT_RULINGS_R2-20261023.md:6-8`) |
| R-2026-10-22-S3 | The E11 pixel band is changedPx <= 2 x the larger same-build repeat floor for a WebGL arm and 0 for a WebGPU arm. | first ruled 2026-10-22 (WebGL arms, from round 2 on, not retroactive): `cesium-webgpu-worker-archive/lanes-2026-10-21/seat-scratchpad/SEAT_RULINGS_S1_20261022.md:7`; restated 2026-10-23: `seat-scratchpad/SEAT_NOTE_NIMRAIS_R2_20261023.md:29` |
| R-2026-10-22-S4 | The E-H WebGPU cells are UNMEASURED for the water landing because the base render is bistable (F-2); they are run and banked as base-bug evidence, not gates. | `cesium-webgpu-worker-archive/lanes-2026-10-21/seat-scratchpad/brief-edge-water-rerun.md:43-45`; `SEAT_NOTE_NIMRAIS_R2_20261023.md:30`; restated `Tools/visual-regression/output/wave-end/water-landing-r2/SEAT_RULINGS_R2.md:16` (durable `seat-scratchpad/SEAT_RULINGS_R2-20261023.md:16`) |
| S5 (bare id in its source) | Where a pass-1 run carried CPU samples above 60 %, the declared repeat pass governs (E-D-HDR PF-1/PF-3 read PASS on it), and the next pre-registration adds a sample-based contention clause (10 consecutive samples above 60 %). | `Tools/visual-regression/output/wave-end/water-landing-r2/SEAT_RULINGS_R2.md:9-12` (durable `seat-scratchpad/SEAT_RULINGS_R2-20261023.md:9-12`) |
| S6 (bare id in its source) | The orbit-disc cell 2c effect-area floor becomes 2 % (was 5 %) from the next pre-registration, not retroactively. | `Tools/visual-regression/output/wave-end/water-landing-r2/SEAT_RULINGS_R2.md:13-15` (durable `seat-scratchpad/SEAT_RULINGS_R2-20261023.md:13-15`) |
| D-1 (unnumbered admission) | A seat Karma rebuild of `Build/` from the same write-tree is admitted: under this program the tree id is the identity and served == disk is what certifies, since bundle md5s do not reproduce across rebuilds. | `Tools/visual-regression/output/wave-end/water-landing-r2/SEAT_RULINGS_R2.md:6-8` (durable `seat-scratchpad/SEAT_RULINGS_R2-20261023.md:6-8`); carried over `Tools/visual-regression/output/wave-end/water-landing-r3/SEAT_RULINGS_R3.md:6-7` (durable `seat-scratchpad/SEAT_RULINGS_R3-20261023.md:6-7`) |
| R-2026-10-23-S7 | Superseded by S8: keep round 5's default-arm wave law and update the C11-158 Karma spec to the corrected invariant. | `Tools/visual-regression/output/wave-end/water-landing-r3/SEAT_RULINGS_R3.md:15-24` (durable `seat-scratchpad/SEAT_RULINGS_R3-20261023.md:15-24`) |
| R-2026-10-23-S8 | No default move lands with the water: the three water-parity-r5 blocks go behind a provider-gated hi define bit, the default and ENHANCED_OCEAN variants return to base bytes, the C11-158 spec stays unchanged, and the default-ocean parity move is recorded as NEW-WATER-DEFAULT-OCEAN-PARITY. | `Tools/visual-regression/output/wave-end/water-landing-r3/SEAT_RULINGS_R3.md:27-33` (durable `seat-scratchpad/SEAT_RULINGS_R3-20261023.md:27-33`) |
| R-2026-10-23-S9 | The eager module-scope bathymetry survey tables (about 0.6 ms of module evaluation, disclosed in the packet) are accepted as they are; no lazy wrapping is ordered. | `cesium-webgpu-worker-archive/lanes-2026-10-21/water-review/_lane-out-20261023-1920-r8-REFUTED-B1-karma/SEAT_RULINGS_R7.md:3-4` |
| R-2026-10-23-S10 | Cell 3a runs from the probe tree that carries KT-2's `lib/sandcastle2-demo-capture.mjs`, with the sheet's rig declared as an untracked data file for the run and removed afterwards. | `cesium-webgpu-worker-archive/lanes-2026-10-21/water-review/_lane-out-20261023-1920-r8-REFUTED-B1-karma/SEAT_RULINGS_R7.md:5-7` |
| (unnumbered, after review pass 7) | Review B1 is not ruled acceptable: the enhanced-ocean path receives the facade's defaults without a `globe.water` read; the build-dependent gates and Karma run on the AFTER build of the round-8 tree. | `cesium-webgpu-worker-archive/lanes-2026-10-21/water-review/_lane-out-20261023-1920-r8-REFUTED-B1-karma/SEAT_RULINGS_R7.md:8-11` |
| (unnumbered, after review pass 8) | B1 is fixed by guarding both `Scene.js` call sites with `globe._bindWaterFacade?.(this, GlobeWater)` (not by changing spec fixtures), and the gate is the FULL Karma suite run to completion on the seat's AFTER build of the round-9 tree. | `cesium-webgpu-worker-archive/lanes-2026-10-21/water-review/_lane-out-20261023-1920-r8-REFUTED-B1-karma/SEAT_RULINGS_R7.md:13-17` |
| R-2026-10-24-S11 | The W1 layout-spec fixture repair lands as a seat-owned spec batch right after W1, not inside W2's delta (landed as Batch 1594). | `cesium-webgpu-worker-archive/lanes-2026-10-21/MAINTAINER_RULINGS_2026-10-22.md:58-64` |

## Rulings of 2026-10-24 to 2026-10-30

*(Appended 2026-10-30 by the records batch after the landings of Batches 1596-1607.)* The heading of R-2026-10-24-M5
below is copied verbatim from the program's archive file
(`cesium-webgpu-worker-archive/lanes-2026-10-21/MAINTAINER_RULINGS_2026-10-22.md`, line 66), one heading level down; the
paragraph under it is the seat's reading, condensed from the five levers on that file's lines 68-74. The seat rulings
S12-S18 follow, one line each with their source. S12 is the id the 2026-10-24 records batch already cites; S13-S18 are
numbered by the seat's records order, and the sources of S13-S16 carry no id. The archive file and the banked lane files
remain the text of record. *(Round 2 of the records batch, after Batch 1622, adds S17 and S18 and the pointer to the seat's
open decisions list.)*

### R-2026-10-24-M5 (maintainer, 2026-10-24 ~10:1x EDT, quoted): "This sounds like a really good start, are there any risks to this?" [on lever 1: one full lane round per wave with a scout phase, per-unit review and a two-repair cap] ... "Lets run it, we can always come back after we get everything landed and run more tests on the whole product instead of mass testing small individual changes"

Seat reading (Gandalf), applied from W3 on: each wave gets ONE lane round (a Sonnet scout, an Opus lead with the full
obligation list and tier-3 fan-out, Sonnet gate runners and an Opus review per unit tip), with at most two repair rounds
before the wave falls back to small rounds; the next wave's scout and lead phases overlap the current wave's Edge job and
landings, and only test-runner phases wait for the Edge slot (from W4 on, waves merge pairwise for one Edge job each);
each wave's Edge job is an IDENTITY job (the identity cells, E-T and E-W) whose CPU launch guard is soft, so it may run
beside a lane, while the per-change PF performance legs move to a whole-product performance campaign after W12 (or
earlier on suspicion) and each wave records them as PF-debt rows, so a default move lands as a default on identity proof
with its PF debt recorded (this amends R-2026-10-22-3 and R-2026-10-23-M1 in practice); and the intermediate batches of
a verified cut land LIGHT (hooks, catalog and doc verifiers only), the lane's per-tip gates being the proof of record,
with the full runner set on the wave's last engine batch. Lever 4 also named "the W2 F2 run (in flight) as the last per-wave
PF leg and the baseline" (the archive file, line 72); that run's PF leg never launched (the CPU guard could not be satisfied
beside the overlapped lanes, and the job was stopped and refuted on its identity cells), so neither W2 nor W3 has a PF
baseline (`DEFERRED_WORK.md` `NEW-CLOUD-W2-PF-DEBT`). Source: the archive file, lines 68-74. The soft guard as run:
`Tools/visual-regression/output/wave-end/w2-r7-identity/SUMMARY_Nimrais.txt:36` ("per the sheet the identity cells launch
when it times out"; gitignored, no durable copy) and `VERIFY_CALIMEHTAR.md:45` of the W3 identity job, durable in
`cesium-webgpu-worker-archive/lanes-2026-10-21/w3-cloud/edge-identity-20261029/`.

### Seat rulings S12-S18 (seat, 2026-10-24 to 2026-10-30)

| id | ruling, in one sentence | source |
|---|---|---|
| R-2026-10-24-S12 | `CAMPAIGN_STATE.md` carries the cloud + water re-landing program as one campaign-level section, and its C13 held-wave paragraph is corrected to R-2026-10-22-11 and R-2026-10-23-M4; this landed in Batch 1595 (`c7c7bc6d35`), and later records batches update that section in place. | ordered: `cesium-webgpu-worker-archive/lanes-2026-10-21/records-20261024/_lane-out-r2-seat-fixed-c702d88d/LANDING_PACKET_OVERHILL.md:142`, `:251-263`; landed: `CAMPAIGN_STATE.md:272` and its section "Cloud + water re-landing (W-waves)"; the 2026-10-24 review's note that the rulings table stopped at S11: `.../REVIEW_TARLANG_P2.md:154` |
| S13 | The context spine's contract and hazard output is a scoping lead and never a gate, and its `DIRECT_HIGH_PLUS_LOW_HAZARD` rule is retuned, not retired, so that a High+Low sum is a hazard only where it is the argument of an `mvp` / `modelViewProjection` / `viewProjection` `* vec4(...)` projection in shader source (landed in Batch 1606: 0 hazards and 51 review rows at `c7c7bc6d35`). | ruling: `F:/Dev/GH/cesium-lane-gemini-wip-20261029/_lane-out/LANDING_PACKET_GWIP.md:123-125` (round 2); the retune: `:152-156`; review: `REVIEW_NORA_P3.md:1` (same folder; HOLDS on round 3, which carries the retune; pass 2 was REFUTED, narrowly, on a guide sentence, though it found "The retune is correct against the corpus", `REVIEW_NORA_P2.md:1`); the guide paragraph as landed: `CONTEXT_SPINE_GUIDE.md:156` |
| S14 | W2 lands with unit 3450 as cut (the round-7 cut, landed as Batch 1599, `b6a18cc088`), its orbital seam and sky hatching recorded as ledger rows, and the orbital air-light anchor left to the maintainer, because the round-8 fix was refuted. | `cesium-webgpu-worker-archive/lanes-2026-10-21/w2-cloud/_lane-out-20261026-1505-r8-REFUTED-0c30e855/REVIEW_HIMLING_P7.md:1` ("Seat: land the round-7 cut tonight, as the brief's fallback says"), B1/B2 `:72-119`; the batch message as landed: `.../w2-cloud/cut-r7-landing-20261026/msg-w2-batch4.txt:56-72`; decision D1: `cesium-webgpu-worker-archive/lanes-2026-10-29/DECISIONS_FOR_MAINTAINER_2026-10-29.md:45-50`; rows: `DEFERRED_WORK.md` section "2026-10-30 — records batch 3" |
| S15 | Foreign agent work found uncommitted in the seat worktree is harvested byte-exactly to the worker archive (a binary diff of the modified tracked paths, a tar of the untracked ones and their md5 sums), the seat is then cleaned by positive list, and the work continues in a lane clone and is audited there; only the seat lands on main. | `cesium-webgpu-worker-archive/lanes-2026-10-29/gemini-wip-seat-transplant/MANIFEST.txt:1-3` (with `MD5SUMS` in the same folder); recommendation A1 to the maintainer: `lanes-2026-10-29/DECISIONS_FOR_MAINTAINER_2026-10-29.md:7-9`; applied to the Antigravity session of 2026-10-29, landed as Batches 1606-1607 (their "Provenance" lines) |
| S16 | Under R-2026-10-22-6, W3 unit 3463 wiring `lighting.enableSunLight` for the WebGPU-only volumetric deck is an admissible route, because WebGL has no volumetric deck and default-to-parity is vacuous there; the seat confirms the route pending the maintainer's ratification (unit 3463 landed as Batch 1613, `86fee24dd2`, on 2026-10-30; the ratification is still open). | the seat's confirmation: `cesium-webgpu-worker-archive/lanes-2026-10-21/seat-scratchpad/brief-records-batch-3.md:38-40` (item 1, S16) and `.../seat-scratchpad/LANDING_NIGHT_2_20261026.md:25`; the lead's seat-item list: `LANDING_PACKET_W3.md:292` and review N-10 `REVIEW_AMROTHOS_P2.md:160`, both in `cesium-webgpu-worker-archive/lanes-2026-10-21/w3-cloud/_lane-out-20261026-1358-r4-HOLDS-30640b4b/` |
| R-2026-10-30-S17 | The Antigravity (Gemini) water program continues in its own lanes untouched: the seat neither redirects nor interrupts it, every finished wave gets a read-only Opus review, and nothing lands except through the seat after review and the maintainer's word (by 2026-10-30 the seat had reviewed twelve waves, eleven REWORK and w1c REFUTED, and salvaged the parts the reviewers held into Batches 1616-1623 through its own lanes). | the maintainer's word of 2026-10-30 04:3x EDT, quoted in `cesium-webgpu-worker-archive/lanes-2026-10-30/salvage-night/DECISIONS_FOR_MAINTAINER_2026-10-29.md:69-70` ("I am going to let gemini finish its water improvement waves so keep an eye out for that additional work") with the seat's recording of it; named S17 by the seat's records brief, `.../salvage-night/brief-records-round2-dispatch.md:33`; the program index `lanes-2026-10-30/GEMINI_WATER_PROGRAM_INDEX.md` |
| R-2026-10-30-S18 | A runner red PROVEN pre-existing at the tip (the same failing test ids at HEAD and at HEAD plus the patch, measured in the landing log) does not block a landing: the runner runs minus the named spec file or files (the seat helpers refuse a misspelt name), every application is named in the landing log, and each red is recorded as a row with a fix-forward owner. Applied on 2026-10-30 three times: lane A's landing (Batch 1619) ran `test-visual-regression-node` minus `metrics-cloud-extraction.spec.mjs`, fixed forward the same night by Batch 1620 and the exclusion removed; lane B's landing (Batch 1623) ran `test-build-infra` minus `verify-package-smoke.spec.mjs` and `test-cloud-c13-quarantine` minus `cloud-observability-counters`, `cloud-reconstruction-attachments` and `cloud-shadow-rte` (`runner-minus-known-red.mjs`, seat kit), all red at the bare tip and not fixed that night (rows `DX-VERIFY-PACKAGE-SMOKE-RED-AT-SEAT` and `NEW-W3-QUARANTINE-PINS-STALE`, each with a fix-forward owner). The decision as first written (`:146`) said one named spec and a fix the same night; the general form is the seat's restatement for this record at 23:2x EDT, so the maintainer may overrule either. | `cesium-webgpu-worker-archive/lanes-2026-10-30/salvage-night/DECISIONS_FOR_MAINTAINER_2026-10-29.md:146` (overrule = hold every salvage landing until the fix lands); the landing logs `.../salvage-night/landing-logs/land-salvage-queue-1793406317.log:2` and `land-andustar-4.log:20` (the named-spec exclusion), `land-salvage-queue-1793406317.log:23-27` and `land-andustar-4.log:24-28` (the per-test allowance), and `baseline-runners-tip-9ac404eb46.log` with `baseline-test-build-infra.log` (the reds at the bare tip before lane B); `DEFERRED_WORK.md` `NEW-METRICS-CLOUD-EXTRACTION-ULP-RED`, `DX-VERIFY-PACKAGE-SMOKE-RED-AT-SEAT`, `NEW-W3-QUARANTINE-PINS-STALE` |

The seat's decisions list of 2026-10-29/30 (B9-B49, from the Antigravity water reviews and the salvage lanes; banked as
`cesium-webgpu-worker-archive/lanes-2026-10-30/salvage-night/DECISIONS_FOR_MAINTAINER_2026-10-29.md`) was open for the
maintainer until the rulings of 23:2x EDT below (R-2026-10-30-M1 … -M4). Where the seat resolved an item by a conservative default for the landing night (B33/B36, B37, B38, B39, B40,
B42, B45 and B46; `salvage-night/PLAN_LANDING_NIGHT_2026-10-30.md` and the decisions file), the default is a seat decision the
maintainer may overrule, not a ruling, and none of these items is recorded here as one.

## Maintainer rulings of 2026-10-30 23:2x EDT (R-2026-10-30-M1 … -M4)

*(Appended by records batch 3, round 3.)* The maintainer answered the four groups of open decisions the seat listed at 23:2x
EDT. Each heading quotes the maintainer verbatim; the paragraph under it is the seat's reading. Source for all four: `cesium-webgpu-worker-archive/lanes-2026-10-30/salvage-night/DECISIONS_FOR_MAINTAINER_2026-10-29.md`, section
"Maintainer rulings 2026-10-30 23:2x EDT" (lines 153-157). With these rulings the decisions list of the paragraph above is no
longer simply open: B1-B44 read "open, resolved by the fix list" (M1); E1-E4, D1, C1-C5 and A1-A2 are accepted as the seat
recommended (M2); A1 and the B34/B41 boundary items are resolved in principle (M3); section F stays held (M4).

### R-2026-10-30-M1 (maintainer, 2026-10-30 23:2x EDT, quoted, on the Gemini water program, B1-B44): "There is still work Gemini is finishing up with this but this doesn't mean we can't review, audit, and suggest fixes for it. The goal is to make it as clean as possible so we can land it tomorrow."

Seat reading: no stop-stacking directive. The seat keeps reviewing every finished Antigravity wave read-only (S17 stands),
consolidates the twelve review files into ONE bottom-up fix list per wave with its recommended resolution for each B-item, and
prepares the landing path (rebase order, Edge cells) so that the program lands on Saturday 2026-10-31. Where a review found a
defect on main that the seat owns (B24, landed as Batch 1618; the B43 row), the seat fixes it itself. Decisions B1-B44 read
"open, resolved by the fix list" rather than waiting on a stop-stacking directive.

### R-2026-10-30-M2 (maintainer, 2026-10-30 23:2x EDT, quoted, on the seat-ready batches E1-E4, D1, C1-C5, A1-A2): "Can we fix these issues and land this tech? It feels like we are overthinking things here. The goal is the improved features in master not how broadly we can gate auditing, fixing, and commiting it. We need to work towards landing tech. Also the .md files should just have data pointers to one .md file that has all of the well refined context rules and information so that we are not double or triple loading the same context info."

Seat reading: fix and land. The seat's recommendations are accepted: E1 (accept Principle 13), E2 (not yet), E3 (pin CI to
Node 22.13 or later and add `test-context-spine` to the guards job), E4 (the cpu-profile pieces only with a consumer), D1 (the
physical orbital look with the night-limb guard), C1-C5 as recommended (C5 opt-in now), and A1/A2 as recommended. Gating stays
at the proof bar by change class (R-2026-08-29-1), with no extra rounds. New directive (rules consolidation): the governance
`.md` files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.clinerules` and any per-agent rules file) become pointers to ONE refined
rules file, so the content lives once and no agent loads the same context twice. It is queued as a docs batch (lane Lindorie,
dispatched by the seat on 2026-10-30), and the held context-spine governance batch 3 (E1, Principle 13) folds into it; the one
file is `CLAUDE.md` unless the batch's measurement argues for a neutral name.

### R-2026-10-30-M3 (maintainer, 2026-10-30 23:2x EDT, quoted, on the seat and clones): "Generally if a LLM does not have the seat it should work in a cloned copy, unless I override and say it can. If I decide another LLM can take the seat then the other LLMs just need to live with that and clean things up."

Seat reading: an LLM that does not hold the seat works in a clone unless the maintainer overrides; the maintainer may hand the
seat to another LLM, and the others adapt and clean up. This resolves decision A1 and the B34/B41 boundary items in principle
(`DEFERRED_WORK.md` `DX-SEAT-WORKTREE-FOREIGN-WIP`; seat ruling S15 stays the harvest procedure).

### R-2026-10-30-M4 (maintainer, 2026-10-30 23:2x EDT, quoted, on the housekeeping ASK list): "Hold on these for now, they are not blocking anything."

Seat reading: the ASK list (section F of the decisions file, and the stray `F:/Dev/GH/node_modules`) stays held; nothing is
deleted.
