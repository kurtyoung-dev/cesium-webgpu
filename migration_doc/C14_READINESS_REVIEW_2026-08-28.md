# Campaign 14 (Dynamic Ocean & Wind) — Readiness Review

**Date:** 2026-08-28. **Status: PROPOSAL — AWAITING MAINTAINER LAUNCH RULING.**

This document is **not** a launch ruling and does not assert one. Campaign numbering is
ratified add-only: **C14 = Dynamic Ocean & Wind** already owns that identity by the
ratified plan [`OCEAN_DYNAMICS_PLAN_2026-07-24.md`](OCEAN_DYNAMICS_PLAN_2026-07-24.md).
Nothing below renumbers a campaign, launches one, or converts a recommendation into a
status. Launch is a maintainer call.

**What this document is.** The ratified ocean plan landed at **Batch 751 (`762f88693f`)**, and
**754 commits** separate that landing from this review's tip `41aad98761` — so it describes a
tree that no longer exists. Maintainer ruling **R1** (2026-08-06) then narrowed
C14's blocking bar to **C12 completion only**. So the practical question this review
answers is: *when C12 closes, can C14 launch on the plan as written?* The answer is **no,
not as written** — the plan's spine is sound and most of its reuse map survives, but a
material set of its technical premises has gone stale, and its wave-1 sequencing points at
prerequisites that have since landed, moved, or never started. §4 proposes a wave-1 row set
that is current.

**Reading rules.**

- The campaign queues are the sole status authorities. Where this document states a status
  it cites the owning queue by `file:line`. Dated audits and plans — **including this one**
  — are historical snapshots (Principle 10).
- Every "this landed" claim carries a batch number or commit hash **as printed by the
  owning queue**. Commit subjects in this repo are known to overstate their diffs, so a
  subject alone is never the warrant.
- Line numbers were re-derived at tip `41aad98761`. They will drift. The identifiers and
  the quoted text are the durable part; treat line numbers as a starting offset.
- §5 records what this document does **not** know. Read it before acting on §4.

---

## 1. The gate: what stands between today and a C14 launch

### 1a. The bar itself

The original ruling **O5** held C14 until Campaigns 11, 12 **and** 13 were all done.
**R1 (2026-08-06) superseded the strict reading of O5** and set a pragmatic bar:
*C12 complete + C13 Gate B green* (`OCEAN_DYNAMICS_PLAN_2026-07-24.md:220-221`, where
O5 is stated and then superseded by name).

**C13 Gate B is CLOSED — green at Batch 866 (`58af0d1819`)**, all seven instruments
certifying on one build with no assertion widened anywhere in the chain
(`OCEAN_DYNAMICS_PLAN_2026-07-24.md:222`). **Confirmed against the owning authority rather
than the dated plan:** the C13 queue's own §9 ledger row reads **"`C13-GATE-B` | COMPLETE —
CLOSED 2026-08-07 (Batch 866)"** and records the closing instrument roster — `edr-mock` 3/3,
`wcs` 3/3, `ingest` 3/3, `seam-poles` 3/3, `time` exempt-by-proof, `metar` GREEN via
discriminator, `channels` 10/10 with the scored rich-fraction vector byte-identical across
all ten runs (`QUEUE_2026-07-23_CAMPAIGN13.md:721`). A later note confirms the closure landed
on build tip `193393790c` and explicitly overtakes an earlier "IN PROGRESS / NO-GO" checklist
(`:1181-1183`).

**The remaining C14 bar is therefore C12 completion, and only that.** R1 explicitly does
*not* wait on C11-137 certification, C13 Gates A/C/D, or the unstarted bodies of either
campaign (`OCEAN_DYNAMICS_PLAN_2026-07-24.md:221`).

> **Documentation drift worth a maintainer's attention.** The ocean plan §6a carries the R1
> supersession, but the epic seed in `DEFERRED_WORK.md` still records only the superseded
> O5 wording — *"O5 stricter — Campaign 14 waits for C11+C12+C13 COMPLETION"*
> (`DEFERRED_WORK.md:4606`). A reader who reaches the seed first will conclude C14 is
> blocked on three campaigns rather than one. The seed should be stamped with R1. This
> review reports the drift; it does not edit the seed.

### 1b. The C12 closure set

C12's exit gate is **MAXIMAL** by ruling `R-2026-08-10-1`: C12 stays open until every
`C12-29` slice lands (`QUEUE_2026-07-19_CAMPAIGN12.md:35`).

The set below derives from the C12 queue's own §0 RESUME HERE section, which the queue
declares authoritative over all prose below it and which orders stamps **by batch number,
not by printed date** (`QUEUE_2026-07-19_CAMPAIGN12.md:3,7`). It is **larger than the
commonly repeated summary** of "C13-41/S3, S5, exit tail".

| # | Item | State per the queue | Kind | Line |
|---|---|---|---|---|
| 1 | **`C12-29` S3** (canonical owner `C13-41`) | "S3 REOPENED — its canonical owner `C13-41` was reopened by `R-2026-08-14-1`, and the machine-readable state was vacated `closed` → `reopened` by `R-2026-08-17-7`" | CROSS-CAMPAIGN | 35 |
| 2 | **`C12-29` S5** | "final seven-lane certification matrix still open"; harness repaired, the certification **run** is what remains owed | BROWSER-OWED | 35, 156–179 |
| 3 | **G3** (star-asset upgrade) | "RED at HEAD; the decision is RULED, the work is not done"; `R-2026-08-10-4` orders a 4096/face re-bake + re-run, "NOT YET EXECUTED at HEAD" | BROWSER-OWED + manual session | 21 |
| 4 | **`C12-12`** 4096 tier | "NOT BAKED"; a data-only change, the same work G3 needs — "do these together"; default-sky identity run also owed | MAINTAINER-ASK (manual session, batched by R-7) | 41, 58 |
| 5 | **`C12-31`** aureole | sky-shell fix landed B785/B786, but "the FULL acceptance sweep is still owed"; the L1–L4 tuple is 25/25 yet findings #4 and #6 remain OPEN and the row is "NOT freeze-ready" | BROWSER-OWED | 43 |
| 6 | **`C12-33`** Moon mip/LOD | acceptance executed and certified (PASS/exit 0), but the artifact **cannot be banked** (the certification schema carries no `runId`) and the maintainer **countersign is owed** | MAINTAINER-ASK | 39, 52 |
| 7 | **§5 exit tail** | EXIT-3 discharged at Batch 1144; EXIT-1/4/5 "ride the rows". **Both** `C12-13` (LICENSE refresh) and `C12-14` (samplable star cubemap) read **"LANDED Batch 865 (`193393790c`) — EDGE ACCEPTANCE OWED"** — the same commit, the same owed run | mixed / BROWSER-OWED | 44, 2242, 2243, 2303 |
| 8 | **G1** (skybox fade) | **RED, and ruled acceptable red at close** by `R-2026-08-21-14`, carried to proposed C17 as `CLT-D10` | RULED-ACCEPTED-RED — *not* a blocker | 20 |

**Ruled OUT of the C12 exit gate** by `R-2026-08-21-16` (`:50`): `C11-79` (stays in C11),
`C12-26` (defers to proposed C17), `C12-31-FOLLOWUP-A/B/C` (filed follow-ups; the C12-31
acceptance sweep itself stays IN), and `C12-11` (closes out of the gate with its HELD
packet kept visibly recorded). `C12-32` defers **INTO C14 W1** by `R-7` (`:1231-1232`) —
see row `C14-03` in §4.

**A caution on reading that table.** The C12 queue carries internal contradictions that a
successor must not resolve by picking the more convenient side. Three bear on C14 timing:

1. §0 line 20 says C12 may close with G1 red; line 2299 still says "C12 closes when all
   four gates pass on both backends at HEAD".
2. `C12-G1F2` is recorded "not owed" at lines 42 and 67, yet a Lane-A re-read still appears
   under "OWED (machine lane)" at line 58 and line 2004 says its re-measure "is STILL
   OWED".
3. `C12-33`'s eighteen banked raw publications all record `NON_CERTIFYING / exitCode 3 /
   certificationEligible false`, while the certification folded from them reads PASS / exit
   0 / eligible true; the queue itself says "Whether that is by design is **not** settled
   here" (`:81-85`).

None of these is resolved here. They are flagged so a future orchestrator does not read
this document's table as having settled them.

### 1c. The `C13-41` chain — the one genuinely cross-campaign blocker

`C13-41` is **REOPENED** (`QUEUE_2026-07-23_CAMPAIGN13.md:718`), carrying a dedicated stamp
that declares itself authoritative over the retained 2026-08-12 "COMPLETE / EDGE VERIFIED"
reconciliation blocks — those are kept as the record of what was believed then, not as
current status (`:726-731`). The machine-readable state agrees: `state: "reopened"`,
`reopenedBy: "R-2026-08-14-1"`, `reopenedRecordedBy: "R-2026-08-17-7"`,
`priorState: "closed"` (`FINDING_DISPOSITIONS_2026-08-13.json:37-46`).

It is on the C14 critical path by name: *"C14 is blocked on C12 is blocked on `C13-41`"*
(`QUEUE_2026-07-23_CAMPAIGN13.md:147`, per `R-2026-08-10-1`).

**Its exit has two conditions, both required** (`QUEUE_2026-07-23_CAMPAIGN13.md:748`):

1. **A fresh, banked refresh-cost measurement (SOL-4)** — "an Edge run" (`:750`).
   **The banked-evidence prerequisite is recorded SATISFIED:** `R-2026-08-21-24` says the
   2026-08-21 runs are the artifact of record and this "satisfies the `R-2026-08-14-1`
   prerequisite on honest evidence" (`MAINTAINER_RULINGS_2026-08-21.md:164-169`).
   **A remainder is explicitly recorded:** the durable WebGPU GPU-timestamp figure is still
   owed — `refreshCostMeasured` is still false and `cost.webgpu.gpuMsPerRefresh` is still
   null because one pre-segment drain did not close, and the queue states plainly **"No
   WebGPU per-refresh cost figure is claimed."** (`QUEUE_2026-07-23_CAMPAIGN13.md:750`).
   Batches 1131 (`1c2161c8de`) and 1136 (`e2615ef8e2`) landed the GPU-timestamp
   instrumentation for this lane (`:46-50`).
2. **A mechanism investigation of the 1.0496 `shadowContrastInvariant` reading.** The queue
   is explicit that naming the known ProceduralClouds over-composite confound "is not the
   same as explaining the 1.0496, and the row does not close on the confound alone"
   (`:783-787`). The latest recorded depth-8 protocol-v4 run still reports
   `shadowContrastInvariant` false at `1.0341102079879674` against `[0.97, 1.03]`, and says
   the band does not move (`:750`).

**The honest reading: condition 1 is substantially discharged with a named remainder;
condition 2 is genuinely open and is a *mechanism* question, not a re-run.** That
distinction governs dispatch shape — a green re-run would not discharge condition 2.

**A documented fallback exists and has not been exercised.** `R-2026-08-10-1` records
"Option A — narrow the gate to S1/S2/S4/S6, transfer S3 formally to C13-41, close C12 and
unblock C14 early", with the revisit trigger being "if C13-41 stalls long enough that C14's
absence costs more than the totality-consistency gap Option A accepts"; Option C (re-file
S3/S4 as C13 rows and close C12-29) is noted as the ledger-cleanest variant
(`MAINTAINER_RULINGS_2026-08-10.md:41-46`). **AVAILABLE, NOT EXERCISED** — the current C12
queue still records the maximal gate (`QUEUE_2026-07-19_CAMPAIGN12.md:35`). **This is the
live maintainer lever with the largest effect on C14's start date.**

---

## 2. Premise audit — the 2026-07-24 plan against today's tree

Each premise below was re-derived by reading the current code, not by trusting the plan's
citation. Verdicts: **HOLDS**, **HOLDS-MOVED** (true, but the path or line drifted), or
**STALE** (no longer true).

### 2a. What still holds — the plan's spine survives

| Plan premise | Verdict | Current evidence |
|---|---|---|
| The FFT ocean's Phillips spectrum already consumes `windX`/`windZ`, `windSpeed` U, `amplitude`, `smallWave`, `dirDamp`; `L = U²/g` and the `\|k̂·ŵ\|²` directional factor are live | **HOLDS-MOVED** | `Shaders/WebGPU/Ocean/OceanInitialSpectrum.wgsl:15-28` (InitParams), `:36-56` (`phillips()`); `L = U²/g` at `:43`, directional factor at `:46-47`, against-wind damping at `:49-51` |
| Gaussian noise is CPU-uploaded deterministically by Box-Muller and never re-rolled at runtime — the property the whole no-pop wind-response design rests on | **HOLDS** | `OceanInitialSpectrum.wgsl:8-9`, consumed at `:71-78` |
| A live re-parameterization path exists and reallocates nothing | **HOLDS** (with a correction, below) | the dirty-flag refresh path is live in `Renderer/WebGPU/WebGPUOceanRenderer.ts` |
| The whole FFT ocean compute + surface chain exists | **HOLDS** | six shaders under `Shaders/WebGPU/Ocean/`; `WebGPUOceanRenderer.ts` (1,028 lines); `Scene/OceanSurfacePrimitive.js` (367); `Scene/GlobeWaterOcean.js` (296) |
| Wind visualization already shipped (C6-FLOWFIELD-WIND) and is opt-in default-off | **HOLDS-MOVED** | `Scene/FlowFieldWindLayer.js` (309 lines), `Renderer/WebGPU/WebGPUFlowFieldRenderer.ts`, `Shaders/WebGPU/FlowFieldAdvect.wgsl`; ships per `DEFERRED_WORK.md:9934` |
| The four flow-field follow-ups the epic absorbs as aliases still exist | **HOLDS** | `NEW-FLOWFIELD-LIVE-EDR`, `-OCEAN-CURRENTS`, `-TRAILS`, `-WEBGL-PARITY` at `DEFERRED_WORK.md:9934` |
| `C6-FFT-OCEAN-CLIPMAP` — the "waves everywhere" coverage gate — is still open | **HOLDS** | `DEFERRED_WORK.md:9936`, follow-up (3): "the single ~3 km patch is only visible from low altitude". No separate status token exists; it remains an unstruck follow-up |

### 2b. What went stale — do not brief from these

| # | Stale premise (as the plan states it) | What is true now |
|---|---|---|
| S1 | `GlobeTerrain.wgsl` lives at `Shaders/WebGPU/GlobeTerrain.wgsl` | It moved to **`Shaders/WebGPU/Globe/GlobeTerrain.wgsl`**. Every §1e citation is off by both path and several thousand lines |
| S2 | "`sampleOceanWaveNormals` uses three hardcoded octave scroll velocities" (cited `:2222-2233`) | The function was **rewritten by `C11-172`** and now lives at `Shaders/WebGPU/Globe/GlobeTerrain.wgsl:2384`, taking per-tile `phase1/phase2/phase3`, using `textureSampleGrad` with an anisotropy-clamped footprint LOD and a hard far cutoff. W2 must be designed against **this** body, not the plan-era one |
| S3 | (implied) wind is not representable in the terrain water shader | **The premise still holds in substance** — `OCEAN_ADVECT_1/2/3` remain WGSL compile-time constants (`:2352-2354`), as do `OCEAN_OCTAVE_REPEATS_1/2/3` (`:2344-2346`) and the weights (`:2347-2349`). No wind uniform reaches this shader. W2 is still well-founded; only its target code shape changed |
| S4 | The tile UB uses a "0 = use shader default" sentinel | The current law is **`GLOBE_UB_UNSET`** — explicitly negative, "never `0.0`" (`Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts:589`, applied at `:602-603`; defined in `WebGPUGlobeTunables.ts`). A `windParams` slot is therefore **append-only growth at float offset 492** — the current `TILE_UNIFORM_FLOATS = 492` (`Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts:263`), i.e. one past the end, alongside `OCEAN_PARAMS_OFFSET = 452` / `NIGHT_OCEAN_PARAMS_OFFSET = 456` (`:296-297`) — not a spare vec4 |
| S5 | W2 is a single shared wave march to mirror across backends | The two backends are **partly shared and partly divergent, by design and with the divergence documented in-source**. `GlobeFS.glsl:1084-1101` states that the fade band (`OCEAN_OCTAVE_FADE_LO`/`HI`) and `OCEAN_WAVE_MARCH_CUTOFF` are **"shared verbatim with the WGSL march"**, but that **"The per-layer scale is backend-native and does not match: WGSL picks explicit physical wavelengths (`OCEAN_WAVELENGTH_*_M`), while this path keeps `czm_getWaterNoise`'s scale."** GLSL is a two-altitude-layer path that mip-averages automatically through `texture()`. W2 is therefore **two backend-specific wind adapters over an already-shared fade/cutoff contract** — better than the plan assumed, but not one mirror |
| S6 | `C11-149` (define-width) is an outstanding blocker, and the lo-word registry is full so no new bit is available | `C11-149` is **LANDED — Batch 739 (`bf7b20c6d3`)** (`QUEUE_2026-07-18_CAMPAIGN11.md:1335`). The hi-word registry is live. "Zero new define bits" remains a sound **design goal**, but it is no longer forced by a full registry |
| S7 | `C11-172` is a future prereq to sequence against (octave LOD 3→2→1) | **COMPLETE — Batch 757** (`QUEUE_2026-07-18_CAMPAIGN11.md:839`). W2 layers over shipped code |
| S8 | Only `windSpeed` has a live public setter | Still the only live **wave-tunable** setter, but the facade has since gained live **`verticalDatum`, `tideEnabled`, `tideExaggeration`** and read-only diagnostics. The plan's options list is incomplete |
| S9 | The ocean-lid vertical datum is UNCONFIRMED, and "RMS 3.7 m vs EGM2008" | **CONFIRMED GEOID, and the 3.7 m figure was itself corrected**: "the report's 'RMS 3.7 m' was reference-table error, not lid error" — the grid reproduces CWT's own lid to 0.03–0.31 m at six sites, **RMS 0.15 m** (`DEFERRED_WORK.md:4612`). The ~101.6 m Sri Lanka plateau closes to ~0.5 m |
| S10 | Tides are a feasibility question sharing an unconfirmed datum probe | **Design A slice 1 LANDED Batch 763 (`3f81970ef7`)** and **slice 2 (harmonic stack) landed Batch 767** (`DEFERRED_WORK.md:4612`, `:4610`). The datum/tide anchor ships |
| S11 | Three wind stores disagree in three representations (weather 3D `{x,y,z}`, clouds 2D, ocean scalar radians) | **Partly obsolete.** Scene weather and cloud wind are both documented/stored as 2D `{x,y}` by default; the divergence has moved downstream into the particle and fog **adapters**, which widen or reinterpret the value inconsistently. The row's justification changes from "reconcile three stores" to "enforce one contract across adapters" |
| S12 | Ocean compute is submitted on its own private encoder before scene render | It now records on the **shared frame encoder**, with private submission only as a fallback |
| S13 | The dirty refresh is "two 256×256 dispatches" | Twiddle covers 8×256 and initial spectrum covers 256×256. The no-reallocation property holds; the dispatch arithmetic in the budget does not |
| S14 | Frame context is "~12.18-12.53 ms/frame, ~4 ms headroom to 60 fps" | Those values survive only as **historical, expressly non-comparable** C13 characterizations. The ≤2.0 ms all-on budget (ruling **O4**, ratified *provisionally pending the W0 baseline*) cannot be evaluated against them |
| S15 | `WebGPUFlowFieldRenderer.ts` is 662 lines | 765 lines. Cosmetic, but it indicates the file has moved on |
| S16 | The cloud weatherTex has all four channels claimed (so wind needs a second texture) | **The conclusion holds and is now stronger** — G/B/A are active shader inputs for genus, cloud base and density, even though several older comments still call them scaffolding |

### 2c. Two defects surfaced by the audit (filed, not fixed here)

Both are small, real, and in code C14 wave 1 would touch immediately.

- **`OceanSurfacePrimitive` amplitude default disagrees with its own documentation** — the
  JSDoc documents `4.0` (`Scene/OceanSurfacePrimitive.js:64`) while the executable default
  is `1.0` (`:100`). The facade also defaults `_amplitude = 4.0`
  (`Scene/GlobeWaterOcean.js:34`), so a directly-constructed primitive and a
  facade-constructed one start at different sea states.
- **`GlobeWaterOcean.windSpeed` JSDoc says "Applied on enable"**
  (`Scene/GlobeWaterOcean.js:118`) but the setter propagates live to the running primitive
  and sets `_paramsDirty` (`:126-131`). The comment understates a shipped capability the
  epic's W1 depends on.

A third, adjacent: `FlowFieldWindLayer` comments say `show=false` frees resources, but the
current code retains created resources for quick re-enable and frees them only on
`destroy()`. The off-gate byte-identity claim is unaffected; the resource-cost claim is not
what the comments say.

---

## 3. What landed since the plan that it does not know about

Stated as capability, each with its authority. This is the material a wave-1 brief must
absorb before it cites the plan.

- **Sea-level correctness and tides.** `OceanSurfacePrimitive` now resolves
  `VerticalDatum.AUTO`, loads an EGM2008 geoid undulation grid, evaluates equilibrium or
  custom tides, composes vertical exaggeration **last**, and publishes diagnostics; the
  facade exposes live datum/tide controls. Landed Batch 763 (`3f81970ef7`) and Batch 767
  (`DEFERRED_WORK.md:4612`, `:4610`). **This changes W0**: the ocean-lid datum probe the
  plan lists as a W0 deliverable shared with tides has already run and been acted on.
- **Physical-wavelength ocean waves + footprint LOD (`C11-172`), COMPLETE Batch 757**
  (`QUEUE_2026-07-18_CAMPAIGN11.md:839`). The terrain wave march is a different, better
  shape than the plan describes, and it has its own node spec
  (`Tools/visual-regression/ocean-wave-lod.spec.mjs`).
- **`C11-149` define-width LANDED Batch 739 (`bf7b20c6d3`)**
  (`QUEUE_2026-07-18_CAMPAIGN11.md:1335`) — the hi-word ShaderDefine registry is live.
- **Shared-frame command-encoder topology** for ocean and flow-field compute, replacing the
  always-private encoder the plan describes.
- **Cloud/wind coupling got substantially richer** — procedural clouds now use
  scene-clock-relative CPU-f64 periodic-phase advection with a quantized IBL revision on a
  64 m drift threshold; the density domain carries high/low f64 morphology-origin
  advection; dynamic environment maps offer a gated full per-face reflected-cloud march
  driven by published live cloud/wind state. Any "one wind authority" design must not
  silently perturb these.
- **Weather ingest gained regional placement and no-data controls** — `WeatherField` now
  carries `registration`, `noDataValue`, `noDataFill` and `priority`; `WeatherProvider`
  exposes pack statistics and a no-data-fill override. The optional-named-array pattern the
  plan relies on for `windU?/windV?` is intact and now better precedented.

**And what did *not* move:** the C13 rows the plan names as the Level-1 field substrate —
**`C13-14`, `C13-18`, `C13-19`, `C13-20` — remain NOT STARTED**
(`QUEUE_2026-07-23_CAMPAIGN13.md:691` for C13-14; `C13-16` is PARTIAL). This is the single
most important sequencing fact in this document after the C12 gate, and it has a
consequence the plan did not anticipate — see decision **D1**.

---

## 4. Proposed wave-1 row set

**PROPOSAL. These row identifiers are provisional and take effect only under a maintainer
launch ruling.** Rows are dependency-ordered. Each states an **observable** acceptance
criterion — a thing that can be checked against reality — rather than an implementation
shape, and names the instrument that would check it. Instruments marked *(to author)* do
not exist yet; that authoring is part of the row.

Wave 1 is deliberately confined to work that is **independent of C13** and independent of
the XL coverage question. It does not contain `C6-FFT-OCEAN-CLIPMAP`, the JONSWAP/TMA
spectrum stack, currents, or jet streams. Those are waves 2+.

### Dependency order

Three lanes, not one chain. Only the arrows shown are real dependencies.

```text
LANE 0 — dispatchable NOW, while C12 is still open
  C14-03  C12-32 shared ephemeris state ....................... (no W1 dependency)

LANE 1 — instrument first (nothing may claim a perf property before C14-01)
  C14-01  multi-metric baseline ──┐
  C14-02  requestRenderMode demand ──┐   (independent of C14-01)
                                     │
LANE 2 — the ocean facade                │
  C14-04  live setters + default/doc defects ──> C14-05  wind authority L0
     ▲                                                        │
     └── needs C14-02 (a frozen frame makes a live setter unobservable)
                                                              │
LANE 3 — the terrain water shader (different subsystem, runs in parallel)         │
  C14-06  tile-UB windParams, both backends ──────────────────┤
     ▲                                                        │
     └── needs decision D1 (the ENU representation), not any W1 row
                                                              ▼
                                          C14-07  off-gate contract proven as a class
                                                              │
  C14-01 ─────────────────────────────────────────────────────┴──> C14-08  coverage
                                                                            decision
```

### The rows

**`C14-01` — Multi-metric ocean & wind baseline.** *(W0. BROWSER-OWED. Blocks everything
that claims a performance property.)*

Ruling **O4** ratified the ≤2.0 ms all-on GPU budget only **provisionally, pending the W0
baseline** (`OCEAN_DYNAMICS_PLAN_2026-07-24.md:219`), and §2b/S14 shows the frame context
the budget was written against is no longer comparable. Wave 1 therefore opens by measuring
rather than assuming.

Per the maintainer's multi-metric rule, this row must never reduce to one number: carry
call counts, timings, memory and allocation together, and state each metric's noise
behaviour beside its bar.

*Acceptance (observable):* a banked artifact recording, for four legs — ocean OFF/ON ×
flow-field OFF/ON — on both an idle and a moving-camera workload, on both backends where
the feature exists: per-pass GPU ms, CPU frame p50/p95, JS-heap delta, and
draw/dispatch/allocation counts, each reported with its own run-to-run spread. A leg whose
spread exceeds its own delta is reported as *not resolved*, never as a pass.

*Instrument:* `Tools/visual-regression/probe-ocean-waves-perf.mjs` and
`probe-fft-ocean.mjs` and `probe-flowfield-wind.mjs` (all exist), driven under the canonical
moving-altitude campaign in `DEBUGGING_GUIDE.md` with clean and instrumented lanes kept
separate; GPU attribution via `CesiumDebug.gpuPassCost(true)`. Interleaved A/B is mandatory
for the GPU timing legs.

---

**`C14-02` — Does the animated ocean keep frames alive under `requestRenderMode`?** *(W0.
Split: node-provable predicate + browser-owed observable.)*

The plan carries this as an explicit OPEN/UNCONFIRMED item: if the FFT ocean freezes when
idle it needs the `C13-35` keep-alive treatment. It is a correctness question, not a
performance one, and it gates whether W1's live setters are even observable.

*Acceptance (observable):* with `requestRenderMode` true, an enabled ocean, and no camera
input, successive captured frames **differ** over a fixed wall-clock window; with the ocean
disabled under identical conditions they are **identical**. The negative control must fire —
if the OFF leg also differs, the instrument is measuring something else and the run is void.

*Instrument:* a node spec over the frame-demand predicate (the demand module is
backend-agnostic JS and is directly testable), plus `probe-ocean-render-demand.mjs` *(to
author)* modelled on `probe-fft-ocean.mjs` for the rendered observable. Do not accept the
node leg alone: the predicate being correct does not prove the renderer reaches it.

---

**`C14-03` — `C12-32` shared ephemeris state.** *(W1 rider. Can start before C12 closes.)*

`R-2026-08-10-7` transferred `C12-32` **into C14 W1**, because it feeds C14 tides and was
sequenced alongside `C12-29` anyway. Critically, the ruling carries a documented fallback:
**"if C14 stays blocked for long, `C12-32` may land standalone earlier — it is independent
work, and landing it early does not re-open C12's gate"**
(`OCEAN_DYNAMICS_PLAN_2026-07-24.md:196`).

**This makes `C14-03` the only wave-1 row that can be dispatched today**, while C12 is still
open. If the ocean lane wants forward motion before the gate clears, this is where it goes.

*Acceptance:* to be re-derived from the `C12-32` row's own recorded criterion at intake —
**this document has not read that row and does not restate its acceptance.** Row ownership
stays with the C12 queue until a W1 intake claims it; do not double-schedule.

---

**`C14-04` — Live wave-parameter setters, and the two default/doc defects.** *(W1. Mostly
node-provable, one browser leg.)*

Add live `windDirection`, `amplitude` and `choppiness` setters on the ocean facade through
the existing `_paramsDirty` path — the plumbing is done and `windSpeed` already proves the
route. Fold in the two defects from §2c: align the amplitude default with its documentation
(or the documentation with the default — that is a maintainer-visible behaviour choice if
the shipped sea state changes), and correct the `windSpeed` "applied on enable" comment.

*Acceptance (observable):* setting each parameter on a **running** primitive changes the
merged displacement/foam output within a bounded number of frames **without** the primitive
being re-created and **without** any GPU reallocation — asserted by an allocation counter
that must read zero across the transition, not by the absence of a log line. Separately: a
directly-constructed primitive and a facade-constructed one, both at defaults, produce the
same sea state.

*Instrument:* a node spec over the params-dirty propagation path; the reallocation and
rendered-change legs via an extension to `probe-fft-ocean.mjs`. Mutate for inertness, not
absence: make the new setters unreachable (`if (false && …)`) and confirm the spec goes red.

---

**`C14-05` — Wind authority Level 0, behind `ocean.waves.windResponse` (default OFF).**
*(W1. Backend-agnostic Scene JS.)*

Extend the `AtmosphericConditions` wind fan-out to the ocean behind a new opt-in gate, with
the pre-ratified water-local overrides (`windSpeedOverride` / `windDirectionOverride`, null
→ use `AtmosphericConditions`). Note the corrected justification from §2b/S11: the target is
**one enforced ENU contract across the downstream adapters**, not the reconciliation of
three disagreeing stores.

The gate is not optional dressing. Without it, unification silently changes shipped ocean
visuals, because the ocean and weather defaults differ.

*Acceptance (observable):* **(a)** with the gate off, the rendered frame is byte-identical
to pre-change at the 0.000% probe bar, and changing `AtmosphericConditions` wind leaves the
ocean's spectrum parameters bit-unchanged; **(b)** with the gate on, changing weather wind
changes the rendered sea state; **(c)** across a wind transition the wave field does not
pop — phase continuity is preserved, which is observable as bounded frame-to-frame
displacement delta through the transition compared with the steady-state delta either side
of it. (c) is the criterion that actually tests the design: it fails if the Gaussian noise
is ever re-rolled.

*Instrument:* `probe-fft-ocean.mjs` off-gate leg (its byte-identical contract already
exists) plus a new transition-continuity leg *(to author)*.

---

**`C14-06` — Water-mask wind modulation via a tile-UB `windParams` slot.** *(W2. BOTH
backends. The first row that touches shared shader territory.)*

Thread wind into the terrain water shading. Design against the **current** code per §2b:
target the three-octave physical-repeat march at
`Shaders/WebGPU/Globe/GlobeTerrain.wgsl:2384`; use the **`GLOBE_UB_UNSET = -1.0`** sentinel
law; specify the slot as **append-only growth at tile-UB offset 492**. Treat the backends as
**two adapters under one neutral-default contract** — the GLSL side is a two-altitude-layer
`czm_getWaterNoise` path, not a mirror of the WGSL march.

*Acceptance (observable):* **(a)** at the unset sentinel, rendered water is byte-identical
to pre-change **on both backends** — this is the Principle 5 obligation and the neutral
default is what makes it achievable; **(b)** with wind set, crest orientation rotates with
wind direction (measurable as a shift in the dominant orientation of the normal field) and
foam onset moves with wind speed along the Beaufort curve; **(c)** the two backends agree
within a stated, pre-registered tolerance on one shared framing — the tolerance is declared
before the run, not fitted after it.

*Instrument:* `Tools/visual-regression/ocean-wave-lod.spec.mjs` (exists; already covers this
shader region) extended for the neutral-default leg, plus
`probe-watermask-wind.mjs` *(to author)* for the rendered legs, plus a
`capture-and-diff.mjs` scene for the cross-backend comparison.

---

**`C14-07` — The wave-1 off-gate contract, proven once for the whole wave.** *(W2 tail.)*

The plan requires every row to carry an off-gate contract: default OFF; off = zero textures,
zero dispatches, lazy feature-renderer never invoked, byte-identical frame at the
0.0/0.000% probe bar; disable frees GPU resources; runtime uniform flags, no new define
bits; add-only UBO layouts in exact cache keys. This row proves it **as a class** rather
than per-row, which is the pattern that has held up in this fork.

*Acceptance (observable):* with every wave-1 toggle off, a full capture is byte-identical to
the pre-wave baseline; the ocean and flow-field feature-renderer lazy loaders are never
invoked (asserted at the loader, not by grepping source); and a mutation that forces one
toggle on makes the assertion fail. Note the §2c finding: the *resource-freeing* half of
the contract is currently weaker than the comments claim for `FlowFieldWindLayer`, so this
row must assert what the code does and either fix the code or correct the comment.

*Instrument:* `capture-and-diff.mjs` baseline scenes plus the existing off-gate legs in
`probe-fft-ocean.mjs` and `probe-flowfield-wind.mjs`.

---

**`C14-08` — Coverage decision gate (a decision row, not an implementation row).**

`C6-FFT-OCEAN-CLIPMAP` is the "waves everywhere" gate and is XL and open
(`DEFERRED_WORK.md:9936`) — today's patch is ~3 km and visible only from low altitude. It
does not belong in wave 1. But wave 1 should **end** by putting the coverage question to the
maintainer with the measured evidence `C14-01` produced, so wave 2's scope is chosen on
numbers rather than on the 2026-07-24 estimate.

*Acceptance:* a decision packet stating the measured cost of the current single cascade, the
measured cost of the wave-1 additions, the remaining headroom against the O4 budget, and the
options for coverage (clipmap rings vs. projected grid vs. staying low-altitude-only) with
their evidence. No implementation.

### Decisions this wave surfaces (maintainer)

- **D1 — the ENU wind contract has no landed home, and its home is two rows deep.** Ruling
  **O1** ratified that the canonical ENU wind representation contract lands as a **rider on
  `C13-18`** (`OCEAN_DYNAMICS_PLAN_2026-07-24.md:216`). O1's stated reason was that C13-18
  was NOT STARTED "so no rework". That reason has aged badly: **`C13-18` is still NOT
  STARTED** (`QUEUE_2026-07-23_CAMPAIGN13.md:695`), **and it depends on `C13-14`** (`:124`),
  an **XL** architecture row that is also **NOT STARTED** (`:691`). `C13-19` and `C13-20` are
  likewise NOT STARTED (`:696`, `:697`). So C14 W1's contract prerequisite sits behind an
  unstarted XL row in another campaign. Options: (i) land the contract standalone in C14 and
  have `C13-18` adopt it when it starts; (ii) start `C13-14`/`C13-18` first, which imports an
  XL dependency into C14's critical path; (iii) re-home the contract. This document does not
  route around the gap with an inline convention — per Principle 9 it names it and stops.
- **D2 — the amplitude default discrepancy is user-visible.** Aligning
  `OceanSurfacePrimitive`'s executable default (`1.0`) with its documented `4.0` would
  change the shipped sea state for directly-constructed primitives. Aligning the other
  direction changes the documentation only. Which way is a maintainer call.
- **D3 — Option A on the C12 gate** (§1c). Not a C14 design decision, but it is the lever
  that sets C14's start date, and it is the one thing on this page a maintainer can act on
  today.
- **D4 — re-ratify the O4 budget** once `C14-01` lands, since the frame context it was set
  against is no longer comparable (§2b/S14).

---

## 5. What this document does NOT know

Written so the next reader does not mistake this review's confidence for coverage.

**How this document was verified  and where that verification stops.** Every commit hash
cited here was resolved with `git log --no-walk` and its subject checked against the row it
is attributed to (26 hashes, all resolving). The load-bearing status quotes were read at
their cited lines, and six ruling citations were corrected after the first draft put them on
the wrong lines. Code claims were re-derived by reading the current source, not by trusting
the 2026-07-24 plan. **What did not happen: an independent adversarial fact-check by a second
reviewer.** That round was dispatched and did not return. So these citations have had one
careful pass, not two  and a single reviewer checking their own document is exactly the
weaker form this fork's own instrument doctrine warns about. Treat the citations as good
leads that have been checked once.

**Not verified because it needs a machine lane (browser/hardware):**

- Every performance number in the plan and in this document is either historical or
  proposed. **No measurement was taken for this review** — no build, no browser, no probe
  was run. `C14-01` exists precisely because that gap is real.
- Whether the FFT ocean keeps frames alive under `requestRenderMode` is **still
  UNCONFIRMED** (`C14-02`). The plan flagged it in July; nothing since has answered it.
- Whether the current ocean and flow-field off-gates are still byte-identical **at HEAD**.
  The 0.000% and 0.0 figures in `DEFERRED_WORK.md:9934,9936` are from the original shipping
  batches (645 and 654) and are hundreds of commits stale.
- The cross-backend agreement tolerance for `C14-06` is unknown — it must be measured before
  it is pre-registered, and the row as written assumes that ordering.

**Not verified because it was out of this review's scope:**

- **`C12-32`'s acceptance criterion was not read.** `C14-03` deliberately defers to the C12
  row rather than restating a criterion this document has not verified.
- The **C11 queue** was consulted only for the four prerequisite statuses named in §2b
  (`C11-172`, `C11-149`) and not swept. C11 rows other than those may bear on ocean work —
  `C11-158` owns a water-default parity decision the plan says C14 must not flip, and its
  current state was **not** re-derived here.
- **License re-verification was not performed.** The plan's §4 licence table and §4a
  reference pre-registration carry several entries marked △ ("repo-declared only") that the
  plan itself says **must be upgraded to ✔ at intake before any file-level reuse**. Wave 1
  as scoped needs no external code, but wave 2 does, and
  `LICENSE_VETTING_AURORA_OCEAN_2026-08-21.md` exists and was **not** read for this review —
  it may already discharge some of those.
- Whether `FEATURE_INVENTORY.md` currently reflects the ocean subsystem's true §B/§C/§D
  placement was not confirmed against the inventory itself.

**Premises that need re-derivation before dispatch, not re-citation:**

- Every line number in this document. They were correct at `41aad98761` and will not stay
  correct. The identifiers and quotes are the durable half.
- The C12 closure set in §1b is a snapshot of a queue that changes with every landing. **Re-read
  §0 of the C12 queue before acting on it** — it declares itself authoritative over its own
  prose, which means it is also authoritative over this table.
- The three C12 internal contradictions in §1b are reported, not resolved. If a future
  reader needs one of them settled, that is a maintainer question.

**A standing caution.** This document is a dated planning artifact. By the fork's own
Principle 10 it is a **lead, not a premise**. If you are about to brief work from it, re-read
the cited lines first — that is the whole reason the citations are here.
