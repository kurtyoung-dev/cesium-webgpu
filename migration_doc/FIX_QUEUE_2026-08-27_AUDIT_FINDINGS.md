# Fix queue — every finding from the 2026-08-27 audit evening

**Date:** 2026-08-27, quiet hours open
**Source of truth for the findings:** [AUDIT_2026-08-27_SOL_WAVE_AND_PROJECT_SWEEP.md](AUDIT_2026-08-27_SOL_WAVE_AND_PROJECT_SWEEP.md) (Batch 1170) plus the three fleet journals, from which §5's tables are machine-extracted — 97 adversarially-verified survivors (2 critical, 11 high, 30 medium, 54 low), zero reconstructed from memory.
**Tip at authoring:** `41aad98761` (Batch 1172)
**Purpose:** the single dispatch view for turning tonight's findings into landed fixes. Every finding is either IN FLIGHT (a lane owns it now), WAVE 2 (dispatched with this document), or QUEUED (wave 3+, dispatch as lanes free). This document tracks dispatch state only — the audit register keeps the evidence, and the campaign queues stay the status authorities for their rows.

## 0. Worker-shape guidance for dispatchers

Codex Sol 5.6 takes bounded, single-deliverable, spec-verifiable fixes — one finding family per
dispatch. Opus leads take the brief, verify its premises against the live tree first (a queue row
is a lead, not a premise), run the mandated pipeline (Sol writes → a separate fresh Sol dispatch
reviews adversarially → Sol tests → Opus reviews last), and return a landing packet. Workers never
run git writes, browsers, or builds; every rendering-adjacent fix states its pixel verification as
owed to the gated Edge executor. Every fix needs a behavioural test that kills an inertness mutant
(`if (false && …)`), never only an absence mutant.

## 1. Already resolved tonight

| Finding | Resolution |
|---|---|
| `G-1` critical — single-copy work in two clones | HARVESTED to `cesium-webgpu-worker-archive/2026-08-27-critical-single-copy/`; landing owed via lanes A2/A3; clones frozen until then |
| `O-6` — landing gate fails its own semantic controls | LANDED, Batch 1172 (behavioural controls; exit 3 → clean) |
| `O-7` — latent TypeError on the gate's diagnosis path | LANDED, Batch 1172 |
| `I-1`/`I-2` — probe exit tier enforced only by regex; zero-check vacuity | LANDED, Batch 1171 |

## 2. IN FLIGHT — owned by a running lane tonight

| Lane | Findings owned | Clone |
|---|---|---|
| A1 | `M-1`…`M-8` (model wave repair; M-1 fail-closed guard is the verdict driver) | cesium-audit-model |
| A2 | **LANDED, Batch 1184** — option (A) co-fade on both backends, interpreter-based fragment spec (10 mutants), 451 celestial tests green, ruling stamped into the row. Dawn sweep stays the acceptance evidence (Edge executor). Filed: a defensive clamp for negative-channel transmittance, and the disc-emission double-counting question the ruling deferred | done; sweep owed |
| A3 | **LANDED, Batch 1176** — three of four blockers repaired with executed proof (spec 119/119); blocker A (M1 scores frame-presence, not call-rate) stays FILED with its patch banked, gated on the Edge acquire run; the independent review of the repaired state twice produced no findings and the landing records that honestly | done; acquire run owed |
| A4 | **LANDED, Batches 1185/1186** — all four fixes with behavioural suites (11/6/4/7) and killed-mutant tables including the two that previously passed for the wrong reason; the review provenance is the lane lead's adversarial round (three fresh counterexamples: last-committed jitter, same-frame toggle+format, sum-preserving swap) after the worker reviews sank. Four probe plans owed to the Edge executor | done; probes owed |
| B1 | next C16 shard (`WebGPUSceneRendererFrustumLoop.ts` 42 markers + next-heaviest) | cesium-lane-c16shard |
| B2 | **LANDED, Batch 1174** — `D-1`…`D-6` + `G-4` repaired across ten documents; two survivors adjudicated deliberate (the register quotes the phrase as evidence; the C13 queue's narration is vacated by its own row cell) | done |
| B3 | `O-8` three uncontrolled grammar rules · `O-9` detached-HEAD exit | cesium-audit-policy |
| C1 | **CLOSED** — final tally: 5 R-SOL claims confirmed exactly, 2 corrected, 1 refuted, 1 marked do-not-cite; 10 renderer findings CONFIRMED and personally spot-checked, 0 refuted, 4 held single-source pending the R4 lean review now running. Three Sol review dispatches produced 5 verdicts total — the lean-brief pattern is the tested countermeasure | closed |
| D1 | **R9 GO (2026-08-28 ~04:30)** — the design converged through five review rounds (17 → 9 → 3 → 1 → 1-clause), every round's findings verified closed by independent recomputation or execution; closing verification by the orchestrator matched the GO image (doc `a9e70159…`, frozen block `ea017da6…`/18,261/470). ON THE RECORD per the reviewer's pre-commitment: (a) base preregistration §10's fresh-architecture-review requirement is DISCHARGED by the rev2→rev5 series; (b) the 2026-08-27 ruling's two arms — 1,400 per-spec grant, binding 1,340 denial — are correctly propagated end-to-end. Implementation phase UNLOCKED; handoff at `_lane-d1-out/HANDOFF.md` | next work window |
| D2 | **LANDED, Batch 1180** — both tools adversarially reviewed (first round NO-GO with 11 P0s over green specs), repaired, validated against reality (all 8 worker clones correctly NOT DRAINED; both known mirror drifts flagged plus two more). Eleven lint errors and one prettier-orphaned mutation anchor were repaired at landing, disclosed in the commit | done |
| D3 | C14 readiness review · C17 scope refresh (proposals) | cesium-lane-plan |

## 3. WAVE 2 — dispatched with this document

**Lane A5 — renderer-local cache invalidation cluster** (clone `cesium-lane-cachefix`). The defect
class fleet 3 hit twenty-plus times, concentrated in three files; one Sol dispatch per family:

| | Locator | Defect |
|---|---|---|
| A5-1 | `WebGPUGaussianSplatRenderer.ts:1403`, `:3113` | async pipeline promises land unguarded after the invalidation sweep; cold-start legacy-layout promises overwrite the packed commit, 64-byte decode of 32-byte records, no further request ever issued |
| A5-2 | `WebGPUProceduralCloudRenderer.ts:1482`, `:1591` | temporal bind groups keep a destroyed half-res view across an A→B→A resize; the correct identity-compare pattern exists at `:1741` in the same file |
| A5-3 | `WebGPUModelRenderer.ts:3964`, `:3361`, `:3388` | customShader add/swap never invalidates the primitive cache (new shader silently never compiles); removal destroys a UBO still referenced at binding 50 |
| A5-4 | `WebGPUModelRenderer.ts:3245` | display pipeline maps keyed without generated-chunk class hashes — two primitives with different metadata classes share one pipeline |
| A5-5 | `WebGPUModelRenderer.ts:5039` | per-geometry camera UB created once at 176 or 336 bytes from `isLit`, never resized — a flat→lit shader flip writes 336 bytes into a 176-byte buffer |

**Lane A6 — elevation-material height derivation** (clone `cesium-lane-elev`): `F1-3` — six
`PrimitiveMatElev{Ramp,Band,Contour}{Flat,Lit}.wgsl` shaders subtract a hardcoded mean-sphere
`EARTH_RADIUS 6371000.0` and publish it as height above the ellipsoid (+7,137 m equator /
−14,248 m poles), and the same lines discard the correct `posRTE` for a raw
`positionHigh + positionLow` sum. One defect, one fix, six files; fork-added capability so WebGL is
not at risk, but the justifying comment cites a WebGL behaviour that does not exist and must be
corrected with it.

**Lane E1 — rule enforcement teeth** (clone `cesium-lane-enforce`):

| | Finding | Repair |
|---|---|---|
| E1-1 | `F1-1` — pre-commit `npx tsc --noEmit` type-checks zero engine files while its comment claims coverage | point the hook at the real per-project checks |
| E1-2 | `G-2` — engine/widgets `.ts` matches no eslint config; ~270 files unlinted; eleven `no-explicit-any` suppressions annotate a linter that never ran; `--quiet` hides the warning | add the config block behind a `--max-warnings` ratchet |
| E1-3 | `G-3` — twelve fork guards run in no CI workflow and no hook | one CI step running the whole-tree-safe guards |
| E1-4 | `G-3b` — `lint-debug-pragmas.mjs` exits 1 on four deliberately-permanent warn sites and cannot be armed | an honoured `permanent-diagnostic` marker, then wire it |
| E1-5 | tooling-catalog spec test A1 pins the census at a literal 1024 — red at the pristine tip | derive the count, prove with a mutation |

## 4. QUEUED — wave 3, dispatch as lanes free (priority order)

| | Locator | Defect | Shape |
|---|---|---|---|
| Q-1 | `Scene.js:3741` | Scene branches on `isWebGPU` to overwrite the shared `frameState.light` — direct P2 violation in the file both backends share | Sol, bounded |
| Q-2 | `WebGPUSceneRenderer.ts:651` | run-of-one indirect-draw branch swallows a command throw with zero output; the sibling branch 60 lines up reports the identical throw | Sol, bounded |
| Q-3 | `WebGPUPostProcessPipeline.ts:1856` | every canvas resize destroys all effects and recompiles their shaders | Opus judgment (resize protocol) |
| Q-4 | `IMAGERY_PROJECTION.md:207` | the canonical doc's summary table inverts the shipped WGSL truth across nine citations — CLAUDE.md calls drift here worse than a projection bug | Sol, doc + verification |
| Q-5 | 3 sites in `Scene/` | unwrapped interpolated `console.log` costing work in production | Sol, bounded |
| Q-6 | probe-lane exit-mapping cluster | runtime/device faults fold to FAIL/1 not ERROR/2; pre-try setup escapes the exit mapper; stack-substring tier classification | Opus design, then Sol |
| Q-7 | `verify-tracked-references.mjs` | cannot distinguish absent-because-unbuilt from absent-because-broken; fails closed on any changed spec in an unbuilt clone | Sol, bounded |
| Q-8 | C16 grammar exclusions | `CC-BY-NC-SA` and `YYYY-MM-DDTHH` leak past the two-string lookahead; zero live occurrences, but the standard REQUIRES license attribution — `C16-R2` rider | Sol, bounded |
| Q-9 | `ViewportQuad.js:187` + siblings | scene-logic-extractor inversions — shared post-branch logic under one backend's branch (fleet 1 backend-agnosticism survivors; full list in §5) | Sol per file |
| Q-10 | `WebGPUSceneRenderer.ts` structure | three self-contained clusters with no orchestration role inline (5,009 lines) | Opus decomposition plan first |

| Q-11 | `AGENTS.md` | the tracked worker-facing rules file carries none of the fork's CRITICAL technical rules — zero hits for positionHigh/positionLow, ShaderDefine add-only, pragma discipline, the C16 standard, backend agnosticism (`CLAUDE.md` is deliberately untracked, so clones receive only AGENTS.md). Verified 2026-08-27; surfaced when a lane noted the rules reached its worker only via the brief | Sol, bounded doc |
| Q-12 | `.prettierignore` | `prettier --check` on `migration_doc/**` is VACUOUS — the ignore file unignores only eight trees and migration_doc is not one, so the command prints success while matching zero files. Every doc-batch "prettier clean" gate over migration_doc has been a false green | Sol, bounded |
| Q-13 | ~~node:test + mixed EOL~~ | **WITHDRAWN by the reporting lane's own experiment** — all-LF and heavily-mixed EOL both run 119/119; the 114→119 movement was a live writer adding five tests between the two measurements (the idle-timeout abort had left the session writing). No guard is warranted; the real finding is the live-writer hazard, already recorded | withdrawn |
| Q-14 | `WebGPUPrimitiveCommands.ts:3624/:5093/:5181` | primitive camera buffers created once and never resized while flat/lit size is recomputed per frame — same family as A5-5 in a second file; pre-existing, sharpened by the A6 UBO growth | Sol, bounded (after A5-5/A6 land) |
| Q-18 | `WebGPUModelRenderer.ts` S1 family | **ONE structural defect confirmed at six sites** (S1-M1..M6): a per-primitive pipeline reference fetched once under `!defined(...)` while a live discriminator — color alpha, invisibility (`:7112`), silhouette translucency (`:7936`), 2D scale (`:5725`), optional pick family never in the clear block (`:5641`), TAA history advance gated only on warmup (`:8584`) — participates in no invalidation path. The `sceneFormatChanged` sweep proves the codebase knows the pattern and misses these sites. Repair structurally (companion discriminator fields or fold into the sweep), NOT six point fixes; coordinate with A5's landed families in the same file | **Opus-judgment**; subsumes Q-16 |
| Q-19 | `EnsureResources.ts:184-202` + `ClusteredLighting.ts:189` | device-invalidation callback nulls nine fields but never resets `_hiZAllocated`/`_hiZAllocatedFor`/`_sortKeysAllocatedFor`/`_clusteredLightingDispatcher`; both dispatcher WeakMaps key on the context object (survives recovery) and capture `context.device` at construction — dead-device objects survive recovery. **Same class as F1-2**; fix with A4's device-identity mechanism, not a third invention | **Opus-judgment**, HIGH |
| Q-20 | `WebGPUSceneRenderer.ts:3860-3990` | translucent cull opens a compute pass with no `endCurrentRenderPass()`/`_resumeScenePass()` bracket; the opaque sibling at `:2354-2361` has the correct bracket verbatim and the comment at `:3876` acknowledges the hazard and leans on the `always` opt-in gate as mitigation — add the bracket so the gate stops being load-bearing | Sol, bounded |
| Q-21 | `WebGPUSceneRenderer.ts:279-283` | snapshot realloc predicate tests existence/device/width/height but never `ppFormat`; `setHDRCanvasOutput:181` changes `_presentationFormat` live with no dimension change, so the snapshot keeps the old format. Store the format, add it to the predicate, correct the adjacent comment | Sol, bounded |
| Q-22 | `probe-backend-isolation.mjs:126-147` census | `census.wrapped` is an uncorroborated self-report — entries are provably emitted by the same statement sequence that installs the hook (sharp version closed with evidence), but the consumer has no report-independent proof of installation; structural to report-consuming gates, worth a corroboration tooth | low; with the acquire run |
| Q-23 | `WebGPUSceneRenderer.ts:1436-1463` (S2-4) | prepareFrame recreates the framebuffer at live canvas dims but never publishes `_width/_height`; executeCommands clamps viewport/scissor against the stale cache before `_ensureResources` republishes — one-frame wrong clamp after every resize. R4-confirmed | Sol-bounded (publish at recreation) |
| Q-24 | `WebGPUGPUSortKeysDispatcher.ts:627` + frustum loop (S2-6) | the readback ring's "prior call = prior submit" invariant breaks with two or more frustums over threshold in one frame: the context-global dispatcher pumps a slot whose copy sits in the still-open encoder. Double opt-in gates it (MEDIUM). R4-confirmed | Opus-judgment (encoder token vs per-frustum ring) |
| Q-25 | `WebGPUSceneRenderer.ts:3824-3841` (S2-7) | previous-frame cull results applied by position with only an `objectCount` equality guard — equal counts across frames with different membership apply frame N-1's flag to a different command; `readResults` also ignores its count argument and returns a cache. R4-confirmed. **Couples with Q-26: land Q-26 first** | Opus-judgment (request epoch: frame id + culler + command-prefix hash) |
| Q-26 | `WebGPUSceneRenderer.ts:2231-2290` (S2-8) | the zero-count early return skips the only reset site of `_gpuCullLastInput`, `_statsLastFrameId`, and the latched `_hiZConsumedThisFrame` — a zero-opaque frustum-0 frame leaves the latch stuck true, violating the invariant the code comment at `:3843` relies on. R4-confirmed | Sol-bounded (hoist bookkeeping above the return) |
| Q-27 | `perf-metric-vector.mjs` noise-prose binding | post-landing assurance proved the contradiction tooth half-broken: `behaviour.includes(String(figure))` is bare substring containment, so five inversions slip through (a "0" satisfied by the 0 in "10"), one proven end-to-end at 119/119 green with the flat inverse of the recorded position; the spec's own contradiction mutant carries no digits so only the easy branch is exercised. Repair: whole-number/delimited figure match + a semantic anchor per claim + digit-bearing contradiction mutants. Figure-perturbation and the two other repairs HOLD strongly | Opus-lean, bounded |
| Q-28 | mirror comparator semantics | the landed verify-orientation-mirror reports two residual disagreements on current main: C12-37 (mirror "COMPLETE + EDGE VERIFIED" vs queue "RESOLVED + LANDED + EDGE VERIFIED") and C11-181 (mirror "COMPLETE" vs queue "COMPLETE + IMPLEMENTED + VERIFIED + LANDED") — vocabulary/subset mismatches, not status conflicts. Decide: subset-compatible comparison, reasoned allowlist entries, or align the mirror text | Opus-lean decision, then Sol |
| Q-16 | `WebGPUModelRenderer.ts:5563` | model `color.alpha` omitted from pipeline AND pass selection — `color.alpha`/`isTranslucent` appear zero times in 9,015 lines while WebGL routes alpha<1 to TRANSLUCENT; a model given a translucent color after first render draws opaque and writes opaque depth, WebGPU only. C1-confirmed: three refutation paths chased and failed (`destroyPipelineResources` never clears `_webgpuCache`; `resolveCustomShaderAlphaMode` reads only `translucencyMode`; the generation predicate memoizes `_geometryBase`) | Sol, bounded; probe owed |
| Q-17 | `WebGPUSceneRenderer.ts:2981` | the no-velocity early return precedes the only per-frame velocity clear, so a producing frame followed by a non-producing one binds stale motion vectors into TAA (`:3170` forwards unconditionally; the TAA zero-placeholder substitutes only on null); the adjacent comment at `:3171` asserts the opposite contract — a Principle-10 defect in a comment | Sol, bounded; probe owed |
| Q-15 | `GlobeTerrain.wgsl` height fallback | the `HEIGHT_SENTINEL_UNAVAILABLE` branch uses the equatorial radius (0 m equator / −21,384.7 m poles) — currently DEAD from all six shipped entry points, filed for whenever a caller reaches it | observation, low |

The remaining ~30 medium and all low survivors are enumerated in §5 with their lane column reading
QUEUED; they dispatch after Q-1…Q-10, batched by file so one Sol dispatch closes several small
findings in the same module. C1's returning findings append here as a dated addendum.
### Shutdown incident addendum (2026-08-28 ~16:45) - the retirement sweep caught lane VE mid-flight

The clone-retirement sweep gutted cesium-lane-nightopt while the lane was still running its one
disclosed in-flight background spec - a seat SEQUENCING ERROR: the lane packet said the
footprint-gate rerun had not returned, and the sweep ran anyway. Cost: ZERO work lost (the
packet was already landed as Batch 1239 via hash-verified copies before the sweep), and the
lane independently reconstructed all eight files byte-exact and banked them with replay scripts
at F:/Dev/GH/cesium-webgpu-backups/q57-nightopt-2026-08-28/ (redundant belt-and-braces; delete
after Q-61 resolves). CLOSEOUT RULE HARDENED: a retirement sweep must confirm the owning lane
has fully exited AND its packet discloses no in-flight runs - EBUSY during a sweep means STOP,
not skip-and-continue.

| | Locator | Finding | Shape |
|---|---|---|---|
| Q-61 | c12-29-s5-svs-footprint-gate test 48 | the dying clone run finished 47/1 with a REAL assertion failure (31 semantic source boundary / raw shaders map-excluded) - earlier reds were timeout-only. UNRESOLVED: could be caused by Batch 1239 shader edits (the pin inventories shader maps) or clone environment. A seat run on main post-1239 was started at shutdown; ITS VERDICT IS RESUME ITEM ZERO - if red on main, triage before any further shader landing | Opus-judgment, triage-first |

### Session stop point for machine restart (2026-08-28 ~16:15) - Batch 1239 landed; two lanes preserved mid-flight

| | Item | State |
|---|---|---|
| LANDED | Q-57 | FIXED Batch 1239 (magnification fade + continuous nightDarkness handover; the fade alone was proven insufficient - the suppression latch was the second half). Edge legs owed incl. the onset-altitude sweep with derived prediction. CORRECTION: the L3 bake measures 455.4 KB - INSIDE the R-2026-08-28-3 half-megabyte gate, not the ~2 MB the row assumed - so the deeper-bake decision is now a cheap maintainer call (halves texel size, full-fade altitude ~42 km -> ~21 km) |
| PRESERVED | lane VF (Q-56/Q-58/Q-55) | stopped at its packet-digest step for the restart - NEAR-COMPLETE work in F:/Dev/GH/cesium-lane-deviceloss (dirty, do not reset). Resume: inspect the clone, re-run its gates, land. Rows stay OPEN until then |
| PRESERVED | lane SW (Q-38b/38d/41/52/54/60 + sink experiment) | stopped mid-Q-60. Partial work in F:/Dev/GH/cesium-lane-solwave (dirty, stable across two hash samples). THREE Sol sessions created 15:55-15:56 died NON-TERMINAL (no task_complete, no surviving process) - treat as dead, SALVAGE INVENTORY taken at shutdown: the clone holds draft work on SIX subjects - all three Q-38d shader fixes plus a new primitive-material-modulo-parity spec, both Q-41 warn wraps, the Q-52 hermeticity edit, and a Q-60-adjacent lib change - ALL UNREVIEWED (the lead died before review/gates/mutants), so resume = review-gate-mutant-land, never straight landing; the two small rollouts hold the partial A/B sink-experiment timings. The project_doc_max_bytes=0 A/B sink experiment is UNFINISHED - re-run it on resume |
| CLONES | retirement sweep | 11 retired on byte-proof or in-session hash-verified landing proof (w3b/w3c/w3d/w3e/w3f/w3g, elevramp, specreds, sunparity, nightblend, lunarshadow). cesium-lane-nightopt is landed-and-drained but EBUSY - delete after the restart releases the handle. KEPT: sundisc2 (FROZEN, maintainer-held), deviceloss + solwave (preserved work above), and eight older-wave clones (c16shard, cachefix, elev, enforce, metric, plan, tools, verify) for a post-restart drainage pass - their dirty files predate this session's hash proofs |
| NOTE | restart hygiene | four stale codex processes from 08-26/08-27 clear with the restart; the Edge/dev-server slots are free; Build/ holds a genuine post-epic artifact at the current tip |

### Acceptance sweep + device-loss lane (2026-08-28 ~15:00) - Batches 1236 landed; sweep evidence at output/visual-wave-acceptance-2026-08-28/

Device-loss cluster dispositions (Batch 1236): Q-46 FIXED (Edge re-verification pending - the T2-2 recipe must go 4-of-4 crash to 0-of-4); Q-47 FIXED WITH PREMISE CORRECTED (liveness, not identity - the globe cache is device-keyed and self-healing; the briefed sixth-family guard was refused as a guard for an absent mechanism); Q-49 CHARACTERIZED (window inherent to the API, measured 1.7 s, cheap suspicion signal landed for speculative pre-cooking only).

Acceptance sweep verdicts: VW-N7 legs 1/3/4/5/6/7 GREEN (anchor -27 luma both backends; off-is-upstream byte-exact; non-injection clean; identity proof; no-double-darkening; CLT-B1 residual (c) CLOSED OBSERVATIONALLY - WebGL vertex-normal terrain shows the night layer). Leg 2 GREEN at orbit, RED at street (Q-57 below). Q-37 pixel acceptance ALL FOUR LEGS GREEN - anchors separated 120.6/137.3 where pre-fix all read one colour; vacuity control fires; frame-timing leg pins the claim. Lunar engine state EXACT both backends (umbral fraction 0.97711 vs 0.9771 predicted, luminance factor 0.04518 vs 0.0452) but the pixel legs are instrument-blocked (Q-58) and the moonlight arm is dead (Q-56). nightDarkness calibration: 0.15 recommended (measured 0.1496 at street over Philadelphia; RATIFICATION PENDING with the sweep's own caveat - sample rural/desert before freezing).

| | Locator | Finding | Shape |
|---|---|---|---|
| Q-55 | WebGPUContext pipeline-cache lazy getters | register a NEW onDeviceInvalidated subscriber per rebuild, never unsubscribe - one leaked closure per recovery (found by lane VD, out of its rows) | Sol-bounded |
| Q-56 | MoonLight scene light | BLOCKER: scene.light = new MoonLight() HALTS RENDERING on both backends - UniformState.js:912 handles only SunLight/else and negates light.direction, which the MoonLight marker class does not carry. The Batch-1225 lunar dimming arm at UniformState.js:1020 is UNREACHABLE - never executable. Fix: derive the moon direction the way SunLight derives the sun's, both consumers | Opus-judgment, BLOCKER |
| Q-57 | default night layer at low altitude | HIGH: nightAlpha 1.0 opaque over a level-2 pyramid (~19 km/texel) replaces the street-level scene with one magnified cream texel below ~100 km (midnight street mean luma 241.87 vs the sharp nightOff scene). Onset altitude unmeasured. Fix design open: resolution-aware alpha fade past the pyramid's max level, and/or a deeper bake against the R-2026-08-28-3 size gate | Opus-judgment, HIGH |
| Q-58 | moon pixel projectability | HIGH: five probe configurations produced zero moon pixels, isMoonVisible false throughout - blocks lunar legs (b)(c)(d). Probe-setup vs engine undetermined; the eclipse-explorer's own shared-frame targeting path was not reproduced | investigate |
| Q-59 | WebGL determinism floor | WebGL repeat captures differ 0.0118%/maxdelta 9 (WebGPU floor stays exactly 0) - per-backend tolerance is now measured doctrine for every future byte-compare leg | recorded |
| Q-60 | worker-clone CRLF false red | c12-29-s5-replacement-device-gate test 13 hashes Function toString over a lib file that is CRLF in fresh clones and LF in main - false red in every worker clone (lane VD reproduced) | Sol-bounded |
| NOTE | 1235 lunar row wording | the DEFERRED_WORK flip reads shipped-pending-Edge-gate; the gate has now run: the DISC appearance is state-confirmed exact, the MOONLIGHT arm is Q-56-blocked. The queue rows here are the authority on that split | recorded |

### Lane VQ-B landings (2026-08-28 ~13:20) - Batches 1227-1229: all four spec reds were drift, zero engine defects

| | Row | Disposition |
|---|---|---|
| DISCHARGED | Q-42 | both reds were stale spec expectations, proven with the metadata-fold file committed-clean: the retirement test asserted the pre-deferral contract (deferred retirement is deliberate - eager destroy frees a texture a live bind group references), and the snap guard sliced from the wrong snap-mode conditional after a second one was added upstream of it (Batch 1227) |
| DISCHARGED | Q-43 | signature-anchored slicing broke on a refactor; regions now addressed by function name with duplicate detection, two assertions strengthened (Batch 1228) |
| DISCHARGED | Q-44 | evidence half observed (first hosted guards run, eight of nine healthy); red half fixed - the empty-range test measured the runner's depth-1 checkout, now hermetic with its own fixture plus an explicit shallow leg (Batch 1229). dev.yml exclusion comment corrected to the measured reasons |
| DISCHARGED | Q-45 | evidence-only: both tooling-catalog checks green in a complete clean clone (exit 0 / 91-91); the earlier reds were transient census staleness closed by Batch 1215. CI wiring still blocked by the shallow-history refusal, now documented accurately in the workflow |
| Q-52 | NEW | verify-landing-compliance.spec "hermetic" marker-controls test enumerates verify-landing temp dirs across the SHARED OS temp dir - reds whenever two lanes run the verifier concurrently (reproduced twice today, also by lane VQ-B). Repair shape: per-test TMPDIR env. Sol-bounded |
| Q-53 | NEW | generate-tooling-catalog.spec A1-family (9 of 49 sandbox tests) red in DETACHED CLONES only - proven pre-existing by two independent lanes' swap-and-restore controls; green at the built main seat. Likely trust-boundary assumptions about the checkout shape. Investigate-low |
| Q-54 | NEW | moon-mip-motion-certification path-backed certification test fails only under the 196-file parallel runner (OS-tmpdir contention at :1428); passes 24/24 standalone. Same hermeticity class as Q-52 |
| DOCTRINE | Sol CLI-direct | background codex exec dispatches MUST redirect stdin from /dev/null (an open stdin blocks the CLI at "Reading additional input from stdin" with zero CPU - looks like a hung worker). AND: the governance-doc sink PERSISTS after the AGENTS.md slim - a retry session spent ~40 min reading AGENTS.md/worker-isolation docs without touching its target. The slimming hypothesis is REFUTED as a complete fix; bounded prompts remain necessary, and the sink needs its own investigation |

### Edge executor tranche 2 (2026-08-28 ~12:45) - evidence at output/edge-executor-2026-08-28-t2/ (RUNLOG 607 lines, 46 PNGs)

Discharged: E-1 clustered lights GREEN against a glTF model (closes tranche-1's blind leg; per-channel response R+25.7/G+23.0/B+18.7 on a 0.000% determinism floor, both controls fired); Batch 1208's cloud morph-excursion leg GREEN (same-size reallocation case exercised inside MORPHING, marchPixels 139500, toggle anchor 9.816%); C12-14 star-cube Edge acceptance DISCHARGED (owed since Batch 865 - gate 41/41, eleven of twelve live contracts verified both backends; flip recorded in the C12 queue); Q-23 pixels GREEN across four sharp resizes but the discriminator is VOID on the default path (Scene.js:6316-6326 rebuilds passState.viewport every frame) - the 1198 clamp keeps its node-spec evidence.

| | Locator | Finding | Shape |
|---|---|---|---|
| Q-46 | genuine GPU-process loss | the WebGPU renderer PAGE CRASHES on real GPU-process loss, 4 of 4 runs; three controls (blank page, bare WebGPU canvas same flags, no-Vulkan flags) all survive and rebuild on a replacement device - the crash belongs to the page. Batch 1199's owed pixel evidence is UNOBTAINABLE until fixed | Opus-judgment, HIGH |
| Q-47 | globe surface pipeline cache | keeps issuing createRenderPipelineAsync on the DEAD device for ~2.75 s after device.lost resolves - a sixth device-identity family with Batch 1199's exact shape, not in its consumer set | Opus-judgment, HIGH |
| Q-48 | gpuCullingHint 'always' | blanks the frame once opaque draws cross ~384-448, permanent 'CommandEncoder locked while RenderPassEncoder is open' validation error; 'auto'/'never' clean at the same count; no counter reports it | Opus-judgment, HIGH |
| Q-49 | device-loss blind window | ~1.7 s before device.lost resolves during which nothing knows the device is dead | investigate with Q-46/Q-47 |
| Q-50 | Q-26 Hi-Z latch pixel leg | UNREACHABLE as specified: below the opaque-count threshold the gate never opens; above it Q-48 blanks the frame. Pixel-leg redesign needed; the 1198 node-spec evidence stands | executor + Opus redesign |
| Q-51 | two-metadata-class pixel leg (Batch 1209) | NOT SCORED - authored fixture banked at output/edge-executor-2026-08-28-t2/job5-metadata-classes/two-class.gltf (two primitives, one material, classes alpha/beta) but the model never got on screen | next tranche, fixture ready |
| DOCTRINE | executor tooling | screenshots must exclude widget DOM (lane-setup.mjs pattern); page.evaluate with a STRING never calls a function it yields (voided two runs); dev-server staleness is proven by symbol presence, never by byte-diffing /Build routes (server.js:323 serves its own esbuild bundle) | recorded |
| OWED | H1 / H2 | cut from the bottom again, two tranches running | next tranche |

**Landing-seat disclosure (this batch):** Batch 1223's fix-queue insertion was shredded one
character per line by a splice-spread-over-string defect in the landing seat's own update
script; the shred spelled the intended wave-4 section and nothing else, it is repaired here
byte-for-byte from the intended text, and the pre-1223 content was verified fully preserved
(263 of 263 normalized chunks present) before the repair touched anything.

### Wave-4 lane landings (2026-08-28 midday, quiet hours lifted by R-2026-08-28-7) - Batches 1218-1222

| | Row | Disposition |
|---|---|---|
| DISCHARGED | Q-37 | canvas-image frame-ordering race root-caused and fixed (Batch 1221): per-frame texture-slot refresh with builder-recorded indices; also closes a latent use-after-destroy. Pixel acceptance owed to the executor with four legs named incl. the frame-timing leg |
| PARTIAL | Q-38 | below-datum flood fixed - WGSL truncated remainder vs GLSL mod (Batch 1222). The above-datum near-solid wall is NOT explained; residual narrowed to dF > spacing with the three-channel readback specified. The recorded translucency control was VOID (appearance-with-material ignores its translucent flag) |
| Q-38b | NEW | czm_pixelRatio dropped from contour line width in both static WGSL shaders and the fabric port - half-width lines on dpr-2 displays; needs a pixel-ratio lane in the primitive camera UB |
| Q-38c | NEW | WebGL primitives carry no materialInput.height at all (GlobeFS.glsl:747 sole assignment) - elevation materials on WebGL primitives read 0; parity work or record the asymmetry in FEATURE_INVENTORY |
| Q-38d | NEW | three more truncated-remainder sites, same class: PrimitiveMatCheckerFlat.wgsl:131, PrimitiveMatCheckerLit.wgsl:301, PolylineMatDash.wgsl:156 |
| Q-38e | NEW | dfCmd._noEffectsSlot derivation looks wrong for textured depth-fail twins (suppresses per-frame shadow/CSM swap); needs its own verification - deliberately not changed in the Q-37 batch |
| REFUTED+DISCHARGED | Q-39 | 'WebGL culls the sun' FALSE - sunVisible true on all 13 rows both legs; the divergence is the WebGPU cold-variant globe-readiness race reaching the probe (third occurrence of the NEW-WEBGPU-OFFLINE-GLOBE-ZERO-FRUSTUMS class). Probe now gates on binned Pass.GLOBE readiness (Batch 1220). Engine row NEW-WEBGPU-GLOBE-COLD-VARIANT-FRUSTUM-COUPLING stays OPEN. Edge re-run owed with pre-registered refutation condition: globeReady false after 45 s reopens as engine defect |
| DISCHARGED | Q-40 | visibility contract published+scored+guarded (62/62); the -0.36 deg offset fully resolved to the Simon1994EphemerisProvider ICRF-vs-TEME branch, reproduced offline to 1e-6 deg on all 13 samples both ways (Batch 1220) |
| NOTE | Q-42 context | c12-29-s5-replacement-device-gate measures 35/1 at the landing seat (VQ-A saw 2 fails at base in its clone) - the delta is for lane VQ-B's diagnosis, not new work |

### Wave-3 landings (2026-08-28 ~06:05) - Batches 1198-1211, all seven lanes closed

All wave-3 lanes were Opus-direct under the A1 precedent (codex MCP server down for the entire
wave; every lane verified no-session before falling back). Landed and pushed before quiet hours:

| Lane | Batches | Discharges |
|---|---|---|
| W3-C frame seams | 1198 | Q-26 bookkeeping hoist, Q-23 viewport clamp (publish-early form REFUTED by executed counterexample), Q-2 run-of-one report |
| W3-B device loss | 1199 (+1200 seat repair: @purpose headers + census) | device-loss epoch resets, five consumers on the shared identity predicate; sky-consumer premise corrected (sampler/layout gap, not LUT views); fog premise corrected (context-keyed shape) |
| W3-F governance | 1201-1203 | Q-11 AGENTS.md carries the six rule families; Q-28 comparator subset-with-floor + C12-37 portfolio row aligned; IMAGERY_PROJECTION table corrected with per-row provenance |
| W3-E four-pack | 1204-1207 | Q-1 isWebGPU seam (six goldens), Q-3 solar-disc floor, Q-4 CC/timestamp exclusion families (census byte-identical), Q-5 four fork diagnostics wrapped |
| W3-D cloud/model | 1208-1209 | cloud temporal source-view keying (morph excursion), model pipeline metadata-class fold (13 sites, one method) |
| W3-G hook + CI | 1210-1211 | pre-commit engine type gate (sentinel-keyed, skip line) + lint-staged status fix; nine build-free guards wired into a CI job with a hollow-job spec |

Landing-seat notes: WebGPUSceneRenderer.ts three-way merged twice (1199 over 1198, 1204 over
1199); comment-marker-guard.spec merged over 1195; package.json hand-merged over 1195 (JSON-
validated); one Q-5 pragma wrap rides in 1204 (same edited region, disclosed in both messages).

Filed, not fixed, by the lanes:

| | Locator | Finding | Shape |
|---|---|---|---|
| Q-41 | SceneRenderer.js:51 + GlobeSurfaceTileProviderRendering.js (~1169) | two unwrapped interpolated console.warn diagnostics, same class as Q-5's targets but console.warn scope | Sol-bounded |
| Q-42 | model-device-recovery.spec.mjs (1 fail) + webgpu-snap-payload.spec.mjs G8 (1 fail) | pre-existing at tip 2ede0a8c89, proven by pristine-file control; both read WebGPUModelPipelineCache.ts | investigate |
| Q-43 | cpu-scene-phase-integration.spec.mjs (3/2) | pre-existing red at HEAD, identical with and without W3-C - measured at the landing seat | investigate |
| Q-44 | .github/workflows/dev.yml guards job | first hosted Actions run is the owed evidence (validated structurally only); also verify-tracked-references Layer 2 is vacuous on a clean CI checkout (Layer 1 only) | watch next push's Actions run |
| Q-45 | verify-tooling-catalog | exit 1 drift on the git-freshness column; test-tooling-catalog 82/91 - excluded from the CI guards job with reasons in the YAML | Opus-judgment |
| OWED | pixel legs | device-loss injection probe (W3-B), cloud morph-excursion resize + two-metadata-class model (W3-D), Q-23/Q-26 pixel legs | next executor tranche |

### Edge executor session findings (2026-08-28 ~05:00) — evidence at output/edge-executor-2026-08-28/

| | Locator | Finding | Shape |
|---|---|---|---|
| DISCHARGED | C11-170 blocker A | zero-count census measured (90 frames / 0 calls / 12 observable members); patch applied and landed Batch 1196 with the per-run bound derivation the shape test demanded | done |
| DISCHARGED | C12-38 dark-hole repair | sample-7 discriminator moved +0.879/+0.875 luminance on both backends; PNGs read, hole gone, no new artifact; co-fade NOT refuted. Magnitude unmeasurable at this exposure (11/13 samples clip both centre and annulus to 1.0) | done; magnitude needs an HDR-exposure leg |
| DISCHARGED | splat cold-start | GATE PASS exit 0, superseded=0, 0.000% cross-backend mismatch with BOTH vacuity controls fired (SH-off 2.5%, covariance-corruption 33.5%) | done; tower scene is the follow-up |
| Q-37 | WebGPU ElevationRamp primitive texture binding | the ramp texture NEVER binds on the primitive path — WebGPU renders the 1x1 default (253,254,254) where WebGL renders the ramp (127,109,127); material side healthy, `_matPrimarySource` stays undefined after 60 frames. **BLOCKS Batch 1183's pixel confirmation** — the elevation arithmetic is currently unobservable | Opus-judgment, HIGH |
| Q-38 | WebGPU ElevationContour line resolution | no discrete lines resolve (near-solid, unchanged by translucency); AND WebGL carries no `materialInput.height` for primitives at all (globe-only, `GlobeFS.glsl:747` sole assignment) — two candidate causes deliberately not guessed between | investigate with Q-37 |
| Q-39 | sun below-horizon parity | at −2.246° WebGL culls the sun and renders night sky while WebGPU renders bright dawn sky WITH a disc — present in pre-fix captures, NOT a Batch-1184 regression | Sol-bounded once triaged |
| Q-40 | sun-disc probe contract | `sunVisible` absent from all 13 rows (all scored:true incl. two below-horizon), plus a consistent ~−0.36° registered-vs-observed altitude offset — the expectation doc predicted this contract question | Sol-bounded |
| OWED | H1 / H2 / F1-2 probes | not reached in the session; RUNLOG records exactly what each still owes | next executor tranche |
| BLIND | E-1 clustered-light probe | the scene never entered the clustered path (position control also moved nothing) — re-run against a glTF model; two setup traps recorded (clusteredLightingEnabled defaults false; white albedo saturates) | next executor tranche |

### A5 close-out corrections and dossiers (2026-08-28 ~04:30)

| | Locator | State |
|---|---|---|
| A5-2 | `WebGPUProceduralCloudRenderer.ts` | dossier READY, mechanism sharpened: `ensureTemporalResources` runs only when temporal is active and reprojection is unsupported in MORPHING, so a morph excursion freezes the temporal dims while `halfView` is destroyed and recreated — on return both bind groups hold a destroyed view; the identity-compare repair exists verbatim at `:1745` | dispatch-ready |
| A5-3 | `WebGPUModelRenderer.ts` | dossier READY: no customShader term in the staleness tuple (`:6474-6489`); UBO destroyed while memoised `textureEntries` still reference it at binding 50 and the merged bind-group cache compares by identity (`:4788`). Sequence AFTER the Q-18 structural sweep, which subsumes it | dispatch after Q-18 |
| A5-4 | **locator corrected**: `WebGPUModelPipelineCache.ts:3241-3245`, not the model renderer | one-point structural fold at `_metadataVariantKey` (`:2816`) covers all fourteen call sites, byte-identical when the gated hashes are zero | Sol, bounded |
| A5-5 | **locator corrected**: `WebGPUPrimitiveCommands.ts` `:5189` (material) AND `:3720` (colour — the row named only one), constants now 272/432 after the elevation landing; the 1183 `assertUniformDataCapacity` checks the SOURCE array and is debug-stripped, so it does NOT cover this defect | Sol, bounded |
| A5-x | six further §5 rows tagged to the A5 lane (splat re-sort throttle `:1545`/`:2411`/`:2922`, cloud texture leak `:2051`, deferred customShader textures `:6672`, decomposition) | untouched, correctly not scope-expanded | wave 3 |

### Filed by the wave-2 landings (2026-08-28)

| | Locator | Defect | Shape |
|---|---|---|---|
| Q-29 | `SolarDiscModel.js` `solarDiscAtmosphereAlpha` | negative transmittance channels return a negative alpha (would brighten the sky); documented as outside the physical domain, no reachable path shown, but a zero clamp is cheap defence-in-depth | Sol, trivial |
| Q-30 | sun-disc emission double-counting | the disc's base RGB is display-referred white, so multiplying by raw slant-path transmittance double-counts an attenuation the tonemapped white already represents; under option (A) the emission is attenuated twice. Deferred by the ruling; wants its own row with a radiometric derivation | Opus-judgment |
| Q-31 | elevation materials in 2D/Columbus View | nothing gates the height derivation on scene mode; in projected vertex space an ellipsoid height is meaningless (pre-existing — the old spherical form was equally meaningless there) | Sol, bounded (mode gate) |
| Q-32 | `computeRTEMatrices` scratch lifetime | returns module-singleton scratches valid only until the next call; three more fields now ride that rule and one intervening caller already reads them — safe today, latent | observation; assert-or-copy follow-up |
| Q-33 | `NEW-WEBGPU-DEVICE-IDENTITY-LUT-CONSUMERS` | sky atmosphere (`:415/:449/:458`), volumetric fog (`:587/:698/:1348/:1512`) and procedural clouds (`:664/:829/:851/:2264`) retain LUT views and old-device bind groups across recovery — consume Batch 1186's `shouldRebuildAtmosphereLUTResources` predicate | Opus-judgment, HIGH |
| Q-34 | `NEW-WEBGPU-IBL-POSITION-PARITY-WEBGL-SHOULDRESET` | upstream's `_shouldReset` is written but never read on the WebGPU path; consume it or document the WebGPU bookkeeping as its replacement | Sol, bounded |
| Q-35 | `NEW-WEBGPU-GLOBE-MATERIAL-ENTRY-KEY` | the material entry keys on `material.type` alone while its module depends on the ocean and imagery toggles; covered today by whole-map clears rather than by the key | Sol, bounded |
| Q-36 | node celestial fleet insensitivity | all 13 celestial gates passed identically before and after a real WebGL appearance change (the co-fade); only the new interpreter spec detects it — the browser sweep is genuinely load-bearing and the fleet should gain one interpreter-class gate per shader pair | Opus design |

## 5. Machine-generated survivor tables (from the three fleet journals, complete)

Every CONFIRMED or PLAUSIBLE verdict from the three adversarial-verification fleets,
severity as corrected by the verifier. `Lane` names the worker lane that owns the fix
tonight; `QUEUED` rows dispatch in wave 3 as lanes free up. Fleet-3 locators that begin
with a bare `:line` are inside the file named at the row's start.

### CRITICAL (2)

| Source | Status | Locator | Finding | Lane |
|---|---|---|---|---|
| fleet2 | CONFIRMED | F:/Dev/GH/cesium-worker-c11170/Tools/visual-regression/lib/perf-metric-vector.mjs:1 | cesium-worker-c11170 holds the 1262-line perf-metric-vector.mjs discharging the 2026-08-25 multi-metric ruling, absent from tip and from main's working copy | A3 (in flight) |
| fleet2 | CONFIRMED | F:/Dev/GH/cesium-worker-sundisc/packages/engine/Source/Scene/SolarDiscModel.js:757 | cesium-worker-sundisc holds an 82-line `solarDiscTransmittanceSplit` implementation that exists in no commit, not in main's tip, and not in main's uncommitted worktree | A2 (in flight) |

### HIGH (11)

| Source | Status | Locator | Finding | Lane |
|---|---|---|---|---|
| fleet1 | CONFIRMED | packages/engine/Source/Renderer/WebGPU/WebGPUPerformanceManager.ts:1622 | WebGPUPerformanceManager.destroy() clears only two Maps; its 7 atmosphere-LUT textures + 2 uniform buffers are never destroyed, never registered in _cacheRegistry, and the manager is never destroyed b | A4 (in flight) |
| fleet1 | CONFIRMED | packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatElevRampFlat.wgsl:76 | Six elevation shaders subtract a hardcoded mean-sphere radius 6371000.0 and call the result height above the ellipsoid, biasing it +7137 m at the equator and -14248 m at the poles | A6 — LANDED, Batch 1183 |
| fleet2 | CONFIRMED | eslint.config.js:14, :55-63, :142-147; packages/engine/Source/Renderer/WebGPU/WebGPUShader | The `any` ban has no lint tooth on engine TypeScript — and empirically the gap is far larger: engine/widgets .ts files match NO eslint config at all, so zero rules run on them. | E1 (wave 2) |
| fleet3 | CONFIRMED | WebGPUDynamicEnvironm:1197 | The WebGPU environment-map refresh gate has no `manager._position` term reachable in the default configuration, so a moving Model/Cesium3DTileset keeps an IBL cube baked for its old location; WebGL re | QUEUED |
| fleet3 | CONFIRMED | WebGPUGlobeSurfaceRen:1203 | Scene-format/MSAA generation change clears three pipeline caches but not `_materialPipelineCache`, so globe-material pipelines keep the old color format and sample count. | A4 (in flight) |
| fleet3 | CONFIRMED | WebGPUGaussianSplatRe:1403 | In-flight pipeline promises write into cache.pipeline / cache.pickPipeline with no generation or resources-identity guard, so pipelines compiled for a superseded format/log-depth/layout/SH axis can la | A5-1 landed 1192; rest dossier/queued |
| fleet3 | CONFIRMED | WebGPUProceduralCloud:1482 | Temporal resolve bind groups capture cache.halfView but are only invalidated on a half-res *size* change, so a size A -> B -> A cycle taken while the temporal gate is off leaves both groups bound to a | A5-1 landed 1192; rest dossier/queued |
| fleet3 | CONFIRMED | WebGPUModelPipelineCa:3245 | Display pipeline maps are keyed without the generated-chunk class hashes, so two primitives of one Model with different metadata classes but the same material identity share one pipeline and one compi | QUEUED |
| fleet3 | CONFIRMED | WebGPUModelRenderer.t:3361 | Removing or swapping a native-WGSL CustomShader destroys `cache._customShader.uboBuffer` while the memoized `primCache.textureEntries` (and the merged group-1 bind group built from it) still reference | A5-1 landed 1192; rest dossier/queued |
| fleet3 | CONFIRMED | WebGPUModelRenderer.t:3964 | Adding or swapping a CustomShader never invalidates the primitive cache, so `materialDefines` and `_customShaderWGSL` keep first-frame values and the new shader silently never compiles. | A5-1 landed 1192; rest dossier/queued |
| fleet3 | CONFIRMED | WebGPUPrimitiveComman:5039 | Material path: per-geometry camera UB created once at 176 or 336 bytes from `isLit`, never resized, so a flat->lit shader flip writes 336 bytes into a 176-byte buffer | QUEUED |

### MEDIUM (30)

| Source | Status | Locator | Finding | Lane |
|---|---|---|---|---|
| fleet1 | CONFIRMED | migration_doc/IMAGERY_PROJECTION.md:150 | Nine file:line citations in IMAGERY_PROJECTION.md point at unrelated code (offsets of 200-2200 lines) | QUEUED |
| fleet1 | CONFIRMED | migration_doc/IMAGERY_PROJECTION.md:207 | IMAGERY_PROJECTION.md:207 canonical table still marks the WGSL texCoordsRect alpha-mask test as `geoUV — WRONG ❌`, contradicting the shipped WGSL and the doc's own two "fix LANDED" notes | QUEUED |
| fleet1 | CONFIRMED | packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessPipeline.ts:1858 | Every canvas size change destroys and recreates all complex post-process effects, and their pipelines are rebuilt through createFullscreenPipeline, which calls createShaderModule/createRenderPipeline  | QUEUED |
| fleet1 | CONFIRMED | packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts:3736 | WebGPUSceneRenderer.ts is 5,009 lines interleaving frame/pass orchestration with three self-contained clusters (GPU culling+HiZ+sort-keys, debug overlays, stats/telemetry) that have no orchestration r | QUEUED |
| fleet1 | CONFIRMED | packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts:651 | WebGPUSceneRenderer.ts:647-656 — the run-of-one branch of executeBatchIndirect swallows an executeWebGPUCommand throw with zero output at any log level, while the sibling branch 60 lines above reports | QUEUED |
| fleet1 | CONFIRMED | packages/engine/Source/Scene/Cesium3DTilesInvalidationFeed.js:163 | Cesium3DTilesInvalidationFeed.js:163 — unwrapped interpolated console.log inside the per-entry apply loop | QUEUED |
| fleet1 | CONFIRMED | packages/engine/Source/Scene/Scene.js:3741 | Scene.js:3741 branches on this.isWebGPU to replace the backend-agnostic frameState.light, diverging published scene state per backend | QUEUED |
| fleet1 | CONFIRMED | packages/engine/Source/Scene/Scene.js:463 | Scene.js:463 — unwrapped init-time console.log with template interpolation on every WebGPU Scene construction | QUEUED |
| fleet1 | CONFIRMED | packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatElevRampFlat.wgsl:115 | Six elevation-material vertex shaders reconstruct world position with the banned positionHigh + positionLow sum before differencing against a ~6.4e6 constant | A6 — LANDED, Batch 1183 |
| fleet1 | CONFIRMED | tsconfig.json:2 | Root tsconfig include is ["scripts/*.js"], so the documented `npx tsc --noEmit` — which is exactly what the husky pre-commit hook runs — type-checks ZERO engine files while exiting 0 | E1 (wave 2) |
| fleet2 | CONFIRMED | .github/workflows/*.yml; package.json:149-176; .husky/pre-commit, .husky/pre-push | Twelve fork-specific guard scripts exist as npm/Tools entry points and none is invoked by any GitHub Actions workflow; only local git hooks enforce them. | E1 (wave 2) |
| fleet2 | CONFIRMED | f:/Dev/GH/cesium-webgpu/CLAUDE.md:12 and migration_doc/CAMPAIGN_STATE.md:34 vs migration_d | CLAUDE.md asserts C11-181 is NOT COMPLETE and that 'the queue row keeps it open', but the named queue row and the ledger both record it COMPLETE with a 2026-08-09 administrative close | B2 (in flight) |
| fleet2 | CONFIRMED | F:/Dev/GH/cesium-worker-c11170/Tools/visual-regression/output/performance/c11-170-perf-reg | c11170 is the only clone with un-repatriated evidence artifacts under Tools/visual-regression/output (6 files); the other eight clones are genuinely empty | A3 (in flight) |
| fleet2 | CONFIRMED | F:/Dev/GH/cesium-worker-g6frame/Tools/visual-regression/probe-gsplat-multifrustum.mjs | cesium-worker-g6frame carries ~318 lines of gsplat probe methodology present in the clone and absent from tip | D2 (in flight) |
| fleet2 | CONFIRMED | migration_doc/CAMPAIGN_PORTFOLIO_QUEUE.md:133,224 vs migration_doc/QUEUE_2026-07-23_CAMPAI | CAMPAIGN_PORTFOLIO_QUEUE.md still records C13-41 / C12-29 S3 as COMPLETE and 'no longer blocks C12' while both status-authority queues record it REOPENED with the closure VACATED | B2 (in flight) |
| fleet2 | CONFIRMED | packages/engine/Specs/Scene/Cesium3DTileBatchTableSpec.js:21 | Cesium3DTileBatchTableSpec.js is xdescribe'd (1,200 lines, 57 it) while the class is live in Source including two WebGPU renderers | QUEUED |
| fleet2 | CONFIRMED | Tools/lint-debug-pragmas.mjs:155; package.json:149 | The debug-pragma linter is unwired and currently exits 1 on four deliberately-permanent console.warn sites it has no way to exempt. | E1 (wave 2) |
| fleet3 | CONFIRMED | WebGPUVoxelRenderer.t:1101 | fragmentPickMain (object pick) still ray-marches the camera-centered phantom box while the color and cell-pick marches use u.cameraPositionProxy, so object-pick hit/miss is decided from unrelated samp | QUEUED |
| fleet3 | CONFIRMED | WebGPUGaussianSplatRe:1545 | The legacy comparator's re-sort throttle tests camera direction only, omitting the camera-position term its own comment and the cited WebGL predicate both carry, so a camera that translates without ro | A5-1 landed 1192; rest dossier/queued |
| fleet3 | CONFIRMED | WebGPUProceduralCloud:1591 | The consuming temporal bind groups are keyed on the attachment generation only, and that counter does not advance when halfView is reallocated at an unchanged size, so binding 0 goes stale by a second | A5-1 landed 1192; rest dossier/queued |
| fleet3 | CONFIRMED | WebGPUPrimitiveComman:2917 | Color path: `hasDepthFail` omitted from the pipeline-rebuild predicate that exclusively builds the depth-fail pipeline, so a late `depthFailAppearance` assignment silently renders nothing on WebGPU | QUEUED |
| fleet3 | CONFIRMED | WebGPUVoxelRenderer.t:3011 | VoxelPrimitive.nearestSampling is read only inside the one-time init block, so runtime toggling is a silent no-op on WebGPU while WebGL re-applies it every frame. | QUEUED |
| fleet3 | CONFIRMED | WebGPUPrimitiveComman:3069 | Color path bakes cull mode from `appearance.closed` / `renderState.cull.enabled` into the cached pipeline but omits both from the rebuild predicate, while the material path's gate keys on `appearanceC | QUEUED |
| fleet3 | CONFIRMED | WebGPUModelPipelineCa:3421 | `_errorPipelines` bakes presentation format, depth format and sample count but is never cleared outside destroy(), so a post-toggle failure serves a stale-format magenta pipeline into the freshly-wipe | QUEUED |
| fleet3 | CONFIRMED | WebGPUVoxelRenderer.t:3583 | stepSize, maxSteps and densityThreshold are hardcoded UBO literals, so VoxelPrimitive.stepSizeMultiplier is a silent no-op on WebGPU. | QUEUED |
| fleet3 | CONFIRMED | WebGPUSceneRenderer.t:3769 | GPU frustum cull drops un-cullable commands (no boundingVolume / cull===false) because their sphere slot stays all-zero | QUEUED |
| fleet3 | CONFIRMED | WebGPUSceneRenderer.t:3836 | Previous-frame cull flags are matched to this frame's command list by count alone, so churn at constant length misapplies flags positionally | QUEUED |
| fleet3 | PLAUSIBLE | WebGPUSceneRenderer.t:3978 | Translucent cull has no readback-in-flight guard and shares one culler across frustums; second same-frame prepareReadback maps a slot the open encoder still writes | QUEUED |
| fleet3 | CONFIRMED | WebGPUModelPipelineCa:4182 | The capture-pipeline key omits the split / model-color / silhouette render-mode bits and `_capturePipelines` is never wiped, so a runtime toggle leaves the env-capture pass on the pre-toggle module in | QUEUED |
| fleet3 | CONFIRMED | WebGPUModelRenderer.t:6672 | CustomShader TEXTURE uniforms that resolve asynchronously are never upgraded from the white placeholder, because the deferred-texture poll covers only glTF material slots. | A5-1 landed 1192; rest dossier/queued |

### LOW (54)

| Source | Status | Locator | Finding | Lane |
|---|---|---|---|---|
| fleet1 | CONFIRMED | migration_doc/DEBUGGING_GUIDE.md:209 | Five live CesiumDebug commands missing from DEBUGGING_GUIDE.md's command table; four appear nowhere in the file | QUEUED |
| fleet1 | CONFIRMED | package.json:48 | package.json sideEffects './Source/Cesium*.js' rationale (protecting a setGlobalDefaultRenderer bootstrap) no longer matches the generated barrels | QUEUED |
| fleet1 | PLAUSIBLE | packages/engine/Source/Renderer/WebGPU/RenderCommand.js:24 | RenderCommand.js is backend-neutral but missing from WEBGPU_COMPAT_EXEMPTIONS, so it becomes the throwing stub in webgl-only builds | QUEUED |
| fleet1 | PLAUSIBLE | packages/engine/Source/Renderer/WebGPU/RenderStateToPipelineVariant.ts:383 | applyPerEncoderState skips setStencilReference when the reference is 0, leaking the previous draw's reference | QUEUED |
| fleet1 | CONFIRMED | packages/engine/Source/Renderer/WebGPU/WebGPUAmbientOcclusionEffect.ts:933 | AmbientOcclusionEffect.updateConfig() destroys 2 of the 4 uniform buffers that _createUniforms() then reassigns, orphaning _blurHUniforms and _blurVUniforms — latent, no caller today. | QUEUED |
| fleet1 | CONFIRMED | packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts:1 | 54 of 272 files under Renderer/WebGPU exceed 1,000 lines (210,107 lines total) with no decomposition entry in DEFERRED_WORK.md, while genuinely exempt large files are correctly exempt | QUEUED |
| fleet1 | CONFIRMED | packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts:5177 | WebGPUContext.ts is 7,747 lines with ~9 responsibilities; companion-file seam applied only to the smallest clusters, and a new resource-owning subsystem must be wired into three separate teardown path | QUEUED |
| fleet1 | CONFIRMED | packages/engine/Source/Renderer/WebGPU/WebGPUContextCullerPool.ts:104 | WebGPUContextCullerPool.ts:104 — all four lazy GPU-culler getters leave the outer import("./WebGPUGPUCuller.js").then(...) without a .catch, so a rejection is unhandled and permanently latches the ini | QUEUED |
| fleet1 | PLAUSIBLE | packages/engine/Source/Renderer/WebGPU/WebGPUDrawCommand.ts:590 | Bundle fast path returns before applyPerEncoderState, dropping the command's own per-encoder state | QUEUED |
| fleet1 | PLAUSIBLE | packages/engine/Source/Renderer/WebGPU/WebGPUDrawCommand.ts:716 | WebGPUDrawCommand.clone() omits depthForTranslucentClassification, classificationDepthPipeline, drawIndirectBuffer/Offset, bundle and enabled | D2 (in flight) |
| fleet1 | PLAUSIBLE | packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceShaders.ts:189 | getDebugFragmentShaderModule preprocesses at definesHi=0 while its clip-distances sibling deliberately threads definesHi, so a debug pipeline pairs a hi-aware vertex module with a hi-blind fragment mo | QUEUED |
| fleet1 | PLAUSIBLE | packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts:499 | WebGPUGlobeSurfaceTileUB.ts:499 — pragma-wrapped console.error for a condition its own comment says renders the globe black | QUEUED |
| fleet1 | CONFIRMED | packages/engine/Source/Renderer/WebGPU/WebGPUGroundPolylineRenderer.js:2367 | Paired load/error listeners on an HTMLImageElement material source are both registered {once:true} but neither is removed when the other fires, retaining the renderer's material cache for the element' | QUEUED |
| fleet1 | CONFIRMED | packages/engine/Source/Renderer/WebGPU/WebGPUGroundPrimitiveRenderer.js:1961 | createWebGPUGroundPrimitiveCommands is an 867-line function spanning six phases; resolveDepthSampleBindGroup is a closure over ~40 locals so the depth-source selection can only be verified by pixel pr | QUEUED |
| fleet1 | CONFIRMED | packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessPipeline.ts:1863 | The ten per-effect ?.resize() calls in WebGPUPostProcessPipeline.resize() are provably no-ops because the initialize() call on the preceding line nulls every one of those fields. | QUEUED |
| fleet1 | PLAUSIBLE | packages/engine/Source/Renderer/WebGPU/WebGPURenderBundleManager.ts:402 | WebGPURenderBundleManager.ts:402-419 — _recordBundleWithValidation pushes a validation scope then runs a caller-supplied record callback and encoder.finish() with no try/finally, leaking the scope on  | QUEUED |
| fleet1 | PLAUSIBLE | packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts:2805 | WebGPUSceneRenderer.ts:2805 — InvertClassification composite skip warning is debug-only | QUEUED |
| fleet1 | CONFIRMED | packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts:23 | WebGPUShaderDefines.ts registry header justifies the bit-31 reservation with a pipelineKeyWithDepthFlag fold that no longer exists, contradicting the same file at :905 and the helper's own docstring | QUEUED |
| fleet1 | CONFIRMED | packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts:249 | ShaderDefine bits 10 (STOCHASTIC_DITHER_ALPHA) and 11 (STENCIL_PICK_WINNER) carry `Consumers:` lines naming WGSL gates that were never authored; the feature shipped as separate entry points instead | QUEUED |
| fleet1 | PLAUSIBLE | packages/engine/Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js:693 | WebGPUShadowMapRenderer.js:693 — pragma-stripped warning for unregistered shadow-cast vertex stride | QUEUED |
| fleet1 | PLAUSIBLE | packages/engine/Source/Renderer/WebGPU/WebGPUViewportQuad.ts:353 | WebGPUViewportQuad.createBindGroupFromUniformMap takes `Record<string, () => any>` when the correct union ViewportQuadUniformValue is declared 226 lines above in the same file | QUEUED |
| fleet1 | CONFIRMED | packages/engine/Source/Scene/CesiumDebug.js:63 | CesiumDebug.help() omits seven of the object's own live methods despite advertising "list all commands" | QUEUED |
| fleet1 | CONFIRMED | packages/engine/Source/Scene/GlobeSurfaceShaderSet.js:1086 | GlobeSurfaceShaderSet.js:1086 uses a raw context.isWebGPU term that is redundant with the WebGL-only capability tested two lines later | QUEUED |
| fleet1 | CONFIRMED | packages/engine/Source/Scene/SceneRenderer.js:519 | SceneRenderer.js:519 — unwrapped seven-interpolation env-inject console.log guarded only by a JS latch | QUEUED |
| fleet1 | CONFIRMED | packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl:1974 | GlobeTerrain.wgsl applyImageryLayer docstring cites GlobeFS.glsl by line number and is off by ~48 lines | QUEUED |
| fleet1 | PLAUSIBLE | scripts/bundleVariantPlugin.js:222 | WebGLCompatibilityStub exemption's 'works in ANY variant' invariant is false because its six Stubs/* dependencies are not exempt | QUEUED |
| fleet1 | CONFIRMED | scripts/bundleVariantPlugin.js:285 | WEBGPU_COMPAT_EXEMPTIONS substring matching silently also exempts WebGPUModelMetadataCache.js | QUEUED |
| fleet1 | PLAUSIBLE | Tools/visual-regression/c12-29-s5-custom-ellipsoid-gate.spec.mjs:6045 | c12-29-s5 spec test returns before asserting when its probe file is missing — an assertion-free early return on absent evidence | QUEUED |
| fleet2 | PLAUSIBLE | .clinerules:516; migration_doc/UPSTREAM_MERGE_2026-06_CHANGELOG.md:215-247 | The documented 'prefer --theirs then re-add WebGPU' conflict step no longer applies to the decomposed high-churn files | QUEUED |
| fleet2 | CONFIRMED | .github/workflows/dev.yml:23-35; .github/workflows/prod.yml:28-40; .husky/pre-commit; .hus | No licensing guard runs in CI or any git hook; verify-packaged-notices and buildThirdParty are manual-only | E1 (wave 2) |
| fleet2 | CONFIRMED | .gitignore:43-44; .github/workflows/dev.yml:21,31; package.json:115 | No committed lockfile while ~90 caret ranges feed a CI type-check gate | E1 (wave 2) |
| fleet2 | CONFIRMED | CHANGES.md:3, CHANGES.md:12, CHANGES.md:18 | CHANGES.md fork section header is fixed at 2026-07-16 but accumulates entries landed weeks later, above the 1.144 section | QUEUED |
| fleet2 | PLAUSIBLE | CLAUDE.md RTE / parity / evidence-repatriation / multi-metric sections; packages/engine/So | Four further rules have no tool; the ShaderDefine add-only ordering in particular has no bit-value snapshot spec. | D2 (in flight) |
| fleet2 | CONFIRMED | F:/Dev/GH/cesium-audit-fleet git diff --numstat 6d5d8b1f07 HEAD -- packages/engine/Source | 533 upstream-owned engine files carry ~115k lines of divergence from the merged upstream tip - the standing hand-resolution surface | QUEUED |
| fleet2 | PLAUSIBLE | F:/Dev/GH/cesium-webgpu git reflog show upstream/main; migration_doc/WEBGPU_MIGRATION_STAT | upstream/main tracking ref last fetched 2026-08-08, tip dated 2026-08-03, so fork's real divergence is unmeasured | QUEUED |
| fleet2 | CONFIRMED | git log -1 --format='%b' 4f0dbc3c8c (also 77d9d2f520, 46ad90befd, 254b4a332a); Tools/landi | Four correctly-prefixed, correctly-attributed batches landed with a body consisting solely of the Co-Authored-By trailer — including Batch 1036, the commit that landed the charter rule requiring non-e | QUEUED |
| fleet2 | CONFIRMED | git log HEAD~150..HEAD | Tools/landing-rules.mjs evaluateCommits({includeCommitQuietHours: | A 13-commit block from Fri 2026-08-14 (cd656255e9..034c7f74d0) fails all four landing rules simultaneously — batch-prefix, body, co-author-trailer and commit-quiet-hours — accounting for 52 of the 56  | QUEUED |
| fleet2 | CONFIRMED | gulpfile.js:386-390; packages/engine/package.json:14-24,32-33; packages/engine/LICENSE.md | wasm_splats_bg.wasm is copied into the @cesium/engine tarball with no notice in packages/engine/LICENSE.md, unlike every peer prepare-copied binary | QUEUED |
| fleet2 | CONFIRMED | migration_doc/DEFERRED_WORK.md:1273,1299 and migration_doc/QUEUE_2026-08-09_CAMPAIGN18.md: | Two ledger 'near line N' self-pointers (9285, 512) have drifted onto unrelated sections, and QUEUE_2026-08-09_CAMPAIGN18.md forwards both verbatim | B2 (in flight) |
| fleet2 | CONFIRMED | packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts; repo-wide wc -l sweep | The ~1000-line decomposition guidance is unmeasured and 162 engine source files exceed it, the largest at 9,015 lines. | A5-1 landed 1192; rest dossier/queued |
| fleet2 | PLAUSIBLE | packages/engine/Source/Scene/Model/MetadataWGSLPipelineStage.js:60; scripts/bundleVariantP | Backend agnosticism has no static import-graph check — but the one violation offered as proof of live decay is a documented, engineered build-plugin exemption. | QUEUED |
| fleet2 | CONFIRMED | packages/engine/Specs/Renderer/WebGPU/WebGPUTextureSpec.js:198 | WebGPUTextureSpec 'writes pixel data to a 2D texture' asserts nothing — no expect() in the body | QUEUED |
| fleet2 | CONFIRMED | Tools/verify-landing-compliance.mjs:138-164 (resolveRange), :74 (DEFAULT_LAST=20), package | The after-the-fact detector has no grandfather floor at Batch 1045, so a widened --last N sweep reports permanently unfixable historical violations. | B3 (in flight) |
| fleet3 | PLAUSIBLE | WebGPUPrimitiveComman:1013 | computeRTEMatrices takes view/projection from uniformState but the RTE origin from frameState.camera, so the color pack and the shadow-cast pack disagree on which camera is authoritative | QUEUED |
| fleet3 | CONFIRMED | WebGPUSceneRenderer.t:1515 | Comment claims _scene is cleared at the end of executeCommands; it is not, and destroy() does not clear it either | QUEUED |
| fleet3 | CONFIRMED | WebGPUProceduralCloud:2051 | cache.weatherTexture and cache.noiseFallbackTexture are allocated here but never destroyed, including in the otherwise meticulous destroyProceduralCloudResources. | A5-1 landed 1192; rest dossier/queued |
| fleet3 | CONFIRMED | WebGPUDynamicEnvironm:2183 | Under SCENE_LIGHT the bake reads `uniformState.lightDirectionWC` while the gate watches only `sunDirectionWC`, so an app-animated scene light with a static sun never re-bakes the cube — real, but WebG | QUEUED |
| fleet3 | CONFIRMED | WebGPUGaussianSplatRe:2411 | The source-withdrawal retirement branch is gated on cache.layoutPacked, so a legacy-layout producer that clears its payload keeps drawing the previous cloud from the still-resident GPU buffer. | A5-1 landed 1192; rest dossier/queued |
| fleet3 | CONFIRMED | WebGPUGaussianSplatRe:2922 | The TAA-off early-out is unreachable because cache.prevSplatBuffer is unconditionally allocated as a placeholder during init, so the motion-vector path runs with TAA disabled; the consequences, howeve | A5-1 landed 1192; rest dossier/queued |
| fleet3 | CONFIRMED | WebGPUGlobeSurfaceRen:2955 | `destroy()` never releases `_materialPipelineCache`, so the per-material-type uniform buffer is never destroyed. | A4 (in flight) |
| fleet3 | CONFIRMED | WebGPUPrimitiveComman:3171 | Placeholder material UB reallocated on every pipeline rebuild without destroying the previous buffer | QUEUED |
| fleet3 | CONFIRMED | Cesium3DTileset.js:3327 | processTiles double-decrements numberOfTilesProcessing when a tileLoad listener throws, permanently latching tilesLoaded false | QUEUED |
| fleet3 | CONFIRMED | Scene.js:5771 | _specularEnvironmentCubeMap is Scene-owned but absent from the destroySceneResources ownedResources list | QUEUED |
| fleet3 | PLAUSIBLE | Scene.js:5890 | try/catch around Matrix3.inverse is inert in release builds, so a degenerate voxel OBB fails closed instead of open | QUEUED |

