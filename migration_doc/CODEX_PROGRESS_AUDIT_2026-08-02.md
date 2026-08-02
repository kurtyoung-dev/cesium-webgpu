# Codex progress audit — Batches 772–818

**Audit date:** 2026-08-02  
**Audited tip:** `2805e7d36e` (Batch 818), with `main == origin/main` and the
fork zero commits behind upstream after the Cesium 1.144 merge.  
**Scope:** work landed after the 2026-07-31 Codex stopping point, the current
campaign ledgers, and the execution claims in
[`HANDOFF_2026-08-02_CODEX_NEXT_WAVE.md`](HANDOFF_2026-08-02_CODEX_NEXT_WAVE.md).

## Repository and verification truth

- The worktree was clean at audit start and the only local branch/worktree was
  `main`.
- Contrary to the handoff header, two preserved safety stashes exist:
  `codex-safety-s5-v8-main-2026-07-28T1142` and
  `codex-safety-s5-v7-main-2026-07-26T1048`. They were not inspected, applied,
  dropped, or rewritten.
- The binding package TypeScript gate passed:
  `npm exec --package=typescript --offline -- tsc --project
  packages/engine/tsconfig.json --noEmit`.
- The complete pure-Node visual-regression spec glob passed with exit code 0:
  `node --test Tools/visual-regression/*.spec.mjs`.
- `git fsck --connectivity-only` found no repository corruption. Dangling
  objects are expected given the preserved stashes and prior worktrees.
- The existing dev server answered HTTP 200 at the CesiumViewer route.

These gates establish a sound starting point. They do not certify moving-camera
pixels, device recovery, or performance.

### Current unstaged worktree verification update

- Engine-package TypeScript passes after the recovery, Moon, snap, projection,
  and weather-tail slices.
- `npx gulp build` passes, including GLSL/WGSL conversion, TypeScript, and all
  unminified bundles.
- `git diff --check` passes.
- Focused snap/projection Node is 69/69; focused Moon cache/policy/lifecycle is
  75/75; the complete visual-regression Node fleet is 1,227/1,227; weather
  rendered-tail policy/mutation is 10/10.
- Exact nonzero Chrome-for-Testing/Jasmine lanes now pass: WebGL/WebGPU Moon
  lifecycle 8/8 + 9/9, Scene/CesiumWidget teardown 1/1 each, and device pool/
  loss 4/4 + 10/10. The earlier 0-spec `EdgeHeadlessCI` launch remains recorded
  only as a tooling failure, not as evidence.
- Browser evidence instead comes from purpose-built Node/Playwright Edge
  probes. `probe-snap-multifrustum.mjs` passes both backends with TAA and clean
  error arrays; `probe-weather-regional-tails.mjs` passes WebGPU cyclic seam/
  far controls and WebGL billboard/no-volumetric controls with ten PNGs read.

## What genuinely landed

The architecture moved forward substantially after Batch 771:

- Batches 772–781 landed the prior Codex C11 wave: WebGL asynchronous shader
  lifecycle work, shadow/RTE corrections, reduced low-limit globe layouts,
  frame-encoder/effects seams, exact-device immutable model pools, bounded
  post-process caches, backend-neutral final model realization, and the first
  representative performance/residency harness.
- Batch 784 added ordinary resident ready-tile count plus two order-invariant
  identity hashes, rejects mismatched/incomplete ready sets, and attributes the
  first divergent segment/tile. This is already the “smallest safe C11-205
  slice” that the handoff incorrectly lists as next work.
- Batch 789 added the bounded environment-refresh scheduler and persistent
  generation-keyed target pool. It prevents unbounded same-frame refresh bursts
  without treating visibility as authority to drop work.
- Batches 791 and 800 moved main model camera and per-model/view light data onto
  dynamic-offset arenas, including 2D/IDL and capture/RTE routing.
- Batches 785, 797, and 798 improved cloud-shadow RTE ownership, global weather
  seams, regional/no-data packing, and low-coverage cloud visibility.
- Batches 786 and 807 corrected the sky aureole's astronomical-Sun anchoring and
  the globe's shared log-depth activation gate.
- Batches 799, 801, 804, 811, and 812 added model topology parity, a 2K lunar
  albedo, a deeper star catalogue, LOLA lunar normals on both backends, and the
  first WebGPU `Scene.snap` surface implementation.
- Batch 803 harvested the safe value from all parked worktrees and completed the
  known pipeline-key alias fixes/diagnostics. The repository is now main-only.

No audit evidence supports reverting these families wholesale. The correct
course is to close the bounded lifecycle, allocation, and motion gaps below.

## Findings, ranked

### 1. Bug 814.1 was an instrument false positive after a real contract fix

Batch 816 fixed the real stash-vs-live-frustum producer-contract violation. The
reported residual was not a second renderer mechanism: the probe inherited
online terrain (so +5 m above the ellipsoid can be below real terrain) and
expected underground terrain occlusion while leaving
`globe.depthTestAgainstTerrain` false (which deliberately clears globe depth).
With offline ellipsoid terrain, terrain depth testing enabled, and
`clearGlobeDepth=false` asserted, the full gate passes at 0.996 foreground
ON/OFF (0.974 green-only because the colocated magenta reference overwrites
green) with zero underground pixels and zero errors. Runtime telemetry also proves both
flat-Mat tails and all 19 globe tails are bit-identical in the accepted frame.

### 2. C11-194 exact-tuple recovery is fixed; broader recovery is incomplete

At audited Batch 818, `WebGPUModelRenderer` initialized a model cache and
pipeline cache once but did not validate them against the current exact
`GPUDevice` and resource generation before subsequent updates/readiness polls.
A live standalone or tile-owned model could retain lost-device buffers, bind
groups, pipelines, and shared-resource leases. This was a correctness
prerequisite, not merely an optimization.

The first worktree attempt correctly added exact tuple ownership, transactional
shared-default construction, asynchronous publication guards, and a common
best-effort disposer, but also added global retained texture-source replay. An
independent review rejected that replay design: it retained mutable decoded
sources without a byte bound, compacted overlapping writes out of chronological
order, could lose recovered mip jobs during invalidation, and did not recover
nested IBL/clipping resources.

The narrowed unstaged slice has now passed independent review. Model caches,
shared resources, pipeline leases, compatibility textures, compressed uploads,
and environment-pool handles are keyed by the exact `(GPUDevice,
resourceGeneration)` tuple. Stale compatibility textures null-drop; candidate
creation and per-feature-pick replacement are transactional; late pipeline and
error-scope callbacks carry lifecycle epochs; and teardown detaches then drains
all model, registry, compatibility, and pooled owners even when an old native
throws. Focused recovery/pool contracts pass 19/19 + 45/45 and package
TypeScript is green. Higher-level owners must still re-realize a dropped
compatibility texture. Nested IBL/clipping recovery and live replacement-device
browser evidence remain open, so C11-194 is correctly still partial.

### 3. C11-202's bounded pick/edge legacy tax is removed; the row remains partial

The audit correctly found that the native descriptor path avoided final WebGL
program/vertex-array/DrawCommand realization but still scheduled the legacy
Picking and EdgeVisibility/EdgeDetection stages before WebGPU created native
equivalents. The independently reviewed worktree correction passes an explicit
native-descriptor mode through `ModelSceneGraph`/`ModelRuntimePrimitive`. It
retains shared geometry, material, feature-ID, metadata, lighting, alpha, and
statistics derivation plus `frameState.edgeVisibilityRequested`, while skipping
only the three legacy GPU-realization stages. The default WebGL path is
unchanged, and the native renderer's independent pick/edge realization plus
fallback rebuild path were inspected. Focused Node contracts are 3/3 with
Jasmine source coverage.

This is a bounded architecture fix, not a timing claim or row closure. The
moving route still must measure its allocation/CPU effect; remaining
legacy-only objects/stages need an audit; the native edge emitter's RTE gap is
open; and future selected-feature post-processing must consume renderer-owned
native IDs instead of recreating legacy `Model.pickIds`.

### 4. The C11-195 arena trades GPU writes for unmeasured JS churn

The camera/light arena removes repeated `queue.writeBuffer` work, which is a
sound direction. Its hot path currently constructs template-string bind-group
keys and several short dynamic-offset arrays per acquire/emission/clone. Until a
moving-route allocation/GC profile is run, the net CPU claim is not certified.
Retaining reusable offset records or identity-keying page tuples is the likely
fix; removing the arena is not.

The audit also found a multi-context ownership mismatch. The mutable arena is
stored in the device-shared immutable-resource pool, but each context owns a
different uniform-ring allocator. When two contexts share one pooled
`GPUDevice` (including the split viewer), alternating updates swap allocator
identity and `beginFrame` clears the arena's entire bind-group cache each time.
That defeats convergence and can turn the intended cache into cross-context
create/clear churn. The correction must make the mutable arena context-owned or
partition its lanes by allocator/context identity; it must not duplicate the
immutable group-0 layout or remove dynamic offsets.

### 5. C11-193 is a bounded scheduler, not yet a shared submission architecture

Each manager still creates and submits its own IBL encoding scope. The scheduler
bounds when managers run and the target pool reduces resource churn, but the
claimed shared encoder/submission portion remains open. The audit also found
that `_grant` set `lastGrantFrameId` before a real submit even though the module
contract says failed encodes must not affect the fairness anchor. The current
worktree correction moves that bookkeeping solely to `noteRefreshSubmitted`;
this closes the fairness defect, not the shared-submission architecture.

### 6. `Scene.snap` surface lifecycle and multi-frustum correctness are green; broader architecture remains partial

The audit found that the synchronous path copied before `pickEnd` submitted the
new snap render and later reconstructed cached eye depth with the current camera.
The worktree correction now records sync and async copies on the active pick
encoder, begins mapping only after submission, and atomically pairs pixels with
immutable camera/frustum/viewport plus exact integer drawing-buffer sample
provenance. It also fixes top-down WebGPU Y, CSS/DPR conversion, bounded
frame/query age, small-overlap cursor remapping, split-viewport payload loads,
exception-safe cleanup, and the permanent post-first-snap ordinary-frame
derived-command allocation tax. The follow-on WebGPU multi-frustum correction
uses one query-scissored zero-payload triangle inside the existing payload pass
where the current slice depth is non-clear. It adds no pass, texture, bind
group, encoder, or submission; reset-removal/depth-compare mutations and a
loaded split-viewport continuation are covered. WebGL now uses its own
snapless-occluder derived command to zero the nearer winner without another
pass. Renderer-neutral frustum math handles asymmetric perspective and
orthographic planes, direct off-centre frusta, viewport/DPR/Y mapping, and
independent aperture dimensions. WebGPU provenance includes the effective far
plane, preventing far-only projection changes from accepting stale bytes. The
combined snap/projection Node lane is 69/69 and both reviews are GO.

The target-cost audit rejected query-sized rendering because it would change
normal projection/culling/screen-space semantics. The safe WebGPU payload
conversion from RGBA32F to exact RG32Uint preserves the u32 key and f32 eye
depth, packs the edge flag in depth's clear sign bit, saves 63.28 MiB at 4K,
and reduces the full RGBA8 + RG32Uint + D24S8 target set from 189.84 to 126.56
MiB. Snap's unused occluder color store is discarded, ordinary picking is
unchanged, and a 25x25 staging row falls from 512 to 256 aligned bytes.

The rebuilt real-Edge multi-frustum probe is green on WebGL and WebGPU with TAA
enabled: far model visible, nearer object in a different slice suppresses it,
far model returns, and device/console/page errors are empty. C11-212 remains
partial for forced SCENE2D depth provenance; genuinely moving camera/cursor
coverage across DPR/asymmetric projection/split viewport/edge clipping/RTE;
even-aperture and WebGL logical-padding fixes; possible shared transient-target
pooling; edge payloads; classification checkpoints; and broader producers.

### 7. Moon cross-backend lifecycle is complete and independently certified

The audited Batch-818 WebGPU callbacks could publish into an orphaned or
superseded cache after destroy, recovery, or URL/variant change. The bounded L2
worktree slice now closes that path with exact owner/pair/URL/channel serial and
backend/context/device/resourceGeneration/cache identity, independent channels,
pre/post-finalize tuple guards, exact-once candidate/source ownership,
transactional bundle publication/retirement, placeholder rollback, detach-first
teardown, and render wakeups. Independent review found one finalize-order
blocker and confirmed its pre/post guard fix. The final focused Moon lifecycle
lane is 75/75 and the complete visual-regression fleet is 1,227/1,227.

C12-35 now passes all L0-L5 gates. L1b integrates the same renderer-neutral
leases into frame-owned WebGL realization; matching normal resources remain
resident but unbound while relief is off. Diagnostics are frozen, exact-pair
aware, resource-free, and WebGPU steady-state reconciliation is allocation-
free. Scene now destroys Moon deterministically, and intentional pooled/context
GPUDevice teardown no longer emits false loss errors. The schema-v2 real Edge
gate proves source coalescing, explicit-render wake, cancellation, visible
stable pixels, queue drain, pending-owner destruction, zero surviving leases,
and zero page/console/GPU faults. Independent review is GO. Moving-camera
seam/shimmer is explicitly reassigned to C12-33's mip/sampler/derivative gate,
so C12-33 is unblocked.

### 8. CoverageJSON antimeridian parsing and rendered regional tails are green in the worktree

The parser reduces longitudes to ordinary min/max. An axis such as
`170, ..., -170` becomes an almost-global span instead of a wrapped 20-degree
region. The packer itself already had a wrapped-bound contract. The worktree
correction unwraps the source axis before deriving orientation and bounds and
adds a focused 7/7 parser/mutation lane. The persistent rendered-tail policy
lane is 10/10. A rebuilt Edge run is green: WebGPU observes both seam sides,
has continuous halves with no centre wall or duplicate band, and keeps the far
view byte-identical to procedural fill; WebGL preserves a non-vacuous billboard
control byte-for-byte and publishes zero volumetric work. Pack statistics match
the same evaluation and device/console/page errors are empty. All ten PNGs were
reviewed. C13-08/Gate B remain IN PROGRESS / NO-GO for complete promotion: the
worktree correction is ready for orchestrator landing review, but canonical
COMPLETE promotion additionally requires the seven post-packer-change browser
regression re-runs (the five global ingest/source/channel/time probes, the
seam/pole probe, and the intended-behaviour METAR probe) — landing review alone
cannot promote.

### 9. Smaller honest issues

- `WebGPUDrawCommand.clone()` omits indirect-draw and translucent-
  classification fields. No current production caller of
  `WebGPUDerivedCommand.deriveCommand()` was found, so this is a latent contract
  gap, not evidence of a current regression.
- C11-90's topology implementation has strong source tests but still owes its
  browser Sandcastle gate; the two-index line-loop edge case also merits a
  translucent/additive parity check.
- The WebGPU sun-shadow-on brightening recorded in Batch 805 remains an honest
  open investigation. The deliberately red star-sprite/cubemap check is now
  classified as the valid incomplete-C12-11 seam signal under already-ratified
  DR-01, not a new design question or authority to remove the catalog.

### 10. Batch 816 added an avoidable per-command logarithm

The stash-first primitive fix initially recalculated
`1 / Math.log2(far - near + 1)` inside `writeLogDepthTail` for every flat, lit,
pick, and polyline primitive camera pack even though the full-camera encode
range is frame-stable. That is a plausible CPU hot-path regression in
primitive-heavy scenes. The corrective worktree slice now publishes
`_logDepthEncodeFactor` once beside `_logDepthEncodeNearFar`; primitive packs
reuse the finite positive value and retain the old calculation only as an
early-frame/legacy-test fallback. This changes no depth curve or feature and is
behaviorally pinned by the 12/12 stash contract, including a test that makes
`Math.log2` throw during a factor-backed pack.

## Corrective slices completed during this audit

These changes are in the current unstaged worktree, not in the audited Batch
818 tip:

- The C11-193 fairness anchor now advances only in
  `noteRefreshSubmitted`; a grant whose encode fails no longer yields next
  frame as though it submitted. The focused environment scheduler/pool lane is
  43/43. Shared encoder/submission and moving-browser credit remain open.
- CoverageJSON cyclic longitude axes are unwrapped before both orientation and
  bounds derivation. Forward/reverse seam encodings canonicalize to the same
  regional interval while ordinary/global axes retain their prior bytes. The
  focused parser lane is 7/7; the persistent rendered-tail lane is 10/10. A
  rebuilt Edge run plus ten-image review closes the antimeridian/WebGL tail in
  the worktree without a renderer feature change.
- The corrected deterministic log-depth probe contract, frame-stable encode
  factor, and removal of temporary renderer telemetry are complete without a
  shader or feature change.
- C11-212 copy submission, immutable view/sample provenance, CSS/DPR/Y mapping,
  bounded cache reuse, split-viewport load behavior, cleanup, snap-pass-only
  command allocation, renderer-neutral off-centre projection math, far-plane
  stale rejection, WebGPU multi-frustum reset, and WebGL occluder erase are
  corrected with 69/69 focused Node contracts. Exact RG32Uint payload reduces
  4K targets by 63.28 MiB and the real-Edge two-frustum gate passes both
  backends. The remaining SCENE2D, genuinely moving-view, aperture/edge-clipping,
  transient-pool, edge, classification, and producer gates keep the row partial.
- C12-35 is complete and independently GO: focused Moon Node 75/75, full Node
  1,227/1,227, exact lifecycle Jasmine 8/8 + 9/9, type/build green, and strict
  schema-v2 Edge PASS with teardown/pixel/fault evidence. C12-33 is unblocked.
- C12-33 is implemented and independently code-reviewed GO but remains an
  acceptance task. WebGL Moon-local and frame-owned WebGPU mip realization,
  seam-unwrapped pre-discard gradients, independent albedo/normal LOD, legal
  WebGL1 fallback, exact queue ownership/retry, and transactional destruction
  are in the worktree. The slice also removed an EXISTING Session-31
  optimization — the WeakMap-keyed `_bindGroupCache` in
  `WebGPUMipmapGenerator.ts` (commit `321bc5a360`) — which was layer-blind and
  under the new layered mip path would alias face 0's bind group across cube
  faces; one-shot streamed textures would additionally retain
  `O(layers × mips)` objects. The removal stands; this bullet's earlier
  wording calling it a merely "proposed" cache was inaccurate.
  Type/build/diff/format and focused Moon+queue Node
  pass 171/171. Fresh Jasmine and the paired/calibrated real-Edge moving lane
  remain unexecuted, so C12-33 is not COMPLETE.
- The bounded C11-194 exact-tuple recovery/disposal slice is independently
  reviewed GO. It includes transactional compressed/fallback/per-feature-pick
  uploads, lifecycle-epoch async publication, detach-first drain-all teardown,
  and same-generation/different-device pool rejection. It deliberately retains
  no decoded-source replay journal; the higher-level re-upload, nested-resource,
  and live-device gates above remain open.
- The bounded C11-205 stable request-ledger slice is reviewed GO in the
  worktree. Per-tile request and attempt serials survive scheduling deferral;
  effective cancellation, reissue, settlement, readiness, URL, chronology, and
  response-byte evidence are normalized into stable cross-leg identities.
  Empty, truncated, serial-gap, orphan, missing-URL, unknown-byte, and
  unsupported multiple-content evidence fails closed. A late cancellation
  followed by accepted content remains a completed request rather than a false
  cancelled settlement. Focused request/lifecycle contracts pass 77/77 and the
  preserved 2026-07-31 artifact
  (`Tools/visual-regression/output/performance/campaign11-c11-205-lifecycle-attribution-2026-07-31.json`,
  per-leg `tilesetLifecycleDiagnostics`) still normalizes to 15 requests, zero
  open, and the same `27b1e7d0-dd48cecb` signature on both legs — re-verified
  against the retained JSON during this correction pass. The independently
  reviewed versioned-state continuation is also GO (7/7 focused contracts):
  immutable tileset packets remove sixteen steady per-model setter calls while
  retaining same-tile event mutation semantics and all per-tile matrix,
  clipping, and environment updates. Null/undefined light state cannot churn
  packets and an idle hidden tileset pays no processing comparison. At this v1
  checkpoint, model transitions and multiple-content inner requests were the
  next instrumentation gap; the schema-v2 continuation below closes that gap
  synthetically while browser/resident proof remains open.
- The C11-205 schema-v2 continuation is independently reviewed GO. It records
  exact multiple-content slot/group membership, cancellation/reissue/discard/
  failure outcomes, direct-model and model/content/tile-ready ordering, stale
  generations, numeric slot order beyond ten entries, and observer teardown
  freeze. Adversarial focused coverage is 57/57 and all 56 legacy performance
  contracts still pass (113/113 combined). A real multiple-content Edge fixture
  and resident certification remain open. The accompanying state-packet module
  now supplies the default export required by the generated barrel while
  preserving its named exports; package and top-level builds pass.
- The C11-202 native descriptor path now skips only legacy pick/edge GPU stages
  while retaining shared derivation and the Scene edge-MRT demand signal.
  Independent review and focused 3/3 contracts are GO; WebGL is unchanged.
  Moving-route attribution, remaining frontend audit, native edge RTE, and
  browser/fallback coverage remain open.
- Campaign-number drift is corrected: Dynamic Ocean & Wind remains Campaign 14
  under O5; Aurora + Space Weather is a research-verified, unlaunched Campaign
  15 with `C15-00` complete and `C15-01..08` pending.

## Ledger corrections required

- `C11-205`: Batch 784 already completed ordinary ready-set identity and
  rejection. Stable cross-leg single-content chronology/serials and the
  bounded versioned-state packet (7/7) are green. The reviewed schema-v2
  continuation now covers multiple-content inner slots plus readiness and
  cancellation/reissue ordering (57/57 focused; 56/56 legacy preserved).
  The row remains partial for a real multiple-content Edge fixture, focused
  browser mutation/performance evidence, and a fresh resident browser run.
- `C11-195`: main camera and model/view light dynamic offsets landed in Batches
  791/800. Measurement, allocation trimming, recovery, and broader multi-view
  certification remain open.
- `C11-212`: fixed-camera surface-hit verification passed and the worktree now
  fixes submission ordering, motion provenance, both backend multi-frustum
  erasure, renderer-neutral projection math, and WebGPU payload cost. The
  real-GPU two-frustum gate passes. SCENE2D, moving-view/aperture/edge-clipping,
  shared transient pooling, and edge/classification/producer coverage remain;
  it is partial, not fully certified.
- `C13-08`: the WebGPU regional-placement pixel lane passed. The
  parser's cyclic-axis correction and focused Node/mutation lane are now in the
  worktree. The rendered antimeridian-straddle and WebGL regression lanes now
  pass in rebuilt Edge and all ten PNGs are reviewed. C13-08/Gate B remain
  IN PROGRESS / NO-GO for complete promotion: the worktree correction awaits
  orchestrator landing review, and canonical COMPLETE promotion additionally
  requires the seven post-packer-change browser regression re-runs the queue
  checklist demands — landing review alone cannot promote. C13-41 unblocks
  only at that promotion boundary.
- `C12-35`: complete / independently GO in the worktree; C12-33 is next.
- `C12-24/25`: implementation and focused browser evidence landed; their older
  “pending landing/Edge” headers are historical prose.
- Bug 814.1 is closed as an instrument false positive after retaining the real
  Batch 816 producer-contract fix; the corrected deterministic gate is green.

## Corrected execution order

1. **DONE for the bounded slice:** stabilize and independently review the
   narrowed C11-194 exact-device/resource-generation cache-rejection/disposal
   work without a global decoded texture replay journal. Keep its broader row
   partial for the listed browser and higher-level owners.
2. **DONE for the bounded C11-212 slice:** both-backend multi-frustum correction,
   projection math, compact payload, and real-Edge gate. Return later for
   SCENE2D/moving-view/aperture coverage, then edge parity.
3. **DONE in worktree / landing review owed:** C13-08 rendered tails. Promote
   Gate B and unblock C13-41 only at landing.
4. **DONE for the bounded slices:** C11-205's stable cross-leg ledger,
   schema-v2 multiple-content/readiness instrumentation, and versioned model-
   state packet. Do not duplicate Batch 784's ready-set work; continue with a
   real multiple-content Edge fixture, focused browser mutation/performance,
   and the resident browser gate.
5. **DONE:** C12-35 L0-L5. Start C12-33 Moon mips, retain every lifecycle gate,
   and require moving seam/limb/close/shimmer evidence before the 2K rebake.
6. **DONE for the bounded C11-202 pick/edge tax slice:** native descriptors no
   longer run legacy-only pick/edge stages. Measure it on the moving route,
   audit the remaining frontend tax/RTE/browser gates, then trim C11-195 arena
   allocations.
7. Complete shared environment submission and the remaining campaign wave
   bodies in their canonical queues.

Every step retains existing WebGL/WebGPU features. Performance credit requires
the canonical Node/Edge moving-camera altitude route plus allocation and pixel
evidence; an idle soak is not an acceptable FPS measurement.
