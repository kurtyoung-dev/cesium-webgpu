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
landed regressions were found, the scene-owned eclipse state is not yet
multi-view correct, and none of the four principal parked changesets has passed
its complete runtime exit gate. Campaign 10 remains the only complete campaign
among Campaigns 10–13.

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
- Eclipse state is computed in Scene-owned, backend-neutral code and then
  consumed by both renderer paths.
- The environment-frustum change fixed a real WebGPU sky failure discovered by
  the new gate.
- The S4 investigation correctly retired an unsupported premise instead of
  forcing a cosmetic fix.

The unresolved architecture issue is view ownership. `Scene` currently has one
eclipse-state object, and the runtime update is tied to the default camera.
Observer geometry is camera-dependent, so secondary/offscreen views can inherit
the wrong eclipse factors. S5/S6 already overlap this code; the correction must
be integrated there and proved with two cameras at one simulation instant.

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
   module identity, entry points, layout, and material descriptor axes. Fix the
   central key with stable shader-module identities and complete descriptor
   state. Run the collision-inducing negative control before the fixed run.

### Secondary, feature-preserving cleanups

- Resolve the globe-water datum before prefetching the 508 KiB geoid asset, so
  `AUTO + EllipsoidTerrainProvider` does not fetch unused data.
- Remove the backend check from `OceanSurfacePrimitive`; request the FFT-ocean
  feature renderer and let an unavailable implementation no-op through the
  existing feature-renderer contract.
- Keep the documented eclipse/LUT gap queued before atmosphere LUTs can become
  default.
- Close the formatting coverage gap by unignoring tracked `.mjs` files in
  Prettier after the live worktrees land. ESLint and lint-staged already include
  `.mjs`; this is specifically a Prettier gap.
- Decompose oversized probe/implementation files where doing so lowers review
  risk; do not mechanically split code without an ownership boundary.

## In-flight changeset audit

| Lane | Static evidence | Runtime evidence | Required correction |
|---|---:|---|---|
| Eclipse S6 — sky totality | 107/107 | Stored evidence is stale and failed | Fix canonical same-task capture; eliminate per-frame star decision allocation; normalize CRLF safely; merge current main; rerun both renderers |
| Eclipse S5 — globe umbra | 109/109 protected set | Fresh run is structural, not visual proof | Land after S6; use RTE-safe/range-normalized body representation; make eclipse state multi-view correct; measure added uniform/shader cost |
| Pipeline aliasing | 46/46 | Required browser lanes unrun | Replace caller-name workaround with a complete central cache key; negative control first; rerun five log-depth probes |
| Environment clear | 15/15 | Browser/visual gates unrun | Remove per-clear result allocation; settle capture-before/after-scene-pass semantics; document and run probe |
| Globe readiness | 51/51 | Browser probe unrun | Run after relevant pipeline work and add the probe to the debugging guide |

### Why S6 must precede S5

S6 owns `Tools/visual-regression/lib/same-task-capture.mjs`, which S5 uses as its
capture authority. The current implementation defers `drawImage()` from the GPU
canvas; Edge/WebGPU can invalidate that surface after presentation. S6 must
capture encoded pixels in the render task (for example, immediate `toDataURL()`)
and decode that immutable snapshot later. Only then can S5's globe-umbra output
be trusted.

S5 and S6 overlap eleven files, including Scene, FrameState, EclipseState,
AtmosphericConditions, the same probe/spec, and five live migration documents.
They require a deliberate merge, not independent application.

### S5 RTE decision

The parked S5 patch sends raw f32 Sun/Moon ECEF and raw model/world position,
described as requiring no RTE split. That conflicts with the fork's mandatory
planet-scale RTE rule even if a narrow error estimate looks acceptable.

The preferred correction preserves the existing two body `vec4` slots:

- upload body unit direction plus inverse range (or angular-radius/range ratio);
- compute `bodyDirection - positionWC * inverseRange` from the already
  RTE-stable local/world position;
- normalize that small relative vector and derive the distance ratio in shader.

This avoids subtracting two large f32 ECEF positions without increasing the
uniform footprint. The CPU twin, shader-pair comments, and two-camera regression
must use the same representation.

## Campaign reconciliation

| Campaign | Audited status | Next meaningful gate |
|---|---|---|
| 1–8 | Closed/frozen; C8 open IDs transferred to C9 | Historical regression evidence only |
| 9 | Closed green | None |
| 10 | Complete at Batch 711 | None |
| 11 | Paused and open; certification held | C11-168 real workloads/GPU comparison, then C11-169/170/171 and W2–W8; C11-137 remains last |
| 12 | Launched and executing | Land validated eclipse S6/S5, then remaining catalogue/HDR/moon/airglow work |
| 13 | Launched and executing | Finish C13-01/02 and Gate A, then C13-06/07/08 and Gate B |
| 14 | Fully planned, not launched | Strict O5: C11, C12, and C13 must all complete first |
| Meshlets | Research complete; Tier 1 recommended | C11-168 dense-tileset measurement lane |

For Campaign 13, completed work is `C13-00,03,04,05,35,36,37,38`; C13-39 is a
closed negative result; C13-01 is in progress; C13-11/26/27 remain blocked.
After Gates A/B, add an explicit C13 alias for the C12-29 S3 cloud/IBL rider
before implementing it.

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
3. Reconcile S5 on top of S6; correct RTE and multi-view ownership; obtain real
   non-structural WebGL/WebGPU images and cost evidence.
4. Redesign and prove the central pipeline cache key.
5. Correct environment-clear allocation/semantics and run its visual gate.
6. Run the parked globe-readiness probe.
7. Reconcile the campaign/document drift once, after the overlapping worktrees
   are landed.
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

The in-flight browser evidence is intentionally not promoted to PASS. A
structural report, stale screenshot, zero-content readback, or fallback capture
does not satisfy a visual gate.
