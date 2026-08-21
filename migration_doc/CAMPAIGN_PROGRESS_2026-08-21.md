# Campaign progress — 2026-08-21 (audited at tip `233086ffc5`, Batch 1107)

Six parallel read-only audits (Opus 5, one per campaign) computed completion
against each queue's OWN ledger and re-verified every counted row against git
history and code, because queue docs drift. This document is the synthesis and
the working focus list; the per-campaign queue documents remain the sole status
authorities for individual rows. Corrections the audits ordered are being
applied to the queue docs in the same landing window that tracks this file.

## Portfolio at a glance

| Campaign | Weighted complete | By row count | Open rows | Closure bottleneck |
| --- | --- | --- | --- | --- |
| C11 parity | ~9% | 13.4% (27/201) | 174 | The W2-W8 body; exit gate C11-137 correctly HELD |
| C12 celestial | 63% | 72% (31/43) | 12 | Maintainer sessions + machine lane ONLY - nothing worker-shaped |
| C13 clouds | 36-43% | 29% (13/45) | ~30 | Orchestrator-owned; SOL-4 -> C13-41 chain |
| C14 ocean | not launched | - | - | C12 completion (R1; Gate B closed B866) |
| C15 gsplat | 60% rows | 6/10 | G6/G7/G9 -> G8 | Lane dormant 191 batches; G9 escalation overdue |
| C15 aurora | held | C15-00 only | 8+2 | R4 hold until C12 closes |
| C16 comments | ~67% of guard debt | 12/22 rows | 9 packages | Pure worker material; grandfather-file gate ruling owed |
| C18 voxel/pc/splat | 17% (28% w/ lane F) | 2/22 | waves P/A/S | Lane F landing; wave A blocked on C11-100 |

## The critical path to C14

One chain, verified end to end:
**SOL-4 banked refresh cost -> C13-41 budget predicate -> C12-29 S3 -> C12
complete -> C14 launches.** Everything on it is machine-lane or
maintainer-owned. The C12 minimal closure set (audit, ordered): the G3
4096-bake + HDR manual session; the G1 shell-extent ruling (or an explicit
accept-red-at-close); the S5 seven-lane certification matrix; the C12-33
design ruling then its ten-run Edge set; the C12-31 sweep; the small
acceptance batch (C12-12 identity, C12-14, C12-32, C12-36, G1F2); the
maintainer in/out calls (C11-79, C12-26, C12-31-FOLLOWUP-A/B/C, C12-11).

## Worker dispatch waves (Codex Sol, isolated clones, Opus initial review)

Wave 1 (dispatched 2026-08-21): C16-P2 Primitive WGSL family (415 markers /
58 near-identical files - the recipe prover); C16-P1 splat+voxel
(452 markers / 4 files, densest in the tree); C11-P3 premise-reconcile pack
(seven stale-premise rows -> per-row disposition memos, zero engine edits);
C12 doc bundle (ledger truth to B1107 + EXIT-3 inventory migration + S5
evidence index - no verdict may be granted by any edit).

Wave 2 (next): C16-P3 primitives/classification (the
WebGPUTranslucentTileClassification scaffolding hazard is written into the
brief); C16-P6 sky/atmosphere/shadow; C11-P1 cheap-parity standing reds;
C15-SOL-A G7+G6 instrument pair (wakes the dormant gsplat lane).

Wave 3: C11-P2 build/boot hygiene; C11-P4 allocation micro-slices; C15-SOL-B
G9 discriminator harness; C18-SOL-A P3 model-path styling stage (after lane F
lands); C16-P5 / P7-compute / P8; C16-P9 string-literal lane
(R-2026-08-21-4). Doc singles: aurora + ocean reference licence vetting
(hold-legal, the C18-S0 shape); C15 dormancy stamp + G9 escalation packet;
C11/C18 queue-truth passes.

## Machine lane (orchestrator, serialized Edge), in order

1. Land the verified lanes (H, J) and the day's corrections at 19:00 ET.
2. Rebuild; SOL-4 eclipse refresh-cost banking (doubles as that probe's
   post-doctrine baseline).
3. Weather-probe baseline sweep - 8 consumers owe fresh baselines
   (R-2026-08-21-3).
4. C12-29 S5 seven-lane certification matrix.
5. C12 acceptance batch (C12-14 / C12-32 / C12-36 / C12-12 identity / G1F2 /
   C12-31 sweep).
6. C18-V2 per-scene non-vacuity mutations, then V3 fleet re-run.
7. C13-10 legs, fog-arm acceptance, C11 W2 pick fleet - interleave as slots
   free.

## Maintainer asks (consolidated)

1. G3 4096-bake + HDR manual session (R-2026-08-10-4 / R-7) - discharges
   C12-12's tier and C12-28.
2. G1 shell-extent ruling (CLT-D10) or accept-red-at-close.
3. C12-33 moon-mip design ruling (shipped four-cell sign test vs the ruled
   sixteen-cell ratio design; custody hash binds the shipped form).
4. In/out-of-gate calls: C11-79; C12-26 airglow; C12-31-FOLLOWUP-A/B/C;
   C12-11 (clear the ten blockers or rule the run out of the exit gate).
5. C15-G9 tower-frame-variance escalation - the R-2026-08-10-7 thirty-batch
   structural clock is exceeded roughly sixfold.
6. C16-20 grandfather clause: census=0 can currently read green over 196
   parked findings; the gate needs an empty-grandfather clause or an
   accepted-residue ruling.
7. C16-02c build-ts lane in/out call.

## New rows the audits ordered (minted with tonight's landings)

- C13: U2 control-band materiality (DERIVED and implemented 2026-08-21:
  absolute floor 0.21 ms from same-bundle cross-round noise; spec-pinned) -
  the row records the derivation and closes.
- C13: U2 register-pressure containment - the measured +5-10% full-res march
  / ~+5% shadow map / ~+13-19% cascade atlas regression is C13-39B's first
  live trigger; U2's no-regression acceptance is RED until it lands.
- C13: SOL-4 gets its own C13 row id; weather-probe fresh-baseline sweep row;
  weather census instrument-shape scope row.
- C16-R1 scope addition (worker find, 2026-08-21): WebGPUVoxelCustomShaderCodegen.ts:171
  emits a raw tracker marker inside a runtime-generated string - the guard does not
  scan string/template literals; this joins the P9 emitter class
  (MetadataWGSLPipelineStage.js:546/548/962).
- C18: lane F landing must NOT claim C18-P4 (no model-path EDL producer
  exists); C18-A1's acceptance recipe must be rewritten post-lane-F;
  C18-P5's gate gains the ThirdParty-WASM provisioning precondition.

## Stale-claim repairs the audits ordered (queue edits in flight)

C11: C11-01 and C11-171 are closed with git evidence but recorded NOT
STARTED; ~8 rows cite discharged blockers (C11-149 landed B739; Campaign 10
closed B711; C11-GT-01 NO-GO B717); C11-132/134 are CODE-LANDED not
COMPLETE; the S3.2 dual-ledger hazard needs its carve-outs. C12: SS0 is 25
batches stale; G4 is CLOSED (B984) despite newer-dated void-run prose;
C12-36's premise cites code that no longer exists; three rows still read
"acceptance OWED" against SS0's own discharge records. C13: C13-41 cell now
leads with REOPENED; Gate A re-marked deps-satisfied/declaration-owed; the
U2 evidence block restamped to its true date. C15: SS6 stamped dormant-since-
B916; C15-G8's headline gate carries the ADDENDUM's reachable form. C16: the
C16-R1 row must record BOTH rulings (2026-08-14 option (a) superseded by
R-2026-08-21-4 option (b) widened); C16-11 is PARTIAL not PENDING; the
shard-sizing table is stale in every column; CAMPAIGN_STATE's 6,450 baseline
needs a progress annotation. C18: SS8's execution order is superseded by the
portfolio queue's recovery-first order; C18-P1's symptom description is
post-B1013 stale.

## Sources

The six audit reports are session artifacts (2026-08-21); their load-bearing
claims were spot-verified at integration. Completion methods: each audit
states its own weighting; the numbers above are not comparable ACROSS
campaigns (different weight scales) - they are comparable against each
campaign's own next audit.
