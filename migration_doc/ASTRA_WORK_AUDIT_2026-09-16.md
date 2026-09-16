# Astra work audit — 2026-09-16

_Provenance: a read-only workflow of twelve Opus agents plus one verifier, run 2026-09-16 against base `c325f858c3` (Batch 1487); each agent report is banked verbatim under `cesium-webgpu-worker-archive/audit-2026-09-16/`._

_Status: the twelve decisions **D1-D12** in §7 were RULED by the maintainer at ~11:05 EDT on 2026-09-16 — the twelve rulings are reproduced verbatim in §9 "Rulings taken" as provisional `R-2026-09-16-1..12`, pending record round 5. §7 keeps the seat's recommendations as written; where you need the decision, read §9._

**Synthesiser:** Hildigrim (Opus). **Seat:** Gandalf (Fable). **Date:** 2026-09-16, 10:43 EDT
(`date` at the seat — **Wednesday, inside quiet hours**; nothing commits before 19:00 ET).
**Base for everything:** the seat repository — the tree this document lands in — @ `c325f858c3`
(Batch 1487), re-derived (`git rev-parse HEAD`).

**Mode: read-only.** No file in `cesium-webgpu`, `cesium-astra-20260914`, any `cesium-lane-*` clone
or `cesium-webgpu-worker-archive` was created, edited or deleted; no git write command was run.

<!-- corrected 2026-09-16 (Isembard, fix round 1, seat-directed): the synthesiser wrote "Nine" and
     then named TWELVE reports. Twelve is the count that re-derives: the bank holds fourteen .md
     files, of which one is this document and one (picks2.md) is a data artifact, leaving the twelve
     source reports tabulated below. The figure is corrected here and in the closing attribution. -->

**Sources.** Twelve independent read-only audits commissioned by this seat, each of which re-derived
its premises at the tree and ran its own mutants. Every number below is sourced to one of those files
or to a command I re-ran myself; where two of them disagree the disagreement is recorded and
adjudicated rather than averaged. The twelve are the seven measurement units `M1`, `M2`, `M3`, `M4a`,
`M4b`, `M5` and `G` plus the five cluster reviews `R-foundation-lighting`, `R-shape-weather`,
`R-march-perf`, `R-temporal` and `R-pipelines-async`. Each is banked verbatim, unmodified, under
`cesium-webgpu-worker-archive/audit-2026-09-16/`, alongside the `M1` and `M3` json sidecars, `audit-summary.json` and this document's own copy:

| Report (in the worker archive) | Agent | Subject |
|---|---|---|
| `cesium-webgpu-worker-archive/audit-2026-09-16/M1-stack-ledger.md` | Ferdibrand | stack ledger |
| `cesium-webgpu-worker-archive/audit-2026-09-16/M2-diff-and-gates.md` | Ferdinand | diff and gates |
| `cesium-webgpu-worker-archive/audit-2026-09-16/M3-collisions.md` | Flambard | collisions |
| `cesium-webgpu-worker-archive/audit-2026-09-16/M4a-aldarion.md` | Flói | Aldarion's packets |
| `cesium-webgpu-worker-archive/audit-2026-09-16/M4b-anarion-arien.md` | Frár | Anarion's and Arien's packets |
| `cesium-webgpu-worker-archive/audit-2026-09-16/M5-gemini-findings.md` | Gimilzor | Gemini's findings |
| `cesium-webgpu-worker-archive/audit-2026-09-16/G-gemini-docs-check.md` | Holman | Gemini docs check |
| `cesium-webgpu-worker-archive/audit-2026-09-16/R-foundation-lighting.md` | Goldilocks | cluster review — foundation / lighting |
| `cesium-webgpu-worker-archive/audit-2026-09-16/R-shape-weather.md` | Gorbadoc | cluster review — shape / weather |
| `cesium-webgpu-worker-archive/audit-2026-09-16/R-march-perf.md` | Halfred | cluster review — march / perf |
| `cesium-webgpu-worker-archive/audit-2026-09-16/R-temporal.md` | Hamson | cluster review — temporal |
| `cesium-webgpu-worker-archive/audit-2026-09-16/R-pipelines-async.md` | Hildifons | cluster review — pipelines / async |

Live state re-measured by me today:

```
$ git rev-parse HEAD                                               c325f858c3
$ for d in ...; git status --porcelain | wc -l
  cesium-lane-ulmo-20260912     HEAD=9f3723b0b3  dirty=17    (L3, FROZEN)
  cesium-lane-manwe-20260912    HEAD=9f3723b0b3  dirty=11    (L4, FROZEN)
  cesium-lane-osse-20260912     HEAD=9f3723b0b3  dirty=14    (L5, FROZEN)
  cesium-astra-20260914         HEAD=c325f858c3  dirty=77    (the cumulative cloud preview)
  cesium-lane-aldarion-20260913 HEAD=c325f858c3  dirty=19
  cesium-lane-anarion-20260913  HEAD=c325f858c3  dirty=7
  cesium-lane-arien-20260913    HEAD=c325f858c3  dirty=8
$ ls Tools/visual-regression/output/.edge-slot.lock                No such file  -> EDGE SLOT FREE
$ git branch                                                       main + backup-inwindow-1405-1429-20260905
```

**Branch transparency (CLAUDE.md, unprompted):** one stale local branch besides `main` —
`backup-inwindow-1405-1429-20260905`, a 2026-09-05 safety ref. Ask before the next package whether to
delete it. The seat's own working tree is dirty in four tracked files
(`Tools/verify-landing-compliance.mjs`, its spec, `Tools/visual-regression/skybox-resolution-policy.spec.mjs`,
`packages/engine/Source/Scene/SkyBoxResolutionPolicy.ts`) plus Gemini's untracked `_lane-out/` (31 files)
— which matters for §8, because the landing wrapper commits from an empty index or by explicit path.

---

## 0. Executive summary

1. **Astra delivered two different things.** Seventeen assigned-row packets across three clones
   (Aldarion 8, Anarion 3, Arien 6) plus four measurement/record units — and, in a fourth clone, a
   **43-unit cumulative volumetric-cloud preview** with 1,142 evidence artefacts and *no* cumulative
   landing packet (M2 §1).
2. **Landable tonight after 19:00 ET: 16 of the 17 assigned-row packets, plus four record-only
   closures.** All Node-only and tools-class; 17/17 freeze md5s match line 1 of their FREEZE file; every
   packet's before/after count reproduced independently; every declared gate re-ran green
   (M4a §1–§4, M4b §1–§3).
3. **Not landable: the cloud stack, in any slice.** Its head unit (`CLOUD_PREVIEW`) is **RETURN by its
   own author**, the dependency graph is one linear chain, and 12 of the 43 units carry a RETURN — so
   nothing downstream detaches (M1 §3 plus the five cluster reviews).
4. **The stack's engineering is largely sound.** RTE clean (no `mvp*position`, no bare `vec3` position,
   no `high+low`); `ShaderDefine`/`ShaderDefineHi`/`ShaderSourceId` untouched; no TypeScript `any`; no
   `Scene → Renderer/WebGPU` import; `CloudUniforms` = 260 floats, append-only, 16-byte aligned, JS and
   WGSL agreeing; `tsc --noEmit` 0 errors over 2,258 files (M2 §3, §2.4).
5. **The deficits are in the guards and the record, not the code.** 37 failures in `test-cloud-c13`
   (32 new), five deliverables that can be made **inert with every spec green**, three of Astra's own
   inertness mutants vacuous, and **zero** `DEFERRED_WORK`/`FEATURE_INVENTORY` rows for 43 units of
   WebGPU-only work.
6. **Three rule breaches need a seat act, not a rework:** 22 of Astra's 76 dirty paths are files the
   three frozen lanes hold; `package.json:207`/`:209` were appended in-tree; and
   `cloud-genus-morphology.spec.mjs` — the one file `SOLO_WORKER_HANDOFF_2026-09-13.md` §9.2 names as
   touchable by *no* solo row — was changed +124/−15 (M2 §5 F1/F2).
7. **`main` is red today on two CI gates independent of anyone's work** — C16 cleanlist 18 regressions
   (`test-c16` subtest 15) and `eslint` 6 `new-cap` errors — and **Astra's tree takes the cleanlist from
   18 to 60**, so `verify-landing-compliance.mjs:483` rejects the batch as it stands (M5 §0, §e).
8. **Gemini's instrument sweep is the highest-value thing it produced and reproduces 100 %.** Its
   1,213-row semantic pass runs at ≈1.2 % defect yield, never opened the 8,727 lines of cloud code in
   flight — and its coverage ledger certifies that it did, citing `CloudVolume.wgsl`, a file that does
   not exist (M5 §d.3).
9. **Parity (R-2026-09-12-8): zero `.glsl` files and zero files under `Source/Renderer/` outside
   `WebGPU/` in any of the 43 freezes.** Under the ruling that is a recorded gap, not a rejection — but
   the gap is 73 paths and ~4,241 WGSL lines, and the handoff lists it as its own open issue #8.
10. **THE ONE DECISION: land the three frozen lanes (L3 Ulmo → L4 Manwë → L5 Ossë) in their reviewed
    form first and rebase Astra onto the result — or land Astra's superset first.** The seat recommends
    the former: Astra's tree already *is* the lanes plus more, six of the lanes' own acceptance specs are
    **red inside it**, and the merge is measured free in that direction (0 engine/spec conflicts) and
    expensive in the other (29 of 111 hunks reject).

---

## 1. Assigned rows — the three clones

All three clones sit at seat HEAD `c325f858c3`. Every patch was frozen, md5-verified against line 1 of
its FREEZE file, and `git apply --check`ed at the seat. **No engine file, no shader, no `migration_doc/`
file, and (except Aldarion's three free script lines) no `package.json` change appears in any of them.**
Nothing here needs the Edge slot.

### 1.1 Aldarion — 8 packets (source: `cesium-webgpu-worker-archive/audit-2026-09-16/M4a-aldarion.md`)

| id | Verdict | Blocking fixes | Gates observed | Order |
|---|---|---|---|---|
| `DX-91` sweep-report split | **LAND** | none | 4 split tests + full-gallery compatibility control; mutant `const split = false && …` → 4→2 pass | **1** (head) |
| `DX-90` per-demo watchdog | **LAND** | none | 7 controls; live Edge leg `dx90-timeout-aldarion-20260914-03` TIMEOUTs both demos (`lastFrameNumber` 450 / 367) and continues; inert-deadline mutant makes the spec **hang forever** (bounded: 0/2) | **2** |
| `DX-95` demo verdict gate | **LAND-WITH-FIXES** (record) | Record the consequence: **no gallery demo declares `__sandcastleSmokeReady`** (`git grep` → 0 files), so every quiet demo becomes `INCONCLUSIVE`→`FAIL`. The sweep is **already red at HEAD**, so this widens an existing red rather than breaking a green gate. File the demo-adoption row. | `wave-end-gate.spec.mjs` stays 36/36/0; reverting mutant reds both named adversarial settle values | **3** |
| `DX-84` browser-orphan preflight | **LAND** | none (seat stages the two new files, regenerates `TOOLING_CATALOG.md`: drift `+2/−0/~0`) | 12/12/0; `test-tools-lib` **115/115/0** — exactly the roster's re-measured target; report-only confirmed by grep (no `taskkill`/`process.kill`/`Stop-Process`) | **4** |
| `WAVE_END` gate decomposition | **LAND** | none | 36/36/0; equivalence re-derived **more broadly than the lane's own script**: 67/67 declarations one-to-one, 66 byte-exact + 1 AST-print identical, **0 semantic differences**, 38/38 exports, acyclic graph, **651/867/957 lines** all under the 1000-line rule; two mutants inside the moved modules red 13 and 21 tests | **5** (last) |
| `DX-82` provisioner guard | **LAND** | none | 7/7/0; acceptance grep 2→0; an independent mutant disabling the *content-difference* guard (the dangerous inverse — clobbering a modified governance file) is caught | independent |
| `DX-89` generated-shader dependency | **LAND-WITH-FIXES** (record) | After this row **`test-cloud-c13` exit 0 no longer implies its cloud assertions ran** on an unbuilt tree (verified: 1 pass / 1 skip, exit 0). Record it in the batch message; file the follow-up (assert `skipped === 0` on a built tree, or take the row's ranked option 2). | built pair **29/29/0, zero skips** | independent |
| `BRANCH` incident-branch assertion | **LAND** | none | 53 → **54/54/0**; the spec asserts `DEFERRED_WORK.md:330-331`'s *iff* over **16 input combinations** rather than enumerating paths; newly reported defect `lib/probe-runtime.mjs:665` (argv-null deref) confirmed real at HEAD | independent |

Gates re-run by the auditor in the clone: `test-tools-lib` 115/115/0, `test-sandcastle` 156/156/0,
prettier and eslint exit 0 over 17 paths, and — **the gate two packets declined** —
`npm run test-landing-rules` **355/355/0, exit 0, 9 min**. The "unrelated seat failures" cited as the
reason for skipping it **do not reproduce**.

Expected reds, both attributable, both cleared by staging: `verify-tooling-catalog` `+2/−0/~0`;
`verify-tracked-references` **11** violations, all class UNTRACKED (the packet predicted 3 at its own
frozen point — expect **11** in the union state).

**HELD check, measured not assumed:** intersection of Aldarion's path set with ulmo/manwe/ossë dirty
paths is **empty**. `cloud-primary-ray.spec.mjs` is *not* held (Ulmo holds `cloud-primary-**shell**`).
Aldarion's three script lines (`:167`, `:168`, `:170`) are the free keys; the held keys are
`test-cloud-c13` (ulmo + manwë) and `test-visual-regression-node` (ossë), neither touched.

### 1.2 Arien — 6 packets (source: `cesium-webgpu-worker-archive/audit-2026-09-16/M4b-anarion-arien.md`)

| id | Verdict | Blocking fixes | Gates (before → after, re-measured) | Order |
|---|---|---|---|---|
| `ARIEN_A1` | **LAND** | none | `cloud-coverage-response` 11/10/1 → **11/11/0** | 1 |
| `ARIEN_A2` | **LAND** | none | `cloud-ibl-revision` 4/3/1 → **4/4/0**; row acceptance (4) grep = 6 (≥5 required), (5) = 0 | 2 |
| `ARIEN_A3` | **LAND-WITH-FIXES** — **the fix is the seat's, in the row** | Row acceptance (6) `git diff -U0 \| grep -c '^-.*",$'` requires 0 and measures **4**. All four removed lines are **old mutation input/replacement strings the same row orders replaced**; none is an assertion label. The row's edits and its guard are mutually exclusive. Correct the row, record the adjudication. | `cloud-march-emission` 32/29/3 → **32/32/0**; `pinWithMutant(` = 6 before and after | 3 |
| `ARIEN_A4` | **LAND** | none | `cloud-observability-counters` 26/24/2 → **26/26/0**; order-inversion mutant reds D3 | 4 |
| `ARIEN_A5` | **LAND** | none | `eclipse-cloud-ibl-response` 18/17/1 → **18/18/0**; ambient-bypass mutant reds D1 | 5 |
| `ARIEN_B` | **LAND** | none | `cloud-reconstruction-attachments` 42/36/6 → **42/40/2**, survivors exactly F1a/F1b by design (`C13-RED-2` owns them). The row prints "42/38/2", which does not sum; the lane's re-measurement governs under R-HANDOFF-6. | 6 |

**Record once, not six times:** with all six applied, `npm run test-cloud-c13-quarantine` measures
**150 tests / 147 pass / 3 fail, exit 1** — survivors F1a, F1b (`C13-RED-2`) and S1 (`C13-N08b-C`,
NOT-SOLO). The six packets' apparently contradictory quarantine numbers are a **consistent chain**
(135 + 1+3+1+1+2+4 = 147), not a contradiction. Prettier and eslint exit 0 over all six specs.
Do **not** union these specs out of quarantine into `test-cloud-c13` in this sitting — that is
`package.json:207`, held by ulmo and manwë.

### 1.3 Anarion — 3 packets + 3 measurements (source: `cesium-webgpu-worker-archive/audit-2026-09-16/M4b-anarion-arien.md`)

| id | Verdict | Blocking fixes | Gates observed | Order |
|---|---|---|---|---|
| `ANARION_GODRAY_RANGES` | **LAND** | Record corrections only: `DEFERRED_WORK.md:2033 → :2130`, `:1660-1664 → :1757-1761`; `TOOLING_CATALOG.md` needs **no** 19→20 / 5→6 edit (that column is a **Refs** count); the row's predicted "583 lines / md5 `d0de939e…`" is superseded by the measured **579 lines / `067e2fb5…`**. | All twelve acceptance commands reproduced: 19/16/3 (B4,C2,C3) → **20/20/0**; EDIT-2-reverted control **20/18/2** with `not ok 10 - B4` *and* `not ok 20 - E6`; aggregate `npm run test-cloud-c13` **541/541/0** on the built clone | after Arien |
| `ANARION_SCHEDULE` | **LAND-WITH-FIXES** — needs a **seat scope stamp** | (a) Disclosed scope deviation: the C13-42f row's Files column is three `lib/` files and says "Do NOT re-dispatch the code"; this unit edits `probe-c13-42-reported-demos.mjs` and `probe-runtime-lifecycle-adoption.spec.mjs`. The deviation is **correct on the merits** — the schedule has 8 subjects against the guard's literal 7 — so this is an adjudication, not a rework. (b) **File collision with Aldarion**: both edit `probe-runtime-lifecycle-adoption.spec.mjs` in non-overlapping regions; whichever lands second must be applied `-3` and the spec re-run. | 54/54/0; two mutants kill it, including running new test I against the **unrepaired HEAD probe** | last |
| `ANARION_N07A` | **RETURN — must not land** | With the patch applied, `cloud-scenes-contract.spec.mjs` is **8/7/1 exit 1** on main (clean HEAD 8/8/0). Missing: the two accepted WebGPU baselines under `Tools/visual-regression/baseline/` (singular, not the row's `baselines/**`), the certification runs, and the row's step-4 visual bar — the auditor read `cloud-orbital-disc.webgpu.hd.png` and it **is** a flat featureless disc. | — | does not land |
| `MEASUREMENT_C13_42G` | **LAND (record-only)** | none | Mask ancestry re-derived from the raw 452 KB `.cpuprofile`: **0.833640** — identical to the packet to six places; spec unprofiled 16/16/0 | any time |
| `MEASUREMENT_C13_42F` | **RETURN (record it)** | Prerequisite genuinely absent: both required evidence specs are untracked at the seat; the probe refuses at exit 3 before navigation | — | any time |
| `MEASUREMENT_ARIEN` / `C13-N58` | **LAND-WITH-FIXES (record-only)** | The RETURN is right for an **unbuilt** clone, but the row's full acceptance measures **green on a built clone** (24/24/0 and 5/5/0). The seat can **close C13-N58 today** on those receipts and record the recipe correction (a build, or the one gitignored shader wrapper, is a prerequisite). | as above | any time |

**Cross-clone collision the lanes could not see** (measured today): `cesium-astra-20260914` holds its
own *different* edits to **five of Arien's six specs** plus 20 engine/shader files. Arien's repairs are
**never worse than HEAD against that engine and better in four of six**, so neither blocks the other —
but before the preview lands the seat must diff those five files and pick one owner per file. Concretely,
A1's new `…length, 3` consumption pin and A5's `?? 10.0` anchor both need re-anchoring against the preview.

### 1.4 What lands tonight, what returns

**Lands tonight (after 19:00 ET), Node-only, no Edge slot:** six Arien packets; Anarion godray; eight
Aldarion packets; Anarion schedule (after the scope stamp and the order call vs Aldarion); three
record-only measurement closures. **Sixteen packets + four records.**

**Returns:** `ANARION_N07A` only — and it returns to a **blocked row**, not to Astra. No worker can fix
it: `capture-and-diff.mjs:801-805` refuses a dirty candidate, inserting the scene entries necessarily
dirties the tree, and a worker may not commit. `C13-N48` (baseline-promotion bindability) owns the
missing route; the seat must supply it before C13-N07a is re-dispatched.

---

## 2. The cloud stack

### 2.1 The chain as Astra states it

43 freeze manifests, all integrity-verified; the dependency graph resolves to **one linear chain of 40
accepted units** plus **3 excluded side branches** (M1 §3). The live preview is byte-identical to its
newest freezes for every file — nothing has drifted.

```
 1 PREVIEW -> 2 LAYERS -> 3 LIGHTING -> 4 DIRECTIONAL -> 5 CIRCULATION -> 6 CONTRAST -> 7 BILLOW
 -> 8 EMPTY_WORK -> 9 THIN_LIGHT -> 10 MARCH_GRID -> 11 MARCH_BUDGET -> 12 RAY_NOISE -> 13 NEAR_LIGHT
 -> 14 LAYER_SCALE -> 15 GENUS_SCALE -> 16 BILLOW_WARP -> 17 ICE_FILAMENTS -> 18 CLEAR_GAPS
 -> 19 ICE_CELLULAR -> 20 COLOR_COMPOSITE -> 21 BILLOW_SCALE -> 22 WEATHER_COHERENCE
       |- 23 DIRECT_LIGHT_CULL   EXCLUDED (RETURN, removed from source; NO withdrawal record)
 -> 24 DISTANT_MARCH -> 25 TEMPORAL_MOTION -> 26 INTERLEAVED_CLOUD
       |- 27 LIGHT_REUSE         EXCLUDED / WITHDRAWN (record exemplary)
 -> 28 AUTO_TEMPORAL -> 29 HORIZON_MARCH -> 30 LIGHT_GRID
       |- 31 JITTER_CADENCE      EXCLUDED / WITHDRAWN (verified out of source, module AND bundle)
 -> 32 LIGHT_GRID_REUSE -> [33, 34 NOT RECONSTRUCTIBLE] -> 35 STARTUP_PIPELINE -> 36 WEATHER_WORKER
 -> 37 ASYNC_PIPELINE (RETURN, carried) -> 38 WEATHER_SKIPPING -> 39 PROJECTED_DETAIL
 -> 41 TEMPORAL_RETENTION -> 43 PIXEL_FOOTPRINT (RETURN/WIP, ENABLED) -> 44 AUXILIARY_PIPELINES
 -> 45 NOISE_REPLACEMENT -> 46 LIGHT_COMPUTE -> 47 NOISE_COMPUTE (RETURN/WIP)   <- HEAD
```

Astra's own tally across the 43 freezes: **LAND 17, RETURN 6, RETURN/WIP 3, WITHDRAWN 2, none stated
15**. That last number is itself a record defect — the handoff, the freezes and the evidence index all
key on per-unit verdicts, and a third of the stack has no machine-readable disposition. A second record
defect: **units 33 and 34 are not reconstructible** (four study directories occupy that window for two
numbers; the grouping was never written down).

### 2.2 Per-unit verdict table

Reviewer verdict = the station-3 verdict from the five cluster reviews, each of which re-derived ≥2
premises per unit at the seat and ran its own inertness mutants. "Default impact" answers *inside an
opted-in volumetric collection* — **no unit anywhere changes the default Cesium image**, because
`CloudVolumetrics.js:51` is `this.enabled = options.enabled ?? false` and `CloudCollection.js:218-222`
defaults `renderMode` to `BILLBOARD` (re-verified by me today in the Astra clone).
Evidence grade: **S**trong / **A**dequate / **W**eak.

| # | Unit | Class | Astra | Reviewer | Blocking finding | Parity | Default impact | Ev |
|---|---|---|---|---|---|---|---|---|
| 1 | CLOUD_PREVIEW | foundation | RETURN | **RETURN** | It **is** the re-integration of L3/L4/L5; its own MUTANT 0 and its only reach-the-image test are dead; owed lane Edge legs + inherited comment cleanup | gap | none | A |
| 2 | LAYERS | foundation | — | **LAND-WITH-FIXES** | F1: gating `selectCloudLayer` index 1/2 false — mid/high silently inherit the LOW optical profile — passes 15/15 | gap | none | A |
| 3 | LIGHTING (= PLANETARY) | foundation | — | **LAND-WITH-FIXES** | F2 **BLOCKER**: the photometry library's inverse no longer inverts the shader; F3: night figure overstated 11.8× | gap | `cloudPlanetaryLighting` **true** (`:212`); user `sunLightColor` silently dropped on the LUT path | A |
| 4 | DIRECTIONAL_LIGHTING | foundation | RETURN | **RETURN** | F5: `silverLining = min(silverLining, 0.0)` → 3/3 green; F7: the 300 default | gap | `cloudSunIntensity` 10 → **300** (`:3641`) | W |
| 5 | CIRCULATION | shape/weather | RETURN | **RETURN** | Default flip costs ≈2.5 s first-frame main-thread stall; must not land ahead of unit 36 | none (backend-neutral) | `cloudWeatherMap` false → **true** (`:285`) | A |
| 6 | CONTRAST | shape | RETURN | **RETURN** | Unvalidated 3.64× exposure bundled with two mechanisms; double-compensates against unit 20 | gap | exposure 0.22 → **0.8** (`:3979`) | A |
| 7 | BILLOW | shape | RETURN | **RETURN** | +89.5 % on the ground cloud pass of the **new default**; deleted a tracked C13-N34 correction comment | gap | `cloudNoiseMorphology` undefined → billowy | A |
| 8 | EMPTY_WORK | march | — | **LAND-WITH-FIXES** | F2: its own mutant unreachable (spec aborts on a 5-arg pin); F1: measured deltas lost their explanation when the premise was retracted | gap | image deltas | W |
| 9 | THIN_LIGHT | foundation | — | **LAND-WITH-FIXES** | F5: `blend * 0.0` makes the thin path unreachable → 6/6 green | gap | `cloudThinLayerLighting` **true** (`:216`) | A |
| 10 | MARCH_GRID | march | — | **LAND-WITH-FIXES** | F3 **BLOCKER**: `package.json:207` appended in-tree; F4: rewrote an Edge probe's verdicts and never ran it | gap | `cloudMarchStepGrowth` 1.025 | S |
| 11 | MARCH_BUDGET | march | — | **LAND** | none (must follow 10) | none owed | none | S |
| 12 | RAY_NOISE | march | — | **RETURN** | F5: `cloudRaySpatialPhase → return 0.5;` leaves the spec 7/7 | gap | default ray phase | A |
| 13 | NEAR_LIGHT | foundation | — | **LAND-WITH-FIXES** | cosmetic only (magic constants, prettier) | gap | replaces the default cone | S |
| 14 | LAYER_SCALE | shape | — | **LAND-WITH-FIXES** | JSDoc + two magic numbers + the F3 clamp | gap | none | S |
| 15 | GENUS_SCALE | shape | — | **LAND-WITH-FIXES** | F3: NIMBOSTRATUS `puffSize 0.16` sits on a WGSL `round()` tie — GPU 22 vs spec evaluator 23 | partial | genus defaults | W |
| 16 | BILLOW_WARP | shape | — | **LAND-WITH-FIXES** | gallery has 8 "after" images and no control | gap | default warp | W |
| 17 | ICE_FILAMENTS | shape | — | **RETURN** | F1 **proof-bar**: `cloudFibreErodedDensity → return density;` survives every spec that names it | gap | fibrous profile | A |
| 18 | CLEAR_GAPS | shape | — | **LAND-WITH-FIXES** | host spec 6/7 for an unrelated stale pin | gap | coverage floor | S |
| 19 | ICE_CELLULAR | shape | — | **LAND-WITH-FIXES** | far-field ice population unmeasured ("resolved" vs "removed") | gap | ice channel | S |
| 20 | COLOR_COMPOSITE | shape | — | **RETURN** | Disarms C13-N20's refuting mutant and its reach-the-image predicate; breaks the photometry transfer premise; **edits the §9.2-forbidden spec** | gap | composite | S |
| 21 | BILLOW_SCALE | shape | LAND | **LAND-WITH-FIXES** | unbounded derived frequency | gap | none at the 0.45 default | A |
| 22 | WEATHER_COHERENCE | shape | LAND | **LAND-WITH-FIXES** | blocked only by its RETURN parent (unit 5) | none | default procedural layers | S |
| 23 | DIRECT_LIGHT_CULL | withdrawn | RETURN | **NOT-A-CANDIDATE** | F15: removed from source with **no withdrawal record** | n/a | none | S |
| 24 | DISTANT_MARCH | march | LAND | **LAND-WITH-FIXES** | two contrary near-field rows with an unnamed mechanism | gap | distant march | S |
| 25 | TEMPORAL_MOTION | temporal | LAND | **LAND-WITH-FIXES** | F2: its acceptance evidence predates unit 26's rewrite of its own call site | gap | moving frames | S |
| 26 | INTERLEAVED_CLOUD | march | LAND | **LAND-WITH-FIXES** | F9 **ruling**: repurposes L3's frozen uniform slot 175 | gap | packed march | S |
| 27 | LIGHT_REUSE | withdrawn | RETURN | **NOT-A-CANDIDATE** | none — the withdrawal record is exemplary | n/a | none | S |
| 28 | AUTO_TEMPORAL | temporal | LAND | **RETURN** | F1 **BLOCKER**: deletes L3's frozen `resolveTier` band **and** appends to `package.json:207` **and** its proving spec crashes at module load | gap | **largest** — auto ground/flight 96 steps full-res → 48 steps half-res + temporal | A |
| 29 | HORIZON_MARCH | march | LAND | **LAND-WITH-FIXES** | F6: headline "30 km" and the ~24 % figure are stale against unit 39; F7: sunset-ground +40 % unexplained | gap | horizon merge | A |
| 30 | LIGHT_GRID | foundation | LAND | **LAND-WITH-FIXES** | 13.5 MB `rgba16float` allocated unconditionally; two adverse table rows unnamed in the prose | gap | lighting volume | S |
| 31 | JITTER_CADENCE | withdrawn | RETURN | **NOT-A-CANDIDATE** | none — verified out of source, generated module and bundle | n/a | none | S |
| 32 | LIGHT_GRID_REUSE | foundation | LAND | **LAND-WITH-FIXES** | F6: view-uniform whitelist unguarded above slot 251 and at 97 → stale baked lighting forever, 9/9 green | gap | none (byte-identical) | S |
| 35 | STARTUP_PIPELINE | pipelines | LAND | **LAND-WITH-FIXES** | no behaviour spec and no inertness mutant of its own | none | none (byte-identical) | S |
| 36 | WEATHER_WORKER | pipelines | LAND | **LAND-WITH-FIXES** | 2-line stale-stub spec repair; +12.35 s (+44 %) init regression unexplained; ≈3.75 s cloudless-startup transient ungated | none | none (byte-identical) | S |
| 37 | ASYNC_PIPELINE | pipelines | RETURN | **RETURN** | Exact-image gate FAIL: 1 px, 1 channel, 1/255 at **(1120, 922)**, cause not isolated. **10 stacked units wait on it.** | none | none | A |
| 38 | WEATHER_SKIPPING | pipelines | LAND | **LAND-WITH-FIXES** | F2 **proof-bar**: the shader-side skip survives a **non-conservative** mutant and `cloudWeatherIntervalEmpty` appears in **zero** specs | **recorded gap** | on by default, byte-identical | S |
| 39 | PROJECTED_DETAIL | temporal | LAND | **LAND-WITH-FIXES** | F3: no inertness mutant; no timing for an always-on 2× `getWorldRay`-per-fragment cost | gap | `projectedDetailEnabled` **true** (`:1312`) | S |
| 41 | TEMPORAL_RETENTION | temporal | LAND | **LAND-WITH-FIXES** | owes a parity/ledger row, the §7-step-12 section, and one case for the `0<blend<1` path | gap | retention | S |
| 43 | PIXEL_FOOTPRINT | temporal | **RETURN/WIP** | **RETURN** | F4: **enabled by default while RETURN/WIP**; reconstruction MAE worsens in ground/orbit/terminator; units 44–47 stacked on it | gap | `pixelFootprintSamplingEnabled` **true** (`:1313`) | A |
| 44 | AUXILIARY_PIPELINES | pipelines | LAND | **LAND-WITH-FIXES** | name the reference run in the byte-identity claim; file the `optional-paths.png` shadow/banding artifact | none | none (byte-identical) | S |
| 45 | NOISE_REPLACEMENT | pipelines | LAND | **LAND** | none — fixes a **real use-after-destroy on main**; cherry-pickable | none | none | S |
| 46 | LIGHT_COMPUTE | pipelines | LAND | **LAND-WITH-FIXES** | 4 ESLint errors + prettier in its own new file; permanent-failure rethrow every frame with no throttle and no log | none | none (byte-identical) | S |
| 47 | NOISE_COMPUTE | pipelines | **RETURN/WIP** | **RETURN** | Exact-image gate FAIL at **(1296, 782)**; and its four settled views were captured with renderer `6f2c69c693`, **not** the frozen `3e675db81c` — the comparison crosses a build boundary | none | none | A |

**Reviewer tally: 2 LAND · 26 LAND-WITH-FIXES · 12 RETURN · 3 NOT-A-CANDIDATE.**

Studies with no production delta (14 directories, all SELF-VERDICT RETURN or PROGRESS) are excluded,
but two carry findings worth keeping: `FIBRE_STUDY` — removing the shadow march drops dense cirrus
**172.98 → 22.75 ms**, so *repeated lighting-density sampling, not the view march, is the dominant
cost*; and `DENSITY_FILTER_ISOLATION` — the cache is 8.8–12.2 % over on fresh mean alpha *before*
reconstruction, so scheduler-only work cannot repair it.

### 2.3 Cross-cutting findings, ranked — rule violations first

**X1 — HELD-file breach (BLOCKER, seat act).** 22 of Astra's 76 dirty paths are held by the three still
frozen lanes (ulmo 11, manwë 7, ossë 10; re-measured today at `9f3723b0b3`). Worst cases:
`WebGPUProceduralCloudRenderer.ts` held by **both** ulmo and ossë while Astra changed it +916/−576;
`ProceduralClouds.wgsl` held by manwë while Astra changed it +1412/−328; three spec files created
**independently in two clones**; and `cloud-genus-morphology.spec.mjs`, which
`SOLO_WORKER_HANDOFF_2026-09-13.md:340` §9.2 names as touchable by **no** solo row, changed +124/−15
(M2 F1).

**X2 — `package.json` written in-tree (BLOCKER, seat act).** `:207` (`test-cloud-c13`) and `:209`
(`test-visual-regression-node`) were appended in-tree — exactly the two lines §9.2 forbids while
ulmo/manwë/ossë hold them, and directs the lane to put verbatim in the packet for the seat to union.
The appends themselves are **clean and strictly add-only**: 93 keys before and after, no key or token
removed, no spec homed in two runners, and all 16 new specs get a runner home (M2 §4). The defect is the
**write location**. `MARCH_GRID` (unit 10) and `AUTO_TEMPORAL` (unit 28) are the two units that did it.

**X3 — Proof bar R-2026-08-29-1 is met only on its first leg.** Behaviour specs exist and are real —
across the five reviews **60+ independent mutants** were run and most died. But:

* **Five deliverables survive a call-site inertness mutant with every spec green**: LAYERS'
  `selectCloudLayer` (`ProceduralClouds.wgsl:401-406`), DIRECTIONAL's silver lining (`:3413`),
  THIN_LIGHT's thin-layer dispatch (`:2383`), LIGHT_GRID_REUSE's view-uniform whitelist
  (`WebGPUCloudLightGrid.ts:54-62`), ICE_FILAMENTS' erosion (`CloudDensityDomain.wgsl:97-99`), plus
  RAY_NOISE (`:503-508`) and WEATHER_SKIPPING's shader half (`:735-737`). That is **seven** distinct
  mechanisms that can be made inert without a test noticing.
* **Three of Astra's own mutants are vacuous**: `cloud-aerial-path-length` MUTANT 0 ("matched nothing —
  this spec is stale"), `cloud-tier-lighting-dials` MUTANT 5 (aborts on `array<CloudLayerDensityDomain`),
  and `cloud-shaped-coverage`'s guard-removal mutant (the spec aborts on a stale 5-arg pin before
  reaching it).
* **There is no independent reviewer and no named Edge leg for any of the 43 units.** Every verdict is
  a SELF-review by the agent that wrote the code. The solo handoff authorises that; Principle 10 says it
  is not an independent check. And no capture in the stack is an Edge leg in the two-tree sense —
  the implement scripts revert-and-re-apply **inside one tree**, which §7 step 9 / seat ruling 10 forbid.
  Provenance is fully recorded (served-md5 == disk-md5, base commit, per-shader sha256), so this is an
  evidence-*class* gap, not a provenance failure — but the seat must not treat any of them as the named
  Edge leg.

**X4 — C16 comment-marker ratchet (BLOCKER at the landing gate).** Astra's tree takes
`comment-marker-guard --verify-cleanlist` from **18 REGRESSED / 6 files to 60 / 13 files**, and the
census from **199 to 241 markers**. The +42 lands in `WebGPUCloudTierPresets.ts` (22),
`ProceduralClouds.wgsl` (13), `WebGPUProceduralCloudRenderer.ts` (6), `CloudTypeProfile.js` (2) and
three Weather TS files (3); `CloudVolumetrics.js` improves 11 → 7. **All five cloud files are already on
`comment-marker-cleanlist.txt`**, so `verify-landing-compliance.mjs:483` and `.github/workflows/dev.yml:79,83`
reject the batch. Invisible from inside either lane: Gemini never audited those files and the solo
self-review bar does not run the C16 guard (M5 §e).

**X5 — Parity, R-2026-09-12-8.** Zero GLSL and zero `Source/Renderer/` files outside `WebGPU/` in any of
the 43 freezes ⇒ the stack is **one recorded gap of 73 paths / ~4,241 WGSL lines**. Per the ruling that
is a gap to record, not a rejection — but **it is recorded nowhere**: `DEFERRED_WORK.md` and
`FEATURE_INVENTORY.md` are byte-identical to HEAD in Astra's clone, and the packet-verbatim route §7
step 10 prescribes was not used either. Three of the new public dials (`cloudPlanetaryLighting`,
`cloudLayers`, `cloudSunIntensity`) are documented **without** the "WebGPU only" note their siblings
carry, so the API itself does not record the gap. Two units (MARCH_GRID, INTERLEAVED_CLOUD) are large
enough that a WebGL twin is a *project*, not a port.

**X6 — Uniform consistency: the memory image is right, every guard that proves it is red.** JS and WGSL
both compute **260 floats**, append-only, vec4-aligned, and every *production* packer/consumer site
agrees (M2 §3.3). But `cloud-genus-morphology.spec.mjs:146` and `cloud-primary-shell.spec.mjs:525` still
pin the old five-term formula, `cloud-tier-lighting-dials.spec.mjs` cannot parse `array<…>`, and
`cloud-tier-single-source.spec.mjs:214` cannot follow the new import — so all four guards are red. Worse,
**three stale mirrors of one memory image coexist**: `probe-cloud-density-domain.mjs:1000` asserts 176,
`cloud-tier-lighting-dials.spec.mjs:222` asserts 216, the tree computes 260. The first of those is an
**Edge probe** — it will fail on the first leg that runs it, in either landing direction.

**X7 — Rules that are CLEAN, stated so they are not re-litigated.** RTE: no `mvp * position`, no bare
`vec3` position attribute, no `high + low` add anywhere in 2,824 lines of WGSL diff.
`ShaderDefine`/`ShaderDefineHi`/`ShaderSourceId`: **untouched** (`git diff --stat` on
`WebGPUShaderDefines.ts` is empty). No TypeScript `any`. No `Scene → Renderer/WebGPU` import and no
`isWebGPU` branch in Scene. Barrel: 11 new `.ts` files are invisible to the `**/*.js` glob and the new
worker is correctly excluded — no `createCesiumJs` breakage. No `WEBGPU_COMPAT_EXEMPTIONS` entry owed.
`lint-debug-pragmas` clean over 283 files. **Principle 11 satisfied** (worst deletion ratio 25 %; no
whole-file rewrite). Feature-renderer pattern respected.

**X8 — File-size rule NOT satisfied.** `WebGPUProceduralCloudRenderer.ts` **5,570 → 5,910 lines** and
`ProceduralClouds.wgsl` **3,157 → 4,241 (+34 %)**, both changed functionally, both ending larger — I
re-measured both with `wc -l` today. Astra *did* extract 664 lines into five new modules, which is real
progress, but CLAUDE.md's "leave it better than you found it" is not met by a file that ends bigger.

**X9 — Default-path risk inside an opted-in collection.** 20 of 43 units change a default there. Three
are **enabled by default while carrying a RETURN/WIP verdict or an open FAIL gate**: unit 43
(`pixelFootprintSamplingEnabled`), unit 39 (`projectedDetailEnabled`), unit 38 (`weatherCoverage.enabled`).
The composed risks the reviews name: the pre-Reinhard gain moved **≈109×** (sunIntensity 10→300,
exposure 0.22→0.8, plus the `/alpha` divide) with **no joint calibration**, pushing radiance into the
Reinhard shoulder — a mechanical explanation for the "flat / too smooth" appearance Astra itself reports;
BILLOW's new default costs **+89.5 %** on the ground cloud pass; CIRCULATION's flip adds **≈2.5 s** of
first-frame main-thread stall; and the async cluster converts six synchronous startup costs into an
**ungated "no clouds for N frames" transient** (weather alone ≈3.752 s) that **no gate measures**,
because every image gate captures settled frames after 64 settling frames.

**X10 — The photometry library is wrong in three of its four declared premises.**
`Tools/visual-regression/lib/cloud-photometry.mjs` `:70` forward-operator pin is **RED** (unit 3 changed
Reinhard to `weightedColor * (cloud.exposure / alpha)` at `ProceduralClouds.wgsl:2844`); `:86`
`DEFAULT_CLOUD_EXPOSURE = 0.22` is silently stale against the packer's 0.8 (unit 6); `:111`
`DEFAULT_TRANSFER = "identity"` is silently wrong now the shader applies `pow(1/2.2)` (unit 20). Its
`inverseReinhard` is what **every photometric probe** uses to recover radiance, so it is now wrong by a
factor of alpha for every non-opaque pixel. The guard fired in the same commit exactly as its own
docstring predicted — and was left red.

**X11 — Two unexplained one-pixel image gates** (unit 37 at (1120, 922), unit 47 at (1296, 782)); both
1/255 in one channel, both with identical raw cloud buffers, both reproduced independently by an auditor
who decoded the PNGs. Two cheap, untried hypotheses exist: a **same-build repeat control** (unit 38
already did exactly this and got identical sha256s), and the **8-bit `pow(2.2)`/`pow(1/2.2)` round trip**
(measured sensitivity `d(out·255)/d(alpha) ≈ 4.3e3` at scene value 0.02, so `Δα ≈ 2.3e-4` flips one LSB).

**X12 — Against seat main the stack turns four extra contract assertions red**, and no packet says so,
because every packet compares against its own preview parent: `cloud-march-emission` A2 (exactly one
march pipeline compiles the emission bit), A3 (emitting pipelines are separate objects), B8 (WGSL and TS
twin are character-identical), G1 (no `createShaderModule` site compiles `PROCEDURAL_CLOUDS_SOURCE` raw).
These belong on the landing checklist.

**X13 — Build freshness, correctly scoped.** Four of 33 dirty engine files postdate the clone's
19:19 build — exactly the **weather-worker chain**, whose guard spec is fully red. The foundation,
lighting and march clusters are **fresh** and their symbols are present in the built bundle, and the two
withdrawn candidates (`cloudCanReuseLight`, `cloudDirectScatteredLight`) are absent from source,
generated module **and** bundle — which discharges the `buildState` warning carried in
`LIGHT_REUSE_WITHDRAWAL.json`.

### 2.4 Astra's own admissions — quoted

From Astra's own handoff — `migration_doc/ASTRA_SOLO_CLOUD_PROGRESS_AND_HANDOFF_2026-09-14.md`
in `cesium-astra-20260914`, untracked at this base:

> "**WebGL volumetric parity and full default-on quality/performance are not demonstrated.**" (open issue 8)

> "The cumulative preview still includes known predecessor acceptance/landing issues. **Focused tests
> passing does not mean the entire npm suite, foundation integration or campaign is green.**" (issue 10)

> "The combined foundation preview **remains RETURN for main landing**: original lane acceptance and
> inherited comment cleanup are still owed." (`:95`)

> "Clouds are still below the realism target: soft pale low decks, coarse billows, grain/bands, limited
> horizon population, simplified storm tops and curled/bloblike ice." (issue 1)

> "**Some testing and documentation effort was excessive relative to visible product progress.** … stale
> parser/stub dependencies, capture readiness mistakes and repeated fine-grained timing runs consumed
> effort without improving cloud appearance."

> "Product files accounted for 61 files / 7,799 added lines; tools/tests 147 / 54,563; records 30 /
> 10,230. **This supports the concern about the balance of work.**"

And per unit: unit 43 — "**Do not treat the capture's PASS as image acceptance**"; unit 47 —
"**Retained red** … **Its cause is not isolated**"; unit 44 — "the broader attachment tests retain
**exactly the same 13 failures as the parent**"; the experiments table — "**Do not accidentally integrate
these because their timing numbers look attractive.**"; and the standing performance caveat — the
matched-clock wins "are different experiments with different parents and are **not additive, application
FPS, or a clean final-stack speedup**."

Two of those deserve emphasis because they are the seat's own conclusion too: the stack is **opt-in**
(nothing changes the default Cesium image), and it is **not landing-ready** by its author's own words.

---

## 3. Gates as measured at the clone

All rows measured in `cesium-astra-20260914` (HEAD `c325f858c3`, dirty = the cumulative
preview) against a pristine HEAD baseline materialised with `git archive` plus regenerated WGSL modules
(fidelity confirmed: `Moon.js`/`SkyAtmosphere.js`/`Sun.js` round-trip byte-identical). Source:
`cesium-webgpu-worker-archive/audit-2026-09-16/M2-diff-and-gates.md` §2, plus M5 §e for the C16 rows and M1 §7 for the seat-main comparison.

| Gate | Astra's clone | HEAD baseline | Verdict |
|---|---|---|---|
| `node --check` (42 changed/new js/mjs) | 42 pass / 0 fail | — | **PASS** |
| `npx tsc --noEmit -p packages/engine` | **0 errors**, 2,258 files in program | 0 | **PASS** |
| `npm run tsc-engine` | exit 0 | exit 0 | **PASS** |
| `npm run lint-debug-pragmas` | clean, 283 files | clean, 277–278 | **PASS** |
| `node Tools/spec-runner-census.mjs` | 377 specs / 171 homed / **206 orphaned** | 377 / 168 / 209 | **PASS** (orphans went *down*) |
| RTE / ShaderDefine / any-ban / barrel / compat-exemptions / Principle 11 | all clean | — | **PASS** |
| `SEATBELT_FROZEN=1 npx eslint` (27 changed engine files) | **15 errors**, 62 warnings, 6 files — *all on added lines*, none in `eslint.seatbelt.tsv`; frozen `curly` count for the renderer drifted 12→10 | 0 | **FAIL** |
| `npx prettier --check` (74 files) | **45 fail** | **0 fail** | **FAIL** |
| `npm run test-cloud-c13` | 730 tests / 693 pass / **37 fail**, 220 s, exit 1 | 5 fail over the same 25 specs | **FAIL — 32 new** |
| `npm run test-visual-regression-node` | 423 / 421 / **2 fail** | 0 fail (both specs 15/15 and 17/17) | **FAIL — 2 regressions** |
| `npm run test-cloud-c13-quarantine` | 150 / 129 / **21 fail** | 15 fail | **FAIL — +6** |
| Astra's 16 **new** specs, run individually | **11 pass / 5 fail** | n/a | **FAIL** |
| `comment-marker-guard --verify-cleanlist` | **60 REGRESSED / 13 files** | **18 / 6** | **FAIL — +42** |
| `comment-marker-guard` census | **241 markers / 95 files** | 199 / 88 | **FAIL — +42** |
| `npm run test-c16` | — | `not ok 15` (78 pass / 1 fail) | **RED AT HEAD** |
| `npm run eslint` (CI glob) | — | **6 `new-cap` errors** at HEAD (+34 from Gemini's gitignored `_lane-out/` scripts, CI-invisible) | **RED AT HEAD** |
| `cloud-march-emission` vs **seat main** | 32 / 25 / **7** | 32 / 29 / 3 | **+4 new reds** (A2, A3, B8, G1) |

The five failing new specs, with causes: `cloud-tier-single-source` **0/1 — crashes at module load**
(`constant CLOUD_LAYER_DENSITY_FLOATS not found in the engine`, `:214`); `cloud-tier-lighting-dials`
24/28 (walker aborts on `array<CloudLayerDensityDomain`); `cloud-aerial-path-length` 23/25 ("the
heuristic aerial composite could not be located — this spec is stale" + MUTANT 0 vacuous);
`procedural-weather-circulation` 10/11 (`ReferenceError: weatherTaskBufferBytes is not defined`);
`cloud-shaped-coverage` 6/7 (pinned WGSL early-out regex no longer matches its own shader).

**One correction to M2, and it matters.** M2 F4 calls `WeatherProvider.getPackedTexture()` structurally
broken (18/18 → 0/18). `cesium-webgpu-worker-archive/audit-2026-09-16/R-pipelines-async.md` §9 F1 **refutes it by execution**: the spec's stub list is
stale by one module. Adding `"WeatherMemory"` to `REAL_WEATHER_MODULES`
(`weather-provider-cache.spec.mjs:24`) takes it **0/18 → 18/18**, and the same class of two-line fix takes
`procedural-weather-circulation` **10/11 → 11/11**. So **F4 is not a BLOCKER — it is a two-line spec
repair**, and 18 of the 37 `test-cloud-c13` failures evaporate with it. A second correction:
`cloud-api-enum-reachability` is **7/7 at seat HEAD**, not 5/7 — so all three of its failures are the
stack's, not two pre-existing (R-foundation-lighting F10).

---

## 4. Collision and reconciliation with L3 / L4 / L5

### 4.1 The framing that has to change

Astra's tree is **not** a re-implementation of the frozen lanes — it is a **descendant** of all three,
combined deliberately and recorded as such. `_lane-out/CLOUD_PREVIEW_FREEZE.json` pins a 21-path
`astra-cloud-preview.patch`, and `CLOUD_PREVIEW_REVIEW_2026-09-14.md` quotes all three frozen md5s
(`Ulmo 84c96383… / Manwe fb8ac2d2… / Osse ba7a1c86…`), which the auditor re-derived with `md5sum` —
**all three match their `FREEZE_*.md5`**. So the question is not whose design wins; it is whether the
lanes' reviewed, mutant-proved, independently verified work lands in its own right, or arrives inside an
unreviewed superset in which **six of those lanes' own acceptance specs are red**.

### 4.2 Per-file overlap, measured

Union of lane-touched paths: **26**. Astra changes **21**; leaves **5** at HEAD (all ledger/config).
Of **111** lane hunks: **62 already applied** in Astra, **29 fail forward** (ulmo 15, manwë 11, ossë 3),
**20 apply cleanly** (all in the ledger files Astra never took), **3** new-file creations skipped
(Astra ships its own copy of the same-named spec). Lane `+`-runs present verbatim in Astra, engine and
spec files only: **L3 41/50 · L4 29/34 · L5 33/36**.

**Control — do the lanes conflict with each other?** Applying ulmo → manwë → ossë onto the *seat's*
files: **0 / 3 / 1 failed hunks, all in `package.json` and `QUEUE_2026-07-23_CAMPAIGN13.md`** —
**zero engine and zero spec conflicts**. That is the seat's existing union job, not a new problem.

### 4.3 Semantic comparison, row by row

| Row | Lane | Status in Astra | What changed |
|---|---|---|---|
| **C13-N10** one tier resolver | L3 Ulmo | **DIVERGED** | Carried (`buildCloudQualityBlock` ×3, `buildCloudQualityInputs` ×2, `shouldDefaultPhysicalAerial` ×3; `resolveCloudQuality` 0 hits vs 1 at HEAD) — then Astra **deleted** `if (cameraHeightMeters <= enableAltitudeMeters) return 3;` and **rewrote the lane's own byte-identity acceptance test** to a `{maxSteps:48, lightSteps:4}` reference. The spec **crashes** in Astra's tree (lane freeze: 28/28). |
| **C13-N11** tier-lighting slots 172–175 | L3 CPU + L4 WGSL | **SUPERSEDED, with a live inconsistency** | Same slots 172/173/174, lane comment block carried verbatim. But **slot 175** `_padQ` → `interleavedRefresh`, and three mirrors of one memory image disagree (probe 176 / dials 216 / tree 260). Dials spec 24/28 (lane 28/28). |
| **C13-N20** planetary aerial | L3 clause + L4 WGSL | **DIVERGED** | Both halves present (`CLOUD_AIR_SCALE_HEIGHT_M` ×4, 0 at HEAD); Astra then added `cloudDaylight` and `cloudSegmentTransmittance`, forcing two of Manwë's regexes to be relaxed. Spec 23/25 (lane 23/23), both reds being *lane* tests reporting themselves stale. **Independently: `CloudVolumetrics.js:209` `?? "heuristic"` makes L3's promotion clause unreachable through the public API.** |
| **C13-N21** per-genus phase | L4 Manwë | **SUPERSEDED** | 13/13 add-runs verbatim, all hunks already applied; `genusPhaseDelta` at slot 171, CUMULUS early return present. Astra rebound genus reads `cloud.*` → `activeCloudLayer.*` for per-layer profiles. Spec 22/23 (lane 23/23); the single red is L3's uniform-float regex, not N21. |
| **C13-N22** 1440×721 weather field | L5 Ossë | **SUPERSEDED** | `WEATHER_TEX_W/H = 1440/721` (seat: 256/128); `EdrWeatherSource.ts`, `weather-field-bounds.spec.mjs` and the EDR gallery **byte-identical** to the lane; `weather-field-bounds` 37/37 green. One red: `weather-map-seam` test 17 (Astra routes through `ProceduralWeatherMapCache` instead of importing the shared producer), 21/22 vs lane 22/22. |

**Ledger rows are absent.** `DEFERRED_WORK.md`, `FEATURE_INVENTORY.md`, `QUEUE_2026-07-23_CAMPAIGN13.md`,
`ES6_MODERNIZATION_STATUS.md` and `eslint.seatbelt.tsv` are byte-identical to HEAD in Astra's clone —
**194 lines of lane ledger missing**, including Ulmo's whole `## 7. Decomposition log`. Astra states this
deliberately ("Their ledgers and eslint seatbelt edits were not integrated").

**Direction of travel matters.** In each of the three same-named specs, Astra's edit **relaxes** a lane
assertion to accommodate Astra's own later change:

| Spec | Lane lines | Astra lines | Differing | Change |
|---|---|---|---|---|
| `cloud-tier-single-source.spec.mjs` | 1782 | 1781 | **48** | byte-identity test weakened to an "automatic atmospheric" reference; tier-lighting row flipped from "no shader consumer yet" to `assert.equal(bufferFloats, structFloats)` with hard-coded `[172,173,174]` |
| `cloud-tier-lighting-dials.spec.mjs` | 1335 | 1336 | **18** | `_padQ` → `interleavedRefresh`; `176` → `216`; `cloud.` → `activeCloudLayer.`; tail test relaxed |
| `cloud-aerial-path-length.spec.mjs` | 783 | 848 | **70** | two composite regexes relaxed; two new tests added |

**Lane acceptance specs, lane freeze vs Astra's tree:** `cloud-tier-single-source` 28/28 → **CRASH (0/1)**;
`cloud-tier-lighting-dials` 28/28 → **24/28**; `cloud-aerial-path-length` 23/23 → **23/25**;
`cloud-genus-morphology` 23/23 → **22/23**; `cloud-primary-shell` green → **8/9**; `weather-map-seam`
22/22 → **21/22**. `weather-field-bounds` 37/37, `cloud-probe-harness`, `cloud-ray-jitter` and
`cloud-temporal-rte` stay green. **Six of ten red, and all six reds are the lanes' own acceptance.**

### 4.4 The three options, with measured cost

**Option A — land L3 → L4 → L5 frozen first, then rebase Astra.**
*Cost on the lanes: near zero* — the three patches stack on seat HEAD with 4 failed hunks, all
`package.json` + `QUEUE`, both already the seat's union step.
*Cost on Astra: low and already measured.* Against a reconstructed post-landing tree, **five of the 26
union paths are already IDENTICAL** (`EdrWeatherSource.ts`, `cloud-probe-harness.spec.mjs`,
`probe-cloud-density-domain.mjs`, `weather-field-bounds.spec.mjs`, the EDR gallery), five more are
lane-only ledger files, and **for the remaining sixteen the resolution is literally "keep Astra's file"**
— its working copy *is* the intended end state of its own stack. Residual work = the five spec repairs
Astra owes anyway, plus the ledger union the seat already owns.
*The real cost in direction A is schedule, not merge*: the owed Edge legs (§8).

**Option B — land Astra first, then rebase the lanes.**
*Cost on Astra: it is not landable as it stands* — its own doc marks the combined preview RETURN, six
specs are red, three stale mirrors of the uniform count coexist.
*Cost on the lanes: high and mostly wasted* — 29 of 111 hunks reject, 62 are already applied (a no-op
that still has to be proven), and the engine change arrives with **no green acceptance spec at all**.
Reconstructing each lane's proof against Astra's tree is a full re-verification of five rows, and the
lanes' *reviewed* assertions — the ones Astra relaxed — would have to be re-argued rather than
re-applied. Also lost: 194 lines of lane ledger and the seatbelt line.

**Option C — cherry-pick / drop a lane. None can be dropped.** N22 is closest (four paths byte-identical,
37/37 green) and still is not subsumed: its delegation assertion is red, its ledger row is absent, Edge
leg 4 has never run. N10 is diverged and its spec crashes; N11 has three coexisting float counts; N20 is
shown unreachable through the public default; N21 was rebound to `activeCloudLayer.*`.

### 4.5 Recommendation

> **OPTION A. Land L3 → L4 → L5 in their frozen, reviewed form first (after their owed Edge legs), then
> rebase Astra's stack onto the result. Drop no lane.**

Reasoning in order of weight:

1. **The merge is free in direction A and expensive in B** — measured, not argued (0 engine/spec
   conflicts between the lanes vs 29 rejecting hunks the other way).
2. **Astra's tree already *is* the lanes plus more**, so landing the lanes costs Astra almost nothing:
   16 of 26 paths resolve to "keep Astra's file".
3. **Proof-bar direction.** The lanes have a behaviour spec, an inertness mutant, a **separate** review
   (`REVIEW_GERONTIUS`, `REVIEW_PALADIN`, `REVIEW_MALVEGIL`) and an **adversarial verification**
   (`VERIFY_ISUMBRAS`, `VERIFY_SARADOC`) — everything but the Edge leg. Astra's versions are
   self-reviewed, relaxed in three places, and red in six. Landing B first would put N10/N11/N20/N21/N22
   into main with **no green acceptance at all** — precisely the inversion Principle 10 exists to prevent.
4. **Landing the lanes first gives Astra the one thing it lacks:** a committed, reviewed baseline to
   rebase against, so the six red specs become a scoped repair on a known-good tip rather than an
   argument between two uncommitted trees.
5. **Drop no lane** — every row still owes its ledger line, its runner home and its Edge leg regardless
   of Astra, and the seat unions the shared files in both directions anyway.

**Three rulings are needed before *either* direction proceeds** — see §7 D2, D3, D4.

---

## 5. Low-hanging improvements, ranked

Value ÷ cost, highest first. "Owner" is who can actually do it under the held-file rules: **Astra**
(own clone, files it already holds), **Gemini** (bounded, docs-shaped), **seat** (held files, rulings,
unions). Every item carries a file:line.

| # | Improvement | file:line | Cost | Owner | Value |
|---|---|---|---|---|---|
| 1 | Add `"WeatherMemory"` to `REAL_WEATHER_MODULES`; add `weatherTaskBufferBytes` + `WEATHER_BUFFER_BUDGET` to the circulation spec's VM sandbox | `weather-provider-cache.spec.mjs:24`; `procedural-weather-circulation.spec.mjs:253-257` | **2 lines** | Astra | 0/18 → **18/18** and 10/11 → **11/11**, measured. Removes a claimed BLOCKER and 19 of 37 `test-cloud-c13` failures |
| 2 | Accept the six-argument `CloudMacroSample` in the pinned regex | `cloud-shaped-coverage.spec.mjs:106` | **1 line** | Astra | Resurrects EMPTY_WORK's dead mutant **and** re-arms CONTRAST's and CLEAR_GAPS' live guards; removes another red |
| 3 | Fix `lib/cloud-photometry.mjs`'s **operator**, not just its pin: `:68-73` forward line **and** `inverseReinhard` (alpha factor), `:86` `0.22 → 0.8`, `:99-111` declare the `pow(1/2.2)` encode | `Tools/visual-regression/lib/cloud-photometry.mjs` | ~15 lines | Astra | Three of four premises are wrong today; every photometric probe recovers the wrong quantity |
| 4 | **Same-build repeat control** for the two one-pixel gates (capture `high-first` twice from the identical unit-37 build, `orbit-candidate` twice from the **frozen** unit-47 build) | `capture-cloud-async-pipeline.mjs`, `capture-cloud-noise-compute.mjs` | 2 capture runs (**Edge slot**) | Astra | If a same-build repeat also differs by one pixel, both gates are GPU nondeterminism and **ten stacked units unblock at once**. Unit 38 already proved the harness works |
| 5 | Extend the two frozen-offset regexes to the live eight-term `CLOUD_UNIFORM_FLOATS` formula, prefix-anchored | `cloud-genus-morphology.spec.mjs:146`; `cloud-primary-shell.spec.mjs:525` | 2 regexes | **seat** (genus-morphology is §9.2-forbidden — packet verbatim) | Restores the add-only guard the whole stack depends on |
| 6 | Execute `selectCloudLayer` field-by-field at indices 0/1/2 (the harness exists at `cloud-direct-lighting.spec.mjs:11-13`) | `cloud-independent-layers.spec.mjs:147` | ~30 lines | Astra | Closes the cluster's largest proof gap (X3) |
| 7 | Assert that erosion erodes: `assert.ok(result < density)` for `0<erosion<1`, `assert.equal(erode(1,0.5),0.5)` | `cloud-billowy-shape.spec.mjs:200-206` | **2 lines** | Astra | Converts ICE_FILAMENTS from RETURN to LAND-WITH-FIXES |
| 8 | Node spec + inertness mutant for `cloudWeatherIntervalEmpty` (transliterate the query as `:23-29` already does for the CPU pyramid; mutate the `+1/sourceSize` term and require RED) | `cloud-weather-skipping.spec.mjs` | ~60 lines | Astra | The only semantic check on an **on-by-default** skip that can erase cloud bands is currently a browser capture |
| 9 | Re-anchor C13-N20's composite locator: allow an optional `cloudDisplayToLinear(` wrapper | `cloud-aerial-path-length.spec.mjs:587, :652` | 2 regexes | seat/Astra (double-homed with Manwë) | Re-arms a refuting mutant for an already-accepted row |
| 10 | Give RAY_NOISE a shader-level behaviour spec via `compileFunction`, keeping the JS twin as an equality oracle | `cloud-ray-jitter.spec.mjs:68-81` | ~20 lines | Astra | Converts a banked 327,744-value browser match into an enforced contract; closes a proof-bar failure |
| 11 | Paste the proven projected-detail mutant (`0.0005 → 0.0000001`) into the spec | `cloud-march-grid.spec.mjs` after `:347` | ~6 lines | Astra | Already proven to red 2 tests; closes unit 39's R-2026-08-29-1 gap |
| 12 | Size the light-grid harness from `CLOUD_UNIFORM_FLOATS` and assert the whitelist is total | `cloud-light-grid.spec.mjs:120, :141` | ~6 lines | Astra | Stops a stale baked lighting volume being reused forever after a future slot append |
| 13 | Clear `_failed` on any change to `_wanted`, or bounded retry (3 then latch and log once) | `ProceduralWeatherMapCache.ts:16, :27` | ~4 lines + 1 test | Astra | Today **one** transient failure means a permanently cloudless sky behind a single console line |
| 14 | JSDoc the five new public dials with `@type` + the "WebGPU only." sentence their siblings carry | `CloudVolumetrics.js:152, :212, :216, :238, :286` | ~25 lines | Astra **or Gemini** (bounded, docs-shaped) | Fixes 2–3 live `cloud-api-enum-reachability` failures *and* records the parity gap in the API |
| 15 | Assert the thin-layer dispatch behaviourally (stub `lightMarchThinLayer→1` etc. and assert the return at blend 1 / 0.5 / 0) | `cloud-thin-layer-lighting.spec.mjs:65-85` | ~15 lines | Astra | Closes half of the DIRECTIONAL/THIN_LIGHT inertness hole |
| 16 | Allocate the 13.5 MB lighting volume lazily (move the create out of `ensureCloudCache` into the first frame where `lightGridBlend > 0`) | `WebGPUProceduralCloudRenderer.ts:3184` → `:4455` | ~5 lines | Astra | Orbital-only sessions currently pay 14,155,776 bytes and never write a texel |
| 17 | Move NIMBOSTRATUS off the WGSL `round()` tie (`0.16 → 0.15`) and clamp the derived warp frequency `min(…, 64.0)` | `CloudTypeProfile.js:328`; `CloudDensityDomain.wgsl:82` | 1 char + 1 call | **seat** (CloudTypeProfile held by Manwë → packet) | Removes a one-octave CPU/GPU divergence for a genus a user can select today, and bounds an unbounded dial |
| 18 | Dependency-completeness assertion in the stub bundler: name the missing module instead of "Cannot convert object to primitive value" | `Tools/visual-regression/lib/engine-stub-bundler.mjs` | ~15 lines | Astra or a seat lane | This exact defect has bitten **four** specs in this stack; turns a 40-minute diagnosis into 10 seconds |
| 19 | `prettier --write` + `eslint --fix` over the 45 / 15 | the M2 §2.2/§2.3 file lists | mechanical | Astra, **seat sequences** the seatbelt (`eslint.seatbelt.tsv` held by Ulmo; `curly` count drifted 12→10) | Two red gates go green; zero of these failures exist at HEAD |
| 20 | One combined `DEFERRED_WORK.md` row + one `FEATURE_INVENTORY.md` §C row covering all WGSL-only cloud units, **written verbatim into the packet** because the files are held | packet → `migration_doc/` | 2 paragraphs | **seat** (Gemini can draft) | Discharges R-2026-09-12-8 bookkeeping for 43 units that currently record nothing |

**Also worth doing, cheap, outside the cloud stack:** pass the ellipsoid-corrected `mu` from
`cloudSunVisibility` into `cloudDaylight` (`ProceduralClouds.wgsl:2876-2882` → `:2896`, ~4 lines — likely
fixes the "very dark sunset" Astra reports); name the inline tuning constants
(`:2514` exponent 32, `:2138` the two 100.0s, `:2144` 25.0, `CloudTemporalResolve.wgsl:390`,
`ProceduralClouds.wgsl:2604`, `:3151`, `:3316`); write the missing `DIRECT_LIGHT_CULL` withdrawal record
(copy `LIGHT_REUSE_WITHDRAWAL.json`'s shape, ~20 lines of JSON); add the permanent-failure sentinel to
`WebGPUCloudPipelineReadiness.ts:54-57` (CLAUDE.md makes retry exhaustion an unwrapped `console.error`,
preferably via `context.log`); re-point the handoff's **28 absolute `F:/Dev/GH/…` links** into the
gitignored `output/` folder; and file the three Aldarion follow-ups (`lib/probe-runtime.mjs:665`
argv-null deref — **confirmed real at HEAD**; `sandcastleTemplate.spec.mjs` 15-temp-dir leak per run;
gallery adoption of `__sandcastleSmokeReady`).

---

## 6. Gemini's cloud-relevant findings

**Verified and worth a row (2 of ~113 cloud/weather/atmosphere rows):**

* **BUG-07** — `WebGPUCloudRenderer.ts:464-467` builds `prevWorldPos = prevPositionHigh + prevPositionLow`
  and multiplies by a **world-space** `camera.prevViewProjection`, while the *same function* two lines
  earlier does the RTE form correctly (`:459-461`). Both CLAUDE.md prohibitions are literally violated at
  Earth magnitude. Note this is the **billboard `CloudCollection`** renderer, **not** the procedural
  volumetric one, and **Astra does not touch the file**. Caveat for the row: Worker 20 refuted the
  structurally identical `ModelPBRComplete.wgsl` claim on TAA-tolerance grounds and never adjudicated
  this one — so the acceptance must assert a **measured behaviour** (pin the velocity texture for a
  static cloud under a moving camera at Earth scale), not a rule citation.
* **BUG-12** — `packages/sandcastle/gallery/volumecloud/main.js:285,287` sums
  `czm_encodedCameraPositionMCHigh + …Low` and `position3DHigh + position3DLow` in FP32 while `:283`
  correctly uses `translateRelativeToEye`. A *cloud* demo teaching the wrong RTE pattern. Demo class, so
  the light proof bar (review + one capture).

**Verified but style, not defects:** `CloudVolumetrics.js` 25 rows (11 CAT-A, 10 CAT-C `── … ──`
dividers, 7 CAT-B); `MetarWeatherSource.ts` 6 rows of which the four labelled CAT-CODE are style or
hardening (the `/g` regex *does* reset `lastIndex`; "GC churn" is asserted without measurement); and
106 further subsystem rows with **zero** additional real defects. Two tiny genuine JSDoc breakages worth
folding in: `WebGPUCSMRenderer.ts:1113` (`@param invRadiiSqX/Y/Z` is not a legal identifier and silently
drops from generated docs) and `SkyAtmosphere.js:318` (`@param` names a type the file never imports).

**Already addressed by Astra — with a tension the seat must resolve:** Astra's diff **deletes** the
`CloudVolumetrics.js:164-173` block (`// corrected 2026-09-12, C13-N34 … THIS EDIT DISCHARGES NEITHER
C13-N12 NOR C13-N41`), taking that file's markers 10 → 7 and its guard regressions 11 → 7. But Gemini's
own Phase 1 remediation for the same block proposes a JSDoc rewrite that **preserves** the corrected
fact, and `cesium-webgpu-worker-archive/audit-2026-09-16/R-shape-weather.md` F5 records the deletion as a **record loss** the BILLOW review never
mentions. **Gemini's version is the better one.** What Astra does *not* clear: `:179-180` (JSDoc leaking
`C13-N12`/`C13-N41`), five more `corrected 2026-09-12` blocks, and all ten CAT-C dividers.

**Stale, wrong, or dangerous — do not action:**

* **The one fabrication.** `MASTER_CODEBASE_AUDIT_COVERAGE_LEDGER_2026-09-16.md:41` certifies the
  Volumetric Clouds & Weather row "Aligned — RTE raymarch verified in shaders" citing **`CloudVolume.wgsl`,
  which does not exist** (`find packages -name 'CloudVolume*.wgsl'` → nothing), and Worker 09's declared
  scope lists no cloud shader. It survived the 09:04 revision. Flag it to Gemini; do not act on ledger §2
  for clouds.
* **BUG-02's remediation is unsafe as written** — it would call `TerrainProvider.destroy()`, which does
  not exist, on a caller-owned object. The dead line at `GlobeSurfaceTileProvider.js:1392` is real and
  should simply be deleted; the claimed leak is unproven.
* **BUG-05** is genuine but **upstream** (`git blame` → Gagliardi 2022) and still labelled a fork
  CRITICAL. Ask for the same reclassification Gemini already applied to BUG-01 and BUG-06.
* **Phase 2 is 42/51 stale** — all 29 `CloudVolumetrics` `@type` tags and the Moon/SkyBox/RenderLayer
  constants already carry the proposed types at HEAD (the last three via `@enum` on the frozen object).
* **Two false findings, one destructive**: the GEE-buffer "dead variables"
  (`createVerticesFromGoogleEarthEnterpriseBuffer.js:104,111,118` — they **are** read at `:408,410,421,
  433,435,446`; applying the remediation breaks the terrain worker's skirt geometry, and it **survived the
  adversarial pass**), and "`scene.terrainProvider =` is deprecated" (no `@deprecated`, no
  `deprecationWarning`, used across the gallery).
* **Phase 3 targets four upstream-authored `new-cap` sites**, contradicting the doc's own anti-churn
  principle; only `PrimitiveGeometryHelpers.js:227,252` is fork-side.

**What Gemini could not see, and what matters most:**

1. **Coverage.** Only **6 of Astra's 75 touched paths** appear anywhere in 4.2 MB of Gemini output.
   `WebGPUProceduralCloudRenderer.ts` (5,570 LOC), `ProceduralClouds.wgsl` (3,157 LOC),
   `WebGPUCloudTierPresets.ts`, `CloudTypeProfile.js` and all of `Scene/Weather` except
   `MetarWeatherSource.ts` are named **nowhere** — while the ledger certifies the row "Aligned".
2. **The C16 delta.** Running the repo's own guard in Astra's clone: cleanlist **18 → 60**, census
   **199 → 241**. See §2.3 X4. Neither lane can see this.
3. **A new standards problem Astra introduces** that predates nothing Gemini could audit: **five public
   properties documented with bare `//` comments** instead of JSDoc (`cloudLayers`,
   `cloudPlanetaryLighting`, `cloudThinLayerLighting`, `cloudSunIntensity`, `cloudWeatherModel`), which
   makes the API doc-scanner bind a neighbour's `@type` to them.

**Signal-to-noise, measured two ways.** Gimilzor spot-checked 22 findings: **22/22 quotes reproduce
verbatim** (zero fabricated code quotes); classification correct 16/22 at first read, **19/22 after
Gemini's own mid-audit self-corrections**; overall defect yield **≈1.2 %** of 1,213 anchored rows
(78.7 % comment cosmetics, 12.4 % CAT-CODE). Holman's independent 30-row stratified sample:
**28 true / 2 false / 0 stale**, 21 actionable, 7 style-only, 2 already caught by an existing instrument,
and **13/30 (43 %) target upstream-authored lines** the doc's own rules say to leave alone.
Verdict: **the instrument sweep is 100 % accurate and worth acting on today; the semantic pass is a
low-yield, high-volume comment audit with a functioning adversarial loop**. Its structural defects are
fixable and specific: no severity column, no per-row disposition (which is exactly how the destructive
GEE row survived), 26 % bare-filename citations, and a Fleet-2 arithmetic error (per-worker counts sum to
668, not the 575 claimed, which the 1,702 grand total inherits).

---

## 7. Decisions for the maintainer

**D1 — Landing direction for the cloud work.**
Options: **(A)** land L3 → L4 → L5 frozen first, then rebase Astra; **(B)** land Astra's superset first,
then rebase the lanes; **(C)** cherry-pick / drop a lane.
→ **Seat recommends (A).** Measured: 0 engine and 0 spec conflicts between the lanes vs 29 rejecting
hunks the other way; 16 of 26 union paths resolve to "keep Astra's file"; and (B) would put
N10/N11/N20/N21/N22 into main with no green acceptance spec at all. (C) is not available — no lane is
subsumed.

**D2 — `resolveTier`'s near-altitude band (M3 ruling (a)).**
L3 ships `if (cameraHeightMeters <= enableAltitudeMeters) return 3;`; Astra deleted it **and** rewrote
L3's byte-identity acceptance test to match. Options: keep the lane's band (Astra re-tunes AUTO_TEMPORAL
on top); accept Astra's two-tier resolver (L3's N10 byte-identity claim is withdrawn in writing); or keep
the band and gate Astra's change behind a dial.
→ **Seat recommends keeping the lane's band and having AUTO_TEMPORAL re-land on top**, because L3's proof
is the reviewed one and Astra's substitute test no longer checks what N10 claimed. Either way it must be
**in writing** — merging silently produces a resolver neither spec describes.

**D3 — Uniform slot 175 and the float-count mirrors (M3 ruling (b)).**
L4 ships `_padQ` at 175; Astra ships `interleavedRefresh`. Three mirrors of one memory image already
disagree: `probe-cloud-density-domain.mjs:1000` says 176, `cloud-tier-lighting-dials.spec.mjs:222` says
216, the tree computes 260. Options: keep `_padQ` and move `interleavedRefresh` to a new appended slot;
or accept the repurposing and update L4's frozen spec.
→ **Seat recommends appending `interleavedRefresh` rather than repurposing a pad**, and — either way —
making the **single-source constant** fix (improvement #5 and the `CLOUD_SLOT_*` export) part of the same
batch. `probe-cloud-density-domain.mjs` is an **Edge probe**: it fails on the first leg that runs it, in
either direction. Slots **214 and 215** are the same shape and should be added to this ruling.

**D4 — C13-N20 reachability (M3 ruling (c)).**
`CloudVolumetrics.js:209` is `options.cloudAerialMode ?? "heuristic"` and `CloudCollection.js:367`
spreads that instance, so `cloudAerialMode` is **never `undefined`** and L3's promotion clause is dead
through the public API. `LANDING_PACKET_ULMO.md` does not address the default; Manwë's Edge leg 3b is
briefed to measure O3 "with the promotion **active**".
→ **Seat recommends changing the default to `undefined` (or adding an explicit `"auto"`) so the promotion
is reachable, before leg 3b runs** — otherwise that leg's premise is false before it starts.

**D5 — Does a solo self-review discharge R-2026-08-29-1's review leg for engine/shader rows?**
Every one of the 43 cloud verdicts is a self-review, and no unit has a named Edge leg. Options: accept
the solo handoff as covering both legs; require an independent reviewer for engine/shader rows only;
require reviewer **and** a named Edge leg per landing batch (not per unit).
→ **Seat recommends the third**, scoped per batch not per unit: the five cluster reviews just delivered
are the independent leg for everything reviewed here, and the Edge legs can be batched with the lanes'
owed legs in one slot session.

**D6 — Default-on posture for RETURN/WIP features.**
Unit 43 (`pixelFootprintSamplingEnabled`), unit 39 (`projectedDetailEnabled`) and unit 38
(`weatherCoverage.enabled`) are **on by default**; 43 is RETURN/WIP by its author, who wrote "Do not
treat the capture's PASS as image acceptance". Options: require every RETURN/WIP feature to ship
default-off; require default-off only where the author's own metric regresses; accept as-is.
→ **Seat recommends the first**, plus giving 39 and 43 real `CloudVolumetrics` dials with JSDoc so
"default-off" has a home (today the only switch is a private cache field).

**D7 — The two one-pixel gates (units 37 and 47).**
Options: block the ten stacked units until the cause is isolated; run the **same-build repeat control**
first and accept GPU nondeterminism if it reproduces; accept the 1/255 delta by policy.
→ **Seat recommends the second** — it is one Edge session, unit 38 already proved the harness, and it
either unblocks ten units at once or produces a real delta to chase. Note unit 47's evidence additionally
crosses a build boundary (captured with `6f2c69c693`, frozen at `3e675db81c`), so its repeat must run on
the **frozen** source.

**D8 — The C16 ratchet, and who owns it.**
`main` is red at HEAD (18 regressions / 6 files), Astra's tree takes it to 60 / 13, and 13 of the 18 sit
in cloud/weather files Astra and the frozen lanes hold. Options: dispatch Gemini's Phase 1 as its own
row now (two owners on one file); fold the remediation into Astra's landing; fix only the +42 Astra adds
and leave HEAD's 18 for a separate row.
→ **Seat recommends folding it into the cloud landing** (one defect, one owner) and taking Gemini's
Phase 1 *text* — which is verified 18/18 exact, and all seven proposed rewrites are clean under the real
grammar — with the three banking conditions (items 1, 4, 6 delete deferred-work pointers; bank them in
`DEFERRED_WORK.md` / `DEV_NOTES_clouds.md` first, per Principle 9). **Add the C16 guard to the solo
pre-landing checklist now**, while the markers are still warm.

**D9 — The six `new-cap` ESLint errors (CI `lint` red at HEAD).**
Four of six sites are upstream-authored (`PixelFormat.js:479`, `clone.js:17`,
`Vector3DTilePrimitive.js:810,830`); only `PrimitiveGeometryHelpers.js:227,252` is fork-side.
Options: fix all six (deliberate upstream divergence); fix the two fork sites and add a scoped eslint
exception for the four; leave CI red.
→ **Seat recommends the second.** Leaving a CI gate red is not an option; churning upstream lines
contradicts the fork's own anti-churn rule.

**D10 — The assigned-row batches tonight.**
Options: land all 16 tonight; hold them until the cloud direction is settled.
→ **Seat recommends landing tonight.** They are Node-only, tools-class, zero engine files, zero HELD
collisions, independently verified, and holding them buys nothing. Three small adjudications ride along:
the **Anarion SCHEDULE scope stamp**, the **Arien A3 row correction** (the row's acceptance (6) and its
prescribed edits are mutually exclusive — the patch is sound), and the **godray record line numbers**
(`:2130`, `:1757-1761`, not the packet's).

**D11 — Gemini's audit doc and its `_lane-out/`.**
Options: land the doc as-is; land after the nine listed corrections; do not land.
→ **Seat recommends "land after corrections" for the doc only**, with `_lane-out/` (≈815 KB, no per-row
dispositions, at least one destructive false row) going to `cesium-webgpu-worker-archive/lanes-2026-09-16/`
under the Evidence Repatriation rule, **not** into the tree. The doc needs: a `migration_doc/README.md`
index row (or `verify-readme-index` makes it violation #1), the seven `file:///f:/…` links replaced
(they point into gitignored `_lane-out/` and `verify-doc-citations.mjs` skips them **by design**, so they
would pass the guard while being dead in every clone), Phase 2 deleted or restated, the four upstream
`new-cap` sites marked, the pre-push snippet given an explicit placement and status capture (appended
after `node "$guard" "$@"` it **masks the no-override quiet-hours guard** via `sh`'s last-command status),
the duplicate CI step dropped, the `C16-20` criteria corrected (leg 4 and the preconditions are missing;
`build-ts` is a reserved maintainer call), the Fleet-2 total fixed (668, not 575), and the two false
findings withdrawn with dated correction lines.

**D12 — `C13-N07a` / `C13-N48`.**
The partial cannot land (it puts a red guard on main) and **no worker can complete it**: the runner
refuses a dirty candidate, the scene entry necessarily dirties the tree, and a worker may not commit.
→ **Seat must supply the promotion route (C13-N48) before re-dispatching**, and the orbital scene needs
visible cloud structure first — which is a cloud-quality dependency, not a tooling one. Keep the freeze
and the three banked evidence runs.

---

## 8. Landing plan

Constraints honoured: **quiet hours** (no commit, no push, weekdays 07:00–19:00 ET — today is Wednesday
and it is 10:43 EDT, so **nothing lands before 19:00**); **R-2026-09-12-4** (a named Edge leg before an
engine landing); the **frozen L3/L4/L5**; and the seat's landing wrapper (**Node gates only**, commit from
an empty index or by explicit path — note the seat tree is currently dirty in four unrelated tracked
files, so *by explicit path* is mandatory).

### Phase 1 — tonight, after 19:00 ET. Node-only, no Edge slot, no engine file.

| Batch | Contents | Gates before the commit | Notes |
|---|---|---|---|
| **B1** | `arien-a1` → `a2` → `a3` → `a4` → `a5` → `b` (one sitting, row order) | `npm run test-cloud-c13-quarantine` → **150/147/3, exit 1**, survivors F1a/F1b/S1; prettier + eslint exit 0 | Record the quarantine number **once**. Do **not** union these specs into `test-cloud-c13` (`:207` held). Correct row §3.3 acceptance (6) in the same batch |
| **B2** | `anarion-godray-ranges` | `node --test godray-sun-usability-uniform-ranges.spec.mjs` → **20/20/0**; `npm run test-cloud-c13` → **541/541/0** on a built tree | Write the record at the **re-derived** lines `DEFERRED_WORK.md:2130` and `:1757-1761`; correct the "A real contract violation" sentence in place, dated; close `DX-92` as the duplicate view |
| **B3** | `dx91` → `dx90` → `dx95` → `dx84` → `wave_end`, then `dx82`, `dx89`, `branch` | `test-tools-lib` 115/115/0; `test-sandcastle` 156/156/0; `test-landing-rules` 355/355/0; wave-end pair 36/36/0; branch spec 54/54/0 | Order is forced by exported `package.json` context, not preference. **Seat acts:** stage the six new files *before* `verify-tracked-references` (all 11 violations are UNTRACKED-class); regenerate `TOOLING_CATALOG.md` (`+2/−0/~0`); union the three free script lines; add the wave-end decomposition line to `ES6_MODERNIZATION_STATUS.md` (held by Ulmo — packet text); record DX-89's exit-code consequence and DX-95's `INCONCLUSIVE` consequence |
| **B4** | `anarion-c13-42-schedule` | `probe-runtime-lifecycle-adoption.spec.mjs` 54/54/0 (+ Aldarion's tests if B3 landed first) | Needs the **scope stamp** first. Collides on one file with Aldarion: apply the second with `-3` and re-run the spec |
| **B5** | record-only: `C13-42g` closure, `C13-N58` closure on the built-clone receipts, `C13-42f` apparatus failure | — | No patch |

Also file, tonight or with B3: the three Aldarion follow-up rows (`probe-runtime.mjs:665`,
`sandcastleTemplate.spec.mjs` temp leak, `__sandcastleSmokeReady` adoption).

### Phase 2 — the frozen lanes. Needs the Edge slot and a fresh clone.

Owed under R-2026-09-12-4, and unavoidable in **either** landing direction:

* **L3 Ulmo — Edge leg 2.** `LANDING_PACKET_ULMO.md` §8: *"Edge leg 2 has not run. It cannot: the slot is
  held."* The slot is **free now**.
* **L4 Manwë — legs 3a / 3b / 3c**, which must run **on L3's landed commit with `manwe.patch` applied on
  top** — so a **fresh clone** of the post-L3 tip is required. Leg 3b's premise needs **D4** settled first.
* **L5 Ossë — leg 4** (`LANDING_PACKET_OSSE.md` §7).

Then land **L3 → L4 → L5**, squash-only, seat-unioning `package.json` (`:207` ulmo+manwë, `:209` ossë)
and `QUEUE_2026-07-23_CAMPAIGN13.md` — the only four conflicting hunks, both already the seat's job.
Rulings **D2, D3, D4** must be recorded *before* these land.

### Phase 3 — the cloud stack, after the lanes.

1. **Rebase Astra onto the landed tip** in a **fresh clone** (its current clone's base is now behind; and
   16 of 26 union paths resolve to "keep Astra's file", so this is a scoped repair, not a re-do).
2. **Repair the guards first, before any engine landing** — improvements #1, #2, #5, #9, #19 turn four
   red gates green and cost about thirty lines in total.
3. **Discharge the proof bar** for the seven inert-survivable mechanisms (improvements #6, #7, #8, #10,
   #11, #12, #15).
4. **Run the same-build repeat control** for the two one-pixel gates (D7) — one Edge session that may
   unblock ten units.
5. **Fix the C16 delta** (D8) and re-run `verify-landing-compliance` before proposing a batch.
6. **Then** split the stack into landable batches. The natural cut points, given the linear chain:
   *(a)* units 1–22 only after PREVIEW's foundation question is closed by Phase 2; *(b)* 24–32 as a
   march/perf batch once slot 175 is ruled; *(c)* 35–47 as a startup/async batch once units 37 and 43
   are resolved. **Unit 45 (`NOISE_REPLACEMENT`) is the one row worth cherry-picking out now** — 2 files,
   56 lines, no image or shader surface, mutant-proved in both directions, and it fixes a **real
   use-after-destroy on `main`**.
7. Each engine batch needs its **own named Edge leg** (D5) and a `DEFERRED_WORK`/`FEATURE_INVENTORY`
   parity row (improvement #20).

### What needs a fresh clone

* Manwë's legs 3a/3b/3c (must run on L3's landed commit).
* Astra's rebase (Phase 3 step 1).
* Any Edge leg taken from Astra's current clone would serve a **stale build** for the four weather-worker
  files (`Build/CesiumUnminified/Cesium.js` 19:19:49 vs those files at 19:29–19:30) — the very subsystem
  whose guard spec is red. Rebuild or re-clone before any `--serve-built` leg.

### Sequencing hazards to carry into the batch messages

1. `package.json` is a same-line collision for ulmo + manwë (`:207`) and ossë (`:209`) **and** Astra
   (a 42-entry superset) — seat-union work in every scenario.
2. Aldarion and Anarion both edit `probe-runtime-lifecycle-adoption.spec.mjs` (non-overlapping; `-3` the
   second).
3. Arien and Astra both edit five of the same six specs — pick one owner per file before the preview lands.
4. `eslint.seatbelt.tsv` is held by Ulmo, so the `curly` 12→10 drift can only be fixed by the seat, after
   L3 lands.
5. `cloud-genus-morphology.spec.mjs` may be touched by **nobody** until both ulmo and manwë land — and
   Astra already touched it (+124/−15). That edit has to be re-derived after Phase 2, not replayed.

---

## 9. Rulings taken

**Taken.** These twelve rulings were taken by the maintainer at ~11:05 EDT on 2026-09-16, prompted by
the seat from §7 of this document; each is the option the maintainer selected. The ids
`R-2026-09-16-1` .. `R-2026-09-16-12` are **provisional** until record round 5 writes them into
`MAINTAINER_RULINGS`. They are reproduced verbatim from the maintainer's file.

1. R-2026-09-16-1 (D1, landing direction): OPTION A — run the three frozen lanes' owed Edge legs, land L3 Ulmo -> L4 Manwë -> L5 Ossë in their reviewed form, then rebase Astra's cloud stack onto the result in a fresh clone.

2. R-2026-09-16-2 (D2): the resolver KEEPS L3's near-altitude band (`if (cameraHeightMeters <= enableAltitudeMeters) return 3`); Astra's AUTO_TEMPORAL re-lands on top; Astra's rewritten byte-identity test does not replace L3's.

3. R-2026-09-16-3 (D3): uniform slot 175 stays L4's `_padQ`; Astra's `interleavedRefresh` is APPENDED as a new slot; the single-source `CLOUD_UNIFORM_FLOATS` constant fix (improvement #5, the `CLOUD_SLOT_*` export) lands in the same batch; slots 214 and 215 fall under the same rule.

4. R-2026-09-16-4 (D4): `CloudVolumetrics.js:209`'s `cloudAerialMode ?? "heuristic"` default changes to `undefined` (or an explicit `"auto"`) so L3's N20 promotion clause is reachable through the public API — BEFORE Manwë's leg 3b runs.

5. R-2026-09-16-5 (D5): solo engine/shader rows need an independent reviewer AND one named Edge leg PER LANDING BATCH (not per unit); the five cluster reviews of 2026-09-16 count as the review leg for what they covered.

6. R-2026-09-16-6 (D6): every RETURN/WIP feature ships DEFAULT-OFF (units 43 pixelFootprintSamplingEnabled, 39 projectedDetailEnabled, 38 weatherCoverage.enabled today default on); 39 and 43 get real `CloudVolumetrics` dials with JSDoc.

7. R-2026-09-16-7 (D7): the two one-pixel gates (units 37, 47): run the SAME-BUILD REPEAT CONTROL first (unit 47's repeat on the FROZEN source, its evidence crossed a build boundary); accept GPU nondeterminism only if it reproduces.

8. R-2026-09-16-8 (D8): the C16 cleanlist ratchet (main red at 18, Astra's tree 60) is FOLDED INTO THE CLOUD LANDING (one defect, one owner) using Gemini's Phase 1 text (verified 18/18) with the three banking conditions (items 1, 4, 6 bank their deferred-work pointers in DEFERRED_WORK/DEV_NOTES_clouds first); the C16 guard joins the solo pre-landing checklist now.

9. R-2026-09-16-9 (D9): the six `new-cap` eslint errors: FIX the two fork-side sites (`PrimitiveGeometryHelpers.js:227,252`), add a scoped eslint exception for the four upstream-authored sites (`PixelFormat.js:479`, `clone.js:17`, `Vector3DTilePrimitive.js:810,830`); CI must not stay red.

10. R-2026-09-16-10 (D10): the sixteen assigned-row packets + four record-only closures LAND TONIGHT after 19:00 ET (Arien A1-B; Anarion god-ray ranges; Aldarion DX-91->90->95->84->wave-end then 82/89/branch; Anarion schedule after its scope stamp; records), with the three adjudications riding along (Anarion SCHEDULE scope stamp; Arien A3 row correction — acceptance (6) and the prescribed edits are mutually exclusive, the patch is sound; god-ray record line numbers `:2130`, `:1757-1761`). N07a returns to a BLOCKED row (D12).

11. R-2026-09-16-11 (D11): Gemini's audit doc LANDS AFTER THE NINE CORRECTIONS (README index row; the seven `file:///f:/` links replaced; Phase 2 deleted/restated; the four upstream `new-cap` sites marked; the pre-push snippet given explicit placement + status capture so it cannot mask the no-override quiet-hours guard; the duplicate CI step dropped; `C16-20` criteria corrected; Fleet-2 total 668 not 575; the two false findings withdrawn with dated correction lines); its `_lane-out/` goes to `cesium-webgpu-worker-archive/lanes-2026-09-16/`, not the tree.

12. R-2026-09-16-12 (D12): C13-N07a's partial does not land; the seat supplies the promotion route (C13-N48) before re-dispatch; keep the freeze and the three banked evidence runs.

§7 is **not** edited to match. The recommendation and the ruling both stay on the record, so a later
reader can see what was recommended as well as what was ruled. Checked pair by pair against §7: **all
twelve rulings took the option the seat recommended**, including the two that turned on a choice
between named alternatives (D5 took the third option offered, D6 the first). Nothing in §7 was
overturned, so no recommendation below is stale — but read §9 for the decision and §7 only for the
argument behind it.

---

*Written by Hildigrim, 2026-09-16, from twelve read-only audits plus my own re-measurement at the seat and
in the clones. Nothing was written outside the audit scratchpad, banked verbatim to
`cesium-webgpu-worker-archive/audit-2026-09-16/`; no git write command was run; no build, no
browser, no `npm install`; Gemini's live `_lane-out/` was read and never modified; no temp root was
created, so none needs sweeping.*
