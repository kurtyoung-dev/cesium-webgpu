# Research Dispatch Queue — Design-Model Perf, Earth at Night, and the Meshlet / Mesh-Shading Track (2026-08-29)

**What this document is.** The **dispatch order** for every row produced by the two research tasks that reported on 2026-08-29 — the AEC design-model performance lane (Treebeard, reviewed by Cirdan) and the Earth-at-Night lane (Quickbeam, reviewed by Celeborn) — plus the mesh-shader / meshlet / 3D-Tiles-extension track the maintainer asked for in the same breath:

> "package all of our findings from both research tasks into batches and queue them up next for our tiered workers. Include meshlets and 3dTile meshlet support. First lets look at creating mesh shaders to support meshlet rendering, then we can meshlets. 3dTile meshlets will likely need to be an extension."

**Authority — read this before citing anything below.**

1. **This queue is the dispatch order, not the status authority named below.** It says what is dispatched, in what sequence, at what tier, and which gate applies; landed and closed DX rows remain as add-only historical inventory rather than executable work.
2. **The live ledger [`FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md`](FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md) remains the sole status authority for every `Q-` id.** `Q-141`–`Q-150`, `B1 (demo)`, `C1`–`C7`, the `AEC demo flags` umbrella and the five Earth-at-Night maintainer questions are recorded there at lines **117–125** and **132–136** (re-read 2026-08-29 — `:126` is a blank line and `:127`–`:131` are the Cirdan section and table headers, so the older “116–136” range was loose). Line **`:116`** is a different row: the **INCIDENT** that produced `Q-145`. Where this document and the ledger disagree about a `Q-` row's **status**, the ledger wins. Where they disagree about **order**, this document is the proposal and the maintainer's ruling wins.
3. **This document does not launch, rule, schedule or fund a row.** Landed and closed entries carry results from their cited commits; listing them here grants no execution authority. Nothing was measured for this document.
4. **Campaign numbering is ratified add-only.** C17 (Celestial Light Transport) is **PROPOSED and NOT LAUNCHED** and holds the C17 identity; C18 is launched. The meshlet track is therefore filed as the **`MS-` wave of the Phase-8b GPU-resident-tiles program** — the placement ruling **M2** already ratified — *pending the maintainer's placement ruling* (gate **M-16**), which may instead give it a launched campaign identity. Three placements are live and the maintainer picks one:
   - **(a) A wave inside the Phase-8b GPU-resident-tiles program**, `MS-` prefix retained. This is what ruling **M2** already ratified verbatim — "inside the Phase-8b GPU-resident-tiles program" (`MESHLETS_RESEARCH_2026-07-24.md` §6a, re-read 2026-08-29). Phase-8b has a design document and no launched queue, so this placement gives the rows a home but no status authority.
   - **(b) Campaign 19**, the next free number after C18, leaving C17 reserved. It buys a launched identity and a status authority of its own. `D3`'s own **G-A** recommendation is **(a) — it is what M2 already ratified; (b) only if the maintainer wants a launched campaign identity**, and **this document is written against (a)**: the `MS-` rows are a Phase-8b wave needing no new campaign number, §6 is titled accordingly, and (b) is recorded as **M-16**'s alternative under D3's exact condition.
   - **(c) A new wave inside C18.** Available, and **argued against** by C18's own ownership table (`QUEUE_2026-08-09_CAMPAIGN18.md:284-302`, re-read 2026-08-29), which mints **no** meshlet ID and deliberately keeps FORK-41 / `C11-98` / `C11-100` where they are. C18's scope is voxels, point clouds and splats; a triangle-mesh cluster track is not that subsystem. If (c) is chosen anyway, that ownership table must be amended in the same landing.
5. **The meshlet track's implementation rows are HELD by a ratified launch gate** — ruling **M6**'s `C11-168` dense-tileset lane, which is **NOT satisfied** (`QUEUE_2026-07-18_CAMPAIGN11.md:2003`, re-read 2026-08-29: "W1 — PARTIAL / VALID CAUSAL DEFICIT, ROOT CAUSE OPEN"). `Q-143` in Wave 1 is the run that begins to satisfy it.

**Sources.** Every row traces to a memo section or a research note, named in its `Source` field. `D1` = design-model rows draft (over Cirdan's memo `cesium-lane-treebeard/_lane-out/REVIEW_DESIGN_MODEL_PERF_CIRDAN.md`); `D2` = Earth-at-Night rows draft (over Celeborn's memo `cesium-lane-quickbeam/_lane-out/REVIEW_EARTH_AT_NIGHT_CELEBORN.md`); `D3` = meshlet track draft; `R1` = mesh-shading standards status; `R2` = fork meshlet plan; `R3` = 3D Tiles / glTF meshlet extension landscape. **Memo and audit sentences are leads, not premises** (Principle 10): every `file:line` reproduced in a brief is re-read at brief-writing time.

---

## 0. Legends

### 0.1 Executor tiers — exactly one per row

| Tier | Shape | The brief must carry |
|---|---|---|
| **SONNET-BOUNDED** | one deliverable, one or two files, no cross-file judgement | the **observable behaviour to assert** and the named **inertness mutant** |
| **SOL-DIRECTED** | bounded, seat-driven: excerpts pasted via stdin, read-only sandbox, region-replacement output, scratch cwd with no `AGENTS.md`/`.agents`. Pure functions, specs, small tools | the method, never the answer; the seat verifies every claim before it touches a tree |
| **OPUS-JUDGMENT** | cross-file engineering, root-causing, anything touching parity or a ratified ruling | the coupled artifacts by path, the ruling text, and the negative control |
| **OPUS-EDGE-EXECUTOR** | browser measurement tranche | the runbook in §7: one Edge job at a time, `--serve-built` with served-md5 == disk-md5, the `Q-145` origin rewrite, Playwright **element** screenshots, interleaved A/B, multi-metric |
| **OPUS-REVIEW** | station-3 | **always a different agent from the author.** Re-derives premises; never relays them |

Every engineering row additionally owes a separate **OPUS-REVIEW** dispatch before landing. That is a standing obligation, not a per-row tier, and it is not restated in each card. `MS-14`, `MS-19` and `MS-26` carry OPUS-REVIEW as their **own** tier because the review *is* their deliverable.

### 0.2 Standing rules, referenced by id

| id | Rule | Authority |
|---|---|---|
| **SR-1** | Never remove, default-disable, bypass or visually degrade a feature to win a metric. Containment is correctness work, not a perf win. | `CLAUDE.md` §Active Remediation Campaign |
| **SR-2** | Renderer-agnostic features ship on **both** backends; a shader feature needs WGSL **and** GLSL unless architecturally impossible. | `CLAUDE.md` Principle 5 |
| **SR-3** | C16 comment standard — no batch/campaign/tracker IDs in `packages/*/Source`; JSDoc-clean; derived code attributed. | `CLAUDE.md` §Campaign 16 |
| **SR-4** | `ShaderDefine` / `ShaderDefineHi` / `ShaderSourceId` / `FeatureRendererKey` entries are **add-only** — never reordered, renumbered or removed. | `CLAUDE.md` §WGSL Shader Pipeline |
| **SR-5** | No engine landings while an Edge tranche runs; tools and docs only, then rebuild. | memory `feedback_no_engine_landings_during_edge_tranche.md` |
| **SR-6** | Probe-first (Principle 8): reproduce in a probe, capture both backends, diff, **read the PNGs yourself**. Never ask the maintainer to verify visual output. | `CLAUDE.md` Principle 8 |
| **SR-7** | Brief from verified premises (Principle 10). A spec written from the fix's brief certifies the brief. Every spec needs an **inertness** mutant (`if (false && …)`), not a deletion mutant. | `CLAUDE.md` Principle 10; handoff §8c R8–R11 |
| **SR-8** | Multi-metric: never gate or judge on one number. Call counts, timings, memory and allocations together, each metric's noise behaviour stated beside its bar. | memory `feedback_multi_metric_performance.md` |
| **SR-9** | Idle-soak FPS is invalid under request-render mode; GPU timing uses the mandatory interleaved A/B protocol. | `CLAUDE.md`; `DEBUGGING_GUIDE.md` |
| **SR-10** | Principle 7 — re-derive a file's current disposition from the ledger before deleting anything that looks dead. | `CLAUDE.md` Principle 7 |
| **SR-11** | Evidence repatriation — copy a clone's PNGs / diffs / reports into main's `Tools/visual-regression/output/` before any reset or delete. | `CLAUDE.md` §Evidence Repatriation |
| **SR-12** | Harness-supplied context hides the defect: assert the value the **runtime** receives, never source text or an injected binding. | memory `feedback_harness_supplied_context.md` |
| **SR-13** | Principle 9 — when the root cause is missing or deferred functionality, surface it as the next concrete work item; no inline hack at the call site. | `CLAUDE.md` Principle 9 |
| **SR-14** | Station-3 review is a separate agent from the author. | memory `feedback_opus_initial_reviewer.md`, `feedback_pattern_v4_lean_fable.md` |
| **SR-15** | Tolkien worker naming — one unique name per lane, used in the Agent description, clone dir, packet, ledger and status lines. | handoff §8e; memory `feedback_tolkien_worker_names.md` |
| **SR-16** | Campaign numbering is ratified **add-only**; C17 is PROPOSED and holds its number; no id is renumbered or reused. | `CLAUDE.md` §Campaign numbering |
| **SR-17** | **Edge lane discipline** — one browser job at a time; never port 8080 (the maintainer's); `--serve-built` with served-md5 == disk-md5; the `Q-145` origin rewrite installed **and refusing**. | memory `feedback_serve_built_for_executors.md`; ledger `:116`; §9 items 1–3 |

`D3` uses a parallel vocabulary `S1`–`S10`. The mapping is S1→SR-1, S2→SR-2, S3→SR-3, S4→SR-4, S5→SR-5, S6→SR-6, S7→SR-7, S8→SR-8 + SR-9, S9→**SR-16**, S10→handoff §7 worker rules plus SR-15.

`D1`/`D2` also use their own numbering, and it is **not** this document's. Re-derived from `D2`'s legend 2026-08-29: D2's SR-8 → this document's **SR-11** (repatriation), D2's SR-9 → §9 item 12 (quiet hours), D2's SR-10 → **SR-8** (multi-metric), D2's **SR-11 → SR-10** (Principle 7), D2's SR-12 → handoff §7, D2's SR-13 → **SR-17**. A `Binds` list that differs from its draft by one of these pairs is a **remap, not a drift** — `EAN-03` is the case that looks like one.

### 0.3 Row-card field key

`Disposition` · `Tier` (exactly one) · `Size` XS/S/M/L/XL · `Backends` · `Depends on` · `Ruling touched` · `Gate` (maintainer-decision id, or none — **every card carries the field**) · `Acceptance` (observable evidence — never source-text shape) · `Binds` (SR ids) · `Source` (memo section / research note).

**`Second dispatch` (optional).** Some rows genuinely need two dispatches under two names (SR-15) — a code edit and a browser certification, a scorer and the run that consumes it. `Tier` still names **exactly one** executor: the one that owns the row's first deliverable. The second is stated in its own `Second dispatch` line with its own tier, so ownership is never blurred across a slash.

**Document-deliverable exemption.** For a row whose deliverable **is** a document (`MS-02` option (b), `MS-06`), acceptance is the document's own pre-registered content **plus an independent OPUS-REVIEW re-derivation of at least three of its claims**. That is the only exemption from the never-source-text-shape rule, and both rows already carry the review.

### 0.4 Wave definitions — the rule this document sorts by

- **Wave 1** — ruling-free demo/tooling fixes, **measurement-first** rows, **and engine rows whose only blocker is a landing-form question rather than an authoring question** (`Q-142` is the case: it is authored and spec'd today, and only its landing form waits on **M-03**). Dispatchable today.
- **Wave 2** — engine rows whose blocker is **evidence**: a measurement that must exist first. A Wave-2 row may still carry a maintainer question about *funding*; its ordering blocker is the measurement.
- **Wave 3** — rows whose blocker is **an answer**: nothing can be authored until the maintainer rules, because the ruling decides what the row *is*. Every Wave-3 row quotes its question verbatim.
- **Wave 4** — improvements **beyond upstream**: the `C1`–`C7` family plus the appearance restoration. Behind Wave 1's instrument, ahead of nothing.
- **Meshlet track (`MS-`, placement on M-16)** — its own ordered phase sequence, §6, behind its own launch gate.
- **Closed-negative — §7** — recorded with the reason and the basis so they are not re-opened. The status table's Wave column points these rows at **§7**, which is where they live.

**Re-waving, stated once.** A row's `Source` field keeps its **draft's** wave number so provenance stays traceable, but the row sits where **this** document's rule puts it. The moves: `EAN-05`, `EAN-06`, `EAN-07`, `EAN-11` from D2 Wave 3 → **Wave 4** (they are improvements beyond upstream, all behind `Q-148`'s repaired instrument); `EAN-02` from D2 Wave 5 → **Wave 4**; `Q-141` and `Q-142` from D1 Wave 2 → **Wave 1** — `Q-141` because it is ruling-free engine correctness whose only blocker is `DM-07`'s counters, and `Q-142` because it is fully authorable today and only its **landing form** waits on **M-03**, which is what the widened Wave-1 definition above admits.

**Cross-reference (2026-09-03).** The architecture-review dispatch queue [`QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md`](QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md) reuses §0.1 (tiers), §0.3 (row fields) and §0.4 (waves) of this document verbatim and adds a priority rule of its own; it is a sibling dispatch view over `ARCHITECTURE_REVIEW_2026-09-02.md`, owns the `AR-` ids only, and changes no `Q-` / `DM-` / `MS-` status here.

---
## 1. LIVE STATUS LEDGER

**Status vocabulary:** `QUEUED` = dispatchable under the current holds · `HELD (x)` = blocked on the named gate or dependency · `CLOSED-NEGATIVE` = closed with evidence, do not re-open. **`Q-` rows carry their ledger status by reference** — this column states dispatchability only.

**Add-only carried states:** `LANDED / CLOSED` = completed work retained as historical inventory and
not released for another dispatch · `PARKED / BANKED` = an existing live-ledger identity retained
here but not released for dispatch · `PREREGISTRATION / PREPARATION ONLY` = a frozen future proof
plan that does not authorize a writer, deletion, build, browser/Edge run, landing, evidence, or
certification.

| ID | Title | Tier | Size | Status | Depends on | Wave |
|---|---|---|---|---|---|---|
| `Q-145` | Sandcastle2 built-app origin rewrite + refusal | SONNET-BOUNDED | S | LANDED (Batch 1307) | — | 1 |
| `Q-146` | Earth-at-Night demo clock coupling + timeline window | SONNET-BOUNDED | XS | LANDED (Batch 1303) | `Q-145` | 1 |
| `Q-147` | `sandcastle.yaml` still says emissive lights are WebGPU-only | SONNET-BOUNDED | XS | LANDED (Batch 1303) | land with `Q-146` | 1 |
| `EAN-03` | Night-darkness slider is inert at shipped defaults | SONNET-BOUNDED | XS | LANDED (Batch 1303) | — | 1 |
| `EAN-04` | Collapse the five-row toolbar out of every capture | SONNET-BOUNDED | XS | LANDED (Batch 1303) | — | 1 |
| `EAN-01` | Demo picks the star map + exposure (ledger `B1 (demo)`) | SONNET-BOUNDED | XS–S | LANDED (Batch 1318, default-off; certification on tranche A) (cert = second dispatch, HELD on `Q-148`) | `Q-145`; cert `Q-148` | 1 |
| `Q-148` | Repair + promote the star probe; census scorer | OPUS-EDGE-EXECUTOR | M | QUEUED | `Q-145`, `EAN-04` | 1 |
| `DM-01` | Rebuild the AEC probe so a streaming lever is measurable | SONNET-BOUNDED | S | LANDED (Batch 1307; first live run 2026-09-01 REFUSED first-traversal-not-observed - diagnosis owed) | `Q-145` | 1 |
| `Q-143` | AEC dense-tileset corrected interleaved re-measure | OPUS-EDGE-EXECUTOR | S | QUEUED | `DM-01` | 1 |
| `DM-02` | `requestRenderMode` leg (ship decision gated) | OPUS-EDGE-EXECUTOR | XS / S | QUEUED (ship HELD on M-01) | `Q-143`, `DM-01` | 1 |
| `DM-03` | `maximumScreenSpaceError = 24` leg (ship decision gated) | OPUS-EDGE-EXECUTOR | XS / S | QUEUED (ship HELD on M-02) | `Q-143`, `DM-01` | 1 |
| `DM-04` | `resolutionScale` control legs | OPUS-EDGE-EXECUTOR | XS | QUEUED (measurement ungated; a **default** proposal would inherit M-02) | `Q-143`, `DM-01` | 1 |
| `DM-05` | `logarithmicDepthBuffer = false` leg | OPUS-EDGE-EXECUTOR | XS | QUEUED | `Q-143`, `DM-01` | 1 |
| `DM-06` | Streaming-phase tileset flags, never evaluated | OPUS-EDGE-EXECUTOR | S | QUEUED (measurement ungated; a `foveated*` / `progressiveResolutionHeightFraction` **default** proposal is HELD on M-02) | `DM-01`, `Q-143` | 1 |
| `DM-07` | Pick-emission and pick-pipeline counters | SONNET-BOUNDED | S | LANDED (Batch 1328) | — | 1 |
| `Q-141` | WebGPU pick commands unbuildable while colour pipeline pends | OPUS-JUDGMENT | M | Phase A LANDED (Batch 1338) - REFUTED BY MEASUREMENT 2026-09-01 (readyGateSkips 0, pending 0, ~187 carriers per pick, still 4/40); re-tiered to the pick pass / readback | `DM-07` | 1 |
| `Q-142` | AO bridge reads `stepSize`; clamps and divisor compound it | OPUS-JUDGMENT | S–M | LANDED (Batch 1327, WEBGPU_AO_FULL_SAMPLE_PATTERN = true) - gate M-03 open | — | 1 |
| `Q-149` | Moon modulation: limiting-magnitude floor | OPUS-JUDGMENT | S | HELD (`Q-148`) | `Q-148` | 2 |
| `DM-08` | WebGPU AO has no runtime config propagation | OPUS-JUDGMENT | S | QUEUED (Q-142 landed Batch 1327; M-03 open; carries the found-but-unfiled updateConfig two-of-four-buffers leak) | `Q-142` | 2 |
| `DM-09` | WebGPU tile-content residency starves the frame loop | OPUS-JUDGMENT | L | DIAGNOSED (Turin, LANDED (Batch 1386; diagnosis-only + offline stall-locus analyser + fence specs)): four off-main-thread waits, not slow pipeline creation - see the DM-09 section; E-2 instrument landed (Helm) - the Edge run names the occupant before any fix is funded | `Q-143` | 2 |
| `DM-16` | `probe-aec-perf` streaming-readiness criterion: receipts must not time an unloaded scene | SONNET-BOUNDED | S | LANDED (Batch 1390; Valandil, reviewer Fengel; streaming-residency readiness with a named settle refusal; the 16-cell re-run is the Edge leg) | `DM-01` | 2 |
| `DM-17` | WebGPU HBAO conflates pixels and metres in `lengthCap`: the same value is the pixel march radius and the eye-space falloff, so the occlusion term saturates to 1.0 at altitude (Cirion, DEFERRED_WORK entry) | OPUS-JUDGMENT (shader, parity) | M | LANDED (Batch 1398; Deor, reviewer Walda: the stride is now derived per pixel from eye-space depth as GTAO does, both variants in lockstep; naga-validated; the row's terrain-range expectation is REFUTED - both references floor at one pixel, so WebGPU still draws no occlusion at terrain range (see DM-18); close-range AO capture is the Edge acceptance, terrain view the control) | `DM-08` | 2 |
| `DM-18` | WebGPU vs WebGL AO radius law at range: WebGL's radius grows as lengthCap * sqrt(depth) with a gaussian weight (AmbientOcclusionGenerate.glsl:68), WebGPU's is metres with a one-pixel floor, so WebGL occludes terrain at range and WebGPU does not (Deor packet §6, NEW-WEBGPU-AO-RADIUS-LAW-DEPTH-INVARIANT) | OPUS-JUDGMENT (shader, parity; a design decision on which law is right) | M | RULED (R-2026-09-02-27): the target is parity with WebGL's depth-scaled radius law; dispatch after the DM-17 Edge captures show the gap | `DM-17` | 2 |
| `DM-19` | Q-141 pick cost: WebGPU sync pick median 150 ms vs WebGL 28 ms at 40/40 hits, and the WebGPU leg reached its 90 s settle with tilesLoaded false (Eowyn leg 2) - measurement first | OPUS-JUDGMENT | M | QUEUED (after `DM-16`; equal-content comparison) | `Q-141`, `DM-16` | 2 |
| `DM-10` | ~2.4 GB unaccounted WebGPU JS heap | OPUS-JUDGMENT | M | HELD (`Q-143`) | `Q-143` | 2 |
| `DM-11` | Pick pipelines build synchronously in a per-`Model` cache | OPUS-JUDGMENT | M | HELD (`DM-07`, `Q-143`, `Q-141`, M-05) | `DM-07`, `Q-143`, `Q-141` | 2 |
| `DM-12` | Elide unused scene-FB MRT slot 1 + MSAA colour resolves | OPUS-JUDGMENT | M | HELD (`Q-143`/`DM-04`) | `Q-143`, `DM-04` | 2 |
| `DM-15` | Does the model colour fleet need `Q-120`'s prewarm question? | OPUS-JUDGMENT | S | HELD (`Q-143`) | `Q-143` | 2 |
| `Q-150` | Flip `SkyBox.defaultVariant` to un-blurred `TYCHO_T5` | OPUS-JUDGMENT | S | HELD (M-06 / Q1) | `Q-148` | 3 |
| `EAN-08` | Per-star limiting-magnitude law | OPUS-JUDGMENT | M–L | HELD (M-07, M-09 / Q2, Q4) | `Q-148`, `Q-149` | 3 |
| `EAN-09` | Paint the sky the photometry already computes | OPUS-JUDGMENT | M | HELD (M-07, M-09 / Q2, Q4) | `Q-148`, `EAN-08` publish | 3 |
| `EAN-10` | STBN dither as a rider on `EAN-09` | OPUS-JUDGMENT | S | HELD (rides `EAN-09`) | `EAN-09` | 3 |
| `EAN-12` | Demo-facing twilight floor | OPUS-JUDGMENT | S–M | HELD (M-10 / Q5) | `Q-148` | 3 |
| `EAN-13` | The demo's instant: moonless or moonlit | SONNET-BOUNDED | XS | HELD (M-08 / Q3) | `Q-146`, `Q-148` | 3 |
| `Q-144` | SKIP_LOD bivariate stencil test unimplemented on WebGPU | OPUS-JUDGMENT | M–L | HELD (M-11) | `Q-143` for scheduling | 3 |
| `DM-13` | GPU culler and Hi-Z are blind to `Pass.CESIUM_3D_TILE` | OPUS-JUDGMENT | L | HELD (M-12) — filing only today | — | 3 |
| `DM-14` | The pick pass re-executes tile update and traversal | OPUS-JUDGMENT | L | HELD (M-13) — filed unfunded | `Q-141`, `Q-143` | 3 |
| `EAN-05` | Flux-conserving star PSF + pixel-space sigma floor | OPUS-JUDGMENT | M | HELD (`Q-148`) | `Q-148` | 4 |
| `EAN-06` | Star HDR output feeding the bloom bright-pass | OPUS-EDGE-EXECUTOR | XS | HELD (`Q-148`) | `Q-148`, `EAN-01` | 4 |
| `EAN-07` | Deepen the sprite catalogue to magnitude 6.0 | OPUS-JUDGMENT | S–M | HELD (M-06 option A, `EAN-05`, seam hold) | `EAN-05`, `Q-148` | 4 |
| `EAN-11` | The radial spoke artifact — diagnose after the sky settles | OPUS-JUDGMENT | S | HELD (`EAN-05`, map decision) | `Q-148`, `EAN-04`, `EAN-05` | 4 |
| `EAN-02` | The opening frame lost upstream's signature image | OPUS-JUDGMENT | S | HELD (sky settled; `Q-123`/`NIGHTFADE-D1` for the thumbnail) | `EAN-01`/`Q-150`, `EAN-13`, `EAN-03` | 4 |
| `MS-00` | Mesh-shading feasibility spike | OPUS-JUDGMENT | XS | QUEUED | — | M0 |
| `MS-01` | Capability seam + standards canary + placement decision | SONNET-BOUNDED | XS | QUEUED | `MS-00` | M0 |
| `MS-02` | WGSL mesh/task stage scaffold | OPUS-JUDGMENT | S (L if it grows) | HELD (M-17 / G-B) | `MS-00`, `MS-01` | M0 |
| `MS-03` | Licence and provenance determination pass | OPUS-JUDGMENT | S | QUEUED | — | M1 |
| `MS-04` | `maxStorageBufferBindingSize` adaptive limit cap | SONNET-BOUNDED | XS | QUEUED (RE-OPENED 2026-09-01: the 2026-08-29 refutation was itself wrong - ADAPTIVE_LIMIT_CAPS in WebGPUDevicePool.ts has no maxStorageBufferBindingSize entry, so the min(adapter, cap) line never executes for it; DEFERRED_WORK still lists the cap as a meshlet prerequisite) | — | M1 |
| `MS-05` | meshoptimizer dependency floor + lockfile reconciliation | OPUS-JUDGMENT | XS | QUEUED | `MS-03` | M1 |
| `MS-06` | Meshlet data layout freeze (one layout, both paths) | OPUS-JUDGMENT | S | QUEUED | `MS-00`, `MS-03` | M1 |
| `MS-07` | Layout encoder / validator (pure, browser-free) | SOL-DIRECTED | S | QUEUED | `MS-06` | M1 |
| `MS-08` | Load-time cluster builder | OPUS-JUDGMENT | M | HELD (M-24 / G-I) | `MS-03`, `MS-05`, `MS-06`, `MS-07` | M2 |
| `MS-09` | Per-tile clusterization cost measurement | OPUS-EDGE-EXECUTOR | S | HELD (`MS-08`) | `MS-08` | M2 |
| `MS-10` | Cluster residency + cull compute pass + indirect draw | OPUS-JUDGMENT | L | HELD (`C11-168`) | `MS-04`, `MS-06`, `MS-08`, `Q-143` | M3 |
| `MS-11` | Per-view cull fanout (CSM cascades, frustum splits) | OPUS-JUDGMENT | M | HELD (`C11-168`) | `MS-10` | M3 |
| `MS-12` | Hi-Z occlusion leg for cluster culling | OPUS-JUDGMENT | M | HELD (`C11-168`, FORK-41) | `MS-10`, FORK-41 | M3 |
| `MS-13` | Vertex-pull render variant (complete attribute stream) | OPUS-JUDGMENT | L | HELD (`C11-168`, `Q-141`) | `MS-10`, `Q-141` | M3 |
| `MS-14` | Independent pick / styling oracle + premise re-derivation | OPUS-REVIEW | M | QUEUED | authored before/with `MS-13` | M3 |
| `MS-15` | Containment re-arm story + default-off gate contract | OPUS-JUDGMENT | M | HELD (`C11-168`) | `MS-10`–`MS-13` | M3 |
| `MS-16` | Mesh-shader cluster rendering path | OPUS-JUDGMENT | L (unpriceable) | HELD (M-25 / G-J; and the standard itself) | `MS-00` E0-b, `MS-06`, `MS-13` | M4 |
| `MS-17` | Intra-tile cluster LOD (Tier 2) | OPUS-JUDGMENT | XL | HELD (ruling **M1**) | `MS-13`, `MS-15`, Tier-1 wins | M5 |
| `MS-18` | Extension pre-registration and wire-spec draft | OPUS-JUDGMENT | M | HELD (M-18…M-23 / G-C…G-H) | `MS-03`, `MS-06` | M6 |
| `MS-19` | Adversarial audit of the wire spec | OPUS-REVIEW | S | HELD (`MS-18`) | `MS-18` | M6 |
| `MS-20` | Renderer-free parser + validator over synthetic fixtures | SOL-DIRECTED (3 turns) | M | HELD (`MS-18`, `MS-19`) | `MS-07`, `MS-18`, `MS-19` | M6 |
| `MS-21` | Loader integration (backend-agnostic) | OPUS-JUDGMENT | M | HELD (M-18 / G-C) | `MS-18`, `MS-20` | M6 |
| `MS-22` | Producer tooling: emit the extension into a tileset | OPUS-JUDGMENT | M | HELD (`MS-18`) | `MS-05`–`MS-07`, `MS-18` | M6 |
| `MS-23` | Pre-baked consumption path | OPUS-JUDGMENT | M | HELD (`C11-168`, M-21 / G-F) | `MS-08`, `MS-10`, `MS-21`, `MS-22` | M6 |
| `MS-24` | Sandcastle demo | SONNET-BOUNDED | S | HELD (`C11-168`) | `MS-10`, `MS-13`, `MS-15` | M7 |
| `MS-25` | Edge acceptance tranche | OPUS-EDGE-EXECUTOR | M | HELD (`C11-168`) | `MS-10`–`MS-15`, `MS-24` | M7 |
| `MS-26` | Track close-out review | OPUS-REVIEW | S | HELD (`MS-25`) | `MS-25` | M7 |
| `DX-01` | One probe runtime for the fleet | OPUS-JUDGMENT | M | RETURNED twice, LANDED (Batch 1377); Amras (Opus), reviewer Meneldor | `Q-145` (landed) | DX |
| `DX-02` | Anti-re-accretion contract (status tag + runtime lint) | SONNET-BOUNDED | S | LANDED (Batch 1397; Gram, reviewer Folca; @runtime residency tag + runtime-residency-contract spec with a shrink-only allowlist in test-visual-regression-node) | `DX-01` | DX |
| `DX-03` | HIGH-set singleton disposition after catalog repair | SONNET-BOUNDED | S | QUEUED (after `DX-14`, released by R-2026-09-02-6) | `DX-14` repair completion and explicit maintainer release | DX |
| `DX-04` | MED set: per-file grep census, then archive | SOL-DIRECTED + SONNET-BOUNDED | S + S | QUEUED (after `DX-14` and `DX-03`) | `DX-14` repair completion and explicit maintainer release, `DX-03`; `DX-05` landed | DX |
| `DX-05` | Exemplar retention + instrument-defect promotion | SONNET-BOUNDED | XS | LANDED (Batch 1308; `505724ef69b4aef5abee178a96251a96c636f170`) | — | DX |
| `DX-06` | Deduplicate the fleet onto the runtime, by family | SONNET-BOUNDED (batches) | S each | BATCH 1 LANDED (Batch 1401; Folcred, reviewer Gleowine: the three OIT reachability probes onto the runtime, byte-compatible receipts, migration spec in test-visual-regression-node). BATCH 2 REFUTED-PREMISE (Eldacar, 2026-09-02): an exhaustive census of 712 probes finds NO second family clearing the two-concern bar once the contract's own-edge-slot-lock pattern is corrected (it false-positives on the write-once evidence-artifact idiom in at least nine certification probes; see DX-02b); the remaining candidates are HELD_FOR_D8 or inside the reopened C12-29 S5 cluster. Next candidate: the DP-H46 metadata family (probe-dp46b..f) after a scoping pass - b/c/d never gate on a verdict and every capture launches its own browser | `DX-01`, `DX-02` | DX |
| `DX-02b` | The residency contract's `own-edge-slot-lock` pattern (`{flag:"wx"}`) matches the unrelated write-once evidence-artifact idiom used across C12/C15/C18 certification probes (Eldacar verified nine sites); tighten it to the runtime's actual slot-lock shape and pin the false-positive with a fixture | SONNET-BOUNDED | XS | QUEUED (next window; before any DX-06 batch relies on the concern count) | `DX-02` | DX |
| `DX-07` | Decompose WebGPUModelRenderer.ts (9,085) | OPUS-JUDGMENT | L | QUEUED (Opus lead; owning lanes closed — DM-07 landed, Q-141 Phase A landed and refuted, the readback work lives in the pick pass; folds Batch 1338's duplicated variant-attach block) | `DM-07` landed; `Q-141` Phase A landed | DX |
| `DX-08` | Decompose WebGPUContext.ts (7,889) | OPUS-JUDGMENT | L | QUEUED (Opus lead; DM-07 landed) | `DM-07` (landed) | DX |
| `DX-09` | Decompose WebGPUPrimitiveCommands.ts + WebGPUSceneRenderer.ts | OPUS-JUDGMENT | L + L | QUEUED (Opus lead; Q120 1325, Q130 1322 and Phase A 1357 landed and quiescent) | `Q120`, `Q130` closure + quiescence | DX |
| `DX-10` | Decompose the pipeline cache + six remaining >1,000-line renderers | OPUS-JUDGMENT | M–L each | HELD (`DX-07..09` recipe; the three point-cloud/compute renderers follow C16-10 per R-2026-09-02-4) | `DX-07..09`; per-file owner closure + quiescence | DX |
| `DX-11` | Stable citations convention | seat (docs) | XS | CLOSED (Batch 1310; `c59d2bafd61efbbca765daf536c040b1f63c502c`) | — | DX |
| `DX-12` | Spec homes measured pass (executes Q-139-D1) | SONNET-BOUNDED | S | QUEUED (R-2026-09-02-16 ratified the seven runner families; fresh build under the standing permission of R-24) | build | DX |
| `DX-13` | Ledger rotation | — | — | QUEUED (R-2026-09-02-15) | — | DX |
| `DX-14` | Tooling-catalog archive-plan generator | OPUS-JUDGMENT | M | LANDED (Batch 1372; Amrod, reviewed GO; the catalog regenerates against the staged index, fail-closed, ARCHIVE PLAN tag-derived) | live-ledger DX-14 section | DX |
| `DX-15` | Retire inline translucent-classification color/composite scaffold (`C11-107` alias/tail) | OPUS-JUDGMENT | M | PREREGISTRATION / PREPARATION ONLY; HELD (G6 Q2d) | `C11-107`; explicit Principle-7 sign-off | DX |
| `DX-16` | PNG/CRC32 helper: `Tools/lib/png-rgba.mjs` (`crc32`, `pngChunk`, `encodeRgbaPng`) with golden-byte identity, two consumers first (27 near-duplicate encoders censused; `capture-and-diff.mjs` and `probe-reproject-baseline.mjs` excluded) | SONNET-BOUNDED | S | LANDED (Batch 1379; Miriel's encoder helper Tools/lib/png-rgba.mjs with its golden-byte spec and two consumers; Hirgon relocated Batch 1375's pnglite.mjs to Tools/lib/png-decode.mjs with its first spec, reviewer Ingold). CORRECTION of the 2026-09-02 05:50 note: pnglite.mjs was a decoder, never a second encoder; the two helpers are complementary halves of one round trip. The encoder census stands at 2 of the 27 RGBA duplicates migrated; the rest go to DX-06 batches | `DX-01` runtime preferred, not required | DX |
| `DX-17` | `attachPageDiagnostics(page, options)`: separate console/page-error arrays and an ownership-safe `detach()`, two low-risk consumers first; the WebGPU error gate stays specialised | SONNET-BOUNDED | S | LANDED (Batch 1380; Ioreth, reviewer Luthien; runner home test-lib added by the seat) | — | DX |
| `DX-18` | `mutateOrFail` fast spec home + the three-way `terminateC11168ChildTree` consolidation | SONNET-BOUNDED | S | LANDED (Batch 1381; Bergil; the three-way consolidation was two-way, both unified) | Batch 1352 | DX |
| `DX-19` | Branch and worktree salvage audit (original intention, anything worth keeping, visual evidence, scripts) → refresh `branches/ACTIVE_WORKFLOW_WAVE_2026-08-29.md` → retire only what is truly unneeded | OPUS-JUDGMENT (audit) + seat (sweep) | S | DONE (Batches 1363, 1365: audit landed, inventory refreshed from it, 53 items banked at zero mismatches, six worktrees and nine heads retired; one worktree and one head remain) | — | DX |
| `DX-20` | Sibling-repository census (22 clones) and two-phase retirement; `cesium-worker-g6frame` banked first, `cesium-lane-sundisc2` stays frozen | SONNET-BOUNDED (census) + seat | S | DONE (Batch 1362 census; 155 items banked at zero mismatches; twenty repositories retired ~24.5 GB; HELD: `cesium-worker-sundisc` pending the sundisc/sundisc2 reconciliation ruling, `cesium-lane-sundisc2` frozen, `cesium-audit-proto` active) | `DX-19` | DX |
| `DX-21` | Rust supervisor: relocate to `F:/Dev/GH/cesium-process-supervisor`, audit, review and improve without shrinking, rename to **chelate** as one prefix, fix `TEST_PLAN.md` :60/:63, pin 1.94.0 | OPUS-JUDGMENT (Rust) | M | LANDED in the relocated repository F:/Dev/GH/chelate (Amandil, reviewer Galathil; rename map + audit in its packet; pointer doc migration_doc/CHELATE.md; in-tree copy deleted after the byte-identical baseline). Certification and Q-152 integration stay NO-GO. | — | DX |
| `DX-22` | Tracked `CAMPAIGN_STATE.md` as the sole campaign-status authority; CLAUDE.md's campaign section becomes a pointer; joins the doc-truth sweep | SONNET-BOUNDED (docs) | S | LANDED (Batch 1385; Aredhel, reviewer Enerdhil; CAMPAIGN_STATE.md is the campaign-level authority and CLAUDE.md's section is a pointer) | — | DX |
| `DX-23` | `migration_doc/README.md` index: LIVE lane-records section, the 123 unindexed documents, a dated currency claim | SONNET-BOUNDED (docs) | XS | LANDED (Batch 1384; Erendis; census 293 documents / 157 linked before, every document indexed now) | — | DX |
| `DX-24` | CI report of reused batch numbers on push (report-only) | SONNET-BOUNDED | XS | LANDED (Batch 1382; Vardamir, reviewer Damrod; batch-number-report.yml + Tools/report-batch-number-reuse.mjs) | — | DX |
| `DX-25` | Codex config: `provision-worker-clone.mjs` writes an explicit trust entry per Cesium clone, then the `f:\dev\gh` root trust is narrowed and the 1.7 GB log store pruned — Codex keeps its ability to branch and clone | seat | XS | DONE 2026-09-02 08:00 ET: the Codex configuration trusts four existing repositories (22 entries before, the wholesale f:\dev\gh entry removed), before/after banked at cesium-webgpu-worker-archive/codex-config-backup-2026-09-02; provisioning flags --codex-trust/--codex-untrust LANDED (Batch 1383; Eomund, reviewer Hirluin) | — | DX |
| `DX-26` | Wave-end gate repair: run the runnable legs and record the third STRUCTURAL; derive `--source-identity`; retire the spec-seam receipt validation; annotate the catalog row meanwhile (executes R-2026-09-02-9; `Q-152` stays the status authority) | OPUS-JUDGMENT | M | QUEUED | Batch 1332/1336 | DX |
| `DX-27` | Guard repair rows: Fëanor (accept `HEAD`/OID local refs, restore the deletion's old tip, 49/49, then the shallow-history hardening) and Idril (four fail-closed assertions) | SONNET-BOUNDED | S + S | QUEUED (R-2026-09-02-10; drafts banked at `cesium-webgpu-worker-archive/guard-drafts-2026-09-01/`) | Batch 1354 | DX |
| `DX-28` | Lunar-bake and staged-Git-read primitive families | research | — | HELD (research-only until exact contracts, leases, runner homes and acceptance matrices are preregistered) | — | DX |
| `DX-29` | Screenshot/artifact-writer consolidation and the Batch-66 final/end-of-session runner family | research | — | HELD (provenance review; runner names encode evidence cutoffs) | — | DX |
| `DX-30` | `.prettierignore` opens with `*`, so a Prettier check on a scratch path passes vacuously; verify the premise, then make scratch-path checks explicit in the landing runbook | SONNET-BOUNDED | XS | QUEUED (premise VERIFIED 2026-09-04, folded `DX-41`: `npx prettier --check 'migration_doc/**/*.md'` matches zero files and prints "All matched files use Prettier code style!", EXIT=0; `npx prettier --check --ignore-path /dev/null migration_doc/README.md` reports real style issues, EXIT=1 — confirming `migration_doc/` is silently ignored; the runbook clause remains QUEUED) | — | DX |
| `DX-31` | Decompose `Tools/visual-regression/lib/probe-runtime.mjs` (994 lines after DX-01 round 3) and `probe-runtime.spec.mjs` (1,547 lines) into focused modules and spec files under the same runner home, behaviour byte-identical | SONNET-BOUNDED | S | QUEUED (flagged by lane Amras, packet §10.8; the ~1,000-line rule; lands after `DX-01`) | `DX-01` | DX |
| `DX-32` | Three pre-existing spec defects surfaced by Turin and Eomund: `Tools/spec-runner-census.spec.mjs:192` mutation anchor drifted (mutant vacuous); `Tools/generate-tooling-catalog.spec.mjs` failed with a run-to-run-unstable failure set and a not-ok count that disagreed with its summary; `Tools/pre-push-guard.spec.mjs` read the real wall clock and failed inside quiet hours | SONNET-BOUNDED | S | LANDED (Batch 1396; Hallas, reviewer Leod: census mutant re-anchored, catalog spec deterministic, guard clock injectable through a fifth argv entry that git's two-argument hook contract never supplies) | — | DX |
| `DX-33` | Three WebGPU cache specs under packages/engine/Specs/Renderer/WebGPU have no runner home (Helm packet §3.2); home them in `test-model-webgpu` and confirm the family count | SONNET-BOUNDED | XS | LANDED (Batch 1395; Targon, reviewer Aldor; test-model-webgpu lists them explicitly) | — | DX |
| `DX-34` | `gsplat-campaign15-instruments.spec.mjs:216-236` certifies the tile-update tagging predicate's truth table (brief-certifying; the predicate is unreachable for splats, Indis §1a); replace with a behaviour spec when the C15-G7a chain design is funded | SONNET-BOUNDED | S | QUEUED (after `C15-G7a` design) | `C15-G7a` | DX |
| `DX-35` | Index the 2026-09-02 documents in `migration_doc/README.md` after DX-23's currency claim landed: `CHELATE.md`, `ARCHITECTURE_REVIEW_PLAN_2026-09-02.md`, `RENDERER_LANDSCAPE_AUDIT_2026-09-02.md`, `audits/2026-09-02_ARCHITECTURE_REVIEW_PHASE1.md`, `branches/SUNDISC_RECONCILIATION_2026-09-02.md`, `C18_P3_PNTS_MODEL_ATTENUATION_DESIGN_2026-09-02.md`; re-run the census and restate the claim | SONNET-BOUNDED (docs) | XS | QUEUED (next window) | `DX-23` | DX |
| `UPSTREAM-SYNC-1.145-00` | The merge commit and the `PORT-INTO-CLASS` resolution pass — all 32 conflicts, one atomic merge commit (§8.0 explains why they cannot be split) | OPUS-JUDGMENT | XL | LANDED (Batch 1408, merge commit `33398505e6`; reviews REVIEW_ERADAN_cluster-a.md / REVIEW_HERION_cluster-b.md / REVIEW_TAR-ANDUCAL_cluster-c.md / REVIEW_TAR-FALASSION_cluster-d.md, all LAND; packet LANDING_PACKET_TAR-MINYATUR.md) | — | 1 |
| `UPSTREAM-SYNC-1.145-01` | Globe cluster review: the `GlobeSurfaceShaderSet` shader-key bit assignment + `GlobeSurfaceTileProvider` | OPUS-JUDGMENT | M | LANDED (Batch 1408; REVIEW_ERADAN_cluster-a.md — LAND) | `-00` landed | 1 |
| `UPSTREAM-SYNC-1.145-02` | Clipping polygons + vector pipeline; the `UP-1` fork-code disposition now that 1.145 deleted the three signed-distance shaders | OPUS-JUDGMENT | L | LANDED (Batch 1408; REVIEW_HERION_cluster-b.md — LAND; D1 = DROP of the WebGL SDF producer only, evidenced not improvised — residue tracked under `-07`) | `-00` landed | 1 |
| `UPSTREAM-SYNC-1.145-03` | Tiles + models review, including the auto-merged RTE-heavy set (`GltfLoader`, `Model3DTileContent`, `EdgeVisibilityPipelineStage`, `PickingPipelineStage`) | OPUS-JUDGMENT | M | LANDED (Batch 1408; REVIEW_TAR-ANDUCAL_cluster-c.md — LAND) | `-00` landed | 1 |
| `UPSTREAM-SYNC-1.145-04` | Renderer core: re-source 1.145's only Scene-layer `ContextLimits` read to `context.limits`; the snap `surfacePosition` contract vs the fork's readback policy | OPUS-JUDGMENT | M | LANDED (Batch 1408; REVIEW_TAR-FALASSION_cluster-d.md — LAND) | `-00` landed | 1 |
| `UPSTREAM-SYNC-1.145-05` | Toolchain, widgets, Sandcastle, and the `@playwright/test` 1.59.1 → 1.62.1 bump; the three fork-only devDependencies in `package.json` hunk 1 | SONNET-BOUNDED (second dispatch: OPUS-JUDGMENT for the Playwright exposure) | M | LANDED (Batch 1408; package.json union confirmed zero-loss by REVIEW_TAR-FALASSION_cluster-d.md (c)5 and packet gate G6; Amplitude telemetry module arrived default-disabled and additive, its dependency unresolved until `-06` leg 1b's `npm install`) | `-00` landed | 1 |
| `UPSTREAM-SYNC-1.145-06` | Post-merge verification + the wave-end gate; baselines NOT refreshed by this row | OPUS-EDGE-EXECUTOR | L | VERIFIED — FIT TO FAST-FORWARD for the 1.145 merge itself (Éowyn job 4, 2026-09-04; `Tools/visual-regression/output/sync-1145-verification-2026-09-04/SUMMARY.md`); legs 1a/1c/3/4/5 GREEN or pre-existing-red-and-unchanged. **Job 5 (2026-09-05) ran the three legs job 4 could not:** leg 1b (Sandcastle2 sweep) NOT RUN for the job-3 comparison (environmental boot-gate timeout, see `DX-48`) but GREEN on substance — all five merge-added demos certify on both renderers, no new GPU validation error; the globe-black attribution (job 4's UNDETERMINED) is now PRE-EXISTING, byte-identical capture on both trees (`AR-894`); leg 2 (draped-polyline width, gate B) RAN and read RED (1.858) in job 5, attributed to a stale served bundle (not to Batch 1410's fix — see `DX-47`), then **RE-RUN CLEAN in job 6 (2026-09-05) against a preflight-certified-current bundle: countRatio 1.000, gate D 1.000/1.022, nadir bbox delta (0,0) — `-07` item 1 CLOSED, item 8's re-vehicle confirmed working.** **Does this change the merge's fast-forward verdict? No — the 1.145 merge commits (`1408`/`1409`) were never in question; Batch 1410's own acceptance is now MET rather than unproven** | `-00`…`-05` landed | 1 |
| `UPSTREAM-SYNC-1.145-07` | The WGSL parity twins the sync opens (`czm_eyeCartographic` / `czm_eyeToEnu` + `eyeToCartographicDelta`, and any new pipeline stage) | OPUS-JUDGMENT (shader, parity) | M | QUEUED — item 1 (draped-polyline width) CLOSED (Penlod, Batch 1410, reviewer Gundor, LAND); **24 items total after the `SYNC_1145_WEBGPU_PARITY_CENSUS_2026-09-05.md` rewrite (2026-09-05, lane Malach) — 23 items remain open (2-24), enumerated in the card** | `-00` landed (Batch 1408) | 2 |
| `UPSTREAM-SYNC-1.145-08` | The ES6-shape guard: no file that was a class pre-merge may be prototype-based after | SONNET-BOUNDED | S | LANDED (Batch 1408; independently re-confirmed by all four cluster reviews, exit 0 over 49 in-scope files; runner home confirmed, `node --test` 11/11 per LANDING_PACKET_TAR-MINYATUR.md §8 G3/G4) | `-00` landed | 2 |
| `DM-N1`…`DM-N11` | Eleven design-model non-levers | — | — | CLOSED-NEGATIVE | — | §7 |
| `EAN-X1`…`EAN-X6` | Six Earth-at-Night closures and hand-offs | — | — | CLOSED-NEGATIVE | — | §7 |

**Counts.** Wave 1 = **17**, Wave 2 = **7**, Wave 3 = **9**, Wave 4 = **5**, meshlet track = **27** (`MS-00`…`MS-26`), closed-negative = **17**. Wave DX = **15** (`DX-01`…`DX-15`; `DX-05` landed, `DX-11` closed, `DX-14` already banked, `DX-15` preparation-only). Total tracked = **97**.

**Umbrella, not a row.** The ledger's `AEC demo flags` entry (`FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md:136`) stays the umbrella over `DM-02`–`DM-06`; it has no tier and no executor of its own, and it attaches to the `C11-168` dense-tileset lane so the flags are judged in the same harness that `Q-143` builds.

**`DX-36`…`DX-41` (2026-09-04 landing night, after the Edge job; fix round by Haldir applied 2026-09-04).** Four new DX rows added to §6a as full cards: `DX-36` landing staging assertion for renames (corrected mechanism — a worker patch is exported `--no-renames`, so a rename arrives as a delete-plus-add and both paths reach `git apply --numstat`; the fatal is a bare `git add` on the path `--3way` already deleted), `DX-37` C16 cleanlist union resolver reachability, `DX-38` chelate contract tests red (owned-by `DX-21`), `DX-40` `build-ts` as a gate plus a JSDoc type-expression lint. Two ids are withdrawn as duplicates and kept only as one-line entries: `DX-39` (served-tree rebuild cannot run the wave-end gate) duplicates `AR-D20` / `AR-883` in `QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md`, which carry the served-tree rebuild gap and its open three-option maintainer decision; `DX-41` (the docs prettier gate checks nothing) is the verification `DX-30` demanded and is folded into `DX-30`'s existing table row in place. Not added to the table above — see the §6a cards for tier, size, dependencies and acceptance.

---
## 2. WAVE 1 — ruling-free and measurement-first. 2026-08-29 PLAN SNAPSHOT — NOT CURRENT STATUS.

**Snapshot scope:** The Wave 1 table above and cards/order below preserve the 2026-08-29 dispatch plan. They are not current status or execution authority. Read every `Q-` id's current status from the live ledger named in §0.

**Dispatch order inside the wave:** `Q-145` → (`Q-146` + `Q-147` + `EAN-03` + `EAN-04`, one demo commit) → `EAN-01` code → `DM-01` → `DM-07` → **`Q-148`** and **`Q-143`** (two tranches, never concurrent — one Edge job at a time) → the `DM-02`…`DM-06` legs inside `Q-143`'s tranche → `EAN-01` certification → `Q-141` → `Q-142`.

**Why measurement leads.** Cirdan §5: *"Do not fund a fix before it. Every engine row below E-4 has an unknown numerator today, and the one thing this dataset proves about diagnosis-by-code-reading on this bug is that it has already been wrong twice."* Celeborn's equivalent is `Q-148`: the instrument that produced the star numbers wrote to a property that does not exist, so two legs threw and one was a byte-duplicate of another.

### `Q-145` — Sandcastle2's built app redirects to hard-coded origins

- **Disposition:** OPEN, tooling. The committed built app carries an unconditional top-level redirect to `http://localhost:8080` with the bucket on `:8081`, so a probe opening it on any other port silently lands on the maintainer's live server. `server.js:230-231` bakes the origins **at build time** and `server.js:218-219` rebuilds only when `Apps/Sandcastle2/index.html` is **absent**, so the redirect is structural and sticky, not a one-off mistake (both re-read 2026-08-29).
- **Tier / Size / Backends:** SONNET-BOUNDED · S · n/a (tooling)
- **Depends on:** none. **Blocks:** `Q-143`, `Q-148`, `DM-01`–`DM-06`, `EAN-01` certification, `EAN-06`, `EAN-11`, `MS-09`, `MS-25` — every row that opens the built app in a browser.
- **Ruling touched:** none. **Gate:** none.
- **Acceptance:** (a) with the helper installed, a run launched at `--port 8094` reports `page.url()` origin `http://localhost:8094` at every navigation and the bucket frame at `:8095`; (b) with the helper removed, the same run **refuses** — non-zero exit, named reason — instead of proceeding; the refusal is the deliverable, not the rewrite; (c) a leg pointed at a dead port fails as a connection error, never as a silent 8080 success. The check compares the **final** URL after redirects. **Inertness mutant:** make the origin check inert (`if (false && finalOrigin !== requestedOrigin)`) and leg (b) must go green.
- **Binds:** SR-6, SR-7, SR-13, SR-15, **SR-17** (it *is* half of SR-17's precondition). Not an engine landing, so SR-5 does not block it — this is exactly the class that may land during **another** row's tranche.
- **Source:** D2 Wave 1 `Q-145`; ledger `:117`. New finding folded in: D2 appendix item 3.

### `Q-146` — the demo writes `clock.shouldAnimate` from every control, and pins `currentTime` off-window

- **Disposition:** OPEN. `earth-at-night/main.js:78-82` subscribes `updateGlobe` to all five observables with no filter and `:95` writes `viewer.clock.shouldAnimate = dynamicLighting`, so any control stops a running clock (lighting OFF) or restarts a paused one (lighting ON). Separately `:25-27` pins `currentTime` ~161 days outside the timeline window `Viewer.js:1022` zoomed to once at construction. **The widget stack is exonerated — spend nothing in `packages/widgets/`.** **Demo-scoped only — no engine change and no gallery-wide sweep:** Celeborn is explicit (*“fix it in this demo only; do not generalise it into an engine change or a 27-demo sweep”*), and the same shape in the `atmosphere` / `terrain` / `shadows` upstream demos is **out of scope and is not a defect this row opens** (only `time-dynamic-wheels` does it correctly).
- **Tier / Size / Backends:** SONNET-BOUNDED · XS · n/a (demo code; symptom identical on both, measured on both)
- **Depends on:** `Q-145`. **Ruling touched:** none — it repairs `VW-N6`, the row that authored the demo. **Gate:** none.
- **Acceptance:** both backends. (a) lighting OFF: fast-forward, then exercise each of the five controls — the clock keeps advancing after every one, with the Dynamic-lighting checkbox **excluded** (stopping the clock is its correct upstream behaviour); (b) lighting ON: fast-forward, pause, nudge a slider — `shouldAnimate` stays `false` **and** `playForwardViewModel.toggled` stays `false`; (c) the timeline needle is on the visible track and moves monotonically at 4000×, screenshotted per backend. Run on a non-8080 port under `Q-145`. **Mutant:** re-point the clock write at the unfiltered subscription and leg (a) must go red.
- **Disconfirming observation — the one result that reopens the widget:** the exoneration holds **unless** step 3 of Celeborn §2 shows `t` static while `canExecute` and `toggled` are both `true`. If an acceptance run produces that, **stop, capture the console, and re-open the widget stack** — Celeborn names it “the only result in this whole lane that reopens the widget”.
- **Pre-landing maintainer round trip:** run the five-step DevTools script at `cesium-lane-quickbeam/_lane-out/REVIEW_EARTH_AT_NIGHT_CELEBORN.md:113-152` **verbatim from that file** (do not retype it), on the WebGPU leg first, and record all four outcome readings. It is the lane's only way to answer Celeborn's open question 5 — which gesture the maintainer actually made.
- **Binds:** SR-3, **SR-5** (a `packages/sandcastle/gallery` landing changes what a probe loads — not during a tranche), SR-6, SR-7, SR-13, SR-15, **SR-17**. **Source:** D2 Wave 1 `Q-146`; memo A1, §2; ledger `:118`.

### `Q-147` — `sandcastle.yaml:3` still says the emissive city lights are WebGPU-only

- **Disposition:** OPEN. `main.js:97-101` sets `globe.enableNightLights` / `nightIntensity` unconditionally and `:106` already prints "emissive city lights are live on both renderers"; `R-2026-08-28-9` (`MAINTAINER_RULINGS_2026-08-28.md:169-175`) amends the WebGPU-only contract.
- **Tier / Size / Backends:** SONNET-BOUNDED · XS · n/a (manifest text)
- **Depends on:** land with `Q-146`. **Ruling touched:** none — it aligns text *with* `R-2026-08-28-9`. **Gate:** none.
- **Acceptance:** the **built gallery card and demo description, as served**, carry no backend-conditional claim about emissive lights — asserted against the **generated Sandcastle2 gallery manifest**, not against the source yaml (SR-12: assert what the runtime serves, never source text). The mutual consistency of `sandcastle.yaml:3`, `main.js:97-101` and `:106` is **review guidance**, not the acceptance.
- **Binds:** SR-3, **SR-5**, SR-12. **Source:** D2 Wave 1 `Q-147`; memo A2; ledger `:119`. Premise re-derived 2026-08-29: `GlobeFS.glsl:277`/`:291`/`:551` carry the WebGL mirroring emission term, so `R-2026-08-28-9`'s VW-N11 has landed and the “both renderers” claim is true.

### `EAN-03` — the Night-darkness slider does nothing at the shipped defaults

- **Disposition:** OPEN. `GlobeFS.glsl:1090` mixes `u_nightDarkness` toward 1.0 by night-imagery coverage, and the bundled layer is pinned `dayAlpha: 0.0, nightAlpha: 1.0` (`GlobeNightImagery.js:23-26`), so coverage saturates and the slider cancels. **Do not change the shader** — the cancellation is deliberate for globes with no night layer.
- **Tier / Size / Backends:** SONNET-BOUNDED · XS · n/a (demo code)
- **Depends on:** couples to `EAN-02`'s camera decision. **Ruling touched:** none. **Gate:** none.
- **Dispatch shape, chosen so the row is single-valued:** **annotate the control with a stated on-screen reason and leave it enabled.** Disabling and annotating are different acts with different SR-1 exposure, and the Binds line below defends the annotate form.
- **Acceptance:** the control carries an on-screen reason at the demo default, **and** a capture with the slider at both extremes reports the stated night-side luminance delta — **which may be zero**, and a zero that matches the stated reason is a pass.
- **Binds:** SR-1 (annotating an inert control is not a degrade; removing the engine's coverage mix to make the slider "work" would be), SR-3, **SR-5**, SR-10. *(D2 binds its own SR-11 here; D2's SR-11 **is** this document's SR-10 — Principle 7. Re-derived from D2's legend 2026-08-29: a remap, not a swap.)* **Source:** D2 Wave 1 `EAN-03`; memo B3.

### `EAN-04` — collapse the five-row toolbar

- **Disposition:** OPEN, and it is not cosmetics: the panel occupies ~28% of a 736 px canvas in every capture in the lane, and UI contamination produced the two refuters' opposed `≥ luma 8` verdicts, the audit's "D4 pixel-identical to D3", and leg G's recorded no-op.
- **Tier / Size / Backends:** SONNET-BOUNDED · XS · n/a
- **Depends on:** none. **Feeds** `Q-148` and `EAN-11`. **Ruling touched:** none. **Gate:** none.
- **Acceptance (scorer-free by construction — see the note):** at the demo default, the collapsed toolbar's **DOM bounding box does not intersect the declared sky region**, and a capture of that region contains **zero pixels matching the toolbar's background token**. Both legs, both backends.
- **Cycle broken, deliberately:** the earlier form verified this with `Q-148`'s census scorer while `Q-148` depends on `EAN-04` — neither could be accepted first. The dependency now runs one way only: `EAN-04` → `Q-148`. A scorer cross-check is welcome **after** `Q-148` lands; it is not this row's bar.
- **Binds:** SR-3, **SR-5**, SR-6, SR-12. **Source:** D2 Wave 1 `EAN-04`; memo B4.

### `EAN-01` — let the DEMO pick the star map and the exposure *(ledger `B1 (demo)`)*

- **Disposition:** OPEN, and it leads because it is the only route to the maintainer's picture that **reverses no ruling and touches no engine file**. Set `Cesium.SkyBox.defaultVariant = Cesium.SkyBox.Variant.TYCHO_T5` **before** `Viewer.createAsync`, enable `highDynamicRange` + bloom, expose both plus star-field intensity. The API is documented with this exact example at `SkyBox.js:296-301`; resolution is at `SkyBox.js:311`; `R-2026-08-28-11` item 3 already names un-blurred `TYCHO_T5` as the sanctioned resolved-star variant. **Honesty obligation:** the demo would then not be showing the engine default — say so on screen next to a DR-01 reference.
- **Tier / Size / Backends:** SONNET-BOUNDED (the demo edit) · XS–S · both backends
- **Second dispatch:** OPUS-EDGE-EXECUTOR · S — the certification capture, run **inside tranche A** behind `Q-148`, under its own Tolkien name (SR-15).
- **Depends on:** `Q-145`. **Certification depends on `Q-148`** — its bar is a point-source census and the census scorer is `Q-148`'s deliverable; landing the edit on an un-repaired instrument would reproduce the audit's D-1 failure, which went green over 27 faint specks.
- **Ruling touched:** none. **Gate:** **none.** It is the **input** to decision **M-06**, not gated on it. It manufactures exactly the browser A/B that decision needs.
- **Landing shape, so nothing needs reverting:** land the toolbar control **default-off — `TYCHO_T5_DIFFUSE` selected and HDR off** — so the shipped default frame is unchanged by the code commit. The flip of the demo default to `TYCHO_T5` + HDR + bloom is a **separate one-line commit, conditioned on the certification passing**. Without this the code lands at dispatch position 3 and certifies only after tranche A, so a failed ≥ 300-maxima bar would leave a shipped demo needing a revert.
- **Acceptance:** captures at the demo default **and** at the view-(6) framing, both backends, **≥ 300 point-like maxima** in a chrome-free sky region; **plus** a byte-identical frame when the control is returned to `TYCHO_T5_DIFFUSE` with HDR off — the byte-identity leg is what proves the control is a control and not a re-render. Report per leg: `highDynamicRange`, bloom enabled, `globe.enableLighting`, sun elevation, camera altitude. Live variant swaps must **destroy the previous sky box** — `Scene.js:620` is a plain field with no setter.
- **Binds:** SR-1, SR-2, SR-3, **SR-5** (a gallery landing changes what a probe loads), SR-6, SR-7, SR-11, SR-15, **SR-17** (the certification leg). **Source:** D2 Wave 1 `EAN-01`; memo B1; ledger `:123`.

### `Q-148` — repair and promote the star probe; author the census scorer. **The single next star measurement.**

- **Disposition:** OPEN, HIGH. The probe writes `V.scene.atmosphericConditions.skyAtmosphere.enableStarBrightnessModulation` at `probe-final-quickbeam.mjs:159`/`:162`; **there is no `atmosphericConditions` accessor on `Scene`** — `Scene.js:6267-6268` publishes the facade *from* `scene.globe.atmosphericConditions`. Legs D2 and D5 threw, D2 is a byte-duplicate of D1, and `enableStarBrightnessModulation` was **never toggled off anywhere in the audit**. Three further findings the memo does not carry: the probe is untracked scratch in the lane clone (promote it into `Tools/visual-regression/` or the instrument dies with the clone); the census scorer belongs in `Tools/visual-regression/lib/` so every star row scores identically; and `C12-36` already records the wall-clock substitution that voided an earlier star-pixel run, so the **render-time leg** must come with it.
- **Tier / Size / Backends:** OPUS-EDGE-EXECUTOR (the probe rewrite and the run — **tranche A**) · M · instrument, same metric on both lanes
- **Second dispatch:** SOL-DIRECTED · S — the census scorer library in `Tools/visual-regression/lib/` and its spec, a pure function over synthetic fixtures with pasted excerpts, **landed before the tranche opens**, not during it.
- **Depends on:** `Q-145`, `EAN-04`. **Ruling touched:** none. **Gate:** none.
- **Acceptance:** (a) reproduces the banked 2×2 within 5% on the D0 mask — WebGPU point-like maxima 0 / 35 / 1,606 / 14,500; WebGL 0 / 42 / 2,050 / 18,167; (b) the never-executed **moon-ON / modulation-OFF** leg exists, is captured, and its filename matches its diagnostic; (c) every leg publishes `highDynamicRange`, `hdrDisplayPolicy`, `useHDRCanvasOutput`, `globe.enableLighting` (**`Q-62`: the fork's shell permissiveness advantage exists only at `enableLighting = false`; at ON the enum resolves to SCENE_LIGHT and the two laws are identical — a leg that omits it cannot be compared to anything**), camera altitude and sun elevation; (d) legs are non-cumulative — running leg N alone reproduces leg N from the full sweep byte-for-byte; (e) render-time leg: each lane's rendered solar elevation within 1.0° of its solved elevation. **Mandatory mutant:** force the modulation branch inert at `SkyBoxFS.glsl:76` and the metric must visibly move. **Metric rule for every star row:** score point-like maxima (strict 3×3 local maximum, centre ≥ 3 luma and ≥ its 5×5 ring mean + 3) and `px ≥ luma 8` / `≥ 24` in a chrome-free sky box — **never `pxGt0`**, the saturating counter that produced every wrong conclusion in the lane.
- **Serves two rows, deliberately:** the census scorer must be authored so **`C12-36`'s owed star-pixel leg can consume it unchanged**, and `Q-148` must **not** re-derive `C12-36`'s estimator. `C12-36` stays **open and incomplete**; nothing in this row discharges it.
- **Binds:** SR-5 (a `Tools/` landing is permitted during **another** row's tranche; this row's own scorer lands before this row runs), SR-6, SR-7, SR-8, SR-11, SR-15, **SR-17**.
- **Source:** D2 Wave 2 `Q-148`; memo A3; ledger `:120`. **Carry forward as UNVERIFIED:** the default+HDR+bloom 39-vs-9 backend asymmetry — Celeborn's own open question 1. Do not quote it until this run confirms it.

### `DM-01` — rebuild the AEC probe so a streaming lever can be measured at all

- **Disposition:** OPEN, hard prerequisite of `Q-143`. The existing ablation matrix (`probe-aec-perf2.mjs:373-379`) runs seven legs **inside one page load, after settle, cumulatively**; a streaming lever (`maximumScreenSpaceError`, `preferLeaves`, `preloadWhenHidden`, `cullRequestsWhileMovingMultiplier`, `requestRenderMode`) only acts during the load phase every leg is downstream of. It also sums `commandList.length` over all passes (`:95`) and falls back to canvas centre `(640, 360)` for the pick position (`:259-260`).
- **Tier / Size / Backends:** SONNET-BOUNDED · S · harness (drives both)
- **Depends on:** `Q-145`. **Ruling touched:** none. **Gate:** none.
- **Acceptance:** a tracked `Tools/visual-regression/probe-aec-perf.mjs` in which (a) every streaming lever is its own **page load**, applied before the first tileset is added and timed to `Scene.renderReady` — **not `tilesLoaded`** (`Q-101`: the legacy gate reports true optimistically on WebGPU); (b) `commandList.length` is reported per `Pass`, not summed; (c) the pick position is a single validated hit used by **both** backends or the leg refuses to report; (d) `Q-145`'s rewrite is installed. Assert `tileset.maximumScreenSpaceError` **read back from the engine** at the frame of the first traversal, not the value the harness wrote (SR-12). **Inertness mutant:** move one lever back to a post-settle `page.evaluate` and the leg must refuse to report, not report a number.
- **Binds:** **SR-5** (a `Tools/` landing — permitted during another row's tranche, and it must land before `Q-143`'s), SR-6, SR-7, SR-8, SR-11, SR-12. **Source:** D1 Wave 1 `DM-01`; ledger `:131` critic's ablation-matrix caveat.

### `Q-143` — AEC dense-tileset baseline: one corrected, interleaved re-measure + CPU profile

- **Disposition:** OPEN, HIGH — the single next design-model measurement; the numerator of every Wave-2 row is void or absent until this runs. Two residency corrections must be in the brief: `Cesium3DTilesetStatistics.clear()` (`:38-49`) is called at the top of every `Cesium3DTileset.update()` (`:3840-3841`), so "153 tiles / 1.91 M triangles" is **one frame's selection**, not residency — report the `incrementLoadCounts` byte counters (`:85-107`) separately and labelled; and `Cesium3DTileset.js:1449` gates the whole traversal on `show`, so with `Structural` hidden (`main.js:69`) **seven** tilesets traverse, not eight.
- **Tier / Size / Backends:** OPUS-EDGE-EXECUTOR · S (one tranche) · both, interleaved. Read-only on the engine.
- **Depends on:** `DM-01`. **Ruling touched:** the **meshlet launch gate** — `DEFERRED_WORK.md:4622` prereq (c) makes `C11-168`'s dense-tileset lane a hard launch gate; the Treebeard run does not satisfy it (no WebGPU frame cost or command count was captured at all). This row begins to.
- **Gate:** none to run. A gate arises only if the maintainer wants `Q-143` to also **discharge** the `C11-168` gate — that needs the moving-altitude campaign as a second lane, which is scope beyond this demo. Flagged as decision **M-14**.
- **Acceptance (all six, or the row is partial):** 1. both backends reach `Scene.renderReady === true` before any timing phase, **not `tilesLoaded`** (`Q-101`: the legacy gate reports true optimistically on WebGPU); 2. the same validated hit position on both legs, and a leg that cannot validate a hit reports "no hit", never a fallback coordinate; 3. reversed run order as a second leg (the original was WebGPU-then-WebGL, i.e. WebGL ran warm); 4. a `probe-cpu-sampling-profile.mjs` flame profile over the WebGPU settle window with `pipelineCache.created`/`pending` sampled **per frame**; 5. a Chrome heap snapshot at the end of each settle window, **bucketed by retainer**; 6. a `TB_ENTRY=/Build/Cesium/index.js` minified repeat to close the unminified-build caveat. **Deliverables that do not exist today:** equal-content frame cost and per-`Pass` `commandList.length` for both backends.
- **Binds:** SR-5, SR-6, SR-8, SR-9, SR-11, **SR-17**. **Source:** D1 Wave 1 `Q-143`; memo §3b E-1, §5; ledger `:134`. Runs as **tranche B**, after tranche A exits.

### `DM-02` — `requestRenderMode = true` leg — measure now, ship decision gated

- **Disposition:** HELD-conditional. Its stated mechanism is refuted for the window that matters (WebGPU produced 29 frames in 75,469 ms and zero in the following 10 s — you cannot free the main thread by suppressing frames that are not happening), and it breaks the demo's hover highlight: `Scene/BatchTexture.js` contains **zero** `requestRender()` calls, verified.
- **Tier / Size / Backends:** OPUS-EDGE-EXECUTOR (leg inside `Q-143`'s tranche) · XS to flip, S to validate · both
- **Depends on:** `Q-143`, `DM-01`. **Ruling touched:** the idle-soak invalidity rule — turning this on invalidates FPS as the metric, so the leg is timed to `Scene.renderReady`, never a settle FPS.
- **Gate:** **M-01** (ship decision only; the measurement is ungated).
- **Acceptance:** a hover-interaction trace showing the yellow highlight **still appears** on WebGPU with the flag on (element screenshots before and after the hover, read by eye), **plus** wall-clock time to `Scene.renderReady` with the flag on and off, interleaved. Settle FPS is not admissible evidence.
- **Binds:** SR-1, SR-6, SR-8, SR-9, **SR-17**. **Source:** D1 §3a row D1. Runs as a leg inside **tranche B**.

### `DM-03` — `maximumScreenSpaceError = 24` leg — measure now, ship decision gated

- **Disposition:** HELD-conditional and unmeasured as a clean number. Its only evidence is ablation leg G, which ran **last** in the cumulative post-settle block; legs C–F ran the identical AO pipeline, so their p95 spread bounds that harness's leg-to-leg drift at ~4 ms and leg G's 8.7 ms is barely twice the drift floor.
- **Tier / Size / Backends:** OPUS-EDGE-EXECUTOR (leg) · XS to flip, S to judge · both
- **Depends on:** `Q-143`, `DM-01`. **Ruling touched:** **SR-1 directly** — this is the definition of degrading a feature to win a metric, on a demo whose purpose is inspecting building geometry.
- **Gate:** **M-02** (ship decision).
- **Acceptance:** side-by-side WebGPU element screenshots at the demo's own camera (`main.js:31-38`, 235.65 m, pitch −20°) at SSE 16 and SSE 24, **plus the WebGL reference at each**, read by eye — a diff percentage alone does not settle it. Frame cost multi-metric from **separate page loads**, never a post-settle mutation.
- **Binds:** SR-1, SR-6, SR-8, **SR-17**. **Source:** D1 §3a row D2. Runs as a leg inside **tranche B**.

### `DM-04` — `viewer.resolutionScale` legs (critic's addition; never evaluated)

- **Disposition:** OPEN. `resolutionScale` is a widget property of the **engine's own widget** — `packages/engine/Source/Widget/CesiumWidget.js:1130-1145` is the accessor, `:279` computes `pixelRatio *= widget._resolutionScale`, `:281-282` assigns `widget._scene.pixelRatio` (all three re-read 2026-08-29). **Note the path: this is `packages/engine/Source/Widget/`, not `packages/widgets/` — `Q-146`'s “spend nothing in `packages/widgets/`” does not apply here** — so it is backend-neutral by construction and is the **control leg** for whether this demo's WebGPU frame is fill-bound at all.
- **Tier / Size / Backends:** OPUS-EDGE-EXECUTOR (legs) · XS · both
- **Depends on:** `Q-143`, `DM-01`. **Ruling touched:** none; judged under SR-1. **Gate:** deferred — it inherits **M-02**'s wording only if a leg is proposed as the demo default.
- **Acceptance:** legs at 1.0 / 0.75 / 0.5 on both backends from separate page loads, multi-metric (frame p50/p95, per-`Pass` `commandList.length`, GPU time under interleaved A/B, heap), with element screenshots at each scale. **Its value as a control is the primary deliverable:** if 0.5 does not move the WebGPU frame, the frame is not fill-bound and `DM-12` loses its remaining plausibility here.
- **Binds:** SR-1, SR-6, SR-8, SR-9, **SR-17**. **Source:** ledger `:131`, critic's additions. Runs as a leg inside **tranche B**.

### `DM-05` — `scene.logarithmicDepthBuffer = false` leg

- **Disposition:** OPEN, **with the critic's framing corrected.** The model **pick** fleet does carry a LOG_DEPTH axis: `WebGPUShaderDefines.ts:372` `LOG_DEPTH: 1 << 15`; `WebGPULogDepth.ts:90-95` computes the pick-fleet switch; `WebGPUModelRenderer.ts:5588` calls `maybeUpdateForPickLogDepth`, and `WebGPUModelPipelineCache.ts:3015-3025` flips `_pickLogDepthEnabled` and **clears four pick pipeline maps**. The real hazard is the opposite of the note's: a mid-session flip is a **cache-invalidation event** — expensive against `Q-134`'s measured 1.6–2.6 s per pipeline creation.
- **Tier / Size / Backends:** OPUS-EDGE-EXECUTOR (leg) · XS · both
- **Depends on:** `Q-143`, `DM-01`. **Ruling touched:** none; adjacent to `Q-102` / `Q-134`. **Gate:** none.
- **Acceptance:** a **separate page load with the flag set before the first tileset is added** — never a mid-session flip, which measures the invalidation. Report time to `Scene.renderReady`, `pipelineCache.created/misses/pending` at first non-empty command list, and the pick hit rate, both backends. Depth correctness by element screenshot at the demo camera (235 m over a building — z-fighting is the visible failure mode).
- **Binds:** SR-4 (do not touch the define registry to run a leg), SR-6, SR-8, SR-9, **SR-17**. **Source:** ledger `:131`; correction is D1 §6 item 4. Runs as a leg inside **tranche B**.

### `DM-06` — streaming-phase tileset flags: listed, never evaluated

- **Disposition:** OPEN. The report listed `preferLeaves`, `progressiveResolutionHeightFraction`, `foveated*` and `cullRequestsWhileMovingMultiplier` and evaluated none, because the harness could not. These are the only flags that act on the phase that is failing. `preloadWhenHidden` is excluded — it already defaults `false` (`Cesium3DTileset.js:471`) and is optimal (`DM-N9`).
- **Tier / Size / Backends:** OPUS-EDGE-EXECUTOR (legs) · S · both
- **Depends on:** `DM-01` (hard — unmeasurable without per-load legs), `Q-143`. **Ruling touched:** **SR-1 on two of the four levers.** `foveated*` and `progressiveResolutionHeightFraction` are **visual-quality** levers — `foveated*` degrades off-centre screen-space error by construction — so they inherit `DM-03`'s SR-1 framing and its gate **M-02**. `preferLeaves` and `cullRequestsWhileMovingMultiplier` are **scheduling** levers and do not. **Gate:** **M-02** for the two SR-1-bearing levers if either is proposed as a demo default; none for the two scheduling levers' measurement.
- **Acceptance:** one page load per flag value, each timed to `Scene.renderReady`, with per-tileset residency bytes at the gate, both backends. A flag that does not move time-to-`renderReady` outside the harness's own leg-to-leg drift — established with a repeated identical leg — is reported as **no effect**, not as a small win.
- **Binds:** SR-1, SR-6, SR-8, **SR-17**. **Source:** ledger `:131`, critic's additions. Runs as legs inside **tranche B**.

### `DM-07` — pick-emission and pick-pipeline counters (the discriminator for `Q-141` and `DM-11`)

- **Disposition:** OPEN, pure instrumentation, and the **prerequisite** that turns two hypotheses into a falsifiable test. Verified premises: `WebGPUModelRenderer.ts:7214` `if (!defined(activePipeline)) { continue; }` sits above `:7602` (pick command construction) and `:7606` (`attachPickToColorCommand`); `WebGPUModelPipelineCache.ts:3716-3745` `getPickPipeline` misses into `createPickPipeline`, a bare synchronous `device.createRenderPipeline` at `:1227` into the per-instance `_pickPipelines` map, while the colour path at `:3346` goes through the device-deduped async central cache.
- **Tier / Size / Backends:** SONNET-BOUNDED · **S** · WebGPU only (WebGL links `ShaderProgram`s synchronously and has no equivalent coupling)
- **Four-file waiver, stated because §0.1 bounds SONNET at one or two files:** the four touched files — `WebGPUModelRenderer.ts` (`:7214`, `:7602`), `WebGPUModelPipelineCache.ts`, the `getDebugSnapshot()` publisher and the mandatory `DEBUGGING_GUIDE.md` registration — are **all additive counters with no logic change**, which is why the tier stands and why the size is S, not XS. A brief that grows a logic change re-tiers the row.
- **Depends on:** none — but must land **outside** a running Edge tranche (SR-5). **Ruling touched:** none. **Gate:** none.
- **Acceptance:** four pragma-wrapped counters published through `getDebugSnapshot()` and registered in `DEBUGGING_GUIDE.md`: primitives skipped by the ready gate per frame; pick commands emitted per frame; `getPickPipeline` call count; summed `createPickPipeline` wall time. Read them **from the engine's own snapshot**, never computed by the harness. **Falsifiable prediction recorded before the run:** skipped-by-ready-gate is non-zero and tracks `pipelineCache.pending`, and the pick hit rate recovers toward WebGL's as `pending` reaches 0. If skipped is ~0 while hits stay at 4/40, **`Q-141`'s readiness half is refuted** and the whole miss belongs to the stale readback. **Inertness mutant:** make the increment unreachable and the spec must go red.
- **Binds:** SR-3, SR-5, SR-7, SR-12. **Source:** D1 Wave 1 `DM-07`; memo §3b E-2/E-5 acceptance bullets.

### `Q-141` — WebGPU model pick commands are unbuildable while the colour pipeline is pending

- **Disposition:** OPEN, CRITICAL — the demo's title feature is functionally broken on WebGPU while content streams. Second mechanism: `WebGPUPickFramebuffer.ts:1282-1300` returns `[]` on the cold-pick path with a latched `console.warn` steering callers to `pickAsync`; with zero frames produced in the window there is no previous frame to serve from.
- **Tier / Size / Backends:** OPUS-JUDGMENT · M · WebGPU only — but **SR-2 check owed**: confirm in the brief that no WebGL twin exists rather than assuming it.
- **Second dispatch:** OPUS-EDGE-EXECUTOR — the `hitSearch` and pick re-run legs are browser work and belong to **tranche C**, after this row and `Q-142` land and the tree is rebuilt.
- **Depends on:** `DM-07` (hard — the counters are the discriminator; without them the fix may address the wrong half). **Ruling touched:** none; cross-references `Q-134` and `F5-16`. **Gate:** none — this is a broken advertised feature, not a trade-off.
- **Risk the brief must carry:** `WebGPUModelPipelineCache.ts:3281-3284` records the synchronous builders as a deliberate **must-render hatch** and `:3393-3394` warns a null pipeline must never be bound; the pick bind groups are produced today as a by-product of colour-command construction. This is a **restructure of emission order, not a moved `if`** — getting it wrong yields wrong feature IDs, which is worse than a miss. Do not remove the hatch.
- **Acceptance:** with `DM-07`'s counters live, re-run the `hitSearch` and pick legs on both backends at the same validated position. Observable target: `hitSearch` recovers from 0/25 and the timed pick hit rate recovers from 4/40 toward WebGL's 40/40 **while `pipelineCache.pending` is non-zero** — i.e. picking works *during* streaming, which is the defect. **No frame-time gain is claimed and none may be reported as one.** Assert the emitted pick-command count observed by the engine; carry an inertness mutant.
- **Binds:** SR-2, SR-3, SR-5, SR-7, SR-10, SR-12, SR-13, **SR-17** (its re-run legs). **Source:** D1 Wave 2 `Q-141`; memo V-2, §3b E-2, C-9; ledger `:132`.

### `Q-142` — WebGPU AO reads `uniforms.stepSize` where the stage exposes `stepCount`

- **Disposition:** OPEN — a live default-path parity break well outside this demo, with **four** faults, not one. **Perf direction is NEGATIVE and is disclosed here so it is not later mis-triaged as a regression.**
  1. **Wrong bridge key.** `WebGPUPostProcessStageCollection.ts:720` reads `stepCount: numU(ao?.uniforms?.stepSize, 4)`; the AO composite exposes no `stepSize` (`PostProcessStageLibrary.js:496-505` defines `directionCount` default 8 and `stepCount` default 32; `stepSize` belongs to the **blur** stage). `numU` returns its default for a non-number, so **WebGPU runs `stepCount = 4`, always** (re-verified 2026-08-29).
  2. **Fixed WGSL clamps.** `AmbientOcclusionGenerate.wgsl:178` `if (d >= 8) { break; }` and `:184` `if (s > 16) { break; }`; the WebGL2 twin has no such cap on the `__VERSION__ == 300` path.
  3. **The divisor does not match the executed loop** (new in D1): `:201` divides by the **unclamped** `directionCount * stepCount` — at the demo's `directionCount = 16` the loop accumulates 32 samples and divides by 64, an extra ~2× under-weight. The clamp fix must move the divisor with it.
  4. **Three WGSL texts, not one** (new in D1): `AmbientOcclusionGenerate_f16.wgsl` carries identical clamps (`:133`, `:139`) and divisor (`:157`); `GTAOGenerate.wgsl` has no direction clamp and is hit by fault 1 only. The demo never sets `algorithm`, so `:704-711` resolves `"hbao"` and `WebGPUAmbientOcclusionEffect.ts:633-638` picks the f16 or f32 HBAO text. **Trap:** fixing the key alone yields `stepCount 32` clamped to 16, and since `:175` is `stepLen = lengthCap / f32(stepCount)`, that **silently halves the AO radius**. Key, clamps and divisor move together or not at all.
- **Tier / Size / Backends:** **OPUS-JUDGMENT** · S–M · WebGPU is the defect, WebGL is the **reference** and must stay byte-identical
- **Why the tier moved, deliberately:** §0.1 bounds the lower tier at one or two files with no cross-file judgement and routes anything touching parity to OPUS-JUDGMENT, and this row as scoped touches **five** — `WebGPUPostProcessStageCollection.ts`, `AmbientOcclusionGenerate.wgsl`, `AmbientOcclusionGenerate_f16.wgsl`, `GTAOGenerate.wgsl`, `WebGPUAmbientOcclusionEffect.ts` — as a **four-text lockstep** on a parity row. The tier was inherited from the pre-scope ledger row `:133`; the scope grew and the tier now follows it. **Do not split the key fix out as its own landing:** the key alone yields `stepCount 32` clamped to 16 and silently halves the AO radius via `:175`.
- **Second dispatch:** OPUS-EDGE-EXECUTOR — the WebGPU-vs-WebGL AO capture pair is browser work in **tranche C**, after the fix lands and the tree is rebuilt.
- **Depends on:** none to author. **Ruling touched:** none; cross-reference `FEATURE_INVENTORY.md` §9.
- **Gate:** **M-03** — the **landing form**, not the authoring. The fix and its spec are dispatchable today; whether it lands default-on or behind a default-off define needs the answer.
- **Acceptance:** a spec that sets `scene.postProcessStages.ambientOcclusion.uniforms.stepCount` and asserts **the value reaching `addAmbientOcclusion`** — failing today at `:720`. Assert the value the pipeline receives, never source text and never a harness-injected binding. Plus a WebGPU-vs-WebGL AO capture pair before and after at the demo camera, read by eye, with the frame-time delta disclosed as **the expected cost**, multi-metric. **Inertness mutant:** short-circuit the corrected read and the spec must go red.
- **Binds:** SR-1 (the SR-1 case in reverse — the current state is a silent degrade that "wins" a metric; correcting it is correctness work), SR-2, SR-3, SR-5, SR-6, SR-7, SR-8, SR-12, **SR-17** (its capture pair). **Source:** D1 Wave 2 `Q-142`; memo C-3, V-8, §3b E-3(a); ledger `:133`; faults 3 and 4 are D1 §6 items 1–2.

---
## 3. WAVE 2 — engine rows behind their measurements

Every row here has an unknown or void numerator today. None is briefed before its measurement reports.

### `Q-149` — the moon modulation is a flat multiply; clamp it with a limiting-magnitude floor

- **Disposition:** HELD behind `Q-148`. A direction-independent `×0.19448` darkens Sirius and the Milky Way equally at in-column night cameras. **Six-text lockstep:** `SkyBoxFS.glsl:76-81`; `Shaders/WebGPU/CubeMapPanorama.wgsl:170-182`; `WebGPUCubeMapPanoramaRenderer.js:170-190` (the **production inline shader** — the WGSL file's own header says so); `StarFieldMath.ts` `computeStarBrightnessModulation`; `StarFieldVS.glsl:166`; `Shaders/WebGPU/Catalog/StarField.wgsl`. **Do not touch the constants** — `STAR_MODULATION_INFLECTION = 0.0` and `STEEPNESS = 23.0` are *solved* from the eclipse-totality anchor (ruling **E3**). The defensible statement is that `0.19448 = 10^(−0.4 × 1.778 mag)` at μ = 18.34 mag/arcsec²: the **value** is published photometry, only its **application as a flat multiply** is wrong. `C12-36` already closed the estimator half (full-moon-overhead 0.018176 → 0.165959; NELM 2.15 → 4.55) — brief it that way or a worker re-derives the estimator. **Preserve** the `_isStarMap` gate (`CubeMapPanorama.js:511`/`:513`) or generic and Street-View panoramas start being dimmed, and the contract order *modulate, cloud-occlude, glare, gamma*.
- **Tier / Size / Backends:** OPUS-JUDGMENT · S (the floor; the graded law is `EAN-08`) · both
- **Depends on:** `Q-148`. **Ruling touched:** none for the form. DR-01 assigns *ownership*, not the exposure law; ruling **E3** governs the constants' values and must survive untouched. **Gate:** none for the floor.
- **Acceptance:** pinned to **view (6)** (8.75 E, 6 S, 600 m) at `2026-08-30T23:25:00Z` — a default-camera or 400 km leg reads factor 1.0 and would pass **vacuously**. At `skyBrightness = 0.031`: a mag-1 star loses **< 0.2 mag**, a mag-5 star loses **> 1.5 mag**. Both dialects agree to 1e-6 through `wgsl-mini-eval.mjs`. **Negative controls:** views (1)–(4) byte-identical (the column fade makes the term inert above 111 km — `SkyBrightness.js:563`), views (5)/(7) byte-identical (sun up). `eclipse-sky-totality.spec.mjs` and `sky-brightness-twilight.spec.mjs` stay green. **Mutant:** make the floor inert and the mag-1 leg must go red.
- **Binds:** SR-1, SR-2, SR-3, SR-4, SR-5, SR-6, SR-7, SR-10, SR-14, SR-15. **Source:** D2 Wave 3 `Q-149`; memo A4; ledger `:121`.

### `DM-08` — WebGPU AO has no runtime config propagation

- **Disposition:** HELD behind `Q-142`. On WebGPU the AO configuration is **latched at first enable** and no later uniform write reaches the shader: `WebGPUPostProcessStageCollection.ts:700` `if (cache.ambientOcclusionEnabled && !cache.aoInitialized) {` … `:740` sets it true, and `aoInitialized` is **never reset** (four sites total). `WebGPUAmbientOcclusionEffect.ts:929 updateConfig` has **zero callers** in `packages/engine/Source` — only Bloom's is called. `Q-142` fixes what the first latch reads; this row fixes that there is only ever one latch. **New in D1:** `WebGPUDepthOfFieldEffect.ts:330 updateConfig` is also uncalled, so scope the row to the propagation **mechanism**, not to AO alone, or the fix lands twice.
- **Tier / Size / Backends:** OPUS-JUDGMENT · S · WebGPU (WebGL propagates through the stage's own uniform map; SR-2 check owed in the brief)
- **Depends on:** `Q-142` (land the key/clamp/divisor first, or the propagation carries wrong values). **Ruling touched:** none. **Gate:** none.
- **Acceptance:** enable AO, render, then change `intensity` / `lengthCap` / `directionCount` / `stepCount` at runtime and assert **the values the AO pipeline receives change**, plus an element-screenshot pair showing the visual change. Today the second write is inert. **Inertness mutant:** make the new propagation call unreachable and the spec must go red. WebGL byte-identical.
- **Binds:** SR-2, SR-3, SR-5, SR-6, SR-7, SR-10 and SR-13 (`aoInitialized` and the uncalled `updateConfig` are scaffolding for exactly this — complete them, do not delete them), SR-12. **Source:** D1 Wave 2 `DM-08`; memo C-3, §3b E-3(b).

### `DM-09` — WebGPU tile-content residency/preparation starves the frame loop

- **Disposition:** HELD behind `Q-143`. The gap is CONFIRMED and large; the **mechanism is unproven and two code-reading hypotheses have already failed on magnitude**. Diagnosis-first row. **What the brief must NOT do:** do not open `WebGPUModelRenderer.ts:5467` as the suspect — the citation is exact and genuinely per-`Model`, but the pools are device-shared and refcounted and the one genuinely per-call item measured ~0.038 ms per composition. **Best-supported leads to carry into the profile, not to assert:** **(a)** central pipeline creation — 12 central pipelines in ~92 s against `Q-134`'s 1.6–2.6 s each is 19–31 s **if serial**, but the snapshot shows them overlapping, and it explains *skipped draws*, not *slow frames*; **(b)** `Scene/Model/Model.js` contains **no `jobScheduler` / `JobType` reference at all**, so model resource processing is not budgeted by the frame's job scheduler the way tile requests are (Cirdan §5 open question 1 — carried with the same not-asserted framing he gave it).
- **Tier / Size / Backends:** OPUS-JUDGMENT · L · WebGPU (WebGL is the reference)
- **Depends on:** `Q-143` (hard). **Ruling touched:** owned by `C11-168` (`QUEUE_2026-07-18_CAMPAIGN11.md:2003`); adjacent to `F5-02`. **Gate:** **M-04** (funding).
- **Acceptance:** **defined by what `Q-143`'s CPU sampling profile names as the main-thread consumer. Until the profile exists this row has no acceptance criterion and must not be briefed.** When it does: before/after on time-to-`Scene.renderReady` and `scene.frameNumber` accrual over a fixed wall-clock window, both backends, interleaved, multi-metric, plus element screenshots proving no content is lost.
- **Binds:** SR-1, SR-5, SR-6, SR-7 (two hypotheses already failed — the third is briefed from the profile, not from code reading), SR-8, SR-10. **Source:** D1 Wave 3 `DM-09`; memo V-1/V-3/V-4, §3b E-4.


**Diagnosis (lane Turin, wave 2, reviewer Forlong):** the WebGPU settle window is four discrete off-main-thread waits (Leg A gaps 3.8 / 14.3 / 15.5 / 36.7 s = 70.3 s of 95.9 s; Leg B 65.0 s of 95.3 s). Inside the largest gap the renderer's main thread stayed healthy (the 250 ms poll fired 142 times at a 251 ms median) while no animation frame was delivered and no `createRenderPipelineAsync` promise settled; `created`, `pending`, `hits` and `misses` did not move. Every candidate mechanism in the brief is ruled out with a citation and fenced by `webgpu-pipeline-creation-not-frame-coupled.spec.mjs`; `aec-residency-stall-locus.mjs` reproduces the finding offline from any banked receipt. `pipeline-creation-bound` stands as a band reading, not a cause. One unmeasured candidate is recorded and not funded: `warmUpGlobeRenderer` compiles the terrain WGSL at context init with no globe check.

**Next measurement (E-2, lane Helm, wave 3, reviewer Arvedui):** `probe-aec-residency-e2.mjs` adds a Chrome trace over the settle window (gpu, viz, gpu.device, toplevel categories), an independent animation-frame logger, a shader-module census published through the debug snapshot, and three controls as separate loads (globe-less with the init prewarm declined through the new `prewarmGlobeRenderer` context option, AO off, one tileset). The Edge run in both orders is the acceptance; DM-09 is funded only after it names the occupant.

### `DM-16` — `probe-aec-perf` streaming-readiness criterion

- **Id correction:** filed as `DM-10` in Batch 1378 by mistake; `DM-10` already named the unaccounted-heap row. Renumbered to `DM-16` here; every 2026-09-02 reference to the readiness criterion means this row.

- **Origin:** Nimloth's station-3 review of Batch 1371 (finding F1, non-blocking, queued as its own row).
- **Finding:** the probe's readiness loop breaks on `Scene.renderReady` after one forced frame; in the eight-tileset AEC scene that is true on the very first frame with zero tile content loaded (`framesToRenderReady: 1` in both control runs). Receipts therefore time, and take per-pass counts, frame p50–p95 and heap from, an unloaded scene; `__aecFindPick` never waits for content, so `pick-position-not-found` is the likely next refusal on the full CLI path.
- **Disposition:** QUEUED. No DM-01 receipt is cited as AEC perf evidence until a real streaming-readiness criterion lands (content selected and uploaded for every created tileset, or a settle on `tilesLoaded` with a bounded wait and a refusal when it does not settle). The Batch 1371 fix (observe the first traversal on `postRender`) stands: it corrected the observation point, not the readiness criterion.
- **Acceptance:** the 16-cell run on a fresh served build with the new criterion shows non-zero content residency at readiness for every cell that is not refused, and the receipt records the criterion it used.

### `DM-10` — ~2.4 GB of unaccounted WebGPU JS heap on a dense-tileset scene

- **Disposition:** HELD behind `Q-143` — a **stability** row, not a perf row. The residency counters that `clear()` does not reset show WebGPU holding **less** tracked content than WebGL while using ~6.6× the heap, which refutes the "content backlog" explanation. **Caveat with teeth:** the run was `Build/CesiumUnminified` with debug pragmas retained on **both** backends — the ratio is not a production number, but the pragmas are symmetric so the asymmetry survives. `Q-143` acceptance item 6 closes it.
- **Tier / Size / Backends:** OPUS-JUDGMENT · M (unknown until the retainer buckets exist) · WebGPU. **Parity story:** WebGPU-specific investigation; no WebGL analogue exists, and WebGL output is asserted unchanged.
- **Depends on:** `Q-143` (specifically the retainer-bucketed snapshot and the minified repeat). **Ruling touched:** adjacent to `F5-02`. **Gate:** none to investigate.
- **Acceptance:** retainer-bucketed heap snapshots at equal content on both backends, and a **named retainer class** accounting for the majority of the WebGPU-specific excess. A row that reports "WebGPU uses more heap" without naming a retainer is not accepted.
- **Binds:** SR-5, SR-7, SR-8. **Source:** D1 Wave 3 `DM-10`; memo V-5, §5 open question 2.

### `DM-11` — WebGPU model pick pipelines build synchronously in a per-`Model` cache

- **Disposition:** HELD, **instrument before funding.** The asymmetry is real and is in **creation**, not storage (`getPickPipeline` → `createPickPipeline` → a bare synchronous `device.createRenderPipeline` at `:1227`, against the colour path's device-deduped async central cache). Its headline evidence — the 4.1× pick cost — is **void**: it compared different cursor positions inside a zero-frame window and scored 4/40 against 40/40 hits.
- **Tier / Size / Backends:** OPUS-JUDGMENT · M · WebGPU. **Parity story:** WebGPU-specific investigation — WebGL links `ShaderProgram`s synchronously and has no per-`Model` pick-pipeline cache; WebGL output and pick results asserted unchanged.
- **Depends on:** `DM-07` (hard), `Q-143` (hard), `Q-141` (correctness before performance on the same path). **Ruling touched:** none; adjacent to `Q-134` and `F5-16`. **Gate:** **M-05**.
- **Acceptance:** `DM-07`'s call count and summed wall time during a hover session **at full residency**, published in the debug snapshot, measured **before any code change**. Then, if funded: hover p50/p95 pick cost at equal content and equal validated position on both backends, interleaved, multi-metric, **with the hit rate reported alongside** — a faster pick that hits less is not a win. Do not remove the synchronous must-render hatch to make the async path clean.
- **Binds:** SR-1, SR-5, SR-7, SR-8, SR-10, SR-12. **Source:** D1 Wave 3 `DM-11`; memo V-7, §3b E-5.

### `DM-12` — elide the unused scene-FB MRT slot 1 and its MSAA colour resolves

- **Disposition:** HELD behind `Q-143` and specifically `DM-04`'s control leg. **Unblocked on the OIT question:** `WebGPUContext.ts:5062-5066` states the attachment-demand record is observe-only and nothing in the render path gates on it; the actual driver is the module-level `let _mrtMode = true;` at `WebGPUSceneFBTargetHelpers.ts:35`, whose only mutator `setSceneFBMrtMode` (`:49`) has **no caller** in `packages/engine/Source`. Payoff for *this* demo is expected near zero; it needs a GPU-bound scene. **State the resolve count as a range, tagged UNVERIFIED (§11):** run 2 records `slot1ResolveOpens: 4`, run 1 records **5**, per frame at frustum count 1 — the run-to-run spread is part of the finding, not a rounding.
- **Tier / Size / Backends:** OPUS-JUDGMENT · M · WebGPU. **Parity story, and it matters most here because this is a scene-framebuffer topology rewrite:** WebGL is untouched, and WebGPU pixels must be **identical before and after** — the resolves are unread (`gbufferReadersMask === 0`), so removing them may not change a pixel at all.
- **Depends on:** `Q-143`, `DM-04`. **Ruling touched:** owned by `F5-04` and audit **action 9** (which already defines the promotion bar: prove with A/B). `F5-18` (the unconditional MSAA **depth** resolve) is adjacent, not primary. **Gate:** none — a gate arises only if someone proposes promoting without the A/B.
- **Acceptance:** exactly the A/B action 9 specifies — a one-target build against the MRT build, compared on GPU time, bandwidth and visual output, at **both** `msaaSamples` 4 and 1, **on a scene that is actually GPU-bound — not this one**. Interleaved A/B, multi-metric, element screenshots read by eye. `WebGPUSceneRenderer.ts:1465-1476` re-reads `scene.msaaSamples` per frame, so the msaa arm is live at runtime. Not a flag — a topology-signature rewrite plus pipeline-cache invalidation; the failure mode is a loud validation error, not a silent artefact.
- **Binds:** SR-1, SR-5, SR-6, SR-8, SR-9, SR-10. **Source:** D1 Wave 3 `DM-12`; memo C-7, V-9, §3b E-6.

### `DM-15` — does the model colour fleet need the globe's prewarm question?

- **Disposition:** HELD behind `Q-143` — an analysis row, not an implementation row. `Q-134`'s cost was measured on the **globe** module; carrying its per-creation cost onto the model module **is a transfer, not a measurement**. This row exists so the transfer is either measured or dropped.
- **Tier / Size / Backends:** OPUS-JUDGMENT · S · WebGPU. **Parity story:** WebGPU-specific investigation — WebGL has no central pipeline cache to prewarm; no WebGL analogue exists and WebGL output is asserted unchanged.
- **Depends on:** `Q-143` (the per-frame `pipelineCache.created`/`pending` sampling). **Ruling touched:** none; adjacent to `Q-120` (`FIX_QUEUE…:384`) and `Q-134` (`:226`). **Gate:** none.
- **Acceptance:** the measured wall time of a **model** central-pipeline creation and the miss accounting during the settle window, reported next to `Q-134`'s globe figures. Outcome is one of: (a) the model fleet shares `Q-134`'s cost and `Q-134` widens to cover it; (b) it does not, and `Q-134` stays globe-scoped. Either outcome closes this row.
- **Binds:** SR-5, SR-7, SR-8. **Source:** ledger `:131` critic's additions; memo V-4 transfer caveat.

---

## 4. WAVE 3 — rows behind a maintainer answer

Nothing here can be **authored** until the answer arrives, because the answer decides what the row is. Each question is reproduced verbatim as the memo recorded it; the numbering `M-nn` is this document's, and the original ids (`Q1`–`Q5`, the design-model gate table) are kept beside them.

### `Q-150` — flip `SkyBox.defaultVariant` to the bundled un-blurred `TYCHO_T5` — HELD on **M-06 (Q1)**

> **Why it is ripe now — the ledger's own precondition, and the head of Celeborn's Q1.** *"`QUEUE_2026-07-19_CAMPAIGN12.md:59` says the DR-01 revisit becomes 'a clean single-variable question — **DR-01 is NOT decided until then**', and `:22` records that the 2026-08-29 Edge tranche 3d G3 re-run on the 4096 tier met the condition."* (both re-read 2026-08-29 — without this preamble **M-06** reads as a question that could have been asked at any time.)
>
> *"DR-01 assigned every resolved star to the sprite catalogue and the cube map to diffuse light only. Measured at your own instant and camera (view 6, 600 m, Moon 57° up at phase 0.91), on both backends, as point-like maxima in a chrome-free sky region: the shipped default delivers **0** resolved point sources; the bundled un-blurred `TYCHO_T5` variant delivers **603 (WebGPU) / 1,136 (WebGL)** with the Moon still up; upstream's `TYCHO_T3` delivers **614 / 1,120**; hiding the Moon as well reaches **14,500 / 18,167**. Above 111 km the Moon term is inert, so at views (1)–(4) the variant is the whole story. The sprite route is capped: it delivers 228 sources/sr against t3's 1,311 (**0.174×**, DR-01's own reversal metric, TRIGGERED), a mag-6.0 re-bake reaches about 0.31×, and Hipparcos/Tycho/Gaia are recorded licence-incompatible — so a licence-clean catalogue can **never** reach upstream's density. Do you: **(A)** keep DR-01 and fund the catalogue — PSF phase fix plus mag-6.0 bake plus a magnitude-graded moon law, M–L, both backends, ceiling about 0.31× upstream; **(B)** reverse DR-01 by flipping `SkyBox.defaultVariant` to the bundled un-blurred `TYCHO_T5` — S in code, but it reddens `skybox-diffuse-seam.spec.mjs:633`, moves G3's certification subject, and re-admits the double-painting `C12-10` rejected; or **(C)** keep the engine default and expose the variant per-scene so demos opt in — XS, already possible today via `SkyBox.createEarthSkyBox(variant)`?"*
>
> **Attach to the same sitting:** the **4096 tier** protocol decision, **with its three options as Celeborn stated them** — land it **opt-in at 19.5 MB**, ship it as an **external asset through the `C12-12` policy seam**, or **drop it** (an option-less ask cannot be answered in a sitting); **G3's chroma and dust arms**, whose `R-2026-08-10-4` trigger the tranche-3d result now satisfies; and **one figure correction** — `R-2026-08-28-11a` describes "263 BSC5 stars"; the shipped table is **2,868** (`BrightStarCatalog.js:35-39`; `LICENSE.md:1474`; `packages/engine/LICENSE.md:1429`).

- **Tier / Size / Backends:** OPUS-JUDGMENT · S in code (the weight is in the ruling, not the row) · both (shared asset, no shader change). Unblocks on the maintainer ruling; the standing station-3 review obligation is §0.1's and is not restated as a tier.
- **Depends on:** `Q-148`. Mutually exclusive in spirit with `EAN-01` option (C) — `EAN-01` is the (C)-shaped answer already available today. **Ruling touched:** **DR-01 / `C12-11`** and `R-2026-08-28-11` item 3. **Gate:** **M-06 (Q1)**.
- **Acceptance:** point-source census in a chrome-free sky box, Moon at its shipped elevation, both backends. Pinned: D0 = **0** maxima. The fix must exceed leg F's 603 / 1,136 at view (6) and reach **≥ 300 maxima with ≥ 2,000 px ≥ luma 8 at views (1)–(4)**. Views (5)/(7) and a daylight frame byte-identical. `skybox-diffuse-seam.spec.mjs` and G3 re-run **against their new subject in the same landing**, or the ruling is silently un-enforced. **Target `TYCHO_T5`, not upstream's `TYCHO_T3`** — `SkyBox.js:420-422` bundles T5 expressly as the reversal artifact, and G3 asserts T3 fails three fork bars at HEAD. **New finding to carry:** `skybox-diffuse-seam.spec.mjs:633` is an `assert.match` over **source text** and is vacuous under SR-7; whatever the ruling, the replacement enforcement must assert the **resolved variant on a constructed sky box** (or the census delta), never a regex.
- **Binds:** SR-1, SR-2, SR-3, SR-5, SR-6, SR-7, SR-8, SR-12, SR-14, SR-15. **Source:** D2 Wave 4 `Q-150`; memo A5; ledger `:122`, `:125`.

### `EAN-08` — the per-star limiting-magnitude law — HELD on **M-07 (Q2)** and **M-09 (Q4)**

> **M-07 (Q2), verbatim.** *"At view (6) the fork correctly computes a moonlit sky at a zenith brightness of 18.34 mag/arcsec² — a 1.78-magnitude naked-eye loss from published photometry — and then applies it as a flat ×0.19448 on the image, so Sirius and the Milky Way dim equally. Two things follow: a magnitude-graded law (C4) will still make the fork's moonlit nights darker than upstream's, which models nothing; and the sky the photometry describes is a luminous blue-grey dome, which the fork does not paint at all (C5). Do you want **(i)** the graded law alone — correct and less pretty; **(ii)** the graded law **plus** the additive dome — correct and, at that instant, a frame upstream cannot render; or **(iii)** the modulation defaulted off for a demo-facing sky?"*
>
> **M-09 (Q4), verbatim.** *"Do C4 (limiting-magnitude law) and C5 (additive night-sky luminance) go into C12's star lane now, or do they queue against a C17 launch decision alongside `CLT-D10` and `C12-26`?"* C17 is proposed, not launched; `R-2026-08-21-16` already routed `C12-26` there.

- **Tier / Size / Backends:** OPUS-JUDGMENT · M–L · both (the same six-text lockstep as `Q-149`)
- **Depends on:** `Q-148`, `Q-149`. **First step, a prerequisite not a nicety:** publish the **raw zenith magnitude** on `frameState` — `Scene.js:4110-4117` writes only the encoded 0..1 scalar, and both `EAN-08` and `EAN-09` need μ. **Ruling touched:** none, but ruling **E3**'s constants and its default-on stance must survive. **Gate:** **M-07 (Q2)** and **M-09 (Q4)**.
- **Acceptance:** as `Q-149`, **plus** a near-horizon leg at view (6) showing bright stars surviving to within about **5° of the horizon**, and byte-identity at (1)–(4) and (5)/(7). The row must also decide what the three `skyAtmosphereVisible` gates do, and confront `StarFieldVS.glsl:139-146`'s Bouguer extinction — which upstream's cube map does not have at all, an independent structural reason the cube map rather than the catalogue is the parity route.
- **Binds:** SR-1, SR-2, SR-3, SR-4, SR-5, SR-6, SR-7, SR-10, SR-12, SR-14, SR-15. **Source:** D2 Wave 4 `EAN-08`; memo C4.

### `EAN-09` — paint the sky the photometry already computes — HELD on **M-07** and **M-09**

- **Disposition:** HELD. `SkyBrightness` produces a real zenith surface brightness in V mag/arcsec² and **every consumer is subtractive**. Consume it **additively** as night-sky luminance on the sky shell. At the maintainer's instant μ = 18.34, so the naked-eye limit is `6.5 − 0.5 × (21.9 − 18.34) = 4.72`: the physically correct view (6) is a luminous blue-grey dome with roughly a third of the catalogue showing through, not a void. **This is why view (6) reads as *nothing* rather than as *a moonlit night*, and why the `Q-149` crush looks like a bug — the fork shipped half a law.** It subsumes the airglow half of the audit's E-5 at zero cost: `SkyBrightness.js:148 NIGHT_ZENITH_MAGNITUDE = 21.9` **is** that floor.
- **Tier / Size / Backends:** OPUS-JUDGMENT · M · both
- **Depends on:** `Q-148`; the `frameState` zenith-magnitude publish from `EAN-08`; **pair with `EAN-10`** or an 8-bit target will band the dome. **Ruling touched:** none. **Gate:** **M-07**, **M-09**.
- **Acceptance:** at view (6) the rendered shell luminance corresponds to a zenith magnitude of **18.34 within 0.2 mag**; the moon-hidden control lands on **21.9**; views (1)–(4) and the daylight views (5)/(7) **byte-identical** — the second identity comes free from the column fade, and if it does not hold the edit escaped its scope.
- **Binds:** SR-1 (it changes **every** night frame — that is the point, and it must be presented as an appearance change, not smuggled), SR-2, SR-3, SR-5, SR-6, SR-7, SR-10, SR-12, SR-14, SR-15. **Source:** D2 Wave 4 `EAN-09`; memo C5.

### `EAN-10` — STBN dither as a rider on `EAN-09`, not a standalone win

- **Disposition:** HELD, rides `EAN-09`'s landing. `Scene/StbnNoiseVolume.js` ships with an in-repo mask, so there is **no provenance question**. On its own it is nearly invisible; the moment `EAN-09` paints a low-luminance dome on an 8-bit target it becomes necessary.
- **Tier / Size / Backends:** OPUS-JUDGMENT · S · both
- **Depends on:** **`EAN-09` (hard — do not dispatch standalone).** **Ruling touched:** none. **Gate:** inherits **M-07** / **M-09**.
- **Acceptance:** a horizontal luminance profile across the night gradient at view (6) with the banding steps gone; no visible noise at 1× zoom; (5)/(7) and a daylight frame byte-identical; and — the containment that matters — the **`px ≥ 8` count in a star-free sliver unchanged**. Lifting the black floor would corrupt every star metric in this document.
- **Binds:** SR-1, SR-2, SR-3, SR-6, SR-7. **Source:** D2 Wave 4 `EAN-10`; memo C6.

### `EAN-12` — a demo-facing twilight floor — HELD on **M-10 (Q5)**

> **M-10 (Q5), verbatim.** *"Keep the published NELM law (no stars until sun ≈ −12°) or add a demo-facing floor so the sun-on-the-horizon views show stars as upstream does?"*

- **Disposition:** HELD. This is a **change to a published law**, not a bug fix, and must be briefed that way: the landed estimator publishes star-modulation factors of 0.363078 at −12°, 0.098257 at −9°, 0.026303 at −6°, 0.006619 at −3°, 0.004175 at −2°. The *defect* claim ("no stars at views (5)/(7)") is CLOSED-NEGATIVE at `EAN-X6`; the *option* is this row, so the maintainer is asked rather than the complaint being silently struck.
- **Tier / Size / Backends:** OPUS-JUDGMENT · S if demo-scoped, M if the engine law moves · both if the law moves. Unblocks on **M-10**; the standing station-3 review obligation is §0.1's.
- **Depends on:** `Q-148`. Overlaps `C12-38` at views (5)/(7) — **defer to `C12-38` for the sun disc itself; do not open a competing sun row.** **Ruling touched:** ruling **E3** — its day anchor is precisely the zero this row would floor. A demo-scoped floor touches nothing. **Gate:** **M-10 (Q5)**.
- **Acceptance:** if demo-scoped: at views (5)/(7) the demo's frame shows ≥ N point-like maxima with the floor on and **byte-identical** frames with it off, both backends, engine default unmoved. If the law moves: `sky-brightness-twilight.spec.mjs` and `eclipse-sky-totality.spec.mjs` re-derived and green against the **new** anchors, the totality anchor bit-exact, and a per-elevation sweep published at −18°/−12°/−9°/−6°/−3°/0°/+3.63°.
- **Binds:** SR-1, SR-2, SR-3, SR-6, SR-7, SR-10, SR-12, SR-14, SR-15. **Source:** D2 Wave 4 `EAN-12`; ledger `:125` (the `MAINTAINER QUESTIONS` row — `:126` is a blank line and was a mis-citation).

### `EAN-13` — the demo's instant: moonless or moonlit — HELD on **M-08 (Q3)**

> **M-08 (Q3), verbatim.** *"Should the demo pick a moonless instant so it shows the fork's full sky, or keep a moonlit one so it shows the physics? If moonless, the demo should state the Moon's altitude and phase in a comment so the composition change is not later mistaken for a fix — and note that even moonless, the shipped default still delivers only about 35 stars at view (6)."*

- **Disposition:** HELD. The single largest measured dimmer in the whole 65-file evidence set is **scene composition, not code**: hiding the Moon at the shipped variant lifts the sky from 0 to 35 point sources and mean luma 0.24 to 2.12. The demo already pins its instant at `main.js:25-27`.
- **Tier / Size / Backends:** maintainer ruling to unblock, then SONNET-BOUNDED · XS · n/a (demo code)
- **Depends on:** `Q-146` (same file, same region — land after so the clock fix is not entangled), `Q-148`. **Ruling touched:** none. **Gate:** **M-08 (Q3)**.
- **Acceptance:** if moonless: the demo's opening frame scores ≥ 35 point-like maxima at view (6) on both backends, and the comment states the Moon's altitude and phase at the chosen instant. If moonlit: no change, and the row closes as answered. **Either way the answer is recorded in the demo's comment.** **Honesty note:** a moonless instant is a composition change and must never be reported as a star fix.
- **Binds:** SR-3, **SR-5** (a gallery landing changes what a probe loads — not during a tranche), SR-6, SR-7. **Source:** D2 Wave 4 `EAN-13`; memo §5 open question.

### `Q-144` — the `skipLevelOfDetail` bivariate stencil test is unimplemented on the WebGPU model path — HELD on **M-11**

> **M-11, verbatim.** *"`skipLevelOfDetail` is a documented public `Cesium3DTileset` option that on WebGPU silently draws ancestors over descendants instead of throwing. Implement the stencil test (M–L), or, as an interim, make the WebGPU path warn once and document the flag as WebGL-only until the test lands?"*

- **Disposition:** OPEN and **re-tagged from "untested flag" to a corruption hazard**; held on the answer because the answer decides whether the deliverable is a stencil implementation or a warning. `Cesium3DTileset.js:3548-3552` requires `context.stencilBuffer`, which WebGPU satisfies (`WebGPUContext.ts:4253-4255`), but the WebGPU model colour pipeline declares **no stencil state at all** (`WebGPUModelPipelineCache.ts:953-957`), and a grep for `skiplod|hasMixedContent|selectionDepth` under `Renderer/WebGPU/` returns nothing. **External, verified 2026-08-29:** `GPUStencilFaceState` defaults are `compare: "always"` with all ops `"keep"` and both masks `0xFFFFFFFF` — MDN, `https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/createRenderPipeline` (retrieved 2026-08-29) — so a pipeline with no stencil state always passes and never writes.
- **Tier / Size / Backends:** OPUS-JUDGMENT · M–L (genuinely new code) · WebGPU (additive; at the `false` default nothing changes and WebGL is untouched)
- **Depends on:** `Q-143` for scheduling priority; no hard code dependency. **Ruling touched:** none; the owner is the C11 3D-Tiles parity surface — **C18 does not own it.** **Gate:** **M-11**.
- **Acceptance:** a WebGPU capture of a `skipLevelOfDetail = true` tileset with `hasMixedContent` true showing **ancestor-over-descendant corruption today and correct ordering after** (element screenshots, read by eye); plus proof the pipeline key carries the new stencil axis — two distinct pipelines observed through `cacheStats()` / `listPipelineVariants()` for stencil-on and stencil-off descriptors, with `stats.wrongModuleHits` reading 0. Byte-identical output at the `false` default on both backends. Note the key already folds `dz:` depth/stencil structurally, so the question is whether the new state actually reaches `buildPipelineDescriptor`, not whether a marker was remembered.
- **Binds:** SR-2, SR-3, SR-4, SR-5, SR-6, SR-7, SR-10, SR-12, SR-13. **Source:** D1 Wave 3 `Q-144`; memo C-5, §3b E-7; ledger `:135`.

### `DM-13` — the contained GPU culler and Hi-Z are blind to `Pass.CESIUM_3D_TILE` — HELD on **M-12**

> **M-12, verbatim.** *"`DM-13` is a real capability gap with no measured payoff anywhere. File it against FORK-41 / `C11-98` and leave it unscheduled, or is there a scene shape you want it measured on?"*

- **Disposition:** FILE ONLY — do not schedule for this demo. The activation gate's input is the per-frustum **OPAQUE** bin (`WebGPUSceneRenderer.ts:2293`, consumed at `:2380`/`:2386`), while this demo's content is entirely `Pass.CESIUM_3D_TILE` (`Model3DTileContent.js:494`; `Pass.js:23` vs `:26`), and the 3D-Tile dispatch reads its own bin un-gated (`WebGPUSceneRenderer3DTilePasses.ts:287-288`). **Cite `:287-288`, not the thresholds** — the thresholds are not the defect.
- **Tier / Size / Backends:** OPUS-JUDGMENT to implement if ever funded (the filing is XS) · L · WebGPU. **Parity story:** WebGPU-only capability gap; WebGL's culler is a separate path and is not in scope.
- **Depends on:** none. **Ruling touched:** owner is FORK-41 / `C11-98`. **Gate:** **M-12** — today's deliverable is the filing, which the gate does not block.
- **Acceptance:** none for this demo — the row is a filing. If ever funded: bounding volumes and indirect plumbing on the tile dispatch plus a re-arm story, with a measured cull rate on a scene where the tile bin is large, multi-metric.
- **Binds:** SR-5, SR-10. **Source:** D1 Wave 3 `DM-13`; memo C-4, V-10, §3b E-8.

### `DM-14` — the pick pass re-executes tile content update and traversal (both backends) — HELD on **M-13**

> **M-13, verbatim.** *"`DM-14` targets a backend-neutral pick cost that also affects WebGL, and it is outside the WebGPU-only scope this lane was given. Leave it filed unfunded, or open it as its own cross-backend row? If funded, the narrower shape is 'skip content update for tiles already updated this frame', not 'skip the pass'."*

- **Disposition:** FILED UNFUNDED and the **highest-risk item on the list**. `Cesium3DTilePass.js:28-33` shows the `PICK` options do **not** set `ignoreCommands`; `Cesium3DTileset.js:3853-3865` runs `selectTiles` then `updateTiles` unconditionally, reaching `tile.update` (`:3586`) → `updateContent` (`Cesium3DTile.js:1076`) → `content.update` (`:2408`), which takes **no pass argument**. The trap: `Picking.js:1593` narrows the culling volume to the pick rectangle, so the pick pass's selected set is computed under a **different** culling volume — reusing one for the other is the bug waiting to happen.
- **Tier / Size / Backends:** OPUS-JUDGMENT if ever funded · L · **both** — a backend-neutral floor
- **Depends on:** `Q-141` (hard, if funded — with picking already returning nothing on WebGPU, adding a second silent-miss mechanism is the worst possible sequencing), `Q-143`. **Ruling touched:** none. **No existing owner.** **Gate:** **M-13**.
- **Acceptance (if funded):** a correctness spec pinning current pick results across a **grid** of positions on **both** backends, authored **from the behaviour and not from the fix's brief**, as the independent oracle — then the same grid after. Cost reported multi-metric alongside the hit rate.
- **Binds:** SR-2, SR-5, SR-7, SR-8. **Source:** D1 Wave 3 `DM-14`; memo V-6, §3b E-9.

---

## 5. WAVE 4 — improvements beyond upstream

The `C1`–`C7` family recorded in the ledger at `:124`, plus the appearance restoration. All behind `Q-148`'s repaired instrument; none behind a ruling except where stated.

### `EAN-05` — flux-conserving star PSF with a pixel-space sigma floor. **The enabler.**

- **Disposition:** HELD behind `Q-148`, and **first among the improvements**. `StarFieldFS.glsl:56` `STAR_PSF_SIGMA = 0.12` is **quad-relative** while the quad is sized in **angular** units (`StarFieldVS.glsl:126-127` over `StarField.js:77 _pointAngularSize = 0.003` / `:82 _minPointSize = 0.0022`), so at a 736×554 capture sigma is ≈ **0.23 px** and sampled brightness swings with sub-pixel phase. It is simultaneously the **shimmer fix DR-01 exists to demand** — `aliasTwinkle 2.4477` against a 1.2 bar, `isolatesSubPixelPhase: true`, identically on both backends, on a certifying-resolution asset — **and** a brightness fix. Deepening the catalogue before this lands would fire DR-01's own reversal trigger harder while the maintainer decides **M-06**.
- **Tier / Size / Backends:** OPUS-JUDGMENT · M · both — `StarFieldFS.glsl:56-72` and `Shaders/WebGPU/Catalog/StarField.wgsl` are a locked pair (`starfield-psf.spec.mjs` extracts and compares both texts), plus the JS twin `StarFieldMath.ts:160-232` and the quad sizing at `StarFieldVS.glsl:126-133`
- **Depends on:** `Q-148`. **Blocks `EAN-07`.** **Ruling touched:** **none — it implements DR-01 rather than reversing it**, and moves `aliasTwinkle` from fired to not-fired, which *strengthens* the `C12-11` seam. **Gate:** none.
- **First step, mandatory, before any `--g3` number is quoted:** **repair `celestial-g3-gate.mjs`'s bright-star contrast derivation.** Celeborn: its analytic “bright star contrast control” grows the core with the quad, which `StarFieldFS.glsl:64-65` explicitly prevents by multiplying `rCore` by `v_coreScale`; the gate's own measured numbers agree with the panel's corrected sweep (`brightSumRatio 1.3598` against `faintSumRatio 1.4389`), **not with its docstring**. This is a `Tools/` landing, so **SR-5 does not block it** — it may land during another row's tranche.
- **Acceptance:** `probe-celestial-gates.mjs --g3` on both backends at **736, 1280 and 1920** canvas widths — the width sweep **is** the point, because the defect is resolution-dependent and a single 1280 leg hides it: `aliasTwinkle.triggered === false` at **every** width. Plus a photometry check the suite lacks: **total deposited energy per star within 2% of `EXPOSURE × 10^(−0.4m)`, invariant to canvas width**. **Negative control:** revert the floor and the trigger must return. **Plus the two legs the standing seam hold actually demands** (`C12_STARFIELD_SEAM_DISPOSITION_2026-08-02.md:60-62`, re-read 2026-08-29): a **moving-camera track, not an idle soak**, measuring aliasing/twinkle, **and** the **2,868-sprite frame cost on WebGL and WebGPU**. They are carried here because `EAN-07` is held on that hold and nothing else in this queue meets its condition.
- **Risk for the brief:** the profile is **amplitude**-normalized today, so widening sigma without flux normalization **in the same edit** over-brightens the sky by roughly the square of the ratio. `starfield-psf.spec.mjs` pins the sigma / alpha / beta / K_HALO quadruple across three texts — budget for a deliberate re-pin and say so in the landing message.
- **Binds:** SR-1, SR-2, SR-3, SR-6, SR-7, SR-8, SR-14, SR-15. **Source:** D2 Wave 3 `EAN-05`; memo C1.

### `EAN-06` — star HDR output feeding the bloom bright-pass: verify the path and expose it

- **Disposition:** HELD behind `Q-148`. Star HDR output above 1.0 feeds the bloom bright-pass only when HDR **and** bloom are enabled, and the combination is off by default. Promoted from the audit's rank 4 because on the same mask leg A-default scores 0 peaks and leg G scores 39 (WebGPU) / 9 (WebGL) at the same coordinates as leg F's brightest — so they are catalogue **sprites**, not cube-map texels (a face low-passed at σ ≈ 0.44° cannot produce a 1 px peak). **Upstream cannot do this at all:** a baked JPEG texel cannot overflow a bright-pass.
- **Tier / Size / Backends:** OPUS-EDGE-EXECUTOR (verification + capture; the demo exposure folds into `EAN-01`) · XS to verify and expose — **S if a default flip is ever proposed; do not scope it that way now** · both
- **Depends on:** `Q-148` (its split HDR-only / bloom-only / both legs are this row's evidence), `EAN-01`. **Ruling touched:** verification and demo exposure reverse nothing; a **default flip** of `Scene#highDynamicRange` or bloom would be a C11 default-parity change with a per-frame cost that moves every capture baseline in the fleet. **Gate:** none as scoped; a default flip needs its own ruling and is explicitly out of scope.
- **Acceptance:** HDR-on/off A/B at views (1) and (6), both backends: a halo appears on the **brightest** stars only with HDR + bloom; the sky floor in a **star-free** sliver does **not** lift; and the **39-vs-9 backend asymmetry is explained or shown to be capture noise before either number is quoted**. Frame cost as an interleaved A/B with call counts, timings, memory and allocations together.
- **Binds:** SR-1, SR-2, SR-6, SR-7, SR-8, SR-13, SR-15, **SR-17**. **Source:** D2 Wave 3 `EAN-06`; memo C2.

### `EAN-07` — deepen the sprite catalogue to magnitude 6.0

- **Disposition:** HELD behind `EAN-05` (hard) and the seam-disposition hold. Re-bake to `--limit 6.0` and advance `MAG_CUTOFF` **in the same commit**. Three corrections to the audit's costing: the fork's own documented next step is **mag 6.0 / 5,058 stars for ~52 KB** (`BrightStarCatalog.js:79-80`), not "6.5 / ~9,000 rows / 110 KB"; "no new licence question" holds only to ~6.5 and **both** LICENSE files pin the redistributed volume at 2,868 stars to magnitude 5.5 under DR-02, so both move with the bake; and the parity ceiling is real — 5,058 stars ≈ 402 sources/sr against t3's 1,311, roughly **0.31×**. Also verified: `StarFieldMath.ts:172 MAG_CUTOFF = 5.5` — `WEBGPU_DEBUGGING_LOG.md:15372` still says 5.0 and is **stale**. Brief from the code.
- **Tier / Size / Backends:** OPUS-JUDGMENT · S–M · both — the licence-doc pair plus the `MAG_CUTOFF` coupling is cross-file judgement; data plus shared math, and `data.length / STRIDE` sizes the buffers, so **no renderer change**
- **Second dispatch:** SOL-DIRECTED · S — the bake itself (a bounded producer run with pasted parameters), seat-verified before it touches a tree.
- **Depends on:** **`EAN-05` (hard)** — every star added between 5.5 and 6.0 is by construction a sub-pixel sprite at the phase-swing extreme — plus `Q-148`. **Ruling touched:** none, but it restates DR-02's facts in two LICENSE files and needs the standing hold lifted (`C12_STARFIELD_SEAM_DISPOSITION_2026-08-02.md:60-62`, "do not deepen … until this lane is measured"). **The hold is NOT discharged by this queue's other rows** — re-read 2026-08-29, its own condition is *“run a moving-camera track, not an idle soak, to measure aliasing/twinkle **and** the 2,868-sprite frame cost on WebGL and WebGPU”*, and neither `EAN-05`'s three static `--g3` widths nor `Q-148`'s static point-source census is a moving-camera track or measures that frame cost. Those two legs are now carried in **`EAN-05`'s acceptance**; the hold lifts when they report, not before. **Gate:** **M-06 — this row *is* option (A)'s content** (the mag-6.0 bake). If the maintainer answers (B), `EAN-07` closes and its two LICENSE edits are never made; the seam hold is a second, independent precondition.
- **Acceptance:** row-count and magnitude-range assertion with `star-catalog-depth.spec.mjs` green; Sirius/Vega/Polaris position and **relative-brightness** check; a sprites-only night capture (cube map **and** Moon hidden, camera elevation stated) scored as point-like maxima with a **monotonic response to `intensity`**; both LICENSE files updated in the same commit and asserted. **Drop the audit's "at least 2,000 distinguishable sprite pixels" bar** — it is unreachable by construction.
- **Binds:** SR-1, SR-2, SR-3, SR-6, SR-7, SR-10, SR-14, SR-15. **Source:** D2 Wave 3 `EAN-07`; memo C3.

### `EAN-11` — the radial spoke artifact: diagnose **after** the sky settles

- **Disposition:** HELD. Real enough to keep, undiagnosed, currently near-invisible against a black sky. **The ordering is the row:** its two likely producers — sampling structure in the blurred `t5_diffuse` faces, or a sprite artifact — **both change identity** once `EAN-01` or `Q-150` changes the map. The column-profile check finds near-identical statistics on both backends, which argues **against** the audit's "seen on WebGPU; check WebGL" framing — do not brief it as a WebGPU defect.
- **Tier / Size / Backends:** OPUS-JUDGMENT (the diagnosis) · S · both, treating neither as the health reference
- **Second dispatch:** OPUS-EDGE-EXECUTOR — the moon-off capture legs at views (1) and (6), scheduled into a named tranche, never run alongside another browser job (SR-17).
- **Depends on:** `Q-148`, `EAN-04`, `EAN-05`, and whichever of `EAN-01` / `Q-150` settles the map. **Ruling touched:** none. **Gate:** none.
- **Acceptance:** the fan is **absent** from moon-off night captures at both view (1) and view (6) on both backends, **at the post-fix star brightness** — not at today's, where it is nearly invisible either way. First step is an **angular histogram about the suspected convergence point**, not reading the PNG by eye. **Known contamination:** the existing column profile carries a UI strip with an identical `max 75.3` in every frame including the all-black D0 — `EAN-04` is a hard prerequisite for a clean measurement.
- **Binds:** SR-6, SR-7, SR-10. **Source:** D2 Wave 3 `EAN-11`; memo C7.

### `EAN-02` — the opening frame lost upstream's signature image

- **Disposition:** HELD until the sky is settled. The demo opens on a small, half-dark Earth at 24,000 km (`main.js:31-33`) where upstream opens on the whole globe in Black Marble: upstream's `updateLighting(false)` sets `dayLayer.show = false` and `nightLayer.dayAlpha = 1.0`, while the fork's auto-managed layer is pinned `dayAlpha: 0.0` and can only cover past the terminator. The shipped `thumbnail.jpg` is byte-identical to upstream's and still advertises the lost image. **This is a default-appearance regression, not merely a pedagogy loss.** Off-by-one correction to the audit: `index.html:26-30` already offers **three** options, so re-adding the two-layer recipe is a **fourth**; and the existing `ion` option needs an authenticated session, so it is **unproven, not proven-good**.
- **Tier / Size / Backends:** OPUS-JUDGMENT · S · n/a (demo code; the engine feature is correct and stays) — the day-half question is a design call touching default appearance
- **Second dispatch:** SONNET-BOUNDED · XS — the demo edit itself, once the design call is made.
- **Depends on:** `EAN-01` / `Q-150` (what the sky looks like decides the framing), `EAN-13` (the instant), `EAN-03`. **And on an answer this queue does not own:** `main.js:72` ships `nightIntensity: 2.5` — the exact value whose 500 km frame clips 10.03 % pure white **entirely on the emission arm** — so if `NIGHTFADE-D1` / `Q-123` rule for an emission ceiling, **this row's 24,000 km opening frame is one of the frames that moves. Do not shoot the thumbnail before that answer.** **Ruling touched:** none, but re-adding the recipe partly restores what `VW-N6` deliberately removed — frame it as an *additional teaching option*, not a reversal. **Gate:** none; depends on **M-08** only through `EAN-13`.
- **Acceptance:** one capture per backend at the demo default that a reviewer would place beside the maintainer's screenshots **without commentary** — night limb, city lights and stars in one frame — plus a **re-shot thumbnail**. If the recipe option lands: an ion-authenticated capture reproducing upstream's whole-globe Black Marble frame, with the other three options unchanged. **Trap named in the brief:** landing the camera before the day-half is decided, and re-shooting the thumbnail twice.
- **Binds:** SR-1, SR-3, **SR-5** (a gallery landing changes what a probe loads), SR-6, SR-7. **Source:** D2 Wave 5 `EAN-02`; memo B2.

---
## 6. THE MESHLET TRACK — the `MS-` rows, placement on **M-16** (Meshlets & Mesh Shading)

### 6.0 Track preconditions — read before scoping any row

**Placement, stated once: these rows are written as a wave of the Phase-8b GPU-resident-tiles program** — option (a) of §0 item 4, which ruling **M2** already ratified and which needs no new campaign number. A launched Campaign-19 identity is **M-16**'s alternative, recommended by `D3` only *“if the maintainer wants a launched campaign identity”*. Nothing below depends on which is chosen; only the row ids' home does.

**The maintainer's order is honoured literally: `MS-00`–`MS-02` are mesh shaders and they come first.** What they can honestly contain is constrained by what WebGPU is.

**Mesh shaders do not exist in WebGPU.** Not shipped, not behind a flag, not a proposal, not a `GPUFeatureName`. The load-bearing external claim was re-verified independently for `D3`: the **W3C WebGPU Candidate Recommendation Draft, 20 August 2026** (https://www.w3.org/TR/webgpu/, fetched 2026-08-29) enumerates exactly 23 `GPUFeatureName` values and the strings "mesh shader", "task shader" and "meshlet" **do not occur anywhere in the document**. `R1`'s four other independent negatives — WGSL CR draft 25 Aug 2026 stage attributes are `@vertex`/`@fragment`/`@compute` only (https://www.w3.org/TR/WGSL/); zero mesh entries among the 23 gpuweb proposal documents (https://github.com/gpuweb/gpuweb/tree/main/proposals); Dawn's `Features.cpp` contains no `mesh`/`task`/ `cluster` substring (https://raw.githubusercontent.com/google/dawn/main/src/dawn/native/Features.cpp); and `gpuweb#3015` parked in the untriaged "Milestone 4+" bucket with the wgpu mesh-shading implementer writing on **2026-06-27** that standardization is not expected soon (https://api.github.com/repos/gpuweb/gpuweb/issues/3015) — are consistent with that, all fetched 2026-08-29.

Two honesty amendments follow, both forced by the fork's own record:

1. **There is nothing to feature-detect.** No name exists. A `hasFeature("mesh-shader")` probe would assert against a string invented here. `MS-01` therefore ships a capability **constant** hard-coded `false` citing the issue, plus a **standards canary** that fails loudly if any adapter ever advertises a mesh-shaped feature.
2. **The inert shader-stage scaffold is a maintainer decision, not a foregone one.** `R1` §6 risk 5 recommends explicitly *against* it; Principle 7 then makes it expensive to remove; the fork's naga is pinned at `packages/wasm-naga/Cargo.toml:60-61` `version = "27"` and cannot parse the syntax (mesh WGSL parsing first shipped in naga 28.0.0, 2025-12-18); and a browser rejects `enable wgpu_mesh_shader;` regardless. `MS-02` is therefore **filed and HELD behind M-17**. The maintainer asked for it; the fork's research argues against it; that disagreement belongs on the record.

**And the part of the instruction that is already true today:** the compute-cluster-cull → compacted-visible-list → `drawIndexedIndirect` path is not a consolation prize. It is the mainstream technique, it runs on stock WebGPU in every shipping browser with no flags, and the fork's own ratified record says so verbatim — `MESHLETS_RESEARCH_2026-07-24.md:37`, **"No mesh shaders — and it does not matter"** (re-read 2026-08-29). **Do not re-derive "no mesh shaders" as a reason to defer meshlets.** It is a reason to defer *mesh shaders*, and nothing else.

**The six ratified rulings** (`MESHLETS_RESEARCH_2026-07-24.md` §6a, Batch 758, re-read verbatim 2026-08-29): **M1** Tier 1 alone, Tier 2 only after Tier 1 proves wins on the `C11-168` lane; **M2** inside the Phase-8b GPU-resident-tiles program; **M3** WebGPU-only additive, WebGL keeps the standard path; **M4** load-time worker clusterization (benchmark probe first) **plus investigate pre-baking meshlet data into 3D Tiles**; **M5** implement-from-techniques stands, and any code taken from or directly inspired by nanite-webgpu carries an attribution comment **at the code site**; **M6** default-off / byte-identical-off gate contract + FAR-003/FORK-41 re-arm story + the `C11-168` hard launch gate. **No Tier-3 row is proposed** — its unblock conditions (64-bit atomics, `drawIndirectCount`) were re-checked 2026-08-29 and remain unmet.

**The launch gate, stated once and inherited by every row below.** `C11-168` is **"W1 — PARTIAL / VALID CAUSAL DEFICIT, ROOT CAUSE OPEN"** (`QUEUE_2026-07-18_CAMPAIGN11.md:2003`), and its **dense-tileset half is precisely the part that does not exist** — everything banked is globe-only or SF-resident-and-invalidated. The corrected run is `Q-143` in Wave 1. **No meshlet row that changes a render path may open until that lane delivers the equal-content WebGPU-vs-WebGL frame cost and `commandList.length` that do not exist today.** Gate **M-24** asks the maintainer to confirm the split this track assumes: authoring / design / licence / tooling rows proceed; every row that changes a render path is HELD. **This track does not re-file the gate** — `C11-168` and `Q-143` stay where they are.

**Three containment switches, all default-off, all verified 2026-08-29:** FAR-003 GPU-culling hint `WebGPUContext.ts:6344` `= "never"`; FORK-41 Hi-Z command drop `WebGPUSceneRenderer.ts:1181` `_hiZConsumeEnabled = false`; the 3D-Tiles indirect fast path `WebGPUSceneRenderer.ts:1001-1002` `requestedMode: "never"`. **No meshlet row may re-arm any of these as a side effect.** `MS-15` owns the re-arm story. Note also the doc-vs-code drift `R2` found: `DEFERRED_WORK.md` asserts Hi-Z command-drop is "DEFAULT ON, verified" while the code and `FEATURE_INVENTORY.md` say it is off — **the code wins**.

**The picking hazard is broader than the 2026-07-24 record states.** **This deliberately goes the opposite way from Cirdan §4's instruction to “soften the picking objection to match its source”, on two premises re-derived 2026-08-29; his instruction is recorded here as superseded, not overlooked.** That record's mechanism sentence cites a docstring, not code. Verified 2026-08-29: the b3dm feature ID is a **vertex buffer** (`WebGPUModelRenderer.ts:3775-3781`) consumed as `@location(8) featureId0` in `ModelPBRComplete.wgsl:757`, and `@builtin(vertex_index)` at `:725` feeds the **morph-target** storage reads — *a second, independent re-indexing dependency the record did not name.* So "fetch the original index from the remap buffer" is **not** the fix; a vertex-pull path loses fixed-function fetch for **every** slot in the nine-slot inventory at `WebGPUDevicePool.ts:107-113`. Compounding: `Q-141` records metadata picking already broken on WebGPU while content streams. `MS-13` / `MS-14` are therefore sequenced **after** `Q-141`.

**Free registry slots, verified 2026-08-29:** `FeatureRendererKey.js` — `FFT_OCEAN: 53` at `:261`, `COUNT: 54` at `:273`, so a new key takes **54** and `COUNT` becomes **55**. `ShaderSourceId` — highest in use is `EDGE_EMITTER: 42` (`WebGPUShaderDefines.ts:1259`), range enforced `0..255` (`WebGPUShaderModuleCache.ts:161`), so **43** and **44** are free. All additions are add-only (SR-4).

---

### Phase M0 — mesh shaders first (the maintainer's stated order)

#### `MS-00` — mesh-shading feasibility spike

- **Disposition:** OPEN — research, no code. Converts "let's look at mesh shaders" into a dated, citable record so the rest of the track cites it instead of re-deriving, and so the fork's own record is not re-litigated a fourth time.
- **Tier / Size / Backends:** OPUS-JUDGMENT · XS · n/a
- **Depends on:** none. **Ruling touched:** none — informs **M-17** and `MS-02`; does **not** re-open M1–M6. **Gate:** none (research row).
- **Acceptance:** a dated memo under `migration_doc/` answering four questions and nothing else — is there a WebGPU mesh-shading feature and its exact `GPUFeatureName`; does any shipping browser expose it behind any flag; can the fork's toolchain parse and validate a `@task`/`@mesh` entry point; what would a stage cost the fork, priced in seams. Every external claim carries a URL and a fetch date. Plus one local, browser-free measurement — **a re-run of `R1` §3.3 for the tracked record, not a new measurement; E0-a is the expected and already-observed result** — an ASCII-run scan of `packages/engine/Source/ThirdParty/naga-wasm/naga_wasm_bg.wasm` for `wgpu_mesh_shader`, `@mesh`, `@task`, `mesh_task_size`, `per_primitive`, `cull_primitive`, `triangle_indices`, with `enable f16;` / `enable clip_distances;` as **positive controls** proving the extraction reaches the parser's string tables. Pre-registered exits: **E0-a NEGATIVE** (the expected result — `MS-02` stays held, `MS-01`'s constant is `false`, the track proceeds at `MS-03`); **E0-b POSITIVE** (a real feature name — `MS-01`'s canary becomes real detection, `MS-02` and `MS-16` are re-scoped from the spec text); **E0-c AMBIGUOUS** (proposal but no name — file the URL and a re-check trigger); **E0-d TOOLCHAIN** (state whether a naga bump changes any of the above). **A negative result is a complete and successful outcome for this row.**
- **Fifth question, moved here from `MS-01`:** the **feature-renderer placement decision** — that the `FeatureRendererKey` slot is minted **once**, by `MS-10`, at **54** with `COUNT` → **55**, with **no second dormant key reserved for a mesh-shader renderer**. It is a deliberate deviation from the literal “scaffold” instruction on Principle 7 grounds — cross-file judgement against a standing principle *and* a maintainer instruction, which §0.1 routes to OPUS-JUDGMENT, i.e. this row and not `MS-01`. If the maintainer wants the reservation it rides on **M-17** with `MS-02`; `MS-10`'s slot-54 minting cites the answer recorded here.
- **Binds:** SR-7, **SR-16**. **Source:** D3 `MS-00`; `R1` §1–§3, §7.

#### `MS-01` — capability seam + standards canary + feature-renderer placement decision

- **Disposition:** OPEN. **Two** small parts, one file each: (1) a capability constant hard-coded `false` on the WebGPU capability surface with a C16-clean comment naming the standards issue and the date last checked — **not** an `adapter.features.has("…")` probe against a name that exists nowhere; (2) a standards canary **in the probe lane**, not the engine, enumerating `adapter.features` and failing non-zero if any entry matches `/mesh|task|cluster/i`. **The written placement decision that was part (3) has moved to `MS-00`** — it is cross-file judgement against Principle 7 and a maintainer instruction, which §0.1 routes to OPUS-JUDGMENT, and leaving it here mis-tiered the row.
- **Tier / Size / Backends:** SONNET-BOUNDED · XS · WebGPU-only. **Parity story:** the constant and canary describe a WebGPU adapter capability with no WebGL analogue; nothing renders, WebGL untouched.
- **Depends on:** `MS-00` (supplies the citation the constant carries). **Ruling touched:** none. **Gate:** none.
- **Acceptance:** the canary probe run against the local Edge build exits 0 and prints the enumerated feature list; **the mutant** — inject a synthetic `"mesh-shader"` string into the enumerated set the probe examines — makes it exit non-zero. A probe that cannot fail on the mutant is vacuous and does not close this row. The constant is exercised by a Node spec asserting it reads `false` and that reading it allocates nothing.
- **Binds:** SR-3, SR-4, SR-7, **SR-16**. **Source:** D3 `MS-01`; `R1` §6 risk 2.

#### `MS-02` — WGSL mesh/task stage support in the shader pipeline — HELD on **M-17 (G-B)**

> **M-17 (G-B), verbatim.** *"WebGPU has no mesh/task shader stage: no `GPUFeatureName`, no WGSL attribute, no browser, no flag, and no proposal document (W3C WebGPU CR draft 20 Aug 2026 and WGSL CR draft 25 Aug 2026, both checked 2026-08-29; `gpuweb#3015` sits in the untriaged 'Milestone 4+' bucket, and its implementer wrote on 2026-06-27 that standardization is not expected soon). The fork's own research recommends against building an inert shader-stage seam, and Principle 7 would then make it expensive to remove. You asked for a mesh/task stage scaffold. Do you want (a) NO scaffold — `MS-01`'s constant, canary and the `MS-06` layout hedge are the entire mesh-shader investment, and `MS-02` is struck; (b) a DOCUMENTATION-ONLY scaffold — a design note recording exactly which seams a stage would touch, with no code and no registry entries; or (c) a CODE scaffold — accepting a permanent `ShaderSourceId`/define entry that can never be reclaimed, an unreachable branch in the preprocessor, and the Principle-7 cost, for a feature with no arrival date? This draft recommends (b)."*

- **Tier / Size / Backends:** OPUS-JUDGMENT · S as scoped, **L** if it grows a third pipeline family · WebGPU-only; **parity story: none needed — the path cannot execute on any backend, including WebGPU.**
- **Depends on:** `MS-00` (E0-b or E0-c required to make it live), `MS-01`. **Ruling touched:** none directly; collides with Principle 7 and with SR-4 (a define bit spent here can never be reclaimed). **Gate:** **M-17 (G-B)**.
- **Acceptance:** for **(b)**: a design note listing, with `file:line`, every seam a mesh stage would touch and what each costs — a **third** pipeline family beside `WebGPURenderPipelineCache` and `WebGPUComputePipelineCache`; a new axis in `generateCacheKey`'s `sh:`/`pl:`/`pr:`/`dz:`/`mx:` fold with `wrongModuleHits` staying at 0; a `drawMeshTasks`-shaped call site `WebGPUDrawCommand.execute` has no branch for; and the naga pin — reviewed by a separate OPUS-REVIEW agent that re-derives at least three of its seam claims independently. Zero registry entries, zero engine code. For **(c)**: a Node spec proving `defines = 0` preprocessing output is byte-identical to the pre-change output for every existing shader source, plus proof no existing registry value moved — and an honest statement that the new path is unreachable, so it has **no** runtime acceptance until E0-b fires. **No naga bump** either way: a bump lets the transpiler parse syntax the browser still rejects.
- **Binds:** SR-3, SR-4, SR-7. **Source:** D3 `MS-02`; `R1` §3.2–§3.3, §6 risk 5.

---

### Phase M1 — foundations (ungated by the launch gate; dispatchable today)

#### `MS-03` — licence and provenance determination pass

- **Disposition:** OPEN, and — exactly like `C18-S0`, the gsplat licence pass, which **already completed** (`QUEUE_2026-08-09_CAMPAIGN18.md:273`: “**DONE 2026-08-09** — 20 projects vetted”, re-read 2026-08-29; its binding outcome was that an Inria research-only licence forces clean-room-from-paper) — it must **precede any externally-derived meshlet work**, and it inherits that pass's UNKNOWN-blocks-derivation rule.
- **Tier / Size / Backends:** OPUS-JUDGMENT · S · n/a
- **Depends on:** none. **Ruling touched:** **M5** (attribution at the code site). **Gate:** none.
- **Acceptance:** a numbered determination per candidate, each quoting licence text **from the fetched file** (never paraphrased) with URL and fetch date, and a **USABLE / FILE-COPYLEFT / STUDY-ONLY / UNKNOWN** verdict. **An UNKNOWN verdict blocks derivation from that project, full stop** — the binding rule `C18-S0` established. Candidates: `meshoptimizer` (MIT, in-tree — confirm the `ThirdParty.json` attestation matches the installed version); `Scthe/nanite-webgpu` (MIT, © 2024 Marcin Matuszczyk; verbatim-confirmed 2026-07-24 and **not re-verified since** — re-fetch **at the moment any code is derived**, and M5's code-site attribution attaches here); `clusterlod.h` (MIT, Arseny Kapoulkine); `nvpro-samples/nv_cluster_lod_builder` and `vk_lod_clusters` (Apache-2.0, NOTICE obligations apply); the meshoptimizer meshlet codec (**do not depend on it in v1** — no JavaScript decoder ships in the installed package). Cross-check that every USABLE verdict's obligations are dischargeable in-tree.
- **Binds:** SR-3. **Source:** D3 `MS-03`; `R3` §6.4.

#### `MS-04` — `maxStorageBufferBindingSize` adaptive limit cap (prereq (a))

- **Disposition:** OPEN and independently useful — any future storage mega-buffer benefits. Verified 2026-08-29: `ADAPTIVE_LIMIT_CAPS` opens at `WebGPUDevicePool.ts:100` and does **not** contain the name, which appears only in the reported-limits snapshot at `:173`, so a cluster mega-buffer bound as storage is capped at the spec default.
- **Tier / Size / Backends:** SONNET-BOUNDED · XS · WebGPU-only. **Parity story:** WebGL2 has no storage buffers, so there is no analogous limit to negotiate; no pixel changes on either backend.
- **Depends on:** none. **Ruling touched:** none — prereq (a) of `DEFERRED_WORK.md:4622`. **Gate:** none.
- **Acceptance:** a Node spec drives the negotiator with a synthetic adapter reporting a large `maxStorageBufferBindingSize` and asserts the **requested device descriptor** carries `min(adapter, cap)` — and, with an adapter reporting a small value, that the request is the adapter's value, not the cap. **Mutant:** remove the new entry and the spec must fail. Real-device confirmation folds into `MS-25`; do **not** claim it from the unit spec.
- **Binds:** SR-1, SR-7. **Source:** D3 `MS-04`; `R1` §4.4.

#### `MS-05` — meshoptimizer dependency floor + lockfile reconciliation

- **Disposition:** OPEN, **blocking for `MS-08`**. Three declared versions disagree: `packages/engine/package.json:52` declares `"meshoptimizer": "^1.0.1"`, `package-lock.json:11721` carries the same range, the **lockfile resolves to 1.1.0 (`package-lock.json:7494`, re-derived at the seat 2026-08-29 rather than inherited from `R3`)**, and the installed tree and `ThirdParty.json` are at **1.2.0** — which does ship `meshopt_clusterizer.js` and `.d.ts`. **The floor is the problem** — `^1.0.1` permits an install that may not carry the JS `MeshoptClusterizer` module at all, and the first version that does is recorded UNCONFIRMED.
- **Tier / Size / Backends:** OPUS-JUDGMENT (choosing the floor requires resolving an UNCONFIRMED external fact) · XS · n/a (build / supply chain)
- **Depends on:** `MS-03`. **Ruling touched:** none. **Gate:** none.
- **Acceptance:** determine from npm registry metadata (URL + date recorded) the first published version exposing `meshopt_clusterizer.js` / `.d.ts`; raise the floor to at least that version; reconcile the lockfile; confirm `ThirdParty.json` attests the version actually installed. Then `npm ls meshoptimizer` at the seat reports one resolved version matching the attestation, and a Node script imports `meshoptimizer/meshopt_clusterizer`, awaits `ready`, and calls `buildMeshlets` on a trivial triangle list, printing a non-zero meshlet count. **Mutant:** pin the floor back below the determined version and the import must fail or the API must be absent. **Workers never run `npm install` — the install runs at the seat.**
- **Binds:** SR-3, handoff §7. **Source:** D3 `MS-05`; `R3` §6.1–§6.2.

#### `MS-06` — meshlet data layout freeze (one layout, both paths)

- **Disposition:** OPEN, design only. **This is the entire mesh-shader hedge**, and it costs layout discipline and zero code: choose the layout for the mesh-shader path's constraints now, so that if a WebGPU mesh stage ever standardizes the cost is one new consumer shader and **not** a re-bake of every tile.
- **Tier / Size / Backends:** OPUS-JUDGMENT · S · **backend-neutral by design** — this is data, not a render path; consumed by the WebGPU compute path (`MS-10`/`MS-13`), by a hypothetical mesh stage (`MS-16`) and by the wire format (`MS-18`).
- **Depends on:** `MS-00` (its E0 answer sets how much mesh-shader constraint to honour), `MS-03`. **Ruling touched:** **M4** (this is what makes runtime and pre-baked producers agree); **M1** (v1 carries no LOD fields, only the reserved slot). **Gate:** none.
- **Acceptance:** a frozen layout document — the single artifact `MS-07`, `MS-08`, `MS-10`, `MS-13`, `MS-16` and `MS-18` all cite — specifying: **cluster descriptor SoA** (`vertexOffset`, `triangleOffset`, `vertexCount`, `triangleCount`, four `u32`, stride 16, matching meshoptimizer's own record so a producer copies WASM output without repacking); a **cluster vertex table** of `u32` indices into the primitive's **original** vertex arrays — the rule that makes every per-vertex consumer correct by construction (POSITION, NORMAL, TEXCOORD_n, `_FEATURE_ID_n`, JOINTS/WEIGHTS, morph deltas) and the reason **no separate `featureIdRemap` field belongs anywhere**; a **micro-index buffer** of three cluster-local `u8` corners per triangle; a **per-cluster cull payload** (bounding sphere plus normal cone, padded to 48 bytes) — exactly what `computeMeshletBounds` returns and exactly what both a compute cull pass and a `@task` shader consume; **positions** as tile-local `f32` plus per-tile RTE high/low centre (**non-negotiable** — the 64-bit precision rule applies identically on both paths); **three mesh-shader-legality constraints adopted now because they are free** (clusters capped at ≤64 vertices / ≤124–128 triangles; the descriptor + micro-index pair is the **canonical stored form**, any compacted `u32` index buffer being a derived artifact of the compute path; cull data per-cluster, never per-draw); and a **reserved-but-empty LOD slot** (named and left absent in v1, not populated). Reviewed by a separate OPUS-REVIEW agent who checks observably that (i) every field can be produced from `MeshoptClusterizer`'s documented outputs without an unspecified transform, and (ii) the layout satisfies the mesh-output limits of the only concrete mesh-shading design that exists (`R1` §1.3), so the hedge is real rather than asserted.
- **Binds:** SR-2 (data is renderer-agnostic — M3's exemption is for the *consumer*, not the format), SR-3, SR-7. **Source:** D3 `MS-06`; `R1` §5; `R3` §3.

#### `MS-07` — layout encoder / validator (pure, browser-free)

- **Disposition:** OPEN. Exactly the SOL-DIRECTED shape: bounded pure functions plus a spec; the seat pastes `MS-06`'s layout table as the excerpt and the output is region-replacement into new files under a declared lease.
- **Tier / Size / Backends:** SOL-DIRECTED · S · n/a — pure functions over typed arrays, no GPU, no browser, no engine import
- **Depends on:** `MS-06`. **Ruling touched:** none. **Gate:** none.
- **Acceptance:** an **encoder** turning `MeshoptClusterizer` output into `MS-06`'s byte layout and a **validator** asserting the structural invariants — every cluster-vertex-table entry `<` the primitive's vertex count; every micro-index `<` its own cluster's `vertexCount`; cluster ranges cover the buffer without overlap; every bounds value finite; `vertexCount ≤ 64` and `triangleCount ≤ 128`. The spec feeds hand-built fixtures with **each** invariant violated in turn and asserts rejection with the specific reason; a valid fixture round-trips encoder → validator → decode byte-identically. **Mandatory mutant:** make the validator inert (`if (false && …)` on each check) and every negative case must go red. A validator that only passes positive fixtures has proven nothing.
- **Binds:** SR-7, handoff §7. **Source:** D3 `MS-07`.

---

### Phase M2 — the data producer (M4's "benchmark probe first")

#### `MS-08` — load-time cluster builder (meshoptimizer under the fork's WASM rules)

- **Disposition:** OPEN if **M-24** confirms the seed/launch split (this row changes no render path and produces data nothing consumes yet); HELD if the maintainer rules that any engine change is launch-gated. **Explicit non-goal:** it produces data and nothing renders from it — deliberate, because the ledger seed records the Gaussian-splat precedent (a renderer shipped with no production data producer) and states the producer half is **first-class scoped work, not an afterthought**.
- **Tier / Size / Backends:** OPUS-JUDGMENT · M · **WebGPU-only (M3)**. **Why WebGL cannot follow:** the clusterizer's inputs are CPU-side positions and indices, and the fork retains typed arrays **only** on WebGPU — `GraphicsContext.ts:965` returns `false`, `WebGPUContext.ts:1848` overrides to `true`, and `GltfLoader.js:1437-1438` gates retention on that getter; WebGL2 additionally has no compute shaders and no indirect draw, so it has no consumer. **Parity story:** WebGL keeps the standard draw path; pixel output unchanged on both; clusters are a performance input, never a visual one.
- **Depends on:** `MS-03`, `MS-05`, `MS-06`, `MS-07`. **Ruling touched:** **M3**, **M4**, **M5**. **Gate:** **M-24**.
- **Acceptance:** on a fixture tileset, a debug-snapshot counter reports non-zero clusters built for N primitives, with the `MS-07` validator run over the produced buffers in-session reporting zero violations; the threshold gate observably skips small primitives; with the feature off, **zero** clusterization work occurs — no worker message, no WASM instantiation — asserted by a counter that stays at 0, not by reading source. **Mutant:** make the threshold gate inert and the "skipped" counter must go non-zero for small primitives. Follow the fork's **third-party** WASM precedent rather than the fork-owned Rust bridge family (`R3` §6.3: the clusterizer exposes no handle, no SIMD variant, no version symbol, and frees its own arena per call): **async loading only**, **threshold-gated activation**, and a fallback of "no clusters, standard draw path", legitimate **only because** the feature is default-off and additive per M6. Heavy work off the main thread on the `createTaskProcessorWorker` pattern.
- **Binds:** SR-1, SR-3, SR-5, SR-7, handoff §7. **Source:** D3 `MS-08`; `R3` §6.3.

#### `MS-09` — per-tile clusterization cost measurement (M4's benchmark, before anything consumes it)

- **Disposition:** OPEN (measurement, not a fix), and load-bearing rather than a formality. Cirdan's objection in one line: a meshlet path *"would add load-time clusterization to exactly the phase that is already losing"* — WebGPU cold start is the measured loser (`Q-134` / `Q-102`: pipelines resolving at 1.6–2.6 s each with 12–15k cache misses before the first non-empty command list). **This row is allowed to return "runtime clusterization is too expensive", and that outcome funds the extension (`MS-18`…`MS-23`) rather than killing the track** — which is exactly what M4's research addition anticipated.
- **Tier / Size / Backends:** OPUS-EDGE-EXECUTOR · S · WebGPU measured, WebGL captured as the load-phase control leg
- **Depends on:** `MS-08`. **Ruling touched:** **M4**, which ratified load-time clusterization *"(benchmark probe first)"* and flagged the per-tile cost UNCONFIRMED. **Gate:** none.
- **Acceptance:** a JSON artifact with both legs (clusterizer on / off) **interleaved in one session**, never two sessions compared, the interleave order recorded and reversed at least once, both legs gated on `Scene.renderReady`, and a stated verdict against a threshold **pre-registered before the run**. Multi-metric: per-tile clusterization wall time (median/p95), total load-phase wall time, worker-thread occupancy, peak JS heap and the delta attributable to cluster buffers, tiles-to-first-content — each metric's noise behaviour stated beside its bar. No single-number claim, no FPS claim, no GPU-bound claim without valid timestamps.
- **Binds:** SR-5, SR-6, SR-8, SR-9, SR-11, **SR-17**. **Source:** D3 `MS-09`; Cirdan memo §4.

---

### Phase M3 — cull and draw (the path that works everywhere) — HELD on the `C11-168` launch gate

#### `MS-10` — cluster GPU residency + cull compute pass + indirect draw

- **Disposition:** HELD on the launch gate. Five parts: (i) upload `MS-06`'s buffers beside the existing per-primitive buffers; (ii) a **new** cull compute shader taking `ShaderSourceId` **43** — **not** a widening of `Shaders/WebGPU/Compute/FrustumCull.wgsl`, whose payload is sphere-only (`:26-28`) and which is shared by four culler pools — doing frustum rejection on the cluster sphere **and** normal-cone backface rejection, writing a compacted visible list plus `instanceCount` in the `CullMode.INDIRECT` write pattern (`WebGPUGPUCuller.ts:38-45`, verified); (iii) consume the args through the existing `WebGPUDrawCommand.drawIndirectBuffer` path, batched by pipeline-homogeneous run; (iv) register `FeatureRendererKey` **54**, `COUNT` → **55**; (v) device-loss hygiene on the `onDeviceInvalidatedOnce` pattern the indirect-draw manager already uses (prereq (d), which already has a pattern to copy). **Known shape to respect:** the execute path is a **CPU loop of one indirect call per draw** (`WebGPUIndirectDrawManager.ts:256-259`, `:267-274`) — correct for stock WebGPU, which has no multi-draw; Dawn's `MultiDrawIndirect` is `FeatureState::Experimental`, reachable only behind `--enable-unsafe-webgpu` and therefore **never** part of a shipped gate contract. The portable optimisation is packing all indirect args into **one** buffer.
- **Tier / Size / Backends:** OPUS-JUDGMENT · L · **WebGPU-only (M3)**. **Why WebGL cannot follow:** WebGL2 has neither compute shaders nor indirect draw — the two primitives this row is built from — so the technique is architecturally unavailable, not merely unimplemented. **Parity story:** identical pixels; WebGL keeps the standard per-primitive draw path; feature off ⇒ WebGPU byte-identical to today.
- **Depends on:** `MS-04`, `MS-06`, `MS-08`; **launch gate `C11-168` / `Q-143`**. **Ruling touched:** **M1** (Tier 1 only, no LOD change), **M3**, **M6**, FAR-003 containment, SR-4. **Gate:** launch gate.
- **Acceptance (multi-metric):** on a dense fixture at a fixed saved view — draw-call count before vs after; culled-cluster percentage published through the existing `getHighDensityCullStats()` snapshot key rather than a new one; **pixel diff against the non-cluster path at the same view at or below the harness's established noise floor** — a draw-call win with a visible diff is a failure, not a trade; and with the feature off, byte-identical output plus zero cluster passes and zero allocations. **Mutant:** make the cone-rejection branch inert and the culled-cluster percentage must move and the probe must notice.
- **Binds:** SR-1, SR-3, SR-4, SR-5, SR-6, SR-7. **Source:** D3 `MS-10`; `R2` §2, §6b.

#### `MS-11` — per-view cull fanout (CSM cascades, frustum splits)

- **Disposition:** HELD on the launch gate, sequenced after `MS-10`. Cluster culling must run **per view** — main camera plus N shadow cascades — or geometry visible in a cascade but culled for the main view disappears from the shadow map. The fork already has the per-cascade culler pool this fans out to. **A shadow that quietly loses casters is precisely the "feature degraded to win a metric" failure SR-1 forbids, and it is invisible in a draw-call count.**
- **Tier / Size / Backends:** OPUS-JUDGMENT · M · WebGPU-only (M3); same parity story as `MS-10`
- **Depends on:** `MS-10`. **Ruling touched:** **M6** (shadow correctness is part of the gate contract), SR-1. **Gate:** launch gate.
- **Acceptance:** element-screenshot captures of a shadowed dense scene, feature on vs off, at two sun angles, pixel-diffed at or below the noise floor; the per-view cull stats show a **different** culled set per cascade (identical sets would mean the fanout is not happening); and the cast-list count with the feature on is not lower than with it off for any cascade. **Mutant:** force all cascades to reuse the main view's visible list — the shadow diff must go red.
- **Binds:** SR-1, SR-6, SR-7. **Source:** D3 `MS-11`.

#### `MS-12` — Hi-Z occlusion leg for cluster culling (prereq (b), Hi-Z half)

- **Disposition:** HELD on the launch gate **and** on FORK-41. **Ownership, stated so it is not violated:** FORK-41's Hi-Z consumer fix is **not** re-filed here — C18 §5 keeps FORK-41 / `C11-98` where they are and `C18-A5` depends on it the same way, so **whoever lands FORK-41 discharges the prerequisite for both**. `MS-12` is only the cluster-granularity consumer. **Premise correction carried forward:** the code says `_hiZConsumeEnabled = false` (`WebGPUSceneRenderer.ts:1181`, verified) — any brief inheriting `DEFERRED_WORK`'s "default on" sentence will mis-scope this row.
- **Tier / Size / Backends:** OPUS-JUDGMENT · M · WebGPU-only (M3); same parity story as `MS-10`
- **Depends on:** `MS-10`; FORK-41 / `C11-98` consumer wiring. **Ruling touched:** **M6**, FORK-41. **Gate:** the `C11-168` launch gate, **and** FORK-41's consumer wiring landing (whoever lands FORK-41 discharges it for `C18-A5` too).
- **Acceptance:** occluder/occludee fixture at a fixed view: cluster-level occlusion rejection count is non-zero and the pixel diff against the non-occlusion path is at or below the noise floor — i.e. **nothing visible was culled**. Multi-metric: rejection count, frame cost interleaved A/B, false-cull count from the existing stats surface. **Mutant:** invert the occlusion test — the pixel diff must go red immediately, proving the probe can see a false cull.
- **Binds:** SR-1, SR-6, SR-7, SR-8. **Source:** D3 `MS-12`; `R2` §4.3.

#### `MS-13` — vertex-pull render variant (the complete attribute stream)

- **Disposition:** HELD on the launch gate and sequenced after `Q-141`. A render path taking `ShaderSourceId` **44** in which `instance_index` selects the cluster and `vertex_index` decodes to a cluster-local corner → micro-index → cluster vertex table → **original vertex index** → attribute fetch. It must reproduce the **entire** nine-slot stream (`WebGPUDevicePool.ts:107-113`) **plus** the morph-target `vertex_index` dependency at `ModelPBRComplete.wgsl:725`. **Three pipeline-key hazards it must not inherit silently:** a new variant axis must be folded into the cache key (module identity is already folded structurally; `wrongModuleHits` must stay present and read 0); `Q-144` records the SKIP_LOD stencil axis missing on the model path — **do not extend the key without re-checking that**; and a cluster flag must **not** be minted as a material define bit.
- **Tier / Size / Backends:** OPUS-JUDGMENT · L · WebGPU-only (M3). **Why WebGL cannot follow:** vertex pulling from storage buffers is the mechanism and WebGL2 has no storage buffers. **Parity story:** identical pixels **and identical pick results**; WebGL unchanged.
- **Depends on:** `MS-10`; **`Q-141`** resolved or explicitly scoped around. **Ruling touched:** **M3**, **M6**, and the meshlet re-indexing picking hazard whose stated mechanism is corrected in §6.0. **Gate:** the `C11-168` launch gate.
- **Acceptance:** at a fixed view on a fixture with per-feature metadata — pixel diff vs the non-cluster path at or below the noise floor; **per-feature pick IDs identical** at a grid of positions that includes points **on cluster boundaries** (`MS-14` owns the independent oracle); per-feature show/hide styling toggles the same features on both paths; morph-target animation frames match. **Mandatory mutant:** make the vertex-table indirection inert — `vertex_index` used directly — and both the pick-ID assertions and the styling assertion must fail. A spec that survives that mutant is asserting text shape, not behaviour.
- **Binds:** **SR-1 (hardest here)**, SR-3, SR-4, SR-7. **Source:** D3 `MS-13`; §1e premise correction; `R2` §3b, `R3` §0.1.

#### `MS-14` — independent pick / styling oracle and premise re-derivation

- **Disposition:** **QUEUED — author it early, deliberately before the fix it will check.** Handoff §8c R9: a spec written from the fix's brief certifies the brief, not the behaviour. `MS-13`'s author must not write `MS-13`'s acceptance spec.
- **Tier / Size / Backends:** **OPUS-REVIEW** (station-3; **must be a different agent from `MS-13`'s author**) · M · **both** — the oracle pins current per-feature pick and styling behaviour on WebGL *and* WebGPU, because a WebGL-side regression is exactly what an unverified premise produced last time
- **Depends on:** authored **before or in parallel with** `MS-13`, never after it and never from its brief. **Ruling touched:** the picking hazard; **M6**. **Gate:** none.
- **Acceptance:** a correctness spec pinning per-feature pick results across a grid of positions on both backends. **Scope split so the row is genuinely dispatchable today:** today's dispatch is the **backend grid oracle on non-boundary positions**, which is held on nothing; the **cluster-boundary positions are a pre-registered amendment that lands with `MS-08`** (HELD on **M-24**), written now so it is not re-derived later. Plus per-feature styling show/hide assertions, plus a written premise re-derivation with fresh `file:line` citations of the two premises `MS-13` rests on (feature IDs arrive via vertex-buffer slot 8; the morph path is a second `vertex_index` consumer). **The spec must run green on today's tip before `MS-13` exists** — that is its control; if it does not, it is measuring the harness, not the engine. It must fail when `MS-13`'s indirection is made inert, and it must be demonstrably sensitive to a pick that returns primitive granularity rather than per-feature.
- **Binds:** **SR-7 made concrete**, SR-1, SR-6, SR-14. **Source:** D3 `MS-14`.

#### `MS-15` — containment re-arm story + default-off / byte-identical-off gate contract (M6)

- **Disposition:** HELD on the launch gate; **the last row before any default changes.** Discharge M6 against **three** switches, not the two the 2026-07-24 report inventoried (§6.0). For each: name the residual defect that put it at `never`/`false`, state whether the cluster path removes that defect or merely does not trigger it, and only then propose a default. **A switch may not be re-armed because a meshlet metric wants it.** If a residual defect is untouched, the honest outcome is that the cluster path runs with that switch still contained, and the row says so.
- **Tier / Size / Backends:** OPUS-JUDGMENT · M · WebGPU-only; WebGL asserted untouched
- **Depends on:** `MS-10`, `MS-11`, `MS-12`, `MS-13`. **Ruling touched:** **M6**, FAR-003, FORK-41. **Gate:** the `C11-168` launch gate.
- **Acceptance:** with the feature off — byte-identical rendering vs the pre-change build at three fixed views; **zero** cluster compute passes dispatched, **zero** cluster buffers allocated, zero worker messages, each asserted through a counter that reads 0, never by reading source. With it on — the three switches read the values this row's contract states, published in the debug snapshot. **Mutant:** flip each switch's default in a scratch build and confirm the off-path assertions go red, proving they can see a default change at all.
- **Binds:** **SR-1**, SR-6, SR-7, SR-8. **Source:** D3 `MS-15`; §1c switch inventory.

---

### Phase M4 — the mesh-shader accelerator (dormant by construction)

#### `MS-16` — mesh-shader cluster rendering path — **DORMANT / NOT STARTABLE**, HELD on **M-25 (G-J)**

> **M-25 (G-J), verbatim.** *"`MS-16` cannot be started and may never be. Do you want it (a) filed as a dormant row with the four named triggers above, so the canary has somewhere to report; or (b) struck entirely, with the triggers recorded only in `MS-00`'s memo?"* This draft recommends (a) — a dormant row with explicit triggers costs one table entry and prevents the question being re-asked.

- **Disposition:** **Cannot be started, and saying otherwise would be fabrication.** There is no WGSL mesh stage, no `GPUFeatureName`, no browser and no flag (re-verified 2026-08-29 against https://www.w3.org/TR/webgpu/, CR draft 20 Aug 2026). The naga pin cannot parse the syntax, and a bumped naga would not help because the browser rejects the enable-extension. **The "behind a flag" framing has no referent: there is no flag to hide behind.** **Named unblock triggers (any one re-opens the row):** a `gpuweb/proposals/mesh-shading.md` appears; a mesh `GPUFeatureName` enters a W3C WebGPU draft; a Chromium Intent to Prototype/Experiment/Ship is filed; or `MS-01`'s canary fires. **What it would buy, priced honestly:** a **third** pipeline family, a new axis in the pipeline-key fold, and a `drawMeshTasks` call site `WebGPUDrawCommand` has no branch for. It would **not** remove the picking problem — a mesh shader still feeds the same fragment stage, so `featureId0` must still be produced per emitted vertex from the cluster's vertex table; the hazard is a **data-remap** problem, identical on both paths. It would **not** remove the clusterization cost either — the producer is the same. **Net: a new pipeline family for zero relief on either of the two things that actually hurt.** That is why `MS-06`'s layout hedge, not this row, is the correct mesh-shader investment today.
- **Tier / Size / Backends:** OPUS-JUDGMENT when and if startable · L (estimate only; unpriceable without a spec) · WebGPU-only, and today **no backend at all**. **Parity story:** identical pixels to `MS-13`'s compute path — an accelerator for the same geometry, never a different picture.
- **Depends on:** `MS-00` **E0-b**, `MS-06`, `MS-13`. **Ruling touched:** none yet. **Gate:** **M-25 (G-J)** for whether the row is filed at all — and, ahead of that, the standard itself.
- **Acceptance:** none until E0-b fires. **Source:** D3 `MS-16`; `R1` §1–§2; `R2` §6e.

---

### Phase M5 — cluster LOD

#### `MS-17` — intra-tile cluster LOD (Tier 2) — HELD by ruling **M1**

- **Disposition:** HELD, and **M1 is a ruling, not a soft preference**: Tier 2 only after Tier 1 proves wins on the `C11-168` lane. Scope from the ratified record: intra-tile cluster-LOD mini-DAG — simplifier plus spatial cluster grouping, monotonic-error schema, traversal-free per-cluster cut test. **The hard structural limit must be restated in every brief:** continuous cluster LOD **does not compose across 3D Tiles LOD levels** — a DAG cut cannot span the tile hierarchy without offline re-authoring, because a parent tile's geometry is an independently simplified asset with different vertices and no shared cluster boundaries. Named costs: double-LOD reconciliation against the CPU/f64 tile SSE (complementary, **not** a replacement), border seams, eviction on tile unload. **Relationship to C18 CLOD, stated so no ID is minted in the wrong place:** `C18-A1` is the continuous-LOD keep-function row on the **point-cloud** LOD layer; `MS-17` is the **triangle-mesh** analogue. They share a technique family and **must not share a row** — the correct relationship is cross-reference, and if `C18-A1` lands first, `MS-17`'s brief cites its recipe rather than re-deriving it. Same for `C18-A5`, blocked by the **same** missing 64-bit atomics that kills meshlet Tier 3.
- **Tier / Size / Backends:** OPUS-JUDGMENT · XL · WebGPU-only (M3); same parity story as `MS-13`
- **Depends on:** `MS-13`, `MS-15`, and Tier 1 proving wins on the `C11-168` lane. **Ruling touched:** **M1**, **M6**. **Gate:** ruling **M1** (Tier 2 opens only once Tier 1 proves wins on that lane), plus the launch gate it inherits.
- **Acceptance:** screen-space-error parity — at a set of fixed views the cluster cut selects a triangle count within a **pre-registered band** of the non-LOD path while the pixel diff stays at or below the noise floor; no visible seams at cluster-group boundaries in element screenshots at two zoom levels; and triangle count, draw calls, frame cost (interleaved A/B) and memory reported together.
- **Binds:** SR-1, SR-2, SR-7, SR-8. **Source:** D3 `MS-17`; ratified Tier 2.

---

### Phase M6 — the 3D Tiles / glTF extension (the maintainer's "will likely need to be an extension")

**Greenfield, verified:** no cluster/meshlet extension exists in the glTF or 3D Tiles registries (`R3` §2.1–§2.2), so the fork would be **authoring** the wire contract. Two findings shape it, re-derived 2026-08-29: **no new `3DTILES_*` extension is needed** — the payload is glTF primitive data, and Cesium already **accepts** `3DTILES_content_gltf` (`Cesium3DTileset.js:3973`, re-read 2026-08-29: it is the entry in `Cesium3DTileset.supportedExtensions`, which proves acceptance, not advertisement), which is the declared route for surfacing glTF extension names at the tileset layer; and **an optional extension needs no allow-list entry** — `ModelUtility.checkSupportedExtensions` (`:400-407`) throws only on an unlisted **required** extension.

#### `MS-18` — extension pre-registration and wire-spec draft — HELD on **M-18…M-23 (G-C…G-H)**

- **Disposition:** HELD on six naming/scope decisions. **This row is M4's research addition promoted from research to a draft spec, and it is a document — no engine change, no registry entry, no external publication.** Process discipline: copy the fork's own `3D_TILES_PATCH_EXTENSION_*` precedent, whose P0a pre-registration shows the shape — a §1 Decision stating exactly what is and is not authorized, a §2 audit basis of frozen byte snapshots with SHA-256, a standards boundary, a frozen contract, a pre-registered acceptance matrix, **required mutants**, and explicitly deferred work. Its label discipline is the part to copy verbatim: *"The verifier receives the label as an input rather than hard-coding it. The label is experimental, is not registered or added to any supported-extension table, and carries no compatibility commitment."*
- **Tier / Size / Backends:** OPUS-JUDGMENT · M · **both** — a wire format is renderer-agnostic; the loader lands on both backends (`MS-21`), only the *consumer* is WebGPU-only
- **Depends on:** `MS-03`, `MS-06`. **Ruling touched:** **M4**. **Gate:** **M-18…M-23 (G-C…G-H)** — six naming/scope answers, all six needed before the draft is authored.
- **Acceptance:** the pre-registration document, with a conformance-language table saying which sections are normative; the audit basis frozen with SHA-256; every open decision numbered; and a pre-registered acceptance matrix naming what would count as **failure** before any implementation runs. Content from `MS-06`'s frozen layout: placement at `mesh.primitives[i].extensions.<NAME>` matching every precedent in the dispatch block (`GltfLoader.js:2492-2527`); storage by bufferView with layouts fixed normatively; the normative rule that **the cluster vertex table indexes the primitive's original vertex arrays**, which makes feature IDs, structural metadata, joints/weights and morph deltas correct by construction; composition rules stated normatively — orthogonal with meshopt compression (subject to its 2..256 `byteStride` constraint, which a 1-byte micro-index buffer does not satisfy), compatible with quantization and GPU instancing, **mutually exclusive with Draco on the same primitive** because Draco re-orders and re-indexes at decode and post-decode order is not a stable cross-decoder contract; and a declared-but-empty LOD slot.
- **Binds:** SR-2, SR-3, SR-7. **Source:** D3 `MS-18`; `R3` §1, §3, §5, §8.

#### `MS-19` — adversarial audit of the wire spec

- **Disposition:** HELD until `MS-18` exists, then OPEN. The audit half of the patch-extension precedent, which ran an audit **and** a re-audit, both independent and adversarial.
- **Tier / Size / Backends:** **OPUS-REVIEW** (different agent from `MS-18`'s author) · S · n/a
- **Depends on:** `MS-18`. **Ruling touched:** none. **Gate:** none once `MS-18` exists.
- **Acceptance:** a findings document classifying each finding CONFIRMED / REFUTED / UNCONFIRMED with its evidence, and — per the precedent — an immutable chronology that does not rescore historical reds; a finding the author disputes stays on the record with both positions. Attack the draft on: index-range closure (can a conforming file address out of bounds?); the Draco exclusion (airtight, or does a decoder ordering guarantee exist?); composition with meshopt compression at the stride constraint; whether the "original vertex index" rule genuinely covers **every** per-vertex consumer including morph deltas and structural-metadata property attributes; and whether the reserved LOD slot can be filled later without a format break.
- **Binds:** SR-7, SR-14. **Source:** D3 `MS-19`.

#### `MS-20` — renderer-free parser + validator over synthetic fixtures (the P0a-shaped first slice)

- **Disposition:** HELD until `MS-18`/`MS-19`; then OPEN — no engine integration, no supported-extension entry, no GPU, no browser. Decomposes into roughly three seat-driven turns.
- **Tier / Size / Backends:** SOL-DIRECTED — **three turns, one lease each, seat-verified between turns** (SOL-DIRECTED is a bounded single-deliverable tier, so the decomposition is stated in the tier rather than buried in the size) · M · n/a
- **Depends on:** `MS-07`, `MS-18`, `MS-19`. **Ruling touched:** none. **Gate:** none.
- **Acceptance:** a pre-registered acceptance matrix — for each invariant, a fixture that violates it and the exact rejection expected: byte layout; index-range closure (every cluster-vertex-table entry `<` the primitive's vertex count; every micro-index `<` its own cluster's `vertexCount`); bounds finiteness; cluster-range coverage and non-overlap; monotonic LOD error when the LOD layer is present. **Required mutants:** each validation branch made inert in turn, and each corresponding negative fixture must go red. A valid fixture round-trips byte-identically. Exit codes meaningful and distinct (pass / fail / structural), per the fork's probe convention. **The extension label is an input, never hard-coded.**
- **Binds:** SR-7, handoff §7. **Source:** D3 `MS-20`; the P0a discipline.

#### `MS-21` — loader integration (backend-agnostic) — HELD on **M-18 (G-C)**

- **Disposition:** HELD only because a constant cannot be named before the prefix route is ruled; it is **not** launch-gated, since it changes no render path.
- **Tier / Size / Backends:** OPUS-JUDGMENT · M · **both.** The loader parses the payload and attaches typed arrays to the primitive. **Parity story:** on WebGL the data is simply unused — no consumer resolves — exactly the documented no-op-on-WebGL contract the fork already ships for three feature-renderer keys. Pixels unchanged on both backends.
- **Depends on:** `MS-18`, `MS-20`; **M-18** answered. **Ruling touched:** **M4** (the pre-baked half). **Gate:** **M-18 (G-C)** — and **not** the launch gate: this row changes no render path.
- **Acceptance:** a spec loading a fixture glTF carrying the extension and asserting the parsed cluster counts, offsets and bounds match the fixture's known values **on both backends**; a fixture *without* the extension parses unchanged and byte-identically; a malformed fixture is rejected by the `MS-20` validator rather than crashing the loader. **Mutant:** make the dispatch branch inert — the parsed-count assertions must fail. Read `extensions.<NAME>` in the primitive dispatch block beside `EXT_mesh_polygon` and `EXT_mesh_primitive_edge_visibility`; resolve bufferViews through the loader's existing bufferView-loader helper; attach a component carrying **typed-array fields, no Cartesian objects** (the reason is stated in-tree next to the edge-visibility loader). **No entry in `ModelUtility.supportedExtensions`** — an optional extension does not need one, and adding one implies a support claim this row does not make.
- **Binds:** SR-2, SR-3, SR-7. **Source:** D3 `MS-21`; `R3` §4.1.

#### `MS-22` — producer tooling: emit the extension into a tileset

- **Disposition:** HELD behind `MS-18`; **tooling, so it may land during an Edge tranche where engine code may not.** A Node tool that reads a glTF/glb (or a tileset's contents), clusterizes with the same `MeshoptClusterizer` calls and parameters `MS-08` uses, encodes with `MS-07`'s encoder, and writes the extension payload plus the `extensionsUsed` declaration — and, at the tileset level, the `3DTILES_content_gltf` declaration that gives a client advance notice.
- **Tier / Size / Backends:** OPUS-JUDGMENT · M · n/a (offline tool)
- **Depends on:** `MS-05`, `MS-06`, `MS-07`, `MS-18`. **Ruling touched:** **M4** (the offline enrichment stage M4 named), **M5**. **Gate:** none beyond `MS-18`'s.
- **Acceptance:** for a fixture asset — the tool's output passes `MS-20`'s validator; the payload is **byte-identical to `MS-08`'s runtime output for the same parameters** (or, under a relaxed **M-21**, both validate and render to the same pixels); and the emitted tileset **loads unchanged in a client that ignores the extension** — the backwards-compatibility assertion, and the most important one this row makes. **The load-bearing property is producer/consumer agreement:** if the two paths may diverge, the spec must say so explicitly.
- **Binds:** SR-3, SR-5, handoff §7. **Source:** D3 `MS-22`; `R3` §6.

#### `MS-23` — pre-baked consumption path (skip the runtime clusterizer)

- **Disposition:** HELD on the launch gate (it changes a render path's input) and on **M-21 (G-F)**. When a primitive carries the extension, feed `MS-21`'s parsed buffers into `MS-10`'s GPU residency directly and **skip clusterization entirely** — no worker dispatch, no WASM instantiation. **This is the strongest engineering argument for the whole extension:** it removes a WASM dependency and a per-tile CPU cost from the client, and it is the direct answer to Cirdan's objection that a meshlet path adds work to the phase that is already losing.
- **Tier / Size / Backends:** OPUS-JUDGMENT · M · WebGPU-only consumer (M3); the loader half (`MS-21`) is both-backend
- **Depends on:** `MS-08`, `MS-10`, `MS-21`, `MS-22`; **M-21** answered. **Ruling touched:** **M4**. **Gate:** the `C11-168` launch gate (it changes a render path's input) **and** **M-21 (G-F)**.
- **Acceptance (multi-metric):** on the same fixture, pre-baked vs runtime-clustered — identical pixels at fixed views; identical per-feature pick IDs (`MS-14`'s oracle); **zero** clusterization worker messages and zero WASM instantiations on the pre-baked leg, asserted by counters that read 0; and the load-phase cost delta reported against `MS-09`'s baseline with the interleave order recorded. **Mutant:** present the extension but corrupt one cluster's `vertexCount` — the `MS-20` validator must reject before anything reaches the GPU.
- **Binds:** SR-1, SR-7, SR-8. **Source:** D3 `MS-23`.

---

### Phase M7 — demonstration and acceptance

#### `MS-24` — Sandcastle demo

- **Disposition:** HELD; follows the rows it demonstrates. A gallery demo in the **current Sandcastle2 layout** (`packages/sandcastle/gallery/<kebab>/` with `index.html`, ESM `main.js`, `sandcastle.yaml`, thumbnail) showing a dense tileset with a toggle for the cluster path and a live readout of draw calls and culled-cluster percentage. **Not** the legacy `Apps/Sandcastle/gallery/` form, which is no longer served. `main.js` imports `Sandcastle` only if used.
- **Tier / Size / Backends:** SONNET-BOUNDED · S · **both** — on WebGL it shows the same scene through the standard path, which *is* the parity story made visible
- **Depends on:** `MS-10`, `MS-13`, `MS-15`. **Ruling touched:** none. **Gate:** launch gate.
- **Acceptance:** the demo loads with zero console errors on both backends (checked in `MS-25`'s tranche, not claimed here); the toggle visibly changes the readout while the rendered image stays the same; the WebGL leg renders the same scene with the toggle inert **and says so in the UI** rather than silently doing nothing.
- **Binds:** SR-3, SR-5 (a demo landing is engine-adjacent — not during a tranche). **Source:** D3 `MS-24`.

#### `MS-25` — Edge acceptance tranche

- **Disposition:** HELD on the launch gate. **Five results, each independently reportable:** 1. **off-path byte-identity** — feature off, output byte-identical to the pre-change build at three fixed views, and M6's zero-cost assertions green; 2. **on-path visual equivalence** — pixel diff vs the non-cluster path at or below the harness noise floor (a draw-call win with a visible diff is a failure); 3. **per-feature pick preservation** — `MS-14`'s oracle run in-browser on both backends including cluster-boundary positions, and **a pick regression fails the tranche outright, no matter what the performance numbers say**; 4. **multi-metric performance** — draw-call count, culled-cluster percentage, CPU frame cost interleaved A/B, GPU time only if `validGpuRunCount > 0` (otherwise state plainly that no GPU claim is made), peak heap, and load-phase cost against `MS-09`'s baseline, each metric's noise behaviour stated;
  5. **the M1 judgement, stated explicitly** — does Tier 1 prove wins **on the `C11-168` lane**, the lane named in the ruling, not a substitute scene? **If the answer is no, `MS-17` stays held and the tranche says so; that is a valid and complete outcome.**
- **Tier / Size / Backends:** OPUS-EDGE-EXECUTOR · M · both legs captured
- **Depends on:** `MS-10`–`MS-15`, `MS-24`; **the `C11-168` dense-tileset lane must have delivered its baseline before any performance verdict is stated.** **Ruling touched:** **M6**, **M1**. **Gate:** the `C11-168` launch gate.
- **Acceptance:** a JSON artifact plus element screenshots, all repatriated into main's `Tools/visual-regression/output/` before any clone is reset, with the interleave order recorded and at least one reversed pair. Runbook is §7 in full.
- **Binds:** SR-5, SR-6, SR-8, SR-9, SR-11, **SR-17**. **Source:** D3 `MS-25`.

#### `MS-26` — track close-out review

- **Disposition:** HELD until `MS-25`. Re-derive, independently: that every claimed acceptance is observable rather than source-text-shaped; that each ruling M1–M6 was honoured or has a recorded deviation with a reason; that the three containment switches ended where `MS-15`'s contract says; that no C18, C11 or FORK-41 row was silently absorbed; and that the ledger entries the track created say what the evidence supports. **Any row that landed with a partial result is recorded as partial, not rounded up.**
- **Tier / Size / Backends:** **OPUS-REVIEW** (separate from every author in the track) · S · n/a
- **Depends on:** `MS-25`. **Ruling touched:** M1–M6 reconciliation, the launch gate. **Gate:** none.
- **Acceptance:** a review document with a per-row verdict and, for at least five load-bearing claims, an **independent re-derivation from the code or the artifact** rather than from the authoring lane's report.
- **Binds:** SR-7, SR-14. **Source:** D3 `MS-26`.

### 6.1 Rows this track deliberately does NOT mint

They stay where they are, and any brief that re-files them is wrong: the `C11-168` dense-tileset measurement lane and **`Q-143`**; **FORK-41 / `C11-98`** Hi-Z and sort-key consumer wiring (shared with `C18-A5` — whoever lands it discharges both); **`Q-141`** WebGPU pick-emission during streaming; **`Q-144`** the SKIP_LOD stencil axis; **`C18-A1`** point-cloud CLOD; **`C11-100`** voxel octree traversal.

---
## 6a. WAVE DX — developer experience: organisation, decomposition, deduplication. CURRENT FRONTIER RECORDED BELOW (maintainer directive 2026-08-29 ~21:40).

**Directive (maintainer, verbatim):** "yes lets do all of the organization, decomposing, deduplication, and other improvements. Lets queue these up to run next." Recorded as ruling **R-2026-08-29-3** in `MAINTAINER_RULINGS_2026-08-28.md`. The directive also RULES the five catalog questions that have waited since 2026-08-15 (`TOOLING_CATALOG.md` M1–M5), each per the catalog's own recommendation: **M1** B for the HIGH set, MED set moves only after its per-file 30-second grep; **M2** C (the catalog + the `@purpose` contract, both already live); **M3** A now, B as the M1 follow-up, C rejected; **M4** B, with the re-audit folded into the wave-end gate (R-2026-08-29-2); **M5** B (one exemplar per technique class stays live; the two instrument-defect findings are promoted into DEBUGGING_GUIDE before their files move).

**Evidence (seat census, 2026-08-29 21:30):** `Tools/visual-regression` holds 937 top-level `.mjs` (644 probes, 237 specs) + 91 lib files; **682 files launch their own browser** (`chromium.launch(`), **91 define their own `sha256`**, 64 probes parse `argv` themselves, while shared libs for launch / capture / preflight exist but predate most probes. **Eleven engine files exceed 1,000 lines** against the decomposition rule: `WebGPUModelRenderer.ts` 9,085, `WebGPUContext.ts` 7,889, `WebGPUPrimitiveCommands.ts` 5,769, `WebGPUSceneRenderer.ts` 5,073, `WebGPUModelPipelineCache.ts` 4,591, `WebGPUProceduralCloudRenderer.ts` 4,488, `WebGPUVoxelRenderer.ts` 4,354, `WebGPUGaussianSplatRenderer.ts` 3,245, `WebGPUGlobeSurfaceRenderer.ts` 3,018, `WebGPUDynamicEnvironmentMapManager.ts` 2,923, `WebGPUPointCloudRenderer.ts` 2,921. Every worker pays a reading tax on these and line-number citations drift at every landing.

**Placement:** the 2026-08-29 plan placed Wave DX after `Q-145`, `DM-07`, and `DM-01` and before Wave 2. That is historical placement, not a current-status assertion; the live ledger and the row-specific frontier below control current status and dispatchability. Row-specific capacity holds remain in force. Every DX row is a no-behaviour-change row: its acceptance is byte-identity on both backends via the wave-end gate plus green specs, never a visual or timing claim.

### Wave DX frontier after the 2026-09-02 rulings (seat, 2026-09-02, after midnight ET)

**Did the Codex seat finish Wave DX? No.** Of `DX-01`…`DX-15`, two landed (`DX-05` at Batch 1308, `DX-11` at 1310). The Codex seat contributed the seven reuse pilots that landed as Batches 1347–1353 after the 2026-09-01 audit (c16 line locator, cloc path, WebGPU test constants, recording buffer device, pragma regex, `mutateOrFail`, the WASM loader) and research on eight further families, all recorded as HOLD or research-only in `CODEX_HANDOFF_2026-09-01.md` §8. Everything else was held on catalog repair, Opus capacity, or owning-lane quiescence.

**What the rulings changed:** `DX-14` is released (R-6), which unblocks `DX-03`/`DX-04`; the decomposition holds on `DX-07`/`DX-08`/`DX-09` are lifted because their owning lanes landed and are quiescent (the Q-141 readback work lives in the pick pass, not in the model renderer); `DX-12` runs against the seven ratified runner families (R-16) with a fresh build under the standing permission (R-24); `DX-13` is a ruling now (R-15); Opus capacity exists under the new tiering (R-24). `DX-10` waits for the recipe and for C16-10 to finish with the three renderers R-4 released. `DX-15` stays held on G6 Q2d and the Principle-7 sign-off.

**Rows added (`DX-16`…`DX-30`)** carry the rulings' cleanup, organisation and optimisation work: the two helper pilots (R-17), the branch/worktree salvage audit before any sweep (R-21), the sibling-repository census (R-22), the Rust supervisor relocation and rename to **chelate** (R-13), the tracked campaign-status authority (R-14), the README index, the CI duplicate-batch report (R-12), the Codex-config narrowing that keeps Codex able to branch and clone (R-23), the wave-end gate repair (R-9), the two guard repair rows (R-10), two research holds, and one premise-first hygiene row.

**Dispatch order:** `DX-19` → `DX-20` → `DX-14` → `DX-01` → `DX-12` (one batch per runner family) → `DX-13` → `DX-02` → `DX-06` (by family) → `DX-16`, `DX-17`, `DX-18` → `DX-07` → `DX-08` → `DX-09` → `DX-03`, `DX-04` → `DX-10` → `DX-21` → `DX-22`, `DX-23`, `DX-24` → `DX-27` → `DX-26` → `DX-25` (when the Codex app is closed). Every row keeps the no-behaviour-change bar: byte identity on both backends, the pipeline-key aliasing spec when keys or defines move, the purpose-header contract for every new probe or gate library, same-batch cleanlist repointing for every decomposition (R-4), and the wave-end three-step at the end of the wave (R-3).

### `DX-01` — one probe runtime for the fleet

- **Disposition:** OPEN. `Tools/visual-regression/lib/probe-runtime.mjs` owning: argv parsing (`--port`, `--runs`, `--reverse`, `--renderer`, `--serve-built` assertion), Edge launch (channel msedge, one browser per run, the single-Edge-slot lock file), served-build preflight on both bundles, the Sandcastle2 origin rewrite + refusal (`Q-145`), `Scene.renderReady` gating, element-only capture, `sha256`, JSON receipt + markdown summary, exit codes 0/2/3. A probe becomes a ~50-line script declaring cells.
- **Tier / Size / Backends:** OPUS-JUDGMENT · M · harness (drives both). **Depends on:** `Q-145` (landed). **Ruling touched:** none (implements M4-B's lifecycle hooks). **Gate:** none.
- **Acceptance:** `probe-aec-perf.mjs` (`DM-01`) and `probe-globe-cold-start-readiness.mjs` re-based on the runtime produce byte-identical receipts (same fields, same values on a fixture run) to their pre-runtime versions; a spec drives the pure parts (argv, refusals, receipt shape); the runtime is the first consumer of `Q-152`.
- **Binds:** SR-5, SR-6, SR-7, SR-12, SR-17. **Source:** seat census 2026-08-29; catalog §4 coverage gaps.

### `DX-02` — anti-re-accretion contract

- **Disposition:** OPEN. Extend `probe-fleet-contract` (the `@purpose` header check) with: a status tag (`ACTIVE | INVESTIGATION | ARCHIVED-CANDIDATE`) required in every `@purpose`; a lint that refuses a NEW `probe-*.mjs` that calls `chromium.launch(`, defines its own `sha256`, or parses `process.argv` directly instead of using the runtime (existing files are allow-listed by name with a shrinking census, never grandfathered silently); catalog regeneration reads the tag.
- **Tier / Size / Backends:** SONNET-BOUNDED · S · tooling. **Depends on:** `DX-01` (the runtime the lint points at). **Ruling touched:** executes M4-B. **Gate:** none.
- **Acceptance:** the contract spec fails on a fixture probe that launches its own browser and passes on one using the runtime; the allow-list count is printed by the census and must not grow.
- **Binds:** SR-12, SR-13. **Source:** catalog M4.

### `DX-03` — HIGH-set singleton disposition after catalog repair

- **Disposition:** **HELD behind `DX-14` repair completion and explicit maintainer release.** The prior ~35-file HIGH-set move is superseded; the latest handoff §5.5 narrows `DX-03` to a singleton disposition after `DX-14` repairs catalog truth. This row does not choose that disposition in advance.
- **Tier / Size / Backends:** SONNET-BOUNDED · S · tooling. **Depends on:** `DX-14` repair completion and explicit maintainer release. **Ruling touched:** executes M1-B (HIGH) and M3-B. **Gate:** the existing live-ledger `DX-14` repair completion and explicit maintainer release.
- **Acceptance (current singleton contract; only after `DX-14` repair completion and explicit maintainer release):** the repaired catalog resolves the HIGH set to the single remaining candidate, `Tools/visual-regression/probe-polyline-geodesic.mjs`; its live `WEBGPU_DEBUGGING_LOG.md` refutation pointer is repointed before any move and remains discoverable at the destination; the packet records the singleton's final disposition and shows zero broken live references. A result that revives the stale ~35-file set is not this row.
- **Superseded bulk-move acceptance (historical, not the current dispatch contract):** `git log --follow` resolves every moved file; `node Tools/spec-runner-census.mjs` and the fleet contract stay green; zero live `migration_doc` references break (grep census before and after, printed in the packet).
- **Binds:** SR-11 (evidence repatriation is not needed — files move, nothing is deleted), SR-12. **Source:** catalog §3 HIGH, M1, M3.

### `DX-04` — MED-confidence set: the per-file 30-second grep, then archive

- **Disposition:** **HELD behind `DX-14` repair completion and explicit maintainer release, then `DX-03`**, then two dispatches. First a census: for each of the ~55 MED files, live reference count in Tools/scripts/package.json/.husky and in live `migration_doc`, superseding sibling, conclusion-banked location, and the M5 exemplar flag; printed as a table with a disposition per file (MOVE / KEEP-EXEMPLAR / REPOINT-THEN-MOVE / KEEP). Second, the move for the MOVE set.
- **Tier / Size / Backends:** SOL-DIRECTED (census, bounded, everything pasted) then SONNET-BOUNDED (move) · S + S · tooling. **Depends on:** `DX-14` repair completion and explicit maintainer release, then `DX-03`; `DX-05` was satisfied by Batch 1308. **Ruling touched:** M1-C→B for MED. **Gate:** the existing live-ledger `DX-14` repair completion and explicit maintainer release.
- **Acceptance:** the census table lands in the catalog; the move's packet shows zero broken live references.
- **Binds:** SR-12. **Source:** catalog §3 MED, M1.

### `DX-05` — exemplar retention + instrument-defect promotion

- **Disposition:** **LANDED — Batch 1308, commit `505724ef69b4aef5abee178a96251a96c636f170`.** One cloud stash-A/B probe and one raw-readback probe remain live (marked in `@purpose`); the instrument-defect findings of `probe-farcam-isolation` and `probe-h12-longsettle` (capture artifacts masquerading as render bugs) were promoted into a short DEBUGGING_GUIDE subsection before their files move.
- **Tier / Size / Backends:** SONNET-BOUNDED · XS · docs + tooling. **Depends on:** none. **Ruling touched:** executes M5-B. **Gate:** none.
- **Acceptance:** review + the guide subsection present; no spec (R-2026-08-29-1: docs).
- **Binds:** SR-12. **Source:** catalog M5.

### `DX-06` — deduplicate the fleet onto the runtime, by family

- **Disposition:** OPEN, batched. Migrate ACTIVE probes to `DX-01`'s runtime in family batches of roughly 40–60 files (catalog §1 family map order), each batch its own landing behind the wave-end gate; delete the local `chromium.launch` / `sha256` / argv copies as each file is migrated. A migrated probe must produce a receipt byte-identical in fields to its pre-migration receipt on a fixture run (values may differ only where the old probe was measuring wrongly — each such case is named in the packet).
- **Tier / Size / Backends:** SONNET-BOUNDED per batch · S each · harness. **Depends on:** `DX-01`, `DX-02`. **Ruling touched:** none. **Gate:** none.
- **Acceptance:** per batch the `DX-02` census shows the allow-list shrinking by the batch's file count; wave-end gate green.
- **Binds:** SR-12, SR-17. **Source:** seat census (682 launch sites, 91 sha256 copies).

### `DX-07` — decompose `WebGPUModelRenderer.ts` (9,085 lines)

- **Disposition:** OPEN. Split along the seams the code already has and that live rows are working in: the pick path (`DM-07` counters, `Q-141`), the edge-visibility emission, the draw-command build, the material/IBL binding. Pure move of code into `*Helpers.ts` / domain companions under 1,000 lines each; no behaviour change; every moved symbol re-exported or imported at its call sites; comments move with their code (C16).
- **Tier / Size / Backends:** OPUS-JUDGMENT · L · WebGPU (WebGL untouched). **Satisfied prerequisites:** `DM-07` LANDED in Batch 1328; `Q-141` Phase A LANDED in Batch 1338 (`73f85cde466254b09d8628b7128af664b30a9db6`). **Remaining hold:** the `Q-141` Phase-B/Edge and owning-work quiescence gate remains closed, and Opus capacity is required.
- **Acceptance:** tsc 0 non-TS2307, eslint 0, the model/pick/pipeline-key-aliasing specs green, module-cache and pipeline-cache keys unchanged (`describeCacheKey()` census identical before/after), and the wave-end gate byte-identical on both backends.
- **Binds:** SR-1, SR-2, SR-7, SR-12, SR-17. **Source:** seat census; CLAUDE.md file-size rule.

### `DX-08` — decompose `WebGPUContext.ts` (7,889 lines)

- **Disposition:** OPEN. Same shape as `DX-07`: resource creation, device recovery (`Q-65` decline branches), statistics/debug snapshot publication, and the feature-renderer registry are the natural companions. No behaviour change.
- **Tier / Size / Backends:** OPUS-JUDGMENT · L · WebGPU. **Satisfied prerequisite:** `DM-07` landed. **Remaining hold:** the owning lane must be quiescent, and Opus capacity is required.
- **Acceptance:** as `DX-07`, plus the device-recovery and readiness specs green.

### `DX-09` — decompose `WebGPUPrimitiveCommands.ts` (5,769) and `WebGPUSceneRenderer.ts` (5,073)

- **Disposition:** **HELD until the `Q120` and `Q130` owning lanes both close and become quiescent.** Only then dispatch the two decompositions separately. The scene renderer's 3D-tile passes are already a companion (`WebGPUSceneRenderer3DTilePasses.ts`); continue that pattern for the post-process handoff, frame preparation and the globe prewarm seam.
- **Tier / Size / Backends:** OPUS-JUDGMENT · L each · WebGPU. `Q120` has landed but retains an open scope decision; `Q130` retains an unlanded Phase-A follow-up, open `Q-130-c2`, and carry-forward findings. **Depends on:** both owning lanes closed and quiescent. **Gate:** Opus capacity plus both closure-and-quiescence attestations.
- **Acceptance:** as `DX-07`.

### `DX-10` — decompose `WebGPUModelPipelineCache.ts` (4,591) and the six remaining >1,000-line renderers

- **Disposition:** **HELD**, one row per file, until `DX-07..09` prove the recipe and each file's owning lane closes and becomes quiescent: pipeline cache after the `Q-141` / `Q-142` owners; procedural clouds and voxels after their owners; Gaussian splats after the C15 GSPLAT owner; globe surface after the `Q120` owner; dynamic environment map and point cloud after their owners.
- **Tier / Size / Backends:** OPUS-JUDGMENT · M–L each · WebGPU. **Gate:** Opus capacity plus every row's owning-lane closure-and-quiescence attestation.
- **Acceptance:** as `DX-07`.

### `DX-11` — stable citations: function anchors, not line numbers

- **Disposition:** **CLOSED — Batch 1310, commit `c59d2bafd61efbbca765daf536c040b1f63c502c`.** Briefs, cards and reviews cite `file:function-or-unique-line` with the line number as a secondary hint; the decomposition rows make line numbers meaningless anyway. The rule is recorded in WORKER_ISOLATION_AND_BRANCH_HANDOFF.md §8f.
- **Tier / Size / Backends:** seat (docs) · XS. **Depends on:** none. **Acceptance:** review only (R-2026-08-29-1).

### `DX-12` — spec homes: the measured pass (executes `Q-139-D1`)

- **Disposition:** OPEN. On a built tree, run every orphan spec once with a per-spec timeout, record pass/fail and wall time, then wire the green ones into the proposed homes (`test-visual-regression-node`, `test-engine-node`, `test-s5`, &) and list the red ones with their first failing assertion for triage (many read generated files or a served build - those get a `requires-build` tag rather than a runner).
- **Tier / Size / Backends:** SONNET-BOUNDED · S · tooling (machine time dominates). **Depends on:** a fresh `gulp build` (engine window). **Gate:** M-DX-1 below for the runner names.
- **Acceptance:** `node Tools/spec-runner-census.mjs --strict` orphans drop to the `requires-build`-tagged set only.

### `DX-13` — ledger rotation (maintainer gate)

- **Disposition:** PROPOSED, not queued. `FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md` is the sole status authority and grows by the day; `migration_doc` is 202 files / 138k lines. Options: (a) rotate the ledger weekly with a one-line pointer chain and a generated index of open rows; (b) keep one ledger and generate the open-row index from it; (c) status quo. **Gate M-DX-2.**

### `DX-14` — tooling-catalog archive-plan generator (existing identity)

- **Disposition:** **PARKED / BANKED; not dispatchable.** The exact live status authority is
  `FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md`, section **“DX-14 parked after two pasted turns: the
  archive plan still does not reach the document (2026-08-29 17:00 machine clock)”**. It records
  the banked generator patch, 3/3 spec, regenerated-catalog comparison, unresolved managed-render
  path, and one unused variable. The next step remains an Opus session with the generator open;
  both repair completion and explicit maintainer release are owed before anything lands, and
  `DX-03` / `DX-04` remain behind it.
  This add-only row preserves that identity and pointer; it does not resume, approve, or relabel the
  work.
- **Tier / Size / Backends:** OPUS-JUDGMENT · M · tooling/docs. **Gate:** the existing live-ledger
  repair completion and explicit maintainer release; no new M-DX identifier is minted here.

### `DX-15` — retire the inline translucent-classification color/composite scaffold (`C11-107` alias/tail)

- **Disposition:** **PREREGISTRATION / PREPARATION ONLY — NO-GO TO IMPLEMENT, DELETE, RUN EDGE,
  LAND, OR CERTIFY.** `DX-15` is the add-only execution alias/tail of canonical `C11-107`; it does
  not replace or renumber another row. The documented depth-sampling replacement and Session-5
  removal schedule establish the architectural premise, not retirement authority. Explicit G6 Q2d
  / Principle-7 maintainer sign-off is still owed; broad Wave-DX authority is not that sign-off.
  Frozen plan: `DX15_TRANSLUCENT_CLASSIFICATION_COMPOSITE_SCAFFOLD_REMOVAL_PREREGISTRATION_2026-08-30.md`,
  22,512 bytes / SHA-256
  `3A7C9B66E1B32FB35ED89BF827A5920DA6BBD8BD5B3F121EBEB490E021C155EF`.
- **Tier / Size / Backends:** OPUS-JUDGMENT · M · WebGPU implementation with a WebGL negative
  control. A later browser dispatch is OPUS-EDGE-EXECUTOR, fulfilled only by the designated tier-2
  Sol Edge steward after reviewer-A GO and an explicit root release. **Gate:** `C11-107` / G6 Q2d
  Principle-7 retirement sign-off.
- **Exact future implementation lease, after sign-off and root collision audit:** one writer owns
  only `packages/engine/Source/Renderer/WebGPU/WebGPUTranslucentTileClassification.ts`,
  `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererEnsureResources.ts`,
  `packages/engine/Specs/Renderer/WebGPU/WebGPUSceneRendererDependentResourcesSpec.js`, and
  `Tools/visual-regression/probe-translucent-classification-scaffold-retirement.mjs`. A separate
  documentation writer owns only the queue/deferred/feature/issue/dev-note/removal-record paths
  frozen in the preregistration. A newly required path is scope drift: stop and obtain a replacement
  lease and fresh preregistration review.
- **Protected/public/build/compatibility boundary:** all packed-depth source, publication, reset,
  consumers, and command plumbing remain live and protected; `_sampler` remains live;
  `_translucentDepthView` is unrelated and out of scope. The standalone
  `packages/engine/Source/Shaders/WebGPU/PostProcess/CompositeTranslucentClassification.wgsl` is a
  generated/public-export surface and is prohibited, as are its generated wrapper, package export,
  GLSL sibling, and every `ShaderDefine` / `ShaderSourceId` removal, reorder, or renumber. Removing
  `composite()` and narrowing `update()` has a raw shipped-`Source` deep-import compatibility risk;
  sign-off and the removal rationale must acknowledge it rather than silently retaining a shim or
  silently removing the method. The guaranteed saving is the eager full-canvas color target and
  avoided HDR churn, not an already-created lazy composite pipeline.
- **Resource and pixel gates:** the real class must create exactly two textures and three retained
  views, create no classification-color target, avoid HDR-only recreation, destroy exactly its two
  owned textures, preserve the 1x sampler-at-slot-2 pack/publication path, and preserve the 4x
  sampler-free MSAA pack. The deterministic matrix is all eight cells of
  `{WebGPU, WebGL negative control} × {1x, 4x} × {ordinary, forced at least two relevant frusta}`.
  Every cell requires a non-vacuous classification-off delta; candidate same-backend RGBA/masks and
  cross-backend diffs must reproduce their baselines exactly. A valid pass-order baseline red is a
  separate C11 repair and remains `FAIL`; DX-15 must not delete around it.
- **Frozen seven inverse mutants:** (M1) restore throwaway color allocation and the resource-count
  gate must fail; (M2) on the pre-cleanup baseline make `composite()` / `_ensureCompositePipeline()`
  throw or invalidate inline `COMPOSITE_WGSL`, while every normal runtime leg must stay green to
  prove no call; (M3) publish packed depth as `null` and the forced consumer/pixel gates must fail;
  (M4) force packed output to all-zero/far and the same gates must fail; (M5) prefer globe depth over
  packed depth and the same gates must fail; (M6) disable MSAA pack and the 4x gates must fail; (M7)
  pin the first packed view or suppress later publication and the multi-frustum slice/ROI gate must
  fail. If M3, M4, or M5 survives, stop: packed depth is not proven load-bearing and deletion stays
  NO-GO. A separate WebGL-classification disable control must turn every WebGL cell red.
- **Fold, manifest, review, and Edge sequence:** fold once as `PASS 0 / FAIL 1 / ERROR 2 /
  STRUCTURAL 3`; never de-score a measured red. A clean manifest must bind sign-off, commits and
  dirty state, transitive source/build/served/fixture identities, immutable baseline/candidate/mutant
  trees, every invocation and error surface, same-render pixel/order witnesses, retained artifacts,
  teardown/quiescence, and both fresh post-patch reviews. Sequence: sign-off → root leases and
  freezes baseline/M2 → implementation and pre-Edge documentation freeze → independent reviewer A
  → root prepares/releases immutable mutant trees and the separate Edge lane → Edge matrix/mutants
  → final evidence/documentation freeze → fresh independent reviewer B → root-only landing. Any
  drift or finding stops/reopens/refreezes the lane. The two preregistration reviews are not the two
  post-patch reviews, and no runtime or certification result is claimed now.


**Completed Wave DX rows:** `DX-05` LANDED in Batch 1308
(`505724ef69b4aef5abee178a96251a96c636f170`); `DX-11` CLOSED in Batch 1310
(`c59d2bafd61efbbca765daf536c040b1f63c502c`). They remain above as add-only historical
inventory and are not part of another executable dispatch.

**Current blocking frontier:** `DX-14` is **PARKED / BANKED and not dispatchable**; its repair
completion and explicit maintainer release are required before `DX-03` / `DX-04`. After both, the
remaining proposed dispatch order is `DX-03` → `DX-01` → `DX-02` → `DX-04` → `DX-06` (batches) →
`DX-12` → `DX-07` → `DX-08` → `DX-09` → `DX-10`; row cards carry the actual dependencies. The
Sol/Sonnet rows (`DX-03`, `DX-04`, `DX-02`, `DX-06`,
`DX-12`) proceed on Codex/Sonnet capacity only when their named holds clear; `DX-01` and the
decompositions wait for Opus capacity and for their owning lanes to close and become quiescent.
`DX-15` remains outside this executable arrow as the held tail of canonical `C11-107` until its
specific sign-off and frozen review/Edge sequence are released.

**Wave DX maintainer gates:** **M-DX-1** runner names for the spec homes (accept the census proposals as written, or name your own); **M-DX-2** ledger rotation (a / b / c).

`DX-14`'s carried live-ledger repair completion and explicit maintainer release and `DX-15`'s
`C11-107` / G6 Q2d Principle-7 sign-off are separate row-specific gates. They do not mint new M-DX
identifiers, and neither is discharged by M-DX-1, M-DX-2, or broad Wave-DX authority.

### `DX-36` — landing staging must cover both halves of a rename, or refuse

- **Disposition:** OPEN. A worker patch is exported `git diff --cached --binary --no-renames`, so a
  rename arrives as a **delete of the source plus an add of the destination** and
  `git apply --numstat` lists **both** paths. `git apply --3way` then applies the deletion and
  removes the source from the worktree and the index — so a landing script that stages with a bare
  `git add -- $PATHS` invokes `git add` on a path that no longer exists and fatals with "pathspec
  did not match any files", aborting the run before the commit. This is what the Batch 1403
  archive-rename landing hit across its seven sources. The seat's untracked scratchpad
  `land-lane.sh` now splits `$PATHS` into present/absent, `git rm --cached --ignore-unmatch`s the
  absent half, and asserts the staged set equals the patch's full path set — but that fix lives only
  in an untracked script. Neither `ORCHESTRATION_HANDBOOK.md` §2 nor
  `Tools/verify-landing-compliance.mjs` carries the rule today.
- **Tier / Size / Backends:** SONNET-BOUNDED · S · tooling (landing runbook). **Depends on:** none.
  **Ruling touched:** none. **Gate:** none.
- **Acceptance:** a landing dry-run over a patch containing a rename stages both the source deletion
  and the destination, and the runbook refuses when the staged set differs from the patch's path
  set; the rule is stated in `ORCHESTRATION_HANDBOOK.md` §2 and checked by
  `Tools/verify-landing-compliance.mjs`.
- **Binds:** SR-7. **Source:** seat landing run, Batch 1403/1404 archive-rename lane, 2026-09-03/04.

### `DX-37` — the C16 cleanlist union resolver is unreachable unless `package.json` also conflicts

- **Disposition:** OPEN. The seat's wave-2 chain wrapper resolves a merge conflict on
  `Tools/c16/comment-marker-cleanlist.txt` by unioning both sides' additions, but that union branch
  is written nested inside the wrapper's `package.json`-conflict check
  (`if git status --porcelain | grep -q '^UU package.json'`), so it only runs when `package.json`
  *also* conflicts. When only the cleanlist conflicts — which two C16 shards landing on the same
  night will always do, since they share the one file — the wrapper reports "not a package.json
  conflict" and stops short of resolving anything. This is what happened landing Freawine's shard
  (Batch 1400): the seat resolved the union by hand instead of the wrapper doing it.
- **Tier / Size / Backends:** SONNET-BOUNDED · S · tooling (landing chain wrapper). **Depends on:**
  none. **Ruling touched:** none. **Gate:** none.
- **Acceptance:** two C16 shards whose cleanlist additions conflict land in sequence without a hand
  resolution; the union is deduplicated and ordered; the resolver runs whether or not
  `package.json` conflicts.
- **Binds:** SR-7. **Source:** seat wave-2 chain wrapper, Batch 1400 (Freawine C16 shard),
  2026-09-03/04.

### `DX-38` — chelate's backend-contract tests are red

- **Disposition:** OPEN. The Rust supervisor relocated to `F:/Dev/GH/chelate` (`dfbdca2`, baseline
  `fc5e888`) fails 4 of 5 tests in `crates/chelate-core/tests/backend_contract.rs` under
  `cargo test --offline`: `malicious_backend_report_drift_is_rejected`,
  `malformed_terminal_is_rejected_by_supervisor_run`, and `terminal_identity_drift_is_rejected` each
  expect `run_with(...)` to return `Err` and it does not; `failed_terminal_does_not_infer_running_from_root`
  expects `NotCreated` and gets `Running` (`left: Running, right: NotCreated`). `backend_contract`
  does not currently gate the landing/certification script — it only tails the test output rather
  than checking `cargo test`'s exit code — so these four failures never blocked anything. A
  supervisor whose contract tests do not reject a malicious, malformed, or identity-drifted backend
  is not something to certify.
- **Tier / Size / Backends:** OPUS-JUDGMENT (Rust, safety contract) · M · Rust (chelate; no CesiumJS
  renderer backend). **Depends on:** none. **Ruling touched:** none (chelate's relocation itself is
  `R-2026-09-02-13`; this row is the contract-test gate, not the relocation). **Gate:** none.
  **Owned-by:** `DX-21` (pointer, not a duplicate).
- **Acceptance:** the four named tests pass on `F:/Dev/GH/chelate` and the landing/certification
  script gates on `cargo test`'s exit code; until then chelate remains uncertified and
  `migration_doc/CHELATE.md` says so (it already does, per `R-2026-09-02-13`'s NO-GO).
- **Binds:** SR-7. **Source:** seat `cargo test --offline` run, `F:/Dev/GH/chelate` @ `dfbdca2`,
  2026-09-03/04.

### `DX-39` — withdrawn

`DX-39` — withdrawn 2026-09-04 (Haldir): duplicate of `AR-D20` / `AR-883` in
`QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md`, which carry the served-tree rebuild gap and its
three-option maintainer decision. Mechanism recorded here so it survives if those rows land
unamended: a plain `npx gulp build` leaves all three generated typings the Sandcastle2 editor
requests absent — `/Source/Cesium.d.ts`, `/packages/engine/index.d.ts`,
`/packages/widgets/index.d.ts` (`packages/sandcastle/vite.config.dev.ts:95,99,103`) — because
`build()` never calls `buildTs` (`gulpfile.js:1443`) and `Source/Cesium.d.ts` has a separate
producer (`scripts/ensureCesiumTypeDefinitions.js:45`); no wave-end step checks for them, so the
demos 404 in the browser rather than the gate refusing.

### `DX-40` — `build-ts` gates the wave-end gate; JSDoc type expressions are linted in `.js`

- **Disposition:** OPEN. Verbatim from lane Elentir's landing packet (the "Fix round (Erendil)"
  version, `F:/Dev/GH/cesium-lane-elentir-20260904/_lane-out/LANDING_PACKET_ELENTIR.md`):

  > **Observable behaviour to assert (1):** with a JSDoc arrow type such as `{() => T}` introduced
  > into any `.js` file under `packages/*/Source`, the wave-end gate does not start — the run
  > reports the failing file and tag before any Sandcastle2 or visual-regression step executes.
  > Today the gate starts, the Sandcastle2 typings sweep 404s, and **zero** demos certify on either
  > renderer, with no earlier signal.
  >
  > **Observable behaviour to assert (2):** committing a `.js` file whose JSDoc contains `=>` inside
  > a `{...}` type expression fails `lint-staged` with the file and line, and the same content in a
  > `.ts` file passes. (Scope is `.js`-only by construction: all four jsdoc configurations —
  > `packages/{engine,widgets}/tsd-conf.json`, `Tools/jsdoc/conf.json`, `Tools/jsdoc/ts-conf.json` —
  > carry `includePattern: ".+\\.js(doc)?$"`, so `.ts` is never parsed by jsdoc and the native arrow
  > syntax is correct there.)
  >
  > **Evidence:** `WebGPUPointCloudEDLState.js:230` (`{() => T}` → `{function(): T}`) failed `npx
  > gulp buildTs` repo-wide after 1.16 min via the unguarded `execSync` at `gulpfile.js:1303`,
  > skipping the widgets workspace entirely and leaving both `index.d.ts` files without their
  > `declare module "@cesium/..."` wrapper. One excluded-by-config sibling remains at
  > `WebGPUContext.ts:7930`.
- **Tier / Size / Backends:** SONNET-BOUNDED · S · tooling (build pipeline / lint-staged).
  **Depends on:** none — the one-line JSDoc fix already landed (lane Elentir). **Ruling touched:**
  none. **Gate:** none. **Owned-by:** NEW.
- **Acceptance:** the two observable behaviours above hold — a reintroduced JSDoc arrow type stops
  the wave-end gate before Sandcastle2 runs, and the same pattern fails `lint-staged` on a `.js`
  file while an identical `.ts` file passes.
- **Binds:** SR-7. **Source:** lanes Zamin/Elentir/Erendil, `LANDING_PACKET_ELENTIR.md`,
  `REVIEW_ERENDIL.md` §(f), 2026-09-04.

### `DX-41` — withdrawn

`DX-41` — withdrawn 2026-09-04 (Haldir): the verification `DX-30` demanded; folded into `DX-30` in
place.

### `DX-42` — census the 219 of 266 `Tools/visual-regression/*.spec.mjs` files without a runner home; add a landing-rules guard

- **Disposition:** OPEN. The 1.145 merge shipped the draped-polyline width regression with
  `vector-layer-draping.spec.mjs` sitting directly on top of it — the spec existed, its fixture guard
  fired, and nobody saw it because the spec had no npm runner home (`R-2026-08-29-1`; lane Penlod
  gave it one while fixing the regression, Batch 1410). Measured by Gundor (Penlod's reviewer,
  2026-09-04): **219 of 266** `Tools/visual-regression/*.spec.mjs` files (82%) are unreferenced by any
  `package.json` script. Independently flagged the same day by lane S's merge review: Eradan's DX-row
  recommendation (cluster-a) and `LANDING_PACKET_TAR-MINYATUR.md` §10 DX row 2 (specifically calling
  out `vector-layer-draping.spec.mjs` before it was homed).
- **Tier / Size / Backends:** SONNET-BOUNDED · S · tooling. **Depends on:** none. **Ruling touched:**
  executes `R-2026-08-29-1` ("a spec with no runner home is a review blocker"). **Gate:** none.
- **Acceptance:** a census script lists every `Tools/visual-regression/*.spec.mjs` file with no
  npm-script reference and states the count (starting measurement: 219/266); each orphan is then
  either (a) homed in an existing or new `npm run` target, (b) archived under `R-2026-08-29-1` with a
  stated reason, or (c) deleted with a reason recorded. **Second requirement** (Gundor, same review):
  a guard in the landing-rules runner that fails when a `Tools/visual-regression/*.spec.mjs` file is
  added without an npm script referencing it — negative control: a fixture spec added with no runner
  makes the guard exit non-zero.
- **Binds:** SR-7, SR-12. **Source:** `F:/Dev/GH/cesium-lane-penlod-20260904/_lane-out/REVIEW_GUNDOR.md`
  (follow-ups item 4); `LANDING_PACKET_TAR-MINYATUR.md` §10 DX row 2; `REVIEW_ERADAN_cluster-a.md`
  "DX rows to queue" item 2.

**`DX-42` (2026-09-04, filed from lane S's merge review and lane Penlod's fix).** Not added to the
summary table above, per the `DX-36`…`DX-41` landing-night precedent — see this card for tier, size,
dependencies and acceptance.

### `DX-43` — repatriate `cluster-b-byteident.mjs`, the only proof the D3 clipping-polygon relocation preserved the probe baseline

- **Disposition:** OPEN. `Scene/ClippingPolygonSdfPack.js` (Batch 1408, `UPSTREAM-SYNC-1.145-02`) is
  proved byte-identical to the pre-merge packer only by `_lane-out/cluster-b-byteident.mjs`, which
  reads git stage `:2:` and therefore **cannot re-run post-commit without editing**, has **no npm
  runner home**, and lives in a lane clone's git-excluded `_lane-out/` — it dies on the next clone
  reset. It is the sole evidence that `probe-globe-clippoly-geodetic.mjs` was correctly left
  un-rebaselined by the `-02` resolution (the cluster-(b) resolver who wrote it, Arminas, and its
  reviewer, Herion, both relied on this exact harness).
- **Tier / Size / Backends:** SONNET-BOUNDED · XS · tooling. **Depends on:** none. **Ruling touched:**
  executes SR-11 (evidence repatriation before a clone is reset or deleted). **Gate:** none.
- **Acceptance:** the harness is copied into a tracked location (e.g. `Tools/visual-regression/`),
  re-pointed from git stage `:2:` to a named pre-merge commit (`33398505e6^1` = `e7360fa234`, per
  Herion's own re-derivation) so it runs from any tree state; given an npm runner home; and re-run
  once to confirm it still reports `IDENTICAL` on layout/positions/extents with its negative control
  (reversed vertex order) still failing.
- **Binds:** SR-11. **Source:** `REVIEW_HERION_cluster-b.md`, "Non-blocking items to carry forward"
  item 2 (`:344-347`); confirmed by `REVIEW_LORGAN.md` R3 item 3.

### `DX-44` — tooling-catalog census reads the git INDEX, not the worktree, so `git add -N` blanks a new file's `@purpose`

- **Disposition:** OPEN. Filed from wave P0-1 (2026-09-04): every lane's tooling-catalog gate was
  structurally unfixable in-lane for the same reason. `readCandidateFileBuffers` /
  `readCandidateIndexEntries` (`Tools/generate-tooling-catalog.mjs:700-753`) read file content via
  `git cat-file --batch` against blob OIDs from the **git index**, not the filesystem. `git add -N` —
  the only staging operation `_COMMON_RULES.md` permits a bounded worker for a brand-new file — records
  the path in the index but points it at git's well-known **empty blob** (`e69de29b...`), confirmed
  directly by three independent lanes (`git ls-files -s <new-file>` → `e69de29b...`; `git cat-file -s
  e69de29b...` → `0`). So a bounded lane's new file is always censused as `NO @purpose HEADER | — | 0 |
  —`, regardless of whether the file carries a correct `@purpose`/`@status` header — verified by all of
  Beleg, Mablung, Baragund and Gorlim regenerating the catalog once and finding exactly this wrong row
  for their own new file, then reverting.
- **Tier / Size / Backends:** SONNET-BOUNDED · S · tooling. **Depends on:** none. **Ruling touched:**
  none. **Gate:** none.
- **Acceptance:** the census reads the **worktree** bytes for any path whose index blob is the
  well-known empty OID (the `git add -N` signature) instead of trusting the index blob unconditionally;
  a negative control proves the fallback is real — a genuinely empty tracked file (index blob `e69de29b`
  because the file **is** zero bytes, not because of `-N`) must still census as `NO @purpose HEADER`,
  so the fallback keys on the `add -N` case specifically, not on "index blob is empty". A fixture pair
  (an intent-to-add file with a real header vs. a genuinely empty tracked file) both censusing correctly
  is the acceptance, not a single case.
- **Binds:** SR-6. **Source:** `LANDING_PACKET_BARAHIR.md` §5.2; `LANDING_PACKET_BELEG.md` §7(a);
  `LANDING_PACKET_MABLUNG.md` §6 (F5); `LANDING_PACKET_BARAGUND.md` "Catalog finding" item 2.

### `DX-45` — `verify-es6-shape` cannot self-locate the pre-merge base in a worker clone; exits 2 every time

- **Disposition:** OPEN. Filed from wave P0-1 (2026-09-04), confirmed independently by all five lanes on
  the same 1.145-merge-line clones. `npm run verify-es6-shape` (bare) exits **2**: *"cannot determine
  the pre-merge base … no merge in progress and HEAD is not a merge commit."* `Tools/upstream-shape-guard.mjs`
  auto-bases on `HEAD^1` only when `HEAD` **is** a merge commit; every wave P0-1 clone's `HEAD`
  (`c979aca757`, Batch 1409) is one commit **past** the merge (`33398505e6`, Batch 1408), so the
  auto-detection refuses rather than guesses — correctly cautious, but it leaves every worker clone
  downstream of a merge with no way to run this gate without external knowledge of the merge commit's
  hash. With `--base=33398505e6^1` (or `--base=33398505e6`, both forms were used across the five lanes)
  the guard runs clean. This is an **environmental refusal, not a product red** — `UPSTREAM-SYNC-1.145-08`
  already records the guard passing when handed the base at merge time; the gap is purely the base
  auto-detection one commit later.
- **Tier / Size / Backends:** SONNET-BOUNDED · S · tooling. **Depends on:** none. **Ruling touched:**
  none. **Gate:** none.
- **Acceptance:** the guard finds its base **without** an explicit `--base` when `HEAD`'s most recent
  ancestor along first-parent is a two-parent (merge) commit — walk first-parent from `HEAD` until the
  first merge commit is found, then base on that commit's own first parent — **or**, if that walk is
  judged too permissive (an unrelated later merge could exist), the tool's `--usage` text and this
  document both name the exact invocation (`--base=<merge-commit>^1`) so a lane can self-serve instead
  of discovering the flag by trial. Either resolution is acceptable; a fixture clone one commit past a
  merge, with no flag passed, exiting 0 (auto-detect form) or printing the exact needed flag in its
  usage/refusal message (documented-flag form) is the acceptance.
- **Binds:** SR-6. **Source:** `LANDING_PACKET_BELEG.md` §6; `LANDING_PACKET_MABLUNG.md` §6 (F1);
  `LANDING_PACKET_GORLIM.md` §6; `LANDING_PACKET_EMELDIR.md` §9; `LANDING_PACKET_BARAGUND.md` gates
  table; `LANDING_PACKET_BARAHIR.md` §5.5.

### `DX-46` — the wave-end gate does not distinguish lane-gates from wave-gates, so a pre-existing red blocks every lane alike

- **Disposition:** OPEN. Filed from wave P0-1 (2026-09-04). Two runners were red at HEAD **before** any
  wave P0-1 lane touched anything, and stayed red identically in every lane's clone regardless of that
  lane's own changes (proven by four independent lanes restoring their touched files to `HEAD` content
  and re-running both gates unchanged): `npm run test-tooling-catalog` (104 tests, 94-95 pass, 9-10 fail,
  all nine/ten sharing **one** root cause — the census-currency precondition, i.e. `TOOLING_CATALOG.md`
  being stale relative to the tree) and `npm run test-visual-regression-node`'s fleet-contract specs
  (see `AR-893`, the roster-pinning row in `QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md`). Neither red is
  caused by, or fixable from inside, a single lane's clone: the catalog gate needs a **seat-side**
  regeneration after every contributing lane lands (`_COMMON_RULES` §2's per-lane regeneration
  instruction was overridden by a wave-wide ruling for exactly this reason — regenerating per lane would
  import ~40 rows of unrelated churn into each lane's patch and guarantee conflicts on a file no lane
  owns), and the fleet-contract reds are `AR-893`'s roster to pin. Today the wave-end gate (`R-2026-08-29-2`)
  runs both as undifferentiated pass/fail steps, so a red that is structurally a **wave-level** concern
  reads identically to a red that is a genuine **lane-level** regression — a lane cannot tell, from the
  gate alone, whether its own change broke something or whether it inherited a standing debt.
- **Tier / Size / Backends:** SONNET-BOUNDED · S · tooling. **Depends on:** `AR-893` (the roster this row
  points at, not duplicates). **Ruling touched:** none. **Gate:** none.
- **Acceptance:** the wave-end gate's own output (or the runbook that invokes it) names, for each runner
  it executes, whether that runner is a **lane-gate** (must be green in every lane's own clone before
  that lane lands) or a **wave-gate** (only meaningful once, on the settled tree, after every
  contributing lane has landed — e.g. the tooling catalog, and the fleet-contract roster until `AR-893`
  pins it) — so a lane reading a wave-gate red at wave-end time knows not to chase it, and a lane-gate
  red is never silently reclassified as a wave-gate to excuse it.
- **Binds:** SR-6. **Source:** `LANDING_PACKET_BARAHIR.md` §5.1, §5.6; all five wave P0-1 landing
  packets' gate tables.

### `DX-47` — the dev server's default mode advances generated shader modules without ever writing the served bundle, and `served md5 == disk md5` cannot see it

- **Disposition:** OPEN. Filed 2026-09-05 (Hunleth) from lane Penlod's round-2 diagnosis, **mechanism
  corrected per Gundor's round-2 review** (`REVIEW_GUNDOR_ROUND2.md`, station 3, LAND). Éowyn job 5
  leg 5-3 measured `UPSTREAM-SYNC-1.145-07` item 1's gate B at **RED** (countRatio 1.858, outside
  `[0.6, 1.67]`) against the sync clone's served `Build/CesiumUnminified/Cesium.js`. Penlod round 2
  proved the measurement itself was sound but its subject was not: the served bundle's md5 matched its
  own disk md5 (the standing executor preflight) throughout, but the bundle's embedded `GlobeTerrain`
  shader text was the **pre-fix** shader (the `< lineWidth` full-width test Batch 1410 removed), while
  the clone's `GlobeTerrain.wgsl` source and its generated `.js` module both carried the fix. **Gundor
  refuted the packet's own build-ordering framing (§1.2) and re-derived the real mechanism (§1.3),
  which is what this row now states:** shader-module generation always precedes bundling in every build
  path (`buildEngine`'s `glslToJavaScript`/`wgslToJavaScript` at `scripts/build.js:1863`/`:1870` run
  before any `gulp.series` bundling step; `buildCesium` regenerates the WGSL modules a second time at
  `scripts/build.js:2085`) — so no ordinary `gulp build` or `buildAllVariants` run can leave a bundle
  older than a module it just regenerated. **The actual exposure is that the default (non-`--serve-built`)
  dev server regenerates the shader `.js` mirrors while never writing `Build/CesiumUnminified` at all:**
  `server.js:151` calls `buildEngine({write:false})`, where `write:false` suppresses only the esbuild
  *bundle* output — the `wgslToJavaScript`/`glslToJavaScript` shader mirrors are real files written
  regardless — and `server.js:365`'s watcher regenerates them again on any `.wgsl` touch, still without
  touching `Build/`. (A second, narrower path to the same symptom: `npx gulp build --workspace
  @cesium/engine` regenerates modules unconditionally at `gulpfile.js:106-110` and early-returns at
  `:126-127` before `buildCesium` ever runs; a `gulp build` interrupted between those two points is the
  same shape, and is not hypothetical — the diagnosis's own evidence records exactly this from a
  cancelled duplicate build.) **`served md5 == disk md5` proves the server is not caching; it is
  structurally blind to a bundle that was never rebuilt in the first place, which is what let a stale
  artifact certify a false RED.** The built-shader-identity preflight this row's acceptance requires
  **landed as its own Tools-only commit, Batch 1423 (`635e6874c9`)** — Éowyn job 6 runs it immediately
  before gate B.
- **Tier / Size / Backends:** SONNET-BOUNDED · S · tooling (build pipeline / executor preflight, and dev
  server). **Depends on:** none — `Tools/verify-built-shader-identity.mjs` is already landed (Batch 1423);
  what remains is wiring it into the standing preflight and the dev-server-mode exposure itself.
  **Ruling touched:** `M-30` (added to §8) — Gundor: "worth a ruling, not a lane note", since this is
  the **second** time a bare md5-equality preflight has been recorded as sufficient (the 2026-08-29
  memory note makes the same claim). **Gate:** none.
- **Acceptance:** every executor preflight (the standing `served md5 == disk md5` check) additionally
  runs the **built-shader identity check** — `Tools/verify-built-shader-identity.mjs` /
  `Tools/visual-regression/lib/built-shader-identity.mjs`, landed Batch 1423 (whole-text comparison of a
  named shader's source against what the bundle actually embeds; exit 0 current · 1 drifted · 2 usage ·
  3 bundle absent) — and treats a non-zero exit as STRUCTURAL (rebuild and re-check) rather than as a
  product verdict; **and** the default dev-server mode is either made to refuse serving a probe request
  once its shader mirrors have advanced past `Build/`, or its `--help`/README text states plainly that
  `--serve-built` is required for any run whose acceptance depends on the served bundle matching current
  source. The check is proven fireable, on the real module (Gundor mutated the live comparison to a
  presence-only check and it was DETECTED, not just the packet's own shadow-implementation test): it
  reports DRIFTED against the exact stale sync-clone artifact job 5 measured (first differing line 508,
  Batch 1410's own addition) and CURRENT against a same-commit rebuild; a whole-tree sweep (two
  independent runs, Penlod's and Gundor's) found 0 false positives after correcting an initial
  witness-line design that missed genuinely stale bundles and a quote-style/digit-suffix design gap that
  flagged 20 current shaders as drifted. Runner home: `npm run test-build-infra` (138/138 including the
  12-test `built-shader-identity.spec.mjs`; note `D1` **skips** rather than fails when `Build/` is
  absent, so the spec being green is not proof a bundle was checked — the CLI is the binding gate, see
  `DX-54`).
- **Binds:** SR-6, SR-8. **Source:** `F:/Dev/GH/cesium-lane-penlod-20260904/_lane-out/LANDING_PACKET_PENLOD2.md`;
  `F:/Dev/GH/cesium-lane-penlod-20260904/_lane-out/REVIEW_GUNDOR_ROUND2.md` §1 (mechanism correction),
  §2 (the bbox/count-ratio/antialias corroboration), §4 (the real-module mutation proof); Batch 1423
  (`635e6874c9`, the landed preflight tool)
  (full diagnosis, the fix, and the recommendation); `Tools/visual-regression/output/sync-1145-verification-2026-09-04/SUMMARY.md`
  (job 5 leg 5-3, the measurement this row explains). **Not yet landed** — Penlod's `penlod2.patch` is
  under review; this row exists so the finding is tracked independently of that patch's landing.

### `DX-48` — the Sandcastle2 sweep's boot gate does not scale with measured machine speed, and a slow run reads as demo failures

- **Disposition:** OPEN. Filed 2026-09-05 (Hunleth) from Éowyn job 5 leg 5-1. A WebGL full sweep of the
  1.145-merge-line tree reported **273/343 certified, 70 failed** against job 3's pre-merge 332/338 —
  but the comparison is **VOID for an environment reason, not the merge**, proven three ways with a
  byte-identical runner: (i) the same 10 failing demos fail **identically** on the pre-merge tree at the
  same settle; (ii) five demos that certified minutes earlier in the same sweep (`hello-world`,
  `3d-models`, `imagery-layers`, `gpx`, `interpolation`) **fail 5/5 on immediate re-run**; (iii) raising
  the documented `SANDCASTLE_SETTLE_MS` env knob from 8000 to 25000 makes two of the failing demos
  (`picking`, `wall`) **pass**. 67 of the 70 failures carry `errors: 0` and captures that are **not**
  blank (`headingpitchroll` meanLum 42.85, `picking` 40.91) — the demos render, but the sweep's fixed
  8-second boot gate is too fast at the machine's current speed, and every demo whose Cesium namespace
  publishes after that window reads as a hard failure with no signal that a longer wait would have
  passed it. All five merge-added demos still certified on both renderers despite the environmental
  noise, and no new GPU validation error appeared — the sweep's substance is sound, only its timing
  discipline is not. See also `DX-47`, a different mechanism (a stale artifact) with the same lesson
  (a fixed-timing/fixed-identity check silently certifying the wrong thing).
- **Tier / Size / Backends:** SONNET-BOUNDED · S · tooling. **Depends on:** none. **Ruling touched:**
  none. **Gate:** none.
- **Acceptance:** either (a) the sweep's boot-gate wait scales with a measured per-machine settle time
  (a short calibration demo run first, the gate set at a multiple of its observed publish time), or (b)
  every sweep receipt records the settle time actually used, so a downstream reader can distinguish
  "these demos are broken" from "this run's settle was too short for this machine" without re-deriving
  it by hand as job 5 had to. **Acceptance measurement:** a re-run of the same sweep at the documented
  (or calibrated) settle passes the same demos on both the merge-line and pre-merge trees, closing the
  void comparison job 5 left open.
- **Binds:** SR-8. **Source:** `Tools/visual-regression/output/sync-1145-verification-2026-09-04/SUMMARY.md`
  (job 5 leg 5-1); `UPSTREAM-SYNC-1.145-06` leg 1b (the prerequisite `npm install` this leg needed).

### `DX-49` — `globe-pipeline-prewarm.spec.mjs`'s context double leaves `_options` unreadable, failing four cases plus one pick-suppression case pre-existing on the merge line

- **Disposition:** OPEN. Filed 2026-09-05 (Hunleth) from the landing-night gate sweep. `npm run
  test-model-webgpu` fails the same **5** cases on the CesiumJS 1.145 merge line and on the post-wave-P0-1
  tree alike — measured independently at the seat and in the sync clone, identical sets both times, and
  independently confirmed pre-existing (not caused by any wave P0-1 lane) by Beleg's HEAD-engine restore,
  which reproduced the same five failures with none of that lane's files present. `Tools/visual-regression/globe-pipeline-prewarm.spec.mjs`
  **E1-E4** ("the globe's first pipeline requests are served by the warm", "a warm at context init
  serves nothing", and two mutant-shape assertions) all throw `TypeError: Cannot read properties of
  undefined (reading 'prewarmGlobeRenderer')` from `warmUpGlobeRenderer`, sourced at spec `:311`; the
  read is `WebGPUContext.ts:1733`'s `prewarmGlobeRendererEnabled` getter (`this._options.prewarmGlobeRenderer
  !== false`) finding `this._options` undefined. **Symptom only — the cause is NOT established.** The
  spec's `boot()` helper (`:292`) constructs the context directly, `new namespace.WebGPUContext({}, {})`
  (`:294`), inside a synthetic single-entry module graph the spec assembles itself (`:113-129`) with
  part of the graph stubbed (`:135-`). Note that the engine constructor this is meant to run **does**
  set `this._options = options` unconditionally at `WebGPUContext.ts:1207`, with no early return before
  it, so bypassing `static async create()` does **not** on its own explain an undefined `_options` at
  the getter — a plain `new` with `{}` would give `_options = {}` and the getter would return `true`.
  The spec's own comment at `:132-134` (a stubbed base class turns `super()` into a Proxy so derived
  field initialisers land on the Proxy rather than the instance) is the most promising lead, but it has
  not been isolated and must not be written down as the cause. Presumed a harness defect rather than an
  engine fault because no wave P0-1 lane's changes touch either file the spec imports and the five
  failures are identical on the merge line and the post-wave tree — but whoever takes this row
  establishes the mechanism first, and re-classifies if it turns out to be engine-side. **State the
  symptom only, per this row's own scope** — the fifth
  case, "a second pick before the map resolves is an in-flight suppression" (test 188 in the same
  runner), fails alongside the four with no established relationship to the `_options` mechanism and is
  filed here rather than assumed to share the cause.
- **Tier / Size / Backends:** SONNET-BOUNDED · S · tooling (test-double repair) — escalate to
  OPUS-JUDGMENT only if re-deriving the fix surfaces a genuine engine-side ordering issue rather than a
  test-double gap. **Depends on:** none. **Ruling touched:** none. **Gate:** none.
- **Acceptance:** **first, isolate why `_options` reads undefined** — the disposition above rules out
  the bypassed-factory explanation but does not replace it, and the stubbed-base-class/Proxy lead at
  `:132-134` is unconfirmed; a fix written before the mechanism is established risks repairing the wrong
  thing. Once isolated: the runner is green (`npm run test-model-webgpu` 0 failures), achieved either by
  repairing the test double to route through the real async factory (or to set `_options` explicitly
  before `warmUpGlobeRenderer` runs) so E1-E4 exercise the real getter, or by re-homing the five cases
  with a stated reason if they turn out to test a shape the shared runtime no longer supports. Either
  resolution is acceptable; leaving the red unexplained is not.
- **Binds:** SR-6. **Source:** `LANDING_PACKET_BELEG.md` §6 (the pre-existing-failure transcript, 29-32
  and 188); brief Addition "landing night" (2026-09-05); measured independently at the seat and in the
  sync clone.

### `DX-50` — adopt the built-shader-identity check as a mandatory leg of the standing Edge executor preflight

- **Disposition:** OPEN. Filed 2026-09-05 (Hunleth) from Gundor's round-2 review follow-up 2 and confirmed
  by Éowyn job 6, which measured the difference directly: job 5's stale-bundle RED on
  `UPSTREAM-SYNC-1.145-07` item 1's gate B and job 6's clean PASS of the same probe against the same
  clone differed **only** in whether `Tools/verify-built-shader-identity.mjs` had been run first. The
  standing `served md5 == disk md5` preflight passed identically in both jobs (job 6's own closing
  section: "The standing preflight… passed throughout job 5 and passed again here; it compares the
  artifact to itself and is structurally incapable of seeing a stale `Build/`. The built-shader identity
  check is what separated the two runs.") — this is now measured evidence, not a hypothesis, for the
  `M-30` ruling this row executes.
- **Tier / Size / Backends:** SONNET-BOUNDED · S · tooling (executor runbook). **Depends on:**
  `Tools/verify-built-shader-identity.mjs`, landed Batch 1423. **Ruling touched:** `M-30`. **Gate:** none.
- **Acceptance:** the standing Edge executor preflight sequence (wherever it is documented — the runbook
  or `_COMMON_RULES`-equivalent for Edge jobs) runs `node Tools/verify-built-shader-identity.mjs` (whole
  sweep, or `--shader <name>` for the specific leg's subject) immediately after the `served md5 == disk
  md5` check and before any product leg, treating a non-zero exit as STRUCTURAL (rebuild, re-check)
  rather than proceeding to measure a possibly-stale bundle. Job 6's own preflight already does this by
  hand (`PREFLIGHT.txt`, both a whole-sweep and a `--shader GlobeTerrain` invocation, both exit 0) —
  this row's acceptance is that shape becoming the **documented, standing** form, not a one-off.
- **Binds:** SR-6, SR-8. **Source:** `REVIEW_GUNDOR_ROUND2.md` §5 item 2 ("Rule on the executor
  preflight"); `Tools/visual-regression/output/wave-p0-1-edge-2026-09-05/SUMMARY.md` ("What this job
  establishes about the preflight itself"); `M-30`; `DX-47`.

### `DX-51` — wire the built-shader-identity check into `probe-vector-draping.mjs` itself, once Brodda's re-vehicle lands

- **Disposition:** OPEN. Filed 2026-09-05 (Hunleth) from Gundor's round-2 review follow-up 1. Standalone
  was the right call while `probe-vector-draping.mjs`'s re-vehicle was in flight in a separate lane
  (tree copy `076cff2634087f18f6b4c6209f07c457` vs the re-vehicled `776dc6f329132e3e46a2286270e66cc1`
  Éowyn ran in both job 5 and job 6) — a standalone CLI check cannot collide with an in-flight lane's
  file. Job 6 confirms the re-vehicle **works** (gate B 1.000 on a clean bundle) but it is **still not
  landed on the tracked tree** two clean Edge runs later; wiring the preflight into the probe itself
  (rather than requiring a human to remember to run the CLI first) is contingent on that landing.
- **Tier / Size / Backends:** SONNET-BOUNDED · XS · tooling. **Depends on:** Brodda's `probe-vector-draping.mjs`
  re-vehicle landing on the tracked tree; `DX-50` (the general preflight adoption, which this row
  specialises for one probe). **Ruling touched:** none. **Gate:** none.
- **Acceptance:** `probe-vector-draping.mjs` calls the built-shader-identity check on its own subject
  shader (`GlobeTerrain`) before computing gate B, and refuses (a distinct exit code from a measured
  red) rather than reporting a countRatio if the check finds the served bundle drifted — closing the
  exact failure mode job 5 hit.
- **Binds:** SR-6. **Source:** `REVIEW_GUNDOR_ROUND2.md` §5 item 1 ("Wire the preflight into the probe").

### `DX-52` — a `Build/` freshness signal (mtime comparison) as a cheap second net beside the identity check

- **Disposition:** OPEN. Filed 2026-09-05 (Hunleth) from Gundor's round-2 review follow-up 3, echoing
  Penlod's own round-2 recommendation. The built-shader-identity check (`DX-47`, landed Batch 1423) is
  the authoritative content check; a cheaper, purely-metadata signal that flags the same condition before
  anyone has to run the heavier check is worth having as a fast first net — newest source mtime under
  `packages/engine/Source/Shaders/` vs the served bundle's own mtime, warning (not failing) when the
  bundle is older.
- **Tier / Size / Backends:** SONNET-BOUNDED · XS · tooling. **Depends on:** `DX-47`/`DX-50` (this is a
  faster, lower-confidence companion to the identity check, not a replacement). **Ruling touched:** none.
  **Gate:** none.
- **Acceptance:** a one-line addition to the same preflight reports "bundle is N seconds older than the
  newest shader source" whenever that is true, so a human reading the preflight output sees the same
  signal Penlod had to reconstruct by hand from four separate `stat` calls; a fixture where the bundle is
  artificially touched older than a shader source triggers the warning, and one where it is newer does
  not.
- **Binds:** SR-8. **Source:** `REVIEW_GUNDOR_ROUND2.md` §5 item 3; `LANDING_PACKET_PENLOD2.md` §"DX rows
  this round surfaces".

### `DX-53` — `decodeJsStringLiteral`'s CRLF line-continuation case is unhandled (safe-direction false-drift, unreachable with esbuild's LF output)

- **Disposition:** OPEN. Filed 2026-09-05 (Hunleth) from Gundor's round-2 review's one non-blocking nit
  (§3) on the newly-landed `built-shader-identity.mjs`. `decodeJsStringLiteral` handles `\` + LF as a
  line continuation (`SIMPLE_ESCAPES` maps it to `""`), but not `\` + CRLF — the `\r` falls through
  `simple ?? next` and is emitted literally, so a bundle containing that exact escape sequence would
  decode with a spurious extra newline and the verdict would read a **false DRIFTED**. Confirmed
  unreachable in the fleet today (esbuild writes LF only) and the failure direction is safe (a spurious
  "rebuild first," never a false CURRENT) — explicitly **not blocking** the tool's landing.
- **Tier / Size / Backends:** SONNET-BOUNDED · XS · tooling. **Depends on:** none. **Ruling touched:**
  none. **Gate:** none.
- **Acceptance:** a one-line fix in the `next === "x"` style Gundor's review names verbatim (treat `\r`
  followed by `\n` as a two-character continuation, `\r` alone as a one-character continuation), with a
  fixture proving the CRLF case decodes without the spurious newline; low priority, safe to defer.
- **Binds:** SR-6. **Source:** `REVIEW_GUNDOR_ROUND2.md` §3 ("Nit, not blocking").

### `DX-54` — `built-shader-identity.spec.mjs`'s `D1` silently skips when `Build/` is absent, so "138/138" is not proof a bundle was checked

- **Disposition:** OPEN. Filed 2026-09-05 (Hunleth) from Gundor's round-2 review follow-up 5. `D1`
  (`built-shader-identity.spec.mjs:219-243`) skips rather than fails when `Build/CesiumUnminified` is
  absent — correct behaviour for a spec suite on a fresh, unbuilt checkout, but it means a green
  `npm run test-build-infra` (138/138) does not by itself certify that any real bundle was ever compared.
  **The CLI (`Tools/verify-built-shader-identity.mjs`), not the spec, is the binding gate** for whether a
  served artifact was actually checked — a distinction this row exists to document, not to change.
- **Tier / Size / Backends:** SONNET-BOUNDED · XS · docs (one sentence). **Depends on:** none. **Ruling
  touched:** none. **Gate:** none.
- **Acceptance:** wherever `test-build-infra`'s runner home or the built-shader-identity tool is
  documented (this queue's `DX-47` card, and/or a header comment in the spec/CLI itself) states plainly
  that `D1`'s green does not imply a bundle was checked — the CLI's own exit code against a real served
  artifact is what does.
- **Binds:** — (docs only). **Source:** `REVIEW_GUNDOR_ROUND2.md` §4 ("One conditional worth stating").

### `DX-55` — `probe-primitive-texture-bindgroup.mjs`'s `frustum-lit` capture is byte-identical to `frustum-flat`, so the cell cannot distinguish a lit appearance from a flat one

- **Disposition:** OPEN. Filed 2026-09-05 (Hunleth) from Éowyn job 6 leg 2 (`AR-832`/`AR-834`'s Edge
  acceptance run, otherwise GREEN 4/4). `frustum-lit-webgpu.png` and `frustum-flat-webgpu.png` are
  byte-identical (sha256 match) in the captured evidence, so the probe's `frustum-lit` scene — meant to
  exercise the **non-flat** (`PerInstanceColorAppearance({flat: false})` or lit-material) shader
  selection path as `AR-832`'s sibling clause — is not currently rendering anything visibly different
  from the flat scene it sits beside. This is an **instrument weakness in the probe, not a product
  defect**: `AR-832`'s own gates (validation-error count, `frustum-flat`'s pixel mismatch, the
  `distinctCoarseColors` canary) all pass independently of this cell, so the row's acceptance is not
  compromised — but the `frustum-lit` cell is currently unable to prove the lit/flat shader selection
  divergence it was added to check.
- **Tier / Size / Backends:** SONNET-BOUNDED · S · tooling (probe scene construction). **Depends on:**
  none. **Ruling touched:** none. **Gate:** none.
- **Acceptance:** `frustum-lit`'s scene is corrected (camera, lighting, or appearance construction) so
  its WebGPU capture differs visibly from `frustum-flat`'s on the same tree, with a negative control
  (reverting the correction reproduces the byte-identical pair) proving the fix actually restores the
  intended lit/flat distinction rather than merely perturbing pixels.
- **Binds:** SR-6. **Source:** `Tools/visual-regression/output/wave-p0-1-edge-2026-09-05/SUMMARY.md`,
  leg 2 ("Instrument note").

### `DX-56` — `WebGPUContext.ts` carries three standing comment-marker-guard errors, so any lane touching it inherits a red it did not cause

- **Disposition:** OPEN. Filed from wave P0-1 (2026-09-04). `npm run lint-comment-markers` reports three
  standing errors in `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts` that pre-date the wave;
  because the guard is a whole-file gate, any lane that edits that file inherits a red it did not
  introduce and cannot clear in-lane without an unrelated cleanup in its own patch. The file is also
  `DX-08`'s decomposition subject (7,889 lines), so the two rows should be sequenced rather than raced.
- **Tier / Size / Backends:** SONNET-BOUNDED · XS · tooling (comment hygiene). **Depends on:** none;
  sequence against `DX-08`. **Ruling touched:** none. **Gate:** `npm run lint-comment-markers`.
- **Acceptance:** `npm run lint-comment-markers` reports zero errors for `WebGPUContext.ts` — each of the
  three either corrected in place or added to `Tools/c16/comment-marker-cleanlist.txt` with a one-line
  recorded reason — and the guard's total flagged count moves by exactly three, so the change is proven
  to have cleared these and nothing else.
- **Binds:** SR-6. **Source:** `LANDING_PACKET_BARAHIR.md` §5.13.

**`DX-56` (2026-09-05, filed from Barahir §5.13, fix round Urwen).** Not added to the "Wave DX = 15"
summary table above, per the `DX-36`…`DX-55` landing-night precedent (`DX-42`'s card states the rule);
see this card for tier, size, dependencies and acceptance.

### `DX-57` — follow-up patches must be diffed against a fetched seat tip, never a snapshot directory

- **Disposition:** OPEN. Filed from wave P0-1 round 5 (2026-09-05, lane Emeldir2). The lane's first
  `emeldir-followup2.patch` was cut with `diff -u` against `_lane-out/pre-r5/`, a local snapshot
  directory copied out of the lane's own clone. The seat holds no blob for that snapshot's index
  lines, so `git apply --3way` failed at the seat with "repository lacks the necessary blob" and a
  direct `git apply` missed context where another lane's commit had moved the ledger tail underneath
  it. The fix was to re-cut the patch in a fresh clone synced to the seat's actual tip
  (`F:/Dev/GH/cesium-lane-emeldir2-20260905`, HEAD `fcaf8d92b3` = Batch 1427) via
  `git diff HEAD --binary --no-renames -- <paths>`, which `git apply --check` and
  `git apply --3way --check` both then accepted cleanly against the seat.
- **Tier / Size / Backends:** SONNET-BOUNDED · XS · tooling (lane/handoff procedure, not engine code).
  **Depends on:** none. **Ruling touched:** none. **Gate:** none (a procedure, not a spec-checkable
  artefact).
- **Acceptance:** the standing rule is recorded where lanes read it before cutting a follow-up patch
  (`ORCHESTRATION_HANDBOOK.md`'s worker-rules paragraph carries the one-sentence version) and a
  follow-up patch's landing packet states which base it diffed against (a fetched seat tip / `FETCH_HEAD`,
  never a bare snapshot directory) as one of its stated verification facts, alongside the `git apply
  --check` / `--3way --check` exit codes it already reports.
- **Binds:** SR-3. **Source:** `LANDING_PACKET_EMELDIR_R5.md` §9 ("Patch re-cut (mechanics only — no
  content change)"); `ORCHESTRATION_HANDBOOK.md`'s worker-rules paragraph (Batch 1424).

### `DX-58` — the provisioner's governance-copy step leaves `MAINTAINER_RULINGS_2026-08-17.md` modified in every fresh clone

- **Disposition:** OPEN. Filed from wave P0-1 (Halmir, 2026-09-04; recurred, Barahir, 2026-09-05;
  reproduced a third time in lane Borlach's own clone at Batch 1428, 2026-09-05). Every freshly
  provisioned worker clone shows `migration_doc/MAINTAINER_RULINGS_2026-08-17.md` as **modified** in
  `git status` immediately after provisioning, before any lane edits it. `git diff --numstat` on the
  file prints **no row** — the content is byte-identical — so the change is a pure line-ending
  artefact (LF/CRLF) of whatever copy mechanism the provisioner's governance-copy step uses. An
  unscoped `git diff HEAD --binary --no-renames -- migration_doc/` export (the shape every lane and
  every wave-close doc-patch uses) picks the file up as a spurious hunk unless the lane remembers to
  name explicit paths instead, which is exactly the workaround `LANDING_PACKET_EMELDIR_R5.md` §9 had
  to apply to keep it out of a patch.
- **Tier / Size / Backends:** SONNET-BOUNDED · XS · tooling (provisioning script). **Depends on:**
  none. **Ruling touched:** none. **Gate:** `git status --short` immediately post-provision.
- **Acceptance:** a freshly provisioned clone's `git status --short` reports zero entries for
  `migration_doc/MAINTAINER_RULINGS_2026-08-17.md` before any lane edit — i.e. the provisioner's copy
  of that file preserves the source's line endings (a binary-mode copy, or a checkout-based copy,
  rather than whatever text-mode copy currently normalises it) — verified across at least two
  independently provisioned clones so the fix is not a one-off.
- **Binds:** SR-3. **Source:** `LANDING_PACKET_EMELDIR_R5.md` §9 ("`migration_doc/MAINTAINER_RULINGS_2026-08-17.md`
  contributes nothing"); reproduced directly in `F:/Dev/GH/cesium-lane-borlach-20260905` (`git status`
  at session start, 2026-09-05). **Recurred wave-wide in wave P0-2 (2026-09-05): all five lane clones showed it, and the lead had to assert per patch that the file was absent from the export — see `cesium-lane-hurin-20260905/_lane-out/LANDING_PACKET_HALDAN.md` §1, which lists it beside `_lane-out/` paths and `eslint.seatbelt.tsv` as one of the four things a patch is checked for NOT containing. The workaround has therefore hardened into a standing verification step, which is the shape of a defect that should be fixed at its source instead. Second candidate owner to rule out before touching the provisioner: the repository's own `.gitattributes:2` (`* text=auto`) combined with `core.autocrlf=true` — the same mechanism the fixture blocks at `:14` and `:41` already document as a silent-rewrite hazard — so the acceptance above must name which of the two is responsible rather than patching whichever is touched first.**

### `DX-59` — `probe-postprocess-resize-survival.mjs` never arms the uncaptured-GPU-error channel; census the fleet for the same omission

- **Disposition:** OPEN. Filed from wave P0-1 job 8 (Éowyn, 2026-09-05). The probe's `gateErrors`
  reads `{errors: [], deviceLost: null, armedDevices: 0}` on a GREEN run. It calls
  `attachConsoleErrorGate` and `errorGateInit` but never `armWebGPUDevices(page)` — the helper that
  installs `device.onuncapturederror` — so `armedDevices: 0` is structural, not a measurement of a
  clean device, and the empty `errors[]` array evidences **console** errors only. The clause this
  probe scores is measured in pixels and slot readings, so job 8's GREEN does not rest on this gate —
  but its coverage is narrower than the receipt's shape implies, and a probe that both attaches a
  console gate and skips the device-error arm is easy to write again elsewhere in the fleet.
- **Tier / Size / Backends:** SONNET-BOUNDED · S · tooling (probe fleet). **Depends on:** none.
  **Ruling touched:** none. **Gate:** none yet — the census this row asks for is the prerequisite for
  one.
- **Acceptance:** (a) `probe-postprocess-resize-survival.mjs` calls `armWebGPUDevices(page)` at setup
  and its receipt reports a non-zero `armedDevices` on a run against a real WebGPU page; (b) a fleet
  census (grep every probe under `Tools/visual-regression/` that calls `attachConsoleErrorGate` or
  `errorGateInit` for a sibling `armWebGPUDevices` call in the same file) names every probe with the
  same omission, with a fix-or-file disposition recorded per name — not fixed silently, per the
  standing rule to surface DX issues rather than route around them.
- **Binds:** SR-6. **Source:** `Tools/visual-regression/output/wave-p0-1-edge-2026-09-05-job8/SUMMARY.md`
  ("Instrument observation — for the seat, not a verdict change").

### `DX-60` — a settle that calls `scene.render()` without `scene.requestRender()` and a null readiness predicate reproduces void captures; census the fleet with the `settleReady()` fix pattern

- **Disposition:** OPEN. Filed from wave P0-1 job 7 / round 3 (Éowyn, lane Emeldir, 2026-09-05) — the
  mechanism behind the job-7 black-frame class. `probe-postprocess-resize-survival.mjs`'s pre-fix
  settles were `settleThen(n, null)`: a fixed frame count, a loop calling `scene.render()` with **no**
  `scene.requestRender()` and **no** readiness predicate. `Scene.js:2698-2723`'s `renderReady`
  docstring names the exact consequence — "a poll that only calls render() would spin against a scene
  that has decided it has nothing to redraw" — and job 7 reproduced it precisely: three of its four
  captures were one byte-identical file (85.5 % black) across ~95 settled frames. The runtime already
  owns a gate for exactly this case, `decideRenderReadyRefusal` (`Tools/visual-regression/lib/probe-runtime.mjs:400-424`),
  which the probe opted out of by passing a `null` predicate — a `runtime-residency-contract.spec.mjs`
  (`DX-02`) concern: a resident probe re-implementing, rather than routing through, what the runtime
  already provides. Fixed in this probe by `settleReady()`
  (`Tools/visual-regression/probe-postprocess-resize-survival.mjs:226-297`): `globe.tilesLoaded` **and**
  a non-empty command list **and** `scene.renderReady`, held for 8 consecutive frames, requesting a
  render each iteration, plus two pure refusal decisions (`decideSettleRefusal`, `decideContentRefusal`)
  that raise a `ProbeRefusal` before any clause is scored rather than letting a contentless frame pass
  or fail either way.
- **Tier / Size / Backends:** SONNET-BOUNDED · S · tooling (probe fleet). **Depends on:** none.
  **Ruling touched:** none. **Gate:** none yet — the census is the prerequisite.
- **Acceptance:** a fleet census (grep every probe under `Tools/visual-regression/` for a settle loop
  that calls `scene.render()`/`renderNow()` without an adjacent `scene.requestRender()`, or that passes
  a `null`/absent predicate to a fixed-frame-count settle helper) names every probe in the same defect
  class, each with a fix-or-file disposition citing `settleReady()` as the reference implementation —
  not a rewrite of the pattern per probe, a port of it.
- **Binds:** SR-6, SR-8. **Source:** `LANDING_PACKET_EMELDIR_R5.md` §2(d)/(e), §3;
  `Tools/visual-regression/output/wave-p0-1-edge-2026-09-05-job7/SUMMARY.md`;
  `packages/engine/Source/Scene/Scene.js:2698-2723`; `Tools/visual-regression/lib/probe-runtime.mjs:400-424`.

### `DX-61` — the dispatch layer cannot distinguish a dead worker from a slow one, and put two live agents in one clone three times

- **Disposition:** OPEN. Filed from wave P0-2 (lead Haldan, 2026-09-05). Three separate dispatch
  rounds each produced **two live agents in one lane clone**. The cause is structural, not a
  mistake: neither a lead nor a coordinator can tell a dead child from a slow one, and "the clone
  looks clean" is not evidence of death — a worker that is still *reading* has written nothing yet,
  so an inspection of the worktree is indistinguishable between the two states. The lead wrote an
  `_lane-out/OWNER` lock file before dispatching and **it did not help, because nothing enforces
  it**: a file that asks politely is not a lock. Cost this wave ≈ **790k tokens** of duplicated
  worker effort, and every duplicate behaved correctly (detected the collision, wrote nothing
  tracked, retired, and banked its findings — several of which corrected the survivor), so the
  defect is the dispatcher's alone and no lane is at fault for it.
- **Tier / Size / Backends:** OPUS-JUDGMENT · S · tooling (dispatch). **Depends on:** none.
  **Ruling touched:** none. **Gate:** none yet.
- **Acceptance:** dispatch proves **liveness**, not intent — a pid file or a heartbeat the
  dispatcher writes and re-reads (a lease with an expiry, refreshed by the running agent), so that
  "is this clone occupied?" is answered by a signal a dead process stops emitting rather than by a
  file a dead process leaves behind. The negative control is the one that matters: kill an agent
  mid-lane and show the dispatcher then reports the clone free, and leave one *reading* and show it
  reports the clone busy. A purely advisory `OWNER` file is explicitly **not** acceptance — wave
  P0-2 shipped one and it failed three times.
- **Binds:** SR-3. **Source:** `cesium-lane-hurin-20260905/_lane-out/LANDING_PACKET_HALDAN.md` §6
  (first bullet) and §7 (the per-lane duplicate-spend column).

### `DX-62` — the session scratchpad is shared across concurrently dispatched lanes, and one lane overwrote another's staging files mid-round

- **Disposition:** OPEN. Filed from wave P0-2 (2026-09-05). Lanes dispatched into separate clones
  nonetheless share one session scratchpad directory, so two lanes writing a staging file under the
  same name collide silently. It happened this wave: lane Uldor recorded that "a shared scratchpad
  file was overwritten by another lane earlier today" and, from its fix round onward, took every
  backup at a path **namespaced to its own clone**
  (`…/scratchpad/uldor-fixround2-20260905/backup/`, with a `SHA1.txt` and a `RESTORE.md`) precisely
  to route around it. Both affected lanes verified their packets uncontaminated, so nothing landed
  wrong — but the failure is silent by construction and the next occurrence need not be caught.
- **Tier / Size / Backends:** SONNET-BOUNDED · XS · tooling (dispatch/provisioning).
  **Depends on:** none. **Ruling touched:** none. **Gate:** none yet.
- **Acceptance:** each dispatched lane is handed a scratchpad path that **contains its own lane
  name**, so two lanes cannot collide on a filename by construction rather than by convention; the
  brief boilerplate names that path, and a two-lane test writing the same basename concurrently
  leaves both files intact. Namespacing by hand inside each lane (Uldor's workaround) is the
  mitigation, not the fix.
- **Binds:** SR-3. **Source:** `cesium-lane-uldor-20260905/_lane-out/LANDING_PACKET_ULDOR.md:951`;
  `LANDING_PACKET_HALDAN.md` §6 (third bullet).

### `DX-63` — the comment-marker guard's `(.wgsl 0/5)` census reads as coverage but is *flagged/scanned*; the output never says which

- **Disposition:** OPEN. Filed from wave P0-2 (2026-09-05); one worker nearly misreported its own
  gate as a miss because of it. `renderCensus` (`Tools/c16/comment-marker-guard.mjs:505-516`) builds
  the per-extension pairs as `${ext} ${counts.flagged}/${counts.scanned}` and prints them **inside
  the `scanned … files (…)` line**, so `.wgsl 0/5` means *0 flagged of 5 scanned* — a perfect score
  — while reading in the shape of a coverage fraction, where 0/5 is the worst possible result. The
  two numbers are populated at `:444-448` and their meaning appears nowhere in the output.
- **Tier / Size / Backends:** SONNET-BOUNDED · XS · tooling (gate output). **Depends on:** none.
  **Ruling touched:** none. **Gate:** the guard's own output.
- **Acceptance:** the census line names what the pair is — `.wgsl 0 flagged / 5 scanned`, or a
  column header stating `flagged/scanned` once — so no reader can take a good result for a bad one;
  the guard's exit codes and findings are unchanged (this is an output-legibility fix, not a
  behaviour change), and a run over a file with a known finding still shows the flagged count move.
- **Binds:** SR-3. **Source:** `LANDING_PACKET_HALDAN.md` §6 (last bullet); the render site read at
  HEAD.

### `DX-64` — `audit-feature-renderers.mjs` counts only the eager registration form, so it reports 41 of 54 keys wired when 52 are, and buries its one true finding among eleven false ones

- **Disposition:** OPEN. Filed from doc wave D1 (Haldad, 2026-09-05) and **re-measured at Batch 1443
  for this row**. `scanSites` matches `registerFeatureRenderer\s*\(\s*FeatureRendererKey\.([A-Z0-9_]+)`
  (`Tools/audit-feature-renderers.mjs:91-96`) — the **eager** form only. It does not match
  `registerFeatureRendererLoader(`, the lazy form `WebGPUFeatureRenderers.ts` uses for every renderer
  that pulls in its own shaders or compute pipelines (e.g. `GAUSSIAN_SPLAT` at `:698-699`,
  `POINT_CLOUD_EDL` at `:725`, `FFT_OCEAN` at `:905`). Measured over the two files at HEAD: **54 enum
  keys, 41 eager registrations, 11 lazy ones, union 52** — and exactly **two** keys are registered by
  neither form: `FOG`, declared intentional in the tool's own `INTENTIONAL_UNWIRED_KEYS` map
  (`:37-43`), and **`GROUND_ATMOSPHERE`**, which the source documents as *retired* at
  `WebGPUFeatureRenderers.ts:804-810` (ground atmosphere is shaded inside `GlobeTerrain.wgsl`; the
  separate-pass renderer was deleted) but which that map does not list. So the tool's twelve-name
  "Unregistered keys" list is eleven false positives hiding one real finding, and its headline count
  is wrong by eleven.
- **Tier / Size / Backends:** SONNET-BOUNDED · XS · tooling (audit). **Depends on:** none.
  **Ruling touched:** none — and note `CLAUDE.md`'s Feature Renderer Pattern section cites this
  enum's `COUNT` (54 at HEAD), which is unaffected. **Gate:** `node Tools/audit-feature-renderers.mjs`.
- **Acceptance:** the scan recognises both registration forms and the run reports **52 of 54 keys
  wired**; the unregistered list contains `GROUND_ATMOSPHERE` **alone**, and that key is then either
  promoted onto `INTENTIONAL_UNWIRED_KEYS` with the retirement reason from
  `WebGPUFeatureRenderers.ts:804-810` (leaving the list empty) or filed as real work — the tool's own
  docstring at `:32-36` already asks a reader to make exactly that call. Negative control: a key
  registered *only* lazily, with its loader call made inert, returns to the unregistered list.
- **Binds:** SR-3, SR-6. **Source:** doc wave D1 seat items (Haldad, 2026-09-05); counts re-derived
  in this lane at Batch 1443 over `Tools/audit-feature-renderers.mjs`,
  `packages/engine/Source/Renderer/FeatureRendererKey.js` and
  `packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts`.

### `Q-130-a` — `FrustumGeometry.js` misuses `defined(vertexFormat.normal)`/`.st` on always-defined booleans

- **Disposition:** OPEN. Filed here as its own row for the first time — until now `Q-130-a` existed only
  inside `Q-130`'s own lane-claims notes cell (`FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md:526`, "`Q-130-a`
  filed: FrustumGeometry misuses `defined(vertexFormat.normal)` on always-defined booleans (not fixed
  here)"), and a repo-wide grep for the id returns exactly that one line. `VertexFormat.js:50,62` assign
  `st`/`normal` as plain **booleans**, so `defined(vertexFormat.st)` and `defined(vertexFormat.normal)`
  are **always true** — `VertexFormat.POSITION_ONLY` sets them `false` (`:109-113`), not undefined —
  and `FrustumGeometry.js:473-490` gates its st/normal attribute emission on `defined(...)` rather than
  on the boolean's truthiness. A `POSITION_ONLY` frustum therefore still emits `st` and `normal`
  attributes, which is the trigger that let `WebGPUPrimitiveShaders.js`'s attribute-presence shader
  selection diverge from WebGL for a flat-appearance frustum (`AR-832`, landed Batch 1418).
- **This is upstream code, and Principle 1 governs it: NOT to be changed here or by `AR-832`.**
  `FrustumGeometry.js` is inherited CesiumJS geometry code, not fork-authored; repairing the trigger
  instead of the WebGPU-side bind-group/shader-selection defect it exposed would hide the underlying
  bug for the next non-material appearance over any other st-carrying geometry, and would touch a file
  outside the fork's WebGPU-specific surface for no parity gain. `AR-832`'s landed fix and `AR-885`
  (the vertexFormat parity row, P3, gated on `AR-832` landing first) both deliberately leave this file
  untouched — this row exists so the trigger itself has a tracked identity, separate from the two rows
  that consume it.
- **Tier / Size / Backends:** OPUS-JUDGMENT (upstream geometry code; any change needs an upstream-sync
  posture, not a fork-local patch) · XS · both (`FrustumGeometry` is shared, backend-agnostic geometry).
- **Depends on:** none to file; **a fix depends on** `AR-832` (landed) and `AR-885` (P3, gated on
  `AR-832`) both closing first, so the trigger's own disposition is decided last, with full knowledge
  of what already reads around it. **Ruling touched:** none. **Gate:** none.
- **Acceptance:** not a fix acceptance — this row's job is to exist as the trigger's tracked identity.
  If a future upstream sync or a maintainer ruling decides to correct `defined(vertexFormat.normal)`/
  `.st"` to a truthiness test in `FrustumGeometry.js`, the acceptance is `AR-885`'s (a `POSITION_ONLY`
  frustum emits no st/normal/tangent/bitangent, and renders byte-identically on WebGL before and after);
  until then this row stays OPEN as a pointer so nobody re-derives "no row exists" a second time.
- **Binds:** SR-1 (Principle 1 — never repair the trigger to hide the defect). **Source:**
  `FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md:526` (Q-130 lane-claims cell); `QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md`
  `AR-885` (the parity row this trigger blocks) and `AR-832`'s landing packet (lane Mablung, reviewer
  Urthel, Batch 1418), which independently re-derived and ratified the same "do not cross this fence"
  disposition.

## 6b. UPSTREAM SYNC — CesiumJS 1.145. Plan authority: `UPSTREAM_SYNC_PLAN_1.145_2026-09-04.md`

**LANDED 2026-09-04.** Planned by lane U on 2026-09-04 from one dry-run merge, executed in an
isolated clone and aborted; then executed for real by lane S (lead Tar-Minyatur) later the same day
as merge commit **`33398505e6`, Batch 1408** — parents `e7360fa234` (fork, Batch 1407) and
`488b114e16` (`upstream/main`, PR #13764), merge-base `6d5d8b1f07`. The plan
([`UPSTREAM_SYNC_PLAN_1.145_2026-09-04.md`](UPSTREAM_SYNC_PLAN_1.145_2026-09-04.md)) carries the
original census and the resolution per hunk; a same-day re-derived dry run found the census had
drifted by exactly one file (+1 hunk, nothing dropped) before the real merge executed; these rows
carry current status, all now landed or verified except `-07`. Verification: Éowyn job 4,
**FIT TO FAST-FORWARD** (`-06`). Follow-up fix: Penlod's draped-polyline width port, **Batch 1410**,
reviewer Gundor.

Measured, not quoted, at execution: `main` was **363 commits behind** `upstream/main` `488b114e16`,
merge-base `6d5d8b1f07`; the merge produced **176 files changed — 125 M, 48 A, 3 D**
(+10,393/−2,493) resolving **33 conflicted files / 80 conflict hunks** (the dry-run census's 32/79
plus one drifted file, `Scene/renderBufferPointCollection.js`).

Two facts that govern how these rows are read. **(1)** The sync is the **one sanctioned merge
commit** against the otherwise squash-only landing rule — CLAUDE.md's procedure requires a verified
two-parent commit, and squashing it would corrupt the next sync's merge-base. Verified: exactly two
parents (`git rev-list --parents -n 1` on `33398505e6`). **(2)** All 33 conflicts resolved into that
single commit; `-01`…`-04` were **review gates on `-00`'s committed tree**, not separate commits, and
all four returned LAND.

### `UPSTREAM-SYNC-1.145-00` — the merge commit and the `PORT-INTO-CLASS` resolution pass

- **Disposition:** LANDED, Batch 1408. Merge commit `33398505e6e5c3a3a635243b7941b5c3264a469b`, parents `e7360fa234b97ca206321ec568f105008be81625` (fork, Batch 1407) and `488b114e16f5879f5d51456640aae67850a715c0` (`upstream/main`, PR #13764), merge-base `6d5d8b1f0725b6f831b336463f4b11c98023427b`. Plan §8.2 executed in full: safety branch `pre-upstream-merge-1.145-2026-09-04` (local to the merge clone, never pushed — delete once `-06` verified green, which it now has). A same-day re-derived dry run found the census had drifted by one file (`Scene/renderBufferPointCollection.js`, +1 hunk; 33 conflicted files / 80 hunks against the plan's 32/79) with every other per-file hunk count identical; nothing else moved. All 32/33 conflicts resolved cluster by cluster per plan §5; the sixth resolution class `PORT-INTO-CLASS` applied to all 13 pre-existing ES6-class files (36 of 80 hunks, 45% — independently matching the plan's 46% prediction) plus the auto-merged `Cesium3DTileset.js` `vectorBlendOption` accessor, which arrived as a bare property-descriptor entry inside the class body and would otherwise have been a hard `SyntaxError`. The `UniformState` × `AutomaticUniforms` fix landed inside this commit as planned. Two parents verified (`git rev-list --parents -n 1 HEAD` = exactly 2); working tree clean after commit.
- **Tier / Size / Backends:** OPUS-JUDGMENT · XL · both. **Depends on:** — (landed). **Ruling touched:** invoked the Upstream Sync Procedure. Its step-5 `--theirs` default is **not yet amended** — `CLAUDE.md:578` still prescribes it, and the amendment is the open maintainer decision `AR-D23` (`QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md:506`); this merge worked around it with the `PORT-INTO-CLASS` class and guarded the failure mode going forward with `-08`. **Gate:** none — ruling-free; it needed a window, not a decision.
- **Acceptance — MET:** `git cat-file -p HEAD` shows two parents (`e7360fa234`, `488b114e16`); `npx gulp build` (2.62 min) and `npx tsc --noEmit` both green; `node Tools/upstream-shape-guard.mjs` reports `OK — no file that was an ES6 class before the merge is prototype-based now` over 49 in-scope files, exit 0, independently re-run by all four station-3 reviewers with the same result; `czm_eyeCartographic` and `czm_eyeToEnu` resolve to defined values through the automatic-uniform path — re-derived numerically (not just read) by Tar-Falassion (cluster-d review): `_eyeCartographic.z === _eyeHeight` exactly, `_eyeToEnu` orthonormal to 8.9e-16 with det 1.
- **Review:** all four station-3 reviews returned **LAND** — `REVIEW_ERADAN_cluster-a.md`, `REVIEW_HERION_cluster-b.md`, `REVIEW_TAR-ANDUCAL_cluster-c.md`, `REVIEW_TAR-FALASSION_cluster-d.md`. Landing packet: `LANDING_PACKET_TAR-MINYATUR.md` (Tar-Minyatur, lead). Follow-up items each review opened are tracked under `-07` (WGSL parity residue) and DX rows; none blocked the commit.
- **Binds:** SR-1. **Source:** plan §2, §3, §8; `LANDING_PACKET_TAR-MINYATUR.md` §1, §4, §8.

### `UPSTREAM-SYNC-1.145-01` — globe cluster resolution review

- **Disposition:** LANDED, Batch 1408. Review gate on `-00`'s globe resolution: `GlobeSurfaceShaderSet`'s shader-key bit assignment (the sync's highest-severity single resolution) and `GlobeSurfaceTileProvider`'s ten transplants into its rendering companion. Reviewer Eradan recomputed both files' upstream semantic delta independently (`git diff` base-vs-theirs compared item for item against fork-vs-merged) and found the two identical except the bit numbers, confirmed the union bit map (`hasVectorLayer` restored to its merge-base bit 33; fork's four flags moved to a documented floor of bit 39; max `flags` 2^43−1, 1,024× headroom under `MAX_SAFE_INTEGER`), and verified the `updateForPick` `OURS` resolution by tracing `DrawCommand.shallowClone` with no `result` argument — the fork is structurally immune to the bug 1.145 fixes.
- **Tier / Size / Backends:** OPUS-JUDGMENT · M · both (WebGL primarily). **Depends on:** `-00` landed. **Ruling touched:** none. **Gate:** none.
- **Acceptance — MET:** the post-merge bit map is stated (bits 32-42, table in `REVIEW_ERADAN_cluster-a.md`) and every bit has exactly one meaning — proven by sweeping all 2,048 subset sums of the 11 high terms against both extremes of the low 32 bits (4,096/4,096 distinct, zero collisions); `Tools/visual-regression/globe-shaderset-flag-injectivity.spec.mjs` (new, homed in `test-engine-node`) re-run at 7/7 with two inertness mutants (a fork term and an upstream term each made unreachable while their `#define` push stays live) both correctly failing. Two non-blocking follow-ups carried to `-07`: no detector for `maxTextures -= 3`, and WebGPU allocates unused WebGL-compat clipping textures.
- **Binds:** SR-1. **Source:** plan §5.1; `REVIEW_ERADAN_cluster-a.md`.

### `UPSTREAM-SYNC-1.145-02` — clipping polygons + vector pipeline; the `UP-1` disposition

- **Disposition:** LANDED, Batch 1408. The sync's largest cost centre. 1.145 deleted `clipPolygons.glsl`, `unpackClippingExtents.glsl` and `PolygonSignedDistanceFS.glsl`. **D1 resolved DROP for exactly the WebGL SDF producer** (`queueCommands`/`_signedDistanceComputeCommand` — the fork's own docstring states `ClippingPolygonCollection.update()` returns at the feature-renderer branch before that body ever runs, so the deletion is confined) and **D3 relocated** the backend-neutral packing bucket to the new `Scene/ClippingPolygonSdfPack.js`, proved byte-identical to the pre-merge packer over three polygons (two overlapping, so extent-merging runs) with a working negative control. The WebGPU SDF atlas (`WebGPUClippingPolygonCollection.computePolygonSDF` → `PolygonSignedDistance.wgsl`) is untouched and does **not** gate on a WGSL co-land — reviewer Herion re-derived this from source rather than accepting the plan's original "`THEIRS`-but-gated" wording, which D1 corrects.
- **Tier / Size / Backends:** OPUS-JUDGMENT · L · both. **Depends on:** `-00` landed. **Ruling touched:** D1/D3 were maintainer-relevant DROP/REWORK calls, exercised and evidenced in `DECISIONS_TAR-MINYATUR.md`. **Gate:** — (exercised, not open).
- **Acceptance — MET:** clipping-polygon rendering unchanged (Herion's independent both-directions line-survival check found 0 missing lines from either side across all 12 cluster files); every changed `pack*CollectionData` call site passes an `Ellipsoid` (0 `_tilingScheme` residue repo-wide); `probe-globe-clippoly-geodetic.mjs` correctly **not** re-baselined. **Residue tracked under `-07`:** the two backends now clip by different algorithms by construction (WebGL `vectorClip` edge-texture, WebGPU SDF atlas — Principle 5 territory, not a defect), and `requestRectangleData` allocates unused WebGL-compat textures on WebGPU (found independently by Eradan and Tar-Anducal, F-1).
- **Binds:** SR-1. **Source:** plan §5.2; `REVIEW_HERION_cluster-b.md`; `DECISIONS_TAR-MINYATUR.md` D1/D3.

### `UPSTREAM-SYNC-1.145-03` — tiles + models review, including the auto-merged set

- **Disposition:** LANDED, Batch 1408. Review gate on `-00`'s tiles/models resolution — 17 hunks across 5 files, all `PORT-INTO-CLASS`/`THEIRS`. Reviewer Tar-Anducal re-ran the three-way merge from the git object store directly (not the resolver's account) and confirmed the `Cesium3DTileset.js` `vectorBlendOption` accessor really did arrive as a bare property-descriptor entry inside the class body — a hard `SyntaxError` if left unconverted — and that it resolved correctly to a `get`/`set` pair. Every `AUTO-VERIFY` consumer named in plan §5.3 was matched to its producer in the merged tree (8-row table in the review, including the pick-pipeline `hasDrapedVectors()` and the model clipping-polygon stage chain). The two plan `UNCERTAIN`s (destroy ownership via `setOwner`; bind-group capacity) both closed on re-derived evidence, not the checkpoint's word.
- **Tier / Size / Backends:** OPUS-JUDGMENT · M · both. **Depends on:** `-00` landed. **Ruling touched:** none. **Gate:** none.
- **Acceptance — MET:** no fork-authored line was removed from any of the five source files (mechanical sweep); all six ES6-class files in the cluster remained classes (0 prototype forms); `queueCommands` has zero surviving call sites; `updateWebGPUForPick`'s inverse-clip repeat verified as a genuine parity extension, not a redundant guard. **One new follow-up (F-1, non-blocking, carried to `-07`):** `ClippingPolygonCollection.requestRectangleData` lacks the backend claim its sibling `VectorProvider.requestDataForRectangle` has, so WebGPU allocates three unused WebGL-compat textures per model per rebake — confirmed independently of Eradan's same finding.
- **Binds:** SR-1. **Source:** plan §5.3, §4; `REVIEW_TAR-ANDUCAL_cluster-c.md`.

### `UPSTREAM-SYNC-1.145-04` — renderer core: `ContextLimits` layering and the snap contract

- **Disposition:** LANDED, Batch 1408. Review gate on `-00`'s renderer-core resolution, 14 hunks across 7 files. `PostProcessStage.js`'s clamp re-sourced to `context.limits.maximumTextureSize`; reviewer Tar-Falassion's repo-wide acceptance grep for `ContextLimits` outside `Source/Renderer/` returned **zero** readers post-merge. `Snapping.js`'s `surfacePosition` UNCERTAIN settled by measurement, not assumption: the re-based metric was sliced out of the shipped file and run against upstream's own implementation over 20,000 random hit sets with **0 mismatches**, and the bounded 9-px box was verified over all 625 winner positions in `[-12,12]²`. `UniformState`/`AutomaticUniforms` verified numerically (§ -00's acceptance).
- **Tier / Size / Backends:** OPUS-JUDGMENT · M · both. **Depends on:** `-00` landed. **Ruling touched:** none. **Gate:** none.
- **Acceptance — MET:** zero `ContextLimits` readers outside `packages/engine/Source/Renderer/`; the snap resolution drops WebGL from 2 readbacks to 1 and adds none to WebGPU; `previousViewProjection` confirmed still at the `CameraUniforms` tail by non-modification (the merge touched zero `struct CameraUniforms` declarations anywhere in the repo). **Two required follow-up rows opened by the reviewer, tracked separately from `-07` since they are renderer-core, not shader, gaps:** F1 — the 4-arg clip (border-clip) form has no unit-level detector, proved by mutation (`SnappingSpec`'s 5 assertions stay green with the clip made unreachable); F2 — the bounded border-clip shortfall (`|offset|` 9-12 returns `undefined`) is documented in-code but not tracked, which plan §5.4 D-3 requires. Both are enumerated under `-07`'s remaining-items list per the seat's placement (same subsystem family, one card).
- **Binds:** SR-1. **Source:** plan §5.4; `REVIEW_TAR-FALASSION_cluster-d.md` (F1, F2).

### `UPSTREAM-SYNC-1.145-05` — toolchain, widgets, Sandcastle, and the Playwright bump

- **Disposition:** LANDED, Batch 1408. The seven non-engine conflicts, the dependency moves, and `@playwright/test` 1.59.1 → 1.62.1. **All three at-risk fork-only devDependencies survived** — `@eslint/js`, `eslint-config-prettier`, `eslint-plugin-n`, each still present at one occurrence (Tar-Falassion's programmatic union check over `dependencies`/`devDependencies`/`scripts`/`overrides`: zero fork keys missing, zero upstream keys missing except `karma-ie-launcher`, which the fork deliberately removed pre-merge and the merge correctly preserves). The `"./Source/Cesium*.js"` `sideEffects` entry is byte-identical to the fork parent. `sg-scan` → `ast-grep scan` kept, not reverted. Installed Playwright confirmed 1.62.1 everywhere (packet §3.5), closing the pre-merge declared-vs-installed drift.
- **Tier / Size / Backends:** SONNET-BOUNDED · M · tooling. **Second dispatch:** OPUS-JUDGMENT · S · tooling. **Depends on:** `-00` landed. **Ruling touched:** none. **Gate:** the Sandcastle analytics module and the CLA-rotation workflow are now decided — see **M-26** (CLA: status quo/Google Sheets kept in the merge, Microsoft-Graph adoption still open) and the disposition note below; neither blocked this row.
- **Acceptance — MET:** `@eslint/js`, `eslint-config-prettier`, `eslint-plugin-n` and the `sideEffects` entry all present post-merge; all six `dev.yml` jobs on `checkout@v7`/`setup-node@v7`. **Sandcastle analytics (Amplitude):** the dependency arrived (`packages/sandcastle/package.json:16`, `@amplitude/analytics-browser ^2.44.6`, default-disabled per upstream) via auto-merge, additive and non-blocking under SR-1; one real defect found and fixed in the same commit — `initAnalytics()` landed **before**, not inside, the fork's same-origin redirect guard's `else` branch (Andvir's AUTO-VERIFY finding), which would have fired a stray analytics session on a throwaway page every wrong-origin visit; moved into the `else` branch. The dependency itself is **not yet installed** in any tree — see `-06` leg 1b (owed after `npm install`, a seat action).
- **Binds:** SR-1. **Source:** plan §6; `LANDING_PACKET_TAR-MINYATUR.md` §3.5, §5.2, §8 (G6); `REVIEW_TAR-FALASSION_cluster-d.md` (c)5.

### `UPSTREAM-SYNC-1.145-06` — post-merge verification and the wave-end gate

- **Disposition:** VERIFIED — **FIT TO FAST-FORWARD**. Éowyn job 4, 2026-09-04, run against the sync clone (tip `5ccd3695d7`, Batch 1410) with preflight PASS (served md5 == disk md5 on :8094/:8081/:8080, clean tree). Full evidence: `Tools/visual-regression/output/sync-1145-verification-2026-09-04/SUMMARY.md` (+ `STATIC_CHECKS.md`).
  - **Leg 1a (variant smoke) — GREEN**, identical verdict to the pre-merge (job 3) baseline.
  - **Leg 1b (Sandcastle2 sweep, both renderers) — NOT RUN.** `Apps/Sandcastle2/` cannot be built on the merged tree: `npx gulp -f gulpfile.apps.js buildSandcastle` fails resolving `@amplitude/analytics-browser` (merge-introduced, `packages/sandcastle/package.json:16`; installed nowhere, no `package-lock.json` refresh). **Owed after `npm install` at the seat — named as Éowyn job-5's leg.** Cost: the five new upstream demos under `--renderer=webgpu` and the `App.tsx`/`RendererToggle` auto-merge are unverified until then.
  - **Leg 1c (capture-and-diff, no `--update`) — RED on baseline provenance only, PRE-EXISTING AND UNCHANGED; rendering GREEN.** Cross-backend 10/10 PASS, max 1.479% (job 3: 1.484%), every per-scene gate within 0.041pp of job 3. The exit-1 is the same 5 missing-baseline scenes and the same `high-density-5k-spheres` black-frame fault job 3 recorded pre-merge. Not a merge regression.
  - **Leg 2 (draped-polyline width, Penlod's Edge acceptance) — CLOSED GREEN (Éowyn job 6, 2026-09-05), after a job 5 RED attributed to a stale bundle.** At job 4's time `probe-vector-draping.mjs` threw `scene.globe.vectorProvider.add is not a function` before any gate computed — 1.145 removed `VectorProvider.add`; `Scene.markVectorCollections` replaced it. Lane Brodda re-vehicled the probe onto `scene.primitives`; job 5 leg 5-3 ran it and gate B computed for the first time: `countRatio` 28741/15470 = **1.858**, outside `[0.6, 1.67]`. Penlod round 2 and Gundor's review found the served `Build/CesiumUnminified/Cesium.js` still embedded the pre-fix `< lineWidth` test — not a build-ordering gap (generation always precedes bundling), but the sync clone's dev server having run in its default non-`--serve-built` mode, which regenerates shader `.js` mirrors without ever writing `Build/CesiumUnminified` (see `DX-47`; preflight tool landed Batch 1423). **Job 6 re-ran the same probe against a bundle the preflight certified current: gates A-E PASS, countRatio 1.000, gate D 1.000 near / 1.022 far, nadir bbox delta (0,0)** — Penlod's falsifiable prediction confirmed on every number named. Job 5's RED is withdrawn as a product verdict; see `-07` item 1 (CLOSED) and item 8 (re-vehicle confirmed working, landing still owed administratively).
  - **Leg 3 (RTE/far-camera probes) — `probe-ellipsoid-rte` GREEN** (0.000% relErr on two ellipsoids, umbra IoU 0.957, 0 device errors — exercises exactly what `-00`/`-04` touched in `UniformState`/`AutomaticUniforms`). `probe-collections-far-camera` FAILs its globe-presence precondition (`onGlobe=false`); attribution **UNDETERMINED**, no pre-merge run exists for this probe.
  - **Leg 4 (subsystem parity probes) — every parity assertion GREEN**; the 2 FAILs are the same globe-brightness precondition as leg 3, and it is symmetric across backends (meanLum 9.127 webgpu vs 9.147 webgl) — not a parity fault. `probe-post-process` NOT RUN, pre-existing missing fixture, unchanged.
  - **Leg 5 (Karma subset, 6 suites) — GREEN relative to baseline.** Identical suite-for-suite pass/fail to job 3; the only change is +103 declared specs, all 1.145's own new tests, distributed proportionally across every suite's skip count. **Not the same specs as `-07` item 9:** this leg re-ran job 3's six pre-existing-red suites; cluster (c)'s own end-to-end Karma specs (`Cesium3DTilesetSpec.js:4620`, the four `ModelSpec` `getRectangle` tests, the two `-02`/`-03` `setOwner`-deviation detach tests) are a different set and remain unexecuted — tracked at `-07` item 9, not here.
  - **Overall: no leg is RED relative to the job-3 pre-merge baseline.** Three seat actions named, none a RED: `npm install` for leg 1b; Batch 1410 lacks behavioural acceptance until `-07` item 8 lands; and one measurement row (below) settles the globe-brightness attribution.
  - **New measurement row (Éowyn):** the imagery-less globe reads near-black on **both** backends in the far-camera and parity probes (globeAvg 6.3 vs ~40 expected; banked centre pixel (5,6,8) vs an earlier capture of the same frame at (31,38,51)). Not a parity fault (9.127 vs 9.147 luminance across backends); wave-end's own globe scenes use the default imagery layer and structurally cannot see it. **Acceptance to settle attribution:** one run of either probe on `e7360fa234` (the reconstruction clone still holds that build) — merge vs pre-existing.
- **Tier / Size / Backends:** OPUS-EDGE-EXECUTOR · L · both. **Depends on:** `-00`…`-05` landed. **Ruling touched:** executes the wave-end gate ruling. **Gate:** none.
- **Binds:** SR-1, SR-11. **Source:** plan §7; `Tools/visual-regression/output/sync-1145-verification-2026-09-04/SUMMARY.md`, `STATIC_CHECKS.md`.

### `UPSTREAM-SYNC-1.145-07` — the WGSL parity twins the sync opens

- **Disposition:** OPEN — **item 1 CLOSED (Éowyn job 6, 2026-09-05).** 1.145 adds GLSL-side features with no WebGPU equivalent. Principle 5 makes the twin an obligation; Principle 9 makes it a named next item rather than a silent gap. Tar-Minyatur's original hand-off (packet §10) numbered six WGSL-twin items; four cluster reviews of the merge itself surfaced six further, related but distinct, findings; Éowyn's `-06` verification surfaced one blocking instrument defect. **`SYNC_1145_WEBGPU_PARITY_CENSUS_2026-09-05.md`** (11 reader groups, 209 findings, refuter-adjudicated; banked 2026-09-05, lane Malach) re-verified all fifteen resulting items against the tracked tree — confirming most, extending six (2, 3, 5, 11, 13, 14) with facts the original hand-off did not have, and opening nine more (items 16-24) from findings the four cluster reviews did not carry. **The family is now 24 items: item 1 CLOSED, 23 open (2-24).** All are carried here rather than duplicated in `FEATURE_INVENTORY.md` §C, which per the census (§4 "Belongs elsewhere") gains **exactly two** entries: one sentence on `UP144-VECTOR-LAYER-WGSL` separating the non-draped `BufferPolylineCollection` metres gap (item 18) from the draped-path sentence it already carries, and one new row for the WGSL model vertical-exaggeration stage (item 15) — this card cross-references rather than restates that entry.

  **1. `GlobeTerrain.wgsl::vectorPolylineRender` half-width/AA/nearest-edge — CLOSED (Éowyn job 6, 2026-09-05).** Penlod, Batch 1410, reviewer Gundor: **LAND** (after a required fix round that corrected the proof's own overclaim — the node spec's width guarantee is anchored on three captured source strings, not on shader behaviour; a required assertion now pins the specific evasion found). WGSL ported to the 1.145 GLSL algorithm (half-width, nearest-edge, `smoothstep` fade), a new `vectorCoverageRadius` tile-uniform float added at the `TileUniforms` tail (offset 492, `TILE_UNIFORM_FLOATS` 492→496), `vector-layer-draping.spec.mjs` given a runner home in `test-engine-node` (was orphaned — see the DX row below) and repaired (its fixture had silently baked to zero packed segments post-1.145, so `B1` was passing over an empty tile). **Behavioural (pixel) acceptance — MET, on the second computation.** Job 5 leg 5-3 measured gate B RED (countRatio 1.858) against a served bundle Penlod round 2 and Gundor's review proved was stale (the sync clone's dev server had run in its default non-`--serve-built` mode, which regenerates shader `.js` mirrors without ever writing `Build/CesiumUnminified` — `server.js:151`/`:365` — leaving the bundle carrying the pre-fix `< lineWidth` test; see `DX-47`). **Job 6 (Éowyn, 2026-09-05) re-ran gate B on a bundle the built-shader-identity preflight (landed Batch 1423, `635e6874c9`) first certified current (0 drifted) and the result reverses cleanly:** gate B countRatio **1.000** (15470 vs 15470, band `[0.6, 1.67]`), gate D cross-backend width 21.375/21.375 = **1.000** near and 23.375/22.875 = **1.022** far (job 5's stale-bundle run: 1.858, 1.841, 1.891), and the nadir bbox — the diagnosis's own named discriminator — is **identical on both backends**, `[453,27,576,739]`, a delta of `(0,0)` where the stale run measured `(+16h, +10w)`. Penlod's round-2 prediction was stated as falsifiable and fired in its favour on every number named. Gates A/B/C/D/E all PASS on job 6 leg 6; the run's non-zero exit is gate F alone, reported STRUCTURAL by design (the cross-build baseline instrument gap, unchanged and still owed, tracked separately below). **This item does not re-open: its behavioural acceptance is met on the first computation against a bundle that actually contains Batch 1410; job 5's RED is withdrawn as a product verdict — it was a correct measurement of the wrong bytes.**

  **Remaining items, one per line, owner and acceptance — rewritten to `SYNC_1145_WEBGPU_PARITY_CENSUS_2026-09-05.md` §4 form (2026-09-05, lane Malach; existing numbers kept so prior packets still resolve):**

  2. **Clipping-algorithm divergence between backends.** WebGL now runs upstream's `vectorClip` edge-texture path (`VectorCommon.glsl:328`); WebGPU still runs its own SDF atlas (`WebGPUClippingPolygonCollection.computePolygonSDF` → `PolygonSignedDistance.wgsl`) — a deliberate D1 resolution, not a defect, but Principle 5 territory. **Owner:** Eradan (`REVIEW_ERADAN_cluster-a.md` finding 2), confirmed by Herion (`REVIEW_HERION_cluster-b.md` §c.3). **EXTENDED (census C-06/C-07):** re-priced **OPUS · XL (was unpriced)**; three further-diverging facts now named — holes have no SDF-side support at all (`ClippingPolygon.js:157` adds per-ring hole validation; `ClippingPolygonSdfPack.js:49-60` `outerRingLength` walks the outer ring only), the merged-extent cap silently drops more than 8 groups upstream no longer caps (`GlobeTerrain.wgsl:3830` `min(extentsCount, 8u)`, `:679` `array<vec4<f32>, 8>`), and the model-clip precision law differs (WebGPU reconstructs an absolute f32 world position where 1.145 rewrote the stage onto a camera-relative geodetic delta). **Explicitly blocked on item 7** — the polygon tables item 2 needs did not exist before this census. **Acceptance:** C-07's five-leg capture — holes, inverse, >8 disjoint regions, a far-from-origin model at close range, and seam stability, every leg reporting the same clip on both backends — plus the CP-12 clause that the probe (`probe-globe-clippoly-geodetic.mjs`, `DEBUGGING_GUIDE.md:348`) states which algorithm each backend runs; an inertness mutant on any one of `ModelPBRComplete.wgsl`'s three discard sites turns the model-clip capture red. **Source:** Eradan f2, Herion §c.3; census C-06/C-07.
  3. **Unused WebGL-compat clipping textures on WebGPU (both reviews).** `ClippingPolygonCollection.requestRectangleData` calls `packPolygonTextures` unconditionally, unlike `VectorProvider.requestDataForRectangle`'s explicit backend claim — WebGPU allocates three WebGL `Texture` objects per model per rebake that nothing samples (not a correctness break; freed on rebake/destroy). **Owner:** Eradan (`REVIEW_ERADAN_cluster-a.md` finding 3) and Tar-Anducal (`REVIEW_TAR-ANDUCAL_cluster-c.md` F-1). **EXTENDED (census C-13):** the same unconditional call also fires **per clipped globe tile**, not only per model — `GlobeSurfaceTileProvider.js:841` reaches `ClippingPolygonCollection.js:473-504` inside the shared `endUpdate` loop, so VRAM/upload/CPU cost scales with visible clipped tiles too. **Owner (per-tile half):** SONNET-BOUNDED · S. **Acceptance:** `requestRectangleData` gains the same `packPrimitiveTextures`-style backend branch `VectorProvider` already has, verified for BOTH the model call site and the per-tile globe call site; measured multi-metric (allocation count + GPU memory alongside frame time). **Source:** Eradan f3, Tar-Anducal F-1; census C-13.
  4. **The 4-arg clip detector gap.** `Snapping._nearestSurfaceHit`'s 4-argument border-clip form has no unit-level detector — proved by mutation: making the clip unreachable (`if (false && …)`) leaves all 5 `SnappingSpec` `nearestSurfaceHit` assertions green because they are all 2-arg. **Owner:** Tar-Falassion (`REVIEW_TAR-FALASSION_cluster-d.md` F1). **CONFIRMED unchanged (census).** **Acceptance:** a node-runnable behaviour spec over the 4-arg form (a fragment adjacent to the edge hit beats one adjacent to the cursor; the `|d|=4` kept / `|d|=5` clipped boundary; the `(12,12)` worst case) with an inertness mutant that makes the clip unreachable; runner home `test-scene-node`. **Source:** Tar-Falassion F1.
  5. **The border-clip shortfall.** For a winner at `|offset|` 9-12 (or a caller passing `width < 9`), `surfacePosition` returns `undefined` where upstream returns a `Cartesian3` — bounded, symmetric across backends, documented in-code but untracked. **Owner:** Tar-Falassion (`REVIEW_TAR-FALASSION_cluster-d.md` F2). **CONFIRMED + EXTENDED (census C-12):** the fork's shape is a 4-arg `nearestSurfaceHit` (`Snapping.js:317-341`) with `halfRegion = floor(regionWidth*0.5)` clipping `abs(dx) > halfRegion`, called at `:498-507` over the single readback — the region is the *intersection* with the original 25-px query, so this half is **shared across both backends**. **WebGPU adds its own aperture-narrowing on top:** `WebGPUSnapFramebuffer.ts:678-691,:693-702` shifts hits and drops those outside the current aperture (the effective box up to 2 rows/columns thinner), and `:781` returns `{hits: []}` cold before any offset test runs. **`AR-030`'s stated mechanism and its "0%" figure (`QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md`) are both wrong and are amended separately in that queue** — `MAX_PRIOR_CURSOR_DELTA_PIXELS` bounds successive query *centres*, not a hit's offset, and a stationary hover takes the `_readbackRegionsEqual` early return before any offset test runs. **Acceptance:** this line **is** plan §5.4 D-3's required tracked row; closes on a widened read that removes the shortfall, or an explicit accepted-limitation note. Amend `AR-030`'s mechanism and stale rate, and **run `AR-M30`**; `probe-scene-snap.mjs` grows a leg recording `surfacePosition` defined/undefined on both backends at a model silhouette, the WebGPU leg run twice to separate cold readback from aperture narrowing. Do **not** re-file this row's own subject. **Source:** Tar-Falassion F2; census C-12.
  6. **The `maxTextures -= 3` detector.** Upstream's clipping-polygon day-texture budget move (B7 delta 7, `-2` → `-3`) has no detector anywhere in the fork. **Owner:** Eradan (`REVIEW_ERADAN_cluster-a.md` finding 1). **CONFIRMED unchanged (census) — WebGL-only; `GI-10` corrected to NA.** **Acceptance:** a spec asserting the budget tracks the sampler count. **Source:** Eradan f1.
  7. **`NEW-WEBGPU-VECTOR-POLYGON-DRAPING` re-tier.** 1.145 makes the same polygon tables serve both draping and clipping, so the WGSL `vectorClip` twin cannot land without it. **Owner:** Herion (`REVIEW_HERION_cluster-b.md` §c.1); restated in `LANDING_PACKET_TAR-MINYATUR.md` §10 item 2. **CONFIRMED and PROMOTED (census C-01):** no longer a ledger-text re-tier — this is now the campaign's **top build item**, **OPUS · L**, and the **hard prerequisite of items 2 and 13**. **Acceptance:** painted-fill pixel count and bbox equal on both backends at nadir and oblique, over globe **and** a model surface; the claim path (`VectorPipeline.js:676-679`/`:768-780`) must never return true for a bake it cannot pack — today it does, then `WebGPUVectorTileResources.ts:172-177` drops it (census C-01). The `DEFERRED_WORK.md` `NEW-WEBGPU-VECTOR-POLYGON-DRAPING` entry's tier text is updated in the same landing that builds this item, not by this document. **Source:** Herion §c.1; census C-01/§5 lane L1.
  8. **`probe-vector-draping.mjs` was broken by the merge (Éowyn job 4) — RE-VEHICLED (lane Brodda) AND CONFIRMED WORKING (Éowyn job 6). STAYS OPEN (census, 2026-09-05) — administrative landing still owed.** `scene.globe.vectorProvider.add is not a function`: 1.145 removed `VectorProvider.add`; `Scene.markVectorCollections` replaced it with a per-frame `scene.primitives` walk. Brodda re-vehicled the probe onto `scene.primitives` with a clamping `heightReference`. Job 6 (2026-09-05) re-ran the same probe against a bundle the built-shader-identity preflight certified current: gates A-E all PASS, countRatio 1.000, gate D 1.000/1.022, nadir bbox delta (0,0) — the re-vehicle **works**. **Re-verified against the tracked tree (census, 2026-09-05): the probe is still NOT landed** — Brodda's working copy carries md5 `776dc6f329132e3e46a2286270e66cc1`; the tree's current `Tools/visual-regression/probe-vector-draping.mjs` is `076cff2634087f18f6b4c6209f07c457`, a different file. **Owner / Tier:** SONNET-BOUNDED (land Brodda's probe edit). **Priority:** P1 — blocker for named landed work's **administrative closure only** (Batch 1410's behavioural acceptance is already MET by measurement). **Acceptance — MET at the behavioural level, OPEN at the landing level:** gate B computed and passed at 1.000 against a preflight-clean bundle (job 6 leg 6); the row does not close until the md5s match. **Source:** Herion/Brodda; census §4 item 8.
  9. **Cluster (c)'s end-to-end Karma specs have never been executed.** `Cesium3DTilesetSpec.js:4620` ("marks loaded tiles dirty when clipping polygons are added or removed"), the four `ModelSpec` `getRectangle` tests (`:1815-1848`), and the two detach tests pinning the `-04`/`-03` `setOwner` deviation are all Karma specs, not node — Éowyn's `-06` leg 5 ran job-3's six pre-existing-red suites (TerrainFillMesh, QuadtreePrimitive, Renderer/Pass, Scene/Pick, ResourceCacheKey, BillboardCollection), none of which is this cluster. So the `setOwner` release path and the clipping-polygon rebake broadcast still rest on reading, not execution. **Owner:** Tar-Anducal (`REVIEW_TAR-ANDUCAL_cluster-c.md` F-2). **CONFIRMED unchanged (census).** **Tier:** OPUS-EDGE-EXECUTOR (a Karma/Edge run, `CHROME_BIN` pointed at Edge). **Acceptance:** the three named specs execute and pass under `npx gulp test --webgpu --browsers=EdgeHeadlessCI` with `--includeName` matching them; bank the receipt as an Éowyn leg alongside `-06`'s existing legs (this is the natural home for the run itself; the row lives here so `-07`'s reader does not lose it). **Source:** Tar-Anducal F-2.
  10. **Two spec gaps in `GlobeSurfaceTileProviderSpec.js`.** The file is 1,681 lines with zero `webgpu`/`updateForPick`/`scene.pick`/`drillPick`/`pickPosition`/`pickFramebuffer` occurrences — the plan's one `UNDETERMINED` census row closes negative on both halves (not broken by the merge, but not covered by name either). **Owner:** Eradan (`REVIEW_ERADAN_cluster-a.md` finding 5). **CONFIRMED (census) — `GI-13`/`GI-15` establish that the inverse-clip tile skip and the pooled-pick decision are both present and reachable, so the specs below assert live behaviour, not a no-op.** **Tier:** SONNET-BOUNDED (spec authoring against existing fixtures). **Acceptance:** a pick-path behaviour spec for `updateForPick` (asserting the WebGL/WebGPU pick command actually gets pushed, per `-01`'s `OURS`-resolution reasoning) and a spec asserting an inverse-clipped tile emits no draw command, both with an inertness mutant (`if (false && …)` on the clip/pick guard) that requires the new assertions to fail. **Source:** Eradan finding 5; census confirms via GI-13/GI-15.
  11. **Stale provenance comments naming a deleted GLSL file.** `WebGPUClippingPolygonCollection.ts:17`, `:246` and `PolygonSignedDistance.wgsl:4`, `:12` still cite `PolygonSignedDistanceFS.glsl`, which 1.145 deletes (D1). **Owner:** Herion (`REVIEW_HERION_cluster-b.md`, non-blocking finding 3). **EXTENDED (census C-18):** the four-site grep undercounts — widen it to `czm_clipPolygons\|clipPolygons.glsl\|unpackClippingExtents\|PolygonSignedDistanceFS` over `Renderer/WebGPU` + `Shaders/WebGPU`; live citations of the deleted GLSL also survive at `GlobeTerrain.wgsl:1651,:3587-3591,:3851,:3880,:4545` and `WebGPUEffectsBindGroup.js:180,:187`, and two orphan WGSL chunks (`chunks/functions/csm_clipByPolygons.wgsl`, a knowingly-wrong 76-line stub, and `csm_unpackClippingExtents.wgsl`, 7 lines) have zero callers and are the named "twin" of a deleted builtin nothing references. **Tier:** SONNET-BOUNDED. **Acceptance:** every widened-grep hit cites a live file or says plainly the GLSL original is gone; the two orphan chunks get one dated disposition (a caller, or a removal date tied to item 2). **Source:** Herion finding 3; census C-18.
  12. **Packet §10 "Also opened", three related items, not yet tracked anywhere.** **Owner:** `LANDING_PACKET_TAR-MINYATUR.md` §10. **CONFIRMED unchanged (census).** **Tier:** SONNET-BOUNDED for (a)/(b), OPUS-EDGE-EXECUTOR for (c). **Acceptance**, one per sub-item: (a) retire WebGL clipping buckets A/B only once item 2's `vectorClip` WGSL twin ships — a dated decision, not an accident; closes when that item's landing packet says so explicitly, not implicitly by omission; (b) the `clipping-performance-dev` Sandcastle demo now trips the `debugShowDistanceTexture` deprecation warning (D2) — closes when the demo is updated to use the non-deprecated accessor or the warning is accepted and documented in the demo's own comment; (c) a two-renderer (WebGL/WebGPU) capture for Gaussian-splat classification depth, to confirm the merge did not disturb the shared depth target cluster (c) and cluster (a) both touch — closes on a `capture-and-diff` run with a named splat-classification scene added to `scenes.json` if one does not already exist.

  13. **`NEW-WEBGPU-MODEL-VECTOR-LOOKUP` — the WGSL twin of the new model vector-lookup stage.** `ModelSceneGraph.js` registers `ModelVectorLookupPipelineStage` on the GLSL path when `model.hasDrapedVectors()`; WebGPU has no equivalent stage. Named as a "deferred row" in `UPSTREAM_SYNC_PLAN_1.145_2026-09-04.md:691`/`:711`, but no filed row existed until Tar-Minyatur's packet §10 item 3 opened this card entry. **Owner:** unassigned. **CONFIRMED + EXTENDED (census C-02/C-05/C-14) into three named legs, not one:** (a) the stage and its composite point — no `HAS_VECTOR_LOOKUP`/`VectorLookup` anywhere under `Shaders/WebGPU`+`Renderer/WebGPU`, `Model.js:2716-2754 updateVectorLookup` runs on both backends with no WebGPU consumer, and the composite must sit after both clip tests and before atmosphere/silhouette/edges (C-02); (b) the model pick override — no fragment-level pick-override mechanism on models at all (`PickingPipelineStage.js:97-98` wraps the GLSL model pickId with nothing on the WebGPU side, C-05); (c) the model-side bake that today realizes a globe-keyed storage buffer with no consumer, wasting memory and paying draw-command rebuilds on every drape-state change (`Model.js:424-426,:834,:1057-1058,:2695-2754`, C-14). **Tier:** OPUS-JUDGMENT (shader, parity) · **L, with an XS bind-group capacity preflight first. Depends on items 14 and 7** (the camera-uniform delta builtin and the polygon tables). **Acceptance:** drape present on WebGPU over a tileset with painted-pixel parity, composite ordering verified against clip/silhouette/edges/atmosphere; the model pick override returns the primitive on both backends; zero globe-vector buffers created for content models with no consumer (or the (a) consumer reads them). **Source:** Tar-Anducal producer/consumer table (`-03` review); Tar-Minyatur packet §10 item 3; census C-02/C-05/C-14.
  14. **`czm_eyeCartographic`/`czm_eyeToEnu`/`eyeToCartographicDelta` in WGSL.** The JS-level `UniformState` getters landed inside `-00`/`-04` and are verified numerically, but the WGSL `CameraUniforms` struct itself is untouched by this merge (Tar-Falassion (c)4: zero `struct CameraUniforms` declarations touched anywhere in the repo) — `FEATURE_INVENTORY.md`/`DEFERRED_WORK.md` carry zero occurrences of `eyeCartographic` or `eyeToCartographicDelta`, so no WGSL consumer exists and nothing files the gap today. The new members go ahead of `previousViewProjection`, never after (CLAUDE.md pins that field's position). **Owner:** unassigned. **EXTENDED with three corrections (census C-20/C-21/C-22):** (a) the builtin needs a **third** uniform beyond the two originally scoped — `czm_eyeEllipsoidCurvature` (pre-existing upstream), consumed alongside `czm_eyeToCartographicDelta` by `ModelClippingPolygonsStageVS.glsl:18` and `ModelVectorLookupStageVS.glsl:13`; (b) `WebGPUAutoUniforms.js` carries `csm_eyeHeight` (`:332`) but **has zero importers outside itself**, so a registry entry there alone would be inert — the acceptance must name a **live** UB packer instead; (c) `mat3x3<f32>` is 3 × vec4 in WGSL, not 9 tight floats like GLSL `mat3` — a packing hazard for `czm_eyeToEnu`, proven by a mutation that packs it tightly and must go red. **Tier:** OPUS-JUDGMENT (shader, parity) · M. **Acceptance:** the WGSL `CameraUniforms` carries the ENU basis and cartographic eye, written by a **live** UB packer and read by at least one consuming WGSL shader; numeric equivalence with `UniformState.eyeCartographic`/`.eyeToEnu` (`_eyeCartographic.z === _eyeHeight` exactly; orthonormal to 8.9e-16 with det 1); `previousViewProjection` stays at the `CameraUniforms` tail. **Source:** Tar-Minyatur packet §10 item 4; census C-20/C-21/C-22.
  15. **WGSL model vertical-exaggeration stage.** `VerticalExaggerationStageVS.glsl` renames `vertexNormal` → `vertexEllipsoidNormalEC` and stops normalizing the model-space direction (a correctness fix upstream). No `FEATURE_INVENTORY.md` entry names a WGSL vertical-exaggeration stage, so this was unscoped, not merely unfinished. **Owner:** unassigned. **CONFIRMED and priced (census C-08):** the stage is missing **wholesale** on WebGPU — `grep exaggerat Shaders/WebGPU/Model/*.wgsl` = 0 hits (re-verified) — so the upstream fix has nothing to apply to; the globe's own WGSL exaggeration exists and is unaffected. **Tier:** OPUS-JUDGMENT (shader, parity) · **M, not XS** — the scoping-pass estimate undersized it; user-visible at any `scene.verticalExaggeration ≠ 1` (glTF models and tileset content rise with terrain on WebGL, stay pinned on WebGPU). **Acceptance:** at 1.0, byte-identical to today on both backends; at 2.0, a model keeps the same contact with exaggerated terrain on both (silhouette/contact capture) — this scoping note is itself the `FEATURE_INVENTORY.md` §C row this item's acceptance requires. **Source:** Tar-Minyatur packet §10 item 6; census C-08.

  **New 16-24 — each carries a user-visible effect no existing item covers, all sourced from `SYNC_1145_WEBGPU_PARITY_CENSUS_2026-09-05.md` §4 (banked 2026-09-05):**

  16. **Metres-width branch, draped path.** `VectorCommon.glsl` adds `u_vectorMetersPerUv`, `metersFromUv`, `pixelsPerMeter` and the three-way MIXED/METERS/pixels branch; `GlobeTerrain.wgsl:4180-4188`'s own comment states only the pixel branch exists — a `widthUnits:'meters'` draped collection keeps constant ground width on WebGL and constant pixel width on WebGPU, orders of magnitude off at most altitudes. **Owner:** unassigned. **Tier:** OPUS-JUDGMENT · M. **Acceptance:** stroke width in px changes with altitude by the same ratio on both backends across ≥3 octaves; a mixed collection shows both families correct in one frame. **Source:** census C-03; promotes `FEATURE_INVENTORY.md:1013`'s existing sentence to a row with its own acceptance.
  17. **Mixed-units branch.** One tile carrying both `METERS`- and pixel-unit primitives must draw both correctly in the same bake. **Owner:** unassigned. **Tier:** SONNET-BOUNDED · S. **Depends on item 16. Acceptance:** one tile carrying both unit kinds draws both correctly. **Source:** census C-03 (`G145-06`).
  18. **`BufferPolylineCollection.widthUnits` on WebGPU (non-draped) — untracked anywhere today.** `BufferPolylineCollection.js:81-114`'s new `widthUnits` option writes a SIGNED width (`renderBufferPolylineCollection.js:174,205-206,313`) and `BufferPolylineMaterialVS.glsl` decodes the sign as the metres/pixels switch; `grep widthUnits Renderer/WebGPU Shaders/WebGPU` = 0 (re-verified), `WebGPUBufferPolylineRenderer.ts:444` → `:566` writes the width unsigned, and `BufferPolylineMaterial.wgsl:70` has no sign test — the `csm_metersPerPixel` builtin the decode needs already exists (`chunks/functions/csm_metersPerPixel.wgsl:8`). A 50 m unclamped polyline is a 50 m ribbon on WebGL and a fixed 50 px line on WebGPU. **Owner:** unassigned. **Tier:** OPUS-JUDGMENT · S — **must land as one pair** (packer sign + WGSL branch); signing the attribute alone inverts every miter. **Acceptance:** one metres and one pixels collection at two camera distances one octave apart — the metres stroke halves on both backends, the pixels stroke does not. **Source:** census C-04; this is a **different code path** from item 16/`FEATURE_INVENTORY.md:1013`'s draped-path sentence and gets its own §C sentence (see the `FEATURE_INVENTORY.md` entry).
  19. **Draped-vector pick twin.** `VectorCommon.glsl` adds `vectorPickPrimitiveIndex`/`u_vectorPickColorTexture`/`vectorPickColorOver(vec4)`; `GlobeTerrain.wgsl:3963-3970 fragmentPickMain` writes `camera.pickColor` unconditionally and `WebGPUVectorTileResources.ts:29-37`'s primitives run is 2 words (f32 width, u32 RGBA8) with no pick slot. `scene.pick` over a draped line/area returns the primitive on WebGL and the globe (or nothing) on WebGPU. **Owner:** unassigned. **Tier:** OPUS-JUDGMENT · M. **Acceptance:** a draped primitive with a known pick id is returned by `scene.pick` on both backends, and a pick one stroke-width away returns the globe on both; a layout mutation (shift the pick run by one primitive) turns the layout spec red. **Source:** census C-05; promotes `FEATURE_INVENTORY.md:1013`'s one clause — the real work is a stride change (2→3 words), a WGSL composite and a per-tile pick opt-in.
  20. **`pickTranslucentDepth` on WebGPU.** All three new snapping demos set `scene.pickTranslucentDepth = true`; `Picking.js:666-671` calls `renderTranslucentDepthForPick` with no backend test, but `PickDepthFramebuffer.js` is a WebGL-only `FramebufferManager` — the flag costs a full extra pick mini-frame per `pickPosition` on WebGPU and (unmeasured claim) influences nothing. **Owner:** unassigned. **Tier:** OPUS-JUDGMENT · M, **with an XS measurement first — brief the measurement, not the fix; the inert half is unverified.** **Acceptance:** (a) a probe clicking a translucent surface returns a position on it on both backends; (b) before the fix, one measurement confirming the inert half. **Source:** census C-10 (`SNAP-16`).
  21. **1.145 snapping demos vs the async readback contract.** Three new gallery demos (`aec-snapping`, `hybrid-snapping-dev`, `ion-snapping-dev`) drive `scene.snap`/`pickPosition`/`pick` synchronously; `WebGPUSnapFramebuffer.ts:744-781` returns `{hits: []}` on a cold or non-overlapping query and none of the demos guards a first call — on WebGPU the hover dot needs a second or third mouse-move and the first click can commit nothing. The underlying async-readback contract is already tracked (`FEATURE_INVENTORY.md:1057 UP144-SNAP-WEBGPU`; Q-141/DM-11); **the demos are not.** **Owner:** unassigned. **Tier:** OPUS-JUDGMENT · S. **Acceptance:** a recorded disposition, then a sweep leg — each demo's first interaction on WebGPU either succeeds or is documented as requiring a settled camera, not discovered later by the Sandcastle2 sweep. **Source:** census C-11 (`SNAP-15`).
  22. **`GlobeSurfaceTileProvider.destroy()` releases the clipping feature renderer.** 1.145 deprecates `ClippingPolygonCollection.destroy`; at HEAD `GlobeSurfaceTileProvider.js:1391-1396` drops the reference (`this._clippingPolygons = undefined;`) instead of calling `releaseFeatureRendererResources` (`ClippingPolygonCollection.js:742-756`, which the setOwner and deprecated-destroy paths already call, CP-07 PRESENT) — destroying globes/viewers against a surviving device accumulates the SDF atlas plus positions/extents textures. **Owner:** unassigned. **Tier:** SONNET-BOUNDED · XS. **Acceptance:** `GlobeSurfaceTileProvider.destroy()` routes through `setOwner(undefined, this, "_clippingPolygons")`; a spec asserts the feature-renderer cache is empty after globe teardown with the context still alive. **Source:** census C-15 (`GI-19`, `G145-21`).
  23. **`BufferPrimitiveCollection.destroy()` releases its feature renderer.** Unlike `BufferPolygonCollection.js:556-566`, `BufferPrimitiveCollection.js:373-388` destroys `_renderContext` (WebGL) and pick ids only, with no feature-renderer release — each destroyed collection retains its WebGPU buffers (~11 per polyline collection) until context loss. The class is tracked as `ARCH-4` (`ARCHITECTURE_REVIEW_2026-09-02.md:537`); these collections are not. **Owner:** unassigned. **Tier:** SONNET-BOUNDED · S. **Acceptance:** `destroy()` resolves the collection's feature renderer and calls its `destroy` slot before the WebGL teardown; a spec asserts buffer count returns to baseline after grow-then-destroy. **Source:** census C-16 (`G7-17`); class `ARCH-4`.
  24. **Clipping rebake staleness on WebGPU.** `ClippingPolygonCollection.js:386-397` clears `_dirty` **inside** `update`, then calls the feature renderer at `:399-402` with no dirty signal, so WebGPU still detects change by counting — an equal-count edit (remove one polygon, add another with the same vertex count) re-clips on WebGL and keeps clipping against the removed polygon on WebGPU. `ARCHITECTURE_REVIEW_2026-09-02.md:789` (`H-P11`) says "do not re-file" **on the pre-merge premise, now stale — this item supersedes that instruction.** **Owner:** unassigned. **Tier:** SONNET-BOUNDED · S. **Acceptance:** the CLIPPING_POLYGONS feature renderer rebakes exactly when contents changed (a monotonic revision, or read the dirty state before `update` clears it); a spec drives an equal-count swap and asserts a rebake. **Source:** census C-17 (`CP-03`).

  **Genuinely tracked in `FEATURE_INVENTORY.md` §C `UP144-VECTOR-LAYER-WGSL`, not restated here (confirmed by reading the entry, not assumed):** the meters-width branch (`VECTOR_WIDTH_IN_METERS`/`VECTOR_WIDTH_MIXED_UNITS` have no WGSL twin — a negative metres width is safely absorbed by `abs()` and drawn in pixels, Penlod/Gundor); the `vectorPickPrimitiveIndex` pick twin (draped polylines are not pickable on WebGPU, Penlod/Gundor); and gate F's cross-build baseline (pre-existing, unchanged, still owed — the entry's own words, "Only the non-regression gate (F) is still owed"). Items 13-15 above are **not** covered by that entry — it is specific to vector-polyline draping, not model vector lookup, camera uniforms, or vertical exaggeration — and are opened here instead, per `REVIEW_LORGAN.md`'s verification-boundary flag (its item 3: "worth one grep before landing").
- **Tier / Size / Backends:** OPUS-JUDGMENT (shader, parity) · M · WebGPU, except item 3's per-tile half (SONNET-BOUNDED · S), item 8 (SONNET-BOUNDED / P1), item 9 (OPUS-EDGE-EXECUTOR), item 10 (SONNET-BOUNDED), item 11 (SONNET-BOUNDED), item 12(c) (OPUS-EDGE-EXECUTOR) and item 15 (**OPUS-JUDGMENT · M, priced by the census — no longer unpriced**), each its own dispatch per the tier stated in the item; **items 16-24 (census-added) each carry their own stated tier and size in the item text**, spanning OPUS-JUDGMENT and SONNET-BOUNDED. **Depends on:** `-00` landed (Batch 1408). **Ruling touched:** none. **Gate:** none.
- **Acceptance:** item 1 **CLOSED** (node-spec acceptance MET; Edge gate B acceptance MET on Éowyn job 6's re-run against a bundle `DX-47`'s built-shader-identity check certified current — countRatio 1.000, gate D 1.000/1.022, nadir bbox delta (0,0); job 5's 1.858 RED was a correct measurement of a stale bundle, withdrawn as a product verdict); items 2-24 each carry their own acceptance above; the WGSL `CameraUniforms` eventually carries the ENU basis and cartographic eye **with `previousViewProjection` still at the tail of the struct** (CLAUDE.md pins that field's position, item 14); `FEATURE_INVENTORY.md` kept current as each sub-item closes rather than the inventory going stale, and gains exactly the two §C entries the census rules (`SYNC_1145_WEBGPU_PARITY_CENSUS_2026-09-05.md` §4 "Belongs elsewhere"): the `UP144-VECTOR-LAYER-WGSL` sentence item 18 needs, and the new WGSL model vertical-exaggeration row item 15 needs. Items 13 and 14 are carried on this card and are NOT restated in §C — the plan's earlier "rows items 13-15" expectation is superseded by the census.
- **Binds:** SR-1, SR-7, SR-13. **Source:** plan §5.4, §5.3; `LANDING_PACKET_TAR-MINYATUR.md` §10; the four cluster reviews; `LANDING_PACKET_PENLOD.md` + `REVIEW_GUNDOR.md`; Éowyn job 4 `SUMMARY.md` leg 2; `REVIEW_LORGAN.md` R3 (items 9-12).

### `UPSTREAM-SYNC-1.145-08` — the ES6-shape guard

- **Disposition:** LANDED, Batch 1408. The assertion that no file which was an ES6 class at the pre-merge tip is prototype-based afterwards. One check, and it caught the entire silent-reversion class the plan identified as this sync's dominant conflict mechanism (45% of hunks, independently re-derived by Eradan matching the plan's 46% prediction). `Tools/upstream-shape-guard.mjs` auto-bases on `HEAD^1` with no merge in progress. Confirmed independently by **all four** station-3 cluster reviews, each re-running it over its own cluster's files plus the whole 49-file in-scope set, all exit 0.
- **Tier / Size / Backends:** SONNET-BOUNDED · S · tooling. **Depends on:** `-00` landed. **Ruling touched:** none. **Gate:** none — has a runner home.
- **Acceptance — MET:** the guard fails on a fixture where a class file is replaced by its prototype-based ancestor and passes on the real post-merge tree (`node --test` on `Tools/upstream-shape-guard.spec.mjs`: 11/11); wired into `npm run verify-es6-shape` and re-confirmed by all four cluster reviews plus `LANDING_PACKET_TAR-MINYATUR.md` §8 (G3, G4).
- **Binds:** SR-12. **Source:** plan §3.3; `LANDING_PACKET_TAR-MINYATUR.md` §8; the four cluster reviews.

---

## 7. CLOSED-NEGATIVE — recorded so they are not re-opened

Each carries the reason and the basis. **None of these is an open row.**

| ID | Item | Closed because | Basis / verification |
|---|---|---|---|
| `DM-N1` | **Meshlets for the AEC demo** | Meshlets attack per-draw cull granularity and draw-call count; **neither is what is failing** there. WebGPU never gets the content resident or the frame loop running, and a meshlet path would *add* load-time clusterization to the phase that is already losing. **This closes meshlets for that demo, not the track** — the track is §6, and `MS-09` is the row that measures exactly this objection. | `DEFERRED_WORK.md:4622`; rulings M1–M6; Cirdan §4. Seed and prereq (c) re-read 2026-08-29. **The load-bearing reason is Cirdan's C-8(a) corrected form, not the report's:** *“nothing is geometry-bound yet on WebGPU because the content never becomes resident”* — the report's “the frame is not geometry-bound” is **retracted** (§11) |
| `DM-N2` | `ambientOcclusion.uniforms.directionCount = 8` | **No-op.** `AmbientOcclusionGenerate.wgsl:178` already clamps to 8, and the config is latched at first enable anyway. The 1.6 ms "win" is leg-to-leg drift; on WebGL, where the write *is* live, the same change went the **wrong** way | clamp verified `:178`; latch verified `:700`/`:740` |
| `DM-N3` | `stepCount = 16` + `directionCount = 4` | **Doubly inert.** `stepCount` is read from `stepSize` and is therefore already 4, so 16 would be a step *up*. Would become a real visual degrade once `Q-142` lands | bridge verified at `WebGPUPostProcessStageCollection.ts:720` |
| `DM-N4` | `scene.gpuCullingHint = "auto"` | **Structurally dead** for this scene shape at any load — not below-threshold. The gate's input is the OPAQUE bin, which is ~0 because all content is `Pass.CESIUM_3D_TILE` | `WebGPUSceneRenderer.ts:2293`; `Pass.js:23`/`:26`; `Model3DTileContent.js:494`; grep = 0 |
| `DM-N5` | `scene.msaaSamples = 1` | **Live at runtime**, so its null result is a **real** measurement: no p50 gain on either backend, p95 worse on both, and it aliases building edges. A visual degrade for a measured non-win — SR-1 | per-frame re-read verified `WebGPUSceneRenderer.ts:1465-1476` |
| `DM-N6` | `ambientOcclusion.enabled = false` | The only AO lever that reaches the WebGPU shader at runtime — which is why "~10 ms is available from AO" is available *only by removing the demo's point*. It also cannot touch either bottleneck: AO does not run during picks | `:742` `setStageEnabled`; `FramebufferOrchestrator.js:139-141` (`usePostProcess = !picking && …`) |
| `DM-N7` | `tileset.skipLevelOfDetail = true` | **DO NOT FLIP on WebGPU** — re-tagged from "untested" to corruption hazard. Becomes a real lever only after `Q-144` | see `Q-144`, all four premises verified plus the MDN stencil defaults |
| `DM-N8` | `scene.pickAsync` as a **perf** lever | Correct to exclude as a perf lever — the same `pickBegin` runs. But it is a **partial remedy for `Q-141`'s readback half**, and a demo code change needing a highlight-race guard. Keep the correctness point inside `Q-141`; keep the flag out | engine warning verified `WebGPUPickFramebuffer.ts:1282-1300` |
| `DM-N9` | Layer toggles / `preloadWhenHidden` | **Already optimal.** `Cesium3DTileset.js:1449` gates the whole traversal on `show`, and `preloadWhenHidden` defaults `false` (`:471`) | both citations verified; the demo hides `Structural` at `main.js:69` |
| `DM-N10` | `tileset.cacheBytes` | **Ruled out by arithmetic:** the default is 512 MB **per tileset** while WebGPU holds ~168 MB of tile content in total, so the limit is nowhere near binding and trimming it cannot touch the 2.57 GB heap | default verified `Cesium3DTileset.js:252` |
| `DM-N11` | Hi-Z for this scene | Right conclusion, **wrong reason**: not "1360 commands is short of the 2400 threshold" but "**the OPAQUE bin is ~0**". The 1360 was `commandList.length` summed over all passes. Fix the comparison wherever it is quoted | `probe-aec-perf2.mjs:95`; bin chain as `DM-N4` |
| `EAN-X1` | "Diagnose why the sprites do not arrive" as its own M-sized lane | **CLOSED-NEGATIVE — DO NOT DISPATCH.** The premise is refuted twice: at view (1), where the crush is inert, the capture carries 10 (WebGPU) / 31 (WebGL) point-like maxima with cores to luma 27–29, and D4 vs D3 moves the brightest peak up. **The sprites arrive; the deficit is depth, not delivery.** A worker briefed on it would hunt a delivery bug that does not exist, and the spec would certify the brief | residue: phase collapse → `EAN-05`; faint-end depth → `EAN-07` |
| `EAN-X2` | Revert `SkyBox.defaultVariant` to upstream's `TYCHO_T3` | **Superseded by `Q-150`'s re-target.** You cannot look better than upstream by shipping upstream's asset, and the fork's own gate says T3 fails three bars at HEAD | the one axis where T3 wins (dust-lane IQR) is an argument for a **better bake**, attached to **M-06**'s sitting |
| `EAN-X3` | Ocean sun-glitter as scoped in the audit | **HAND OFF, DO NOT DISPATCH.** It would reverse `C11-163`'s standing opt-in/default-OFF term on an epic armed 2026-08-28 as lane CW, and its target frame is a **day** case (view (5)'s sun is +3.63° up) | handed to lane CW as an **S0 day-sun-glint input** |
| `EAN-X4` | Airglow and zodiacal light as a fresh idea | **Already ratified and placed.** Airglow **is** `C12-26`, ruled OUT of the C12 exit gate and deferred to proposed C17; the zodiacal half has its own deferred owner with an unbudgeted provenance review. Executing it now would also lift the very floor every star acceptance bar is measured against | airglow folds into `EAN-09`, where `NIGHT_ZENITH_MAGNITUDE = 21.9` already **is** that floor |
| `EAN-X5` | Twilight glare shaping **now** | **Sequencing, not merit.** Physically sound and genuinely upstream-beating — the law already ships as `solarGlareVeil` — but it edits the `C12-31` aureole whose full acceptance sweep is owed on the C12 machine lane, and C12 completion is the remaining bar for the C14 launch | cheap first step meanwhile, **no code and no browser**: extract the radial luminance profile from the banked capture and fit it. Re-propose after the sweep |
| `EAN-X6` | "No stars at views (5)/(7)" **as a defect** | Acting on it would be a regression dressed as a fix: the sun is +3.63° up and `starFieldEffectiveIntensityScale = 0.0000` on both backends — ruling **E3**'s derived day anchor. A sunset sky has no stars; upstream shows them only because it models nothing | the *option* to add a demo-facing floor is `EAN-12`, HELD on **M-10**. The defect claim is closed; the law question is not |

### 7.1 Cross-references — existing rows this queue leans on, and does **not** re-file

These are **not new rows**. Each already has an owner; the column on the right is the part a brief written from this queue would otherwise get wrong.

| Row | Where it lives | What must not be got wrong |
|---|---|---|
| `Q-62` | ledger `:115` (Celeborn refuter L7 / correction C-6, **PLAUSIBLE**) | **Scope correction.** The fork's shell-permissiveness advantage over upstream exists **only at `globe.enableLighting = false`** (enum NONE); at **ON** the enum resolves to SCENE_LIGHT and the two laws are **identical**. **No leg may compare fork-vs-upstream shell permissiveness without stating `globe.enableLighting`** — which is why `Q-148` acceptance (c) requires it per leg, and why that requirement is not bookkeeping. |
| `Q-101` | ledger | the legacy `tilesLoaded` gate reports true **optimistically** on WebGPU — the reason `Q-143` and `DM-01` gate on `Scene.renderReady` instead. |
| `C12-36` | `QUEUE_2026-07-19_CAMPAIGN12.md:2503`, `:2506` | the landed log-luminance estimator. Its **star-pixel leg is still OWED and the row is incomplete**; `Q-148`'s scorer must be authored so that leg can consume it unchanged, and `Q-148` must **not** re-derive the estimator. Nothing here discharges `C12-36`. |
| `C12-38` | `QUEUE_2026-07-19_CAMPAIGN12.md:2504` | the owner of views (5)/(7): **landed, acceptance evidence OWED** — a 13-sample dawn sweep with **sample 7** as the pre-registered discriminator, already queued for the Edge seat (§9 item 1). `EAN-12` and `EAN-X3` defer to it for the disc itself. The unlanded option-(B) `solarDiscTransmittanceSplit` lives only in the KEPT `cesium-worker-sundisc` clone. |
| `Q-123` / `NIGHTFADE-D1` | ledger `:285`/`:278` and `:458`/`:498` | both pending the **same** maintainer eyeball as **M-06…M-10**. If the answer caps emission, `EAN-02`'s 24,000 km opening frame and its thumbnail both move. |
| `C12-12` | the policy seam named in **M-06**'s attach block | the route by which a 4096 tier could ship as an **external asset** instead of a 19.5 MB in-repo bump. |
| `C18-S0` | `QUEUE_2026-08-09_CAMPAIGN18.md:273` | **DONE 2026-08-09**, 20 projects vetted. `MS-03` inherits its UNKNOWN-blocks-derivation rule; it does not re-run it. |

---

## 8. MAINTAINER DECISIONS — every gate in one place

Twenty-nine numbered decisions (24 from the original set plus `M-26`/`M-27`, added 2026-09-04 from the
1.145 sync's station-3 reviews, plus `M-28`/`M-29`/`M-30`, added 2026-09-05 by lane Hunleth's doc pass —
`M-28`/`M-29` are records, not asks; `M-30` is the one live ask this round adds). **`M-15` is deliberately unassigned** so that `M-16`…`M-25` map
one-to-one onto the meshlet track's original gate ids `G-A`…`G-J`. Questions marked *verbatim* are
reproduced word for word in the row that owns them; this table states the ask and the rows it
unblocks.

| # | Original id | The ask | Unblocks | This document's recommendation |
|---|---|---|---|---|
| **M-01** | D1 gate `DM-02` | `requestRenderMode` breaks the demo's hover highlight (`BatchTexture.js` has zero `requestRender()` calls). Restoring it needs a demo code change, outside the flag-only envelope. **Authorize the code change, or drop the flag?** | `DM-02` ship decision | measure first; decide on the trace |
| **M-02** | D1 gate `DM-03` | SSE 24 trades model detail for frame time on a demo built to inspect building geometry. Reading the side-by-side captures: **acceptable as the demo default, or does the flag stay off and the row close?** | `DM-03` ship; `DM-04`/`DM-06` inherit the wording | none — it is an eyeball call |
| **M-03** | D1 gate `Q-142` | Correcting the AO bridge makes WebGPU AO strictly more expensive (32 → 512 samples/px at the demo's settings; 32 → 256 at engine defaults) and changes default AO output for every WebGPU scene. **Land it as a correctness fix and accept the regression, or land it behind a default-off define?** | `Q-142` landing form; `DM-08` follows | land the correctness fix; disclose the cost |
| **M-04** | D1 gate `DM-09` | An L-sized root-cause hunt on a mechanism two code readings already got wrong. **Fund it once `Q-143`'s profile names a consumer, or hold it inside `C11-168`'s W1 lane?** | `DM-09` | fund out of the profile |
| **M-05** | D1 gate `DM-11` | **Confirm the close-on-small-share rule:** if `DM-07` shows pick-pipeline builds are a small share of the surviving pick cost, close `DM-11` as hygiene rather than funding an async restructure | `DM-11` | confirm |
| **M-06** | D2 **Q1** (DR-01) | *verbatim in `Q-150`, with its ripeness preamble* (`QUEUE_2026-07-19_CAMPAIGN12.md:59` — the revisit is now “a clean single-variable question; DR-01 is NOT decided until then” — and `:22`, the tranche-3d run that met the condition). (A) keep DR-01 and fund the catalogue; (B) reverse it by flipping the default to un-blurred `TYCHO_T5`; (C) keep the engine default and expose the variant per scene. **Attach:** the **4096 tier with its three options** — land opt-in at 19.5 MB / external asset via the **`C12-12`** policy seam / drop — G3's chroma and dust arms, and the 263-vs-2,868 figure correction | `Q-150`; **gates `EAN-07`, which *is* option (A)'s content — answering (B) closes it**; shapes `EAN-11`, `EAN-02` | none — this is the maintainer's picture to choose |
| **M-07** | D2 **Q2** | *verbatim in `EAN-08`.* (i) graded law alone; (ii) graded law **plus** the additive dome; (iii) modulation defaulted off for a demo-facing sky | `EAN-08`, `EAN-09`, `EAN-10` | (ii) — the dome is what makes the physics legible |
| **M-08** | D2 **Q3** | *verbatim in `EAN-13`.* Moonless instant (shows the fork's full sky) or moonlit (shows the physics)? | `EAN-13`; then `EAN-02` | record the answer in the demo comment either way |
| **M-09** | D2 **Q4** | *verbatim in `EAN-08`.* Do C4 and C5 go into C12's star lane now, or queue against a C17 launch decision alongside `CLT-D10` and `C12-26`? | `EAN-08`, `EAN-09`, `EAN-10` | C12's star lane, since C17 is unlaunched |
| **M-10** | D2 **Q5** | *verbatim in `EAN-12`.* Keep the published NELM law, or add a demo-facing twilight floor? | `EAN-12` | demo-scoped floor if any; do not move the engine law |
| **M-11** | D1 gate `Q-144` | `skipLevelOfDetail` is a documented public option that silently corrupts on WebGPU. **Implement the stencil test (M–L), or warn once and document the flag as WebGL-only until it lands?** | `Q-144`; unblocks `MS-13`'s key check | warn now, implement when scheduled |
| **M-12** | D1 gate `DM-13` | A real capability gap with no measured payoff anywhere. **File against FORK-41 / `C11-98` unscheduled, or name a scene shape to measure it on?** | `DM-13` | file unscheduled |
| **M-13** | D1 gate `DM-14` | Backend-neutral, affects WebGL, outside the WebGPU-only scope. **Leave filed unfunded, or open as a cross-backend row?** If funded, the narrower shape is "skip content update for tiles already updated this frame" | `DM-14` | leave filed |
| **M-14** | D1 `Q-143` note | Should `Q-143` also **discharge** the `C11-168` launch gate? That requires the canonical moving-altitude campaign added as a second lane — scope beyond this demo | whether `MS-10`…`MS-15` unblock on `Q-143` alone | run `Q-143` as scoped; decide the second lane after reading it |
| **M-15** | — | *reserved, deliberately unassigned* | — | — |
| **M-16** | D3 **G-A** | Campaign placement: (a) a wave inside the Phase-8b program with the `MS-` prefix (what **M2** already ratified); (b) **Campaign 19**, next free number after C18; (c) a wave inside C18 — argued against by C18's own ownership table | the whole meshlet track's identity | **(a)** — `D3`'s G-A verdict verbatim: *“it is what M2 already ratified; (b) only if the maintainer wants a launched campaign identity”*. This document is written against (a); (b) needs only a retitle. Not (c) |
| **M-17** | D3 **G-B** | *verbatim in `MS-02`.* (a) no scaffold; (b) documentation-only scaffold; (c) code scaffold with a permanent registry entry | `MS-02` | **(b)** |
| **M-18** | D3 **G-C** | Extension prefix route: (a) reserve a vendor prefix by filing the Prefixes.md issue; (b) a clearly experimental, unregistered label taken as an **input** to loader and verifier — the P0a discipline — with no supported-extension entry; (c) borrow `CESIUM_`, accepting misattribution risk. Note `CESIUM` is reserved to Cesium GS, Inc., and this fork is not that entity | `MS-18`, `MS-21` | **(b)** now; (a) if **M-23** says publication |
| **M-19** | D3 **G-D** | Scope word and v1 content: `_primitive_clusters` or `_mesh_clusters`; `clusters` or `meshlets`; culling-only with a declared-but-empty LOD slot, or culling + LOD? Does ruling **M1** bind the wire format too? | `MS-18` | `primitive` + `clusters` ("meshlet" implies a stage browser WebGPU lacks); culling-only with the slot declared |
| **M-20** | D3 **G-E** | Storage: bufferViews with normatively-fixed layouts, or accessors? Accessor-componentType legality for non-index, non-attribute extension accessors is UNCONFIRMED | `MS-18` | **bufferViews** |
| **M-21** | D3 **G-F** | Producer: pre-baked, runtime, or both? If both, the spec must say a client MAY ignore a present extension and re-cluster, and that the two paths need not agree bit-for-bit. This governs whether the client keeps a WASM dependency at all | `MS-18`, `MS-22`, `MS-23` | **both**, with the client-MAY-re-cluster clause |
| **M-22** | D3 **G-G** | Accept "MUST NOT be combined with `KHR_draco_mesh_compression` on the same primitive"? It removes a class of tilesets from the feature and deserves an explicit yes | `MS-18` | **yes**, explicitly |
| **M-23** | D3 **G-H** | Fork-internal format, or publication candidate? Publication implies prefix reservation, a schema file, conformance vectors and a second implementer | `MS-18` | **fork-internal** until Tier 1 proves wins |
| **M-24** | D3 **G-I** | *verbatim in §6.0.* Does the `C11-168` launch gate gate **every** meshlet row, or only rows that change a render path? This draft assumes the latter — research, licence, layout, spec-authoring, validator and tooling rows proceed; `MS-10` onward are HELD — because **M4** itself filed the pre-baking work as research | `MS-08`; confirms the whole track's dispatchable set | **implementation rows only** |
| **M-25** | D3 **G-J** | *verbatim in `MS-16`.* File the dormant mesh-shader row with its four named triggers, or strike it? | `MS-16` | **file it dormant** |
| **M-26** | lane S `DECISIONS_TAR-MINYATUR.md` D5 | **CLA check migration.** Upstream's 1.145 delta migrates its CLA check from Google Sheets to Microsoft Graph (206 insertions/35 deletions; the merged action would throw `"MICROSOFT_GRAPH_INFO_JSON not found."` if taken as-is, since the fork holds no such credential). The merge landed with the **status quo kept**: `.github/actions/check-for-CLA/` restored byte-identical to the fork's Google-Sheets mechanism, `cla.yml`'s `env:` block restored to the three Google secrets (keeping upstream's `setup-node@v6`→`@v7` bump), the `GoogleConfig.json` `.gitignore` line restored, and `cla-rotation-reminder.yml` kept with its `schedule:`/cron **withheld** (GitHub quiet-hours posture — an annual cron opening issues about a credential the fork does not hold is unwanted visible activity). **Adopt upstream's Microsoft-Graph migration (configure the secret, revert the four restorations), or keep Google Sheets permanently (close this decision and drop the restorations from future-sync watch lists)?** All four restored items revert together if Graph is adopted. | none — resolved as-shipped pending this ruling | keep Google Sheets unless there is an operational reason to hold a Microsoft Graph credential |
| **M-27** | `REVIEW_ERADAN_cluster-a.md` finding 4; restated in `LANDING_PACKET_TAR-MINYATUR.md` §10 (Governance) | **Extend CLAUDE.md's `ShaderDefine` add-only rule to the WebGL globe shader-set key.** The rule in CLAUDE.md's "WGSL Shader Pipeline" section ("Add-only. Never reorder, renumber, or remove") currently names only `WebGPUShaderDefines.ts`'s bit registry. The 1.145 sync's highest-severity single resolution was exactly this failure mode on the *other* backend: the fork's pre-merge `GlobeSurfaceShaderSet.js` had silently renumbered an upstream-inherited bit (`hasVectorLayer`, bit 33) with no governance rule catching it, and the sync's `-01` resolution had to restore it to its merge-base position and write an in-code add-only rule as a stopgap (`GlobeSurfaceShaderSet.js:322-331`). **Adopt the governance-level extension so the next sync does not re-arm the same trap on a third registry?** | none — the in-code rule is a workaround, not the governance fix | yes — extend the CLAUDE.md rule text to name `GlobeSurfaceShaderSet.js`'s shader-key bit assignment alongside `ShaderDefine`/`ShaderDefineHi`/`ShaderSourceId`/`FeatureRendererKey` (SR-4); CLAUDE.md itself is not edited by this document |
| **M-28** | Hunleth doc pass, 2026-09-05 | **Not a decision — a collision record, resolved in the same pass.** `FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md` used the id `Q-3` for two unrelated things: `:80` (`WebGPUPostProcessPipeline.ts:1856`, the resize-destroys-effects row that `AR-009`, landed Batch 1420, partially owns) and `:1254` (a wave-3 landing-summary line naming "Q-3 solar-disc floor", an already-discharged, unrelated item). The `:1254` occurrence is renamed to `Q-154` (the next free `Q-` id in that file — the file's `Q-` ids run 1-153 with no gap) in the same patch that carries this row, with a one-line note at the site. Nothing about either discharge changes. Recorded here so a future reader does not re-collide the id. | none | recorded as resolved |
| **M-29** | Hunleth doc pass, 2026-09-05 | **Not a decision — a scope call to confirm, not overturn.** `AR-832`'s landed fix (Batch 1418, lane Mablung, reviewer Urthel) makes `selectWebGPUShader` read `appearance.flat` so a flat `PerInstanceColorAppearance` never selects a lit shader variant — a shader-selection change bounded to one production call site and proven not to cross either fence Principle 1 protects (`FrustumGeometry.js` untouched; selection does not read `vertexFormat`). The lead (Barahir) already ratified this on Urthel's corrected evidence at landing time. **This entry exists only so the seat has a one-line record of a scope call of that reach, not to reopen it** — see `AR-832`'s row for the full evidence (the one other in-tree page it visibly changes, `Apps/WebGPUTest/primitive-box-webgpu.html`, going lit → flat, matching WebGL's own behaviour for the same flag). | none — already ratified | confirm the ratification stands, or say so if not |
| **M-30** | Gundor, `REVIEW_GUNDOR_ROUND2.md` §5 item 2 | **The executor's standing preflight (`served md5 == disk md5`) is structurally blind to a served bundle that was never rebuilt at all — this is the second recorded instance (2026-08-29 memory note; 2026-09-05 job 5 leg 5-3/Penlod/Gundor), and Gundor is explicit that it is "worth a ruling, not a lane note."** Mechanism: the dev server's default (non-`--serve-built`) mode regenerates shader `.js` mirrors via `wgslToJavaScript`/`glslToJavaScript` (`server.js:151`, `:365`) without ever writing `Build/CesiumUnminified` — an md5 comparison of the artifact to itself proves the server is not caching, and proves nothing about whether that artifact was ever rebuilt from current source. **Adopt the built-shader-identity check (landed Batch 1423) as a MANDATORY second leg of every executor preflight, or accept the risk and require every Edge job to state which build mode served it?** | `DX-47`, and every future Edge job's preflight discipline | adopt the built-shader-identity check as mandatory; a bare md5 match should never again be reported as sufficient in an Edge job's discipline record |

**One sitting is recommended for M-06 through M-10** — they are one subject (the fork's night sky) and answering them separately risks a partial law. `NIGHTFADE-D1` and `Q-123` are already pending the same eyeball and belong in that sitting; they are **not** re-filed here.

---

## 9. EXECUTION NOTES — binding on every dispatch

1. **One Edge job at a time (SR-17).** Never two browser tranches concurrently. `Q-148` is **tranche A**, `Q-143` **tranche B** (carrying the `DM-02`–`DM-06` legs), and `Q-141`/`Q-142`'s browser legs **tranche C**; they are sequenced, not parallelised. **Port 8080 is the maintainer's** — a tranche takes its own port or waits. **The Edge queue is not empty before any of them:** `C12-38`'s 13-sample dawn sweep (sample 7 the pre-registered discriminator) is **already owed** and competes for the same seat. Sequence explicitly and name which runs first — this queue's proposal is `C12-38` → A → B → C, since `C12-38`'s subject is landed and its evidence is the older debt.
2. **`--serve-built`, and assert served md5 == disk md5** before the first capture. The default `node server.js` serves `Build/CesiumDev` through live esbuild; an executor that does not pass `--serve-built` may be measuring source that never reached a build.
3. **`Q-145` is a precondition for every browser row that opens the built app.** The Sandcastle2 origin rewrite and its **refusal** must be installed, and the guard must keep refusing for the WHOLE life of the page — not a single post-navigation check — whenever any navigation (main frame or bucket/run frame) lands off the requested origin. Without it a probe on any port silently lands on the maintainer's server — the incident that produced this row. **Landed:** `Tools/visual-regression/lib/sandcastle2-origin-rewrite.mjs` — `sandcastle2-renderer-gate.mjs`'s `openSandcastle2Url` is the one-call opener: it installs the rewrite on the page's `BrowserContext`, navigates under the persistent guard, AND waits for the run/bucket frame under the same guard extended with the bucket origin, so a single call covers both frames, not just the top-level one. `createGuardedPage(context, origins)` is the page factory EVERY opener must use for the `Page` itself, not only for `openSandcastle2Url`'s own internal calls — it wraps `close()` so a breach the caller never explicitly checked (a navigation call that was never `await`ed, or awaited but never inspected), or one still in flight when `close()` runs (refused on its own as `NAVIGATION_UNVERIFIED`), still surfaces loudly at close time rather than being lost. Calling `openSandcastle2Url` against a page created with a plain `context.newPage()` does NOT get this: it records later breaches but arranges nothing to surface them at close, and `browser.close()` never invokes the wrapped `page.close()` at all — both create-with-`createGuardedPage` and navigate-with-`openSandcastle2Url` are required together. `sandcastle-smoke.mjs --sandcastle2`, `probe-sandcastle2-webgpu-start.mjs`, and `probe-sandcastle2-ports.mjs` all now create their page via `createGuardedPage` and route every exit path through it. Any executor opening `Apps/Sandcastle2` by any other means — a bare `page.goto`, a hand-rolled probe, or a guarded navigation against an unguarded page — is not covered and must be fixed before its tranche runs, not after.
4. **No landings that change what a probe loads while an Edge tranche runs (SR-5).** `Tools/` and `migration_doc/` landings are permitted **during another row's tranche** — `Q-145`'s helper, `DM-01`'s probe, `Q-148`'s probe and scorer, `EAN-05`'s gate repair — and **each must land before its own** row runs: `Q-148`'s scorer is not “mid-tranche” work, it is tranche A's precondition. **`packages/engine/Source` *and* `packages/sandcastle/gallery` landings are not permitted mid-tranche**, because both change what a probe loads: that covers `DM-07`'s counters *and* the demo rows `Q-146`, `Q-147`, `EAN-03`, `EAN-04`, `EAN-01`, `EAN-13`, `EAN-02`, `MS-24`. Land after the executor exits, then rebuild.
5. **Build before landing any batch that adds a `packages/engine/Source` file** — a new leaf with named exports breaks the generated barrel. Run the build at the seat first.
6. **Reviewers are always separate agents from authors** (SR-14). An author may not approve its own work, and a spec written from the fix's brief is not an independent check. `MS-14` exists as its own row for exactly this reason.
7. **Worker naming: Tolkien registry** (SR-15). Every dispatched worker, reviewer, executor and scoping agent gets a unique Tolkien name, used in the Agent description, the clone directory, the packet, the ledger and every status line. Check the registry **before** each dispatch. Workers get **clones, not worktrees**; landings are squash-only; `git status --porcelain` empty at handoff; workers never run a git write, `npm install`, a build or a browser.
8. **Packet claims are not ledger facts.** A lane's packet says what the lane claims until a separate reviewer confirms it. Rows written into the ledger from an unreviewed packet must say "lane claims" until they are.
9. **Freeze before review.** A completed lane can wake itself and edit under a running review — record hashes and declare the freeze before dispatching a reviewer.
10. **Evidence repatriation before any clone is reset or deleted** (SR-11). The Treebeard and Quickbeam lanes both hold probes, logs and JSON that exist nowhere in main: copy them into main's gitignored `Tools/visual-regression/output/` preserving each probe's subdirectory layout, **before** the clones are touched. `DM-01` and `Q-148` then land the rebuilt instruments as tracked tools.
11. **Instrument doctrine, carried:** WebGPU canvas captures are Playwright **element** screenshots only (in-page `drawImage` returns transparent); GPU timing is interleaved A/B in one session; readiness is `Scene.renderReady`, not `tilesLoaded`; idle-soak FPS is invalid under request-render mode.
12. **GitHub quiet hours** — no commit, no push, no visible GitHub activity on weekdays 07:00–19:00 ET. Hold work as uncommitted worktree state and land after 19:00. `date` on the machine is authoritative.
13. **Proof bar by change class (R-2026-08-29-1).** Engine/parity/shader rows keep the full bar; tools rows carry a spec only with logic worth pinning and a runner home; docs, comments and demo text carry review plus a capture, no spec; a spec with no runner home is a review blocker; a probe that measures the feature is the preferred acceptance.
14. **Wave-end gate (R-2026-08-29-2).** Every multi-batch wave closes with the variant smoke test, the Sandcastle2 sweep on both renderers and the visual-regression capture-and-diff (baselines refreshed deliberately), run by an Edge executor and banked under `Tools/visual-regression/output/wave-end/<wave>/`. Not per batch. `Q-152` builds the chained runbook.

---

## 10. Dispatch order at a glance

```
WAVE 1   Q-145                                             [Tools - may land mid-tranche]
         (Q-146 + Q-147 + EAN-03 + EAN-04)  one demo commit  [gallery - SR-5, never mid-tranche]
         EAN-01 (code, default-off)   DM-01 [Tools]   DM-07 [ENGINE - SR-5, never mid-tranche]
         Q-148 scorer (SOL-DIRECTED, lands first)
         Q-148  ──tranche A──►  EAN-01 certification  ──►  EAN-01 default flip (1 line, on the bar)
         Q-143  ──tranche B──►  DM-02..DM-06 legs
         Q-141 (needs DM-07)    Q-142 (author + spec now; landing form on M-03)
         rebuild ──tranche C──►  Q-141 re-run legs  +  Q-142 AO capture pair

WAVE DX  DONE  DX-05 [Batch 1308] · DX-11 [Batch 1310]
         FRONTIER  DX-14 [PARKED; repair completion + explicit release; blocks DX-03 / DX-04]
         AFTER REPAIR + RELEASE  DX-03 ──► DX-01 ──► DX-02 ──► DX-04 ──► DX-06(batches)
         ──► DX-12 ──► DX-07 ──► DX-08 ──► DX-09 ──► DX-10
         TAIL DX-15 HELD(C11-107/G6 Q2d Principle-7 sign-off; separate root-gated Edge lane)

WAVE 2   Q-149 · DM-08 · DM-09 · DM-10 · DM-11 · DM-12 · DM-15        (behind their measurements)

WAVE 3   Q-150(M-06) · EAN-08/09/10(M-07,M-09) · EAN-12(M-10) · EAN-13(M-08)
         Q-144(M-11) · DM-13(M-12) · DM-14(M-13)                       (behind an answer)

WAVE 4   EAN-05 ──► EAN-07        EAN-06        EAN-11        EAN-02   (beyond upstream)

MESHLET  M0  MS-00 ──► MS-01      MS-02 HELD(M-17)
 (M-16)  M1  MS-03 · MS-04 · MS-05 · MS-06 ──► MS-07
         M2  MS-08(M-24) ──► MS-09
         M3  MS-14 (authored early) ‖ MS-10 ──► {MS-11 · MS-12 · MS-13} ──► MS-15  [HELD: C11-168]
         M4  MS-16 DORMANT(M-25)
         M5  MS-17 HELD(M1)
         M6  MS-18(M-18..M-23) ──► MS-19 ──► MS-20 ──► MS-21 ──► MS-23
             MS-18 ──► MS-22 ──────────────────────────────► MS-23
         M7  MS-24 ──► MS-25 ──► MS-26
```

**Historical 2026-08-29 plan classification for the rows listed below (not current dispatch or status authority):** `Q-145`, `Q-146`, `Q-147`, `EAN-03`, `EAN-04`, `EAN-01` (code, default-off), `DM-01`, `DM-07`, `Q-148`, `Q-143`, `DM-02` and `DM-03` (**the measurements** — only their ship decisions carry **M-01**/**M-02**), `DM-04`, `DM-05`, `DM-06`, `Q-141`, `Q-142` (author and spec; landing form on **M-03**), `MS-00`, `MS-01`, `MS-03`, `MS-04`, `MS-05`, `MS-06`, `MS-07`, `MS-14` (non-boundary grid today). That is **25 rows** — the earlier “24” was an arithmetic error over a list of 23 ids that also omitted `DM-02`/`DM-03`'s ungated measurement legs.

**Edge accounting, corrected.** Five of those rows carry an OPUS-EDGE-EXECUTOR tier: `Q-148` (**tranche A**), `Q-143` (**tranche B**) and `DM-02`–`DM-06`, which are **legs inside tranche B**, not tranches of their own. Three further Edge jobs are owed by rows tiered elsewhere — `EAN-01`'s certification (inside tranche A) and `Q-141`'s re-run legs plus `Q-142`'s capture pair (**tranche C**, after both land and the tree is rebuilt). **Eight Edge jobs, three tranches, one at a time (SR-17)** — and `C12-38`'s owed dawn sweep is ahead of all of them in the same seat (§9 item 1).

---

## 11. Nonclaims

- **This document does not launch, rule, schedule or fund a row.** Its landed and closed entries carry cited results; the remaining order is a dispatch proposal and grants no execution authority.
- **No performance claim.** Nothing was measured for this document. Every number quoted is quoted from the cited memo, queue or ledger row, not re-measured — including `C11-168`'s 9.2025 ms / 4.65 ms, `Q-141`'s 4/40 picks, `Q-134`'s 1.6–2.6 s pipeline resolutions, and every star census figure.
- **No claim that any launch gate is satisfied.** `C11-168` is not, and §6.0 cites the row that says so.
- **One inherited claim is retracted verbatim, so that no brief picks it up from the source report:** *“the frame is not geometry-bound”* (Treebeard report `:190-193`, `:382-384`) is **not supported** — no WebGPU steady-state frame cost or command count exists in that run (`raw.webgpu.idle.deltas` and `.cmds` are empty arrays; `idleFrame` / `idleCommands` are `null`; the 16.6 ms figures come from the `orbit` leg after a ~34° uncompensated rotation, at a content state never captured). The honest form, which supports the same conclusion and is the one `DM-N1` rests on, is Cirdan's C-8(a): **nothing is geometry-bound yet on WebGPU because the content never becomes resident.**
- **Measurement claims inherited from the two lanes are carried as UNVERIFIED where the drafts marked them so** — the Treebeard raw-JSON figures (frame counts, residency sums, heap totals, pick timings, ablation p95s) and the Earth-at-Night 39-vs-9 HDR asymmetry, the `ion` night-imagery option's behaviour and the radial spoke's producer. Any brief that makes one load-bearing must re-open the lane's raw artifact first.
- **No extension name, prefix, schema or compatibility contract is proposed as frozen**, and no claim is made that any candidate name is available or safe to publish.
- **No claim about mesh shaders beyond the dated standards record.** No browser was launched for this document, so "no shipping browser exposes a mesh feature" is an inference from the W3C CR draft plus Dawn's feature table, not a local `navigator.gpu` measurement. `MS-01`'s canary exists precisely to convert that inference into a measurement.
- **Row sizes are estimates**, not commitments; `MS-16`'s in particular is unpriceable without a spec.
- **Two fork documents disagree with the code and this queue follows the code:** the meshlet research doc's feature-ID mechanism sentence (§6.0) and `DEFERRED_WORK`'s Hi-Z "default on" sentence (`MS-12`). A third is stale: `WEBGPU_DEBUGGING_LOG.md:15372` says `MAG_CUTOFF 5.0`; the code says 5.5 (`EAN-07`).
