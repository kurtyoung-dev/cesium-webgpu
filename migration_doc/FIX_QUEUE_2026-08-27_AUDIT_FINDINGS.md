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
### Q-65 LANDED - Batch 1270 (2026-08-29 ~01:15 machine clock)

| | Row | Disposition |
|---|---|---|
| Q-65 | FIXED (Edge-pending) | station-3 review LAND-WITH-FIXES, every fix in the landing procedure, none in the diff (`cesium-lane-q65/_lane-out/Q65_REVIEW_PASS1.md`). Root cause and the premise correction CONFIRMED: the frame arriving DURING the ~1.4 s recovery window hit `_isDeviceUnavailable`'s conflation of recoverable loss with terminal, and CesiumWidget._onRenderError killed the loop with no re-arm; the successor device and the eight-getter rebuild were already GREEN on pristine main. Ordering answered precisely: the fix PREVENTS the kill, it does not re-arm after one (Scene.requestRender never touches _useDefaultRenderLoop). Refinement: the five entry-point throws were already pragma-gated, so RELEASE builds already declined silently - the five-site change alters debug builds only; the genuinely new runtime behaviour is the two scene-renderer guards, the model-arena liveness arm (`resolveModelCameraArenaOwner`, a non-pragma Error = the release-build twin) and the requestRender re-request. Harness class BOUNDED not sampled: `isDeviceLost` is a real WeakSet.has, only whole-module stubbing can fake it, exactly one spec did (repaired; re-stubbing it in memory sends legs 2a/2b red). The loosened HEAD spec passes 34/34 FALSELY against the lane source - the slice-tightening was measured-necessary. 7 files +112/-49; new spec 12/12; 59/59 across the three specs at the seat; tsc 0 non-TS2307; eslint/prettier/C16 0; TOOLING_CATALOG regenerated after staging (also clears main's 8 drifted rows) |
| RECIPE | Q-65 Edge recipe amended | leg 9's first message is NOT a discriminator (beginFrame reports before clear() throws, so it fires pre-fix too); leg 9's second message is record-only (the globe self-guards at WebGPUGlobeSurfacePipelines.ts:630-636 before reaching the sentinel, so its absence in the globe-only leg is expected). Recipe: Edge + --enable-gpu-benchmarking, ?renderer=webgpu, chrome.gpuBenchmarking.terminateGpuProcessNormally() (never device.destroy()), three legs + terminal-path negative control; deviceLossState / resourceGeneration are non-discriminators |
| Q-84 | NEW | `WebGPUContext.createSync` still throws on a RECOVERABLE loss (production-visible); no in-engine frame-path caller (PickFramebuffer uses Sync.create, WebGL-only) - record the asymmetry; extend when a caller appears | Sol-bounded |
| Q-85 | NEW | pre-existing null-PBO dereference in `PickFramebuffer.js:83-105` surfaces as a misleading 'Async Picking Request Timeout' | Opus-judgment |
| Q-86 | NEW | multi-context device recovery is untested (the recovery path is exercised for one context only) | executor recipe + spec |

### Edge tranche 3d (2026-08-29 ~03:00 exit) - G3 on the 4096 tier, C12X E2/E3, Q-62, Karma; evidence output/edge-tranche3d-2026-08-29/ (65 files) + EDGE_TRANCHE_3D_PACKET_2026-08-29.md

| | Row | Disposition |
|---|---|---|
| INSTRUMENT FIRST | Q-76 (was Q-3D-1) | `node server.js` in default mode mounts /Build/CesiumUnminified on Build/CesiumDev and routes the entry through LIVE esbuild - the executor's first J1/J2/J4 runs measured the wrong build; the G3 probe's own provenance check caught it. `--serve-built` (served md5 == disk md5) is MANDATORY in every executor brief; the three jobs were re-run and came back byte-identical (J4's eight STRUCTURAL provenance lines disappeared, confirming the cause). No conclusion below rests on the wrong build | brief template + DEBUGGING_GUIDE |
| J0 | GREEN | g3-gate spec 117/117, policy spec 28/28, 4096 face served 200 + JPEG magic |
| J1 G3 @4096 | FAIL (exit 1), IDENTICAL on both backends, 16/18 criteria green | resolved TYCHO_T5_DIFFUSE/4096, 4096 px/face, 384 MiB, no render overlap. vs Batch 934 @2048: px/face 2048 -> 4096 (>= 2700: RED -> GREEN); arcmin/px 2.637 -> 1.3184 (<= 2.0: RED -> GREEN); median chroma 0.000 -> 0.000 (>= 0.20: RED - the ASSET: positive control returns 0.5, all three variants read 0); dust IQR vs t3 0.585x -> 0.5851x (>= 3: RED - UNREACHABLE by any bundled variant at any resolution, the certifying variant being the low-passed one measured against t3). Granularity 0.4187, band retention 0.9258. Fold FAIL, 4/5 red -> 2/5. DR-01 recorded, not interpreted: aliasTwinkle STILL TRIGGERS at 2.4477 vs bound 1.2 with a certifying-resolution asset, both backends, control valid (isolatesSubPixelPhase true); spriteDensity 0.1741 vs 10 triggered; smearedMilkyWay 0.9258 vs 0.6 not triggered. Per the C12 queue's own OWED text this ELIMINATES the asset variable and makes DR-01 a clean single-variable question |
| PENDING MAINTAINER | 4096 tier + R-2026-08-10-4 protocol | Option A executed. The tier is staged uncommitted (12 faces, 19.5 MB, both t5 variants, opt-in) and clears exactly the two resolution criteria; chroma and dust are source-asset properties the pipeline cannot manufacture. Levers: (i) LAND the tier as an opt-in quality option and record G3 as FAIL-on-asset with the bar honest (cost 19.5 MB in the engine assets - the Option C trigger); (ii) HOLD the tier out of the bundle and ship it as an external/CDN asset via the existing policy seam (zero bundle cost; the resolver already handles a non-bundled request); (iii) DROP; plus DR-01 itself (twinkle survives a certifying resolution -> the sampling/PSF side, not the asset). The seat recommends (ii) unless the maintainer's eyeball values the 4096 sky enough to pay 19.5 MB. Maintainer keeps the appearance eyeball per R-2026-08-28-13 |
| J2 C12-12 default-sky identity | resolver GREEN; pixel identity NOT PROVEN | default request resolves 2048 fallback:false; SIZE_4096 resolves 4096 fallback:false. No reproducible pre-tier sky capture exists -> this run is banked as the BASELINE, not an identity proof |
| J3 C12X E1 | NOT-RUNNABLE | no instrument exists for the exposure-sweep discriminator; the C12X intake pre-registered the prediction, not a probe. shadowContrastRatioAtDeepest re-read 1.0341102079879674, bit-identical to the banked value | Sol-bounded instrument (Opus/Sonnet now) |
| J4 C12X E2 | BLOCKER REPRODUCES | refreshCostMeasured still false: WebGPU 'pre-segment GPU readback drain did not close (timedOut=true, undrained=1)'; WebGL 2.424 ms/refresh vs 3.172 in the other run of the same build (+31% swing - single-number reporting is void here) |
| J5 C12X E3 (specs) | multiview 44/44; dense-cost 40/40 in 594 s (not 26 min); replacement-device 35/36 RED | the red is a stale pinned whole-build module count (2202 vs 2207) = instrument (Q-81). AMBIGUITY resolved by the executor: E3 names exist as both node gates and same-named Playwright PROBES; the specs ran; the probes (the half the intake calls never run in a browser) remain OWED - next Edge job |
| J6 Q-62 | REPRODUCES byte-identically | the executor's reader hypothesis was REFUTED by a control; the twilight black box stands as an engine finding |
| J7 Karma | GREEN 7/7 (Edge 152) | Q-75 CLOSED - the :267 expectation passes |
| Q-77 | NEW | G3 criteria 3 (chroma) and 4 (dust IQR vs t3) are unreachable by ANY bundled variant at any resolution - the gate can never fold PASS on the shipped assets; either the bar names a source the pipeline can actually bake from, or the criteria are re-scoped to what the ruling meant | Opus-judgment (with the maintainer's DR-01 ruling) |
| Q-78 | NEW | eclipse DirectionalLight diagnostic disagrees with the shipped lighting on all 4 rungs (persists under --serve-built; likely night-epic drift since the light rewiring) | Opus-judgment |
| Q-79 | NEW | WebGPU refresh/fill counters disagree where WebGL's match exactly (+8 = segmentsPerLeg; 82 control refreshes with 0 fills) | Opus-judgment |
| Q-80 | NEW | the SOL-4 refresh-cost lane publishes no memory/allocation metric - violates the multi-metric rule | Sol-bounded |
| Q-81 | NEW | replacement-device gate pins a whole-build module count (2202 vs 2207) - an instrument that reds on every unrelated landing | Sol-bounded |
| Q-82 | NEW | SkyBoxResolutionPolicy.ts header (:43/:47/:51-53) self-contradicts post-tier - resolves with the tier decision (fix text either way) | seat |
| Q-83 | NEW | gulp test --includeName takes a SUITE name; a zero-match run exits 1 indistinguishably from a failure | Sol-bounded |

### Q-74 packet delivered + a maintainer decision (2026-08-29 ~02:40)

| | Row | Disposition |
|---|---|---|
| Q-74 | PACKET DELIVERED, in station-3 review (`cesium-lane-q74`) | premise RELOCATED: not a contour-law defect. Upstream: `czm_materialInput.height` is globe-only (GlobeFS.glsl ~834 sets it; AllMaterialAppearanceFS.glsl leaves it uninitialised), so on a primitive dF = 0 / alpha = 0 everywhere; WebGL renders nothing visible with depth written because MaterialAppearance({translucent:true}) keeps ALPHA_BLEND in its render state while isTranslucent() answers false. WebGPU: the material pipelines baked the colour-target blend from isTranslucent() ALONE, writing the discarded alpha as opaque colour - hence the fill invariant to width, spacing and translucent. Fix (class): read the blend from appearance.renderState (RenderStateToPipelineVariant.ts, WebGPUPrimitiveCommands.ts; polyline-material pipeline got the same one-liner with NO pixel evidence - flagged for reviewer veto). Second change: the globe fabric's hardcoded pixelRatio 1.0 -> czm_pixelRatio() backed by a `pixelRatio` lane carved from _pad2b (float 63; CAMERA_UNIFORM_FLOATS stays 232 - WILL MOVE at landing because CW2 appends a 12-float tail -> 244). 6 files +174/-26; new specs 18/18 incl. 4 if(false) mutants; 24/25 regression sweep green (gsplat-harness 5 pre-existing; svs-footprint not run: 25 min no summary then 240 s budget) |
| Q-74-D1 | PENDING MAINTAINER | with blending restored, a latent divergence becomes VISIBLE: the six WebGPU PrimitiveMatElev* shaders (Batch 1183) derive a real geodetic height, GLSL does not, so WebGPU will draw contour bands on a primitive where WebGL draws nothing. Options: B1 port the height derivation to the GLSL appearance shaders (lane recommends; Principle 5; the only route that makes the primitive scene a valid cross-backend subject for Batch 1261's own lane), B2 gate the WGSL derivation behind an opt-in, B3 accept and record. Reviewer asked for a cost estimate of B1 |
| INSTRUMENT | tranche 3c Job 4 dpr legs measured nothing | `useBrowserRecommendedResolution` defaults true and pins scene.pixelRatio = 1.0 regardless of devicePixelRatio (CesiumWidget.js ~275-284); the 3c harness never overrode it, so both dpr legs read the same value of the term under test. Every future dpr recipe sets it false with an in-page precondition assert. Also: the globe contour scene needs TERRAIN (ellipsoid height ~ 0 -> dF = 0 on both backends) |
| FOLLOW-UP | PrimitiveMatGrid* pixel-ratio stand-in | the grid material shaders keep the same hardcoded 1.0; their comments record the blocker (a conditional logDepth field would make later offsets define-dependent). Reported, not changed | row when Q-74 lands |

### Q-71 LANDED - Batch 1268 (2026-08-29 ~02:10); R9A4 pass 3 GO-FOR-2a

| | Row | Disposition |
|---|---|---|
| Q-71 | FIXED (Edge-pending) | station-3 review LAND-WITH-FIXES (`cesium-lane-q71/_lane-out/Q71_REVIEW_PASS1.md`), both fixes applied at the landing seat. Root cause CONFIRMED and the row's premise corrected on the record: `constrainedAxis` plays no part (bit-identical basis with and without); the defect is upstream's heading/roll encoder reading azimuth off `up` inside its near-vertical band (a17ab8c5fd / 9598a6a50a / 6b200e64a7, 2015; still verbatim on upstream/main 6d5d8b1f07). Fix: `directionUpToHeadingPitchRoll` inverts setView3D directly (also repairs flyTo / flyToBoundingSphere), public getters untouched. Reviewer's independent sweep: 704,225 out-of-band cases bit-identical (max deviation 0); the lane's 'top-down flyToBoundingSphere unmoved' claim CORRECTED - it builds a rolled up and moves by <= 1.5e-10 rad post-fix vs up to 1.59e-6 pre-fix (never worse). B1: the `EPSILON20` branch threshold left a noisy window (za 1e-10..1e-7 rad, rolled up delivered up to pi wrong, 12,370/40,000 samples) -> `EPSILON12`: 0/40,000 bad, 0 differences vs EPSILON20 across 300,000 out-of-band cases, spec margins byte-identical; re-verified at the seat (stability worst up-error in the noise regime 1.98e-4 rad; live 14/14; mutant A 4/14; mutant B 9/14 with 3.1 rad). B2: the exact-vertical limit is a snap for the DIRECTION only, not for `up` (bound now stated). Four Jasmine cases authored, NOT yet run in Karma - executor `--includeName Camera` owed, plus diag-aim2 on both backends (edit its hard-coded renderer at line 11 for the WebGPU leg) and the eclipse-explorer telescope preset |
| Q-71b | NEW | after a now-correct near-zenith setView, `camera.heading` reports 270 deg where 90 is correct and `camera.roll` 0; feeding the getters back reproduces the 2.353628 deg symptom relocated into the getter round trip (getters keep the wide band because it is load-bearing top-down). Strictly better than pre-fix; a getter-side repair is its own row | Opus-judgment |
| R9A4 pass 3 | GO-FOR-2a (`_lane-d1-out/R9A4_REVIEW_PASS3_35859037.md`) | conservative projection rebuilt independently at 50,957 / 1,375 / 51e3f722 exactly; P24 images executed (clean GREEN; one-path-deleted RED 30 vs 29; swapped-path RED on the deep walk - detectors independent; if(false) GREEN under both = recorded kills; absence 5->4 tests); P17 wiring confirmed (gate call after the pin loop); P18 361/358/3 re-derived; non-carrier bases 574/584/575/643 unchanged. Non-blocking FIX G: two P25 conjuncts are vacuous (the absent-path check passes for any string incl. empty; 30+1===31 is two literals) - derive PRESENT_PATHS from a literal 31-path SUCCESSOR_PATHS and assert it includes the decomposition path (+5 LF, F3 carrier 815 -> 820, over by 18) - ADOPTED for round 2a; FIX H: the dense literal is 1,044 columns and defeats the line-oriented detector - dense form stays rejected. Round 2a executor DISPATCHED on the seat's brief; placement fill-in still BLANK (maintainer) |

### Clone drainage executed + three packets in review (2026-08-29 ~00:50)

| | Item | Disposition |
|---|---|---|
| DRAINAGE | 16 old clones, two-phase | Phase one (Opus, harvest only): all 16 archived under `cesium-webgpu-worker-archive/<clone>/2026-08-29/`, 15 evidence files repatriated into `Tools/visual-regression/output/` (6 collisions skipped - main's copy larger/later in every case), zero stashes, zero unreachable commits, report `DRAINAGE_INVENTORY_2026-08-29.md`. Phase two (seat, after per-clone re-confirmation: archive present, no stash, HEAD ancestor of main): 13 DRAINED clones DELETED (c11170, c16debug, c16grammar, lane11, profring, sol4fix, c16shard, cachefix, elev, enforce, metric, plan, tools), ~13 GB reclaimed. KEPT with unlanded work: `cesium-worker-sundisc` (C12-38 sun-disc transmittance split `solarDiscTransmittanceSplit` - the ONLY tree holding it; `sundisc2` stays frozen and un-entered), `cesium-worker-g6frame` (gsplat corner-reference class probe + `highAltitudeLabelFraming` - C15 gsplat lane, gated), `cesium-lane-verify` (`_c1_verify/` S3 163-family prototype census + R3 summary - editorial carry-in owed) |
| Q-65 | PACKET DELIVERED, in station-3 review | premise CORRECTED: the failing clear() is not on the healthy successor (that leg and the eight-getter rebuild are GREEN on pristine main) - it is the frame arriving DURING the ~1.4 s recovery window, where `WebGPUContext._isDeviceUnavailable` conflates recoverable loss with terminal and clear/draw/endFrame/copyTexture/beginFrame throw the terminal DeveloperError; the throw escapes Scene.render -> tryAndCatchError -> renderError -> CesiumWidget._onRenderError, which sets _useDefaultRenderLoop=false with no re-arm. Fix: decline branches at all five entry points + requestRender on recovery; second thrower `resolveModelCameraArenaOwner` (WebGPUModelRenderer.ts ~1507, non-pragma Error, release-build twin) repaired with its already-red contract pin. 7 files +112/-49; new spec 12/12, inertness mutant 5/7 (tests 2/3/4/8/9 fix-independent = the premise correction), 37 affected specs 1116/20 -> 1124/12 with 0 new failures. Harness defect found: frame-seams spec's truthy-Proxy stubs made isDeviceLost() truthy. Decisions for the seat: catalog regen (default: in the landing batch), createSync asymmetry (follow-up row), one redundant frame on recovery when requestRenderMode=false, disposition FIXED (Edge-pending) |
| Q-71 | PACKET DELIVERED, in station-3 review | premise CORRECTED: `constrainedAxis` not involved; the upstream heading/roll encoder's near-vertical band (acos 0.999 = 2.5626 deg) reads azimuth off `up` - right looking down, pi out looking up - so a near-zenith setView reflects through the zenith (2x the zenith angle). Fix in `CameraHelpers.js` inverts setView3D directly above EPSILON20 horizontal (also repairs flyTo/flyToBoundingSphere); getters untouched; 4 Jasmine cases (node mirror live 14/14, mutant A 4 fails, mutant B 9 fails with 4.119e-2 rad); 41,940-case out-of-band sweep 0 diffs. Karma run owed to the executor. Candidate Q-71b: `camera.heading` still reports the zenith-side azimuth pi out |
| CW2 | PACKET DELIVERED, in station-3 review | slice 1 (GGX glint + moonglade + night gate ported onto the globe water-mask ocean, BOTH classic and enhanced arms, plus the reduced GLSL twin; shared leaf `Scene/CelestialWaterReflection.js`; globe camera UB 232->244 floats, off = +0; WebGL off compiles upstream's shader exactly) + slice 1b (Q-73: FFT phase on `frameState.time`, frame-count fallback, `simulationEpoch`). No Sol verdict (halted 3x on the lane's own drift). Slices 2 (stars) and 3 (S5a) NOT started - S5a blocked on a bind-group layout change. API: `globe.oceanCelestialReflection` (both backends) vs `water.ocean.celestialReflection` (FFT, WebGPU-only) |
| R9A3 | AUTHORED, review pass 2 dispatched | `_lane-d1-out/R9A3_008cfa69.md`: three blocking fixes applied (2a carries P-1's provenance-core arm so the bindings are used; P15 inert form synthesized from SPEC_IMPORTS; re-frozen block goes to a successor R9B file, R9 never edited in place, P19 repository-qualified); all six owed repairs sized: +111 to the gate carrier; carrier matrix under G-ONE-B F1 815 / F2 825 / F3 810 (best, over by 8) / F4 878; G-ALL all breach; three families 912. R9A2's 'four families fit' WITHDRAWN post-repair. Ceiling that admits B: >= 1,348 at F3 (>= 1,353 at F1, ~1,398 for ~50 LF margin). Round 2a placement-independent; 2b has no authority until the maintainer's fill-in |
| R9A3 pass 2 | GO-WITH-FIXES (2026-08-29 ~01:20; `_lane-d1-out/R9A3_REVIEW_PASS2_89ef62da.md`) | two of three blocking fixes fully confirmed (landed-2a candidate lints clean under both wirings; P15 synthesized form GREEN; no residual in-place R9 assumption); all seven non-blocking confirmed; sizing reconciled to +116 vs +111 (the 5-LF seam: P-3's classifyIndividualCaps returns outcomes per R9 7 line 1100). Reviewer carrier matrix F1 820 / F2 830 / F3 815 (best) / F4 883; ceilings admitting option B: F3 >= 1,353, F1 >= 1,358, ~50 LF margin ~1,403 (plan on this conservative column). ONE remaining blocking fix -> R9A4 dispatched: P-1's walk targets a 31-path inventory whose 31st file only exists after 2b (live tree 30) - wired after the identity pin it lands inert; wired before it breaks P17. Fix = own top-level test for the walk, arity 30 in 2a widening to 31 in 2b, P17 clause amended, reached-and-green predicate with inertness image, P18 -> 361/358/3 (362/359/3 with P-18c) |
| R9A4 | AUTHORED (2026-08-29 ~01:40; `_lane-d1-out/R9A4_94a75532.md`), pass 3 dispatched | the blocking 30-vs-31 finding reproduced (live recursive ordinary paths 30; successor `p0b-parser-provenance-mutants.spec.mjs` absent) and discharged on the R9A2 6.2 pattern: `assertPrototypeEolIdentity` gets its own top-level test, the gate still calls it after the pin loop (3-occurrence canary), and two predicates added - P24 (walk reached and not inert; absence / inertness / one-path-deleted images) and P25 (inventory arity 30 in 2a widening to 31 at Freeze C, declared). P17 re-justified; P18 corrected to 361/358/3 (362/359/3 with P-18c). Two P-1 arm candidates projected, both lint/format clean: conservative 90 LF (51e3f722...) and dense 61 LF (reported, NOT recommended - a ~1,500-column literal is not a legitimate way to clear a ceiling). Author accepts the reviewer's +116; final table (plan on the reviewer column): F3 carrier 815 = over by 13; ceilings admitting B: F3 >= 1,353, F1 >= 1,358, ~1,403 for ~50 LF margin. Placement fill-in still BLANK (maintainer); round 2a may execute on its own predicates on a GO |

### R9A2 review pass 1 - RULING-NEEDED on placement; R9A3 dispatched (2026-08-29 ~00:20)

Review: `cesium-audit-proto/_lane-d1-out/R9A2_REVIEW_PASS1_6d14c7ee.md` (53,554 B / 880 LF / sha256 67677320...). Every one of the amendment's ~40 numeric claims reproduced EXACTLY under independently written probes (kernel 63/335; exclusives 46/433 + 48/490; the round-1 reviewer's core floor double-counted the 68-line gate that already sat inside the core exclusive, and its mutant floor missed the gate's 167-LF transitive cost; corrected two-family floors 787 / 1,014; four families under G-ALL 704/714/695/763 = headroom 98/88/107/39; G-ONE-B 583/570/638; three families 787/681/749; all five projections and twelve FIND-uniqueness checks; drift 4 prototype + 1 doc). The defects are predicate well-formedness and round scoping, not measurement.

| | Item | Disposition |
|---|---|---|
| PENDING MAINTAINER | RULING-NEEDED 1 - placement | R-2026-08-28-12 chose four families on the round-1 estimate of ~150 LF headroom apiece; measured it is 98/88/107/39, and R9's OWN owed repairs P-1 (75 LF prettier-clean floor; the 31-path inventory alone is an irreducible 33) + P-3 (net +27) land in the shared gate. Options with numbers: **A** four families G-ALL as preregistered - gate charged 4x, F4 -> 865, OVER by 63 (infeasible today); **B** four families with G-ONE-B as baseline + P-1 walk in F1 only - F1 806 vs 802, -4..+5 by density, four of six owed repairs still unsized; **C** three families - gate-carrying family 903, over by 101 (worse than four); **D** raise the 1,340 coupled ceiling to >= ~1,450 (reverses the 08-27 denial); **E** stop for a new design. Reviewer recommends B and asks the maintainer to rule the residual margin explicitly rather than discover it at Freeze C. The seat does NOT decide this. |
| BLOCKING author fixes | 3 | (1) round 2a would land an image failing its own P12 and firing P9 - the R9A1 EDIT 4 `readFileSync, readdirSync` bindings are unused until the 2b walk (eslint no-unused-vars x2 on both P13/P13a projections; created by R9A2's round split, omitted from its 6.7 disclosure); (2) P15 inert form (i) unsatisfiable (five-import fabricated string vs four-entry SPEC_IMPORTS under image A); (3) P11 (re-freeze the terminal block in 2b) contradicts P19 (R9 byte-identity re-asserted after every sub-round) - and P19 names a path without a repository: the canonical R9 exists ONLY in the clone, not in cesium-webgpu |
| non-blocking | 7 | FIND/REPLACE given in the review; two flagged items checked out clean (P18 360/357/3 vs P21 368/368 consistent; P8's slice control triple coherent); banked evidence the author did not use: the baseline TAP already records P0B-19's first failure as 'provenance line cap' at :1542 = 6.3's primary form |
| DISPATCHED | R9A3 author (same lane, context intact) | fixes 1-10 with re-executed projections; BOTH placements preregistered as named alternatives (A as R9A2, B = G-ONE-B baseline + F1-only walk, B marked recommended) with the maintainer's choice an explicit fill-in selecting which P10 binds; the four unsized owed repairs (P-5, P-6/D7, P-8, D4) sized to prettier-clean floors so option B's full charge against F1 is visible |

### Edge tranche 3c (2026-08-28 ~23:10 exit) - celestial legs + first compiles; evidence output/edge-tranche3c-2026-08-29/

| | Row | Disposition |
|---|---|---|
| GREEN | JOB 0 first compiles | 3/3, 0 page/GPU/console errors on six legs: GLSL `APPLY_NIGHT_LIGHTS` compiles and emits; `OceanSurface.wgsl` compiles with the celestial functions and renders; the 288/448-byte camera UBs draw clean. Live defaults confirmed: nightDarkness 0.15, enableNightLights true, nightIntensity 2.5 |
| GREEN | JOB 1 NV legs (4 green, 1 reframed) | shakedown reproduces the banked 79.2337 at the 0.0205% WebGL floor; opt-out = upstream globe at all 12 pins; city lights on-vs-off 16.69%/16.62% and WebGL lights-off vs the pre-1254 default 0.0152% (1254's only orbit-visible change IS the emission); street default 11.5077 byte-identical to 3a `-nd015`; app-managed stack darkens with zero layers injected; intensity 2.5->5.0 moves both backends within 1.6%. REFRAMED: cross-backend ON agreement at the WebGL floor was never achievable (backends differ 16.9-17.6% with night imagery OFF); the honest discriminator is meanAbs, where the ON pair (0.336987) matches the lights-off control (0.33862) - the emission adds no cross-backend divergence |
| GREEN | JOB 2 lunar disc + MoonLight | copper Moon observable on both backends (disc mean 6.49/6.51 at greatest vs 122.3/122.5 pre-eclipse; whole-disc R/B 36x vs 1.49; aim error 0.000000 deg). Leg (e) EXACT: MoonLight renders (pre-1248 it halted) and lightColor dims to 0.0451849 = 22.1x > 20x, bit-identical on both backends; SunLight control stays (1,1,1). NOT ESTABLISHED: the 0.0452 luminance ratio measured 0.0531 (97.71% coverage is threshold-dominated); leg (e) pixel half + leg (f) not run |
| GREEN (salvaged) | JOB 3 moonglade | first pass VOID - the same-settings anchor moved 66.08%, as much as the treatment; root cause `WebGPUOceanRenderer.ts:757` evolves the FFT surface on cache.frameNumber, not frameState.time. Frame-locked capture (frameNumber 46 on every page) gave a byte-identical control, then: enable float 1.044% / maxDelta 245 (GREEN), byte-identical off (GREEN), moon.show=false returns the ON frame byte-identically to OFF (GREEN, exact). Terminator sweep void / not re-run; phase sweep not run (new Moon below horizon at that site) |
| RED | JOB 4 Karma + contour dpr | Karma 1 failed of 7 (Q-75, FIXED in the worktree - re-run owed to the 3d executor). Contour dpr parity NOT EXECUTABLE (Q-74) |
| INTEGRITY | start/end md5 | 239c0642 -> db9467d9: `gulp test` rebuilt Build/ after the tip advanced 2fce3b9c8a -> d2c092c9b7 and after the 4096 skybox tier was staged uncommitted. Blast radius nil: every Job 0-3 capture preceded the rebuild; only Karma followed it. Rule stands: never rebuild while an executor runs - `gulp test` counts as a rebuild, so future executor briefs run Karma LAST or not at all |
| PREMISE | FFT ocean is WebGPU-only | the FFT ocean and celestialReflection have no GLSL twin, so the CW legs have no WebGL parity reference (WebGL confirmed flat, zero bright pixels). CW2's reduced GLSL moonglade twin (R-2026-08-28-11 sub-decision 2) is what creates one |
| Q-71 | NEW | `Camera.setView` reflects an explicit direction across `constrainedAxis` within ~1 deg of zenith; the error is exactly 2x the zenith angle (1.176814 -> 2.353627 deg). Breaks the shipped `eclipse-explorer` targeting flow for its own zenith presets | Opus-judgment |
| Q-72 | NEW (needs confirmation) | WebGPU produced no model-mask pixels at greatest where WebGL found the model (lunar leg) - reproduce before filing a fix lane | executor recipe first |
| Q-73 | NEW | FFT ocean time advances on frame count, not simulation time (`WebGPUOceanRenderer.ts:757` uses cache.frameNumber) - the surface is pinned-clock-invariant, which voids any same-settings capture that is not frame-locked, and decouples the ocean from the scene clock | Sol-bounded (Opus/Sonnet now) |
| Q-74 | NEW | elevation contour on a primitive draws no lines on either backend: WebGPU draws a uniform fill invariant to a 40x width change and to spacing (27057 px every time) and ignores `translucent`; WebGL draws nothing (`materialInput.height` is globe-only). Blocks pixel verification of Batch 1261; the globe path cannot substitute (its fabric hardcodes pixelRatio 1.0) | Opus-judgment |
| Q-75 | FIXED (worktree) | `WebGPUPrimitiveModelMatrixRTESpec.js:267` sliced the world-camera low half to `LIT_CAMERA_BYTES/4`, which moved 432->448 with the pixel-ratio tail, so the slice swallowed `[1,0,0,0]` against a 4-element expectation. Fix: bound the low half by `LIT_PIXEL_RATIO_OFFSET` and pin both lane widths at 4. Karma re-run owed (executor J0) | seat |

### C12 close-out lane landed + rulings R-12/R-13 (2026-08-29 ~01:15) - Batches 1263-1264

| | Row | Disposition |
|---|---|---|
| LANDED | C12X intake | close-out set with true blockers and owners recorded in the C12 queue: S3 cond. 2 has a MECHANISM (a display-encoded residue cannot dim by F; fog eliminated by the fixture's own pins; the cloud in-shader Reinhard + display-space lerp is the live instance) with a pre-registered exposure-sweep discriminator; EXIT-2 DISCHARGED (class audit 6/6 with lane-F landed); Q-61 re-confirmed not reproducing; two S5 instrument reds repaired (one was the same Q-60 defect SW2 landed - the landed version stands) |
| Q-69 | NEW | GlobeTerrain.wgsl subsequent-imagery-pass early return (~:4491) exits BEFORE the eclipse multiply, cast shadow and atmosphere block - with the night layer now default-ON the default globe plausibly gains a term an eclipse cannot dim | Opus-judgment |
| Q-70 | NEW | three S5 gates hash Shaders/GlobeFS.js (gitignored build output) - ENOENT on every fresh clone; and two S5 gates need >25 min (svs-footprint) / ~26 min (dense-cost) so bounded lanes misread timeouts as reds (the Q-61 origin). Narrow the provenance inputs or document the build prerequisite; give the long gates a stated budget | Sol-bounded |
| EDGE 3d | C12X jobs | E1 exposure-sweep discriminator (lane B deepest rung, two exposures; shadowContrastRatioAtDeepest must rise by a(F)=F(L+1)/(FL+1)); E2 SOL-4 refresh-cost depth-8 lane; E3 S5 matrix (dense-cost, multiview, replacement-device) with per-lane watchdogs above 25 min and a build preflight |
| RULED | R-12 / R-13 | R9: four families + exhibit-certification path first (R9A2 author dispatched). G3 re-bake DELEGATED under the runbook: seat downloads + bakes the 4096 tier, executor runs the G3 gate, maintainer keeps the eyeball + decision protocol |

### Late-evening landings + Edge tranche 3b (2026-08-29 ~00:30) - Batches 1252-1261

Landed: CW S0/S1 (1252/1253 - GGX sun glint + moonglade on the FFT ocean), NV (1254 - nightDarkness conditional default 0.15 + city lights default ON with a GLSL emission twin; 1255 seat repair), SW2 (1256-1261: Q-41 four wraps + the SceneRenderer release-build every-frame warn, Q-38d three floored-remainder sites, Q-60 at the right depth (the toString constants, not the gate), Q-52 private TMPDIR + decoy, Q-54 premise REFUTED -> timeout re-derived from measurement, Q-38b primitive camera pixel-ratio lane FLAT 272->288 / LIT 432->448). Sink A/B RESULT: -c project_doc_max_bytes=0 KILLS the governance sink (subject A first exec = target file; subject B without the flag spent its first eleven execs reading AGENTS.md and the governance chain) - the flag is now mandatory on every Sol dispatch.

| | Row | Disposition |
|---|---|---|
| DETERMINATION | C11-163 port target | under R-11 item 1: the default globe ocean is the CLASSIC arm (enableEnhancedOcean defaults false; the dossier was wrong), and the sun glint exists twice in GlobeTerrain.wgsl - the port lands on BOTH arms (lane CW2) |
| CORRECTED | star catalog size | BrightStarCatalog.count is 2,868 (STRIDE 4), not the 263 quoted from the Batch-313 inventory row - the splat design of R-11a is the only viable shape by three orders of magnitude |
| CONFIRMED | Q-46 | tranche 3b: genuine GPU-process loss crash 4-of-4 -> 0-of-4; attribution failuresOnDeviceMarkedLost 5 -> 0; blind window 1.4 s carrying only the two unavoidable pre-knowledge calls |
| Q-65 | NEW HIGH | successor to Q-46: recovery completes at DEVICE level (device #1 -> #3, healthy, gen 0 -> 1) but the render loop stops permanently with the terminal-loss DeveloperError from _WebGPUContext.clear - initialized=false, clusteredDispatcher=null, sky/cloud caches still on the dead device. 4 of 4. The post-recovery frame is the widget DOM over a black canvas. Also: the refusal sentinel never fires because nothing is attempted (assertion 5 of 1236 unobservable) | Opus-judgment, HIGH |
| CONFIRMED | Q-63 / VW-N7 L3 | level-3 onset re-measure GREEN (texel counts exactly doubled, band one level deeper, both backends exact). Q-63 blur band RELOCATED not removed: brightening flip unchanged at 500->340 km; peak moved 170 -> 85 km and grew +60 -> +94; 170 km is now the worst frame. Open lever: NIGHT_IMAGERY_FADE_FULL_TEXELS = 8 |
| Q-64 | NEW MEDIUM | night fade produces hard tile-level banding where adjacent terrain levels straddle the knee (42 km, both backends, 69.1% on-vs-off; layer-off twin clean) | Opus-judgment |
| Q-62 | MIXED | catalog reachable and physically correct (2,868 stars, Sirius within 6 px, Pogson liveness, WebGL/WebGPU byte-identical IoU 1.000; C12-11 harness A-G all true, exit 3 = prerequisites only) BUT the July twilight black box REPRODUCES exactly: sun -20 deg, vmag-2.14 box peaks 0.0 both backends, while the probe header documents a vmag-3.6 star anchoring at 15/255 - a sharp contradiction to investigate | Opus-judgment |
| Q-66 | NEW | Tools/lint-debug-pragmas.mjs scans Renderer/WebGPU only; every Q-41 site was in Scene/. First count: 106 unguarded console.* lines across 477 Scene/*.js files, mostly upstream sites needing triage not wraps. Rider on E1-3/E1-4 | investigate |
| Q-67 | NEW | Q-38b globe half OPEN: the fabric WGSL port (Material.js) hardcodes pixel ratio 1.0 and the globe surface camera UB has no pixel-ratio lane; PrimitiveMatGridFlat.wgsl also blocked on lifting logDepth out of its ifdef | Sol-bounded once designed |
| Q-68 | NEW | NV's unmasked emission carried exactly (WGSL reference): a masked layer still emits on both backends - both-backends follow-up; also globe-night-imagery-option F-section mutates GlobeNightImagery.js on disk while the fade spec asserts it unchanged (cross-spec race under the parallel runner) | Sol-bounded |
| DOCTRINE | executor + seat | never REBUILD while an Edge session runs (a mid-sweep build would split legs across two engines with no signal in the captures); the seat lands engine files during a sweep only because the executor serves the gulp artifact - the bundle md5 re-check at end of run is now required in every RUNLOG. Closeout inventories must include git stash list. Landing sequences chain commits on the gate EXIT CODE, never on a read of the output |

### Lane VF2 + R9 amendment author (2026-08-28 ~23:20) - Batches 1248-1250

| | Row | Disposition |
|---|---|---|
| FIXED (Edge-pending) | Q-56 | MoonLight is a real light on both backends (Batch 1248): world-space moon direction captured beside the eye-space one, non-negated light arm, shadow-camera arm; the Batch-1225 dimming arm is now REACHABLE and its spec honestly re-pinned. Edge leg: MoonLight scene light dims to 4.518% at greatest on the Porto Velho preset, both backends, enableLunarEclipse=false as the anchor |
| REFUTED -> PRESCRIPTION | Q-58 | probe-setup, not engine: a bare scene.render() renders at the WALL CLOCK interleaved with frozen-clock frames, so the diagnostic aimed 146 degrees off. Executable recipe pinned in moon-onscreen-oracle.spec (Batch 1249): pass the clock to every render, aim from the published sample at the position with geodetic up, 6-degree fov, re-aim after clock changes, count disc pixels not isMoonVisible, moon.show=false vacuity control |
| FIXED x8 | Q-55 | the leak was in EIGHT lazy getters, not two; one DeviceInvalidationSlot registry + onDeviceInvalidatedOnce (Batch 1250); a slot-collision mutant is caught only by the all-fields-nulled assertion |
| DOCTRINE | closeout inventory | the previous VF lane's engine edits were in a git STASH the shutdown inventory never checked - clone inventories must include git stash list; the stash is redundant with 1248 and is dropped at clone retirement |
| R9A | amendment authored | _lane-d1-out/R9A1_d0640778.md (45,697 B) with a 15-predicate reviewer pre-commitment block; REVIEWER dispatched (pass 1 = the preregistration itself). MATERIAL RISK for a ruling: the mutant family measures 1,030 lexical LF against an 802 allowance (228 over) before any repair line - a Freeze-C stop, not rescored; the stage-1 drift (R9A-02) is disclosed as the authorized preimage pending the reviewer's concurrence. Stage-1 packet banked in file form beside it |

### Edge tranche 3a (2026-08-28 ~22:40) - Batch 1239 pixel-confirmed on all six legs

| | Row | Disposition |
|---|---|---|
| CONFIRMED | Q-57 / VW-N7 | see the wave ledger row; before/after PNGs: visual-wave-acceptance-2026-08-28/webgl-midnight-street-on-nd1.png (cream wash) vs edge-tranche3a-2026-08-28/webgl-midnight-street-on-nd1.png (sharp scene) |
| Q-63 | NEW | least-legible altitude sits just ABOVE the fade band: on-vs-off luma flips from darkening to brightening between 500 and 340 km and peaks +60 at 170 km while the layer is still at fade 1.0 - an illegible blur where the off-control is a sharp regional view. Pre-existing (orbit byte-unchanged proves 1239 did not cause it). Batch 1244's deeper pyramid halves every altitude; the live question is whether NIGHT_IMAGERY_FADE_FULL_TEXELS = 8 is the right upper knee. Measure on the level-3 build before touching the knee | executor 3b, then Opus if the knee moves |
| NOTE | pyramid size bookkeeping | the ruled 455 KB is the JPEG payload of all 170 tiles (what a client downloads); the 829 KB seen on disk is filesystem cluster allocation over 170 small files. The size gate is about payload; 455 KB stands |

### Q-61 RESOLVED + star-reachability leg queued (2026-08-28 22:25)

| | Row | Disposition |
|---|---|---|
| RESOLVED | Q-61 | c12-29-s5-svs-footprint-gate is 57/57 on main post-1239 - the 47/1 in the dying VE clone was clone-environment, not the street fix. VE reconstruction bank deleted (landing was hash-verified) |
| Q-62 | NEW | bright-star catalog reachability: the July TWILIGHT-STAR-REACHABILITY-BLACK-BOX diagnostic (a mag-2.1 star box black at sun -20 deg, Batch 904) is still open; run probe-stars-catalog.mjs at the current tip on both backends in the next Edge tranche so the star field carries a fresh verdict before the water lane depends on it | executor, tranche 3b |

### Post-restart resume (2026-08-28 21:30) - codex session GC lands; VF stop-note corrected

CORRECTION to the stop record: lane VF was NOT near-complete. After the restart its clone holds
only three untracked specs (moonlight-scene-light, moon-onscreen-oracle,
pipeline-cache-invalidation-subscriptions) - no engine edit persisted. The specs are the
contract; lane VF2 re-implements against them (Q-56/Q-58/Q-55 stay OPEN). Lane SW2 resumes the
six unreviewed drafts plus Q-54/Q-38b and owns the project_doc_max_bytes=0 sink A/B.

CODEX SESSION GC POLICY (maintainer directive, replaces the wholesale wipe): Tools/
codex-session-gc.mjs scopes by the rollout session_meta cwd - only sessions under this
project's clone roots are ever candidates; other projects' history is reported as a count and
never touched (5 such sessions detected and preserved on first run). Procedure: every lane
packet lists the Sol session ids it created; after the batch lands AND pushes, the seat runs
--delete-ids over that list; a periodic --older-than 48 --delete sweep catches strays;
NON-TERMINAL sessions (no task_complete) are protected by default because they may hold
unharvested worker output, and are deleted only by explicit id once their salvage is landed
or abandoned. Deletion goes through codex delete <id> so the CLI index stays consistent.

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

