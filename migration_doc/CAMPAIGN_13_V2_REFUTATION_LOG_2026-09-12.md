# C13 v2 — Refutation and Critique Log

**Status: LANDED** (Batch 1476, tree `a5975c5bfe`, 2026-09-12).

**Date:** 2026-09-12 · **Applies to:** `CAMPAIGN_13_V2_CLOUD_QUALITY_2026-09-12.md`
**Purpose:** every claim the refutation pass overturned, with its correction and where the correction lives; every claim it could not confirm, kept with an `[unverified:]` marker; every MISSING/WEAK item the critique named, with what was added.

Load-bearing sites were re-opened read-only at `F:/Dev/GH/cesium-webgpu` this session before applying each correction (Principle 10 — a refutation report is itself a lead).

---

## Part A — REFUTED claims (22 distinct; 4 were duplicate pairs, consolidated)

| # | Draft claim | Correction applied | Where in the final plan |
|---|---|---|---|
| **R1** | §0.5 — sun-colour slots 88-90 written at `:3788-3790` | **`:3786-3788`** (off by two). `grep -n "88 R\|89 G\|90 B"` → `3786`/`3787`/`3788`. The substantive claim (one camera-keyed CPU ramp per frame, `sinElev` block `:3772-3783`) is exact and stands | §0.5; `C13-N19` deliverable |
| **R2** | §0.7 / risk 4 — "35 cloud/god-ray specs on disk, 4 named in package.json, 31 homeless" | **32 on disk, 7 homed, 25 homeless.** The 35 double-counted a file matching both globs; the "4 named" filter dropped the three god-ray specs that ARE homed (`godray-energy-law` → `test-engine-node`; `c13-42-godray-fixture` → `test-c13-42`; `godray-sun-usability-uniform-ranges` → `test-cloud-c13`) while keeping god-ray specs in the denominator. Re-measured this session: `ls *.spec.mjs \| grep -iE 'cloud\|godray'` minus two `pointcloud-*` false positives = 32; 7 matched in `package.json` | §0.8 (new sub-section); `C13-N02` acceptance; §8 risk 4; §9 L2 bar |
| **R3** | §1.3 O5 — the field has "no latitude term, no circulation" | **It has a latitude term.** `ProceduralWeatherMap.ts:56-57` computes `vv = (y + 0.5) / h` and `:59-60` pass it as the second noise coordinate. Restated as **"no meteorological latitude structure — no ITCZ, no clear belts, no land/sea contrast, no circulation, constant G/B/A, static in time"**, so a worker briefed to "add a latitude term" is not misled | §0.12 (new); §1.3 O5 "Today"; `C13-49-slice` |
| **R4** | §1.3 O5 — "a 2-octave periodic fBM" | **Two 5-octave stacks, ten octaves total** (`periodicFbm2D(…, octaves = 5)`, `WeatherMapSeam.ts:149-163`), blended 0.7/0.3 and thresholded by `smoothstep01((f - 0.42)/0.18)`. Matters because O5's spectrum bar is a claim about decades spanned | §0.12; §1.3 O5 |
| **R5** | `C13-N25` — "`WeatherField.baseMeters` already exists and is unread" *(reported twice)* | **It is read end-to-end.** `WeatherTexPacker.ts:345`, `:439`, `:260-261` pack it into channel B; `ProceduralClouds.wgsl:1226-1249` decodes it to `baseShiftFrac` (norm `CLOUD_BASE_NORM_METERS = 12000`, `:316`); applied at `:1265-1277`/`:1350-1362`/`:1422-1431`; producers `MetarWeatherSource.ts:198,:342,:363` and `SyntheticWeatherSource.ts:138,:160`. **The real gap:** it lifts the base only *within* the deck `cloudLayerBottom = 1500` / `cloudLayerTop = 4000` already chose. Row deliverable survives; premise restated | §0.13 (new); `C13-N25`; §4.3 channel list; §6 (the `WEATHER_DATA_INGEST_ROADMAP` row now says "in particular B is live") |
| **R6** | §6 — the stale deprecated-alias sentence is at `CLOUD_UNIFICATION_DESIGN.md:148` | **`:146`.** `:148` is item 5 (the add-only dirty-index note). `grep -n "keeps working"` → 146. Matters because `C13-N33` re-stamps that line in place — a worker given `:148` edits the wrong bullet. The superseding text at `:109-111` is correct as cited | §6 first table; §0.11 context |
| **R7** | `C13-N22` — "two constants (`:204-205`) plus one source default", sized **S**, with "`weather-map-seam.spec.mjs` must stay green" *(reported twice)* | **At least four code sites plus two doc headers.** `weather-map-seam.spec.mjs:66-68` carries its own mirror (`// Must match WEATHER_TEX_W / WEATHER_TEX_H in the renderer.` / `TEX_W = 256` / `TEX_H = 128`), used at `:119`, `:124`, `:189-191`, `:194`, `:198`; `WeatherTexPacker.ts:336` and `:492` carry `texW = 256` defaults; headers at `WeatherTexPacker.ts:5` and `ProceduralWeatherMap.ts:15` state "256x128"; the polar low-pass runs at 721 rows. **Re-sized S → M**; the spec moves in the same batch. The 5.6× arithmetic is undisputed | §0.14 (new); `C13-N22`; §4.3; D5 con-line; §9 L5 (worker model raised Sonnet → Opus) |
| **R8** *(itself REFUTED 2026-09-12; see the correction inside this cell)* | §1.3 A2 — "brackets the physical **0.8843** for water clouds (Kokhanovsky §3.1.4)" | ~~**Not in the cited source.** The PDF was fetched and all 171 FlateDecode streams inflated (1.12 M chars); "0.8843" does not occur; the only `0.88xx` token is a PDF text-matrix coordinate.~~ <!-- corrected 2026-09-13, R-2026-09-12-10 --> **CORRECTED 2026-09-13 (R-2026-09-12-10), from the wave-1 launch seal (Tilion, 2026-09-12): this refutation was itself wrong on its central claim. 0.8843 IS in the cited PDF** — once, on **page 22**, under the section heading **3.1.4 "The asymmetry parameter"**, precisely the §3.1.4 the draft cited. Re-running the same extraction reproduces this refutation's fingerprint **exactly** (171 streams, all inflated, **1,121,056 chars**), so it is the same document; the string survives only when `Tj`/`TJ` show-text operators are decoded per line, because the glyphs are split across text-showing operators — **a whole-stream scan for the literal digits cannot find it**. Independently confirmed in the peer-reviewed version: A. Kokhanovsky, *Optical properties of terrestrial clouds*, **Earth-Science Reviews 64 (2004) 189–241, §3.1.4, page 205**. **What survives of this row, and it is the more important half:** 0.8843 is **g₀**, the large-particle geometrical-optics limit at n = 1.333, **not** a cloud-droplet value (Eq. 3.35 puts real water at g ≈ 0.845–0.874), so **A2's absolute band remains barred from pre-registration** — and the ≥0.05 per-genus separation clause remains gateable. **Lesson recorded, because it cost a launch-seal task:** a negative result from a text extraction is a statement about the *extractor*, not about the *source*, until the extraction method itself is shown adequate. **Kept with an `[unverified:]` marker plus "WHAT WOULD CONFIRM", and A2's absolute band is barred from pre-registration** (a gate on an unlocatable constant is what `R-2026-08-06 R3` forbids). The **≥0.05 per-genus separation clause** is a property of our own output and remains gateable today | §1.3 A2 `[unverified]`; `C13-N21` acceptance; §8 Unknown 7; §9 L4 proof bar; launch-seal item |
| **R9** | §4.4 / §6 — Takram author quote "…the latter is currently stuck…" cited to issue #50; "support rendering views from space" under Planned features | **The quote is not on that page.** Issue #50 is titled "Clouds: Render artifacts are apparent as the camera zooms out", is a **user** report of shadow artifacts from a satellite perspective proposing a fade-out. **Kept with `[unverified:]` and a structural warning**, because §6 uses this framing to reverse the `C13-29` deferral and D2/D3 lean on it. The supersession is **re-grounded** on the verifiable facts: no WebGPU cloud backend, no orbital demo, no cloud story above 8,444 m | §4.4 `[unverified]`; §6 first row; §8 Unknown 8 |
| **R10** | `C13-N01` — "extends a proven spec with a proven runner home… a material de-risking", sized **M**, 2× Sonnet | **Not a low-risk extension.** `lib/probe-fleet-contract-allowlist.mjs:39-45` is a flat frozen `probeFile → single-reason` map; the spec asserts every listed probe **still violates** (`:14-19`, `:679` shrink-only); 43 of the 60 cloud/god-ray probes are listed with watchdog-only reasons; routing = 26,959 lines across 60 probes. **Re-sized M → L and STAGED** — detector + census in Wave 1, routing in Wave 2 in family batches with their own allowlist generation | §0.7 (rewritten); `C13-N01`; §5.2; §5.3 Waves 1–2; §8 risk 5; D1 option (c); §9 L2 |
| **R11** | `C13-N02` / risk 4 — same census error as R2, and internally contradicted by the plan's own WS-G row | Consolidated with **R2**. Note recorded that the draft's §0 four-spec count contradicted its own later text naming `godray-energy-law` at `test-engine-node` | §0.8 |
| **R12** | `C13-42d` — compound symptom "`executeCalls = 0` **AND** `halfWidth/halfHeight/temporalWidth/temporalHeight` all 0" | **The zeros are the expected tier-3 configuration.** The banked error payload reads `maxSteps 96 / lightSteps 8` = tier 3 = `renderResScale 1.0`, `temporalEnabled false`; a **successful** run (`output/cloud-perf-adaptive.json` `readiness`) shows the same zeros with `executeCalls: 1`. **Symptom narrowed to `executeCalls = 0` only** — briefing the compound form sends a lane after a resource-allocation bug that does not exist | §0.11(a); `C13-42d` row; §5.1; D12 note |
| **R13** | `C13-42d` "reframed as an ENGINE row… nobody owns the engine side"; D12 recommends filing it as an engine row | **On the evidence at HEAD it is an instrument defect.** `lib/cloud-probe-harness.mjs:195-202` wraps `featureRenderer.execute` = `executeProceduralClouds` (`WebGPUFeatureRenderers.ts:870-878`); the live composition calls `cloudFR.executePreparedCloudFrame(...)` (`WebGPUSceneRendererEnvironmentalEffects.ts:327-329` → `WebGPUProceduralCloudRenderer.ts:5206`). **`C13-N08a` (harness readiness repair) promoted from Wave 2 to Wave 1 and made the first action**; `C13-42d` gated behind it; D12 restated to recommend "repair the harness first, then decide" | §0.11(b); new row `C13-N08a`; `C13-42d`; §5.3 Wave 1 lane α; D12 (3 options, recommendation changed) |
| **R14** | §2.4 / O9 / §8 risk 1 / Wave-1 deliverables — "No cloud frame cost has ever been measured in this repository" (4 places) | **False in all four.** `output/cloud-reconstruction-consume/report.json` banks per-cloud-pass GPU timings **with the union fold applied** (5 named passes, `avgMs` 3.7587 / 2.7494, `overlapMs: 0`); `cloud-perf-adaptive.json` `msPerFrame: 12.26`; `cloud-perf-fixed.json` `26.5833`; both `gpu-queue-drain-max-throughput`, nvidia/pascal, 1024×768, bundle sha256 pinned; `probe-cloud-perf.mjs` is ACTIVE with a pair-ID A/B protocol. **`C13-N06` re-scoped to EXTEND those probes**; O9 restated as "measured in aggregate but never per rung"; the "first in the project's history" line removed from the Wave-1 deliverables | §0.9 (new); §2.4; §1.3 O9; §8 risk 1; `C13-N06`; §9 L7; §9 closing paragraph |
| **R15** | `C13-N07` delivers "a cloud lane in `wave-end-gate.mjs`"; every wave exits via that runner | **The runner is fail-closed at HEAD** — `wave-end-gate.mjs:2`: every step `bindable:false`, every invocation refuses pre-spawn with exit 3, zero children, Q-152 open with zero receipts; confirmed in `buildStepPlan` `:359-398`. **Inert clause removed**; **new row `C13-N48` (Q-152 bindability repair) filed into Wave 1 lane L8**; every wave exit restated as the **manual three-step per `R-2026-09-02-3`** until it lands | §0.10 (new); `C13-N07a`/`C13-N07b` split; new `C13-N48`; §5.5; §6 superseded table; §8 risk 14; §9 exit condition |
| **R16** | §9 "One defect, one owner… no other file is briefed to two lanes" | **False in the draft itself.** `C13-N11` (lane L3) edits `ProceduralClouds.wgsl:2537` (the literal `0.5` in the sole `multiScatterLight` call), a file lane L4 owns. **`C13-N11` moved to L4**; the ownership block rewritten to state L4 owns the WGSL file, L3 owns the two TS files, L5 shares one with L3 with a landing order and a patch-path diff, and L1/L2 co-own the descriptor contract | §0.15 (new); `C13-N11` row note; §6 merged list; §9 ownership block and L3/L4 rows |
| **R17** | §5.3 Wave 1 lane α = `C13-42a → C13-42f → C13-42d → C13-42b` | **§9 assigned only two of the four**, and its Edge column deferred `C13-42f` to Wave 2 while `C13-42d` had no lane at all. **§5.3 and §9 reconciled**: lane α is `C13-N08a → C13-42a → C13-42b`; `C13-42f` and `C13-42d` move to Wave 2 explicitly | §5.3 Wave 1 / Wave 2; §9 L1 |
| **R18** | `C13-N06` acceptance — "{Shell,S1..S4} × {L0..L3} × {1080p, 4K}" in Wave 1 | **Unsatisfiable:** Shell is `C13-29` (Wave 4), S4 is `C13-N12` (Wave 6), L3 needs `C13-N18/N19/N20`+`C13-22` (Waves 3–4); §9 silently narrowed the same row. **Split into pass 1 (Wave 1, {S1,S2,S3} × {1080p,4K}) and pass 2 (after `C13-13` and `C13-29`)**, so "discharges half the M2 hold" rests on a bar the row can meet | `C13-N06`; §5.3 Waves 1 and 4; §9 L7 |
| **R19** | §9 — "L3/L4/L5 land in the evening window *before* the next tranche opens, and L7's measurement runs last" | **`R-2026-08-29-1` makes the named Edge leg part of the proof bar for engine/parity/shader rows**, i.e. owed before landing; as sequenced, three `[E]` batches land with their proof bar outstanding. **Sequencing inverted** (tranche first, land after — which the no-landings-during-a-tranche rule already permits) and **new decision D16** filed so a deferred leg would be ruled, not assumed | §9 constraints and Edge queue; new **D16** (launch seal) |
| **R20** | `C13-N05` deps "C13-N03; decision D10", scheduled Wave 2 | **D10 is one of the plan's own open decisions with no ruling checkpoint between Waves 1 and 2.** **D10 moved into the Wave-1 launch seal** (answerable with no code); the GMGSI header read added as a second precondition; fallback stated (slip `C13-N05` to Wave 3, drop O1 from Wave-2 acceptance) | `C13-N05` deps; §5.3 launch seal; §8 risk 15; D10 marked LAUNCH SEAL |
| **R21** | Lane β is independent of lane α and can run on the governed HEAD runtime | **Not independent at the descriptor seam.** `C13-N01` would route 60 probes to HEAD's `cells({…})` shape while `C13-42a` changes it (adds `scope`, `probe-runtime.mjs:1626`; requires `workBudgetMs`, `:1440-1447`) — 60 files rewritten twice. **`C13-N01` staged** (see R10); the seam named explicitly in §5.2 and in the §9 ownership block; **D1 gained option (c)** describing the unstaged form and its cost | §5.2; §5.3; §9; D1 |
| **R22** | *(consolidated)* duplicate reports of R5 and R7 | Folded into R5 and R7 above; both corrections applied once | — |

---

## Part B — UNVERIFIED claims kept with inline markers (7)

Each is retained in the plan with an `[unverified: …]` marker naming what the cited source actually says and what would confirm it. **None may be pre-registered as a gate or quoted to the maintainer as fact.**

| # | Claim | Why it could not be confirmed | Marker location |
|---|---|---|---|
| **U1** | D2(b) — "the Shell has no per-pixel march jitter at all, so it structurally cannot exhibit the stipple" | A property of code that does not exist: `CLOUD_TIER_PRESETS` has exactly four tiers (0–3), no shell entry, and `C13-29` is DEFERRED | §7 D2; decisions file D2 con-line. The weakest-recommendation and Wave-4-revisit framing is preserved |
| **U2** | `C13-N24` — "all GFS cloud records are template 5.3 = integer bit-unpack + prefix sum: no JPEG2000, no WASM" | **PARTLY RESOLVED BY MEASUREMENT, 2026-09-12 — see Part F.** The citation was still wrong (the NCEP page defines what 5.3 *is*, not which template GFS uses), and the mechanism description was wrong (5.3 is complex packing with group splitting, not simple bit-unpack). But the substantive claim now has evidence for two records. Four record types remain unchecked | `C13-N24` (marker replaced with the measurement); §4.1 GFS row; §6 (`C13-26` now superseded for the measured records, conditional for the rest); §8 Unknown 1; D6 (recommendation no longer conditional on the whole check) |
| **U3** *(CONFIRMED 2026-09-12 — the header was read)* | GMGSI "~42 min latency, 7–8 MB NetCDF, 71°N–71°S" | The AWS registry page confirms ~8 km, hourly, the bucket ARN and the open-data statement — but states **no** latency, format, size or latitude range; and §8 already conceded the grid/projection are undocumented. <!-- corrected 2026-09-13, R-2026-09-12-10 --> **RESOLVED 2026-09-13 (R-2026-09-12-10), from the wave-1 launch seal (Tilion, 2026-09-12): the "WHAT WOULD CONFIRM" step was performed and the draft's three figures were close but not exact.** Latency **≈43 min**, not ~42 (S3 median **42.8–42.9 min**, n = 96 over a full UTC day) — the draft's number was right to the minute by luck, not by source. Format **NetCDF-4/HDF5, CF-1.8**, **7–8 MiB** on the wire and **185.9 MiB** uncompressed — confirmed. Latitude **±72.7°** (72.7154 N / 72.7368 S), **not 71°** — the draft was ~1.7° optimistic, and the two absent caps are **4.51 % of Earth's surface**, which a referee must **mask** rather than read as clear. And the undocumented grid/projection §8 conceded is now **measured**: there is no `grid_mapping`, `crs` variable or CRS attribute anywhere in the file, and the grid is **spherical Mercator** (fit max error **0.000036°** against **11.07°** for plate carrée). | §4.1 GMGSI row; §8 Unknown 4; added as a `C13-N05` precondition. ~~**WHAT WOULD CONFIRM:** read one file's NetCDF header~~ — **done; §4.1 and §8 Unknown 4 are corrected in place.** |
| **U4** | DWD ICON "CC BY 4.0" | The cited page confirms the availability disclaimer verbatim but states **no licence** (it points at separate conditions of use); the 13 km figure and CLC* field list are also not on it | §4.1 ICON row; §8 Unknown 5. **WHAT WOULD CONFIRM:** DWD's GeoNutzV / conditions-of-use page |
| **U5** | Takram `localWeather.frag` carries "// TODO: Tile and fix seams" | The file was fetched: four RGBA procedural channels confirmed, **no TODO comments present** | §4.4. The substantive "no data path" half is confirmed and stands |
| **U6** | Takram "≈32 ms without upscaling" on M3 Max; "RTX-4090 rows vsync-pinned at 60" | The README table reports **FPS**, and the rows found were M3 Max 92–95 / M2 Ultra 60 / iPad Pro M4 60 / iPhone 13 36–53. No no-upscaling M3 Max row and no RTX-4090 row appeared | §2.4. The ~10.5 ms conversion (from the confirmed 92–95 FPS row) is retained; the table is now quoted as FPS with device/resolution/preset/upscaling intact |
| **U7** | §2.2 rung cost targets (S_shell ≤0.5, S1 ≤2.0, S2 ≤4.0, S3 ≤8.0, S4 ≤16 ms @1080p p50) | The external anchors were not fetched (no network in this lane). Worse: the only banked datapoint on the measuring machine is **12.26 ms/frame at 128 steps, 0.79 MPx** — 1080p is 2.6× the pixels, so **S3 and S4 sit below it** | §2.4 block quote; §8 risk 1. Restated as **hypotheses to be refuted by `C13-N06`**; no row's acceptance may cite them until measured |

---

## Part C — Critique items (25), and what was added for each

### Coverage of the maintainer's four goals

| # | Item | Verdict | What was added |
|---|---|---|---|
| **C1** | Weather **fronts** — named verbatim in goal 3 — had a row but no statistic | MISSING | New bar **P1 Frontal ladder** (≥1000 km band at ≥3:1 anisotropy; four-étage sequence in one column at three cross-front sample lines; cold-front leading edge ≥2× sharper than trailing) and it is now `C13-N28`'s acceptance, with `C13-N23` and `C13-N38` as hard deps |
| **C2** | The frontal ladder and per-texel genus are unbuildable at HEAD; no row widened the genus decode | MISSING | New row **`C13-N38` Per-texel genus profile** (L, `[+D]`, Wave 3): extinction, phase-G, erosion style, fibre morphology and deck assignment become per-texel, with an **explicit uniform/bind-group budget**. Acceptance: two adjacent texels with different genus ids produce different extinction AND phase in one frame, inertness mutant restores the collection-level value. Made a dep of `C13-N27`, `C13-N28`, `C13-16` and `C13-23` |
| **C3** | Channel-G collision: `C13-N27` writes a regime id into a channel with two live producers and a live consumer | MISSING | `C13-N27` gains an explicit **channel-budget deliverable** — a fifth channel / second texture, or a documented bit-split of G with both decoders updated — plus a regression assertion that a METAR-fixture render is byte-identical in genus behaviour. §4.3 restated: "G is NOT free" |
| **C4** | Four named patterns (streets, orographic, fog, marine-Sc LTS) routed to a row that measured three | WEAK | New row **`C13-N27b`** and new bar **P4** with a statistic per pattern (streets ≥4:1 within 15° of the 10 m wind; orographic r ≥0.5 with terrain-gradient·wind; fog edge sharpness ≥2× and diurnal burn-off; marine Sc LTS-sweep response band) |
| **C5** | Goal 3 undelivered for the default (no-provider) user for the whole campaign, and first-ish on the cut line | MISSING | New row **`C13-49-slice`** (M, **Wave 2**) replacing `buildProceduralWeatherMap` with a latitude-banded, seasonally-phased, time-parameterised field, and new bar **P5** (ITCZ, subtropical clear belts, mid-latitude storm track each detectable in a zonal-mean profile with no provider). Added to the "must not be cut" list |

### Acceptance and instruments

| # | Item | Verdict | What was added |
|---|---|---|---|
| **C6** | The orbital instrument was a deliverable inside the Wave-4 row it was to judge, while Wave-1/3 rows already claimed orbital bars | MISSING | New row **`C13-N04b` orbital ladder probe** in **Wave 1 lane L6**, computing O3/O4/O6/O7 across the 20 km→20,000 km sweep. `C13-N20`, `C13-N14` and `C13-29` all re-pointed to score against it; §9 L4's "one orbital capture pair" downgraded-proof replaced with the measured statistic |
| **C7** | Cloud scenes entered the standing gate only in Wave 4, after nine engine landings | MISSING | `C13-N07` **split**: **`C13-N07a`** (2 WebGPU-baseline scenes, **Wave 1**, no `C13-29` dep) and `C13-N07b` (cross-backend, Wave 4). The Edge queue puts L6's baselines **first** in the tranche |
| **C8** | A3, A6 and G1 were stated as bars and appeared in no row's acceptance | MISSING | New row **`C13-N39` Photometric conformance suite** owning all three, riding `C13-21`'s energy work and `C13-N27`'s coverage response. Owning-row column added to every bar in §1.3 |
| **C9** | The flight-sim band had no flight fixture — T1's forward leg and A9 unmeasurable | MISSING | `C13-N03` extended (S → **L**) with 3 in-atmosphere stations (10 km cruise, between decks, and a 100 m/s forward traverse with declared duration and cadence) and 1 crosswind station. Made a dep of `C13-44` and `C13-12` |
| **C24** | Queue §8's geography / lifecycle / consumer dimensions were inherited as binding and nothing was filed | MISSING | The 8 geographic stations added to `C13-N03`; new row **`C13-N50`** for lifecycle on the widened 3-slice weather texture (context destroy, device loss, two simultaneous contexts, cache pressure), Wave 2. §3 preamble now names both owners |
| **C23** | No row derived and landed the null `CHARACTERIZATION_THRESHOLDS` | MISSING | New row **`C13-N47`**: run the calibration, write the thresholds, and carry an `R-2026-08-06 R3` compliance statement showing each derived bar can still fail. Acceptance: `characterizationDisposition()` returns `"acceptance"` |
| **C25** | The wave-end gate is load-bearing for all six waves and has never produced a receipt | WEAK | New row **`C13-N48`** in **Wave 1 lane L8**; every wave exit restated as the manual three-step per `R-2026-09-02-3` until it lands. (Same correction as R15.) |

### Performance

| # | Item | Verdict | What was added |
|---|---|---|---|
| **C16** | Cost measured once in Wave 1 and never again; no standing cloud perf gate | MISSING | New row **`C13-N43`** — cloud lane in `c11-170-perf-regression-gate.spec.mjs` (today `grep -ci cloud` → 0), Wave 2, pinning each rung's p50/p95 at 1080p and 4K plus peak VRAM with a stated noise band, re-run per wave. `C13-N06` made re-runnable by design (two passes) |
| **C17** | The cost table was 1080p-p50-only, with no 4K or memory bar, and discarded existing measurements | WEAK | §2.2 gained **@4K p50** and **peak VRAM delta** columns; `C13-N06` re-scoped to **extend** `probe-cloud-perf.mjs`'s pair-ID A/B protocol; the "never measured" claim replaced by "never measured *per rung, with p95 and allocation counts*" (see R14) |
| **C13** | No adaptive quality controller — the only scaling input is camera altitude | WEAK | New conditional row **`C13-N42`** (frame-budget-aware hysteretic rung selection, default off; acceptance: a synthetic 2× inflation causes exactly one rung drop and no oscillation over 600 frames) and new decision **D18** forcing the alternative to be *stated* rather than left silent |

### Product surface

| # | Item | Verdict | What was added |
|---|---|---|---|
| **C12** | The two-axis ladder had no public API, no docs, no demo — "users can scale down" designed and never exposed | MISSING | New row **`C13-N41` Public two-axis quality surface** (Wave 3, immediately after `C13-13`): a documented lighting-quality dial, `"shell"`/`"ultra"` honoured, JSDoc + CHANGES, and `packages/sandcastle/gallery/cloud-parameters` exposing S and L separately with each rung's measured cost. Acceptance: every documented enum value is reachable **and changes the image**. §2.1 gained defect 5 recording the gap |
| **C21** | Cloud→IBL and cloud→reflections default-off, unmeasured, and covered by no bar — although "cloud-related lighting" is goal 1 | MISSING | New bars **L1 Overcast response** and **L2 Reflection consistency**, and new row **`C13-N49`** owning them (also repointing the dead `globe.showProceduralClouds` reference at `WebGPUDynamicEnvironmentMapManager.ts:2423`). Defaults explicitly *not* silently flipped (`SR-1`) |
| **C20** | `C13-30`, `C13-33`, `C13-34` left "kept unchanged (deferred)" though each sits inside a stated goal | MISSING | All three **pulled in**: `C13-34` (env-map cloud shadow, an S) into Wave 4 beside `C13-22`; `C13-30` (precipitation, minimal `PRATE`/`ww` slice) into Wave 5 beside `C13-N29`; `C13-33` re-pointed as the **goal-3 demo** onto `C13-N24`/`C13-N45` |

### Parity floor

| # | Item | Verdict | What was added |
|---|---|---|---|
| **C14** | The WebGL floor was scoped as one shader twin, but the backend has no cloud plumbing at all | WEAK | **`C13-N15` re-sized L → XL and split (a)(b)(c)(d)**: renderer class + Scene wiring + composite-point decision; the WebGL weather upload path off the same packer bytes; the GLSL shell shader; and the explicit documented degradation contract `QUEUE_2026-07-23_CAMPAIGN13.md:344-347` requires. §1.4 gained a "why it is XL, not L" paragraph with the grep evidence |
| **C15** | Two bars assigned to WebGL (H3, O6) were unreachable under a shell-only floor | MISSING | **H3** made reachable by requiring **3 analytic shells over the 3 slices** in the WebGL floor; **O6** restated on WebGL as continuity across the 20 km→20,000 km sweep with the shell alone. Both written into §1.4 and put as decision **D19** so the alternative (drop the bars) is explicit |

### Data path

| # | Item | Verdict | What was added |
|---|---|---|---|
| **C18** | No provider failure path: no timeout, cache, tick driver, or offline determinism of the rendered result | MISSING | New row **`C13-N44` Provider degradation ladder** — engine-driven tick, bounded retry, stale-slice-with-provenance, timeout → procedural fallback **byte-identical to the no-provider render**, slice cache with a byte ceiling. `C13-24`'s acceptance also amended to **assert the tick actually drives** |
| **C19** | The honesty/provenance contract quoted as binding with no implementing row | MISSING | New row **`C13-N45` Weather provenance surface** — `scene.weather.provenance` with source id, `validTime`, attribution and a synthetic/observed flag; consumers for the three `WeatherTypes.ts:118-122` fields that have none. Acceptance: a procedurally-filled texel reports `synthetic`; this is what "a synthetic-as-observed mutant must fail" actually needs |

### Closure and honesty

| # | Item | Verdict | What was added |
|---|---|---|---|
| **C22** | No reachable exit: GATE-D deps on the descoped `C13-14`; GATE-C deps scattered; none of the new bars in any gate | MISSING | New row **`C13-N46`** (Wave 1 ledger) re-writing Gates C/D and EXIT against the v2 bars, **and new decision D17**, since changing a ratified gate's dependency list is a maintainer act |
| **C10** | The cut line removed the maintainer's stated second-priority goal first while claiming it was still delivered | WEAK | §5.4 rewritten to state exactly what the reduced set delivers and abandons: goal 1's lighting half **not at all**; goal 4's in-atmosphere half degraded, with **only A2's separation clause and A4 surviving** and A1/A3/A5/A6/A7/A9/I1–I3/T1 named as abandoned. "Must not be cut" list extended with `C13-49-slice`, `C13-N04b`, `C13-N07a`, `C13-N48`, `C13-N46`, `C13-N47` |
| **C11** | "Above and beyond Takram" has no comparison instrument and no row that would create one | MISSING | New row **`C13-N40` Peer head-to-head instrument** (Wave 2, L): stand the peer's cloud scenes up locally at matched resolution/camera/sun, capture the A-bar statistics plus frame time on this machine, bank a side-by-side; **T1 becomes the head-to-head bar** since their README names ghosting/smearing on a forward run as unfixed. New decision **D20** so declining to fund it forces the honest alternative to be said out loud |

---

## Part D — Decisions added by this pass

| ID | Subject | Origin |
|---|---|---|
| **D16** | Edge-leg ordering vs landing (`R-2026-08-29-1` makes the leg part of the proof bar) | R19 |
| **D17** | Re-write Gates C/D and EXIT against the v2 bars | C22 |
| **D18** | Adaptive quality controller, or state that scaling is manual + altitude-only | C13 |
| **D19** | WebGL bar list — multi-deck shell + shell-only O6, or drop H3/O6 | C15 |
| **D20** | Fund the peer head-to-head instrument, or state that goal 2 has no acceptance | C11 |

Existing decisions materially changed: **D1** (gained the staged option, now recommended), **D2** (recommendation's premise marked unverified), **D3** (floor now multi-deck and XL), **D5** (sizing corrected S → M), **D6** (recommendation made conditional on the template check), **D10** (moved into the launch seal), **D12** (recommendation inverted — harness first, not engine row).

---

## Part E — Row-count delta

| | Draft | Final |
|---|---|---|
| New `C13-N` ids | N01–N37 (37) | **N01–N50 (50)**, with `N04b`, `N07a/b`, `N08a/b`, `N27b` as splits |
| Existing C13 rows re-scoped / re-pointed / pulled in | 21 | **24** (adds `C13-30`, `C13-33`, `C13-34`) |
| Rows added by the critique | — | **N38–N50 plus `C13-49-slice`, `C13-N04b`, `C13-N07a`, `C13-N08a`, `C13-N27b`** |
| Rows re-sized | — | `C13-N01` M→L, `C13-N03` M→L, `C13-N15` L→XL, `C13-N22` S→M |
| Waves | 6 | 6 (unchanged; Wave 1 grew from 8 lanes' worth of rows to 20 rows across the same 8 lanes) |

---

## Part F — Resolved after the pass, by measurement (1)

### U2 — GFS cloud-record GRIB2 data-representation template

**Status: PARTLY RESOLVED. Two of six record types measured; four still owed.**

The scratchpad already held two real GFS 0.25° cloud records banked by an earlier research lane, so the check the plan had scheduled as a launch-seal item was run here instead of deferred. Each message was walked section by section from offset 16 (4-byte length, 1-byte section number) and Section 5 octets 10-11 read directly:

```
=== lcdc.grib2 (756,598 bytes), discipline=0, edition=2
  S1 len=21
  S3 len=72   gridTemplate 3.0
  S4 len=34   prodTemplate 4.0  param=6/3      (category 6 = cloud, parameter 3 = low cloud cover)
  S5 len=49   numPoints=1038240  DRS TEMPLATE 5.3
  S6 len=6
  S7 len=756,396

=== t.grib2 (731,729 bytes), discipline=0, edition=2
  S4 len=34   prodTemplate 4.0  param=6/1
  S5 len=49   numPoints=1038240  DRS TEMPLATE 5.3
```

**What this establishes.**

1. **No JPEG2000 and no WASM decoder for these records.** Template 5.3 is complex packing with spatial differencing — integer work, decodable in pure TypeScript. `C13-N24`'s core premise holds for the records measured, and the `C13-26` WASM clause is genuinely superseded for them.
2. **The native-grid figure is independently confirmed.** `numPoints = 1,038,240 = 1440 × 721` — the same number §1.2 uses to derive 27.8 km/texel and the 5.6× gain for `C13-N22`. That arithmetic was previously carried from a `.idx` read; it is now confirmed from the record header itself.
3. **The mechanism description in the draft was still wrong and stays corrected.** Template 5.3 is not "integer bit-unpack + prefix sum": it carries group splitting with per-group reference values, group widths and group lengths *before* the spatial-difference recursion. `C13-N24` must be sized for complex packing.

**What is still owed (the same one-line check, four times):** `MCDC`, `HCDC`, the per-layer `PRES` cloud bottom/top, and `TMP` cloud top were not in the banked pair. Until they are checked, `C13-N24`'s **L** sizing and **D6(a)** rest on a two-record sample. If any is template 5.40, that record alone needs a J2K path and the `C13-26` clause returns for it.

**Recipe, for whoever runs the remaining four:** walk sections from offset 16 by their 4-byte big-endian length; at section number 5, `readUInt32BE(off+5)` is the point count and `readUInt16BE(off+9)` is the template number. Or `wgrib2 -packing`.
