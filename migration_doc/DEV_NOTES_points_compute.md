# DEV notes — point clouds, splats and compute

Comments moved out of `packages/*/Source` by the Campaign 16 comment
remediation, preserved verbatim. Format:
[DEV_NOTES_FORMAT.md](DEV_NOTES_FORMAT.md). These are historical records, not
current documentation — verify any claim here against the code before acting
on it.

### `packages/engine/Source/Scene/GaussianSplatPrimitive.js` — `hasSnapshotRenderPayload`

_Moved 2026-09-02._

> Reading `gaussianSplatTexture` unconditionally is what stalled the native
> path permanently after the `C15-G2` scene-logic extraction: the snapshot
> reached `TEXTURE_READY` with no texture by design, so the guard fired on
> every frame forever, the sort was never scheduled and `commitSnapshot`
> never ran. Keep this predicate backend-aware — it is the one readiness
> check in the shared half that cannot be written in terms of WebGL objects.

Kept because it names the specific extraction that caused the stall, which
the rewritten comment generalizes away; a future refactor of the scene-logic
split should know this predicate is where that class of regression showed up
before.

### `packages/engine/Source/Scene/GaussianSplatPrimitive.js` — `hasDrawableResult`

_Moved 2026-09-02._

> Backend-neutral answer to "has this primitive produced a drawable result
> yet?" — the question `!defined(this._drawCommand)` used to stand in for.
>
> `NEW-SPLAT-PENDING-WORK-DRAWCOMMAND-PROXY`: `_drawCommand` is built only by
> {@link GaussianSplatPrimitive.buildGSplatDrawCommand}, which `C15-G2` gated
> off on native backends, so on WebGPU the old term was PERMANENTLY true. It
> fails toward doing more work rather than less, so it was never a stall —
> but it made the settled-scene early return structurally unreachable,
> costing a `Matrix4.clone`, a `Matrix4.multiply` and
> `shouldStartSteadySort`'s two `Cartesian3` deltas on every frame of a scene
> that has stopped moving.

Kept because the specific cost (one clone, one multiply, two deltas per idle
frame) is the measured reason the old WebGL-shaped proxy was worth replacing,
and that number has no home in the rewritten comment.

### `packages/engine/Source/Scene/GaussianSplatPrimitive.js` — `applySphericalHarmonicsBudget`

_Moved 2026-09-02._

> Backend-neutral SH budget (`C15-G5` / `NEW-SPLAT-SH-DEGREE-BACKEND-DEPENDENT`).
>
> The WebGL SH texture is `maximumTextureSize` wide and cannot be widened
> further, so above a splat count of <code>maxTex * floor(maxTex /
> dims)</code> its required HEIGHT exceeds the same limit and the snapshot
> degrades to degree 0 (base colour only) rather than crashing.
>
> A WebGPU storage buffer has no such bound, so before `C15-G5` this decision
> lived entirely inside the WebGL-only half of
> {@link processGeneratedSplatTextureData} and the two backends would have
> disagreed about the SH degree — silently, and only for clouds far larger
> than either in-tree gate asset. Both backends now take the degree from
> THIS one function, so they degrade together by construction. (WebGPU
> giving up capability it technically has is the correct trade: the row's
> whole purpose is cross-backend colour parity, and the alternative is a
> divergence that no parity gate would ever be run large enough to catch.)

Kept because it records the specific silent-divergence failure mode this
function's unification prevents — useful if a future change is tempted to
let either backend compute its own SH degree again.

### `packages/engine/Source/Scene/GaussianSplatPrimitive.js` — `processGeneratedSplatTextureData` (backend branch)

_Moved 2026-09-02; the comment's claim was also corrected in the same batch._

> ── Backend branch. Everything above ran for both backends; everything below
> constructs WebGL `Texture` objects. A native feature renderer owns its own
> GPU resources, so it gets the packed WASM buffer verbatim and no WebGL
> texture is created for it at all. `C15-G3` turns this retained artifact
> into a GPU storage buffer; until then the WebGPU splat draw is still
> absent by design, for that one remaining reason.

Kept because the claim is now FALSE and was corrected rather than merely
re-tagged: `C15-G3` landed (see `WebGPUGaussianSplatRenderer.ts`'s
`resolveSplatSource`, which reads `_packedSplatTextureData` off exactly this
retained artifact), so the WebGPU splat draw is no longer absent. The
rewritten comment states the current, still-true half only — a native
renderer gets the packed buffer verbatim and builds its own GPU resources
from it. A future reader diffing against an old copy of this file should not
mistake the archived sentence for a still-open gap.

### `packages/engine/Source/Renderer/WebGPU/WebGPUBufferPointRenderer.ts` — `BUFFER_WASM_ENCODE_THRESHOLD`

_Moved 2026-09-02._

> NEW-BUFFERCOLL-WASM-ENCODE-WIRE (Batch 272) / NEW-BUFFERCOLL-ENCODE-BENCHMARK
> (Batch 273) — minimum dirty primitive count before the position high/low lanes
> are routed through the batch RTE encode (one contiguous `batchEncodeRange`
> call: WASM SIMD kernel when the module loads, byte-identical scalar fround
> twin otherwise) instead of the per-primitive scalar `EncodedCartesian3` loop.
>
> Tuned from measurement (Batch 273), NOT assumption — see
> Tools/wasm-encode-benchmark.mjs (real-kernel CPU encode) +
> Tools/visual-regression/probe-buffercoll-encode-benchmark.mjs (end-to-end
> repack+upload, both backends). Findings:
>   - The DOMINANT win is hoisting the position encode OUT of the per-primitive
>     loop (the per-point EncodedCartesian3 65536-grid split is the bottleneck),
>     NOT WASM SIMD. The batch fround split over a contiguous Float64Array beats
>     the per-primitive scalar path by ~25-40% end-to-end at >= 1500 points on
>     BOTH backends, even with the WASM kernel dark (JS fround twin running).
>   - The real WASM kernel (Node micro-bench) adds only ~1.2x over scalar fround
>     at 10k-50k and ties at 100k — below browser measurement noise, so no
>     WASM-specific gating is warranted.
>   - Crossover: batch loses below ~750 points (fixed slice-setup overhead),
>     is marginal at ~1000, and wins reliably from ~1500 up. Absolute repack
>     time below 1500 is < 0.5 ms/frame — negligible vs the frame budget.
> 2000 sits comfortably inside the winning region with margin against noise.

Kept because the specific measured percentages, the WASM-vs-scalar ratio and
the crossover point are exactly what a future re-tuning of this threshold (or
a similar threshold on a sibling collection) needs, and re-deriving them
without re-running the two cited tools would be guessing.

### `packages/engine/Source/Shaders/WebGPU/Compute/VolumetricFog.wgsl` — `CLOUD_SHAPE_FIELD_MEAN` / `FOG_CHEAP_FIELD_MEAN` / `FOG_CHEAP_FIELD_SIGMA_RATIO`

_Moved 2026-09-02._

> CLOUD-LOW-COVERAGE-CUTOFF (fog cheap-path arm) — the distribution constants
> that let the cheap cloud-shadow field share the visible march's coverage
> response. See the long block at the gate in `sampleCloudShadow`.
>
> MEASURED, not tuned. Both numbers come from sampling the two real fields
> with the shipped arithmetic in f32:
>
>   baked shape channel (CloudNoiseBake.wgsl `valueFBM`, 4 octaves, periodic)
>     over a 60^3 grid of its full period: mean 0.43067, sigma 0.08963
>   this module's `fbm3d(p) * 0.5 + 0.5` over 96,800 samples at the real ECEF
>     magnitudes the shadow ray reaches (|samplePos| * 0.0003 ~ 1913, so the
>     f32 hash quantisation the GPU sees is included): mean 0.49976,
>     sigma 0.12063
>
> `FOG_CHEAP_FIELD_MEAN` is 0.5 EXACTLY rather than the measured 0.49976: a
> value fBM of uniform hashes is symmetric about 0.5 by construction, so 0.5
> is the structural value and the residual is sampling noise.
> `FOG_CHEAP_FIELD_SIGMA_RATIO` is 0.12063 / 0.08963.
>
> The ratio is EMPIRICAL and cannot be predicted from octave weights alone
> (those give only 1.065): the bake's periodic `pmod` lattice at base
> frequency 2 and its different hash carry the rest.

Kept because the exact grid resolution (60^3), sample count (96,800) and the
ECEF magnitude sampled are the reproduction recipe for these two constants;
the rewritten comment keeps the two measured means/sigmas but not the
sampling methodology that would let someone re-run the measurement.

### `packages/engine/Source/Shaders/WebGPU/Compute/VolumetricFog.wgsl` — `sampleCloudShadow` (coverage-gate normalization)

_Moved 2026-09-02._

> CLOUD-LOW-COVERAGE-CUTOFF — FOG CHEAP-PATH ARM.
>
> This gate used to threshold at `1.0 - <the raw requested coverage>`, on
> the claim (three comment blocks above) that it "mirrors
> ProceduralClouds.wgsl::cloudDensity shape ... so the shadows roughly track
> the visible cloud layer". Both halves of that were wrong:
>
>   1. the visible march and the IBL cube now route their gate through the
>      SHARED `cloudEffectiveCoverage` response, and this was the last raw
>      `1.0 - coverage` threshold left in the cloud-density family; and
>   2. a coverage threshold is only transferable between two density fields
>      when they have the SAME distribution, and these two do not. The
>      baked shape channel the march samples is a 4-octave periodic value
>      fBM measuring mean 0.4307 / sigma 0.0896 / max 0.7164, while the
>      local field here is `fbm3d`'s 3-octave value fBM, which is symmetric
>      about 0.5 by construction and measures sigma 0.1206 / max 0.9331 —
>      a field 35% wider and centred 0.07 higher.
>
> Feeding the same threshold to both therefore mistracks in BOTH directions:
> with the shared response applied to the march, the raw gate here shadowed
> 0.07% of ground at coverage 0.15 where the visible deck covers 2.21%, and
> 65.0% at coverage 0.55 where the visible deck covers 41.3% — worst error
> 23.9 percentage points. Fair-weather skies cast almost no fog shadow while
> mid-coverage skies cast a near-overcast one. (Every figure in this block is
> reproduced by the spec named at the end of it; run that, don't trust this.)
>
> The fix is a re-derivation, not a rescale: STANDARDISE this field onto the
> baked shape field's first two moments and then apply the shared response
> unmodified. That makes the gate's exceedance — the fraction of the deck
> that is cloud — agree with the visible march's to within 1.5 percentage
> points across the whole coverage range, and it keeps ONE definition of the
> coverage response in the engine (`CloudDensityDomain.wgsl`, prepended to
> this module by `WebGPUVolumetricFogResources`). Normalising the SAMPLE
> rather than moving the threshold also matches the smoothstep RAMP, so the
> gate's amplitude distribution tracks as well as its support.
>
> Reachability: everything from `cloudShadowEnable < 0.5` upward is
> unchanged, so a scene without volumetric clouds is byte-identical.
>
> CPU twin: `normalizeFogCheapCloudField` in WebGPUCloudDensityDomain.ts.
> Pinned by Tools/visual-regression/fog-cheap-coverage-gate.spec.mjs — do
> not edit one alone.

Kept because it records the specific refuted approach (a raw `1.0 - coverage`
threshold) and its measured error (worst case 23.9 percentage points, fair
weather reading as near-overcast) — the reason a future reader must not
"simplify" the gate back to a plain threshold. The rewritten comment keeps
the live constraint (why normalization is needed, the CPU-twin/spec pinning)
but not the magnitude of the mistake the current code no longer makes.

### `packages/engine/Source/Shaders/WebGPU/Compute/VolumetricFog.wgsl` — `densityInjection` (ground fog band datum)

_Moved 2026-09-02._

> Phase C / Batch 420 — GROUND FOG boost. When enabled, add a near-
> surface density spike that decays exponentially with height above the
> GROUND DATUM so the mist hugs the ground and fades into the normal fog
> (or clear) above the band.
> Gated behind `enabled` AND `intensity > 0` so the OFF default path is
> byte-identical to pre-Batch-420 (the `densityInjection` output is
> unchanged when `u.groundFog.x < 0.5`).
>
> NEW-WEBGPU-GROUND-FOG-RENDERS-NOTHING — the falloff argument used to be
> the raw `altitude`, i.e. the height above the INSCRIBED SPHERE the base
> height fog uses. That is 10.2 km at 46.4 deg N and 21.4 km at the equator
> even at sea level, so `exp(-altitude / 120)` collapsed to a denormal (or
> an exact f32 zero) and the accumulated optical depth left transmittance at
> EXACTLY 1.0 — the whole effect was an arithmetic no-op outside ~83 deg of
> latitude. The band is now measured from `u.altitudeCurvature.y`, the
> camera-local ground datum the CPU packs in this same frame, so the
> sphere-vs-ellipsoid offset cancels.

Kept because the measured magnitude of the original bug (an exact f32 zero
outside ~83 degrees of latitude, i.e. the feature rendered nothing almost
everywhere) is the reason the datum must stay `u.altitudeCurvature.y` and
never revert to the raw inscribed-sphere `altitude` — a future reader who
does not know the old failure mode could plausibly "simplify" it back.

### `packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts` — `packUniforms` (viewport size)

_Moved 2026-09-02._

> POINT-SPRITE-SHAPE — viewportSize must be the REAL render-target size.
> The old `uniformState._context?._canvas` read was always undefined
> (UniformState has no `_context`), so every point cloud rendered with a
> phantom 1920x1080 viewport — points came out both smaller than WebGL's
> gl_PointSize squares AND anisotropic (16:9-squished) on non-16:9
> canvases. The caller passes context.drawingBufferWidth/Height.

Kept because the measured symptom (silently wrong point size AND aspect
ratio on any non-1920x1080 or non-16:9 canvas) is the reason the caller must
keep passing `drawingBufferWidth`/`drawingBufferHeight` explicitly rather
than a future refactor trying to read them off `uniformState` again.

### `packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts` — `updateWebGPUPointCloud` (pipeline-format-invalidation block)

_Moved 2026-09-02._

> Batch 168 - velocity pipeline references the same shader module
> built against the now-invalid format; force rebuild.
> ...
> Batch 169 - the cached draw commands hold a pointer to the
> OLD pipeline. After the resolver re-runs against the new
> format the pipeline pointer changes; the command must be
> re-built so its `pipeline` field points at the live object.
> Pre-Batch-169 the command survived a format change and would
> be submitted with the stale pipeline reference (WebGPU then
> rejects the draw because the pipeline's color target format
> doesn't match the active attachment). Not user-visible because
> HDR isn't toggled at runtime, but matches the Ground{Primitive,
> Polyline} fix that landed pre-Batch-166.

Kept because it records the specific validation failure (stale pipeline
reference rejected against the new attachment format) that the `cache.command
= null` reset below exists to prevent, and names the sibling renderers
(GroundPrimitive, Polyline) that hit the same class of bug first.
