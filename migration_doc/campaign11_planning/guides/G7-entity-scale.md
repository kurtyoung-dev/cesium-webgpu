# G7 — Entity-at-Scale Arc (S10) + Collections Frontend + Celestial Retained Resources — Campaign-11 Cluster Guide

**Clusters:** `entity-scale` (register §9, 12 items) + `celestial-env` (register §11, 2 items).
**Anchors verified against committed HEAD `5b98ab9698` (Batch 699, `main`) on 2026-07-18.** Every file
cited in an "Architecture today" block below was checked clean in `git status` (working tree == HEAD for
all cluster-relevant paths), so working-tree reads were HEAD reads at verification time. C10 workers are
landing concurrently — **re-grep every anchor by SYMBOL before editing**; line numbers are freshly
grepped hints, not gospel. Drift from the source register is called out per item.

**Primary sources:** `migration_doc/PERF_ARCH_DEEP_DIVE_2026-07-16.md` §11 (S10-1..S10-9), §2 (S1-4),
§3 (S2-1), §14 seed 3; `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` §3.2 rows L136/L137/L145 + §9
items 62/76/77; `migration_doc/QUEUE_2026-07-16_CAMPAIGN10.md` §4 (W1 cheap-rider table) + §6
(next-campaign seeds); `migration_doc/DEFERRED_WORK.md` ~356-357 (NEW-ENTITYCLUSTER-GPU /
-GPU-MERGE) + ~5116 (PARITY-POINT-SPRITE-SHAPE-RESIDUALS).

**Charter rules that bind every item here (never weakened):** no feature degradation or
default-disablement for a metric win; rule-3 conservatism; probe-first (CLAUDE.md Principle 8);
premise-verify-first (several register quantities are deep-dive estimates, flagged below); one concern
per slice; perf evidence = moving-altitude campaign discipline only (idle-soak invalid) — extended
here with a NEW deterministic entity lane built to the same clean/API-lane standard.

---

## Cluster charter + sequencing (reads first)

### The arc in one paragraph — "Entity-at-scale arc (S10 umbrella, register §14 seed 3)"

The fork's bulk-static Entity work (BulkPoint/Billboard/LabelVisualizer, default-wired) is genuinely
good — 10 k *parked* markers are settled O(changed). What breaks at 10 k, structurally and on BOTH
backends, is everything dynamic-adjacent: the legacy visualizer lane is O(N × 10–35 megamorphic
Property reads)/frame with no dirty-tracking (S10-1); enabling clustering — the feature users reach
for at exactly this scale — **forfeits the entire bulk lane by construction** (S10-3) and one moving
entity forces a full declutter rebuild every frame (S10-2); geometry loading pays ~11 updaters + ~13
Events per entity regardless of need (S10-4); and the WebGPU collections frontend leaks per-frame
O(N) scans (S10-5), pick repacks (S10-6), and resolver-closure churn (S2-1) that the resident-instance
architecture was built to avoid. The deep-dive is explicit that these costs are **upstream of the
renderer** and will cap the ≥2× goal on entity scenes even after the full C9 backlog lands
(PERF_ARCH_DEEP_DIVE §11 context block + top-10 row 8). C10 deliberately did not open this arc
(C10 queue §6 lists "entity-at-scale arc (S10)" as a next-campaign seed) — C11 is where it opens.

The umbrella row itself ("Entity-at-scale arc (S10 umbrella)", P1/XL) is **not a schedulable slice**
— it is the arc. Its concrete content is exactly the S10-* dossiers below. Do not mint a task for
the umbrella; schedule the members.

### Mandatory sequencing (cluster-internal dependency spine)

1. **"10k-entity benchmark lane (§14 seed 3 prerequisite)" FIRST, as its own slice.** Every S10
   finding is invisible to the current gate — verified at HEAD: the campaign workload set
   (`Tools/visual-regression/performance-workloads.json`, id `fork-remediation-phase0-v1`, 12
   workloads) contains **zero Entity/DataSource workloads** (the 4096-point mutation scenes drive a
   `PointPrimitiveCollection` directly, below the DataSource layer). No S10 slice may claim a perf
   result before this lane exists and has recorded PRE baselines.
2. S10-5 and S2-1 (cheap, WebGPU-frontend, independent) can run in parallel with the lane build but
   must re-run their oracles on the lane once it lands.
3. S10-1 before S10-2/S10-3 payoff claims (a decoupled cluster catalog still lands in the legacy lane
   for its *dynamic* members — S10-1's third lane is what makes S10-3's decoupling pay).
4. S10-3 is the prerequisite for S10-2's fix to matter at scale (deep-dive S10-3 owner note).
5. S10-6 scopes under the pick cluster's FAR-107 contract — allocation mechanics only here
   (cross-cluster constraint, see OPEN QUESTIONS).
6. FAR-307 before-or-with S10-8 (both touch `PolylineCollection`/`WebGPUPolylineRenderer`; one
   concern per slice demands explicit ordering).
7. The two celestial items are independent of the entity spine and of each other in code, but
   NEW-WEBGPU-STARFIELD-SINGLE-SUBMISSION's instrumentation slice should land before
   NEW-WEBGPU-CELESTIAL-RETAINED-RESOURCES retains StarField command objects (retention changes the
   identity semantics the instrumentation must observe — instrument the churn world first).

### Landed-work interaction map (Batches 683–699 — check before every slice)

| Landed | What it changed | Interaction with this cluster |
|---|---|---|
| B693 `C10-01` 1-frustum default | Default 3D WebGPU = 1 frustum (WebGL parity); env commands excluded from near/far widening; sky-only fallback keys on seeing a BV-less ENVIRONMENT command in `commandList` | All deep-dive per-frame collection numbers that assumed 2 frusta (duplicate camera-UB writes per slice, S2-1's repack multiplier) are STALE — re-measure on the lane. Celestial: the binned env push is **load-bearing for the sky-only fallback** — never delete the push. |
| B694 `C10-09` prev-buffer revision-skip | House revision-token pattern (`instanceDataRevision`/`prevBufferRevision`, bump at content-write, reset on realloc, seed via GPU self-copy) in PointCloud/Splat/Cloud renderers | The pattern S10-5/S10-6/S2-1 caches must mirror. Billboard/Label/Point collection renderers were NOT touched by B694 — do not assume the tokens exist there; add them, same naming discipline. `probe-taa-jitter` must stay green after any collection-frontend change. |
| B687/B688 C9-17 Slices A+B | Settled model group-1 bind-group caching + loader-owned geometry revision tokens (240/240 settled fast-path) | Precedent + oracle style for "settled ⇒ 0 creates/frame" claims. S10-9 is *upstream* of C9-17 (visualizer, not renderer) — complements, no overlap; verify C9-17 Slice D STOP-gate state at intake before touching model command paths. |
| B695 `C10-10` shadow single-sweep | Caster collection folded into the single PVS walk | Entity lane workloads should keep shadows at Viewer defaults; if a shadows-on entity variant is added later, the caster sweep is O(commands) — attribution must not blame S10 slices for it. |
| B697 `C10-03` demand resolve | Scene-color MSAA resolves 9→1/frame, demand-driven | Do not cite eager-resolve bandwidth in entity-lane attribution; it is already elided. |
| B699 `C10-02` translucent-twin gate | Phantom model translucent twin gated on `styleCommandsNeeded` | No collision (entity geometry batches build `Primitive`, not batch-table Models). |
| B667/B684 C9-06 celestial extinction cache + StarField warm-keep | Exact-scalar extinction cache; `fr.prepare` warm-keep on both backends; StarFieldSpec 7/7 Karma green | Both celestial items build ON this. Retained-resource work must keep `prepareWebGPUStarField` building resources with **no per-frame pack or draw**, keep `probe-celestial-extinction-cache` green (starUpdateDelta 1, pipelineReady true), and keep StarFieldSpec green. |

### Verification substrate (existing probes, verified present in `Tools/visual-regression/` at HEAD)

Entity/collections: `probe-entity-bulk.mjs`, `probe-entity-bulk-billboard-label.mjs`,
`probe-bulk-vs-legacy-perf.mjs`, `probe-sandcastle-bulk-legacy.mjs`, `probe-collections-entity.mjs`,
`probe-collections-regression.mjs`, `probe-entitycluster-gpu.mjs` (parity band 0.75–1.25),
`probe-point-label-partial-write.mjs`, `probe-billboard-partial-write.mjs`,
`probe-collections-2dcv-morph` (referenced by DW B301 gate list), `track-entity-probe.mjs`,
`probe-point-sprite-shape.mjs`, polyline fleet (`probe-polyline-multimaterial.mjs`,
`probe-polyline-image-material.mjs`, `probe-polyline-appearance-*.mjs`).
Celestial: `probe-celestial-extinction-cache.mjs`, `probe-celestial-extinction-revision-gate.mjs`,
`probe-sun-stars-extinction.mjs`, `probe-env-skybox-stars.mjs`, `probe-skybox-stars-sun.mjs`,
`probe-skybox-stars-sun-facing.mjs`, `probe-starfield-webgl-parity.mjs`, `probe-stars-catalog.mjs`,
`probe-stars-hdr-autoexposure-parity.mjs`, `probe-stars-hdr-verify.mjs`, `diag-stars-hdr-autoexposure.mjs`,
`probe-moon-atmosphere.mjs`, `probe-moon-sunlit.mjs`, `probe-env-moon.mjs`, `probe-sun-pixel-check.mjs`,
`probe-sun-glowfactor.mjs`, `probe-frustum-count-3d.mjs`, `probe-atmo-moon-438.mjs`.

---

## ITEM 1 — "10k-entity benchmark lane (§14 seed 3 prerequisite)" (P1 · tooling · S–M)

### What + why (evidence trail)

PERF_ARCH_DEEP_DIVE §14 seed 3 is explicit: *"A coherent multi-batch arc with its own 10 k-entity
benchmark lane (current campaign scenes have no entities — build the lane first)."* The register
carries it as its own P1 row. Without it, every S10 claim (3–15 ms dynamic floor, 200–500 ms TTFF
stall, 1.76 MB/pick repack) is an estimate; with it, each S10 slice gets the same on/off/restored
p95 evidence discipline C9-30/C10-30 established. This is the S10 arc's Gate-A equivalent.

### Architecture today (verified at HEAD `5b98ab9698`)

- `Tools/visual-regression/performance-workloads.json` — schema-versioned
  (`performance-workloads.schema.json`, `schemaVersion: 1`), workload-set id
  `fork-remediation-phase0-v1`, protocol block (Edge, 1280×720, fixed clock `2026-06-21T08:00:00Z`,
  120 warmup / 600 measured frames, settle contract). Twelve workloads:
  `settled-static-3d`, `moving-camera-3d`, `moving-camera-altitude-track-3d` (authoritative),
  `moving-pick-camera-altitude-track-3d`, `sparse-mutation-3d`, `full-mutation-3d`,
  `pick-center-3d`, `resize-cycle-3d`, `settled-static-2d`, `moving-camera-columbus`,
  `morph-roundtrip`, `destroy-recreate-content`. **None create an `Entity` or a DataSource** — the
  mutation scenes drive a raw 4096-point `PointPrimitiveCollection`.
- `Tools/visual-regression/run-performance-campaign.mjs` — the runner: file-identity stamping,
  clean vs API-instrumented lanes, deterministic environment normalization (imagery removed,
  ellipsoid terrain, fog/skyBox/sun/moon off — verified at ~:1538-1580), per-workload
  settle/warmup/measure protocol.
- `Tools/visual-regression/performance-workloads.spec.mjs` — schema conformance spec for the
  workload file.
- Existing entity perf probes (`probe-bulk-vs-legacy-perf.mjs`, `probe-entity-bulk.mjs`) exist but
  are correctness/ratio probes, not campaign-protocol lanes — they do not produce
  checkpoint-comparable p50/p95 artifacts.

### Target design + invariants

Add four deterministic entity workloads (deep-dive seed-3 wording): **static** (10 k constant
billboard+point+label entities — must exercise the bulk lane), **clustered** (same set,
`cluster.enabled = true` — today this is the S10-3 forfeiture path; the lane must capture the PRE
cost honestly), **dynamic-mover** (10 k static + a deterministic K-mover cohort, K ∈ {1, 100} —
`SampledPositionProperty` driven off the fixed clock, exercising S10-1 and the S10-2 every-frame
declutter), **path-tracking** (N tracked entities with `path` graphics over the fixed clock window —
exercising S10-8). Plus one load-time lane: a deterministic CZML/GeoJSON-style bulk add measuring
TTFF stall (S10-4's 200–500 ms claim).

Invariants:
1. **Workload-set identity is sacred.** The C9-30/C10-30 comparison artifacts are keyed to
   `fork-remediation-phase0-v1`. Do NOT mutate that file's id or its 12 existing workloads. Either
   append with a bumped set id or (preferred, see OPEN QUESTIONS) create a sibling
   `performance-workloads-entity.json` consumed by the same runner via a `--workloads` arg — the
   runner and spec must both accept it.
2. Determinism: fixed clock drives all movers; no `Math.random` without a seeded PRNG; entity
   counts and positions byte-stable across runs.
3. Both backends, clean + API lanes, same file-identity stamping as the existing runner.
4. The lane itself must be allocation-honest: the harness must not allocate per-frame in a way that
   pollutes GC attribution (pre-build entity arrays, reuse JulianDate scratch).
5. Record PRE baselines for all lanes on the unmodified engine and commit the JSON artifacts —
   these are the arc's reference anchors.

### Implementation walkthrough

1. Premise-verify the runner's extension seam: confirm `run-performance-campaign.mjs` reads the
   workload file path from a flag or constant; add `--workloads <file>` if absent (keep default
   byte-identical).
2. Author `performance-workloads-entity.json` (own set id, e.g. `fork-entity-scale-v1`) + extend
   `performance-workloads.spec.mjs` coverage to it. Entity construction goes through the real
   `viewer.entities` / a `CustomDataSource` — the whole point is the DataSource layer, so do NOT
   shortcut to collections.
3. Environment normalization: reuse the existing normalization block; entities need no imagery.
   Keep clustering OFF except in the clustered lane.
4. Add per-lane sanity counters to the API lane: entities count, bulk-lane resident count vs legacy
   count (the Bulk* visualizers expose classification — assert the static lane actually rides the
   bulk path, else the lane measures the wrong thing), declutter runs/frame in the clustered lane.
5. Run 5 reps both backends; record p50/p95 + artifact JSONs; commit under the campaign artifact
   convention.

### Traps

- **The static lane silently falling off the bulk path** (e.g. a default heightReference or a
  non-constant property in the test data) would make PRE numbers measure the legacy lane and
  invalidate every later delta. Assert bulk residency explicitly (step 4).
- Fixed clock + `SampledPositionProperty`: samples must span the clock window or availability
  checks will hide movers.
- Idle-soak rule: entity lanes are *moving/mutating* by construction — never add a "static idle FPS"
  lane under request-render mode (charter).
- 32 GB machine + 10 k×3 graphics types: keep per-lane totals bounded (10 k entities, not 10 k per
  type stacked to 30 k+labels) — labels multiply glyph collections (S10-5 N = summed text length).
- Background Edge probes carry the known machine-crash risk (memory feedback_review_scripts):
  pre-scan the lane script for unbounded loops before first run.

### Verification recipe

- New lane names (proposed): `entity-static-10k`, `entity-clustered-10k`,
  `entity-dynamic-movers-10k`, `entity-path-tracking`, plus `entity-load-ttff` (load-time probe,
  may live as `probe-entity-load-ttff.mjs` outside the frame-loop campaign).
- Oracle for THIS slice: lanes run to completion on both backends, 0 device/page errors, p95
  variance across 5 reps within the noise budget the C10-30 methodology uses; bulk-residency
  assertion passes in `entity-static-10k`; PRE artifacts committed.
- No banner claim — this is tooling; promotion rule does not apply beyond "lane exists and is
  deterministic".

### Model tier + effort

**opus-or-sol, S–M.** Well-specified tooling on an existing harness; the only judgment call
(workload-file identity) is pre-decided above / escalated in OPEN QUESTIONS.

---

## ITEM 2 — "S10-1 — dynamic-entity fallback lane (supersedes S1-4)" (P1 · perf · L)

### What + why (evidence trail)

PERF_ARCH_DEEP_DIVE S10-1 (+S1-4, which it supersedes — S1-4 independently surfaced the same
territory at 5 k billboards ≈ 75 K+ property evaluations/frame): the bulk static lanes require EVERY
consumed property constant *including position* and `heightReference === NONE`; the canonical
10 k-mover and clamped-marker workloads fail categorically and land in the legacy visualizers, which
re-read the full property tree (isShowing walk + isAvailable interval search + 10–17
`getValueOrDefault` + setter equality checks) per entity per frame, main thread, both backends —
~3–15 ms/frame CPU floor at 10 k dynamic. Aggravator: terrain-clamped markers can never be bulk even
when fully constant.

### Architecture today (verified at HEAD `5b98ab9698`)

- `packages/engine/Source/DataSources/BulkPointVisualizer.js` — `isStaticPointEntity` at :45
  (heightReference gate at :59-66 — non-NONE or non-constant disqualifies); `_classify` at :415
  with the `clusteringEnabled` gate at :422-424 (register said :420-424 — 5-line drift, symbol
  exact). Siblings verified: `BulkBillboardVisualizer.js` `_classify` :479/:486,
  `BulkLabelVisualizer.js` `_classify` :469/:478.
- Legacy lane property storm: `PointVisualizer.js` (per-frame `getValueOrDefault` chain; sets
  `cluster._clusterDirty = true` at :119 for dynamic entities), `BillboardVisualizer.js` (:128),
  `LabelVisualizer.js` (:132). Register cited 14 getValue-family sites in BillboardVisualizer —
  not re-counted; pattern confirmed.
- The bulk write-once options path in `BulkPointVisualizer.js` (:95-155 `getValueOrDefault` chain)
  is the *one-time* evaluation the static lane already does — the third lane reuses this shape.

### Target design + invariants

Deep-dive fix shape, four parts (each independently committable — one concern per slice; this item
is a mini-arc of 2–4 slices, not one mega-slice):
(a) **third lane "static-except-position"**: constant style attributes written once via the bulk
path; only position + availability-show streamed per frame; (b) **definitionChanged-driven
per-property memoization** in the legacy lane; (c) **SampledPositionProperty segment-cursor cache**
(avoid per-frame binary search — monotone clock advance = O(1) amortized); (d) **clamped-static
sub-lane** (constant properties + heightReference clamp: subscribe to terrain-height updates
instead of re-polling).

Invariants:
1. Pixel parity: bulk vs legacy vs third-lane rendering byte-equivalent for the same entity set
   (probe-entity-bulk already asserts bulk/legacy parity — extend to the third lane).
2. Property semantics preserved EXACTLY — see Trap 1 (CallbackProperty).
3. Classification transitions (static ⇄ dynamic ⇄ static-except-position) must be lossless: a
   property edit mid-session re-classifies without dropped/duplicated primitives
   (`_classify`-on-changed already exists at :458-462 — reuse, don't fork).
4. Backend-agnostic: this is DataSources-layer work; zero `isWebGPU` branches (charter Principle 2).

### Implementation walkthrough

1. **Premise-verify on the lane** (Item 1 must be landed): record `entity-dynamic-movers-10k` PRE
   p95 both backends + a CPU profile confirming the property-read storm is the top cost. If the
   profile shows something else dominating (e.g. S10-2's declutter, if clustering on), fix
   attribution first.
2. Slice (a): add `isStaticExceptPositionEntity` classification to the three Bulk* visualizers
   (`_classify` at BulkPoint :415 / BulkBillboard :479 / BulkLabel :469): all style properties
   constant, position non-constant OR availability time-windowed, heightReference NONE. Resident
   instances get style packed once; a per-frame tight loop streams position (+show) via the
   existing partial-write manager (`WebGPUResidentInstanceBuffer.sync` partial-write path — the
   architecture the deep-dive's clean-check praises; on WebGL the equivalent is the bulk lane's
   attribute sub-range update).
3. Slice (b): in the legacy visualizers, cache last-known values per entity keyed by a
   `definitionChanged`-bumped revision; skip the getValue chain when revision unchanged AND the
   property tree contains no time-varying members (see Trap 1 — this requires a per-entity
   "time-sensitive" bit computed at classification).
4. Slice (c): add a cursor to `SampledPositionProperty` (or a wrapper cache in the visualizer)
   remembering the last sample interval index; on monotone time advance, verify-and-advance
   instead of binary-search. Pure additive, upstream-file touch — keep it small and comment-dense.
5. Slice (d): clamped-static sub-lane — static styles + clamp: register with the terrain height
   update service (`updateHeight` callback web, S1-3 territory) once, re-evaluate only on height
   callback. Coordinate with the frame-delta cluster's S1-3 item if both are scheduled (OPEN
   QUESTIONS).

### Traps

1. **CallbackProperty and time-varying properties do NOT raise `definitionChanged` per tick** —
   `isConstant === false` with no event. Memoizing on definitionChanged alone FREEZES
   CallbackProperty-driven entities (silent feature break — charter violation). The memoization
   gate must be: `Property.isConstant(p) === true` → memoize on definitionChanged; else always
   re-read. This is the single most dangerous edge in the whole arc.
2. Availability (`isAvailable`) is time-dependent even when everything else is constant — the
   third lane must keep the per-frame availability check (it is cheap: one interval lookup, and
   slice (c)'s cursor idea applies to `TimeIntervalCollection` too).
3. `heightReference` disqualification (BulkPointVisualizer :59-66): slice (a) keeps NONE-only;
   slice (d) relaxes it. Do not merge the two (one concern per slice).
4. Cluster interplay: dynamic entities set `cluster._clusterDirty = true` per frame
   (PointVisualizer :119). The third lane must preserve that exact signal for its streamed movers
   until S10-2's displacement gate lands — otherwise clustered scenes silently stop re-decluttering
   (feature break). Sequence: S10-1(a) may land before S10-2, but must replicate the dirty signal.
5. B694 discipline: any new resident-buffer revision fields follow the
   `instanceDataRevision`-style naming + bump-at-content-write + reset-on-realloc contract.
6. C9-25 (rte-taa cluster) will convert Billboard/Point/Label temporal shaders to previous-frame
   high/low camera-relative math — S10-1's streamed-position path must not cache absolute-ECEF
   assumptions in new code paths (keep EncodedCartesian3 splits at the pack site, as
   `buildPickInstanceData` already does).

### Verification recipe

- **Probes:** extend `probe-entity-bulk.mjs` / `probe-entity-bulk-billboard-label.mjs` with a
  third-lane parity case (bulk vs legacy vs static-except-position pixel equality per backend);
  new `probe-entity-dynamic-lane.mjs` (proposed): K movers among 10 k static — asserts (i) mover
  positions update on screen (feature oracle), (ii) API-lane counter "legacy-lane resident count"
  ≈ K not N, (iii) CallbackProperty entity keeps animating (Trap-1 oracle), (iv) a mid-session
  style edit on a third-lane entity re-classifies and renders correctly.
- `probe-point-label-partial-write.mjs` + `probe-billboard-partial-write.mjs` +
  `probe-collections-regression.mjs` + `probe-collections-2dcv-morph` green (resident-buffer
  contract untouched for existing lanes).
- **Perf:** `entity-dynamic-movers-10k` on/off/restored (in-build kill-switch flag per C10-03
  precedent), 5 counterbalanced reps, both backends. Banner only if ≥5% whole-lane CPU-p95 or >3×
  noise; otherwise the named-stage oracle (legacy-lane entity visits/frame N → K) lands the slice
  per the §1 promotion rule (truthful miss + green mechanics = VALID COMPLETE).
- capture-and-diff band: existing scenes untouched — `globe-default` crossBackend must stay in its
  0.43–0.77% band (this work must not touch globe paths at all; a shift = scope leak).

### Model tier + effort

**Split: fable for slice (b)'s memoization-contract design** (the CallbackProperty/time-sensitivity
classification is semantically ambiguous and the failure mode is silent);
**opus-or-sol for slices (a)/(c)/(d)** (well-specified mechanics on verified anchors). Total L
across 2–4 slices.

---

## ITEM 3 — "S10-2 / S10-3 — clustering forfeits the bulk lane + declutter rebuild" (P1 · perf · L)

### What + why (evidence trail)

Two coupled findings (PERF_ARCH_DEEP_DIVE S10-2/S10-3; top-10 row 8; extends
NEW-ENTITYCLUSTER-GPU-MERGE in DEFERRED_WORK ~357):
- **S10-3 (the structural half):** `_classify` routes EVERY entity to the legacy fallback while
  `cluster.enabled === true` because the legacy lane owns the cluster's collections. *The fork's
  headline 50–1400× bulk win and clustering are mutually exclusive by construction.* The
  forfeiture is an ownership artifact, not a data requirement.
- **S10-2 (the per-frame half):** visualizers set `cluster._clusterDirty = true` every frame for
  every non-constant-position entity (no displacement gate); each declutter pass removeAll()s and
  recreates the 3 cluster collections, projects ALL N world→window on CPU with fresh objects,
  builds a fresh KDBush (WebGL) — the Batch-301 GPU grid path replaced only the KDBush term and
  keeps all O(N) CPU work plus a pack/upload/mapAsync readback (one-frame-stale by design,
  B308-verified parity ratio 1.02).

10 k clustered static markers + 1 mover = S10-1 + S10-2 simultaneously — "a guaranteed 30 fps-class
scene on both backends".

### Architecture today (verified at HEAD `5b98ab9698`)

- Forfeiture gate: `BulkPointVisualizer.js:422-424` (`clusteringEnabled = this._cluster.enabled ===
  true;` … `if (hasPoint && !clusteringEnabled && isStaticPointEntity(entity))`), same shape at
  `BulkBillboardVisualizer.js:486-488`, `BulkLabelVisualizer.js:476-478`.
- Per-frame dirty: `PointVisualizer.js:119`, `BillboardVisualizer.js:128`, `LabelVisualizer.js:132`.
- Declutter driver: `EntityCluster.js:243-250` (`if (this._clusterDirty) { … }` + re-arm logic at
  :247), property-setter dirty at :353/:366/:388/:402/:415, camera-changed dirty at :981.
  Register's :528-574/:580-761 declutter internals not line-re-verified (symbol territory
  confirmed via `_clusterDirty` consumers) — **worker: re-read the declutter body before editing.**
- GPU path: `DataSources/EntityClusterGPU.js` (`clusterWithGrid`, B308 rep-to-rep + member-to-seed
  gates), `Renderer/WebGPU/WebGPUEntityClusterDispatcher.ts` (slot 50 FR; grid buffers
  `cellCounts`/`cellRep`/`pointCellId` stay GPU-resident — explicitly named scaffolding for the
  deferred GPU merge; Principle 7 protected).
- PREMISE-UNVERIFIED (line level): "fresh `{index,collection,clustered,coord}` + Cartesian2 per
  point per declutter" — verify by reading the declutter body / heap profile before claiming the
  allocation number.

### Target design + invariants

Deep-dive fix shape, in dependency order:
(a) **S10-3 decoupling (prerequisite):** static entities stay in bulk flat-buffer collections;
their constant positions register with the cluster ONCE; declutter drives only per-item
`clusterShow` bits; an entity leaves the fast lane only while represented by a cluster proxy.
(b) **S10-2 displacement gate:** `_clusterDirty` from movers gated on actual screen-space
displacement threshold (plus the existing camera-changed dirty).
(c) **Incremental declutter:** reuse cluster billboards/labels in place; persistent points array.
(d) **Finish NEW-ENTITYCLUSTER-GPU-MERGE:** GPU union-find/connected-components over the resident
grid buffers so CPU never touches N (the B301/B308 scaffolding's stated destination).

Invariants:
1. **Clustering VISUAL BEHAVIOR is a feature** — merge radii, minimumClusterSize semantics,
  cluster label content, and (for (b)) declutter *cadence* are user-observable. (a)/(c)/(d) must be
  pixel-equivalent at settled state; (b) changes when re-declutter happens and needs an explicit
  bounded-staleness contract + maintainer sign-off on the default threshold (OPEN QUESTIONS —
  charter: no feature degradation; ship (b) opt-in-tunable with a conservative default of 0-change
  = current behavior unless approved).
2. `probe-entitycluster-gpu.mjs` parity band 0.75–1.25 (B308) must hold PRE and POST.
3. Pick: clustered entities pick as cluster objects today; decoupling must not change pick results
  (cluster proxy owns the pickId; bulk-resident members keep theirs when unclustered).
4. The one-frame-stale GPU readback contract stays (B301: declutter already lags camera.changed).

### Implementation walkthrough

1. Premise-verify with the `entity-clustered-10k` lane: PRE p95 + a counter for declutter
   runs/frame and N-projections/run (API lane). Verify the S10-3 forfeiture live: bulk resident
   count == 0 with clustering on.
2. Slice (a): introduce cluster-membership as a per-item bit consumed by the bulk lanes
   (`clusterShow` mask in the resident instance flags — the packed-show-flag idea shared with
   S10-6), remove `!clusteringEnabled` from the three `_classify` gates, and teach
   `EntityCluster` to read constant positions from the bulk store instead of owning collections
   for static members. This is the L-sized heart; expect visualizer + EntityCluster + bulk-store
   surface changes. Keep the legacy path for dynamic members (S10-1 owns their cost).
3. Slice (b): screen-space displacement gate where the visualizers currently write
   `_clusterDirty = true` (:119/:128/:132) — compare projected position to the position the
   current declutter consumed; camera-changed dirty (:981) unchanged.
4. Slice (c): incremental declutter — reuse the 3 cluster collections' items in place (no
   removeAll), keyed by stable cluster identity.
5. Slice (d): GPU connected-components per the DW ~357 design (link to densest in-range neighbour
   + pointer-jump compaction; RTE high/low atomic centroid sums). XL-ish on its own — treat as a
   separate later slice, gated on (a)-(c) landing and the lane proving the readback is the
   remaining term.

### Traps

- **(a) without S10-1:** the dynamic movers still drag their cohort through the legacy lane —
  don't promise the full win until S10-1(a) exists.
- `EntityCluster` is shared upstream API surface — KML/GeoJSON/CZML datasources construct it;
  behavior changes leak everywhere. Run the datasource Karma suites, not just probes.
- The GPU dispatcher (slot 50) is FR-pattern code — Scene/DataSources code must keep consulting it
  only via `context.getFeatureRenderer(ENTITY_CLUSTER_GPU)` (no isWebGPU branches).
- B308's greedy claim-on-accept semantics (sub-threshold seed's members stay available) is exact
  CPU parity — incremental declutter (c) must preserve it or the parity band breaks.
- removeAll-elimination (c) interacts with label glyph re-layout — labels cache glyphs per text;
  reuse must invalidate on text change (cluster count changes → label text changes → glyph
  re-layout is REQUIRED there; only position-stable clusters may skip).
- Do not delete the KDBush WebGL path — WebGL2 keeps it (B301 note); (d) is WebGPU-only and the
  CPU path remains the WebGL implementation (parity via probe).

### Verification recipe

- `probe-entitycluster-gpu.mjs` (band 0.75–1.25, both backends, near/far merge counts) — the
  standing gate.
- New `probe-entity-cluster-bulk-coexist.mjs` (proposed): 10 k static clustered + 1 mover —
  asserts (i) bulk resident count == N-static POST (was 0 PRE), (ii) cluster representative count
  parity WebGL/WebGPU within band, (iii) mover re-clusters within the staleness bound, (iv) pick
  on a cluster returns the cluster, pick on an unclustered member returns the entity, (v) 0 errors.
- On/off/restored: kill-switch per slice; `entity-clustered-10k` p95 PRE/POST/RESTORED, 5 reps.
  Banner per promotion rule; the structural oracle for (a) is "bulk-lane residency under
  clustering" (0 → N-static), for (b)/(c) "declutter runs/frame" and "allocations/declutter".
- Karma: DataSources suites touching EntityCluster + visualizers (`gulp test --includeName` per
  the Edge CHROME_BIN memory).

### Model tier + effort

**fable for slice (a) design + the (b) staleness contract** (ownership rearchitecture with
user-visible semantics and an open maintainer decision); **opus-or-sol for (c) and the
instrumentation**; **(d) opus-or-sol later, own slice** (the design is already written in DW ~357).
Total L (a–c) + L (d).

---

## ITEM 4 — "S10-4 — GeometryUpdaterSet lazy instantiation" (P2 · perf · M)

### What + why (evidence trail)

PERF_ARCH_DEEP_DIVE S10-4: GeometryVisualizer + PolylineVisualizer instantiate per-entity updater
sets unconditionally — 10-11 updater objects (Box..Wall) each with its own Event + eventHelper
subscription, drained in an un-timesliced update loop on load. 10 k point-only entities ≈ ~110 K
updater objects + ~120–130 K Events/subscriptions/closures (~50–100 MB retained) + **~200–500 ms
synchronous TTFF stall**; steady-state, an 11-way dispatch per property write multiplies CZML
update storms.

### Architecture today (verified at HEAD `5b98ab9698`)

- `packages/engine/Source/DataSources/GeometryUpdaterSet.js` — per-set `new Event()` (:41) +
  `new EventHelper()` (:42) + per-updater `eventHelper.add(updater.geometryChanged, …)` (:45)
  inside the constructor loop; `removeAll` at :80. Register's :16-27/:36-58/:60-70 spans drifted
  slightly; symbols exact.
- `packages/engine/Source/DataSources/GeometryVisualizer.js` — `_onCollectionChanged` at :509
  (exact match to register); batch concat at :178; updater-set wiring ~:294-316.
- `PolylineVisualizer.js:259` (register) — not line-re-verified; same pattern per source.
- PREMISE-UNVERIFIED (quantities): the ~110 K/~50–100 MB/200–500 ms numbers are estimates — the
  `entity-load-ttff` lane (Item 1) is the confirmation instrument.

### Target design + invariants

Lazy updater instantiation keyed by which graphics slots are actually defined on the entity
(point-only entity → zero geometry updaters), plus a re-check on `definitionChanged` when a
geometry graphics slot appears later; budget/time-slice the added-entity drain.

Invariants: (1) an entity that GAINS `entity.box` (etc.) mid-session must instantiate its updater
and render — the laziness must be provably transparent; (2) `geometryChanged` aggregation semantics
unchanged for entities that do have geometry; (3) time-slicing must not reorder visible-primitive
creation in a way that changes first-render content beyond the slice budget (bounded, documented).

### Implementation walkthrough

1. Premise-verify: profile the `entity-load-ttff` lane; confirm updater construction dominates the
   stall (vs e.g. property materialization).
2. In `GeometryUpdaterSet` (or its call sites), replace the eager loop with: scan
   `GeometryUpdaterSet.registeredUpdaters`-style type list against defined graphics slots; create
   only matches; subscribe ONE `definitionChanged` listener per entity that re-scans for newly
   defined slots (the set already owns a definitionChanged subscription — reuse it, don't add).
3. Time-slice: in `GeometryVisualizer._onCollectionChanged` (:509), drain added entities against a
   per-frame budget (ms-based, matching the existing incremental patterns elsewhere in the fork);
   carry a pending queue.
4. Keep `removeAll` (:80) correct for partially-instantiated sets.

### Traps

- The 11-way dispatch is also the mechanism that catches a graphics slot being ASSIGNED later —
  the single definitionChanged rescan must cover every slot the eager version would have caught
  (write a spec case per slot type; 10-11 cases, cheap).
- Time-slicing interacts with `dataSourceDisplay.ready` semantics — `ready` must not report true
  while the drain queue is non-empty (silent visual-completeness change otherwise).
- Both S10-4 and S10-7 edit `GeometryVisualizer` — sequence them (S10-4 first is cheaper) and
  rebase deliberately; one concern per slice.

### Verification recipe

- Karma: the full GeometryVisualizer/PolylineVisualizer/updater spec families (they are extensive
  upstream) — the primary correctness net.
- New `probe-entity-lazy-updaters.mjs` (proposed): 10 k point-only entities → API-lane counters
  assert updater instances ≈ 0 (POST) vs ~110 K (PRE); then assign `box` graphics to one entity at
  runtime → box renders (laziness-transparency oracle); `ready` gating asserted.
- `entity-load-ttff` lane PRE/POST: TTFF stall delta is the named-stage oracle; banner only if it
  also moves whole-lane p95 per promotion rule.
- capture-and-diff: `geojson`-style scenes if present in the VR scene set; otherwise the probe's
  own PNG pair.

### Model tier + effort

**opus-or-sol, M.** Mechanical once the rescan contract is written; the spec surface is the work.

---

## ITEM 5 — "S10-5 — collection define-scan gating" (P2 · perf · S · WebGPU-only)

### What + why (evidence trail)

PERF_ARCH_DEEP_DIVE S10-5: `computeDefinesForFrame` walks the ENTIRE collection every frame to
derive 6 gate bits; the early-break fires only when ALL six are set, so a common default collection
scans N×6 probes forever; labels scan per-glyph. 10 k billboards + 10 k labels ≈ 80–150 K+
probes/frame ≈ 0.3–1.0 ms on the WebGPU frontend — despite the resident-instance manager already
carrying an exact dirty signal.

### Architecture today (verified at HEAD `5b98ab9698`)

- `WebGPUBillboardRenderer.js` — `computeDefinesForFrame` at :815, early-`break` at :853, per-frame
  call at :999 (all exact vs register).
- `WebGPULabelRenderer.js` — `computeLabelDefinesForFrame` at :331 (register said the :331-416 span
  — confirmed; scans glyph billboards).
- `WebGPUPointPrimitiveRenderer.js` — `computePointDefinesForFrame` at :695 (register said "same
  in WebGPUPointPrimitiveRenderer" without a line; noted here for the worker).
- Dirty signal: the resident-instance manager (`WebGPUResidentInstanceBuffer.ts`, sync/dirty
  machinery at :167-177+) tracks exact per-item dirtiness — the signal to key on.

### Target design + invariants

Cache `currentDefines` per collection; rescan only when `dirtyCount > 0` or on `forceFullRebuild`.
For clear-detection (a bit that must turn OFF when the last item using it changes), keep per-bit
population counts incremented/decremented on item add/remove/change — O(changed), never O(N).

Invariants: (1) defines NEVER stale — a wrong define bit selects a wrong pipeline variant (silent
wrong-render, the BUG-GLOBE-PIPELINE-NAME-AXES class); (2) settled collection ⇒ 0 probes/frame;
(3) device-loss / cache-invalidation resets the memo (defines recomputed from scratch on the new
generation).

### Implementation walkthrough

1. Premise-verify: count probes/frame at 10 k settled via a pragma-wrapped counter (PRE evidence).
2. Per renderer, thread the resident manager's dirty accounting into a `definesRevision`; memoize
   `computeDefinesForFrame` output keyed by (revision, collection generation). Population counts
   per bit maintained at the same write sites that mark items dirty.
3. Follow B694 naming discipline for the revision fields; reset on realloc/full-rebuild.
4. Labels: glyph-level dirtiness rolls up to the label collection's revision (text change = glyph
   set change = revision bump — the label renderer already rebuilds glyphs on text change; hook
   there).

### Traps

- The six bits differ per renderer — enumerate them per file and write one clear-detection spec
  per bit (a bit stuck ON is invisible in most scenes: it selects a fatter shader variant that
  still renders correctly — detect by asserting define VALUE equality scan-vs-memo under mutation,
  not by pixels).
- `forceFullRebuild` and device-loss paths bypass incremental accounting — memo must invalidate on
  both (C-R12's device-loss walk gap is a known standing hazard; do not add another cache the loss
  walk misses — register the memo with whatever invalidation the renderer's cache already uses).
- Do not fold this into S2-1's resolver caching even though both live in the same update paths —
  separate slices, separate reverts.

### Verification recipe

- New `probe-collection-define-memo.mjs` (proposed): builds a collection; drives each define bit
  ON then OFF via API mutations (e.g. add/remove the one item with a feature); asserts
  memo==scan defines every frame (dual-run assertion in the probe, scan kept under a debug flag),
  probes/frame == 0 at settled, and pixels unchanged PRE/POST.
- Existing gates: `probe-collections-regression.mjs`, `probe-point-label-partial-write.mjs`,
  `probe-billboard-partial-write.mjs`, `probe-collections-entity.mjs`, `probe-collections-2dcv-morph`.
- Perf: `entity-static-10k` named-stage counter (probes/frame N×6 → 0); banner per promotion rule
  (unlikely to clear ≥5% alone — land on the structural oracle).

### Model tier + effort

**opus-or-sol, S.** Well-specified; the dirty signal already exists.

---

## ITEM 6 — "S10-6 — pick instance repack + visibility-flip structural rebuild" (P2 · perf · M)

### What + why (evidence trail)

PERF_ARCH_DEEP_DIVE S10-6 (DEEPER on FAR-107/FAR-409 — those cover the pick mini-frame + readback,
not this): `buildPickInstanceData` allocates a fresh `Float32Array(N×44)` and re-packs ALL N
instances (including EncodedCartesian3 splits) on every pick-pass frame per collection — per
mouse-move under hover picking (10 k billboards = 1.76 MB alloc + repack + writeBuffer per pick per
collection). Separately, the resident manager treats ANY visibility flip as structural
(`_needsFullRebuild`) so one show-toggle re-packs/re-uploads all N×176 B — a blinking billboard
re-uploads 1.76 MB at its blink rate.

### Architecture today (verified at HEAD `5b98ab9698`)

- `WebGPUBillboardRenderer.js` — `buildPickInstanceData` at :335, consumed at :1482.
- `WebGPUPointPrimitiveRenderer.js` — `buildPickInstanceData` at :261, consumed at :1400.
- `WebGPUResidentInstanceBuffer.ts` — full-rebuild branch at :167 (`if (this._needsFullRebuild(options))`),
  `_needsFullRebuild` at :177 (register said :195-292 for the class span — method-start drift; the
  show-flip→structural premise lives inside `_needsFullRebuild`'s conditions: **worker must re-read
  the method body** to confirm visibility participates in the structural predicate before claiming
  the second half).

### Target design + invariants

(a) Resident pick mirror: pick instance data becomes a second resident buffer maintained by the
same partial-write manager (or a single resident buffer + a small 4-float pick-ID side buffer) —
no per-pick-frame repack; (b) pack a `show` flag INTO the instance record instead of compacting
slots so show-toggles become 16-byte partial writes (shader skips hidden instances by flag —
degenerate/zero-size emission).

Invariants: (1) pick results byte-identical (same pickId → same object resolution) across 3D/2D/CV;
(2) hidden instances neither render NOR pick; (3) the pick mirror follows the SAME dirty signal as
the color buffer (one source of truth — divergence = picking a stale position); (4) scope =
allocation/upload mechanics only — the pick *contract* (query semantics, readiness, async) belongs
to FAR-107 in the pick cluster; do not pre-empt it.

### Implementation walkthrough

1. Premise-verify BOTH halves: (i) instrument bytes/pick-frame on a 10 k hover scene; (ii) read
   `_needsFullRebuild` and prove a show-flip takes the structural branch (if it doesn't at HEAD,
   the second half is already fixed — drop it and note the register drift).
2. Half (b) first (smaller, benefits color path too): add the show flag to the packed record ONLY
   if the record layout has a free lane; otherwise this becomes a layout change touching the WGSL
   structs — in that case STOP and re-scope (layout changes ripple into every consumer of the
   176 B record and into C9-25's future previous-frame lanes; that is an L, not an S).
3. Half (a): mirror the resident manager for pick data; reuse its dirty ranges; pick-pass upload
   becomes "flush dirty ranges", not "rebuild array".
4. B694 discipline for any new revision fields.

### Traps

- **Cross-cluster:** the pick fleet (C10-11 log-depth conversion, `NEW-COLLECTION-PICK-2DCV-PIPELINE-KEY-PARITY`,
  FAR-107) is active territory. This slice must not change pick pipeline keys, depth behavior, or
  WGSL pick outputs — bytes and buffers only. Verify C10-11's outcome at intake (register ⚠C10).
- Show-flag-in-shader changes the "hidden = absent from buffer" invariant — drillPick/occlusion
  code that assumes compaction (index == dense slot) must be audited before switching to flags
  (search for slot-index arithmetic over the resident buffer).
- EncodedCartesian3 splits in the pick pack must stay bit-exact with the color pack (RTE charter).
- Blink-rate scenario: ensure the 16-byte partial write coalesces through the manager's existing
  dirty-range merge, not one writeBuffer per toggle.

### Verification recipe

- Probes: `probe-point-pick-webgpu.mjs`, `probe-pickposition-webgpu.mjs` (standing red — expected
  FAIL pre-existing; use OFF-oracle discipline: fails identically with this change neutralized),
  billboard/point pick cases in the pick fleet, `probe-collections-regression.mjs`.
- New `probe-pick-instance-mirror.mjs` (proposed): 10 k billboards under synthetic hover — asserts
  bytes-uploaded/pick-frame ≈ dirty-only (0 at settled), pick hit parity on 20 sampled instances
  vs PRE, show-toggle uploads ≤ 16 B×toggled, hidden instance not pickable.
- Perf: `moving-pick-camera-altitude-track-3d` (existing hover-pick lane!) + `entity-static-10k`
  with hover — named-stage oracle = pick-pack bytes/frame; banner per promotion rule.

### Model tier + effort

**opus-or-sol, M** (drop to S if premise-check kills the show-flip half). Escalate to fable ONLY if
the record layout has no free lane (design decision).

---

## ITEM 7 — "S10-7 / S10-8 — geometry/path incremental batching" (P2 · perf · L)

### What + why (evidence trail)

Two FAR-209-adjacent halves (PERF_ARCH_DEEP_DIVE S10-7/S10-8):
- **S10-7 (geometry batches):** any geometry-affecting change does removeUpdater (47-batch probe ×
  10 updaters ≈ 470 probes) then re-insert, marking the batch `createPrimitive = true` → a
  brand-new `Primitive` re-combining EVERY instance in the batch (worker re-tessellation + full
  upload + double-buffer memory spike). Streaming 5 k polygons one-per-tick ≈ 12.5 M cumulative
  re-combines. Both backends.
- **S10-8 (paths):** per path per frame the full lead/trail window is re-interpolated into a
  freshly sliced array; all paths in a reference frame share ONE `PolylineCollection`, and any
  polyline's position-COUNT change triggers `createVertexArrays`, re-encoding and re-uploading
  EVERY polyline in the collection — sliding windows change counts near-continuously. 500 paths ×
  120-sample windows ≈ 12 MB CPU/frame + GPU buffer recreation. **WebGPU regresses harder** (buffer
  recreation churns bind groups).

### Architecture today (verified at HEAD `5b98ab9698`)

- S10-7: `GeometryVisualizer.js` `_onCollectionChanged` :509 (exact; verified it handles
  added/removed — the register's claim that generic `changed` entities are ignored there and flow
  via `updater.geometryChanged` is consistent with the signature `(entityCollection, added,
  removed)`); `StaticGeometryColorBatch.js` `createPrimitive = true` at :89,
  `geometryInstances: geometries.slice()` at :170 (register said :137-183 — inside that span).
  PREMISE-UNVERIFIED: the "47 batches" count (register :50-55/:148-186) not re-counted at HEAD —
  worker recount (it is a static concat of outline/color/material × shadow × layer combinations).
- S10-8: `PathVisualizer.js` — shared collection `_polylineCollection` created :847 + added to
  scene :850 (register :845-851 exact); `subSample` at :710 with per-type subsamplers :221-696;
  `polyline.positions.slice()` at :990 (register :983-991 exact).
  `Scene/PolylineCollection.js` — `POSITION_SIZE_INDEX → createVertexArrays` at :448-449 (register
  :446-449, 2-line drift); `createVertexArrays` function at :945; per-polyline bucket for-in at
  :484ish (register :458-472 — drifted, symbol verified).

### Target design + invariants

- S10-7: batch sharding with a size cap (rebuild the shard, not the world); updater→batch
  back-pointer (kills the 470-probe scan); sub-range re-upload for shape-preserving changes.
- S10-8: ring-buffer incremental trail (append head / trim tail, cache interior samples);
  pre-allocate per-path vertex capacity so counts never change (degenerate-vert padding) turning
  updates into sub-range writeBuffer; polyline→bucket-offset back-pointer.

Invariants: (1) rendered geometry byte-equivalent (sharding must not change material batching
semantics visible via translucency sort or per-batch appearance); (2) path trails visually
identical at every clock time (padding verts must be exactly degenerate); (3) asynchronous
primitive replacement keeps the old primitive visible until the new one is ready (upstream
double-buffer behavior — preserve it inside a shard).

### Implementation walkthrough

1. Premise-verify on the lane: `entity-path-tracking` PRE (S10-8) + a CZML streaming-add probe
   (S10-7): confirm the collection-wide `createVertexArrays` fires ~every frame and the batch
   recombine is the top cost.
2. S10-8 first (self-contained, WebGPU-biased win): (i) fixed-capacity path allocation in
   `PathVisualizer` (window size derivable from resolution × lead/trail — cap + document); (ii)
   ring-buffer subsample: reuse the interior, interpolate only the new head segment per tick;
   (iii) in `PolylineCollection`, when only VALUES changed within an unchanged capacity, take the
   existing non-size update path (POSITION_INDEX) — verify at :484 that the per-polyline write is
   sub-range, extend if not.
3. S10-7 second: shard `StaticGeometryColorBatch` (and siblings — outline/material variants) at a
   documented cap (e.g. 512 instances/shard, tuned on the lane); add `updater → {batch, shard}`
   back-pointer consulted by remove/insert; `createPrimitive` dirties only the shard.
4. FAR-307 coordination (same files territory on the WebGPU side): land FAR-307's persistent
   material table first OR explicitly rebase — both restructure how polylines group (OPEN
   QUESTIONS sequencing).

### Traps

- S10-7 sharding changes translucency batching granularity — Primitive-level sorting between
  shards must preserve draw order semantics for translucent geometry (test with mixed-alpha
  polygons; capture-and-diff a translucent-geometry scene).
- The `geometries.slice()` at :170 exists because the async Primitive constructor consumes the
  array — sub-range paths must not alias live arrays into an in-flight worker tessellation.
- Degenerate-vert padding in `PolylineCollection` interacts with the polyline volume/screen-space
  expansion shaders — a zero-length segment must produce zero fragments on BOTH backends (WebGL
  `PolylineCollectionVS` + the WGSL twin); verify with the polyline probe fleet, including
  `probe-polyline-geodesic.mjs` and `probe-polyline-appearance-2d.mjs` (2D wrap paths duplicate
  segment logic).
- S10-8's fixed capacity is per-path memory ×N — cap × 500 paths must stay bounded; make capacity
  adaptive-grow-only with the B694 reset-on-realloc discipline.
- WebGPU bind-group churn claim: after FAR-307/S2-1 land, re-measure — the churn may already
  shrink; attribute honestly.

### Verification recipe

- Probes: polyline fleet above + `probe-vr2-polylines-3dtiles.mjs`; new
  `probe-path-ring-buffer.mjs` (proposed): 50 tracked entities, fixed clock scrub — asserts pixel
  parity vs PRE at 3 clock times, `createVertexArrays` invocations/frame → 0 at steady state
  (counter), capacity growth bounded; new `probe-geometry-batch-shard.mjs` (proposed): stream 1 k
  polygons one-per-tick — asserts per-add recombine cost O(shard) not O(N) (instance-recombine
  counter), final render pixel-equal to a single-shot add.
- Karma: geometry batch + PathVisualizer + PolylineCollection spec families.
- Perf: `entity-path-tracking` on/off/restored p95; banner per promotion rule; structural oracles
  (recombines/add, createVertexArrays/frame) land the slices.

### Model tier + effort

**opus-or-sol for S10-8** (mechanics well-specified, oracles crisp); **fable for the S10-7
sharding design** (translucency-order and async-replacement semantics need judgment), then
opus-or-sol execution. Total L across 2-3 slices.

---

## ITEM 8 — "S10-9 — ModelVisualizer static lane" (P2 · perf · S)

### What + why (evidence trail)

PERF_ARCH_DEEP_DIVE S10-9: every model entity pays isShowing + isAvailable + computeModelMatrix
(orientation getValue + Matrix4 compose) + ~25 `getValueOrDefault` reads + node-transformation /
articulation sub-loops per frame even when fully constant. 1 k static model entities ≈ 25 K
property dispatches + 1 K matrix composes/clones per frame (~1–3 ms) — upstream of, and invisible
to, C9-17's renderer-side work. The bulk/Sol `isStatic*` classification precedent was never
extended to models.

### Architecture today (verified at HEAD `5b98ab9698`)

- `packages/engine/Source/DataSources/ModelVisualizer.js` — per-frame `getValueOrDefault` chain
  verified at :108-278 (show :108, `entity.computeModelMatrix` :112, `Matrix4.clone` at :195 —
  exact match to register; silhouette/color/blend reads :210-232; animation reads :245-278).
  **Zero occurrences of `isStatic` in the file** — no static lane exists; premise confirmed.

### Target design + invariants

Reuse the `isStatic*Entity` classification pattern (BulkPointVisualizer :45 as the template):
constant-graphics model entities write Model state once (on classification and on
definitionChanged) and are skipped in the per-frame loop; dynamic ones keep the legacy loop.

Invariants: (1) a static-classified model entity that mutates ANY property re-enters the loop that
frame (definitionChanged-driven, with the CallbackProperty trap from S10-1 applied identically);
(2) availability windows keep working (time-windowed entities are NOT static);
(3) `runAnimations` / articulations force dynamic classification (they consume the clock);
(4) zero renderer-side changes — this is a visualizer-only slice, complementing C9-17 without
touching WebGPUModelRenderer (C9-17 Slice D is STOP-gated; stay out of its territory).

### Implementation walkthrough

1. Premise-verify: 1 k constant model entities on the lane (a small-N variant is fine — models are
   heavy; 100–1 k) — profile the visualizer loop share.
2. Write `isStaticModelEntity(entity)`: position/orientation constant, all consumed graphics
   properties constant, no animations/articulations defined, heightReference NONE, availability
   covering the whole clock window (or accept per-frame availability check as in S10-1 Trap 2).
3. Partition into static/dynamic sets maintained on collection-changed + definitionChanged;
   per-frame loop walks dynamic only.
4. One-time write path = the existing loop body run once at classification.

### Traps

- `model.readyEvent`-dependent state (the visualizer touches Model post-load — e.g.
  environmentMapOptions/incrementallyLoadTextures at :146-152 apply at creation) — the one-time
  write must run AFTER model readiness where upstream did, or settings silently drop.
- `heightReference` on models triggers clamping updates — clamped models are dynamic (or S10-1(d)
  territory later; keep them dynamic in this slice).
- `entity.computeModelMatrix` reads position AND orientation — both must be constant for static.
- Do not cache across `modelMatrix` external mutation: the visualizer owns model.modelMatrix for
  its entities; nothing else should write it — assert (debug pragma) rather than assume.

### Verification recipe

- Karma: ModelVisualizer spec family (upstream has thorough coverage of every property mapping —
  the primary net; add static-lane cases: classify, mutate-one-property, re-render).
- New `probe-entity-model-static-lane.mjs` (proposed): 50 static + 5 dynamic model entities
  (offline glTF, e.g. BoxTextured) — asserts per-frame visualizer visits == 5 (counter), pixel
  parity PRE/POST, a mid-session `model.scale` property change on a static entity takes effect
  next frame.
- Perf: lane variant with models; named-stage oracle = visualizer property dispatches/frame
  (25 K → ~25×dynamic); banner per promotion rule.

### Model tier + effort

**opus-or-sol, S.** The precedent (`isStaticPointEntity`) is in-tree and verified; risks are
enumerable property mappings.

---

## ITEM 9 — "S2-1 — collection resolver-closure churn" (P2 · perf · S)

### What + why (evidence trail)

PERF_ARCH_DEEP_DIVE S2-1 (owner note: C9-27/FAR-309 add-acceptance-clause; interim fix explicitly
scoped to not conflict with C9-27's view ring which deletes the mechanism long-term): `makeResolver`
is documented call-once-per-update (per frame). Each call allocates the opts literal, a fresh pack
arrow closure capturing frameState/modelMatrix, a 4-element extraEntries array, the returned
resolver closure, and `_keyForExtras` string-builds an identity key via `+=` concatenation — the
exact identity-string pattern C9-13 bans on terrain. It also unconditionally repacks the full
camera UB CPU-side with no revision gate. ~16 allocations (~1 KB)/collection/frame; the
settled-collection zero-work contract stops one line above the resolver rebuild.

### Architecture today (verified at HEAD `5b98ab9698`)

- `WebGPUCollectionCameraUB.js` — `makeResolver(opts)` at :141; `_keyForExtras` call at :187,
  static at :321 (register :141-262/:321-336 — exact); shared CPU scratch comment at :86; the
  "called once per update()" contract documented at :266-267.
- Call sites verified: `WebGPUBillboardRenderer.js:1224`, `WebGPULabelRenderer.js:1121`,
  `WebGPUPointPrimitiveRenderer.js:1124`, `WebGPUPolylineRenderer.js:488` (×material type),
  `WebGPUCloudRenderer.ts:1297` (register said :1277 — 20-line drift).
- PREMISE-UNVERIFIED (magnitude): the "unconditional full camera repack" cost was measured under
  the pre-C10-01 2-frustum world (per-slice duplicates). B693's 1-frustum default reduces slice
  count in 3D — re-measure before claiming numbers; the allocation churn premise is
  frustum-independent and stands on the verified code shape.

### Target design + invariants

Cache resolver + opts keyed by the collection cache's existing `_gen` identity token; replace
`_keyForExtras` string building with numeric-id comparison (deep-dive: `_idOf` already yields
ints); revision-gate the CPU repack (camera revision — UniformState frame/camera identity).

Invariants: (1) resolver behavior identical on every mutation path (modelMatrix change, extras
change, HDR flip, device loss → `_gen` MUST bump on each; verify what bumps `_gen` before trusting
it — if any of those paths does not bump it, extend the key, do not skip the rebuild);
(2) interim-fix shape must be deletable by C9-27's view ring without archaeology (isolate in one
memo block, comment the C9-27 pointer); (3) per-frame writeBuffer of camera contents continues
whenever contents actually change (this gates the CPU-side repack + allocations, not the upload
correctness).

### Implementation walkthrough

1. Read `makeResolver` + `_keyForExtras` + the `_gen` mechanics in full; enumerate every input
   that can change the resolver's behavior; map each to an existing revision source.
2. Memoize per collection cache: `{gen, extrasIds, resolver, opts}`; compare numerically.
3. Revision-gate the repack on (camera revision, modelMatrix revision) — reuse UniformState's
   existing frame identity rather than inventing one.
4. Keep the resolved bytes path byte-identical (the pack function itself is untouched).

### Traps

- The resolver closure captures `frameState` — a cached closure must NOT capture a stale
  frameState reference; restructure to pass frameState at resolve-time (parameter, not capture)
  as part of the memo, or re-make on frameState identity change (it is per-frame stable in
  practice, but the capture is the bug surface).
- Polyline calls makeResolver per material type (:488) — the memo must key per material-type
  resources entry, not per collection singleton (interacts with FAR-307's regrouping — sequence).
- Do not extend into S10-5's define memo — separate slice, separate revert.

### Verification recipe

- Probes: `probe-collections-regression.mjs`, `probe-point-label-partial-write.mjs`,
  `probe-collections-entity.mjs`, `probe-polyline-multimaterial.mjs`, cloud probe
  (`probe-cloud-property-edit` per B694 ledger) — all must stay green.
- New assertion inside an existing collections probe (or `probe-collection-resolver-memo.mjs`):
  allocations/frame at settled == 0 for the resolver block (pragma-wrapped counter), mutation
  paths (modelMatrix nudge, HDR flip, extras change) each rebuild exactly once.
- Perf: `entity-static-10k` + existing `sparse-mutation-3d` (collection-direct — also exercises
  this path); named-stage oracle = resolver allocations/frame; banner per promotion rule.

### Model tier + effort

**opus-or-sol, S.** The one design risk (closure capture) is named above.

---

## ITEM 10 — "FAR-307-POLYLINE-PERSISTENT-MATERIAL-TABLE" (P2 · perf · L)

### What + why (evidence trail)

C9 queue §9 W5 item 62: *"Persistent exact material/geometry table with safe coalescing and dirty
ranges; high-cardinality mixed materials, mutation, pick, TAA velocity, lifetime, and no
first-material aliasing."* It is the durable owner of the Sol-audit P0-5 interim fix
(`AUDIT-P0-COLORTYPE-POLYLINE-BATCHING`, COMPLETE 2026-07-16): exact-material-identity grouping had
split N default Color-type polylines into N groups/segment buffers/UBOs/bind groups/draws for zero
correctness gain; the interim fix keys Color-type materials by material TYPE while UBO-consuming
types (Glow/Dash/Arrow/Outline) keep exact identity. FAR-307 replaces per-update regrouping with a
persistent table + dirty ranges.

### Architecture today (verified at HEAD `5b98ab9698`)

- `WebGPUPolylineRenderer.js` — the interim P0-5 keying VERIFIED live: `materialType` resolution at
  :305, `groupKey = materialType === "Color" ? <type key> : <identity key>` at :313-317, group map
  :318-324; `getMaterialResourceKey` at :336 (`Color`/undefined → `${materialType}_default` :343-344,
  else `${materialType}_${id}` :353); per-material-type frame resources
  (`materialTypeFrameResources` Map) at :407; camera resolver per type at :488. The file's own
  header (:74-76) documents the material-type bucketing + nested `pipelines[materialType] → Map`
  cache as polyline-unique logic.
- The regrouping runs per update (per frame when dirty) — the persistent-table premise (groups
  rebuilt rather than maintained) is the code's documented shape; PREMISE-UNVERIFIED at the
  magnitude level (how often regroup fires at settled) — instrument first.

### Target design + invariants

Persistent material/geometry table: stable group identity across frames keyed by (materialType,
material identity for UBO types); per-group segment buffers maintained with dirty ranges (add/
remove/mutate polyline → touch only its group's ranges); safe coalescing (small groups may share
buffers ONLY with per-draw offsets that preserve exact material bytes — never first-material
aliasing, the failure P0-5's history warns about).

Invariants (straight from the W5-62 acceptance text): high-cardinality mixed materials render
correctly; material mutation (Color→Dash, dash-length edit) takes effect next frame; pick still
resolves per polyline; TAA velocity unaffected; buffer lifetime device-generation-safe; NO
first-material aliasing (two groups with equal type but different UBO contents never share a UBO).

### Implementation walkthrough

1. Instrument settled behavior: groups rebuilt/frame, buffers recreated/frame on a 100-polyline
   mixed-material scene (PRE evidence; if the interim fix already made settled zero-work, the
   slice's value is mutation-path + high-cardinality — re-scope honestly).
2. Introduce the table keyed by the P0-5 groupKey (already correct); retain group objects +
   segment buffers across updates; add per-group `contentRevision` (B694 naming) bumped by
   polyline add/remove/position/material writes (PolylineCollection's property-index dirty flags
   — POSITION_INDEX/MATERIAL_INDEX etc. — are the existing signal; consume, don't duplicate).
3. Dirty-range uploads within a group; group create/destroy only on membership change.
4. Coalescing LAST and only with the aliasing spec in place.

### Traps

- **S10-8 collision:** S10-8 restructures `PolylineCollection` count-change behavior; FAR-307
  restructures the WebGPU renderer's consumption of it. Land FAR-307 first (its table absorbs
  count-stable updates naturally) or explicitly sequence — never concurrently.
- Pick: `probe-polyline-appearance-pick.mjs` is a committed RED probe for a DIFFERENT bug
  (appearance-primitive pick viewport, pick cluster) — do not claim or break it; polyline
  *collection* pick must stay green.
- Material UBO field alignment: any new UBO packing goes through the existing pack helpers — the
  Material-UBO field-name audit (standing-reds cluster) flags silent misalignment as a live risk
  class; do not hand-roll offsets.
- 2D/CV: polylines have mode-specific paths (`probe-polyline-appearance-2d.mjs`,
  `probe-collections-2dcv-morph`) — table identity must include whatever mode-dependent variants
  the pipeline cache keys on today (read the `pipelines[materialType]` key composition before
  moving it).

### Verification recipe

- Probes: `probe-polyline-multimaterial.mjs` (the high-cardinality gate),
  `probe-polyline-image-material.mjs`, `probe-polyline-geodesic.mjs`, `probe-polyline-cloud-consume.mjs`,
  `probe-collections-regression.mjs`, `probe-collections-2dcv-morph`, ground-polyline fleet
  untouched (`ground-polyline-smoke.mjs` etc. — different renderer, assert no scope leak).
- New `probe-polyline-material-table.mjs` (proposed): 200 polylines across all 5 material types —
  settled creates/frame == 0 (groups + buffers + UBOs + bind groups counters), mutate one dash
  material → exactly one group's ranges upload, add/remove polyline → only its group rebuilds,
  Color+Glow with equal colors do NOT alias, pixel parity PRE/POST, pick 10 sampled polylines.
- Perf: `entity-path-tracking` (paths ride PolylineCollection) + a polyline-heavy lane variant;
  named-stage oracle = per-frame creates at settled; banner per promotion rule.

### Model tier + effort

**opus-or-sol, L.** The acceptance contract is fully written (W5-62); the interim fix pinned the
keying semantics; remaining work is disciplined mechanics.

---

## ITEM 11 — "PARITY-POINT-SPRITE-SHAPE-RESIDUALS" (P2 · parity · M)

### What + why (evidence trail)

DEFERRED_WORK ~5116 (2026-07-02, surfaced by the shipped PARITY-POINT-SPRITE-SHAPE fix, B490-era):
two residuals after the shape/size parity landed:
1. **PARITY-POINTCLOUD-COLOR-TINT (candidate row, diagnose-first):** WebGPU point clouds read
   ~27–45% brighter/bluer than WebGL on the same PNTS data (per-channel mean ratios R 0.78 /
   G 0.72 / B 0.69), with a **monotone same-session drift** (seven consecutive runs: styled
   9.34→16.67%, attenuation-only 12.29→18.85% raw ds4) — NOT a pure global gain (gain-equalized
   compare still leaves ~9.7–12.4%, itself creeping ~1pp/run). The drift "smells like a
   time/adaptation-dependent stage (auto-exposure/tonemap adaptation)". The probe currently gates
   on gain-NORMALIZED ds4 (<16%) so the tint cancels; DW asks to tighten to ~8% once fixed.
2. **czm_pixelRatio + u_maxTotalPointSize unplumbed** → hiDPI point primitives undersize vs WebGL.

### Architecture today (verified at HEAD `5b98ab9698`)

- Residual 2 CONFIRMED: `packages/engine/Source/Shaders/WebGPU/Collections/PointPrimitiveColor.wgsl:164`
  carries the literal comment *"(czm_pixelRatio and u_maxTotalPointSize are not plumbed into
  this"*… — the gap is self-documented in the shader. WebGL sources:
  `Shaders/PointPrimitiveCollectionVS.js` + `Scene/PointPrimitiveCollection.js` (both contain
  `maxTotalPointSize`).
- Residual 1: no fix in git (DW row open). Suspect list from DW: color pipeline around the
  point-cloud draw (gamma/linear, tonemap interaction, or RGB through `buildInstanceBuffer`);
  the drift points at auto-exposure/tonemap adaptation. Diagnostic assets exist:
  `diag-stars-hdr-autoexposure.mjs` + `probe-stars-hdr-autoexposure-parity.mjs` demonstrate the
  house method for isolating auto-exposure adaptation effects.
- Probe: `probe-point-sprite-shape.mjs` present; prints per-channel `gains` every run.

### Implementation walkthrough

Residual 1 (diagnose-first, own slice):
1. Reproduce the drift: run `probe-point-sprite-shape.mjs` 5× same session; confirm the monotone
   creep still reproduces at HEAD (2 weeks of pipeline changes since 07-02 — C10-03's resolve
   rework and C9-era tonemap work may have moved it; PREMISE re-verify).
2. Bisect the stage: A/B with auto-exposure OFF (`scene.postProcessStages.autoExposure` path),
   tonemap forced fixed, HDR off — the drift disappearing under one toggle names the stage.
3. Fix in the named stage (likely: point-cloud draws sampling into the auto-exposure history or
   the FR's draw ordering relative to exposure measurement — do NOT hack a gain constant into the
   point-cloud shader; charter: no inline shortcuts).
4. Tighten the probe's normalized gates toward ~8% per the DW instruction ONLY after the fix.

Residual 2 (mechanical, own slice):
1. Plumb `pixelRatio` (UniformState `pixelRatio`) + `maxTotalPointSize` into the point-primitive
   UB (a free pad lane or widen per WGSL struct rules — mirror the JS pack + WGSL struct together,
   Material-UBO-alignment discipline).
2. Mirror `PointPrimitiveCollectionVS` sizing exactly (the DW entry documents the formula parity
   already achieved: outlinePercent from unpadded size, scaleByDistance on TOTAL size, +3px AA
   pad, `v_pixelDistance = 2/totalSize` — extend with the pixelRatio term where WebGL applies it).
3. Also touch `PointPrimitivePick.wgsl` twin (sizing must match color pass or pick footprint
   diverges).

### Traps

- Residual 1 is cross-cluster with postprocess-effects (auto-exposure owner) — if the root cause
  lands in AutoExposure, coordinate: fix belongs there, gate probes here.
- hiDPI: the VR harness runs `deviceScaleFactor: 1` — residual 2's oracle needs an explicit
  `deviceScaleFactor: 2` probe context or it will falsely pass; do not claim parity from the
  default harness alone.
- Tightening the probe gate before the tint fix would turn the standing drift into a flaky red —
  order matters (DW says tighten AFTER).

### Verification recipe

- `probe-point-sprite-shape.mjs` (gains print + normalized/raw ds4 both scenes); repeat-run drift
  oracle (5 same-session runs, creep < 0.2pp/run POST vs ~1pp PRE).
- New `probe-point-primitive-hidpi.mjs` (proposed): dsf=2 context, WebGL-vs-WebGPU point footprint
  pixel counts within 5% (PRE shows undersize), maxTotalPointSize clamp exercised.
- `probe-point-pick-webgpu.mjs` + collections regression green.
- Promotion: parity items — the band tightening (16%→~8%) is the landing oracle, no perf banner.

### Model tier + effort

**Residual 1: fable, M-investigate/S-fix** (explicitly diagnostic; session-drifting root cause).
**Residual 2: opus-or-sol, S** (self-documented gap, formula parity already written down).

---

## ITEM 12 — "NEW-WEBGPU-CELESTIAL-RETAINED-RESOURCES" (P1 · perf · S–M)

### What + why (evidence trail)

C9 queue §3.2 L136 + §9 item 76 (NOT STARTED; C10 queue §4 lists it as a W1 cheap-rider candidate
that was never absorbed — unowned): the C9-06 audit found WebGPU Sun recreates its position vertex
buffer as time advances, then writes a 256-byte UBO and allocates a bind group plus a command per
frame; StarField writes 256 B and allocates two commands plus arrays per frame. Task: retain
device-generation-safe commands/bind groups, move the changing Sun position into a dirty
uniform/buffer update, eliminate per-frame typed arrays / command arrays / native resource churn —
preserving time motion, HDR/MSAA/resize, visibility restore, multiple contexts, loss, and
deterministic destruction, without changing WebGL or celestial output.

### Architecture today (verified at HEAD `5b98ab9698` — premise CONFIRMED, stronger than the register states)

`packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js` (Sun):
- `createSunQuadBuffer(device, sunPosition)` at :300 — allocates a fresh 48-float `Float32Array`
  AND a fresh GPUBuffer per call (6 verts × posHigh/posLow/direction — RTE-encoded, correct).
- Per-frame recreate at :568-577: `if (!defined(cache.vertexBuffer) || !Cartesian3.equals(cache.lastSunPos, sunPos))
  { vertexBuffer.destroy(); cache.vertexBuffer = createSunQuadBuffer(...) }` — the live rotating
  `uniformState.sunPositionWC` (:564-567) changes every simulated-time-advancing frame, so with an
  animating clock this is a **GPUBuffer destroy+create per frame**.
- `UNIFORM_BUFFER_SIZE = 256` (:183); UBO created once (:579-587) but `cache.bindGroup =
  device.createBindGroup(...)` EVERY frame (:603-610) and `cache.command = new WebGPUDrawCommand(...)`
  EVERY frame (:612-619), then `commandList.push` (:621).
- **The in-file GOOD precedent is the Moon**, same file: UBO once (:968-976), bind group retained
  behind `if (!defined(cache.bindGroup))` with explicit invalidation on texture change (:978-992,
  `_bundleStale` marker), snapshot-freezable uniform-write skip (:1000-1032), render-bundle replay
  (:1034+). The Sun/StarField fix is "make them Moon-shaped".

`packages/engine/Source/Renderer/WebGPU/WebGPUStarFieldRenderer.ts`:
- `STAR_UNIFORM_BUFFER_SIZE = 256` (:157); per-frame `writeBuffer` (:619) — content-driven, fine.
- Per-frame `cache.command = new WebGPUDrawCommand({...})` (:646-654) AND
  `cache.injectCommand = new WebGPUDrawCommand({...})` (:657-665) — two fresh command objects +
  two fresh `bindGroups`/`vertexBuffers` array literals every frame. Bind group itself is retained
  (created in `ensureStarFieldResources`, :531).

### Target design + invariants

1. Sun vertex data: retain ONE GPUBuffer; on `sunPos` change, `queue.writeBuffer` the 192 bytes
   into it from a module-scratch Float32Array (no allocation, no destroy/create). Keep the
   `Cartesian3.equals` gate as the dirty check.
2. Sun bind group: create once; invalidate ONLY on inputs changing identity (uniformBuffer
   recreate, sunTextureView change, device generation) — Moon pattern.
3. Sun/StarField commands: retain the `WebGPUDrawCommand` instances (+ their bindGroups/
   vertexBuffers arrays); rebuild only when pipeline identity changes (HDR flip swaps pipelines —
   see Traps), device generation bumps, or constituent resources change. Per-frame work becomes:
   dirty-check + writeBuffer(s) + `commandList.push(retainedCommand)`.
4. Preserve EXACTLY: time motion (sun visibly rotates — the dirty gate must fire on position
   change), HDR/MSAA/resize behavior, visibility restore, multi-context (cache is per-primitive
   `_webgpuCache` keyed off context — verify per-context correctness when two viewers exist),
   device loss (C-R12 hazard: register the retained resources with the loss walk the file already
   uses), deterministic destroy.

### Implementation walkthrough

1. Premise-instrument PRE: pragma-wrapped counters for sun buffer creates/frame, bind-group
   creates/frame, command allocs/frame with an animating clock (probe below) — expect ~1/1/1 (sun)
   + 2 (stars) per frame.
2. Sun buffer retention (writeBuffer path) — smallest slice; verify sun still rotates
   (`probe-sun-pixel-check.mjs` at two clock times).
3. Sun bind-group + command retention, Moon-pattern guards.
4. StarField command-pair retention. **Coordinate with NEW-WEBGPU-STARFIELD-SINGLE-SUBMISSION**
   (Item 13): if that item lands first and drops the inject path, only ONE command needs
   retention; if this lands first, retain BOTH and note that retained-command identity makes the
   `maybeInject` dedupe scan (`SceneRenderer.js:358-371`, identity compare `envCmds[c] === cmd`)
   actually able to catch a duplicate — a behavior improvement that must be called out, not
   silent (it could mask Item 13's double-draw before it is measured — another reason Item 13's
   instrumentation slice goes FIRST).
5. HDR flip test: `scene.highDynamicRange` toggle mid-session → pipelines swap → retained commands
   rebuild exactly once → visuals correct (probe-stars-hdr-verify + probe-sun-* battery).

### Traps

- **Retained command mutation:** `WebGPUDrawCommand` instances pushed into `commandList` get binned
  and executed per frame; verify nothing downstream mutates per-frame fields on the command object
  (owner/pass are static; check the executor does not stamp per-frame state onto commands — if it
  does, retention needs a reset step).
- C10-01 (B693): the binned env push is what triggers the sky-only fallback — retention must not
  change WHEN the push happens (every rendered frame while visible), only the object identity.
- C9-06 warm-keep: `prepareWebGPUStarField` builds resources with no per-frame pack/draw — the
  retained command should be built lazily on first `update`, not in `prepare` (keep prepare
  draw-free, per the B684-certified StarFieldSpec behavior).
- Snapshot mode: the Moon skips uniform writes when frozen — extend the same freezable courtesy to
  Sun/StarField only if C9-06's cache doesn't already cover it; do NOT let a freeze skip the
  position dirty-check re-arm (thaw must recompute).
- Multi-context: `cache` lives on the primitive (`starField._webgpuCache`) — two contexts sharing
  one primitive is the documented multi-context hazard; check how the cache is keyed before
  retaining device objects in it (if it is per-primitive-single-context today, preserve that
  contract and note it; do not silently widen).
- Do not touch the Moon path at all (it is the reference; a diff there = scope leak).

### Verification recipe

- New `probe-celestial-retained-resources.mjs` (proposed): animating clock, sun+stars visible,
  API-lane counters — PRE {sunBufferCreates≈1/frame, sunBindGroupCreates≈1/frame,
  commandAllocs≈3/frame} → POST {0/0/0 at settled; exactly-once rebuilds on HDR flip, resize,
  forced device-loss-recovery}; sun position advances across two clock samples (pixel centroid of
  the sun disk moves — feature oracle); star brightness unchanged (mean luminance of star pixels
  within 1%).
- Existing battery (all must stay green, both backends where applicable):
  `probe-celestial-extinction-cache.mjs` (starUpdateDelta 1, pipelineReady, warm-keep),
  `probe-celestial-extinction-revision-gate.mjs`, `probe-sun-stars-extinction.mjs` (PARITY
  match=true), `probe-env-skybox-stars.mjs`, `probe-starfield-webgl-parity.mjs`,
  `probe-stars-catalog.mjs`, `probe-moon-atmosphere.mjs`, `probe-sun-glowfactor.mjs`,
  `probe-frustum-count-3d.mjs` (env binning untouched), `diag-stars` family for HDR.
- Karma: StarFieldSpec 7/7 (Edge CHROME_BIN per memory).
- capture-and-diff: globe-default band 0.43–0.77% + historical lanes 0.01%.
- Perf stance: this is allocation hygiene — named-stage oracle (creates/frame → 0) lands it; no
  banner expected (default route p95 impact is µs-scale); promotion rule: truthful miss + green
  mechanics = VALID COMPLETE.

### Model tier + effort

**opus-or-sol, S–M.** The Moon precedent makes this well-specified execution; the traps are
enumerated. Sequence AFTER Item 13's instrumentation slice.

---

## ITEM 13 — "NEW-WEBGPU-STARFIELD-SINGLE-SUBMISSION" (P1 · correctness · M)

### What + why (evidence trail)

C9 queue §3.2 L137 + §9 item 77 (NOT STARTED; W1 cheap-rider candidate, unowned; the C9 row
explicitly notes "per the broken-feature rule this correctness-first item stays queued"): a static
command-flow audit indicates a cubemap frame keeps the binned catalog-star draw AND a distinct
post-cubemap injected draw — contradicting the single-submission contract and potentially doubling
star GPU work/brightness. Task: instrument exact execution order/count with and without cubemap,
then establish ONE authoritative environment command path preserving sky-only frustum creation,
additive HDR appearance, WebGL behavior, visibility toggles, and recovery.

### Architecture today (verified at HEAD `5b98ab9698` — premise CONFIRMED statically, with a sharper finding than the register's)

The full chain, read end-to-end at HEAD:
1. `WebGPUStarFieldRenderer.ts` `updateWebGPUStarField` (:582): pushes `cache.command` into
   `frameState.commandList` (:655) AND returns a **distinct** `cache.injectCommand` (:657-666).
   Both are freshly allocated per frame (never identity-equal).
2. `Scene.js:3746-3765`: `starCommand = starField.update(frameState)`;
   `dropForBinnedNoCubemap = starField.wasBinned && !defined(environmentState.skyBoxCommand)`;
   `environmentState.starFieldCommand = dropForBinnedNoCubemap ? undefined : starCommand`. So
   **with a cubemap present, BOTH the binned copy and the inject copy survive.** (No cubemap →
   inject dropped → net 1×. WebGL → wasBinned false → inject-only → net 1×. Those legs are fine.)
3. `SceneRenderer.js:330-444` (injection into the farthest frustum's ENVIRONMENT slot):
   `bgEnv = [skyBoxCommand?, starFieldCommand?]` is **PREPENDED** ahead of the already-binned env
   commands (:383-404 — the shift loop at :397-399). The `maybeInject` identity-dedupe (:358-371)
   applies only to skyAtmosphere/sun/moon/panoramas, NOT to the bgEnv prepend — and could not
   catch the star pair anyway (distinct objects).
4. **Resulting execution order on a cubemap frame:** `skyBox → injectStars → … binned env
   (including binnedStars) …`. The comment inside `updateWebGPUStarField` (:639-645) claims the
   binned copy draws EARLY and is "wiped by the cubemap" so net brightness is 1× — but the bgEnv
   prepend (added later to fix the atmosphere-erase bug, per the :373-382 comment) **inverted that
   ordering**: the binned copy now executes AFTER the cubemap, additively, on top of the injected
   copy. Static conclusion: on WebGPU cubemap frames the catalog draws **twice, both visible,
   additive HDR → ~2× star brightness contribution + 2× GPU work**, and the in-code
   double-draw-avoidance comment describes an ordering that no longer exists.

This static read SHARPENS the register (which hedged "potentially doubling") but the item's own
step 1 — runtime instrumentation of exact order/count — remains mandatory before any fix:
per-frame command execution logging must confirm both draws land and quantify the brightness
delta. PREMISE-VERIFIED at the static level; RUNTIME-UNVERIFIED (by design — that is slice 1).

### Target design + invariants

One authoritative path. The minimal candidate fix (pending instrumentation): change the Scene.js
gate from `dropForBinnedNoCubemap` to drop-inject-whenever-`wasBinned` — under the CURRENT prepend
ordering the binned copy already draws after the cubemap, in the right position (stars on top of
skyBox, before atmosphere), so the inject copy is the redundant one. Then fix the stale comment
blocks in BOTH files to describe the real ordering (a drift between comment and code here already
caused one misdesign; comment truth is part of the deliverable).

Invariants (from the C9 §9-77 acceptance text): exactly ONE physical catalog draw per frame in
every configuration {cubemap on/off × WebGL/WebGPU × stars visible/hidden}; unchanged enabled
appearance EXCEPT the intended brightness halving on WebGPU cubemap frames (this is a visual
CHANGE — it restores WebGL parity; the parity probe is the arbiter, see recipe); sky-only frustum
creation preserved (the binned push is untouched — C10-01's fallback depends on it); off/on
restore; recovery (device loss); WebGL byte-untouched.

### Implementation walkthrough

1. **Slice 1 — instrument (fable):** pragma-wrapped per-frame log/counters in the WebGPU executor
   tagging star-command executions (owner === starField) with order indices; run with and without
   a skyBox cubemap; record {drawCount/frame, order, mean star-pixel luminance}. Also capture
   WebGL luminance for the same scene (parity reference). Artifacts: JSON + PNGs. If drawCount==1
   (static analysis wrong — e.g. an unseen dedupe), downgrade the item to a comment-truth fix and
   file the correction against the register.
2. **Slice 2 — the fix (opus-or-sol):** apply the one-line gate change (or the instrumentation-
   informed alternative); update the two stale comment blocks; keep `wasBinned` backend-agnostic
   semantics exactly (WebGL path must keep receiving the returned command).
3. Verify the brightness delta matches prediction (cubemap-frame star luminance drops to ≈ the
   no-cubemap level and ≈ WebGL level).

### Traps

- **The parity direction must be proven, not assumed:** `probe-starfield-webgl-parity.mjs` and
  `probe-env-skybox-stars.mjs` PRE-state tell you whether current gates were tuned against the
  doubled brightness. If a probe band was calibrated on the 2× state, fixing the double-draw will
  RED that probe — recalibrating it is part of the slice (with PNGs read, per Principle 8), not a
  regression to paper over.
- HDR auto-exposure adaptation: halving star energy shifts auto-exposure on night scenes —
  `probe-stars-hdr-autoexposure-parity.mjs` + `diag-stars-hdr-autoexposure.mjs` are the
  instruments; expect small downstream exposure deltas and budget for them in bands.
- Do NOT remove the binned push or move stars out of `commandList` (C10-01 sky-only fallback +
  frustum-existence contract). The fix is in which COPY survives, not in the push.
- Item 12 interplay: retention changes object identity semantics; run this item's instrumentation
  BEFORE Item 12 retains star commands (sequencing rule in the charter section).
- `panoramaCommandList` / CubeMapPanorama frames (SceneRenderer :415-419): re-run the
  instrumentation with a panorama scene — the same prepend mechanics apply; verify no analogous
  duplicate there while you have the instrumentation live (observation only; separate item if red).

### Verification recipe

- Slice-1 artifacts: order/count JSON with and without cubemap, both backends' luminance.
- Slice-2 gates: `probe-env-skybox-stars.mjs`, `probe-skybox-stars-sun.mjs`,
  `probe-skybox-stars-sun-facing.mjs`, `probe-starfield-webgl-parity.mjs` (the parity oracle —
  WebGPU cubemap-frame star luminance within band of WebGL), `probe-stars-catalog.mjs`,
  `probe-stars-hdr-verify.mjs`, `probe-celestial-extinction-cache.mjs` (warm-keep untouched),
  `probe-frustum-count-3d.mjs` (frustum parity untouched), StarFieldSpec 7/7 Karma.
- On/off/restored: `skyBox.show` toggle mid-session → exactly-one-draw invariant holds in every
  state; `starField.show` off → 0 draws → on → 1 draw.
- capture-and-diff: globe-default band unchanged (daytime — stars invisible; the change is
  night-scene-only); add the night PNG pair to the slice artifacts (C9-06 style: non-black pixel
  counts + crisp stars, read by eyes).
- Promotion: correctness item; no perf banner. GPU-work halving on cubemap night frames is a
  bonus, cite analytically only.

### Model tier + effort

**Slice 1: fable, S** (diagnostic; two in-code comments contradict each other and the register —
exactly the ambiguous-premise profile). **Slice 2: opus-or-sol, S–M** (one-line gate + comment
truth + band recalibration). Register effort M overall — agrees.

---

## OPEN QUESTIONS for the orchestrator

1. **Benchmark-lane workload-file identity (blocks Item 1, hence the arc):** the C9-30/C10-30
   comparison artifacts key on workload-set id `fork-remediation-phase0-v1`. Should the entity lane
   live in a SEPARATE `performance-workloads-entity.json` with its own set id (my recommendation —
   preserves checkpoint comparability and keeps the default-path gate's runtime unchanged), or be
   appended under a bumped id? Maintainer/orchestrator call before Item 1 is cut.
2. **Declutter displacement-threshold default (S10-2 slice b):** gating `_clusterDirty` on
   screen-space displacement changes user-visible re-cluster cadence. Charter forbids degrading a
   feature for a metric. Options: (i) ship opt-in (`cluster.declutterDisplacementThreshold`,
   default 0 = today's behavior) — no approval needed; (ii) pick a nonzero default — needs
   maintainer sign-off. Guide assumes (i) unless told otherwise.
3. **Cross-cluster sequencing vs the pick cluster:** S10-6 must not pre-empt FAR-107's pick-query
   contract, and C10-11 (pick-fleet log-depth, C10-owned) may still be in flight. Does the
   orchestrator want S10-6 held until FAR-107 lands, or scoped strictly to allocation mechanics
   now (my recommendation: strict scope now, one revisit clause)?
4. **S1-3 / frame-delta cluster overlap:** S10-1 slice (d) (clamped-static sub-lane) touches the
   terrain-height callback web that S1-3 (globe-height plumbing rebuild, frame-delta cluster)
   rebuilds. If both are scheduled in C11, S1-3 should land first or slice (d) should be deferred
   to avoid double-churn on the same plumbing.
5. **C9-27 timing:** S2-1's interim fix is explicitly scoped to not conflict with C9-27's
   collection view ring (which deletes the resolver mechanism long-term). Is C9-27 scheduled
   anywhere in C11? If yes and early, S2-1 may not be worth an interim slice; if late/absent,
   S2-1 stands.
6. **C10-30 attribution gate:** should the S10 arc's opening (Items 2-3, the L-sized slices) wait
   for the C10-30 checkpoint verdict, in case its per-stage attribution re-ranks model-frontend vs
   entity-frontend work? Items 1, 5, 9 (lane + cheap WebGPU hygiene) are safe to schedule
   regardless.
7. **STARFIELD single-submission downgrade path:** if Item 13's instrumentation shows net 1×
   (static analysis wrong), the item collapses to a comment-truth fix — pre-authorize that
   downgrade so the worker doesn't force a fix onto a healthy path.
8. **Entity-lane brightness/probe recalibration authority (Item 13 trap):** recalibrating a
   parity band that was tuned against doubled star brightness is a probe-content change — confirm
   the orchestrator accepts band edits inside the same slice when accompanied by PNGs + a written
   rationale (house precedent: B308 band tightening 0.4–2.5 → 0.75–1.25).
9. **PARITY-POINTCLOUD-COLOR-TINT ownership:** if the fable diagnosis lands the root cause in
   AutoExposure/tonemap (postprocess-effects cluster), does the fix migrate clusters or stay here
   with a cross-cluster reviewer? Recommend: fix migrates to the owning subsystem, probes stay
   here.

---

## Coverage ledger

| Register row (§9 entity-scale + §11 celestial-env) | Dossier | Premise state at HEAD `5b98ab9698` |
|---|---|---|
| Entity-at-scale arc (S10 umbrella, register §14 seed 3) | Cluster charter (not schedulable as one task) | Umbrella — members verified individually |
| 10k-entity benchmark lane (§14 seed 3 prerequisite) | Item 1 | VERIFIED (12 workloads, zero entity lanes) |
| S10-1 — dynamic-entity fallback lane (supersedes S1-4) | Item 2 | VERIFIED (gates + legacy lane); magnitudes lane-pending |
| S10-2 / S10-3 — clustering forfeits bulk lane + declutter rebuild | Item 3 | VERIFIED (forfeiture gate exact; declutter-body internals worker-re-read) |
| S10-4 — GeometryUpdaterSet lazy instantiation | Item 4 | VERIFIED (per-set Event/EventHelper); magnitudes lane-pending |
| S10-5 — collection define-scan gating | Item 5 | VERIFIED (3 scan sites + per-frame calls) |
| S10-6 — pick instance repack + visibility-flip rebuild | Item 6 | VERIFIED (repack); show-flip structural half PREMISE-UNVERIFIED (re-read `_needsFullRebuild` body) |
| S10-7 / S10-8 — geometry/path incremental batching | Item 7 | VERIFIED (slice sites); "47 batches" count PREMISE-UNVERIFIED |
| S10-9 — ModelVisualizer static lane | Item 8 | VERIFIED (zero isStatic in file) |
| S2-1 — collection resolver-closure churn | Item 9 | VERIFIED (allocation shape); magnitude stale post-C10-01, re-measure |
| FAR-307-POLYLINE-PERSISTENT-MATERIAL-TABLE | Item 10 | VERIFIED (P0-5 interim keying live); settled-regroup magnitude instrument-first |
| PARITY-POINT-SPRITE-SHAPE-RESIDUALS | Item 11 | Residual 2 VERIFIED (WGSL self-documented); residual 1 drift re-reproduce-first |
| NEW-WEBGPU-CELESTIAL-RETAINED-RESOURCES | Item 12 | VERIFIED (all churn sites read at HEAD) |
| NEW-WEBGPU-STARFIELD-SINGLE-SUBMISSION | Item 13 | VERIFIED statically (double-draw + inverted-ordering comment); runtime instrumentation = slice 1 by design |
