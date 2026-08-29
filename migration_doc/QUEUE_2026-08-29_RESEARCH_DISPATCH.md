# Research Dispatch Queue — Design-Model Perf, Earth at Night, and the Meshlet / Mesh-Shading Track (2026-08-29)

**What this document is.** The **dispatch order** for every row produced by the two research tasks that reported on 2026-08-29 — the AEC design-model performance lane (Treebeard, reviewed by Cirdan) and the Earth-at-Night lane (Quickbeam, reviewed by Celeborn) — plus the mesh-shader / meshlet / 3D-Tiles-extension track the maintainer asked for in the same breath:

> "package all of our findings from both research tasks into batches and queue them up next for our tiered workers. Include meshlets and 3dTile meshlet support. First lets look at creating mesh shaders to support meshlet rendering, then we can meshlets. 3dTile meshlets will likely need to be an extension."

**Authority — read this before citing anything below.**

1. **This queue is the dispatch order, not a status authority.** It says what is dispatched, in what sequence, at what tier, behind which gate. It does not record completion.
2. **The live ledger [`FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md`](FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md) remains the sole status authority for every `Q-` id.** `Q-141`–`Q-150`, `B1 (demo)`, `C1`–`C7`, the `AEC demo flags` umbrella and the five Earth-at-Night maintainer questions are recorded there at lines **117–125** and **132–136** (re-read 2026-08-29 — `:126` is a blank line and `:127`–`:131` are the Cirdan section and table headers, so the older “116–136” range was loose). Line **`:116`** is a different row: the **INCIDENT** that produced `Q-145`. Where this document and the ledger disagree about a `Q-` row's **status**, the ledger wins. Where they disagree about **order**, this document is the proposal and the maintainer's ruling wins.
3. **No row here is launched, ruled, scheduled or funded.** Nothing was measured for this document.
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

---
## 1. LIVE STATUS LEDGER

**Status vocabulary:** `QUEUED` = dispatchable under the current holds · `HELD (x)` = blocked on the named gate or dependency · `CLOSED-NEGATIVE` = closed with evidence, do not re-open. **`Q-` rows carry their ledger status by reference** — this column states dispatchability only.

| ID | Title | Tier | Size | Status | Depends on | Wave |
|---|---|---|---|---|---|---|
| `Q-145` | Sandcastle2 built-app origin rewrite + refusal | SONNET-BOUNDED | S | QUEUED | — | 1 |
| `Q-146` | Earth-at-Night demo clock coupling + timeline window | SONNET-BOUNDED | XS | QUEUED | `Q-145` | 1 |
| `Q-147` | `sandcastle.yaml` still says emissive lights are WebGPU-only | SONNET-BOUNDED | XS | QUEUED | land with `Q-146` | 1 |
| `EAN-03` | Night-darkness slider is inert at shipped defaults | SONNET-BOUNDED | XS | QUEUED | — | 1 |
| `EAN-04` | Collapse the five-row toolbar out of every capture | SONNET-BOUNDED | XS | QUEUED | — | 1 |
| `EAN-01` | Demo picks the star map + exposure (ledger `B1 (demo)`) | SONNET-BOUNDED | XS–S | QUEUED (cert = second dispatch, HELD on `Q-148`) | `Q-145`; cert `Q-148` | 1 |
| `Q-148` | Repair + promote the star probe; census scorer | OPUS-EDGE-EXECUTOR | M | QUEUED | `Q-145`, `EAN-04` | 1 |
| `DM-01` | Rebuild the AEC probe so a streaming lever is measurable | SONNET-BOUNDED | S | QUEUED | `Q-145` | 1 |
| `Q-143` | AEC dense-tileset corrected interleaved re-measure | OPUS-EDGE-EXECUTOR | S | QUEUED | `DM-01` | 1 |
| `DM-02` | `requestRenderMode` leg (ship decision gated) | OPUS-EDGE-EXECUTOR | XS / S | QUEUED (ship HELD on M-01) | `Q-143`, `DM-01` | 1 |
| `DM-03` | `maximumScreenSpaceError = 24` leg (ship decision gated) | OPUS-EDGE-EXECUTOR | XS / S | QUEUED (ship HELD on M-02) | `Q-143`, `DM-01` | 1 |
| `DM-04` | `resolutionScale` control legs | OPUS-EDGE-EXECUTOR | XS | QUEUED (measurement ungated; a **default** proposal would inherit M-02) | `Q-143`, `DM-01` | 1 |
| `DM-05` | `logarithmicDepthBuffer = false` leg | OPUS-EDGE-EXECUTOR | XS | QUEUED | `Q-143`, `DM-01` | 1 |
| `DM-06` | Streaming-phase tileset flags, never evaluated | OPUS-EDGE-EXECUTOR | S | QUEUED (measurement ungated; a `foveated*` / `progressiveResolutionHeightFraction` **default** proposal is HELD on M-02) | `DM-01`, `Q-143` | 1 |
| `DM-07` | Pick-emission and pick-pipeline counters | SONNET-BOUNDED | S | QUEUED | — | 1 |
| `Q-141` | WebGPU pick commands unbuildable while colour pipeline pends | OPUS-JUDGMENT | M | QUEUED | `DM-07` | 1 |
| `Q-142` | AO bridge reads `stepSize`; clamps and divisor compound it | OPUS-JUDGMENT | S–M | QUEUED (landing form on M-03) | — | 1 |
| `Q-149` | Moon modulation: limiting-magnitude floor | OPUS-JUDGMENT | S | HELD (`Q-148`) | `Q-148` | 2 |
| `DM-08` | WebGPU AO has no runtime config propagation | OPUS-JUDGMENT | S | HELD (`Q-142`) | `Q-142` | 2 |
| `DM-09` | WebGPU tile-content residency starves the frame loop | OPUS-JUDGMENT | L | HELD (`Q-143`, M-04) | `Q-143` | 2 |
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
| `MS-04` | `maxStorageBufferBindingSize` adaptive limit cap | SONNET-BOUNDED | XS | QUEUED | — | M1 |
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
| `DM-N1`…`DM-N11` | Eleven design-model non-levers | — | — | CLOSED-NEGATIVE | — | §7 |
| `EAN-X1`…`EAN-X6` | Six Earth-at-Night closures and hand-offs | — | — | CLOSED-NEGATIVE | — | §7 |

**Counts.** Wave 1 = **17**, Wave 2 = **7**, Wave 3 = **9**, Wave 4 = **5**, meshlet track = **27** (`MS-00`…`MS-26`), closed-negative = **17**. Total tracked = **82**.

**Umbrella, not a row.** The ledger's `AEC demo flags` entry (`FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md:136`) stays the umbrella over `DM-02`–`DM-06`; it has no tier and no executor of its own, and it attaches to the `C11-168` dense-tileset lane so the flags are judged in the same harness that `Q-143` builds.

---
## 2. WAVE 1 — ruling-free and measurement-first. Dispatchable today.

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

Twenty-four numbered decisions. **`M-15` is deliberately unassigned** so that `M-16`…`M-25` map one-to-one onto the meshlet track's original gate ids `G-A`…`G-J`. Questions marked *verbatim* are reproduced word for word in the row that owns them; this table states the ask and the rows it unblocks.

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

**One sitting is recommended for M-06 through M-10** — they are one subject (the fork's night sky) and answering them separately risks a partial law. `NIGHTFADE-D1` and `Q-123` are already pending the same eyeball and belong in that sitting; they are **not** re-filed here.

---

## 9. EXECUTION NOTES — binding on every dispatch

1. **One Edge job at a time (SR-17).** Never two browser tranches concurrently. `Q-148` is **tranche A**, `Q-143` **tranche B** (carrying the `DM-02`–`DM-06` legs), and `Q-141`/`Q-142`'s browser legs **tranche C**; they are sequenced, not parallelised. **Port 8080 is the maintainer's** — a tranche takes its own port or waits. **The Edge queue is not empty before any of them:** `C12-38`'s 13-sample dawn sweep (sample 7 the pre-registered discriminator) is **already owed** and competes for the same seat. Sequence explicitly and name which runs first — this queue's proposal is `C12-38` → A → B → C, since `C12-38`'s subject is landed and its evidence is the older debt.
2. **`--serve-built`, and assert served md5 == disk md5** before the first capture. The default `node server.js` serves `Build/CesiumDev` through live esbuild; an executor that does not pass `--serve-built` may be measuring source that never reached a build.
3. **`Q-145` is a precondition for every browser row that opens the built app.** The Sandcastle2 origin rewrite and its **refusal** must be installed, and the run must refuse when the final URL origin differs from the requested one. Without it a probe on any port silently lands on the maintainer's server — the incident that produced this row.
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

**Dispatchable today with no maintainer answer at all:** `Q-145`, `Q-146`, `Q-147`, `EAN-03`, `EAN-04`, `EAN-01` (code, default-off), `DM-01`, `DM-07`, `Q-148`, `Q-143`, `DM-02` and `DM-03` (**the measurements** — only their ship decisions carry **M-01**/**M-02**), `DM-04`, `DM-05`, `DM-06`, `Q-141`, `Q-142` (author and spec; landing form on **M-03**), `MS-00`, `MS-01`, `MS-03`, `MS-04`, `MS-05`, `MS-06`, `MS-07`, `MS-14` (non-boundary grid today). That is **25 rows** — the earlier “24” was an arithmetic error over a list of 23 ids that also omitted `DM-02`/`DM-03`'s ungated measurement legs.

**Edge accounting, corrected.** Five of those rows carry an OPUS-EDGE-EXECUTOR tier: `Q-148` (**tranche A**), `Q-143` (**tranche B**) and `DM-02`–`DM-06`, which are **legs inside tranche B**, not tranches of their own. Three further Edge jobs are owed by rows tiered elsewhere — `EAN-01`'s certification (inside tranche A) and `Q-141`'s re-run legs plus `Q-142`'s capture pair (**tranche C**, after both land and the tree is rebuilt). **Eight Edge jobs, three tranches, one at a time (SR-17)** — and `C12-38`'s owed dawn sweep is ahead of all of them in the same seat (§9 item 1).

---

## 11. Nonclaims

- **No row here is launched, ruled, scheduled or funded.** This is a dispatch proposal.
- **No performance claim.** Nothing was measured for this document. Every number quoted is quoted from the cited memo, queue or ledger row, not re-measured — including `C11-168`'s 9.2025 ms / 4.65 ms, `Q-141`'s 4/40 picks, `Q-134`'s 1.6–2.6 s pipeline resolutions, and every star census figure.
- **No claim that any launch gate is satisfied.** `C11-168` is not, and §6.0 cites the row that says so.
- **One inherited claim is retracted verbatim, so that no brief picks it up from the source report:** *“the frame is not geometry-bound”* (Treebeard report `:190-193`, `:382-384`) is **not supported** — no WebGPU steady-state frame cost or command count exists in that run (`raw.webgpu.idle.deltas` and `.cmds` are empty arrays; `idleFrame` / `idleCommands` are `null`; the 16.6 ms figures come from the `orbit` leg after a ~34° uncompensated rotation, at a content state never captured). The honest form, which supports the same conclusion and is the one `DM-N1` rests on, is Cirdan's C-8(a): **nothing is geometry-bound yet on WebGPU because the content never becomes resident.**
- **Measurement claims inherited from the two lanes are carried as UNVERIFIED where the drafts marked them so** — the Treebeard raw-JSON figures (frame counts, residency sums, heap totals, pick timings, ablation p95s) and the Earth-at-Night 39-vs-9 HDR asymmetry, the `ion` night-imagery option's behaviour and the radial spoke's producer. Any brief that makes one load-bearing must re-open the lane's raw artifact first.
- **No extension name, prefix, schema or compatibility contract is proposed as frozen**, and no claim is made that any candidate name is available or safe to publish.
- **No claim about mesh shaders beyond the dated standards record.** No browser was launched for this document, so "no shipping browser exposes a mesh feature" is an inference from the W3C CR draft plus Dawn's feature table, not a local `navigator.gpu` measurement. `MS-01`'s canary exists precisely to convert that inference into a measurement.
- **Row sizes are estimates**, not commitments; `MS-16`'s in particular is unpriceable without a spec.
- **Two fork documents disagree with the code and this queue follows the code:** the meshlet research doc's feature-ID mechanism sentence (§6.0) and `DEFERRED_WORK`'s Hi-Z "default on" sentence (`MS-12`). A third is stale: `WEBGPU_DEBUGGING_LOG.md:15372` says `MAG_CUTOFF 5.0`; the code says 5.5 (`EAN-07`).
