# Campaign Closure Audit — C11 / C12 / C13

> ## ⛔ ADDENDUM 2026-08-07 — READ BEFORE ACTING ON ANY RECOMMENDATION BELOW
>
> **This audit is a historical snapshot taken at Batch 844. Its headline
> recommendation was overtaken by Batches 851–866 within roughly 24 hours. The body
> below is UNEDITED and stays that way — the value of a snapshot is that it records
> what was known then. This block records what changed since.**
>
> ### 1. The headline recommendation is spent — `C13-GATE-B` is CLOSED
>
> §2 item 1 and §4.A say **"`C13-GATE-B` is 7 probe runs away and nothing else"**
> and call it "the highest-value single action available across all three
> campaigns". That was the right call, it was taken, and it is **done**:
> **`C13-GATE-B` CLOSED GREEN at Batch 866 (`58af0d1819`).** Full roster at
> closure — edr-mock 3/3, wcs 3/3, ingest 3/3, seam-poles 3/3 (860), time
> exempt-by-proof (855), metar GREEN via discriminator (866), channels 10/10 with
> the scored vector byte-identical across all ten runs (866). **No assertion was
> widened anywhere in the chain.**
>
> ### 2. …but "7 probe RUNS and nothing else" was wrong about the *cost*
>
> The runs were not the work. Three findings the audit could not have had:
>
> - **Batch 852 (`6e7133072c`)** — the channels probe was scoring a **network-fed
>   globe**, and **six other Gate-B legs shared the defect**.
> - **Batch 855 (`d9502bc1e6`)** — **five of the six remaining legs had false-green
>   mechanisms**; all five were pinned, and the sixth was exempted *with proof*.
> - **Batch 864 (`47809cf482`)** — the **metar gate 4 had been BLIND since the day
>   it was written**. Batch 860 read it RED 3/3; the attribution took two batches to
>   settle, and the outcome was **no engine defect** — the instrument was the fault.
>
> ⚠ **§4.B's line "all six drive GLOBAL fields and the spec asserts their bytes are
> unchanged, so any red is a real regression" is REFUTED — do not carry it
> forward.** Batch 855 proved that reading unsafe. A red from an unpinned
> network-fed leg is an instrument reading until pinned, not an engine regression.
> This is the single most dangerous stale sentence in this document.
>
> ### 3. Promotions that have since happened (§4.A verdicts, executed)
>
> `C13-06` → **COMPLETE**; `C13-07` → **COMPLETE** (recorded honestly: the
> Batch-855 susceptibility of its pixel gate was REAL and the verdict *survived* it
> — seam-poles re-ran PASS 3/3 under the pin); `C13-08` → **COMPLETE** (the seven
> owed browser regressions are green *under pinning*, i.e. stronger evidence than
> the pre-pin runs the row originally asked for); `C13-GATE-B` → **COMPLETE**;
> `C13-41` → **UNBLOCKED**, ready for dispatch. The
> `CLOUD-LOW-COVERAGE-CUTOFF` **fog arm** Edge run (§4.B) is still owed.
>
> ### 4. The O5 question in §5 was answered — and the answer moved again
>
> §5 asks what "complete" means for the O5 hold. The maintainer ruled it the same
> day: **R1 — O5 binds on a pragmatic bar, C12 complete + C13 Gate B green**, with
> **R2** deliberately keeping C11 and C13 honestly open so C14 stops depending on
> them (`DEFERRED_WORK.md`, §"2026-08-06 - MAINTAINER RULINGS"). **With Gate B now
> closed, half that bar is met and the remaining Campaign-14 gate is C12 completion
> ONLY.** §2 item 2 — "then take C12 to its gates" — is therefore no longer the
> second priority; **it is the whole remaining path.** Note also that
> `C12-21`/`C12-22`, which §2 item 2 puts on the G4 moon half, **landed at Batch
> 858** (Edge acceptance owed), and `C12-27`, on the G2 critical path, **landed at
> Batch 865** (Edge acceptance owed).
>
> ### 5. Index gap
>
> This file was, until this addendum, the **only** top-level `migration_doc/*.md`
> absent from [`README.md`](README.md) — against README's own "**Trust this index**
> over any individual doc's self-description". It is now indexed. That gap is why
> the drift-sweep process which corrected four stale README rows at Batch 820 never
> saw this file.

**Prepared:** 2026-08-06, at `main` tip `2e209bbd62` (Batch 844), clean tree.

**Question asked:** the maintainer wants to close out Campaigns 11, 12 and 13. What
actually stands between here and that?

**Method:** every open row in
[`QUEUE_2026-07-18_CAMPAIGN11.md`](QUEUE_2026-07-18_CAMPAIGN11.md),
[`QUEUE_2026-07-19_CAMPAIGN12.md`](QUEUE_2026-07-19_CAMPAIGN12.md) and
[`QUEUE_2026-07-23_CAMPAIGN13.md`](QUEUE_2026-07-23_CAMPAIGN13.md) was classified into
exactly one of five buckets. Claims were checked against code, specs, probe artifacts
under `Tools/visual-regression/output/` (gitignored, read from the main tree) and the
git log — **not** against the queue's own prose, which is stale in both directions in
at least four places recorded in §6 below.

---

## 1. Executive summary — what closes each campaign, in what order

**None of the three campaigns is close to closure on its own stated exit gate. Two of
them are months away, and that is a scope fact, not an evidence gap.**

| Campaign | Exit gate | Distance to that gate | Rows never started |
| --- | --- | --- | --- |
| C11 | `C11-137` C8-contract certification | **Months.** The maintainer explicitly HELD certification on 2026-07-23 pending the W2–W8 body, and that body is ~178 rows that have never been started. | ~178 of ~250 |
| C12 | All four gates G1–G4 green on both backends + 5 numbered conditions | **Weeks.** 12 rows never started (mostly S/XS/M), 4 acceptance runs owed, 1 large open certification matrix (`C12-29`). | 12 of 38 |
| C13 | `C13-EXIT` = Gates A–D green | **Months.** Gate D needs `C13-14` (XL weather quadtree) plus six dependent rows, all NOT STARTED. Gate C needs the entire W2 reconstruction stack, also NOT STARTED. | 17 of 42 numbered |

**The order that actually maximises value:**

1. **Close `C13-GATE-B` first — it is 7 probe RUNS away and nothing else.** `C13-08`
   is the last Gate-B row; its code, CPU twin (31/31) and regional pixel lane are all
   green, and the only thing owed is re-running six global weather probes plus METAR
   after the packer change (`QUEUE_2026-07-23_CAMPAIGN13.md:968-1023`). Closing Gate B
   also unblocks `C13-41`, the only C13 row currently blocked purely on a gate.
2. **Then take C12 to its gates.** C12 is the only campaign where the remaining work is
   bounded and enumerable. The critical path is `C12-G1F2` (S, diagnosis) → G1;
   `C12-27` (M) → G2; `C12-18` (M) + `C12-19` (L) + `C12-28` (M) → G4 sun half;
   `C12-21`/`C12-22` (XS each) → G4 moon half. Everything else in C12 is an acceptance
   run or a small residual.
3. **Do not attempt to close C11 or C13 as scoped.** Both would need multi-month
   programmes. If closure is the actual goal, the productive move is a **maintainer
   re-scope decision** (§4.4), not more execution.

**The one thing that could change this picture in a day** is a maintainer ruling on
what "complete" means for the O5 hold (§5). If O5 binds on *exit gates*, Campaign 14 is
months out. If it binds on *the work the maintainer actually cares about*, C12 plus
C13-Gate-B is a defensible bar and C14 could launch in weeks.

---

## 2. Campaign 11

**Exit gate:** `C11-137` C8-upstream-contract certification, "DEAD LAST"
(`QUEUE_2026-07-18_CAMPAIGN11.md:1444-1456`). Ratified 2026-07-18: the campaign closes
on the deterministic focused/unit C8-contract gate with truthful counts; the full
real-scene suite is a recorded follow-up, not a close-blocker.

**⚠ Certification is HELD by maintainer ruling 2026-07-23** (`:1446`): presented with a
minimal ~15-id certification path versus holding until the W2–W8 body executes, the
maintainer chose HOLD. **C11 cannot close without either executing ~178 rows or the
maintainer reversing that ruling.** Everything below is written against that fact.

### 2.A PROMOTABLE NOW

**None.** No C11 row can be promoted to COMPLETE on evidence already in the tree.

The closest candidates and why each fails:

- **`C11-213` (vector-layer draping WGSL twin)** — the acceptance is *nearly* clean.
  `output/vector-draping/manifest.json` (2026-08-06 22:52 UTC, Batch 842) shows both
  backends producing an **identical bbox `[451,19,584,747]`**, centroid delta
  `0.0007 px` / `0.012 px`, changed counts 22396 vs 22397, oblique bboxes identical,
  determinism and removal both `0`, `errors: []` on both. Gates A/C/D/E pass. **But**
  gate F is STRUCTURAL — its in-build half is 0 px on both backends, and the
  cross-build half has no pre-change baseline — and gate B carries an open pre-existing
  WebGL-side residual extent (`NEW-WEBGL-VECTOR-DRAPING-RESIDUAL-EXTENT`). Promoting
  now would treat a structural verdict as a pass, which the campaign's own rules forbid.
  → **bucket B**.
- **`C11-181` (globe shader variant eviction/reference correctness)** — implemented,
  verified and landed at Batch 773, and the row itself says "landing is not completion"
  (`:1444` region, ledger row `C11-181`). Its focused browser gate was never executed
  because `EdgeHeadlessCI` launched Edge and ran zero tests (front matter,
  2026-07-31 overlay). → **bucket B** (needs a probe/Karma RUN).
- **`C11-GT-01`** is already COMPLETE (NO-GO verdict, Batch 717) and `C11-GT-02/03` are
  already correctly recorded as gate-closed. No promotion available; they are done.

### 2.B NEEDS A BOUNDED PIECE OF WORK

Ordered by value. "RUN" = orchestrator machine lane; "CODE" = worker lane.

| Item | What is owed | Lane | Size |
| --- | --- | --- | --- |
| `C11-213` gate F | Cross-build baseline: capture the vector-free frame from a pre-Batch-827 build and compare the hash against the current `9dfc9dc5`. Requires one extra build of an older tree. | RUN (+ build) | M |
| `C11-213` gate B | Diagnose `NEW-WEBGL-VECTOR-DRAPING-RESIDUAL-EXTENT`. Filed, LOW, pre-existing WebGL defect — not caused by the WGSL twin. | CODE | S |
| `C11-212` / `UP144-SNAP-WEBGPU-EDGES` | The edge browser gate: an Edge snap at a model silhouette returning `isEdge: true` on BOTH backends with positions inside pixel tolerance. **No such probe exists** — `Tools/visual-regression/` has `probe-snap-multifrustum.mjs` and `probe-scene-snap.mjs` but no edge-snap probe. So this needs a probe AUTHORED and RUN. | CODE + RUN | M |
| `C11-212` remainder | Forced SCENE2D slice-camera-depth probe; moving camera/cursor across DPR / asymmetric projection / split viewport / canvas edge / RTE boundary; even-sized aperture + WebGL edge-clipped logical padding. | CODE + RUN | L |
| `C11-184` sun-shadow gate | `Tools/visual-regression/probe-sun-shadow-gate.mjs` exists (Batch 840) and **has never been run** — `output/sun-shadow-gate/` is an empty directory created 2026-08-06 19:20. This is the cheapest un-run gate in the tree. | RUN | S |
| `NEW-WEBGPU-SHADOW-DARKNESS-FADE-NOT-APPLIED` | Filed by source tracing at Batch 840, never measured. WebGL reads the faded `shadowMap._darkness` (`Scene/ShadowMap.js:215`); both WebGPU paths read the unfaded public `shadowMap.darkness` (`WebGPUShadowMapRenderer.js:1310`, `WebGPUEffectsBindGroup.js:1289`). | RUN then CODE | S–M |
| `NEW-WEBGPU-GLOBE-RECEIVE-IGNORES-OUTOFVIEW` | Same batch, same status. `WebGPUGlobeSurfaceRenderer.ts:862-867` never consults `outOfView` although the WebGPU cast dispatch does (`WebGPUContext.ts:4656`). | RUN then CODE | S |
| `C11-181`, `C11-182`, `C11-183`, `C11-184`, `C11-185`, `C11-187`, `C11-192..211` | All landed with focused **browser** gates open, blocked on the `EdgeHeadlessCI` launcher executing zero tests. One fixed launcher unblocks roughly a dozen rows at once. | RUN (launcher first) | M |
| `C11-157` Slice D | The `C11-91` silhouette OIT body wash — design-heavy stencil/pass work, already dossiered in `DEFERRED_WORK`. | CODE | L |
| `C11-168` | Six-pair certification, blocked behind `C11-205`'s resident readiness gate. | RUN | M |

**Note on the launcher.** The single highest-leverage bounded item in C11 is not a
feature row at all: it is repairing focused `EdgeHeadlessCI` Karma execution. It is
named as a blocker in the 2026-07-31 front matter, in the 2026-07-31 C12 audit overlay
("focused Edge/Karma execution is presently unavailable because the documented
`EdgeHeadlessCI` run timed out before executing a test; that is a blocker, not a new
pass count"), and it gates the browser half of a dozen otherwise-finished C11 rows.

### 2.C BLOCKED ON A MAINTAINER DECISION

1. **The `C11-137` certification HOLD itself** (`:1446`). Options: (a) keep the hold —
   C11 does not close this year; (b) revert to the minimal ~15-id certification path
   (test-infra `C11-132/133/134`, Gate-B diagnoses, `C11-140/146`, the four owner items
   `C11-138/142/143/144`, Gate-D) and close C11 on the deterministic C8-contract gate,
   moving the untouched body to a successor campaign. **This is the single decision
   that determines whether C11 closure is weeks or quarters.**
2. **Splat data producer (`C11-26`, §7.1 item 1, `:1546-1550`).** Two coupled
   questions: placement (a WebGPU branch in `GaussianSplatPrimitive.update` pre-FR-return
   versus inside the feature renderer) and the offline asset (vendor a licence-clean
   `.spz`/glTF-splat tileset versus build a faithful synthetic builder). Blocks
   `C11-18`, `C11-105`, `C11-IC-02`.
3. **The gated tail `C11-GT-02` / `C11-GT-03`** requires the Gate-D verdict *plus fresh
   maintainer sign-off* (`:1462`). `C11-GT-02` is additionally gate-closed by
   `C11-GT-01`'s NO-GO and should stay closed; `C11-GT-03` (MSAA default flip) is a
   reserve lever that may only be pulled on a Gate-D MISS with bandwidth-attributed
   evidence.
4. **FAR-107 public pick-API review** and the **declutter displacement-threshold
   default** remain listed as unresolved cross-guide open questions (`:1570`).

### 2.D BLOCKED ON ANOTHER ROW

| Row | Blocker | Blocker's bucket |
| --- | --- | --- |
| `C11-168` six-pair certification | `C11-205` per-tile readiness/request-lifecycle gate | B |
| `C11-GATE-D-CHECKPOINT` | `C11-SEED-27` clean-env r5 re-measure (its anchor input) | B |
| `C11-137` (exit) | the four owner items `C11-138`/`C11-142`/`C11-143`/`C11-144`, all NOT STARTED, plus `C11-132/133/134` | B |
| `C11-18`, `C11-105`, `C11-IC-02` | `C11-26` splat producer | C |
| Any new `ShaderDefine` consumer | `C11-149` define-width (registry exhausted at bits 0-30) | B (M) |
| `C11-163` celestial water reflection | `C12-14` samplable star texture | E (C12-owned) |

### 2.E SHOULD BE DEFERRED OUT OF THE CAMPAIGN

This is where the bulk of C11 lives, and saying so plainly is the point of this audit.

- **~160 rows in the never-started cluster blocks**: pick (`C11-01..10`),
  standing-reds (`C11-11..25`), model-frontend (`C11-27..31`), terrain-imagery
  (`C11-32..34, 36..42`), attachment-topology (`C11-43..50`), rte-taa (`C11-51..57`),
  frame-delta (`C11-58..63`), entity-scale (`C11-64..74`), submit-residency
  (`C11-75..78`), tiles-model-parity (`C11-81..99`), classification-voxel
  (`C11-100..108`), shadows-lighting (`C11-109..112`), atmosphere-sky
  (`C11-113/114/116`), postprocess-effects (`C11-117..123`), water (`C11-131`),
  test-infra (`C11-132..147`), build-boot (`C11-148..156`), arch-seeds
  (`C11-SEED-23..26`). These are legitimate work with cluster guides, but they are a
  campaign's worth of work, not a closure tail. **If C11 is to close, they belong in a
  successor campaign, not in the closure path.**
- **`C11-163`** (celestial water reflection epic) is explicitly Tier-4/gated and opt-in
  default-OFF; it is a feature epic, not closure work.
- **`C11-177`, `C11-179`** — deep design is already C12-owned per the 2026-07-23 audit
  ruling; the C11 rows should be marked TRANSFERRED like `C11-79/80/115/160/161/175`
  were, rather than left reading NOT STARTED in C11.

### 2.F Tally — Campaign 11

| Bucket | Count | Notes |
| --- | --- | --- |
| A — promotable now | **0** | |
| B — bounded work | **~12 named items** (covering ~20 rows) | Dominated by browser gates blocked on one launcher |
| C — maintainer decision | **4** | The certification HOLD is decisive |
| D — blocked on another row | **6 chains** | |
| E — defer out | **~165 rows** | The cluster blocks plus two epics |
| — never started, total | **~178 of ~250 IDs** | Counted from the §3.2 ledger's cluster blocks plus individually-listed rows |

---

## 3. Campaign 12

**Exit gate** (`QUEUE_2026-07-19_CAMPAIGN12.md:599-605`): "C12 closes when all four
gates pass on both backends at HEAD, with:" (1) every manifest attributable to a commit
and a recorded adapter pairing; (2) **zero default-ON WebGPU-only celestial multipliers
remaining** — an audit closing the *class*, not the instance; (3) `FEATURE_INVENTORY.md`
updated; (4) `LICENSE.md` attributions current; (5) no new `ShaderDefine` bits consumed.

The four gates (`:592-597`):

- **G1 — skybox fade.** Sun ≥ 25° above local horizon; M1 source-count ratio ≥ 0.90;
  RMS-contrast and P99.9−P50 ratios ∈ [0.85, 1.15]. Mean luminance explicitly
  non-certifying.
- **G2 — white blobs.** `r_1e-3 / r_core ≥ 8` analytic, **composite HWHM ≥ 4** on Edge
  per the `C12-G2-DEF` ruling; two agreeing log-log slopes in [−5,−2]; <25 clipped
  px/star; rendered brightest:faintest ≥ 15:1. **Explicitly includes the `C12-27`
  criterion** (`:537`).
- **G3 — asset upgrade.** ≤ 2.0 arcmin/px; ≥10× sources/steradian vs t3; median chroma
  ≥ 0.20; dust-lane structure via low-pass residual IQR ≥ 3× current.
- **G4 — sun + moon.** Sun `r_1e-3/r_core ≥ 10`, angular diameter within 5% of 0.5334°,
  `I(0.95R)/I(0)` ∈ [0.3,0.5]. Moon: full:quarter integrated-brightness ratio must
  exceed the Lambertian ~3:1 — a *phase curve*, not a single frame. **Plus the `C12-28`
  check** (byte-identical on SDR displays).

### 3.A PROMOTABLE NOW

**One row, and only in part.**

- **`C12-11` (DR-01 star-map seam) — check (G) is discharged and should be recorded as
  such.** Batch 837's `probe-stars-catalog` run proved the decisive half: the diffuse
  cubemap alone yields **zero** resolved point sources, sprites-off frame at 0 bright
  pixels and max luminance 28, against ~1300 bright pixels in the same view before
  Batch 833. Check (D) (intensity scales the count) also PASSES. **Wording change:**
  the row's "Edge acceptance OWED (do not self-promote)" should become "checks (D) and
  (G) PASS at Batch 837; check (A) is blocked on
  `C12-STAR-POINT-CENSUS-LIVE-CALIBRATION`, an instrument question, not a product
  one." The row still must not go COMPLETE — check (A) returns 0 resolved sources for
  the sprites-ON frame while the sprites are demonstrably drawing (max luminance
  28 → 180), which is an unresolved measurement defect.
- **`C12-34` engine leg** is already correctly recorded as PASS at Batch 824
  (`FEATURE_INVENTORY.md:681` carries the same verdict). No change owed; the star-pixel
  leg remains STRUCTURAL because the star field drew nothing at the darkest lane — an
  instrument gap, not a product verdict. → the *row* is bucket B.

Everything else that looks promotable is not: `C12-33`'s probe is honestly
`CALIBRATION_PENDING` (exit 2) with numeric thresholds deliberately null until five
paired repetitions separate; `C12-31`'s first browser probes were green but the full
acceptance sweep is explicitly open; `C12-29`'s S5/S6 targeted gates pass but its final
certification matrix is seven lanes wide and untouched.

### 3.B NEEDS A BOUNDED PIECE OF WORK

**Never started, on the gate critical path:**

| Row | Item | Lane | Size |
| --- | --- | --- | --- |
| `C12-G1F2` | Diagnose the G1 default-pair RMS-contrast divergence 1.488 against band [0.85,1.15]. M1/m2b/m3 are all in band, so it is contrast-specific. **Gates G1.** | RUN then CODE | S |
| `C12-27` | Angular solar glare star-washout — reuse the `C12-05` Stiles–Holladay `1/θ²` math applied to the sky, both backends, both cubemap and sprite pass. Verified absent: no `angularSeparation`-shaped term exists in `Source/Shaders` or `Source/Scene`. **Gates G2.** | CODE | M |
| `C12-21` | Phase-dependent earthshine — multiply by `(1 − phaseFraction)`. Verified absent: `Moon.wgsl:463` is still `vec3(0.4,0.5,0.7) * 0.08 * (1.0 - rawNdotL)` with no phase term, and `:453` records `phaseFraction` as scaffolding kept *for* `C12-21`. **Gates G4 moon half.** | CODE | XS |
| `C12-22` | Soft terminator from the Sun's finite ~0.5° disc (±0.0044 in N·L), one `smoothstep`. Verified absent in `Moon.wgsl`. **Gates G4 moon half.** | CODE | XS |
| `C12-18` | Reconcile bake vs screen-space halo; disc at true 0.53°, all halo from the PP chain. Absorbs the transferred `C11-160` sunBloom wiring and `C11-115` ALPHA_BLEND implementation. **Gates G4 sun half.** | CODE | M |
| `C12-19` | True HDR sun radiance — remove the `clamp(...,0,1)` in both bakes, retune BrightPass, probe against AE-on and AE-off lanes. Absorbs transferred `C11-161`. **Gates G4 sun half.** | CODE | L |
| `C12-28` | HDR default on HDR-capable displays via `matchMedia("(dynamic-range: high)")`; app-overridable; byte-identical on SDR. **Named in G4's criterion.** | CODE | M |
| `C12-12` | VRAM/streaming policy — 2048/face default, 4096 opt-in, KTX2. Touches G3's format arm (median chroma ≥ 0.20 "fails immediately under 4:2:0 JPEG"). | CODE | S |
| `C12-13` | `LICENSE.md` residual: extend the Bundled Engine Assets Files line with the baked t5 faces, add a t5 variant sentence, record the KTX2 derivation chain. **Exit condition 4.** | CODE | XS |
| `C12-32` | Shared celestial ephemeris state — one `CelestialEphemerisState` consumed by EclipseState, UniformState, Moon, tides, atmosphere. Not gate-blocking; feeds C14 tides. | CODE | M |

**Acceptance runs owed on already-landed work:**

| Row | What is owed | Lane | Size |
| --- | --- | --- | --- |
| `C12-33` | Focused Moon browser tests + the calibrated moving Edge lane. The probe is deliberately fail-closed (`{}` cannot certify) and needs ≥5 paired normal/control repetitions plus mandatory seam PNG inspection. Blocked since 2026-08-02 by a usage cap; nothing in Batches 820-844 executed it. | RUN | M |
| `C12-31` | Full aureole acceptance sweep. First probes green 2026-08-01 (aureole anchor PASS, G1 m2b in band); `probe-sky-aureole-anchor.mjs` L1–L4 plus the three `C12-31-FOLLOWUP-A/B/C` consumers (model ground-atmosphere/fog, IBL radiance bake) are open. `PARITY_MAX` for `probe-model-ibl` is owed a re-derivation after the instrument fix. | RUN | M |
| `C12-34` | Star-PIXEL leg. Currently STRUCTURAL because the star field drew nothing at the darkest lane — fix the probe configuration, then re-run. | CODE + RUN | S |
| `C12-11` check (A) | `C12-STAR-POINT-CENSUS-LIVE-CALIBRATION`: run the census over a synthetic frame containing splats of the sprite renderer's actual on-screen footprint. Recorded instruction: do **not** loosen the census. | CODE + RUN | S |
| All four gates | G1/G2/G3/G4 have never been run as *gates* at the current HEAD. `output/celestial-g1.json` is dated 2026-08-01 and predates Batches 819–844 including the `C12-11` default-variant switch, which changes the star field's entire source composition. **Every gate baseline is stale by construction.** | RUN | M |
| Exit condition 2 | The celestial-multiplier class audit: for each of `enableStarBrightnessModulation`, cloud-cover occlusion, `enableMoonPhase`, `enableEarthshine`, `enableNightSkyDimming`, assert either a GLSL consumer exists or the default is off. Note `enableNightSkyDimming` was already found to have **zero consumers anywhere** (recorded on `C11-176`). | CODE | S |
| Exit condition 3 | `FEATURE_INVENTORY.md` celestial WIP §C → §B, airglow added to §D. | CODE | XS |

### 3.C BLOCKED ON A MAINTAINER DECISION

1. **`C12-29` scope versus the exit gate.** `C12-29` (eclipse occlusion effects) is a
   whole subsystem appended into C12, and **none of G1–G4 measures it**. Its
   `C12-S5-FINAL-CERTIFICATION-MATRIX` is seven open lanes (`:502-515`): real
   terrain/exaggeration/fill/provider transitions at the footprint edge; behavioural
   pick and retained-capture refinement; dense selected-terrain timing with a controlled
   active/inactive S5 cost comparison; custom-ellipsoid runtime; NASA-SVS geospatial
   comparison with projection/ephemeris/terrain-mask provenance; generic
   multi-View/stereo-shaped execution; a genuine replacement-device browser run
   (`GPUDevice.destroy()` is terminal and is explicitly not evidence). **Decision:** does
   C12 close with `C12-29` open (the literal reading of §5 — the four gates say nothing
   about eclipse), or is the S5 matrix a de facto fifth gate? Option A closes C12 weeks
   earlier; option B is months and needs a real second GPU/device-loss rig.
2. **`C12-26` (Earth-limb airglow emission).** Filed as W6 "file, don't fold", M–L, a
   genuinely new emissive limb shell. It is in the queue but no gate covers it.
   **Decision:** in-scope for closure, or explicitly deferred?
3. **`C12-14`** (expose the baked cubemap as a samplable star texture) is marked
   *opportunistic*. It discharges the `C11-163` blocker for free. **Decision:** do it as
   a closure rider, or drop it and leave `C11-163` blocked?
4. **LD-3 remains unanswered** (`:639`) — the DR-02 relaxation. The safe default stands
   (HEASARC sourcing, factual fields only, own schema bind `C12-09`), and `C12-09` has
   since landed under it, so this is now moot in practice and should be recorded as
   such.

### 3.D BLOCKED ON ANOTHER ROW

| Row | Blocker | Blocker's bucket |
| --- | --- | --- |
| `C12-19` | `C12-17` (done), `C12-18` (B) | B |
| `C12-18` | transferred `C11-160` + `C11-115` implementation — both now folded *into* `C12-18` itself, so this is self-contained | — |
| `C12-28` | `C12-07` (landed Batch 748) | done |
| G2 | `C12-27` | B |
| G4 | `C12-18`, `C12-19`, `C12-21`, `C12-22`, `C12-28` | B |
| G1 | `C12-G1F2` | B |
| `C11-163` | `C12-14` | C |
| `C12-29` S3 (eclipse → cloud lighting/IBL) | `C13-41`, which is blocked on `C13-GATE-B` | B (7 probe runs) |

### 3.E SHOULD BE DEFERRED OUT OF THE CAMPAIGN

- **`C12-26` airglow** — a new emissive subsystem, M–L, with no gate. Its own row text
  says "file as its own row; do NOT expand `C11-176..179` to cover it." It belongs in
  the atmospheric-effects roadmap alongside the (unlaunched) Campaign 15 aurora work,
  not in a closure tail. Recommend E, pending the §3.C decision.
- **`C12-32` shared ephemeris state** — a shared-CPU architecture fix that "is not the
  cause of the WebGPU-only resident gap and not permission to change any celestial
  result". It feeds C14 tides. Recommend deferring to C14's W0 rather than gating C12
  closure on it.

### 3.F Tally — Campaign 12

| Bucket | Count | Rows |
| --- | --- | --- |
| A — promotable now | **1 (partial)** | `C12-11` checks (D)+(G) |
| B — bounded work | **16** | 10 code rows + 6 acceptance/audit runs |
| C — maintainer decision | **4** | `C12-29` scope is the big one |
| D — blocked on another row | **8 chains** | all resolve to B |
| E — defer out | **2** | `C12-26`, `C12-32` |
| Complete/accepted | **21 of 38** | |

---

## 4. Campaign 13

**Exit gate** (`QUEUE_2026-07-23_CAMPAIGN13.md:594-609`): `C13-EXIT` = Gates A–D green;
selected W4/W5 owners complete or explicitly deferred; WebGL billboards and shared
globe/Scene APIs green; all existing cloud feature toggles preserved; TypeScript /
build / lint / unit tests green; moving golden tour and performance report committed;
zero unowned device/validation errors.

**Gate B** (the near-term target) requires: WGS84/RTE probes green from ground through
orbit; camera motion and teleports causing no precision swimming; temporal / shadow /
mask / capture sharing the coordinate contract; dateline and poles with no visible
seam or pinch; **regional bounds placing fixtures correctly**. It fails when any path
returns to raw full-ECEF `f32`, only the primary march is fixed, a regional field is
globally stretched, or the seam merely moves.

### 4.A PROMOTABLE NOW

**Two rows should be promoted from "IMPLEMENTED + PROBE-VERIFIED" to COMPLETE, and one
gate is one run-batch away.**

- **`C13-06` (RTE cloud-shadow / mask / capture / atmosphere consumers).** Evidence in
  the tree: `cloud-shadow-rte.spec.mjs` 17/17 including a cross-validation of the
  owner's geodetic projection against `Ellipsoid.WGS84.scaleToGeodeticSurface` to
  `2.1e-9 m` over 280 samples; full cloud spec lane 81/81; `tsc --noEmit` clean; naga
  validates all four touched shaders; orchestrator probe run 2026-08-01 with
  `probe-cloud-shadows-flagon/cascades/parity` green and the NEW
  `probe-cloud-shadows-polar.mjs` at 82°N showing ground-band delta 37.2 (ON 23.6 /
  OFF 60.8) with PNGs read. `output/cloud-shadows/` exists, dated 2026-08-01 12:15.
  **Wording change:** the row's own "Not closed here" list is honest and scoped
  (`C13-09` transmittance attachment, `C13-22` volumetric-fog local-fbm) — those are
  *other rows*. Promote `C13-06` to COMPLETE with the residuals retained as pointers.
- **`C13-07` (dateline/pole-safe global weather sampling stopgap).** Post-fix
  antimeridian step max 0.067 / mean 0.010, below the interior *mean*; both polar rows
  single-valued; exact byte identity below 59° latitude; `weather-map-seam.spec.mjs`
  17/17; orchestrator pixel gate `probe-weather-seam-poles.mjs` green 2026-08-01 with
  PNGs read (`output/weather-seam-poles/`, 2026-08-01 11:56). Its residual is
  explicitly `C13-14`'s. **Promote to COMPLETE.**
- **`C13-GATE-B` is 7 probe runs away** — see 4.B item 1. This is the highest-value
  single action available across all three campaigns.

Deliberately **not** promoted: `C13-16` (see 4.C), `C13-08` (browser floor owed),
`CLOUD-LOW-COVERAGE-CUTOFF` fog arm (Edge run owed), `C13-01` (fixture tour green but
metrics/GPU-timing legs open), `C13-02` (PARTIAL — pass timing alone does not close it).

### 4.B NEEDS A BOUNDED PIECE OF WORK

| Item | What is owed | Lane | Size |
| --- | --- | --- | --- |
| **`C13-08` → `C13-GATE-B`** | Re-run seven probes after the packer change: `probe-weather-ingest`, `probe-weather-edr-mock`, `probe-weather-wcs`, `probe-weather-channels`, `probe-weather-time`, `probe-weather-seam-poles` (all six drive GLOBAL fields and the spec asserts their bytes are unchanged, so any red is a real regression) plus `probe-weather-metar` (the intended behaviour change: clear-station −120° and cloudy-station 0° must still separate). Checklist at `:968-1002`. All the code, the 31/31 CPU twin, the 7/7 cyclic parser lane, the cell-registration fix and the regional pixel lane are already green. | RUN | **S–M** |
| `CLOUD-LOW-COVERAGE-CUTOFF` fog arm | Edge run with volumetric clouds ON at coverage 0.15 / 0.35 / 0.55 showing the shadowed ground fraction tracking the visible deck, plus a clouds-OFF byte-identical control. Spec is 15/15 with a four-way in-file mutation group; only the browser leg is owed. | RUN | S |
| `C13-16` neutrality phase | Item 1 of the checklist (default byte-neutrality, **exactly 0** changed pixels) has still not run — `output/cloud-genus-morphology/` contains `manifest-uniforms.json` and `manifest-direction.json` but no neutrality manifest. Gate B deliberately keeps `cloudQuality: 96` for a determinism reason, so it is the expensive leg. | RUN | S |
| `C13-16` items 6, 7 | Re-run `northatlantic-cirrus-fibratus` in `probe-cloud-tour.mjs` (floor-gate risk recorded: ground may land near 0.0017 against a 0.002 floor; the correct response is lowering `FIBRE_MORPHOLOGY[CIRRUS].strength`, never the floor) and the streaked-shadow check via `probe-cloud-shadows-flagon.mjs`. | RUN | S |
| `C13-01` | Complete per-sequence metrics and GPU timing; the 12/12 fixture + 6/6 sequence tour is green as of Batch 790 but the row is still IN PROGRESS for measurement. | RUN | M |
| `C13-02` | Broader cloud CPU/GPU counters and the repaired-tour measurement surface. `C13-39` landed byte-inert timestamp wiring for all 7 cloud passes + env Sky Fill; the counters themselves remain open. | CODE | M |
| `C13-GATE-A` | Follows `C13-01`/`C13-02`. Mechanical once those close. | RUN | S |
| `C13-40` | Async cloud-noise prewarm + generation-keyed reconstruction resources and retirement. The `C13-05` temporal parity bind-group cache is a separately bounded partial. | CODE | M |

### 4.C BLOCKED ON A MAINTAINER DECISION

1. **`C13-16-SCREEN-ANISOTROPY-ATTENUATION` — filed Batch 842, this is a live decision.**
   The first successful direction-phase run
   (`output/cloud-genus-morphology/manifest-direction.json`, 2026-08-06 22:46 UTC)
   produced **real product data that does not meet the gates**:

   | Prediction | Required | Measured |
   | --- | --- | --- |
   | `cirrusElongationMin` | ≥ 1.6 | **1.178** |
   | `cumulusElongationMax` | ≤ 1.35 | 0.971 ✓ |
   | `cirrusOverCumulusMin` | ≥ 1.4 | **1.214** |
   | grain ordering CIRRUS > CIRROSTRATUS > CIRROCUMULUS, margin 1.1 | — | 1.178 / 0.978 / 0.905 — ordering correct, the second margin is **1.081**, short |
   | wind rotation | 90° ± 30° | argmax moved 30° → 90°, i.e. **60°** — at the band edge |

   The morphology is directionally present and the uniform row demonstrably reaches the
   GPU (`uniformRow` reads `[0.6, 9, 0.9, 0.12]` for cirrus, `[0,1,0,0]` for cumulus),
   and rotating the wind moved the elongation argmax — which is the check that separates
   a wind-aligned domain from a fixed diagonal artifact. But a **9:1 in-domain anisotropy
   arrives as ~1.2:1 on screen** because the volumetric march integrates many shell
   samples per pixel at different heights of the anisotropic domain. The gate predictions
   came from the CPU twin, which measures the FIELD, not the integrated image.
   **Options:** (a) raise the authored aspects so the render matches the intent — a
   visual-design change that requires re-reading `GENUS_PHASE_G_LIMIT` alongside it; or
   (b) accept ~1.2:1 as what 9:1 looks like through this march, in which case gates
   C/D/E must be re-derived from an *integrated-image* model. **Explicitly forbidden:**
   lowering the gates to the measured numbers — that converts a real question about
   whether cirrus reads as fibrous into a tautology.
   Also owed from the same run, deliberately not scalarised:
   `item4-fallstreak-tilt.png` and `item8-near-sun-phase.png` need a human verdict
   (both PNGs exist, 2026-08-06 18:46).
2. **`C13-11` STBN provenance.** BLOCKED pending a licence-clean generation/import plan
   and notices; NVIDIA STBN assets are prohibited. Gate C may legitimately record STBN
   as an explicit blocker rather than a failure.
3. **`C13-26` / `C13-27` network dependencies.** `C13-26` needs a same-origin proxy plus
   a GRIB2 WASM decoder plus a deterministic fixture; `C13-27` needs a genuinely
   networked Edge session and explicitly states that offline/mock success is not live
   EDR certification. `C13-33` is CONDITIONAL NOT TRIGGERED behind `C13-26`.
   **Decision:** fund the proxy+decoder, or defer all three out of C13.
4. **The W3 architecture question, which is the real C13 closure decision.**
   `C13-GATE-D` requires "at least four regions with intentionally different
   distributions; same-region/same-type variation; reproducible fixed seed; ENU wind
   direction geographically correct; time slices interpolate; tile seams/gutters
   invisible" — which needs `C13-14` (XL globe-quadtree weather tile schema, gutters,
   cache, atlas, LOD) plus `C13-15/16/17/18/19/20`. **All seven are NOT STARTED, and
   `C13-14` is the only XL in the campaign.** There is no version of "close C13" that
   does not either fund that XL or re-scope Gate D.

### 4.D BLOCKED ON ANOTHER ROW

| Row | Blocker | Blocker's bucket |
| --- | --- | --- |
| `C13-41` (C12-29 S3 eclipse rider) | `C13-GATE-B` | **B — 7 probe runs** |
| `C13-GATE-B` | `C13-08` browser floor | B |
| `C13-GATE-A` | `C13-01`, `C13-02` | B |
| `C13-09`, `C13-10`, `C13-12`, `C13-13` | reconstruction attachment topology, which is `C13-09` itself; the chain is `C13-09` → `C13-10` → `C13-12`/`C13-13` | B (L each) |
| `C13-GATE-C` | `C13-09..13` + `C13-36..41`; STBN may remain an explicit blocker | C + B |
| `C13-15..20` | `C13-14` (XL) | C |
| `C13-GATE-D` | `C13-14..20` | C |
| `C13-16` regional mixtures half | `C13-14`, `C13-15` | C |
| `C13-21`, `C13-22`, `C13-23`, `C13-24` | temporal + regional substrate | D-of-D |
| `C13-33` | `C13-26` | C |
| `C13-34` | `C13-22` | D-of-D |

### 4.E SHOULD BE DEFERRED OUT OF THE CAMPAIGN

- **The W6 gated tail is already correctly DEFERRED**: `C13-29` (orbit impostor),
  `C13-30` (precipitation coupling), `C13-31` (contrail/pyrocumulus), `C13-32` (view-local
  cascaded clipmap, XL), `C13-34` (cloud shadows into environment maps). No change owed
  — these are already outside the closure path by their own status.
- **`C13-26`/`C13-27`/`C13-33`** (GRIB2 ingest, live EDR confirmation, historical replay
  demo) should be moved out of C13 explicitly rather than left BLOCKED inside it. They
  depend on infrastructure (same-origin proxy, WASM decoder, networked session) that has
  no owner in this campaign, and `C13-EXIT` allows "selected W4/W5 owners complete **or
  explicitly deferred**" — so deferring them is a legal path to the exit gate, and
  someone should actually exercise it.
- **`C13-28`** (ground snow-albedo consumer, both backends) is a feature row that needs
  terrain-shader coordination; it is W5 and can be explicitly deferred under the same
  clause.

### 4.F Tally — Campaign 13

| Bucket | Count | Rows |
| --- | --- | --- |
| A — promotable now | **2** | `C13-06`, `C13-07` |
| B — bounded work | **8 items** | `C13-08`'s 7 runs are the headline |
| C — maintainer decision | **4** | `C13-16` attenuation is filed and live; W3 funding is the real one |
| D — blocked on another row | **11 chains** | |
| E — defer out (or already) | **8** | 5 already DEFERRED, 3 should be moved |
| — never started | **17 of 42 numbered** | includes the entire W2 reconstruction stack and all of W3 |

---

## 5. The exit-criteria question, answered precisely

**A campaign can have every row green and still miss its exit gate, or vice versa.
Here is where each actually stands.**

### 5.1 C11

The exit gate is a *test-suite certification*, not a feature bar. `C11-137` closes on
the deterministic C8-contract gate with truthful counts, and the ratified 2026-07-18
reading makes the full real-scene suite a recorded follow-up rather than a
close-blocker. **On the letter of the gate, C11 could certify off a ~15-id path.** The
maintainer looked at exactly that trade on 2026-07-23 and chose HOLD. So C11's blocker
is *not* its exit criteria — it is a deliberate scope ruling. Reversing that ruling is
the only fast path, and it is a decision, not work.

### 5.2 C12

The exit is four measured gates plus five conditions. **The gates do not cover
`C12-29`** — the eclipse subsystem, which is the largest body of work in the campaign
and has a seven-lane certification matrix still open. This is the inverse case: C12
could satisfy G1–G4 and conditions 1–5 while `C12-29` remains materially uncertified.
Two consequences worth stating plainly:

- If closure is read literally (four gates + five conditions), C12 is roughly
  **10 bounded code rows and 6 acceptance runs** from closing, and `C12-29`'s residual
  moves to `DEFERRED_WORK` or a successor campaign.
- If `C12-29` is treated as a de facto gate, C12 needs a replacement-device rig, a
  NASA-SVS geospatial comparison, and multi-View/stereo execution — none of which are
  scoped, and one of which (`supportsStereoViewport`) is explicitly recorded as *not
  available* on WebGPU.

**Additionally:** exit condition 2's audit closes a *class* whose cloud-cover-occlusion
half is coordinated with C13 (`:602`). So C12's exit gate has a real, if narrow,
dependency on C13.

### 5.3 C13

Gate B is the only gate within reach, and it is genuinely close. Gates C and D are not:

- **Gate C** requires counters proving true 1/16 current work, full-resolution history,
  depth/velocity/moment topology, safe disocclusion/cut/resize resets, and moving GPU/CPU
  evidence beating the half-resolution baseline at comparable quality. Its inputs
  `C13-09/10/12/13` are all NOT STARTED (three of them L, one M).
- **Gate D** requires the whole W3 regional-realism stack behind an XL.

`C13-EXIT` then requires all four. **C13 cannot close in weeks under any reading that
keeps Gate C and Gate D as written.** What *can* close in days is Gate B, and that has
downstream value: it unblocks `C13-41`, which is the last open owner of `C12-29`'s S3
rider.

### 5.4 The re-scope option, stated so it can be decided

If "close out C11, C12 and C13" means "reach a defensible stopping point and move on",
the shape that fits the evidence is:

1. **C12** closes on G1–G4 + conditions 1–5, with `C12-29`'s residual matrix, `C12-26`
   and `C12-32` explicitly deferred.
2. **C13** closes at **Gate B** (not Gate D), with W2 (reconstruction) and W3 (regional
   weather) re-founded as a successor campaign, and `C13-26/27/28/33` formally deferred
   under the `C13-EXIT` "explicitly deferred" clause.
3. **C11** closes on the minimal `C11-137` certification path, with the ~165 never-started
   cluster rows re-founded as a successor campaign.

That is a decision the maintainer has to make; this audit does not make it. But it is
the only version of "close all three" that is measured in weeks rather than quarters.

---

## 6. The O5 dependency (Campaign 14)

**Exact wording**, `OCEAN_DYNAMICS_PLAN_2026-07-24.md:188` — verified verbatim:

> **O5 RULED (stricter than the recommendation):** **Campaign 14 launches only after
> Campaigns 11, 12, AND 13 are done** — not merely after `C13-GATE-D`. W0-W2's
> C13-independence does not accelerate the launch.

**What "done" means there is not defined.** The ruling is explicit about what it is
*stricter than* — it rejects the weaker bar "after `C13-GATE-D`" — but it does not say
whether "done" means every row closed or the exit gate passed. Two readings, with
different consequences:

- **"Exit gates passed"** — the more natural reading given that the ruling is phrased
  against a gate. Under this reading C14 waits for `C11-137`, C12's G1–G4, and
  `C13-EXIT`. Since `C13-EXIT` requires Gate D requires `C13-14` (XL), and `C11-137` is
  under an active HOLD, **C14 is a multi-quarter wait.**
- **"All rows closed"** — strictly stronger still, and would additionally require the
  ~178 never-started C11 rows. **C14 would effectively never launch.**

Either reading blocks C14 for the foreseeable future. `DEFERRED_WORK.md:609` and
`HANDOFF_2026-08-02_CODEX_NEXT_WAVE.md:16` both restate the hold, and
`ATMOSPHERIC_EFFECTS_ROADMAP.md:157-158` records that the Campaign-14 label was briefly
collided with the aurora work and corrected — **Dynamic Ocean & Wind remains Campaign 14
under O5; the aurora epic is Campaign 15 (`C15-00` complete, `C15-01..08` pending,
not launched).**

**Recommendation:** put the "what does *done* mean" question to the maintainer alongside
the §5.4 re-scope, because they are the same decision wearing two hats. Note also that
the plan itself records W0–W2 as C13-independent and O4 as "lower priority, can proceed
asynchronously" — so there is already maintainer language that would support a narrower
hold if the maintainer wants one.

---

## 7. Cross-campaign register of maintainer decisions

Consolidated so they can be answered in one sitting.

| # | Decision | Campaign | Options | Implication |
| --- | --- | --- | --- | --- |
| 1 | Reverse or keep the `C11-137` certification HOLD | C11 | minimal ~15-id path vs execute the W2–W8 body | Weeks vs quarters for C11 |
| 2 | `C11-26` splat producer placement + offline asset | C11 | FR-internal vs scene-logic-extractor; vendor vs synthesise | Unblocks `C11-18`/`C11-105`/`C11-IC-02` |
| 3 | `C11-GT-03` MSAA reserve lever | C11 | pull only on a Gate-D MISS with bandwidth attribution | Visual policy; needs recorded sign-off |
| 4 | FAR-107 public pick-API review; declutter displacement-threshold default | C11 | open since the G1–G10 sweep | Small, but they gate two clusters |
| 5 | **`C12-29` in or out of the C12 exit bar** | C12 | literal four-gate reading vs de facto fifth gate | Weeks vs months for C12 |
| 6 | `C12-26` airglow in scope for closure? | C12 | in vs defer to the atmospheric roadmap | M–L of new subsystem |
| 7 | `C12-14` samplable star texture as a closure rider? | C12 | do it (frees `C11-163`) vs drop | S |
| 8 | **`C13-16-SCREEN-ANISOTROPY-ATTENUATION`** | C13 | raise authored aspects (visual-design change, re-read `GENUS_PHASE_G_LIMIT`) vs accept ~1.2:1 and re-derive gates C/D/E from an integrated-image model | Filed Batch 842; blocks `C13-16` either way |
| 9 | Human verdict on `item4-fallstreak-tilt.png` and `item8-near-sun-phase.png` | C13 | deliberately not scalarised | Two PNGs, minutes |
| 10 | `C13-11` STBN provenance path | C13 | fund a licence-clean generation/import plan vs record as a permanent Gate-C blocker | NVIDIA assets prohibited |
| 11 | `C13-26`/`27`/`33` network infrastructure | C13 | fund proxy + GRIB2 WASM decoder + fixture vs defer out | Three rows |
| 12 | **Fund `C13-14` (XL) or re-scope Gate D** | C13 | the only two ways C13 reaches `C13-EXIT` | Months either way |
| 13 | **What "done" means in O5** | C14 | exit gates vs all rows | Determines whether C14 is quarters or never |
| 14 | Launch Campaign 15 (aurora/space weather) | C15 | `C15-00` complete, `C15-01..08` pending, unlaunched | Independent of O5 |

---

## 8. Documentation drift found while auditing

These are not work items in the buckets above; they are places where the queues assert
something the tree contradicts. Each was verified.

1. **`C13-16`'s row tail and its §C13-16 checklist STATUS block are STALE.** Both say
   the acceptance run "produced NO verdict" and that "EVERY item below is still OWED",
   citing the 420 s watchdog overrun
   (`QUEUE_2026-07-23_CAMPAIGN13.md:66` and `:907-915`). Batch 839 made the probe
   runnable (phase-split with a derived watchdog; readiness/direction legs dropped to
   `cloudQuality: 32` with a demonstrated — not asserted — invariance argument), and the
   direction phase **ran and produced real product data** on 2026-08-06 22:46 UTC.
   Checklist items 2, 3 and 5 are measured (and failing); items 4 and 8 have their PNGs
   captured awaiting a human verdict. Only items 1, 6 and 7 remain un-run. **"Zero
   credit" is now wrong.**
2. **`DEFERRED_WORK.md` contains committed merge-conflict markers.** `<<<<<<< ours` at
   line 40, `=======` at line 98, `>>>>>>> theirs` at line 100, introduced by Batch 843
   (`5616545523`) and still present at the Batch-844 tip on a clean tree. The
   `NEW-WEBGPU-GROUND-FOG-RENDERS-NOTHING` heading is duplicated across the marker.
   **Fix before anything else reads that file as authority.**
3. **`C13-GATE-B`'s ledger row cites `output/weather-regional-tails/manifest.json` as
   current evidence.** That artifact is dated 2026-08-02 15:17 — it predates nothing
   relevant, so the citation is fine, but the row should make explicit that the seven
   owed reruns are *later* than it, which the §C13-08 checklist does and the ledger row
   does not.
4. **`C12-11`'s row still reads "Edge acceptance OWED (do not self-promote)"** while
   Batch 837 discharged checks (D) and (G) at pixels. The accurate status is
   "(D)+(G) PASS; (A) blocked on an instrument calibration". See §3.A.
5. **`C11-177` and `C11-179` read NOT STARTED in the C11 ledger** although the
   2026-07-23 audit ruling made their deep design C12-owned (`:637`, LD-2). They should
   carry TRANSFERRED markers like `C11-79/80/115/160/161/175/176a` do, or the C11 tally
   overstates C11's remaining body by two rows.

---

## 9. Rows whose status I could not determine

Flagged rather than guessed.

- **`C11-196`, `C11-197`, `C11-198`, `C11-203`, `C11-204`, `C11-206`, `C11-207`,
  `C11-209`, `C11-210`.** These sit inside the compacted `C11-192 … C11-211`
  "post-attribution architecture tail" ledger row, which names only
  `C11-192/193/194/195/199/200/201/202/205/208/211` individually. The remaining nine IDs
  are defined in §1.29 but have no per-row status anywhere. **They should be expanded to
  individual ledger rows before any C11 tally is treated as authoritative.**
- **`C12-29`'s overall status.** Its S1/S2/S5/S6 slices have targeted gates passing and
  its final certification matrix is open, but the row has no single status token in
  §4 — the queue calls it "open" in one overlay and lists per-slice states in three
  others. Whether it is PARTIAL or IN PROGRESS is not resolvable from the document.
- **Whether the `EdgeHeadlessCI` Karma launcher is currently repaired.** Every reference
  I found (2026-07-31 C11 front matter, 2026-07-31 C12 overlay, `C11-187`'s row) says it
  launched Edge and executed zero tests, but no batch between 819 and 844 records either
  a fix or a re-confirmation. This matters because roughly a dozen C11 rows are waiting
  on it. **Verify before scheduling those rows.**
- **`C13-24`'s scope boundary.** It is NOT STARTED and depends only on `C13-08`, which is
  nearly closed — so it may be schedulable much earlier than its W4 wave placement
  implies. I could not determine from the queue whether the W4 placement is a real
  dependency or an artefact of wave authoring.
