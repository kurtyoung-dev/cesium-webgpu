# Maintainer rulings — 2026-09-12

## R-2026-09-12-1 — C13 capture spine: two lanes, C13-N01 staged (D1)

R-1 (D1) capture spine: TWO lanes; C13-N01 STAGED (detector + census in wave 1; routing in wave 2 after C13-42a lands).

Basis: `CAMPAIGN_13_V2_DECISIONS_2026-09-12.md` D1 (capture-spine strategy), derived from C13 plan §0.7, §3 `C13-N01`, §5.2, §5.3 Waves 1–2, and §9 L2.

Executed: Batch NNNN (2026-09-12).

Authority: charter §1.1.

## R-2026-09-12-2 — C13-15/16/17/20 re-pointed; C13-14 deferred behind a measured ceiling — a re-sequencing under RULING-2026-08-06 R2 (D4)

R-2 (D4) re-sequencing: C13-15/16/17/20 re-pointed onto C13-N22/N23/N27/N38; the C13-14 weather quadtree deferred behind the first measured resolution ceiling (~4096x2048). Ruled as a re-sequencing under RULING-2026-08-06 R2, not a re-scope.

Basis: `CAMPAIGN_13_V2_DECISIONS_2026-09-12.md` D4 (re-point `C13-15/16/17/20` off the XL `C13-14`), derived from C13 plan §3 WS-E, WS-F, and §6.

Executed: Batch NNNN (2026-09-12).

Authority: charter §1.1.

## R-2026-09-12-3 — C13 gates rewritten now as a Wave-1 ledger row C13-N46 (D17)

R-3 (D17) gates rewritten now as a wave-1 ledger row (C13-N46): GATE-D deps -> C13-N22/N23/N24/N27; GATE-C names the rung cost table; EXIT enumerates gate bars vs calibration bars per renderer.

Basis: `CAMPAIGN_13_V2_DECISIONS_2026-09-12.md` D17 (re-write Gates C/D and EXIT against the v2 bars), derived from C13 plan §3 WS-H `C13-N46`, §5.3 Wave 1 lane β, and §9 L8.

Executed: Batch NNNN (2026-09-12).

Authority: charter §1.1.

## R-2026-09-12-4 — Edge-leg ordering: the named leg runs before the landing for every [E] row (D16)

R-4 (D16) Edge-leg ordering: the named Edge leg runs BEFORE the landing for every [E] row (R-2026-08-29-1 read literally); tranche first, land after.

Basis: `CAMPAIGN_13_V2_DECISIONS_2026-09-12.md` D16 (Edge-leg ordering vs landing), derived from C13 plan §5.2, §5.3, §5.5, and §9.

Executed: Batch NNNN (2026-09-12).

Authority: charter §1.1.

## R-2026-09-12-5 — Default weather source: GFS primary + GMGSI referee + ECMWF second; four GRIB2 template checks as a Wave-1 seal task (D6)

R-5 (D6) default weather source: GFS primary + GMGSI imagery referee + ECMWF as a second provider behind the same interface; the four remaining GRIB2 template checks (MCDC/HCDC/PRES/TMP) are a wave-1 launch-seal task before sizing C13-N24.

Basis: `CAMPAIGN_13_V2_DECISIONS_2026-09-12.md` D6 (default data source), derived from C13 plan §3 `C13-N24`, §4.1, §5.3, and §9.

Executed: Batch NNNN (2026-09-12).

Authority: charter §1.1.

## R-2026-09-12-6 — Ground-truth imagery: fetch at probe time, derive, pin a fixture set (D10)

R-6 (D10) ground-truth imagery: fetch at probe time, bank derived metrics only, small pinned fixture set for offline reproducibility; WMO Atlas photos and flight-sim screenshots excluded; ESDIS/NOAA acknowledgements in the manifest.

Basis: `CAMPAIGN_13_V2_DECISIONS_2026-09-12.md` D10 (ground-truth evidence licensing), derived from C13 plan §3 `C13-N05`, §4.1, §4.2, and §9.

Executed: Batch NNNN (2026-09-12).

Authority: charter §1.1.

## R-2026-09-12-7 — The single Edge slot: C13-41's discriminator first; cloud work pure-Node until it returns; then L6 -> L3 -> L4 -> L5 -> L7 (D9)

R-7 (D9) the single Edge slot: the C13-41 exposure-sweep discriminator (R-2026-09-02-5) runs FIRST after the P0-2 gate; cloud work stays pure-Node until it returns; then the cloud Edge queue L6 -> L3 -> L4 -> L5 -> L7.

Basis: `CAMPAIGN_13_V2_DECISIONS_2026-09-12.md` D9 (cloud quality vs `C13-41` for the single Edge slot), derived from C13 plan §5.2, §5.3, §5.5, §6, and §9.

Executed: Batch NNNN (2026-09-12).

Authority: charter §1.1.

## R-2026-09-12-8 — WebGL parity: FULL, including the GLSL march twin and a GLSL god-ray stack; AR-D13 answered (D3)

R-8 (D3) WebGL parity: FULL parity including the GLSL march twin of ProceduralClouds.wgsl and a GLSL god-ray stack (answers AR-D13 as full parity) - the plan's WS-C shell-only floor is superseded by a full WebGL workstream; the shell stays as the cheap rung on both backends.

Basis: `CAMPAIGN_13_V2_DECISIONS_2026-09-12.md` D3 (scope of the WebGL parity floor / open decision `AR-D13`), derived from C13 plan §0.16–§0.19, §1.4, §2, §3 WS-C / WS-C2, §5.3 Wave 7, §5.4, §6, §8 risk 17, and §9.

Executed: plan ratified; execution begins Wave 4 (`C13-N15a`–`d`) and Wave 7 (WS-C2).

Authority: charter §1.1.

## R-2026-09-12-9 — Globe.js cloud default: keep HELD; revisit at Wave 4 (D2)

R-9 (D2) Globe.js cloud default: keep HELD (R-2026-09-10-6); REVISIT at wave 4 with default ON at the shell rung on both backends, the march off until C13-44 + a measured frame cost.

Basis: `CAMPAIGN_13_V2_DECISIONS_2026-09-12.md` D2 (the M2 `Globe.js` default, held under `R-2026-09-10-6`), derived from C13 plan §5.3 Wave 4, and §5.5.

Executed: Batch NNNN (2026-09-12).

Authority: charter §1.1.

## R-2026-09-12-10 — Archive-hold scope: dated in-place corrections permitted; C13-N33 may proceed in Wave 2 (D13)

R-10 (D13) archive hold scope: in-place corrections of factually false sentences are permitted (dated), no file moved or repointed; C13-N33 may proceed in wave 2.

Basis: `CAMPAIGN_13_V2_DECISIONS_2026-09-12.md` D13 (scope of the archive hold for `C13-N33` doc re-stamping), derived from C13 plan §3 `C13-N33`, §5.3 Wave 2, §5.5, and §6.

Executed: Batch NNNN (2026-09-12).

Authority: charter §1.1.

## R-2026-09-12-11 — Adaptive quality controller C13-N42: BUILD, default off, Wave 3 (D18)

R-11 (D18) adaptive quality controller C13-N42: BUILD, default off, wave 3; acceptance = a synthetic 2x cost inflation causes exactly one rung drop and no oscillation over 600 frames.

Basis: `CAMPAIGN_13_V2_DECISIONS_2026-09-12.md` D18 (adaptive quality controller), derived from C13 plan §2.5, §3 WS-B `C13-N42`, and §5.3 Wave 3.

Executed: Batch NNNN (2026-09-12).

Authority: charter §1.1.

## R-2026-09-12-12 — Peer head-to-head instrument C13-N40: FUND, Wave 2 (D20)

R-12 (D20) peer head-to-head instrument C13-N40: FUND (wave 2, L); "above Takram" becomes a per-statistic dated claim; T1 (forward-run ghosting) is the head-to-head bar.

Basis: `CAMPAIGN_13_V2_DECISIONS_2026-09-12.md` D20 (peer head-to-head instrument), derived from C13 plan §3 WS-H `C13-N40`, §4.4, §5.3 Wave 2, §5.4, and §8 risk 16.

Executed: Batch NNNN (2026-09-12).

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
