# Maintainer rulings — 2026-09-12

## R-2026-09-12-1 — C13 capture spine: two lanes, C13-N01 staged (D1)

R-1 (D1) capture spine: TWO lanes; C13-N01 STAGED (detector + census in wave 1; routing in wave 2 after C13-42a lands).

Basis: `CAMPAIGN_13_V2_DECISIONS_2026-09-12.md` D1 (capture-spine strategy), derived from C13 plan §0.7, §3 `C13-N01`, §5.2, §5.3 Waves 1–2, and §9 L2.

Executed: Batch 1476 (2026-09-12).

Authority: charter §1.1.

## R-2026-09-12-2 — C13-15/16/17/20 re-pointed; C13-14 deferred behind a measured ceiling — a re-sequencing under RULING-2026-08-06 R2 (D4)

R-2 (D4) re-sequencing: C13-15/16/17/20 re-pointed onto C13-N22/N23/N27/N38; the C13-14 weather quadtree deferred behind the first measured resolution ceiling (~4096x2048). Ruled as a re-sequencing under RULING-2026-08-06 R2, not a re-scope.

Basis: `CAMPAIGN_13_V2_DECISIONS_2026-09-12.md` D4 (re-point `C13-15/16/17/20` off the XL `C13-14`), derived from C13 plan §3 WS-E, WS-F, and §6.

Executed: Batch 1476 (2026-09-12).

Authority: charter §1.1.

## R-2026-09-12-3 — C13 gates rewritten now as a Wave-1 ledger row C13-N46 (D17)

R-3 (D17) gates rewritten now as a wave-1 ledger row (C13-N46): GATE-D deps -> C13-N22/N23/N24/N27; GATE-C names the rung cost table; EXIT enumerates gate bars vs calibration bars per renderer.

Basis: `CAMPAIGN_13_V2_DECISIONS_2026-09-12.md` D17 (re-write Gates C/D and EXIT against the v2 bars), derived from C13 plan §3 WS-H `C13-N46`, §5.3 Wave 1 lane β, and §9 L8.

Executed: Batch 1476 (2026-09-12).

Authority: charter §1.1.

## R-2026-09-12-4 — Edge-leg ordering: the named leg runs before the landing for every [E] row (D16)

R-4 (D16) Edge-leg ordering: the named Edge leg runs BEFORE the landing for every [E] row (R-2026-08-29-1 read literally); tranche first, land after.

Basis: `CAMPAIGN_13_V2_DECISIONS_2026-09-12.md` D16 (Edge-leg ordering vs landing), derived from C13 plan §5.2, §5.3, §5.5, and §9.

Executed: Batch 1476 (2026-09-12).

Authority: charter §1.1.

## R-2026-09-12-5 — Default weather source: GFS primary + GMGSI referee + ECMWF second; four GRIB2 template checks as a Wave-1 seal task (D6)

R-5 (D6) default weather source: GFS primary + GMGSI imagery referee + ECMWF as a second provider behind the same interface; the four remaining GRIB2 template checks (MCDC/HCDC/PRES/TMP) are a wave-1 launch-seal task before sizing C13-N24.

Basis: `CAMPAIGN_13_V2_DECISIONS_2026-09-12.md` D6 (default data source), derived from C13 plan §3 `C13-N24`, §4.1, §5.3, and §9.

Executed: Batch 1476 (2026-09-12).

Authority: charter §1.1.

## R-2026-09-12-6 — Ground-truth imagery: fetch at probe time, derive, pin a fixture set (D10)

R-6 (D10) ground-truth imagery: fetch at probe time, bank derived metrics only, small pinned fixture set for offline reproducibility; WMO Atlas photos and flight-sim screenshots excluded; ESDIS/NOAA acknowledgements in the manifest.

Basis: `CAMPAIGN_13_V2_DECISIONS_2026-09-12.md` D10 (ground-truth evidence licensing), derived from C13 plan §3 `C13-N05`, §4.1, §4.2, and §9.

Executed: Batch 1476 (2026-09-12).

Authority: charter §1.1.

## R-2026-09-12-7 — The single Edge slot: C13-41's discriminator first; cloud work pure-Node until it returns; then L6 -> L3 -> L4 -> L5 -> L7 (D9)

R-7 (D9) the single Edge slot: the C13-41 exposure-sweep discriminator (R-2026-09-02-5) runs FIRST after the P0-2 gate; cloud work stays pure-Node until it returns; then the cloud Edge queue L6 -> L3 -> L4 -> L5 -> L7.

Basis: `CAMPAIGN_13_V2_DECISIONS_2026-09-12.md` D9 (cloud quality vs `C13-41` for the single Edge slot), derived from C13 plan §5.2, §5.3, §5.5, §6, and §9.

Executed: Batch 1476 (2026-09-12).

Authority: charter §1.1.

## R-2026-09-12-8 — WebGL parity: FULL, including the GLSL march twin and a GLSL god-ray stack; AR-D13 answered (D3)

R-8 (D3) WebGL parity: FULL parity including the GLSL march twin of ProceduralClouds.wgsl and a GLSL god-ray stack (answers AR-D13 as full parity) - the plan's WS-C shell-only floor is superseded by a full WebGL workstream; the shell stays as the cheap rung on both backends.

Basis: `CAMPAIGN_13_V2_DECISIONS_2026-09-12.md` D3 (scope of the WebGL parity floor / open decision `AR-D13`), derived from C13 plan §0.16–§0.19, §1.4, §2, §3 WS-C / WS-C2, §5.3 Wave 7, §5.4, §6, §8 risk 17, and §9.

Executed: plan ratified; execution begins Wave 4 (`C13-N15a`–`d`) and Wave 7 (WS-C2).

Authority: charter §1.1.

## R-2026-09-12-9 — Globe.js cloud default: keep HELD; revisit at Wave 4 (D2)

R-9 (D2) Globe.js cloud default: keep HELD (R-2026-09-10-6); REVISIT at wave 4 with default ON at the shell rung on both backends, the march off until C13-44 + a measured frame cost.

Basis: `CAMPAIGN_13_V2_DECISIONS_2026-09-12.md` D2 (the M2 `Globe.js` default, held under `R-2026-09-10-6`), derived from C13 plan §5.3 Wave 4, and §5.5.

Executed: Batch 1476 (2026-09-12).

Authority: charter §1.1.

## R-2026-09-12-10 — Archive-hold scope: dated in-place corrections permitted; C13-N33 may proceed in Wave 2 (D13)

R-10 (D13) archive hold scope: in-place corrections of factually false sentences are permitted (dated), no file moved or repointed; C13-N33 may proceed in wave 2.

Basis: `CAMPAIGN_13_V2_DECISIONS_2026-09-12.md` D13 (scope of the archive hold for `C13-N33` doc re-stamping), derived from C13 plan §3 `C13-N33`, §5.3 Wave 2, §5.5, and §6.

Executed: Batch 1476 (2026-09-12).

Authority: charter §1.1.

## R-2026-09-12-11 — Adaptive quality controller C13-N42: BUILD, default off, Wave 3 (D18)

R-11 (D18) adaptive quality controller C13-N42: BUILD, default off, wave 3; acceptance = a synthetic 2x cost inflation causes exactly one rung drop and no oscillation over 600 frames.

Basis: `CAMPAIGN_13_V2_DECISIONS_2026-09-12.md` D18 (adaptive quality controller), derived from C13 plan §2.5, §3 WS-B `C13-N42`, and §5.3 Wave 3.

Executed: Batch 1476 (2026-09-12).

Authority: charter §1.1.

## R-2026-09-12-12 — Peer head-to-head instrument C13-N40: FUND, Wave 2 (D20)

R-12 (D20) peer head-to-head instrument C13-N40: FUND (wave 2, L); "above Takram" becomes a per-statistic dated claim; T1 (forward-run ghosting) is the head-to-head bar.

Basis: `CAMPAIGN_13_V2_DECISIONS_2026-09-12.md` D20 (peer head-to-head instrument), derived from C13 plan §3 WS-H `C13-N40`, §4.4, §5.3 Wave 2, §5.4, and §8 risk 16.

Executed: Batch 1476 (2026-09-12).

Authority: charter §1.1.

## Note — defaults taken 2026-09-12 (D5, D7, D8, D11, D12, D14, D15, D19)

Defaults taken at the plan's recommendation unless the maintainer vetoes: D5 weather texture 1440x721 now (M, seam spec updated in the same batch); D7 CLOUD_TIER_PRESETS canonical, resolveCloudQuality literals deleted; D8 provisional (b) accept ~1.2:1 with re-derived failable gates; D11 gate the spectrum and fractal bars, calibrate IoU; D12 repair the harness first (C13-N08a), engine row only if executeCalls = 0 survives; D14 file C13-47/48/49, priorities stamped "superseded by C13 v2 §5"; D15 bake a second STBN volume; D19 superseded by R-8 (full parity) - the interim shell keeps multi-deck.

Owning rows for the defaults:
- **D5:** `C13-N22` (Wave 1, M; seam spec updated in same batch).
- **D7:** `C13-N10` (Wave 1, S; presets canonical, literals deleted).
- **D8:** `C13-16` (Wave 5, M; provisional (b) accept ~1.2:1 with re-derived failable gates C/D/E).
- **D11:** `C13-N04`, `C13-N05` (Wave 1/2; gate spectrum and fractal bars, calibrate IoU).
- **D12:** `C13-42d`, gated behind `C13-N08a` (Wave 1; repair harness first, engine row opens only if executeCalls = 0 survives).
- **D14:** `C13-N32` (Wave 1, S; file C13-47/48/49, priorities stamped "superseded by C13 v2 §5").
- **D15:** `C13-11` part 2 (Wave 2, S; bake a second scalar STBN volume).
- **D19:** `C13-N15c` (Wave 4, M; superseded by R-2026-09-12-8 full parity — the interim shell keeps multi-deck).

## Note — seat sequencing from the C13-42a lane

Seat sequencing from the C13-42a lane (Minardil/Ciryaher): C13-42a-3 item 8 (a malformed scope.run third argument silently drops work and reports success - spec-pinned, not fixed) is sequenced BEFORE C13-42a-2 (the 18 legacy probes' migration).

Reason: a runtime that silently drops work would make eighteen migrations' evidence untrustworthy.

## Note — the eight defaults stood unvetoed through Wave 1 (recorded 2026-09-13)

The defaults note above (D5, D7, D8, D11, D12, D14, D15, D19) was taken "at the plan's
recommendation unless the maintainer vetoes". **No veto arrived, and Wave 1's Node-only lanes
executed against them.** Their state as of Batch 1482 (`77789c120b`, 2026-09-13 12:53:15 -0400),
each figure from the batch that produced it:

- **D5** (weather texture 1440×721 now, seam spec in the same batch) — lane L5 (Ossë) FROZEN
  2026-09-13, not yet landed; the constant bump surfaced a 1,135 ms first-frame stall reduced to
  300 ms byte-identically, and the seam mirror plus a second mirror the plan's §0.14 missed
  (`weather-field-bounds.spec.mjs`) are in the freeze. Edge leg 4 owed before landing.
- **D7** (`CLOUD_TIER_PRESETS` canonical, `resolveCloudQuality` literals deleted) — lane L3 (Ulmo)
  FROZEN 2026-09-13, not yet landed; Edge leg 2 owed before landing.
- **D8** (provisional (b) accept ≈1.2∶1 with re-derived failable gates) — untouched; `C13-16` is
  Wave 5.
- **D11** (gate the spectrum and fractal bars, calibrate IoU) — **EXECUTED, Batch 1480**
  (`39283ec388`, 2026-09-12 15:16:28 -0400): `lib/cloud-spectrum.mjs` ships validated on
  synthetic fields of known slope, `cloud-spectrum.spec.mjs` 9/9.
- **D12** (repair the harness first, engine row only if `executeCalls = 0` survives) —
  **EXECUTED, Batch 1478** (`e69d3e4fc7`, 2026-09-12 14:09:11 -0400): `C13-N08a` repaired the
  readiness instrument; `C13-42d` stays gated behind the `baseline-01` re-run, which needs the
  browser and is owed.
- **D14** (file `C13-47`/`-48`/`-49`, priorities stamped "superseded by C13 v2 §5") —
  **EXECUTED, Batch 1476**, confirmed at the tree by `C13-N32` in **Batch 1481**
  (`9f3723b0b3`, 2026-09-12 15:30:28 -0400).
- **D15** (bake a second scalar STBN volume) — untouched; `C13-11` part 2 is Wave 2.
- **D19** (superseded by `R-2026-09-12-8`; the interim shell keeps multi-deck) — unchanged.

Recorded by the record lane, not ruled: this note reports execution state and mints no authority.

## Note — seat rulings taken during Wave-1 execution (2026-09-12 and 2026-09-13)

Seat rulings, not maintainer rulings. Recorded here so the wave's decisions have one index; each
lives in full where it is cited. Three of them are additionally put to the maintainer as
**ruling requests** in `RULING_REQUESTS_2026-09-08.md` (`RR-2026-09-13-A` the quarantine-runner
convention, `RR-2026-09-13-B` a red guard gets a repair row, `RR-2026-09-13-C` a seat gate never
runs a suite that reads a held file; `RR-2026-09-13-D` is the landing-gate corollary).

1. **Quarantine runner** (2026-09-12, lane L2): 18 green cloud specs to `test-cloud-c13`, 7 red to
   a standalone `test-cloud-c13-quarantine` in no aggregate; `C13-N08b` re-scoped add-only to
   repair them. Executed Batch 1479. → `RR-2026-09-13-A`.
2. **`cloud-probe-harness.spec.mjs` homed by L1**, not L2, as part of `C13-N08a`; L2 counts it
   "homed by another lane" and the landing unions the `package.json` script line. Executed
   Batches 1478/1479.
3. **`C13-N07a` entries HELD** (2026-09-12, lane L6): a `scenes.json` entry without a banked
   baseline makes `capture-and-diff.mjs` exit 1 by construction, so the two cloud scenes land with
   their baselines in the executor's reviewed commit; the override-must-name-its-remover spec lands
   first. Executed Batch 1480, with the held entries tracked at
   `Tools/visual-regression/scenes-cloud-pending.json`.
4. **L8 granted ownership of `capture-and-diff.mjs`** for one additive default-off change
   (`--served-base` plus a `WAVE_END_SOURCE_*` env preference), every existing refusal kept.
   Executed Batch 1481; `C13-N48` is DONE-pending-first-receipt.
5. **A seat gate never runs a suite that reads a held file** (2026-09-12 landing incident); lane
   gates are the lane's own spec commands. → `RR-2026-09-13-C`.
6. **A red guard gets a repair row in the next batch**, never a standing "same four" annotation
   (2026-09-12, from the nine-day `probe-fleet-contract.spec.mjs` red). → `RR-2026-09-13-B`.
7. **`WebGPUProceduralCloudRenderer.ts` and `WebGPUCloudTierPresets.ts` have ONE owner** (lane L3),
   with the three hunks lane L4 needs landing in L3's batch and L4 landing after L3
   (2026-09-12/13). Neither lane has landed; the ordering is stated in both packets.
8. **`C13-N20`'s promotion corrected** (2026-09-12): under `auto`, `cloudAerialMode` "physical"
   defaults ON above the blend altitude with **no** spatial-tier test, isolated in
   `shouldDefaultPhysicalAerial`; the earlier "tier ≥ 2" reading is unreachable because
   `resolveTier` maps `cameraHeight >= disableAltitude` to tier 1. Not byte-identical above the
   band edge under `auto`, by intent.
9. **Preset values pinned to the pre-wiring literals** (2026-09-13, lane L4): `powderStrength` 0.5
   and both floors 0 at all five sites, so the wiring lands byte-identical; the intended tuning is
   a follow-up row under `C13-N11` with an Edge capture. A ruling that pins values needs a spec
   that guards the pin — L3 landed one (28/28, un-pinning all five sites goes 25/28 RED).
10. **Edge legs never revert and re-apply inside one tree** (2026-09-13, from five verifier rounds
    on L3's leg 2): BEFORE is the main tip at leg time, AFTER is a fresh clone of that tip with the
    lane patch applied three-way, both md5-asserted, the apply step asserting `git ls-files -u` is
    empty rather than grepping for conflict markers, every capture naming its origin and every
    command written in full.
11. **A frozen tree is never mutated in place** (2026-09-13, P0-2 review): mutants run in a temp
    copy under the lane temp root, and the landing wrapper re-asserts the freeze md5.
12. **The union set at landing includes the campaign queue's §9 status ledger** (2026-09-12): three
    lanes appended add-only rows there in one wave and the first union resolver did not cover it.
13. **`R-HANDOFF-1` … `R-HANDOFF-11`** (2026-09-13) adjudicate the solo-row set and are **not
    restated here** — they live in `SOLO_WORKER_HANDOFF_2026-09-13.md` §2.3, which is their
    authority, and landed in Batch 1482.
