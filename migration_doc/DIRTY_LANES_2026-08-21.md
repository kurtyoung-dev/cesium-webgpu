# Dirty-lane register — 2026-08-21

**What this is.** The complete map of the uncommitted multi-lane work in the shared `main`
worktree, as attributed on 2026-08-20/21 and updated after the overnight landings
(Batches 1070–1085). One section per surviving lane: what it is, its files, what gates it,
and its disposition under the 2026-08-21 provisional rulings
([MAINTAINER_RULINGS_2026-08-21.md](MAINTAINER_RULINGS_2026-08-21.md)). The owning campaign
queues remain the sole status authorities; this register only says *what is in the tree and
why it has not landed*.

**Backup.** The full pre-session dirty state is banked as a replay-verified patch bundle at
`f:/Dev/GH/cesium-webgpu-backups/main-dirty-2026-08-20T2137` (tracked patch + untracked
archive, verified in both directions). Refresh the backup before any operation that
touches these files.

**Landed and removed from this register (2026-08-20/21):** the C11-210 compute-command
lane (Batch 1071), the C11-196/202 model-pick unit (1072), the C11-213 vector slice
(1073), the C11-140 probe + artifact (1074), picking S0/S1 (1075), the Matrix/TS-cast
micro-lane (1070), the spec-limits refresh (in 1070/1073), and the landed-lane doc
sections (1078). The register below is what remains.

---

## Lane F — C18-P dedicated point-cloud renderer / EDL / GPU-LOD / Draco

The largest lane (~4,500 lines): `WebGPUPointCloudRenderer.ts` (+1,170),
`WebGPUPointCloudEyeDomeLighting.ts` (+1,430), `WebGPUPointCloudLODProcessor.ts`,
`WebGPUDecoupledScan.ts`, the frustum-loop/3D-tile-pass EDL wiring
(`WebGPUSceneRendererFrustumLoop.ts`, `WebGPUSceneRenderer3DTilePasses.ts`),
`WebGPUFeatureRenderers.ts`, the point-cloud hunks of `WebGPUContext.ts`, four untracked
runtime modules (`WebGPUPointCloudEDLState.js`, `WebGPUPointCloudLodLocalFrame.js`,
`WebGPUPointCloudRteHistory.js`, `PointCloudAttributeUtils.js`), `PointCloud.js` (+161,
Draco CPU stage), `Cesium3DTileset.js` / `TimeDynamicPointCloud.js` (EDL destroy), four
WGSL shaders (`PointCloudEDL`, `PointCloudEDLDepth`, `PointCloudLOD`,
`PointCloudLODScanCompact`), specs/probes (`WebGPUPointCloudLODProcessorSpec.js`,
`probe-pointcloud-lod.mjs`, `probe-pointcloud-gpulod-scene-wiring.mjs`,
`probe-timedynamic-pointcloud-load.mjs`, shared `pointcloud-voxel-public-correctness.spec.mjs`),
and the C18 queue row updates (C18-P2/P5 → IN FLIGHT) plus the `FEATURE_INVENTORY.md`
PNTS-retention entry.

**Status:** implementation locally complete per the queue's own stamps; **terminal
browser gates owed** (per-format colour fixtures + negative controls for C18-P2; a real
compressed Draco ready/render gate for C18-P5). **Gate:** machine lane, not a ruling.
**Known cross-lane debt:** one unclassified `enabled !== false` convention hit in
`WebGPUPointCloudEyeDomeLighting.ts` that the landed celestial-gate class audit names —
classify it at this lane's landing.

## Lane G — C18-V voxel readiness / pick lifecycle

`WebGPUSceneRendererPickPass.ts` (`skippedWrongVoxelOwner` census, `pickClearValue`,
clear-on-zero-frustums), `probe-voxel-parity.mjs` edits, the shared public-correctness
spec, C18 queue row text. **Status:** Batch 1028 landed the core; **browser closure open —
the C18-V2 certifying-scene runs are executing in the T0 frozen-build program right now.**
**Gate:** machine lane (in progress). **Linkage proven 2026-08-21 (Batch 1091):** the C11-13 pick-pipeline spec’s selected-owner dispatch test is red at committed tip (the consumer was never landed) and green in this dirty tree — lane G’s `skippedWrongVoxelOwner` census IS the missing consumer, and the T0 battery’s cell-pick off-pixel red is the same defect’s pixel face. Landing lane G closes both. **LANDED Batch 1097 (2026-08-21): engine + parity-probe halves, discriminator-certified (identity spec 9/9, selected-owner spec 5/5, parity probe PASS at tip+G). NARROWED REMAINDER, still open: the cell-pick probe’s off-geometry pixels INSIDE an active frustum still read 0xFFFFFFFF on WebGPU — lane G’s clear covers the zero-frustum path only; filed as the row’s remaining defect with this sharper premise. The shared `pointcloud-voxel-public-correctness.spec.mjs` fails without lane F’s point-cloud half and stays with lane F.**

## Lane H — C13 cloud: C13-09 sentinel + C13-16 U2 morphology

`WebGPUCloudReconstructionAttachments.ts` (zero-alpha → −1 sentinel),
`CloudReconstructionAttachments.wgsl`, `ProceduralClouds.wgsl` (+91, U2 constant-pivot
carve-before-erosion), seven cloud spec/model files, the U2 interleaved-A/B perf harness
(`cloud-u2-perf-evidence.*`, `probe-cloud-u2-perf.mjs`), C13 queue updates including the
new `C13-16-EROSION-STRENGTH-RANGE-CONTRACT` row. **Status:** model gates green (42/42
attachment contracts); **visual acceptance + the mandatory interleaved perf A/B owed.**
**Gate:** machine lane; C13 is orchestrator-owned by the 2026-07-24 executor ruling —
never a Sol dispatch.

## Lane I — C12-29 S5 replacement-device harness

`probe-c12-29-s5-replacement-device.mjs` (+3,341), `lib/c12-29-s5-replacement-device-gate.mjs`
(+1,350, v8 schema), its spec (+2,460), untracked capture lib. **Status:** harness repair
after the first shard's operational ERROR; no product verdict claimed. **Gates:** the S5
fleet-contract repair (fix SOL-5 — watchdogs/browser leaks/exit semantics, a work item)
and the `R-2026-08-18-27` charter tiering (ruled). **Reconciliation RESOLVED 2026-08-21:** the `cesium-webgpu-cert-s5-3cbb82885fc7`
clone's HEAD (034c7f74d0) is an ancestor of origin/main — everything it holds already
landed; this tree's dirty copies are strictly newer repair work and supersede it. The
clone is retention-only until this lane lands.
**LANDED (Batch 1104, 2026-08-21):** harness repair + capture lib + stale allowlist
row removal, station-3 reviewed PASS-WITH-FIXES with all required fixes applied at
integration (schema literals pinned; uncaught throws exit ERROR 2; cleanup
incompleteness reclassified STRUCTURAL per R-2026-08-18-27's principle). Fleet 62/62
in the lane clone; gate spec 36/36 in the freshly built landing tree. The S5
certification RUN itself remains owed on the machine lane.

## Lane J — C12-11 star-catalog certification harness

`probe-stars-catalog.mjs` (+1,853: UUID-bound write-once reports, watchdog, checks A–G),
untracked gate lib + spec. **Status:** harness rebuild; no verdict claimed anywhere.
**Gate:** the C12-11 repair packet itself is RETURNED TO HELD on the queue (ten
architecture-level blockers); the harness can land once reviewed, the row stays held.

## Lane K — Celestial G3 gate (source/lifecycle/residency preflight)

`lib/celestial-g3-gate.mjs` (+312), `celestial-g3-gate.spec.mjs` (+898),
`probe-celestial-gates.mjs`. **Status:** strengthens the gate (runtime policy / device /
lifecycle / residency lies → STRUCTURAL). **Gates:** reconcile with `R-2026-08-14-2`
before any 4096-only packet is read as certification authority (work item), and the G3
asset work itself is the ruled-but-manual maintainer session (4096 bake + HDR check).
Related: fix SOL-2 must land before any G3 re-run is read as certifying.
**LANDED (Batch 1107, 2026-08-21):** station-3 PASS-WITH-FIXES - the lane IS the
SOL-2 fix (the unratified 4096-only early-return is removed, the ratified >=2700
bar returns as an operative FAIL criterion, both enshrined failures-empty mutants
repaired into their inverses, the Batch-934 RED preserved un-re-measured); 4096
stays a reported non-certifying upgrade preference. Reviewer fix applied and
inertness-proven at integration: the forged-residency direction (resident claimed,
VRAM ledger zero) joins the four-lie mutant sweep and reds when its clause is made
inert. House-scale disposition recorded: the spec (3,166 lines) crosses the 3,156
ratchet whose tooling is unimplemented; the probe (4,045) carried its overage in.
Remaining for G3 itself: the ruled MANUAL maintainer session (4096 bake + HDR
check) - not this lane's claim.

## Lane L — Moon-mip LOD / motion certification

`moon-mip-lod-shader.spec.mjs`, `moon-mip-motion-certification.spec.mjs`,
`moon-mip-motion-probe-contract.spec.mjs`, `lib/moon-mip-motion-certification.mjs`,
`probe-moon-mip-motion-edge.mjs`. **Status:** implements the per-`@fragment` restructure
that ruling-audit finding **R-17** proves partially unsatisfiable (the
`textureSampleGrad` calls live in `computeEllipsoidColor`, outside both fragment bodies).
**Disposition under the provisional rulings: the packet's R-17 recommendation is adopted —
amend the clause order to target the shared function; a repair package executes it, then
this lane lands.** Fix SOL-10 (contract re-scope) rides the same repair.
**LANDED whole (Batches 1087 + 1100, 2026-08-21):** the R-17 repair landed as the
lod-shader spec re-anchor (1087); the remaining four files landed together with the
re-scoped custody hash (1100) — `preregistrationSha256` binds the ACTUAL frozen
sign-test design (`sign-test-v1`) after an accepted worker refutation proved the ruled
sixteen-cell ratio design does not exist in shipped source; the discrepancy is filed
verbatim in the probe and every report for the maintainer. Suites 23/23 + 20/20 re-run
in the landing tree. Remaining for this lane: only the 2.5-hour Edge ten-run set,
queued behind the design ruling — no dirty files.

## Lane M — C13-41 eclipse cloud-response gate

`lib/eclipse-cloud-response-gate.mjs` (+625), `eclipse-cloud-response-gate.spec.mjs`
(+1,215), `probe-eclipse-cloud-response.mjs`, untracked `finding-ownership-audit.spec.mjs`
(shared with lane P), `CAMPAIGN_STATE.md` C13-41 REOPENED corrections. **Status:** the
row is REOPENED by `R-2026-08-14-1`; the FAIL-capability change is authorized by
`R-2026-08-18-27` **with the audit's prerequisite ordering adopted: the SOL-4 banked
refresh-cost measurement must land first** (machine lane, queued). **Disposition:** the
packet's R-7 recommendation (closure record as schema migration) is provisionally adopted
and unblocks the ownership-audit spec's schema.

**LANDED with lane N (Batch 1105, 2026-08-21) as one linked landing group** - the two
lanes' specs are mutually anchored, so neither could land alone; station-3 reviewed
PASS-WITH-FIXES (ruling-conformant: refreshCostMeasured keeps its eligibility role, no
FAIL path on refresh cost exists structurally). finding-ownership-audit.spec.mjs is
HELD OUT (red until the C18 FEATURE_INVENTORY edit lands); the CAMPAIGN_STATE
corrections stay with lane P. SOL-4's banked refresh-cost measurement is now
UNBLOCKED on the machine lane.

## Lane N — Weather capture doctrine (async immutable capture)

`lib/weather-probe-pinning.mjs` (async `capture()` through the canonical
`same-task-capture`), untracked `lib/weather-capture-doctrine.mjs` (acorn fail-closed
census), `weather-probe-headroom.spec.mjs` (+1,130), six weather probes,
`probe-cloud-shadows-polar.mjs`, shared eclipse files (with lane M). **Disposition under
the provisional rulings: the doctrine's value is ADOPTED — this lane proceeds to review
and landing, with the explicit cost recorded: figures banked from the retired reader are
not comparable, and every consuming probe owes a fresh machine-lane baseline.** The
2026-08-21 harness work (capture-harness F4) implements the same doctrine for the
celestial side.

**LANDED with lane M (Batch 1105, 2026-08-21).** Station-3 FAIL converted: the flagon
probe's re-introduced live reader was rewired through the pinning harness (captures,
warmup renders, and a documentary-PNG-bound brightness metric), making it the census's
ninth consumer; the PARSE_ERROR fail-closed branch is now spec-pinned; the pinning
lib's stale allowlist row retired with the sanctioned-census pin consciously shrunk
51 to 50. ACCEPTED GAP recorded: the weather suspension scan is narrower than the
celestial one (an await nested after the first argument inside the freeze declarator
passes) - canonical-drift guard only. FILED: the census's opt-in-by-import scope
(committed non-consumer weather probes sit in a blind spot; needs an
instrument-shape scope row). Every consuming probe owes a fresh machine-lane
baseline per R-2026-08-21-3.

## Lane P — Governance / integrity-recovery

`Tools/pre-push-guard.mjs` (commit quiet-hours), `Tools/verify-landing-compliance.mjs`
(+3,816) + spec, untracked `Tools/verify-tracked-references.mjs` + spec, the
tooling-catalog generator (+1,618) + spec + **untracked launcher that `package.json`
already references** (the live defect: landing `package.json` without
`Tools/generate-tooling-catalog-launcher.cjs` breaks every fresh clone — they land
together or not at all), `.mcp.json.template`, two `.agents/skills/*` bundles,
`finding-ownership-audit.spec.mjs` (shared with M), and the governance doc set
(`CAMPAIGN_STATE.md`, `ORCHESTRATION_HANDBOOK.md`, `EXECUTOR_LANE_CHARTER_2026-08-14.md`,
`README.md` index, `CODEX_SOL_OPERATING_BRIEF.md`, two untracked audit docs).
**Disposition:** the eleven undispositioned 2026-08-18 amendments are provisionally
adopted per their packet recommendations; this lane lands in slices as each disposition
executes, launcher-with-package.json first, `verify-tracked-references` promoted per the
R-19 residual recommendation.

## Residual strays (attach to a landing or drop deliberately)

- `GlobeTerrain.wgsl` — comment-only em-dash normalization (6 lines); attach anywhere.
- `WebGPUGlobeSurfaceTypes.ts` — one comment correcting `w = reserved` to the HDR-flag
  truth; attach to any globe landing.
- `probe-bloom-parity.mjs`, `probe-point-sprite-shape.mjs` — carry only the `offline=true`
  boot rider; land with the next probe hygiene batch.
- `QUEUE_2026-07-23_CAMPAIGN13.md` / `QUEUE_2026-08-09_CAMPAIGN18.md` /
  `WEBGPU_DEBUGGING_LOG.md` (four excluded blocks) / `NEXT_SESSION_HANDOFF.md` /
  `PICKING_ARCHITECTURE_STATE` cross-refs — doc dirt owned by the lanes above; each block
  lands with its lane per the Batch-1078 exclusion list.
- C11 queue `C11-100` row edit — unattributed (probably C18); excluded from Batch 1078,
  lands when its owner claims it.

## Not in the tree but part of this register's story

- **Picking beyond S0/S1** — no dirty files; gated on the §10 decisions, now provisionally
  ruled (see the rulings file): the identity-plateau predicate is accepted as satisfying
  FAR-107, aperture is an opt-in scene option, frame-age cap 2, declarative prewarm,
  WebGL globe-pick parity, drillPick adopts the predicate. Architecture work resumes
  under those provisional answers.
- **C16-R1** — provisionally ruled as a single code-edit lane over all three
  string-literal marker classes; to be scoped as its own package.
