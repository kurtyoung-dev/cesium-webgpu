# DEV notes — clouds

Comments moved out of `packages/*/Source` by the Campaign 16 comment
remediation, preserved verbatim. Format:
[DEV_NOTES_FORMAT.md](DEV_NOTES_FORMAT.md). These are historical records, not
current documentation — verify any claim here against the code before acting
on it.

Covers the procedural volumetric cloud renderer, its WGSL shaders, the WebGPU
cloud support modules, the `CloudCollection` scene family, and the weather
ingest and `AtmosphericConditions` modules that feed them.

## Procedural cloud renderer

### `packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts` — (module docblock)

_Moved 2026-08-11._

```text
WebGPU Procedural Cloud Renderer

Renders volumetric clouds as a full-screen pass using ray marching.
Activated by a VOLUMETRIC {@link CloudCollection} (the Scene/Globe managed
`globe.defaultCloudCollection`, or a user collection) — cloud-unification epic
slice 4B removed the legacy `globe.showProceduralClouds` / `globe.cloud*` API.

Configuration is carried by the collection's `.volumetric` {@link CloudVolumetrics}
(identical field names to the former `globe.cloud*`), resolved into a
{@link CloudVolumetricsConfig} snapshot each frame:
  - enabled: boolean (default false) → collection renderMode VOLUMETRIC
  - cloudCoverage: number 0-1 (default 0.5)
  - cloudLayerBottom: number meters (default 1500)
  - cloudLayerTop: number meters (default 4000)
  - cloudWindSpeed: number m/s (default 15)
  - cloudWindDirection: {x, y} (default {x: 0.7, y: 0.3})
  - cloudDensity: number (default 0.3)
  - cloudQuality: number 32-128 steps (default 64)

── C13-09 RECONSTRUCTION ATTACHMENTS: WHAT IS LIVE, WHAT IS PENDING ──

LIVE. `CloudReconstructionAttachments pass` writes front / transmittance-
weighted cloud depth, screen-space motion with an explicit validity channel,
and the depth/coverage moment pair, at the half-resolution march size, with
full creation / resize / device-swap lifecycle and a monotonic generation
key. It is OPT-IN and DEFAULT OFF (`setCloudReconstructionAttachments`,
surfaced as `CesiumDebug.cloudReconstructionAttachments(true)`): with it off
nothing allocates and no pass is encoded, so the shipped cloud lane is
identical in pixels AND in cost.

PENDING, and deliberately so — this row is infrastructure and NOTHING READS
THE SET YET (CLAUDE.md Principle 7: the producer half exists, the consumer
half is the follow-up, and deleting the targets because no pass samples them
is the documented anti-pattern):

  - C13-10 owns the true 1/16-rate current-frame march. It replaces the
    analytic depth ESTIMATOR (shell interval under the march's own resolved
    alpha) with per-sample accumulation emitted by the march itself, and it
    is the row permitted to change `ProceduralClouds.wgsl`.
  - C13-12 owns every consumer: attachment-aware motion/depth rejection,
    variance clipping from the moment pair, reactive history, wind advection
    in reprojection, and disocclusion.
  - Orthographic and morph frames still produce NO attachments, because the
    producer needs a usable inverse current view-projection-relative-to-eye
    for its per-pixel ray. That is the same residual C13-05 recorded; it
    closes when reconstruction carries a per-pixel ray origin.
```

The scaffolding map for the reconstruction-attachment producer: it records which
follow-up owns each unwired half, and which file each is permitted to change.
The rewritten docblock states the same live/pending split as current behaviour
and current limitations; this preserves the ownership split, which is about the
work programme rather than the code.

### `packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts` — `CLOUD_UNIFORM_FLOATS`

_Moved 2026-08-11._

```text
CloudUniforms float count — grown ADD-ONLY: 64→80 (weather seam) → 96 (W1-W8
lighting) → 104 (Batch 407 dials 96-103) → 108 (Batch 408 V11 profile 104-107;
Batch 409 renamed pads 105-106 → nearPlane/farPlane, no count change) → 112
(Batch 434 atmosphere-LUT coupling: aerialLutMode/ambientLutMode/atmosphereThickness/pad 108-111)
→ 120 (Batch 443 multi-deck: multiDeck/pad + deckBoundsLow/Mid/High vec2 112-119)
→ 128 (Batch 445 CLOUD-RTE: encodedCameraHigh.xyz+pad 120-123, encodedCameraLow.xyz+pad 124-127)
→ 132 (Batch 555 E2 CLOUD-MAMMATUS: mammatusStrength/Scale/Depth+pad 128-131).
→ 136 (Batch 610 E1 CLOUD-EXOTIC-SPECIES: speciesMode/Strength/Scale/Param 132-135).
→ 140 (Batch 611 E2 CLOUD-EXOTIC-FEATURES-REMAINING: featureMode/Strength/Scale/Param 136-139).
→ 144 (Batch 612 E3 CLOUD-EXOTIC-SPECIAL: specialShadeMode/Strength/Scale/Param 140-143).
→ 148 (Batch 634 C6-CLOUD-STBN-TAAU LOD half: marchStepGrowth/maxRayDistance+2 pads 144-147).
→ 160 (C13-37: CPU-f64 texture-domain phases, 148-159).
→ 168 (C13-37: encoded canonical morphology origin, 160-167).
→ 172 (C13-16 per-genus morphology: genusFibreStrength/Anisotropy/Shear +
       genusPhaseDelta, 168-171).
```

The full slot-allocation history of the cloud uniform buffer. Kept because it is
the only record of which change claimed which float range, which is what makes a
future slot conflict diagnosable; the rewritten comment states only the add-only
rule the layout must keep obeying.

### `packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts` — `CloudCache#attachmentsEnabled`

_Moved 2026-08-11._

```text
── C13-09 — reconstruction attachments (front/weighted depth, velocity,
moments) ──
DEFAULT OFF: `attachmentsEnabled` starts false, so nothing here allocates,
no pass is encoded, and the shipped cloud lane is byte-identical AND
cost-identical. Turned on through `setCloudReconstructionAttachments`
(surfaced as `CesiumDebug.cloudReconstructionAttachments(true)`), the
producer writes the set at the HALF-RES march resolution — the attachments
are defined at the reconstruction resolution, and on the full-res path
there is no intermediate march target to derive them from.

★ AT C13-09 NOTHING READ THEM. `reconstructionEnabled` below is C13-10's
  SEPARATE opt-in that makes the march emit and the resolve consume; with
  only `attachmentsEnabled` set the set is still produced-and-unread, which
  is what keeps C13-09's own acceptance legs meaningful. Removing the
  targets because "no render pass reads them" is the exact anti-pattern
  CLAUDE.md Principle 7 documents.
```

The explicit dead-code exemption for the attachment targets, naming which
follow-up owns the consumer half. The rewritten comment states that the set is
produced and unread; this records why the state is deliberately reachable at all,
namely that it is the only configuration in which the producer can be exercised
in isolation.

### `packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts` — `CloudCache#reconstructionEnabled`

_Moved 2026-08-11._

```text
── C13-10 — march-emitted reconstruction + the first consumer ──
A SECOND opt-in, DEFAULT OFF, layered on C13-09's. When it is set the
half-resolution march compiles with `CLOUD_MARCH_EMIT_RECONSTRUCTION` and
writes contract slot 1 (depth) as a second colour target; the producer
compiles with the same bit, READS that target and drops the depth slot from
its own MRT; and the temporal resolve compiles with
`CLOUD_RECONSTRUCTION_CONSUME` and validates history against the set.

★ EVERY VARIANT PIPELINE IS A SEPARATE OBJECT BESIDE THE HISTORICAL ONE
  (`halfEmitPipeline` beside `halfPipeline`, and so on). Nothing is
  rebuilt, invalidated or recompiled when the flag flips, so the shipped
  pipelines are the same GPU objects they would have been without this row
  — which is what makes "default byte-identical" a structural property
  rather than a promise.
```

Records that the variant pipelines being separate objects is a correctness
property rather than an implementation convenience: it is what makes the
unchanged path provably unchanged instead of merely believed to be.

### `packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts` — `timedCloudPass`

_Moved 2026-08-11._

> C13-39 — route a cloud render pass through the opt-in GPU timestamp profiler.
> Every raymarching pass this module opens (shadow map, shadow cascade atlas,
> half-res march, temporal resolve, bilateral upscale, full-res march,
> transmittance mask) is a separate measurable lane. Without this the passes
> carried no `timestampWrites`, so `CesiumDebug.gpuPassCost()` could not
> attribute any GPU time to the cloud march at all — which is what the C13-39
> baked / LIVE / single-shadow / cascaded-shadow acceptance lanes need.

Names the four measurement lanes this seam was built to serve. Useful when a
later performance investigation needs to know which configurations the pass
labels were designed to separate.

### `packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts` — `ensureShadowResources`

_Moved 2026-08-11._

> ─── C13-06 — the sun-view frame is owned by WebGPUCloudShadowFrame.ts ───
> The former local mat4 helpers (mul4 / invert4 / buildSunViewOrthoVP) built the
> world-to-sun-clip matrix and its inverse in f32 from a SPHERICAL 6378137 m
> footprint centre. Both defects are now closed by the shared f64 frame owner:
> the centre is a WGS84 geodetic surface projection, and the matrices are
> emitted relative to a caller-supplied eye so no planet-scale magnitude reaches
> an f32 matrix entry. See WebGPUCloudShadowFrame.ts for the full contract.

Names the two specific defects a locally reimplemented sun frame would
reintroduce: an f32 planet-scale matrix product, and a spherical rather than
geodetic footprint centre. The rewritten comment states the constraint; this
keeps the failure modes attached to it.

### `packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts` — `publishCloudIblCoverage` (`IBL_REVISION_*` steps)

_Moved 2026-08-11._

> C13-37 IBL-refill debounce — the env-cube cloud march is expensive (full cube
> fill + IBL prefilter + SH-L2 projection), and `publishCloudIblCoverage` runs
> every frame, edge-triggering that refill through `iblRevision`. Comparing the
> raw continuous inputs with `!==` bumped the revision on ANY float wobble, so an
> app animating `cloudCoverage` (or density / wind) refilled the whole cube every
> frame — defeating the consume-side `CLOUD_COVERAGE_REFRESH_EPSILON` gate once
> `iblRevision` began edge-triggering the same refill.

Records the interaction between the two gates: the consume-side coverage epsilon
was rendered ineffective once the revision counter began edge-triggering the same
refill, which is why the debounce had to move to the publish site rather than be
tightened where it already existed.

## Cloud WGSL shaders

### `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl` — `CloudUniforms`

_Moved 2026-08-11._

> ── Batch 445 (4.12 CLOUD-RTE) — camera-relative high-precision march. Slots
> 120-127, two new 16-byte rows appended ADD-ONLY (existing field offsets above
> are UNCHANGED). The RTE high/low split of the camera world position; the planet
> center relative to the camera is -(high+low). READ ONLY inside the
> CLOUD_QF_HIGH_PRECISION branch. C13-04 enables that branch automatically;
> explicit false retains the legacy A/B route. The .xyz carry the split; the
> packed pad keeps each on a 16-byte (vec4) stride so the struct length is 128. ──

Representative of the ten near-identical "appended ADD-ONLY (all earlier offsets
UNCHANGED)" notes the struct carried, one per growth step. The rewrite states the
byte-lock discipline once at the head of the struct instead. Note the trailing
claim "so the struct length is 128" was already stale — the struct has since
grown to float 171 — which is why it is recorded here rather than restated.

### `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl` — `cloudShapeTex` / `cloudDetailTex` bindings

_Moved 2026-08-11._

> V2 — baked 3D noise (shape 128³ + detail 32³) + sampler. DECLARED but NOT
> sampled yet (no path reads them → byte-identical); V3 switches cloudDensity /
> cloudBaseDensity to sample these instead of the live fbmNoise/worleyF1.

Records that these two textures were once allocated-but-unread scaffolding, which
is the state the project's dead-code rule protects. That stage is over —
`bakedBase`, `legacyBakedBase` and `cloudDensityFromMacro` all sample them — so
the comment was describing a condition that no longer held.

### `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl` — `CloudUniforms#exposure`

_Moved 2026-08-11._

> W1 — exposure feeding the Reinhard tone-map at the cloud composite. Calibrated
> against sunIntensity~10 + the dual-lobe forward peak so the silver lining is a
> gradient, not a white-out. Promoted to the `cloud.exposure` uniform (Batch 407,
> default 0.22) so it can be tuned live; the const is gone.

Was an orphan: a docblock left in place above nothing after the constant it
described became a uniform. The calibration numbers — sun intensity ~10, default
exposure 0.22 — are the only record of where the default came from.

### `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl` — `vertexMain`

_Moved 2026-08-11._

> OVERSIZED fullscreen triangle — verts (-1,-1), (3,-1), (-1,3) so the whole
> [-1,1] clip square sits INSIDE the triangle and every screen pixel is shaded.
> The previous exact-fit triangle (-1,-1),(1,-1),(-1,1) coincided with three
> NDC corners and covered ONLY the lower-left half (x+y<=0) — the upper-right
> half was never rasterized, so clouds appeared only in the bottom-left of the
> screen behind a hard corner-to-corner diagonal. (That diagonal was long
> misfiled as a "frustum-edge artifact"; it was a non-oversized fullscreen
> triangle.) `uv` is an affine function of the clip xy, so it still
> interpolates 0..1 across the visible square unchanged.

Kept for the misdiagnosis: a hard corner-to-corner diagonal in a full-screen
volumetric pass reads as a frustum-edge artifact and was triaged as one for a
long time. The rewritten comment states the geometric constraint but not the
symptom-to-cause mapping.

### `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl` — `genusFibreFactor`

_Moved 2026-08-11._

> Scene/CloudTypeProfile.js has always carried an `erosion` axis (FIBROUS for the
> cirrus family, PUFFY for the water-droplet genera) and a per-genus `phaseG`, and
> NEITHER reached the shader: a genus changed only its density scale, deck, height
> gradient, and extinction, so cirrus rendered as faint scaled-down cumulus lobes.
> These three functions are the genus-level SHAPE and PHASE half.

Names the four genus axes that did reach the shader before these functions
existed — density scale, deck, height gradient, extinction — which is the list to
check against if a genus ever reads wrong again.

### `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl` — `raySphereIntersect`

_Moved 2026-08-11._

> RESIDUAL (deferred): for near-RADIAL rays the geometry still needs
> `radius - |ro|` (a ~1e3 m difference of two ~6.4e6 m magnitudes), which f32
> can't fully resolve — removing THAT needs RTE high/low camera (DP emulation in
> WGSL). The residual is ~1 m and not visibly observed, so the full DP path
> stays deferred (NEW-WEBGPU-CLOUD-RTE) until a shimmer artifact is seen.
>
> RETAINED (Principle 7), NOT dead code: C13-04 moved the visible march and
> C13-06 moved the beer-shadow producer onto the oblate `rayEllipsoidIntersect*`
> pair, so this spherical form currently has no caller in this module. It stays
> because it is the documented numerically-stable primitive the cloud subsystem
> reaches for whenever a TRUE sphere is the right model (the environment-capture
> march keeps its own local copy, `cloudShellIntersect` in
> ProceduralSkyCubemap.wgsl, for exactly that reason), and because C13-22's
> shadow redesign is queued against this file. Deleting it would mean
> re-deriving the Haines form and its rationale from scratch. The shader
> compiler dead-strips an uncalled function, so it costs nothing at runtime.

Two things with no home in the code: the ledger id `NEW-WEBGPU-CLOUD-RTE` that
owns the remaining ~1 m double-precision residual and the trigger condition for
picking it up, and the queued shadow redesign that is one of the reasons the
uncalled function is retained.

### `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl` — `cloudDensity`

_Moved 2026-08-11._

> Raw-world wrappers keep the non-RTE A/B diagnostic route on the same
> mathematical density field. C13-06 moved the LIVE shadow route onto the
> camera-relative twin below; these remain the explicit `cloudHighPrecision =
> false` escape path and the same-build oracle.
> SCAFFOLDING (Principle 7): cloudDensity itself is defined but not yet called
> (cloudDensityWithFootprint below IS live). Do not delete.

An explicit dead-code-rule marker. The rewritten comment states that the function
has no caller and why it is kept; this preserves the original wording that
classified it as scaffolding rather than dead code.

### `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl` — `cloudBaseDensity`

_Moved 2026-08-11._

> SCAFFOLDING (Principle 7): cloudBaseDensity is defined but not yet called. It is
> the cheap no-erosion base oracle retained for the C13-22 shadow redesign's
> empty-space skipping; wire-up is pending. Do not delete.

Same reason, plus the row that owns the pending wire-up. The rewritten comment
cannot name that row.

### `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl` — `cloudDensityRelativeWithFootprint`

_Moved 2026-08-11._

> The pre-C13-06 shadow pass reconstructed a full-ECEF `vec3<f32>` sample and
> rebuilt the periodic texture domains from it. That is the raw-world route the
> visible march abandoned in C13-37: the visible march reconstructs its domains
> from CPU-`f64` origin phases plus a small camera-relative displacement. Two
> routes reading "the same field" through different reconstructions is exactly
> the per-consumer approximation the audit convicted, so the shadow now reads
> through the identical owner.

The "per-consumer approximation" finding is an audit result that spans more than
this file — it is the reason several cloud consumers were pulled onto one density
owner. The rewritten comment states the local constraint only.

### `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl` — `DeckResult`

_Moved 2026-08-11._

```text
C13-10 — per-sample reconstruction emission. Present ONLY in the emitting
variant: C13-39's negative result makes register footprint a static
property of the module, so these two accumulators (and every line that
touches them) are deleted by the preprocessor for the full-resolution
march, the shadow map, the cascade atlas and the god-ray mask.

  frontDistance       nearest sample distance that actually contributed
                      extinction, metres; -1 when the deck contributed
                      nothing. This is the channel one mean depth cannot
                      provide for separated overlapping volumes.
  weightedDistanceSum Σ wᵢ·tᵢ over this deck's OWN transmittance weights,
                      where wᵢ = (1 - exp(-σᵢ·Δ)) · Tᵢ is exactly the
                      weight the radiance accumulation already uses. Their
                      sum is the deck's alpha by construction, so the
                      transmittance-weighted mean distance is this divided
                      by `alpha` — an ACCUMULATION, not the uniform-
                      extinction estimator C13-09 had to settle for.
```

Records the measured result that set the whole variant strategy: the cloud march
was found to be occupancy-bound with static register allocation, so unconditional
additions to this module are paid by five pipelines. The rewritten comment states
the consequence; this preserves the provenance of the claim.

### `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl` — `marchDeck`

_Moved 2026-08-11._

> When opted in: the fixed sampling comb GROWS geometrically along the ray so far
> shell samples (which read as 1-2 px) coarsen (Takram/AAA perspective step), and
> the march STOPS past maxRayDistance where clouds are sub-pixel. WebGPU-only
> (no WebGL twin) — a pure perf/quality dial with no visual-parity requirement.

Kept for the technique's provenance. "Takram/AAA perspective step" is a codename
tag rather than a citation, so the rewritten comment describes the geometric
step growth and leaves attribution unclaimed. If a published source is
identified, it belongs in a `Reference:` line at that function.

### `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl` — `fragmentCloudMaskMain`

_Moved 2026-08-11._

> ─── TAKRAM-9 (cloud-aware god rays) — screen-space transmittance mask ───

Same reason: the pass was named after a reference implementation. The rewritten
banner names what the pass produces instead. Whether the mask approach itself
derives from that implementation, and therefore needs a `Reference:` block or a
`LICENSE.md` entry, is unresolved.

### `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl` — `cloudShadowMain`

_Moved 2026-08-11._

```text
C13-06 closed two defects the audit convicted here:

 1. WGS84. The shell was two SPHERES of the equatorial radius and the height
    was `length(p) - planetRadius`. WGS84's polar axis is ~21.4 km shorter, so
    at high latitude this marched a slab several deck thicknesses ABOVE the
    shell the visible march renders — the sun ray met no cloud and the cast
    shadow silently vanished. Both branches now intersect the SAME expanded
    oblate shells `cloudShellAxes` gives the primary march.
 2. RTE. The column point was a full-ECEF `vec3<f32>` from an `f32` matrix
    whose translation column was itself ~6.4e6 m, and the density domains were
    rebuilt from that raw coordinate. Both are now camera-relative, so the map
    is cast by exactly the field the visible march renders.
```

Two failure modes with a distinctive signature — a cast cloud shadow that
vanishes only at high latitude, and a shadow map that disagrees with the visible
march by a slowly-varying offset. Both are worth recognising if a future change
to the shadow frame reintroduces either.

### `packages/engine/Source/Shaders/WebGPU/Environment/CloudTemporalResolve.wgsl` — `(module docblock)`

_Moved 2026-08-11._

> STILL OPEN AFTER C13-10's FIRST SLICE: the history remains HALF-RESOLUTION
> (the row's full-resolution reconstruction and true 1/16 current work are its
> follow-up), and every THRESHOLDED rejection — motion/depth bounds, variance
> clipping, reactive history, wind advection, disocclusion proper — is C13-12.

The only in-code statement of which rows own the unfinished halves of this pass.
The rewritten docblock lists the limitations as current behaviour, which is what
a reader needs, but cannot name the rows that will close them.

### `packages/engine/Source/Shaders/WebGPU/Environment/CloudTemporalResolve.wgsl` — `fragmentMain`

_Moved 2026-08-11._

> ★ WHERE C13-10 STOPS AND C13-12 STARTS. The ledger gives `C13-12`
> "attachment-aware motion/depth rejection, variance clipping, reactive
> history, wind advection in reprojection, disocclusion". So every
> THRESHOLDED test — a depth-delta bound, a variance-clip width, a
> reactivity ramp, a wind-advected reprojection — is that row's. What is
> implemented here is the READ path and NON-PARAMETRIC validity: a fact the
> producer recorded (validity 0, the no-cloud sentinel), an internal
> consistency requirement on the moment record, and one early-out that is
> EXACTLY output-equivalent to running the full path. No number below is a
> quality knob; the only tolerance is the storage format's own quantum.

Quotes the ledger row verbatim, which is the record of exactly where the boundary
was drawn and why nothing in this branch carries a tunable threshold. The
rewritten comment keeps the principle and drops the citation.

### `packages/engine/Source/Shaders/WebGPU/Environment/CloudReconstructionAttachments.wgsl` — `(module docblock)`

_Moved 2026-08-11._

```text
Writes the reconstruction attachment set the temporal chain will read:
front / transmittance-weighted cloud depth, screen-space motion with its
validity, and the moment pair a variance clip needs. NOTHING READS THESE
YET — C13-10 owns the true 1/16-rate current-frame march and C13-12 owns the
consumers (motion/depth rejection, variance clipping, reactive history,
wind-aware reprojection, disocclusion).

★ WHY THIS IS A SEPARATE MODULE. C13-39's negative result established that
  WGSL register allocation is STATIC: code added to `ProceduralClouds.wgsl`
  inflates the register footprint of EVERY pipeline compiled from it — the
  visible march, the shadow map, the cascade atlas, the god-ray mask. None of
  those want a reconstruction attachment. So this producer is its own module
  with its own pipeline, and it RE-DERIVES the WGS84 shell intersection
  rather than importing the march's. The duplication is deliberate and is the
  cheaper side of the trade.
```

Two things. First, the "nothing reads these yet" sentence stopped being true once
`CloudTemporalResolve.wgsl` gained its consuming variant, and the rewrite says so
— this preserves the record that the set shipped as a producer with no consumer,
which is the dead-code-rule situation the file was written into. Second, the
separate-module decision rests on a measured occupancy result recorded elsewhere;
the rewritten docblock states the static-register-allocation consequence without
being able to cite where it came from.

## WebGPU cloud support modules

### `packages/engine/Source/Renderer/WebGPU/WebGPUCloudReconstructionAttachments.ts` — `(module docblock)`

_Moved 2026-08-11._

```text
C13-09 — cloud reconstruction attachment LAYOUT, LIFETIME, and GENERATION.

WHAT THIS ROW OWNS, AND WHAT IT DELIBERATELY DOES NOT.

`C13-05` left the cloud history a COLOR-ONLY half-resolution proxy, and said
so in `CloudTemporalResolve.wgsl` itself: its `representativeShellDistance`
is "a representative geometric proxy, not physical cloud depth; per-pixel
front/weighted depth remains C13-09". One mean depth per pixel cannot
separate two overlapping volumes, cannot reject a disoccluded history sample,
and cannot tell a reprojection that crossed a silhouette from one that did
not. This module is the TOPOLOGY that fixes that: the exact attachment set
the reconstruction chain reads, its formats, its byte cost, and the
generation key that makes a stale bind group impossible to serve.

★ WHAT IS LIVE AND WHAT IS STILL PENDING. The inventory belongs here rather
  than in a commit message, and it is updated as rows land — not left to
  describe the day the file was created:

    LIVE at C13-09    — allocation, resize, device-swap recreation, the
                        generation key, the producer pass, and the byte /
                        pass counters the Gate-A surface reports. Produced,
                        and (at that row) consumed by nothing.
    LIVE at C13-10    — the MARCH-EMITTED depth (a compile-time variant, see
                        the C13-10 block at the foot of this file) and the
                        FIRST CONSUMER: the temporal resolve now reads
                        depth / velocity / moments and validates history
                        against them. Both are opt-in and default OFF, and
                        they are SEPARATE opt-ins from C13-09's, so a build
                        can still produce without consuming — which is what
                        keeps C13-09's "produced but not consumed" claim
                        A/B-testable.
    PENDING C13-10    — the row's headline is NOT closed by that slice: one
                        current-frame phase covering one-sixteenth of
                        full-resolution pixels, and a FULL-RESOLUTION
                        history, both remain. The history below is still
                        half-resolution.
    PENDING C13-12    — every THRESHOLDED consumer: attachment-aware
                        motion/depth rejection, variance clipping from the
                        moment pair, reactive history, wind advection,
                        disocclusion proper.

★ C13-39 BINDS THE SHAPE. Its negative result established that WGSL register
  allocation is STATIC, so anything added to the shared `ProceduralClouds`
  module inflates EVERY pipeline compiled from it — including the shadow map,
  the cascade atlas and the god-ray mask, none of which want a reconstruction
  attachment. So the producer lives in its own WGSL module
  (`CloudReconstructionAttachments.wgsl`) and its own pipeline, and it
  re-derives the WGS84 shell intersection rather than importing it. The
  duplication is the point: it is what keeps the march's register budget at
  exactly the value C13-39 measured. `cloud-reconstruction-attachments
  .spec.mjs` pins `ProceduralClouds.wgsl` by content hash so this cannot
  erode by accident.

★ SLOT 0 IS NOT ALLOCATED HERE. The premultiplied color/transmittance
  attachment the row asks for ALREADY EXISTS as the half-resolution march
  target (`ProceduralClouds Half-Res Target`, rgba16float, premultiplied RGB
  with alpha; transmittance is `1 - a`). Re-allocating it would double the
  cost of a target the topology only needed to NAME. It is in the table with
  `ownedHere: false` so the contract is complete and the byte accounting can
  still separate "what this row added" from "what the set costs".

Everything in this module is pure: no device calls, no allocation on the
per-frame path, and every function is executable under `node --test`.

@module WebGPUCloudReconstructionAttachments
```

The scaffolding inventory the dead-code rule protects: which halves of the
reconstruction chain are wired, which are only allocated, and which queue rows
own the remainder. The rewritten docblock keeps the behaviour and the limits;
this preserves the row-by-row attribution and the A/B-testability argument for
keeping produce and consume as separate opt-ins.

### `packages/engine/Source/Renderer/WebGPU/WebGPUCloudReconstructionAttachments.ts` — `CloudAttachmentGeneration`

_Moved 2026-08-11._

> `generation` starts at 0 meaning "nothing allocated" and increments on every
> (re)allocation. C13-40 will key retained bind groups on it; until then it is
> what makes a resize or a device swap OBSERVABLE rather than silent.

Records that the generation counter was built ahead of its consumer: retained
bind groups are meant to key on it. The rewritten comment states only the
monotonicity constraint, which is what the code enforces today.

### `packages/engine/Source/Renderer/WebGPU/WebGPUCloudReconstructionAttachments.ts` — `releaseCloudAttachmentGeneration`

_Moved 2026-08-11._

> Rewinding would let a retired bind group's key collide with a future one,
> which is the precise failure C13-40's retirement work has to be able to rule
> out. Release keeps the counter monotonic and only clears the resident facts.

Names the queue row whose bind-group retirement work depends on this function
never rewinding the counter. The constraint itself survives in the code; the
attribution does not.

### `packages/engine/Source/Renderer/WebGPU/WebGPUCloudReconstructionAttachments.ts` — `cloudTransmittanceWeightedDepth`

_Moved 2026-08-11._

```text
★ THIS IS AN ESTIMATOR, NOT AN ACCUMULATION. It is exact only for uniform
  extinction inside the interval. It remains the DEFAULT and is not
  deprecated: it is the only depth available to a build that does not compile
  `C13-10`'s emitting march, it is the `//>>else` of that variant, and it is
  the reference the accumulation is checked against. The accumulation itself
  is {@link cloudMarchWeightedDepth}. The WGSL producer mirrors this
  expression-for-expression.
```

The reason this estimator is not superseded by the march-emitted accumulation:
it is the `//>>else` branch of a compile-time variant and the reference the
accumulation is validated against. The rewrite keeps both facts without naming
the row that added the variant.

### `packages/engine/Source/Renderer/WebGPU/WebGPUCloudReconstructionAttachments.ts` — `(march-emitted section banner)`

_Moved 2026-08-11._

```text
═══════════════════════════════════════════════════════════════════════════
C13-10 — MARCH-EMITTED RECONSTRUCTION

The estimator above answers "what depth does this alpha imply over this
geometric interval". The functions below answer the question the estimator
could not reach without changing the march: "what depth did the march
actually integrate". They are the CPU twins of the
`CLOUD_MARCH_EMIT_RECONSTRUCTION` variant, and they exist here — beside the
estimator, in the same pure module — precisely so a reviewer can see the two
side by side and so `node --test` can execute both without a device.

★ OWNERSHIP MOVES, IT DOES NOT DUPLICATE. When the variant is compiled the
  MARCH writes contract slot 1 (`depth`) as a second colour target and the
  producer pass READS it, because a render pass cannot sample an attachment
  it also writes. {@link CLOUD_EMITTED_ATTACHMENTS} is the producer's MRT
  list in that variant, and it is derived from the same contract table so
  the two can never drift.
═══════════════════════════════════════════════════════════════════════════
```

A file-scope banner removed under the placement rule. Its load-bearing halves —
why the twins live beside the estimator, and why the march rather than the
producer owns slot 1 under the variant — moved into the module docblock and
into `CLOUD_EMITTED_ATTACHMENTS`'s own block.

### `packages/engine/Source/Renderer/WebGPU/WebGPUCloudReconstructionAttachments.ts` — `classifyCloudReconstructionHistory`

_Moved 2026-08-11._

```text
★ WHAT THIS DELIBERATELY DOES NOT CONTAIN. The C13 ledger gives `C13-12`
  "attachment-aware motion/depth rejection, variance clipping, reactive
  history, wind advection in reprojection, disocclusion". Every one of those
  needs a TUNED NUMBER — a depth-delta bound, a clip width in sigmas, a
  reactivity ramp. There is no tuned number here, and that is the boundary:
  this function returns only facts the producer already recorded
```

The scope boundary drawn against a named queue row, with the test that decides
which side of it a change falls on: if it needs a tuned number, it does not
belong in this function. The rewrite keeps the test and drops the row.

### `packages/engine/Source/Renderer/WebGPU/WebGPUCloudObservability.ts` — `(module docblock)`

_Moved 2026-08-11._

```text
C13-02 — cloud CPU/GPU observability and temporal-cost counters.

WHAT WAS ALREADY THERE, AND WHY IT DID NOT CLOSE THE ROW. Batch 762 (the
C13-39 negative result) landed byte-inert `timestampWrites` on all seven
cloud render passes plus the environment Sky Fill, so `CesiumDebug
.gpuPassCost()` could finally attribute GPU time to the cloud march at all.
That is a GPU-timer wiring, not an observability surface: it says nothing
about how many pixels the march dispatched, how much of the frame the cloud
lane actually occupied, whether the temporal history accepted or reset, what
the weather cache did, or what the CPU spent scheduling any of it. Gate A's
evidence requirement is "counters prove present target sizes and work" —
pass timings alone cannot prove either.

WHAT THIS MODULE IS. The pure, allocation-bounded half of the surface:

  1. {@link CloudFrameCounters} — one mutable record, created once per
     context and RESET IN PLACE at the top of every cloud execute. Reset is
     `for` over a fixed field list, so a culled or early-returned frame
     reports zeros rather than last frame's numbers, and no frame allocates.
  2. {@link CloudCpuStageAccumulator} — fixed-slot `Float64Array` timing for
     the named CPU stages. DISABLED by default: `beginStage`/`endStage`
     return on one boolean read, so the shipped path pays no `performance
     .now()` and the render result cannot depend on the instrumentation
     (C13-02's own removability clause).
  3. {@link summarizeCloudGpuCoverage} — the CLOUD-SCOPED unique-sample fold.

★ (3) IS WHY THIS FILE CONSUMES `WebGPUTimestampAccounting` RATHER THAN
SUMMING PASS TIMES. C11-140 (Batch 903) established that adding per-pass
durations double-counts every nanosecond two passes share, and that clamping
the resulting ratio to 1 hides the double-count instead of reporting it. A
cloud lane is exactly where that bites: the shadow map, the cascade atlas and
the half-res march are separate passes that a driver may overlap. So the
cloud total is the UNION of the cloud passes' intervals, folded by the same
`summarizeFrameCoverage` the whole-frame ledger uses, and the excess of the
sum over the union is surfaced as `overlapMs`. A cloud GPU claim built on the
naive sum is not falsifiable; a claim built on the union is.

The eight pass names below are the render-pass DESCRIPTOR LABELS, because
that is the key `WebGPUPerformanceManager.withRenderPassTimestamps` records
timings under. They are data, not a re-derivation: `cloud-observability
-counters.spec.mjs` reads the renderer source and fails if a label here has
no `timedCloudPass` site, or if a site's label is absent from this list.

NOTHING HERE TOUCHES WGSL. C13-39's negative result binds the campaign: WGSL
register allocation is static, so a runtime-gated shader counter still costs
occupancy on the default path. Every counter in this module is CPU-side
bookkeeping over numbers the renderer already computes, and the sample-count
fields are therefore explicitly BOUNDED PROXIES (dispatched pixels x the
resolved step budget), which is the form C13-02's own text asks for
("primary/light-march sample counts or bounded proxy counters").

@module WebGPUCloudObservability
```

Records which prior batch wired the byte-inert `timestampWrites` across the
seven cloud passes plus Sky Fill, the measurement finding behind the
union-not-sum decision, and the queue-row provenance of the removability and
bounded-proxy clauses. The rewritten docblock keeps every mechanism; this keeps
the attribution.

### `packages/engine/Source/Renderer/WebGPU/WebGPUCloudObservability.ts` — `CLOUD_ENVIRONMENT_TIMED_PASS_NAMES`

_Moved 2026-08-11._

> The environment pass the cloud deck feeds but does not own. Kept SEPARATE
> from the list above: folding it into the cloud union would attribute the
> whole sky bake to the cloud lane, which is the attribution error C11-146's
> settle-window rule exists to prevent. Reported as its own scope.

The separation is defended by a specific prior attribution error; the rewritten
comment states the consequence without citing the finding that produced it.

### `packages/engine/Source/Renderer/WebGPU/WebGPUCloudObservability.ts` — `snapshotCloudObservability`

_Moved 2026-08-11._

> `gpu` is `null` rather than a zero-filled object when the adapter has no
> timestamp support, because a zeroed timing block is indistinguishable from a
> genuinely idle lane and the fleet has already been misled by exactly that
> shape once (the settle-window attribution finding, C11-146).

The null-versus-zero choice was made after a zero-filled timing block misled a
reading. The code keeps the reason; this keeps the precedent it came from.

### `packages/engine/Source/Renderer/WebGPU/WebGPUCloudObservability.ts` — `CloudFrameCounters` (reconstruction attachment fields)

_Moved 2026-08-11._

```text
── C13-09 reconstruction attachments ──
The set is OPT-IN and default OFF, so all of these read 0 on the shipped
path. That zero is load-bearing evidence rather than an absence: Gate A
reads it as "the producer encoded nothing and allocated nothing", which is
the claim the default path makes.

── C13-10 march-emitted reconstruction ──
Gate C asks for evidence that the current work and the reconstruction
topology are what they are claimed to be. These four are the minimum that
distinguishes "the variant was requested" from "the variant actually ran",
which is the distinction a half-built pipeline would otherwise hide.
```

Two box-drawn field-group banners removed under the placement rule. The
rewritten comments keep why the zeros are evidence and why requested and
emitted are separate counters; the gate names go here.

### `packages/engine/Source/Renderer/WebGPU/WebGPUCloudNoiseResources.ts` — `(module docblock)`

_Moved 2026-08-11._

```text
Campaign 3 v2 — 3D cloud-noise texture bake (V2).

**What's shipped (V2):** allocate + bake the two tileable 3D noise textures
the volumetric-cloud raymarcher will sample, and hand back sample views + a
`repeat` 3D sampler. The bake runs ONCE (a one-shot compute encoder, like the
VolumetricFog shadow-placeholder init). C13-37 Slice B extends each level-0
bake into a complete box-filtered mip chain in that same encoder.

  • shape  — 128³ RGBA8: R = Perlin-Worley billow, G/B/A = inverted Worley at
             increasing frequency (the erosion fBm V3 combines to remap R).
  • detail — 32³  RGBA8: R/G/B = high-frequency inverted Worley.

**What's a NO-OP until V3:** nothing here samples the textures. V2 binds them
into the cloud BGL (bindings 6/7/8) but the shader keeps `noiseSource = 0` and
the live `fbmNoise`/`worleyF1` march still produces every pixel — so V2 is
byte-identical. V3 flips `cloudDensity`/`cloudBaseDensity` to sample these.

Modeled on `WebGPUVolumetricFogResources.ts` (3D `texture_storage_3d` write
target + compute bake). Uses `device.createComputePipeline` directly (the bake
is a per-context singleton, so central pipeline-cache dedup buys nothing).

@module WebGPUCloudNoiseResources
```

Preserved because the "no-op until V3" half had gone stale by the time it was
moved: `WebGPUProceduralCloudRenderer` sets `CLOUD_QF_NOISE_BAKED` whenever the
resolved tier's `noiseSource` is `BAKED`, which tiers 1 through 3 all do, so the
baked textures are sampled on the volumetric path. The rewritten docblock states
the selection rule instead of a fixed verdict.

### `packages/engine/Source/Renderer/WebGPU/WebGPUCloudDensityDomain.ts` — `(module docblock)`

_Moved 2026-08-11._

```text
Campaign 13 C13-37 — planet-stable cloud-density domains.

The baked cloud textures are periodic. Sampling every texture from aligned,
axis-aligned multiples of raw ECEF exposes that periodicity as a planetary
lattice. These campaign-fixed rotations, offsets, and non-harmonic scales
decorrelate the shape, slow-warp, and detail domains without adding a texture
tap.

Provenance: the shape and detail transforms retain the original xorshift32 +
Shoemake draws (seeds 0xc1337001/0xc1337003). The WARP transform was
re-drawn from a splitmix32 stream (state = the exported generation seed
XOR 0x5eed7a3b; 16 warm-up draws, one Shoemake uniform-quaternion draw,
one phase-offset draw) because the original adjacent per-domain seeds
produced correlated draws — all three rotations shared m22 ≈ -0.427
(Shoemake's m22 = 2*u1 - 1) — and the correlated warp orientation left a
warp-texel-lattice combination (the 32-texel granularity of the warp vector
field, ~1.03 km world period at default puff size) within 3 degrees of
screen-horizontal at the C13-37 grazing acceptance camera. That projection
read as coherent horizontal tiling: the measured 0-degree/40-52px
baked-periodicity regression tracked the warp draw across probe A/B trials,
not the shape or detail draws. The replacement warp minimizes a documented
suppression penalty — the pair-mass of visible distance rows where any
low-order warp-texel lattice combination lands an in-range screen repeat
within 8px of a metric-aligned direction — at BOTH acceptance cameras
simultaneously. All matrices are stored row-major and rounded to f32 so CPU
origin phases use the exact coefficients visible to WGSL. They are data,
not regenerated at runtime.
```

The measured evidence behind the warp re-draw, including the specific probe
signature (0-degree, 40-52 px baked periodicity) that tracked the warp draw and
not the shape or detail draws. The rewritten docblock keeps the derivation
recipe and the reason an adjacent seed is wrong; the trial record stays here.

## Scene, weather and atmospheric conditions

### `packages/engine/Source/Scene/AtmosphericConditions.js` — `(module docblock)`

_Moved 2026-08-11._

> Pattern rationale (see `migration_doc/WATER_RENDERING_DESIGN.md §5.1`):
>
> - Existing upstream Cesium APIs must keep working unchanged.
> - New code (and user code going forward) gets a single canonical home for
>   atmosphere/fog/cloud/weather/night state, grouped by domain.
> - Phase 1+ state that has no legacy backing (volumetricFog,
>   varyingAtmosphereDensity, the new lighting flags, cloud volumetrics,
>   skyAtmosphere.starModulationCurve, groundAtmosphere.perFragment) lives
>   directly on the facade.

The facade pattern was specified in a design document rather than derived in the
file. Kept because the rewritten docblock states the arrangement but cannot cite
where it was decided.

### `packages/engine/Source/Scene/AtmosphericConditions.js` — `AtmosphericConditions#clone`

_Moved 2026-08-11._

> TODO(Phase 2): full structured snapshot including Cartesian3 serialization.

The only written record that `clone()`'s scattering-only coverage is a deliberate
first cut with a defined intended endpoint, not an oversight.

### `packages/engine/Source/Scene/AtmosphericConditions.js` — `buildLighting` (`eclipseAutoExposure`)

_Moved 2026-08-11._

> C12-19 SEAM: C12-19's AE lanes have not landed, so there is no
> eclipse-aware metering window, no AE clamp and no eclipse term in the AE
> debounce yet. When they land, this flag is the switch they read: the
> false path must stay exempt from (or clamped in) the new AE lanes, and
> the true path must feed the eclipse-dimmed luminance into them. The
> transfer-function split above is the complete, shipped default path;
> everything C12-19 adds attaches to the `true` branch.

Records the contract the future auto-exposure work must honour on each branch of
`eclipseAutoExposure`. It is about work not yet done, so it has no home in the
code, but a maintainer landing those lanes needs it.

### `packages/engine/Source/Scene/AtmosphericConditions.js` — `buildLighting` (`enableSolarLimbDarkening`)

_Moved 2026-08-11._

> HONEST NOTE: at SDR defaults the bake clamps alpha to 1 and the glare
> term alone is ~0.73 over the disc, so limb darkening is arithmetically
> masked until C12-19 removes that clamp (or C12-18 moves the halo to
> the post-process chain). It ships now so C12-19 only has to remove
> clamps, not re-derive the law — and the clamp count is ASYMMETRIC:
> ONE site in `SunTextureFS.glsl` (the final `clamp(color, 0, 1)`) but
> SIX in the WebGPU CPU twin (`WebGPUEnvironmentRenderer.js` — four
> `Math.min(1, Math.max(0, …))` calls in the half-float branch plus two
> `Math.min(255, …)` in the 8-bit branch, and the 8-bit branch cannot
> carry >1 at all, so C12-19 must also force the float format there).

The exact clamp-site census (one on WebGL against six on WebGPU, plus the 8-bit
format constraint) is the actionable part. The rewritten comment keeps the
asymmetry and the format consequence; this preserves the per-call-site breakdown
and the reason the law shipped ahead of the clamp removal.

### `packages/engine/Source/Scene/AtmosphericConditions.js` — `buildLighting` (`enableEarthshinePhase`)

_Moved 2026-08-11._

> The same batch also gave earthshine a GLSL implementation for the
> first time (it had been WGSL-only, a standing Principle-5 gap the
> C11-176b row flagged). MAINTAINER RULING 2026-08-06 (R5): with both
> original reasons for the FALSE default removed (WebGPU-only,
> phase-backwards), `enableEarthshine` now defaults ON, making the
> phase-correct term live on BOTH backends at defaults. Apps opt out
> the same way they previously opted in.

The maintainer ruling that flipped `enableEarthshine`'s default, together with
the two conditions the ruling depended on. If either condition is ever reversed —
earthshine losing its GLSL path, or the phase term being removed — the default is
back in question.

### `packages/engine/Source/Scene/AtmosphericConditions.js` — `buildLighting` (`enableAngularSolarGlare`)

_Moved 2026-08-11._

> Replaces the model C11-176
> deleted, which keyed the dim to the SUN'S ELEVATION and therefore dimmed
> the whole sky uniformly (including stars 180 deg away) and did nothing
> at all in orbit.

A refuted design: elevation-keyed star dimming. The rewritten comment states why
elevation keying is wrong without recording that it was previously shipped and
removed.

### `packages/engine/Source/Scene/AtmosphericConditions.js` — `buildSkyAtmosphere` (`enableStarBrightnessModulation`)

_Moved 2026-08-11._

> C11-176 (2026-07-19) — DEFAULT FLIPPED TO FALSE FOR WEBGL PARITY.
> This shipped `true`, which silently contradicted the consuming renderer:
> `WebGPUCubeMapPanoramaRenderer.js:539-548` documents the flag as "Default
> OFF for WebGL parity" and gates on `=== true` as a fail-safe against an
> ABSENT property — shipping it present-and-true defeated that fail-safe.
> WebGL's `SkyBoxFS.glsl` is nine lines and applies NO such term, so this was
> a pure unmatched WebGPU divergence: star colour was multiplied by
> factor = 1 - smoothstep(0, 1, clamp((skyBrightness - inflection) \* steepness, 0, 1))
> which at skyBrightness = 1.0 (sun >= ~23.6 deg above the camera's local
> horizon — i.e. most of the sunlit hemisphere for an orbital camera) equals
> exactly 0.5, halving the star map.
>
> MEASURED (probe-skybox-star-modulation, camera placed along the sun
> direction so skyBrightness = 1.0): WebGPU/WebGL mean luminance 0.493,
> contrast (stddev) 0.552, and visible star pixels 21.06% -> 4.01% — five
> times fewer stars. Forcing this flag false at runtime restored 1.001 /
> 1.009 / 1.000 respectively, which is what proved causation.
>
> The capability is NOT removed — only its default. Setting it back to true
> re-enables the dim exactly as before (the probe's A/B relies on that).
>
> C12-29 S6 / ruling E3 (2026-07-25) — DEFAULT FLIPPED BACK TO TRUE, and the
> two things that made the C11-176 default WRONG are fixed rather than
> worked around:
>
> (a) NO WEBGL CONSUMER. C11-176's stated reason was "WebGL's SkyBoxFS.glsl
> is nine lines and applies NO such term, so this was a pure unmatched
> WebGPU divergence" — correct at the time. `SkyBoxFS.glsl` now carries
> the identical expression, fed by `u_starModulation` /
> `u_skyBrightness` from `CubeMapPanorama.js`, so the flag is a
> both-backend default-path multiplier and satisfies C12 exit-gate
> item 2.
> (b) THE CURVE ZEROED ORBITAL STARS. The measured C11-176 failure was at
> `skyBrightness = 1.0` for a camera "along the sun direction" — an
> ORBITAL camera on the day side, where the sky is genuinely black and
> the stars are genuinely there. `SkyBrightness.computeSkyBrightness`
> now multiplies by `computeAtmosphericColumnFactor`, which is 0 above
> the engine's own 111 km scattering shell, so that camera gets factor
> 1.0 and is byte-identical to today.
>
> The curve defaults move from the C11-176 pair {0.5, 1.0} (which merely
> HALVED the star map at full daylight — neither a correct day sky nor a
> usable totality reveal) to the derived pair below.

The full measurement record behind the default of this flag: the probe numbers
(mean luminance 0.493, stddev 0.552, star pixels 21.06% to 4.01%), the two
defects that made an earlier `false` default correct at the time, and the
superseded `{0.5, 1.0}` curve pair. The rewritten comment states the two
constraints that now hold; this preserves how they were established.

### `packages/engine/Source/Scene/AtmosphericConditions.js` — `buildClouds`

_Moved 2026-08-11._

> the legacy "procedural" name is
> historical; the kernel HAS been volumetric (HG dual-lobe + Beer-
> Powder lighting + 3D FBM density field + light-ray marching) since
> it landed.

Explains why `WebGPUProceduralCloudRenderer`, `enableProcedural` and
`clouds.proceduralCoverage` carry a name that does not describe what they do. The
rewritten comment says the two toggles are aliases but cannot say why the naming
is what it is.

### `packages/engine/Source/Scene/AtmosphericConditions.js` — `buildVolumetricFog` (`temporal`)

_Moved 2026-08-11._

> so the
> grazing-ray march cap (Batch 421) is lifted on the temporal path

The march cap the temporal path lifts is a specific pre-existing mitigation
rather than a general property of the integrate pass; recorded here so the
cross-reference survives the batch number's removal.

### `packages/engine/Source/Scene/AtmosphericConditions.js` — `buildEffects`

_Moved 2026-08-11._

> shimmer — heat-haze screen-space UV warp (Phase B, SHIPPED). Gated
> on high temperature.
> groundFog — low-altitude mist (Phase C scaffold). Gated on a small
> temperature−dewpoint spread (near-surface saturation).
> optics — cold-air ice-crystal sky overlay: 22° halo / sun-dogs /
> pillars (Phase D scaffold). Gated on sub-freezing temps.
> precipitation — rain/snow/hail particles (Phase E scaffold). Driven by
> weather.type / weather.intensity.

The scaffold-versus-shipped labels were stale at the time of the rewrite:
`groundFog` is read by `WebGPUVolumetricFogRenderer` and `WebGPUGroundFogBand`,
`optics` by `WebGPUColdOpticsEffect`, and `precipitation` by
`WebGPUSceneRendererEnvironmentalEffects`. Recorded because the labels are the
only written statement of the order the four effects were intended to land in.

### `packages/engine/Source/Scene/EclipseCloudResponse.js` — `(module docblock)`

_Moved 2026-08-11._

> So at totality the world, the sky and the ground all fell to the ~5-lux
> twilight floor while the cloud deck and every IBL-lit model stayed at full
> midday brightness. That is precisely the cross-backend / default-ON
> multiplier failure class the C12 exit gate names, except here it was
> cross-SUBSYSTEM within one backend.

Names the failure class: a default-on multiplier applied in one subsystem and
not in another within the same backend, rather than across backends. The
rewritten comment states the symptom and the four uncovered sites; this records
the class, which is what makes the same defect findable elsewhere.

The same docblock also carried the refresh-gate note:

> The input is therefore quantized the way C13-37 quantized the cloud-IBL
> revision inputs: SNAP to a grid and compare the snapped value, never a
> per-frame delta (a delta test does not accumulate, so a slow drift never
> fires). … A one-way "only re-fill when it got
> darker" gate is the stale-dark latch, and it is the mutant the spec builds.

The second sentence identifies which mutation the contract spec constructs, so a
maintainer changing the gate knows what the spec will assert against. The
rewritten comment keeps the latch description but drops the pointer to the
mutation test.

### `packages/engine/Source/Scene/CloudVolumetrics.js` — `(module docblock)`

_Moved 2026-08-11._

> A
> `CloudVolumetrics` instance is therefore structurally
> interchangeable with the globe as a config source, letting the byte-locked
> 136-float `CloudUniforms` packer and its ~50 read sites stay
> unchanged (see migration_doc/CLOUD_UNIFICATION_DESIGN.md §1.2).
>
> Instances are created lazily by {@link CloudCollection} and exposed as
> `collection.volumetric`. Nothing reads this object yet — the
> publish/consume wiring lands in a later slice of the cloud-unification epic.

Two things: the design document that ratified the field-name mirroring, and a
"nothing reads this yet" claim that was stale at rewrite time — the facade, the
provider path and the WebGPU cloud renderer all read `collection.volumetric`.
The second is kept as a warning that the docblock had drifted.

### `packages/engine/Source/Scene/CloudCollection.js` — `CloudCollection#constructor`

_Moved 2026-08-11._

> Cloud-unification epic (WebGPU volumetric via CloudCollection)
> All three additions below are opt-in, default-off, and inert on the WebGL
> renderer + when renderMode is BILLBOARD. Nothing reads them yet — the
> publish/consume wiring lands in a later slice. See
> migration_doc/CLOUD_UNIFICATION_DESIGN.md.

Same stale "nothing reads them yet" claim as `CloudVolumetrics`, plus the design
document reference. Kept so the drift is on the record rather than silently
corrected.

### `packages/engine/Source/Scene/CloudRenderMode.js` — `CloudRenderMode`

_Moved 2026-08-11._

> Only one `VOLUMETRIC` collection is primary per
> frame in the first cut (see migration_doc/CLOUD_UNIFICATION_DESIGN.md §7 Q1).

The single-primary-collection rule is a design decision recorded in the
unification design document, not derivable from the code. The rewritten comment
states the rule; this preserves where it was decided and that it was scoped as a
first cut.

### `packages/engine/Source/Scene/Weather/WeatherTypes.ts` — `(module docblock)`

_Moved 2026-08-11._

> See migration_doc/WEATHER_DATA_INGEST_ROADMAP.md.

The weather-ingest module set — `WeatherTypes`, `WeatherProvider`,
`EdrWeatherSource`, `WcsCoveragesWeatherSource` — was built against a phased
roadmap document. Recorded once here rather than in each file.

### `packages/engine/Source/Scene/Weather/WcsCoveragesWeatherSource.ts` — `(module docblock)`

_Moved 2026-08-11._

> NOTE (see migration_doc/WEATHER_DATA_INGEST_ROADMAP.md): GeoTIFF/NetCDF binary
> coverage decode is a DEFERRED follow-up — this source deliberately requests the
> CoverageJSON representation.

Records that binary coverage decode is a deferred item with a home in the ingest
roadmap, not merely an unimplemented alternative. The rewritten comment says no
binary decoder exists; this says one was planned and postponed.

### `packages/engine/Source/Scene/Weather/WeatherFieldGrid.ts` — `(module docblock)`

_Moved 2026-08-11._

> SCOPE (deliberate): this is the bounded W1 correction the Campaign 13 queue
> scopes. Composing SEVERAL overlapping regional sources with priority, and
> feathering the boundary between an observed region and its fill, are `C13-20`;
> per-tile bounds/no-data with gutters and LOD are `C13-14`. This module must not
> be presented as a substitute for either.

The two out-of-scope items have queue rows that own them. The rewritten comment
keeps the scope boundary but cannot name the rows, so the pointer lives here.

### `packages/engine/Source/Scene/Weather/WeatherMapSeam.ts` — `(module docblock)`

_Moved 2026-08-11._

> SCOPE (deliberate): this is the bounded stopgap the Campaign 13 queue scopes
> for the CURRENT global map. It does NOT introduce the globe-quadtree weather
> tile schema, gutters, per-tile bounds/no-data, atlas, or LOD — that is `C13-14`
> and this module must not be presented as a substitute for it.

The globe-quadtree weather tile schema is a tracked follow-up with its own queue
row, and this module is explicitly a stopgap in front of it.

### `packages/engine/Source/Scene/Weather/WeatherTypes.ts` — `WeatherField#priority`

_Moved 2026-08-11._

> C13-08 — relative precedence when several sources cover the same texel
> (higher wins). DECLARED here so the packer/provider contract carries it;
> the composition that CONSUMES it is `C13-20` and is not built yet, so a
> single field's priority currently has no effect.

`priority` is a declared-but-unread field, protected by the project's dead-code
rule. The rewritten comment says nothing composes multiple sources yet; this
names the row that will.

### `packages/engine/Source/Scene/CloudTypeProfile.js` — `CloudTypeProfile.FIBROUS`

_Moved 2026-08-11._

> A
> deep carve on top of that walks straight back into the C13-01 tour's
> "CIRRUS renders ~nothing" finding, so every row here retains more than half
> the deck's mean mass. That floor is asserted, not just intended.

The half-mean-mass floor exists because a recorded visual tour found cirrus
rendering as very nearly nothing. The rewritten comment keeps the floor and the
reason; this preserves the observation that produced it.
