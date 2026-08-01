# Claude/Fable/Opus Progress Audit — 2026-07-26

**Audit baseline:** `7531209e0f` (before Batch 745)
**Audited landed head:** `e76cfebb7b` (Batch 768)
**Range:** 24 commits, Batches 745–768, 118 files, 40,406 additions,
661 deletions
**In-flight lanes reviewed:** eclipse S6, eclipse S5, pipeline-key aliasing,
environment clear, and globe-pipeline readiness
**Authority:** this is the evidence and continuation review requested after the
Fable 5 / Opus 5.0 work period. It supplements, but does not replace, the live
campaign ledgers.

**2026-07-28 continuation overlay:** S5's selected-terrain transition gate now
passes on WebGL and WebGPU with cross-backend parity, and its current automated
counts are visual **4/4**, protected **145/145**, core **134/134**, recovery
**7/7**, and performance **23/23**. Scene's logical-View preparation now owns
S1/S2/S6 and clears the S5 alias/memo; retained capture, main globe, and pick
each prepare S5 once from their exact owned selection. This overlay supersedes
the audit's 2026-07-26 S5 current-status claims without rewriting its historical
records.

## Executive verdict

The Claude-model period made substantial, useful progress. It did not merely
add documentation:

- both renderers received a physically better Moffat solar-disc profile;
- the WebGPU ocean gained physical-wavelength, RTE-safe wave coordinates and
  pixel-footprint LOD;
- the default WebGPU ocean styling now matches the WebGL-compatible look while
  retaining the enhanced style as an opt-in feature;
- the moon gained physically motivated appearance work without deleting its
  existing feature set;
- the environment-frustum defect caught by the celestial gate was fixed;
- eclipse S1/S2 established backend-neutral state and scene/atmosphere dimming;
- tide datum, equilibrium, and harmonic foundations landed;
- cloud/environment timing instrumentation disproved one proposed optimization
  instead of shipping an unmeasured shortcut;
- Campaign 14 and meshlets were researched and gated rather than started ahead
  of their prerequisites.

The work is not ready to be treated as a fully closed campaign, however. Three
landed regressions were found, and at the audited head none of the four
principal parked changesets had passed its complete runtime exit gate.
Continuation work later on 2026-07-26 moved eclipse observer state to each
logical `View` and integrated an RTE-correct S5 carrier. The real WebGL and
WebGPU browser footprint gate and the later selected-terrain transition gate
now pass. A moving-camera instrumentation lane proved that the remaining WebGL
long tasks are synchronous shader-link completion rather than steady-state S5
fragment work, while its repeated current-build route proves renderer parity,
not an isolated S5 performance delta. NASA-SVS comparison and the full
real-terrain, behavioral pick/capture, dense-timing, custom-ellipsoid,
multi-View/stereo, and genuine replacement-device matrix remain open. Campaign
10 remains the only complete campaign among Campaigns 10–13.

No recommendation in this audit removes or disables a feature for performance.
Every proposed optimization keeps the visual/functional result and requires a
measured feature-preserving gate.

## Landed-change review

### Celestial and eclipse work

The celestial harness, Moffat point-spread function, moon appearance work,
solar-wave work, environment-frustum correction, and eclipse S1/S2 are
directionally correct:

- Moffat solar-disc shaping was implemented for WebGL and WebGPU rather than as
  a one-backend visual fork.
- The moon changes are allocation-free in their direct shader/state plumbing.
- At the audited head, eclipse state was computed in one Scene-owned,
  backend-neutral object and consumed by both renderer paths. The continuation
  described below preserves the backend-neutral computation while moving the
  mutable observer state to each logical `View`.
- The environment-frustum change fixed a real WebGPU sky failure discovered by
  the new gate.
- The S4 investigation correctly retired an unsupported premise instead of
  forcing a cosmetic fix.

The audited view-ownership problem is now structurally corrected in the
shared-tree S5/S6 reconciliation. Each `View` owns stable S1/S2/S5/S6 state;
Scene's logical-View preparation prepares and publishes S1/S2/S6 and clears the
transient S5 alias/memo. Retained capture, main globe, and pick are the sole S5
producers; each prepares once against its exact owned selection before emitting
commands.
That removes one duplicate O(1) broad test for each rendered-globe logical
`View`/frame plus the repeated fit on active intersecting frames. It is a
bounded hot-path cleanup, not an FPS claim. The remaining gate is evidence, not
another Scene-global redesign: prove two scheduled cameras at one simulation
instant, then certify the still-open generic multi-view scheduler and WebGPU
per-eye viewport path. An adjacent temporal-history hazard also remains:
re-entrant `UniformState.update()` calls still advance previous-camera/VP state
per call rather than once per presented View frame.

### Ocean work

The physical-wavelength wave coordinate design is a strong improvement:

- the CPU computes each tile's large phase in f64;
- only a small fractional phase and normalized span are sent to WGSL;
- integer repeat counts keep adjacent tiles and the antimeridian continuous;
- derivatives drive a pixel-footprint LOD/fade rather than merely dropping a
  visible feature at distance;
- the enhanced ocean look remains available, while the default matches the
  WebGL-compatible presentation.

Two implementation problems were found and are corrected in Batch 769:

1. The animation clock wrapped at `16384`, but
   `16384 * {0.008, 0.012, 0.018, 0.03}` is not integral. The resulting
   `fract(time * advection)` discontinuity caused a deterministic global phase
   jump around every 30 minutes at 60 FPS. The period is now `16000`, for which
   every advection component completes an integer number of repeats.
2. The per-tile uniform packer created a local `frac` closure for every tile
   command. The helper is now module-scoped and allocation-free.

The remaining performance question is measured GPU cost. The wave path can use
three gradient samples and anisotropy up to 8, and aggregate gating can leave an
individual zero-weight octave sampled. The correct follow-up is a moving-camera
GPU A/B over water at low, middle, and orbital altitudes, followed by
feature-preserving zero-weight octave elimination only if the timestamps prove
it worthwhile.

### Tide work

The datum probe, equilibrium model, harmonic constituent stack, and explicit
JulianDate noon-origin handling are valuable backend-neutral foundations. The
audit did find a correctness defect in the new predictor:

```js
if (!(amplitude !== 0.0)) {
  // Also skips NaN
}
```

That expression does not skip `NaN`; a one-row station could return
`{ valid: true, heightM: NaN }`. Phase-lag NaNs and truncated parallel arrays
were also unchecked.

Batch 769 corrects the contract:

- missing/truncated arrays are invalid;
- non-finite amplitude/lag rows are ignored;
- an all-missing station stays invalid with finite zero-valued result fields;
- a mixed station uses its remaining finite rows;
- a finite zero-amplitude station remains a valid zero tide.

### Cloud and environment work

The C13 temporal-RTE and IBL relevance work that landed at Batch 754 remains
valid. C13-39's instrumentation and negative verdict are also good engineering:
the proposed shared-module hoist did not justify itself under measurement, so
the optimization was rejected without sacrificing the effect.

The environment-fill timing descriptor currently allocates once per environment
map fill, not once per rendered frame. This is acceptable and is not a current
hot-path blocker.

The continuation audit also found and repaired a recovery-ordering edge in
scene-capture reflections. Device invalidation clears the published globe
capture sources, while dynamic-environment update executes before the globe can
republish them. Capture now has explicit `FAILED`, `SKY_ONLY`, `SUBMITTED`, and
`PARTIAL` results. Only `SUBMITTED` commits successful debounce state;
zero-command replay cannot report success, and failed-attempt throttling is
separate from successful-capture cadence. Hidden/opted-out globe transitions
refill a deliberate sky or model-only state rather than replaying retained
terrain. Provider, selected-resource, and imagery identity changes advance a
content epoch, and mode/source/result discontinuities invalidate temporal
history. The producer requests exactly one follow-up frame when publication
resumes, so request-render mode cannot spin.

The capture-source record is reused. The per-tile publication call now returns
before any record writes after the first matching tile in a frame. The
feature-on producer still performs one allocation-free
O(selected tiles + imagery associations) identity scan per frame; fold that
fingerprint into existing quadtree/resource transitions only after measuring
its cost. The default-off path pays one feature-flag branch and creates no
WeakMap. Current recovery evidence is **7/7 Node** and **11/11 Edge/Karma**; a
real replacement-device browser lane remains open. Calling
`GPUDevice.destroy()` produces terminal loss with `reason === "destroyed"` and
does not prove replacement-device recovery.

## Performance and architecture findings still open

### Highest priority

1. **WebGPU sun texture creation is a synchronous CPU bake.** The first use,
   resize, HDR change, or appearance change can execute a nested JavaScript
   raster loop up to 1024-by-1024, including profile math and optional
   half-float packing. Measure 1080p/4K first-use and resize latency, then move
   generation to a GPU pass or use the smallest CPU source resolution that
   preserves the current HDR/appearance result.

2. **Moon atmospheric in-scatter can run when it cannot contribute.** A moving
   camera/time normally defeats the exact-value cache, and the default-on path
   can perform the extinction plus 16-primary/64-secondary sample work even
   when the moon is offscreen or Earth-occluded. Add measured visibility,
   occlusion, and physically bounded cadence gates; do not turn the feature off.

3. **Celestial ephemerides are recomputed by multiple consumers.** Uniform
   state, Moon, EclipseState, and opt-in tides repeat Sun/Moon/rotation work.
   Introduce a canonical per-frame/per-view celestial ephemeris snapshot once
   the eclipse view-ownership contract is settled.

4. **The central WebGPU render-pipeline cache key is incomplete.** The parked
   patch stamps caller names at known sites, but the cache still omits shader
   module identity, entry points, explicit layout identity, stage constants,
   and several primitive/target/depth/stencil/multisample axes. Its browser
   negative control strips names and probes the real cache even though those
   stripped keys were never inserted, so it cannot certify several marker
   forms. Do not land that changeset as the cache fix. First add fake-device
   collision tests, then use per-device WeakMap identities for shader modules
   and explicit layouts, normalize the effective descriptor, and key every
   structural axis. Keep names as diagnostics, not correctness.

### Secondary, feature-preserving cleanups

- Resolve the globe-water datum before prefetching the 508 KiB geoid asset, so
  `AUTO + EllipsoidTerrainProvider` does not fetch unused data.
- Remove the backend check from `OceanSurfacePrimitive`; request the FFT-ocean
  feature renderer and let an unavailable implementation no-op through the
  existing feature-renderer contract.
- Keep the documented eclipse/LUT gap queued before atmosphere LUTs can become
  default.
- Close both repository tooling gaps after the live worktrees land: tracked
  `.mjs` files are ignored by the repository-wide Prettier policy, while
  `Tools/**` is globally ignored by ESLint. Lint-staged naming `.mjs` does not
  override either ignore policy, so the probe fleet currently has neither
  enforcement lane.
- Decompose oversized probe/implementation files where doing so lowers review
  risk; do not mechanically split code without an ownership boundary.

## In-flight changeset audit

| Lane | Static evidence | Runtime evidence | Required correction |
|---|---:|---|---|
| Eclipse S6 — sky totality | 51/51, including active-ellipsoid geodetic-up and WGSL validation | Both renderers PASS; see debugging log | Integrated before S5; retain its capture and environment-command contracts as regression gates |
| Eclipse S5 — globe umbra | Focused source/math/RTE contract 18/18; visual 4/4; protected 145/145; core 134/134; recovery 7/7; performance 23/23; build and targeted lint green | Both-backend rendered footprint and selected-terrain transition PASS with parity; six-pair moving-camera run PASS on all 12 executions | Finish NASA-SVS comparison, real terrain/exaggeration/fill/provider transitions, behavioral pick/capture, dense timing, custom-ellipsoid runtime, generic multi-View/stereo, and genuine replacement-device recovery; the repeated current-build lane proves parity, not a controlled isolated S5 speedup |
| Pipeline aliasing | 46/46 source inventory only | Parked browser negative control is structurally invalid and unrun | Do not land the caller-name workaround; build a complete central semantic key and real fake-device negative controls |
| Environment clear | 15/15 | Browser/visual gates unrun | Remove per-clear result allocation; settle capture-before/after-scene-pass semantics; document and run probe |
| Globe readiness | 51/51 | Browser probe unrun | Run after relevant pipeline work and add the probe to the debugging guide |

### S6-before-S5 sequencing outcome

S6 owns `Tools/visual-regression/lib/same-task-capture.mjs`, which S5 uses as its
capture authority. S6 landed first and now freezes encoded pixels synchronously
from the live GPU canvas in the render task; only decoding the immutable
snapshot may await. That prerequisite is fulfilled. The continuation used the
repaired helper successfully on both renderers; broader certification gates
listed below remain open.

S5 and S6 overlapped Scene, FrameState, EclipseState, AtmosphericConditions,
probe/spec support, and live migration documents. The shared-tree
reconciliation is deliberate: S5 extends the View-owned state established
across S1/S2/S6 rather than transplanting the parked Scene-global copy.

### S5 RTE decision

The parked S5 patch sent independently rounded raw f32 Sun/Moon ECEF positions.
That was rejected. The integrated payload instead uses a geocentric common-ray
differential computed in CPU f64:

- Sun unit direction plus inverse range;
- Moon-minus-Sun unit-direction differential plus inverse Moon range;
- shader rays `s=uS-P*a`, `D=dU+P*(a-b)`, `m=s+D`, where `P` is the direct
  globe model-space surface position;
- separation from `atan2(length(cross(s,D)), dot(s,m))`.

The f32 surface position has sub-meter quantization at Earth radius, and it is
multiplied by astronomical inverse ranges before entering the ray equations.
That keeps the position-dependent error far below the footprint scale without
reconstructing two independently rounded astronomical endpoints or coupling
the payload to a camera. WebGL packs the common-ray data into one
command-local `mat4` and reuses `czm_ellipsoidInverseRadii`; WebGPU carries the
same 64 bytes in group 0/binding 2. Ordinary WebGPU frames reuse one inert
renderer-owned buffer without ring allocation/upload. Active frames memoize
one slice per logical View/revision and allocator epoch, so a private
pick/capture submission cannot reuse a stale dynamic offset. The camera UB
remains 232 floats / 928 bytes. At gates 3/4, WebGPU therefore carries one
64-byte View slice and WebGL carries the active bit-33/`mat4` variant; both have
zero body ranges and zero local-geometry ALU, with no per-tile or per-pass
carrier growth.

## Campaign reconciliation

| Campaign | Audited status | Next meaningful gate |
|---|---|---|
| 1–8 | Closed/frozen; C8 open IDs transferred to C9 | Historical regression evidence only |
| 9 | Closed green | None |
| 10 | Complete at Batch 711 | None |
| 11 | Paused and open; certification held | C11-168 real workloads/GPU comparison, then C11-169/170/171 and W2–W8; C11-137 remains last |
| 12 | Launched and executing; S6 landed, S5 integrated but not finally certified | Finish S5's NASA-SVS, real terrain/exaggeration/fill/provider, behavioral pick/capture, dense-timing, custom-ellipsoid, multi-View/stereo, and genuine replacement-device matrix, then remaining catalogue/HDR/moon/airglow work |
| 13 | Launched and executing | Finish C13-01/02 and Gate A, then C13-06/07/08 and Gate B |
| 14 | Fully planned, not launched | Strict O5: C11, C12, and C13 must all complete first |
| Meshlets | Research complete; Tier 1 recommended | C11-168 dense-tileset measurement lane |

For Campaign 13, completed work is `C13-00,03,04,05,35,36,37,38`; C13-39 is a
closed negative result; C13-01 is in progress; C13-11/26/27 remain blocked.
`C13-41` is now the canonical owner for the C12-29 S3 cloud/IBL rider. It is
blocked on Gate B; C13-39 informs its shader-variant/register-pressure design
but is a closed negative result, not an execution dependency.

## Maintainer decisions carried forward

Recommended dispositions:

1. **Broken globe pipeline accessors:** remove the four zero-caller accessors.
   They use obsolete keys and have returned null for roughly 15 months. Do not
   replace them with an allocating enumeration API without a real consumer.
2. **`wrongModuleHits`:** first make the central key correct. If a diagnostic
   remains useful, count full vertex/fragment module plus entry-point identity;
   no hot-path logging.
3. **Repository-wide `.mjs` gap:** close the Prettier omission in an isolated
   mechanical batch after all live worktrees land.
4. **Redundant tides worktree:** its seven untracked files are byte-identical to
   Batch 767 on main. It is safe to remove, but deletion still requires explicit
   maintainer authorization.

## Verified continuation order

1. Batch 769: land the independent tide/ocean correctness and allocation fixes
   with canonical specs.
2. Repair S6's shared capture and star-field hot path; merge and rerun both
   backends before landing.
3. **In progress:** S5 is reconciled on top of S6 with the corrected RTE
   representation, per-View ownership, a dedicated 64-byte WebGPU carrier, and
   a static inactive/active WebGL globe-shader variant. Terrain activation now
   uses a provider-wide realized-mesh envelope for its O(1) broad gate and
   scans skirt-inclusive selected-mesh spheres only when that gate can
   intersect the penumbra. Scene prepares S1/S2/S6 and clears S5; main
   rendering, pick, and retained capture each prepare the same View-owned S5
   block once from their exact selection. Removing the consumerless coarse
   preparation saves one duplicate O(1) broad test for each rendered-globe
   logical `View`/frame and repeated fitting on active intersecting frames; no
   FPS claim is made for that bounded cleanup. The protected Node set is
   145/145, the real both-backend footprint and selected-terrain transition
   gates pass, and all twelve executions in the six-pair moving-camera lane
   pass. Finish NASA-SVS evidence and the real terrain/exaggeration/fill/
   provider, behavioral pick/capture, dense-timing, custom-ellipsoid,
   multi-View/stereo, and genuine replacement-device matrix before marking it
   complete.
4. Redesign and prove the central pipeline cache key. Do not merge the parked
   caller-name suffix patch as the correctness mechanism.
5. Correct environment-clear allocation/semantics and run its visual gate.
6. Run the parked globe-readiness probe.
7. Keep the current-state overlays in the campaign and debugging documents in
   sync as each remaining parked lane lands; do not rewrite the preserved
   historical executor records.
8. Resume C13 Gate A/B and C11's real-workload measurement sequence.

## Validation performed for this audit

- The 17-file Node suite covering added/modified audit-period probes:
  **280/280 green**.
- Full TypeScript gate at audited head: **green**.
- Full repository build at audited head: **green**.
- Batch 769 engine build: **green**.
- New canonical Karma specs in Edge:
  - `Core/HarmonicTideModel`: **4/4 green**.
  - `Renderer/WebGPU/WebGPUGlobeSurfaceTileUB`: **3/3 green**.
- Existing `tidal-harmonics.spec.mjs`: **34/34 green** after the predictor
  correction.
- Continuation checkpoint for S5:
  - `eclipse-globe-umbra-rte.spec.mjs`: **18/18 green**.
  - `eclipse-globe-shadow-visual.spec.mjs`: **4/4 green**.
  - `eclipse-sky-totality.spec.mjs`: **51/51 green**.
  - Dynamic-environment recovery contract: **7/7 green**.
  - Core eclipse contract: **134/134 green**.
  - Combined protected eclipse/recovery Node run: **145/145 green**.
  - Performance-manifest/evidence contract: **23/23 green**.
  - Full engine build, generated shader wrappers, and targeted engine lint:
    **green**.
  - Expanded Edge/Karma dynamic-environment manager gate: **11/11 green**.
    The earlier terrain-mesh classification result was 4/4; its requested
    current-tree rerun was blocked by the executor approval-usage cap before
    the browser launched, not by a test failure.
  - Real browser footprint: **PASS** on both WebGL and WebGPU, with no control
    drift, console error, or device loss.
  - The fixed-camera selected-terrain transition lane is **PASS** on both
    renderers with parity. Its outside-target state exercises **81/81** rays
    over exactly **36** stable selected/rendered/encoded/scaled-ENU/skirted
    meshes at gate 3, with zero Sun/Moon inverse body ranges; its S2-only
    control is non-vacuous. Correction is exact on WebGL and within one code on
    WebGPU. The first inside-target sample uses **25** meshes at gate 2; the
    reverse transition first takes the conservative two-root fallback at gate
    2, then settles back to exactly 36 meshes at gate 3. WebGPU correction and
    local states each allocate exactly one additional slice versus gate 0,
    independent of tile count. Artifact:
    `Tools/visual-regression/output/eclipse-globe-shadow-report.json`.
  - The explicit WebGL program-event route recorded exactly seven programs and
    seven long tasks. Every long task contained exactly one blocking
    `getProgramParameter(..., LINK_STATUS)` wait; the seven waits totalled
    **753.9 ms** after the static inactive/active split, versus **889.9 ms**
    before it. This proves a renderer-wide asynchronous compilation
    opportunity; it does not by itself certify a stable frame-time speedup.
  - The six-pair, fresh-process, counterbalanced moving-camera lane completed
    all 12 runs with valid active/inactive eclipse evidence and no page,
    device, or external-request failures. Median WebGL/WebGPU CPU averages were
    3.667/3.363 ms; median CPU p95 values were 5.273/5.500 ms; median CPU p99
    values were 8.850/7.320 ms. WebGPU's median GPU average/p95 were
    2.056/3.105 ms. Median FPS and 1%-low were 54.27/42.69 for WebGL and
    56.50/48.70 for WebGPU. WebGL retained nine compile/link long tasks per
    run; WebGPU recorded none.
  - Those repeated results certify the current build's renderer parity and
    reject an obvious S5 regression, but do not isolate S5's performance delta.
    The banked pre-spatial baseline has only one run per lane, so it is not a
    counterbalanced before/after proof. Its timestamped WebGPU result moved
    directionally from 2.464/6.418 ms average/p95 to 1.729/2.680 ms in the
    matching single post run, but no stable speedup is claimed from that
    asymmetric comparison.
  - NASA-SVS footprint comparison, real terrain/exaggeration/fill/provider
    transitions, behavioral pick/capture, dense timing, custom-ellipsoid
    runtime, generic multi-View/stereo, and genuine replacement-device recovery
    remain pending. Horizon twilight now uses active-ellipsoid geodetic up on
    both backends; catalogue-star extinction follows the active ellipsoid's
    maximum radius but its older integrator remains a documented spherical
    approximation.

The targeted S6 and S5 live-browser gates are promoted to PASS because they use
same-task live-canvas capture and non-vacuous controls. That does not promote
the still-unrun pipeline-aliasing, environment-clear, or globe-readiness
worktree probes, nor does it close S5's broader certification matrix. A
structural report, stale screenshot, zero-content readback, or fallback capture
still does not satisfy any visual gate.
