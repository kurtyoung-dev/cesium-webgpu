# Campaign 18 Queue — Voxel, Point Cloud & Splat Modernization (2026-08-09)

**Live execution queue and sole status authority for C18. Launched by
maintainer directive 2026-08-09** ("Work that is able to be approved should go
into a new campaign 18"). Source of truth for every claim below:
[VOXEL_POINTCLOUD_GSPLAT_AUDIT_2026-08-09.md](VOXEL_POINTCLOUD_GSPLAT_AUDIT_2026-08-09.md)
(parity audit + adoption survey) and
[REFERENCE_VISUALS_CATALOG_2026-08-09.md](REFERENCE_VISUALS_CATALOG_2026-08-09.md)
(license-vetted external references). Update this ledger at every completion,
pause, block, or deferral.

**Campaign numbering is ratified add-only.** C18 takes the next free number.
**Campaign 17 (Celestial Light Transport) remains PROPOSED and NOT LAUNCHED**
— it holds the C17 identity by ruling R-2026-08-10-7 ("CLT epic renumbers to
proposed C17") and its plan is
[CELESTIAL_LIGHT_TRANSPORT_PLAN_2026-08-07.md](CELESTIAL_LIGHT_TRANSPORT_PLAN_2026-08-07.md).
C18 launching before C17 does not renumber, launch, or reorder C17 in either
direction.

**Scope:** the three subsystems the audit covered — voxels
(`WebGPUVoxelRenderer` + `VoxelPrimitive` traversal/upload), point clouds (all
three paths: 3D Tiles PNTS→Model, `TimeDynamicPointCloud`→dedicated renderer,
`BufferPointCollection`), and Gaussian splats — **only where the audit ranked
the work as new, approvable, and not already owned by an open row.** Everything
already tracked stays where it is; see §4 Ownership boundaries.

## Binding contracts for every row

1. **Both backends where portable** (Principle 5). WGSL-only additive features
   are allowed under the C11-ratified governing principle (additive WebGPU is
   fine; parity items are not optional), but a shader feature with a portable
   GLSL twin ships both twins or states why it cannot.
2. **No feature is removed, default-disabled, bypassed, or visually degraded to
   improve a metric.** Performance rows carry a byte-identical-off gate.
3. **Probe-first** (Principle 8): every row's acceptance is an automated
   probe/capture-and-diff result, never a request that the maintainer reload
   and look.
4. **C16 comment standard** for all new code — no batch/campaign/tracker IDs in
   `packages/*/Source`; provenance lives in commit messages, `LICENSE.md` and
   `migration_doc/**`. The C16-00 marker guard enforces it on touched files.
5. **GPU timing is interleaved A/B in one run** (the `C13-39` closure doctrine).
   A count is not a timing — do not repeat the `C15-G4` substitution.
6. **No external code is derived from until its LICENSE file has been read
   verbatim** (the catalog's ✔ upgrade). See §6.

## Sequencing constraint — C16-10

`C16-10` (rewrite shard: splats, points, compute) will rewrite the embedded
WGSL and comments in **exactly these files** — the worst marker census in the
repo is `WebGPUVoxelRenderer.ts` 60 / `WebGPUPointCloudRenderer.ts` 29 /
`WebGPUGaussianSplatRenderer.ts` 22 (`QUEUE_2026-08-10_CAMPAIGN16.md`, `C16-R1`).
**Any C18 row touching those files lands either entirely before or entirely
after `C16-10` — never interleaved with it.** Interleaving guarantees a
comment-only-diff gate that cannot be satisfied and a rewrite shard that has to
re-census mid-flight. The orchestrator picks the side at dispatch and records it
in the row's status cell.

---

## 1. Wave V — verification honesty FIRST

The audit's §5 recommendation: this wave is the highest leverage per hour in
the entire campaign, because it re-arms trust in every claim the other waves
build on. **No Wave P or Wave A row starts before `C18-V1` lands** — building
on a gate that exits 0 on failure is how a green becomes unauditable.

| ID | Title | Scope | Acceptance (probe-verifiable) | Size | Deps |
|---|---|---|---|---|---|
| `C18-V1` | Probe verdicts must exit non-zero on GATE FAIL | Three probes print `GATE FAIL` and then exit 0 — no `process.exit` and no `process.exitCode` anywhere in the file: `probe-point-sprite-shape.mjs`, `probe-pointcloud-edl-parity.mjs`, `probe-timedynamic-pointcloud-load.mjs`. Give each a real exit code. **Discharges the OPEN `NEW-PROBE-VERDICT-PRINTS-FAIL-AND-EXITS-ZERO`** (`DEFERRED_WORK.md` near line 512) — that row is the authority for the finding; do not re-file it. Note the row's own caveat: adding a non-zero exit CHANGES the verdict a runner observes, so each probe's current standing result is re-read after the change and any newly-red leg is filed, not normalized. | Each of the three probes returns 0 on a passing run and non-zero on an injected gate failure, proven by a negative control per probe (deliberately falsified threshold ⇒ non-zero exit). Structural/indeterminate legs use the fleet's exit-3 convention with a named reason, per the exit-3 fleet ruling. | S | — |
| `C18-V2` | Capture-and-diff baseline scenes for all three subsystems | None of the three subsystems has a `capture-and-diff` baseline scene, so cross-backend certification is one-shot probe history instead of a continuously re-run gate. Add one voxel, one point-cloud and one splat scene to the split-screen baseline suite. **Discharges `VR-BASELINE-SCENES-VOXEL-POINTCLOUD-SPLAT`** (filed 2026-08-09). | `node Tools/visual-regression/capture-and-diff.mjs` runs all three new scenes on Edge and stores baselines; each scene's non-vacuity is proven by a source mutation that pushes its mismatch above threshold and is then reverted. Scene selection must exercise a path the existing probes do not (the splat scene rides the in-tree tilesets, not synthetic `_splatData`). | S | `C18-V1` |
| `C18-V3` | Re-arm freshness: re-run the stale voxel + point-cloud probe fleets at HEAD | Every recorded voxel run is 2026-07-02..17 and the point-cloud visual-parity numbers are 2026-07-01..02 — 3-5 weeks stale, against a tree that has since taken an upstream v1.144 sync. Re-run the 11-probe voxel fleet and the point-cloud fleet at HEAD on Edge, with the `C18-V1` exit codes live. Record dated results in the ledger. | Every probe in both fleets has a dated 2026-08 result at HEAD with an honest verdict. Any newly-red probe is FILED as its own row (or attached to the owning C11/C18 row) — a red is never normalized away, and a gate is never widened to accommodate one. | S | `C18-V1` |

**`C18-V1` LANDED — and the row's own count was wrong.** The three named probes
were fixed (0 pass / 1 gate fail / 3 structural with a named reason each), but a
static sweep of all 623 probes found **15** members of the class, not 3. The
twelve extra are `probe-classifier-logdepth-flip`, `probe-clipping-planes-parity`,
`probe-cloud-shadow-cascades`, `probe-flowfield-wind`,
`probe-globe-clippoly-geodetic`, `probe-hdr-canvas-output-decomp`,
`probe-hdr-toggle-invalidation`, `probe-model-capture-camera-parity`,
`probe-model-capture-reflection`, `probe-sandcastle-scene-capture`,
`probe-scene-capture-off`, `probe-tileset-capture-reflection`; each had its
printed verdict bound to an exit code, with no structural tier invented for it.
**The reason the original count was low is itself the finding:** the contract
analyzer's source scanner treated a regex literal's unpaired quote as a string
opener and went blind for the rest of the file, so constructs below such a regex
read as absent. That is fixed, and two fleet-wide anchors now hold with no
allowlist — a probe that prints a PASS/FAIL verdict must be able to leave with a
non-zero code, and the scanner must reach the end of every probe still reading
code. **Consequence for `C18-V3`:** fifteen probes will now report verdicts a
runner has never observed. A newly-red leg there is a finding to FILE, not to
normalize, and not evidence that this row broke something.

---

## 2. Wave P — point-cloud correctness

The weakest-verified of the three subsystems, and the one whose dominant
real-world usage (3D Tiles PNTS) silently loses features on WebGPU.

| ID | Title | Scope | Acceptance (probe-verifiable) | Size | Deps |
|---|---|---|---|---|---|
| `C18-P1` | Dedicated-path colour tint + gate de-normalization | `TimeDynamicPointCloud` renders 27-45% bright/blue with session-drifting magnitude (per-channel mean ratios ≈ R 0.78 / G 0.72 / B 0.69), and the standing sprite gate is **gain-normalized around the divergence** so its green does not certify colour. Fix the tint mechanism (the monotone same-session creep points at a time/adaptation-dependent stage — auto-exposure/tonemap interaction or the linear/gamma handling around the point-cloud draw — not at geometry), **then de-normalize the gate**. **Discharges `PARITY-POINTCLOUD-COLOR-TINT`** (promoted candidate → filed 2026-08-09). | The probe gates on the RAW ds4, not the gain-normalized one, and passes; per-channel gains land inside [0.97, 1.03]; seven consecutive same-session runs show no monotone creep (the drift signature is the mechanism's fingerprint, so its absence is the fix's evidence). | M | `C18-V1`, `C18-V3` |
| `C18-P2` | Dedicated-path colour format decode | The dedicated renderer decodes RGB-stride-3 only: RGBA is misread at stride 3, RGB565 renders white, `CONSTANT_RGBA` is ignored, and translucency is lost (always opaque). WebGL handles all four plus translucency. Implement the full decode set in the WebGPU dedicated path. | One fixture per format (RGB, RGBA, RGB565, `CONSTANT_RGBA`) plus a translucent asset; each renders cross-backend inside the gate; a per-format negative control (decode path swapped) turns exactly that format's leg red. | M | `C18-P1` |
| `C18-P3` | PNTS model path: attenuation + `pointSize` | All PNTS tilesets route through the Model pipeline, where WebGPU renders **fixed 1 px points** — the WGSL styling stage is orphaned and `pointCloudShading` attenuation/`maximumAttenuation`/`geometricErrorScale` are silently ignored. Wire the quad-expansion path (the scaffolding is recorded do-not-remove in `DEFERRED_WORK.md` near line 9285 — Principle 7 applies, finish it rather than route around it). | On a PNTS tileset, varying `pointCloudShading.maximumAttenuation` changes the WebGPU rendered footprint and matches WebGL within the gate at three camera distances; with `pointCloudShading` disabled the frame is byte-identical to pre-change. | M | `C18-V2` |
| `C18-P4` | PNTS model path: EDL routing (the silent no-op) | Tileset eye-dome lighting is **silently inert** on WebGPU — only `_edlSource`-tagged commands are recorded by the EDL processor, so `pointCloudShading.eyeDomeLighting` changes nothing and warns nothing. Route the model-path commands through the existing offscreen EDL path (which is already near-parity on the dedicated path). **`C18-P3` + `C18-P4` together discharge `PNTS-MODEL-PATH-EDL-INERT`** (filed 2026-08-09, an L cluster row). | Enabling `eyeDomeLighting` on a PNTS tileset changes WebGPU pixels and matches WebGL within the gate; a counter proves the tileset's commands are actually recorded by the EDL processor (the inertness canary — a pixel test alone cannot distinguish "inert" from "subtle"); OFF leg byte-identical. | M | `C18-P3` |
| `C18-P5` | Dedicated-path Draco: the silent permanent hang | A Draco-compressed `TimeDynamicPointCloud` **never renders and never reports ready** on WebGPU — the dedicated path lacks the decode step the model path has, and there is no error surface at all. **Discharges `POINTCLOUD-TIMEDYNAMIC-DRACO-HANG`** (filed 2026-08-09). | A Draco-compressed `TimeDynamicPointCloud` reaches ready and renders on WebGPU at cross-backend parity within the gate; the probe asserts readiness under a bounded timeout so a regression to the hang fails loudly instead of silently; the shared CPU decode is reused, not forked. | M | `C18-V1` |

**Recorded but deliberately NOT rowed here.** The audit's §2b table also shows
`normalShading` / `backFaceCulling` unsupported on the dedicated path (no
normals in the 40-byte layout). It is neither in the audit's ranked §3 gap list
nor in its §4 adoption list, and it has no tracked row anywhere. It is named
here so it is not lost; filing it is a separate intake decision, not a C18 row
invented at queue time.

---

## 3. Wave A — additive adoption

From the audit's §4 ranked payoff/cost list. All rows are additive
(WEBGPU-EXCEEDS or lossless), which is what makes them approvable without a
parity ruling. Sizes and acceptance criteria below are the audit's own where
the audit authored them.

| ID | Title | Scope | Acceptance (probe-verifiable) | Size | Deps |
|---|---|---|---|---|---|
| `C18-A1` | Continuous LOD (CLOD) keep-function for the point-cloud GPU LOD layer | Replace the 4-band decimation in `PointCloudLOD.wgsl` with a continuous `keep = hash(id) < f(dist)` keep-function, killing band-boundary popping. WebGL has no LOD layer at all, so this is purely additive WEBGPU-EXCEEDS work — parity-principle clean. | Camera-dolly probe asserting no kept-set discontinuity at the former band radii, plus a negative control that restores the bands and makes the discontinuity reappear. | S | — (self-contained; honours the `C16-10` sequencing rule) |
| `C18-A2` | Voxel empty-space skip via per-slot min/max occupancy | The march fixed-steps the whole volume; per-atlas-slot occupancy metadata lets it skip empty bricks. Lossless — no visual change, so the performance principle is satisfied by construction. The occupancy data is a by-product of the brickmap/page-table generalization, which is **`C11-100`'s implementation vehicle and stays recorded there**. | Interleaved-A/B GPU timing (the `C13-39` doctrine — one run, both legs, never across builds) on a sparse asset showing a real march-cost drop, plus byte-identical output on a dense asset where nothing is skippable. | S-M | `C11-100` (coordinated dependency — C18 does not own it) |
| `C18-A3` | Multi-scale EDL | Assemble a multi-scale eye-dome-lighting response from pieces already landed (the r32float EDL FBO on the dedicated path). Both backends where portable. **Explicitly gated behind Wave P and Wave V**: do not build atop a divergent, unauditable colour baseline. | Extended EDL parity probe with **real exit codes** (i.e. post-`C18-V1`), cross-backend within the gate at two scales, OFF leg byte-identical. | S | `C18-P1`, `C18-V1` |
| `C18-A4` | Ambient occlusion over EDL depth | Layer the existing AO effect over the EDL depth target (GBuffer-normals-from-depth already exists), giving point clouds contact shading without a normals attribute. | Same extended EDL parity probe with the AO leg added; AO-off byte-identical; cross-backend within the gate where the AO effect is portable. | M | `C18-A3` |
| `C18-A5` | Two-pass u32 compute point rasterization behind the existing count threshold | The scale unlock for 100M+ points. Single-pass Schuetz-style rasterization is **impossible** on browser WebGPU (no 64-bit atomics), so this is the two-pass u32 form, reusing the existing SOA buffers, scan/compact and count-threshold gate. | Parity vs the quad path at the threshold boundary (the frame either side of the switch matches within the gate) plus interleaved perf A/B in one run. | M-L | `C18-A1`; **FORK-41 / `C11-98`** HiZ + sort-key consumer wiring (cross-reference — that work stays tracked where it is) |
| `C18-A6` | Ray-guided residency feedback for voxel streaming | Atomic miss-flags plus a readback ring (patterns already proven in the GPU culler) feeding the existing demand ladder, so the streamer loads what the march actually asked for. Requires convergence-frame scheduling under request-render mode. | *(Acceptance authored at queue time — the audit ranked this item but did not author a criterion.)* At a fixed camera the residency set converges within a bounded frame count and the converged frame is byte-identical to a fully-resident capture of the same view; a negative control that suppresses the miss-flags leaves the frame coarse, proving the feedback path is load-bearing; request-render mode demands frames only while unconverged. | S-M | `C11-100` (brickmap vehicle — coordinated dependency) |

---

## 4. Wave S — splat rows, GATED post-`C15-G8`

**These rows execute in the C15 G-track lane** — the gsplat track queued by
maintainer ruling **R6** (`DEFERRED_WORK.md` RULING-2026-08-06), which is a
separate lane sharing the C15 queue document and is explicitly **NOT under the
R4 aurora hold**. **`QUEUE_2026-08-02_CAMPAIGN15.md` §6 remains the sole
authority for `C15-G0..G8`**; nothing here re-plans, re-scopes or re-sequences
a G row.

**Activation condition:** every G row carries a byte-identical-WebGL-off gate
until the terminal gate closes, so a C18 row that changes splat output cannot
be certified before then. **`C18-S1..S4` activate only when `C15-G8` closes.**
`C18-S0` is the exception — it is a license-verification pass with no engine
change, it is **not** gated by G8, and it must complete before any G-derived or
C18-S work borrows externally.

| ID | Title | Scope | Acceptance (probe-verifiable) | Size | Deps |
|---|---|---|---|---|---|
| `C18-S0` | **DONE 2026-08-09** — dedicated license-verification pass over the gsplat ecosystem. **Result: 20 projects vetted; Mip-Splatting AND StopThePop both carry the Inria research-only licence byte-for-byte, so `C18-S2` is clean-room-from-paper MANDATORY; `C18-S1`/`C18-S4` need no external reference and `C18-S3` needs at most one (GPUSorting, MIT).** Full record: [`GSPLAT_REFERENCE_VETTING_2026-08-09.md`](GSPLAT_REFERENCE_VETTING_2026-08-09.md) | The reference catalog's honest §3 gap: **zero vetted gsplat candidates exist** — the whole ecosystem (antimatter15/splat, mkkellogg/GaussianSplats3D, PlayCanvas supersplat, and the Mip-Splatting / StochasticSplats research implementations) has never had its LICENSE files read verbatim by this fork. Run the L-xx determination process over it: fetch and read each LICENSE file verbatim (never a paraphrase — the L-24 lesson), record a numbered determination, and pre-register the survivors in this queue's §6 table. **No engine change.** | A determination row per candidate in `LICENSE_DETERMINATIONS_2026-08-10.md` with the licence text quoted from the fetched file, a USABLE / FILE-COPYLEFT / STUDY-ONLY / UNKNOWN verdict, and the §6 table below updated from △ to ✔ (or the reference struck). A row that stays UNKNOWN blocks derivation from that project, full stop. | S | — (not gated by `C15-G8`) |
| `C18-S1` | SH distance-band truncation | Evaluate spherical harmonics at degree 1 far / degree 3 near through the **backend-neutral `applySphericalHarmonicsBudget` seam** — the `C15-G5` option-(a) precedent, where both backends degrade together by construction. Cuts the tower asset's 8.6M-word SH buffer traffic and VS ALU at globe zoom-out. Quality-preserving at the near band; a distance-graded budget, not a feature removal. | Parity-harness near/far azimuth legs identical cross-backend, plus byte-identical-off. | S | `C15-G8`, `C18-S0` |
| `C18-S2` | Mip-Splatting opt-in (both backends) | Both backends currently ship vanilla +0.3 dilation with no compensation, which aliases and over-brightens distant splats — the globe-critical splat quality item, since a geospatial camera spends most of its time far from the asset. Shader-only, portable across GLSL and WGSL, **default-off**. | Cross-backend parity with the feature ON at both gate assets, plus off-gate byte-identical on both backends. | S-M | `C15-G8`, `C18-S0` |
| `C18-S3` | GPU radix sort for splats | Removes sort-staleness popping during fast slews (the current throttle is ~0.5° / 1 m / 3 frames). Subgroups now ship and are already auto-requested. WebGPU-side performance path; WebGL keeps the shared worker sort — the orders converge, so there is no visual divergence. **Discharges the `WEBGPU_MIGRATION_BACKLOG.md` §11 "Gaussian Splat sort — radix sort on GPU" item** (near line 799), which `C15-G4` named as an explicit non-goal until now (`QUEUE_2026-08-02_CAMPAIGN15.md` §6d) — cross-reference both, do not re-file. | Frozen-camera index byte-equivalence versus the worker sort, **plus interleaved A/B timing in one run** — do not repeat the `C15-G4` count-for-timing substitution. | M | `C15-G8`, `C18-S0` |
| `C18-S4` | Splat `splitDirection` | The WebGL vertex shader discards across the split line; the WebGPU renderer and WGSL have no equivalent, so `ImagerySplitter`-style comparisons show splats on **both** sides. **Discharges `GSPLAT-SPLITDIRECTION-MISSING`** (filed 2026-08-09; the filing itself calls it a natural post-G8 G-track rider). | Split-screen probe: with `splitDirection` set, splats appear on exactly one side on WebGPU and match WebGL's discard boundary; `splitDirection` unset ⇒ byte-identical to pre-change. | S | `C15-G8` |

---

## 5. Ownership boundaries — work that stays where it is

C18 rows **must not duplicate, re-file, or renumber** any of the following.
They are listed as coordinated dependencies so a C18 dispatch reads them first.

| Owner | What it owns | Why it is not a C18 row |
|---|---|---|
| `C11-13` (P0, W1) | Voxel camera-inside-volume renders BLACK (`NEW-VOXEL-INSIDE-CAMERA-BLACK`) | The audit's #1 user-impact gap, already a P0 in the C11 W1 wave. C18 adds nothing; running it earlier is a C11 scheduling call. |
| `C11-100` (P1, W7, XL, sliced) | Voxel octree depth > 3, non-BOX refinement root-only, L3 LRU (`PARITY-VOXEL-OCTREE-TRAVERSAL`) | The audit's brickmap / per-level page-table candidate is **`C11-100`'s implementation VEHICLE**, recorded there, not a new ID here. `C18-A2` and `C18-A6` consume its output. |
| `C11-86` (P2, W7, L) | Per-point GPU style-expression → WGSL compiler | The third limb of the PNTS model-path composite loss. `C18-P3`/`C18-P4` fix attenuation and EDL; **style expressions remain C11-86** — cross-reference only. |
| `C11-108` (P2, W7, M) | Voxel user `customShader` residuals — upstream GLSL, uniforms and colorMap all silently gray (`VOXEL-USER-CUSTOMSHADER-RESIDUALS`) | Tracked and scoped in C11. |
| C11 W7 voxel API cluster `C11-100..C11-108` | clippingPlanes, time-dynamic keyframes, `levelBlendFactor`, ortho camera, vertical exaggeration, depthTest ray-clip, `stepSize`, events/statistics/debugDraw | The audit's gap #8 (L cumulative). Per-feature coverage is confirmed **at C11 intake** against `FEATURE_INVENTORY.md`; no new IDs are needed where rows already exist. |
| **FORK-41** / `C11-98` (P2, W7, M) | Hi-Z occlusion + `PointCloudSort` / `GPUSortKeys` consumer wiring | `C18-A5` depends on it and cross-references it; the wiring itself stays tracked in FORK-41 and `FEATURE_INVENTORY.md` §D. |
| `C15-G0..G8` + `C15-GSPLAT-TOWER-FRAME-VARIANCE` | The entire gsplat WebGPU track and its terminal parity gate | `QUEUE_2026-08-02_CAMPAIGN15.md` §6 is the authority. Wave S rides that lane's order and activates at G8. The tower frame-variance class is under the R-7 30-batch escalation clock and is not re-litigated here. |
| `C16-10` | Comment/WGSL rewrite shard over these exact files | See the sequencing constraint at the top. C18 does not do comment remediation; C16 does not do behaviour changes. |

---

## 6. Reference pre-registration (2026-08-09)

The catalog's §4 process recommendation: pre-register references in the plan
document **before** any implementation batch derives from them, so licence
verification is a plan-time gate rather than a landing-time scramble.

**Legend:** ✔ = licence file read verbatim this pass; △ = repo-declared only,
**MUST be upgraded to ✔ at intake before any file-level reuse**; STUDY-ONLY =
techniques only, never copy code.

**Status for Campaign 18: EMPTY BY EVIDENCE, not by omission.** The reference
catalog surveyed atmosphere/celestial, planet/space, weather/cloud,
water/ocean, bathymetry/terrain and environment-effects ecosystems. **It found
no vetted external reference for voxel rendering, point-cloud rendering, or
Gaussian splats** — the gsplat gap is recorded explicitly in its §3
("zero candidates in this sweep... needs its own dedicated license-verification
pass"). Therefore:

- **No Wave V, Wave P or Wave A row derives from an external project.** They
  are in-tree correctness and in-tree additive work.
- **`C18-S0` IS the pre-registration pass for Wave S**, and it has now run — see
  immediately below. It populated the table with two ✔ rows and **struck two
  candidates outright**. No `C18-S1..S3` row may borrow from anything absent
  from that table. Wave S remains implement-from-technique (the house norm),
  with every derivation site carrying a `Reference:` block and a numbered L-xx
  determination — the difference is that this is now a conclusion backed by read
  licence text, not a placeholder pending verification.

**`C18-S0` RAN 2026-08-09.** Twenty projects surveyed, licence artifacts fetched
and transcribed literally; the full record — candidate table, Inria
provenance-chain verdicts, honest gaps and per-row recommendations — is
[`GSPLAT_REFERENCE_VETTING_2026-08-09.md`](GSPLAT_REFERENCE_VETTING_2026-08-09.md).
**The headline is a constraint, not a shopping list:** the two references that map
most directly onto Wave S — `autonomousvision/mip-splatting` and
`r4dl/StopThePop` — **both carry the Inria/MPII "Gaussian-Splatting License"
byte-for-byte** ("The *Software* may be used \"non-commercially\", i.e., for
research and/or evaluation purposes only"), which cannot be reconciled with an
Apache-2.0 engine. The pass's standing rule: **every splat repository whose
`LICENSE` opens with `Gaussian-Splatting License` is research-only, whoever's
name is on the paper.** The result is that Wave S stays implement-from-technique
by evidence rather than by default — three of its four rows need no external
reference at all.

| Name | Ecosystem | Licence (as recorded) | Author | What it guides |
|---|---|---|---|---|
| aras-p/UnityGaussianSplatting | Unity HLSL | **MIT** ✔ `Copyright (c) 2023 Aras Pranckevičius` | Aras Pranckevičius | `C18-S1` — SH quantization/bit-budget ladders, **only if** the row grows a bit-budget dimension. The distance-graded band LOD itself has no reference anywhere. |
| b0nes164/GPUSorting | HLSL / CUDA | **MIT** ✔ `Copyright (c) 2024 Thomas Smith` — ⚠ multi-part LICENSE, one bundled component (bb_segsort) is **LGPL-2.1** | Thomas Smith | `C18-S3` — OneSweep / DeviceRadixSort digit-pass structure, as a **structural cross-check only**: it contains no WGSL, so it cannot be a porting source, and nothing may be read from the LGPL component. |
| autonomousvision/mip-splatting — **STRUCK, research-only** | research | **Gaussian-Splatting License** (Inria + MPII) ✔ | Yu, Chen, Huang, Sattler, Geiger | `C18-S2` — **struck as a code reference.** Derive from the paper only: *Mip-Splatting: Alias-free 3D Gaussian Splatting*, CVPR 2024, arXiv:2311.16493. |
| r4dl/StopThePop — **STRUCK, research-only** | research | **Gaussian-Splatting License** (Inria + MPII) ✔; the MIT carve-out sits inside a fork of the Inria rasterizer and stays UNKNOWN | Radl, Steiner, Parger, Weinrauch, Kerbl, Steinberger | Not pre-registered for any row. If hierarchical per-pixel resort is ever wanted it is a separate row, clean-room from arXiv:2402.00525. |

**Rows needing no external reference at all**, per the vetting doc §5:
`C18-S1` (the `applySphericalHarmonicsBudget` seam already exists in-tree),
`C18-S3` (the Onesweep algorithm is published and `DecoupledLookbackScan.wgsl` —
`L-18` — already provides the decoupled-lookback primitive), and `C18-S4` (a WGSL
port of the fork's own `PrimitiveGaussianSplatFS.glsl` discard).

---

## 7. Non-goals — recorded so they are not re-proposed

- **Ray-traced 3D Gaussian splatting.** No WebGPU ray-tracing API exists.
- **4DGS / animated splats.** Already out of scope per the G-track's own
  non-goals (`QUEUE_2026-08-02_CAMPAIGN15.md` §6d).
- **SOG loader.** Outside the 3D Tiles container this fork gates on.
- **Single-pass 64-bit-atomic Schuetz point rasterization.** Blocked by the
  absence of 64-bit atomics in browser WebGPU; `C18-A5` is the two-pass u32
  form, which is the only reachable variant.

**Watch — surveyed, ranked, deliberately NOT queued** (revisit at C18 intake or
a later campaign, do not treat as approved work): SPZ-4 loader compatibility
check (S); StochasticSplats sort-free spike — UPGRADED 2026-08-09: Gaussian Point Splatting (BSD-3, see reference pre-registration) is the named primary candidate; StochasticSplats was never license-vetted (M-L, post-G8, fits the existing
STBN + TAA infrastructure); temporal half-res voxel march reusing the cloud
reconstruction (M); NanoVDB ingest (M-L, strategic); 2DGS (asset-ecosystem
gated); LiDAR-surfel rendering through the splat renderer (M, post-G8).

---

## 8. Ledger

| ID | Wave | Size | Status |
|---|---|---|---|
| `C18-V1` | V | S | **DONE** — 15 probes fixed, not 3 (see the row); fleet-wide anchor + scanner-blindness fix landed; spec 32 → 47 tests |
| `C18-V2` | V | S | PENDING |
| `C18-V3` | V | S | PENDING |
| `C18-P1` | P | M | PENDING |
| `C18-P2` | P | M | PENDING |
| `C18-P3` | P | M | PENDING |
| `C18-P4` | P | M | PENDING |
| `C18-P5` | P | M | PENDING |
| `C18-A1` | A | S | PENDING |
| `C18-A2` | A | S-M | PENDING — coordinated with `C11-100` |
| `C18-A3` | A | S | PENDING |
| `C18-A4` | A | M | PENDING |
| `C18-A5` | A | M-L | PENDING — cross-refs FORK-41 / `C11-98` |
| `C18-A6` | A | S-M | PENDING — coordinated with `C11-100` |
| `C18-S0` | S | S | **DONE — 2026-08-09.** 20 projects vetted, licence artifacts transcribed literally. Mip-Splatting + StopThePop are both Inria research-only ⇒ `C18-S2` is clean-room-from-paper MANDATORY; `C18-S1`/`C18-S4` need no external reference, `C18-S3` needs at most one (GPUSorting, MIT, LGPL component excluded). Record: [`GSPLAT_REFERENCE_VETTING_2026-08-09.md`](GSPLAT_REFERENCE_VETTING_2026-08-09.md) |
| `C18-S1` | S | S | PENDING — **GATED post-`C15-G8`** |
| `C18-S2` | S | S-M | PENDING — **GATED post-`C15-G8`** |
| `C18-S3` | S | M | PENDING — **GATED post-`C15-G8`** |
| `C18-S4` | S | S | PENDING — **GATED post-`C15-G8`** |

**Recommended execution order** (the audit's §5, adapted to this queue): close
the splat tail in the C15 G-track lane (it is the cheapest path to one fully
certified subsystem and it discharges the standing R-7 escalation clock); in
parallel run `C18-V1 → C18-V2 → C18-V3`, then `C18-P1 → C18-P2` and
`C18-P3 → C18-P4` (`C18-P5` is independent and can ride any slot); start
`C18-A1` and `C18-A2` immediately since both are self-contained and additive;
~~`C18-S0` can run at any time and should run early, because its answer bounds
how Wave S is implemented~~ — **`C18-S0` ran 2026-08-09 and its answer is now
recorded in §6.** `C11-13` (P0) stays a C11 dispatch and is the single
highest user-impact item this audit found.

## Reference pre-registration additions (2026-08-09, SIGGRAPH 2026 scout)

Legend per the reference catalog: ✔ license verbatim-read; STUDY-ONLY = techniques/paper only, never copy code.

| Reference | License | Author | Guides |
| --- | --- | --- | --- |
| Gaussian Point Splatting (TOG/SIGGRAPH 2026) | BSD-3-Clause ✔ (independent implementation — no Inria lineage; vendored /packages unaudited, re-check at intake) | Joris Rijsdijk, TU Delft | PRIMARY candidate for the sort-free splat direction (Wave S adjacent, post-`C15-G8`); the two-pass/packed-u32 adaptation is required — WGSL has no 64-bit atomics, and the recorded single-pass non-goal STANDS |
| RaDe-GS closed-form splat depth/normals (TOG 45) | **STUDY-ONLY** — code is Inria/MPII non-commercial; clean-room from arXiv 2406.01467 only | Baowen Zhang, HKUST | The `C15-G7`/depth-composite problem space (splat-vs-globe z, pickPosition); registered BEFORE anyone needs it per this queue's own rule |

