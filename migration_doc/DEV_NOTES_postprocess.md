# DEV notes — post-process & effects

Comments moved out of `packages/*/Source` by the Campaign 16 comment
remediation, preserved verbatim. Format:
[DEV_NOTES_FORMAT.md](DEV_NOTES_FORMAT.md). These are historical records, not
current documentation — verify any claim here against the code before acting
on it.

### `packages/engine/Source/Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts` — `VOLUMETRIC_FOG_PARAMS_FLOATS`

_Moved 2026-08-09._

> 72 floats (288 bytes) after Batch 26 — added 8 floats at offsets 64–71
> for the C-P7-RTE altitude reconstruction (cameraAltitudeRTE +
> altitudeCurvature). See the WGSL `VolumetricFogParams` struct for
> field layout.
>
> 84 floats (336 bytes) after Session 65 Batch 44 — appended 12 floats
> at offsets 72–83 for the Phase 6c cloud-shadow uniforms:
>   72..75  cloudShadow      (enable, layerBottom, layerTop, coverage)
>   76..79  cloudWindAndTime (windDir.xy, windSpeed, time)
>   80..83  cloudDensityShape (densityMultiplier, absorption,
>                              noiseScale, _pad)
>
> 88 floats (352 bytes) after Batch 420 — appended 4 floats at offsets
> 84–87 for the Phase C ground-fog uniforms:
>   84..87  groundFog        (enabled, intensity, bandHeight, peakDensity)
>
> 92 floats (368 bytes) after Batch 431 (FOG-IBL-AMBIENT) — appended 4
> floats at offsets 88–91 for the sky-LUT / IBL fog-ambient uniforms:
>   88..91  iblAmbient       (enable, atmosphereThickness, scale, _pad)
> When `enable` (offset 88) < 0.5 the scattering kernel takes the
> existing `ambientTerm = u.occlusion.y` branch byte-for-byte, so the
> OFF default consumes NONE of these floats — flag-off output is
> byte-identical to pre-Batch-431.
>
> 96 floats (384 bytes) after Batch 435 (FOG-TEMPORAL) — appended 4 floats
> at offsets 92–95 for the integrate-pass blue-noise jitter:
>   92..95  temporal (enableJitter, frameIndex, _pad, _pad)
> When `enableJitter` (offset 92) < 0.5 the integrate pass adds NO jitter
> to the slice depth, so the OFF default integrate output is byte-identical
> to pre-Batch-435 (the jitter is the ONLY thing offsets 92–95 drive, and
> it is gated to zero on the parity path).
>
> 116 floats (464 bytes) after Batch 437 (CLOUD-SHADOWS) — appended 20 floats
> at offsets 96–115 for the HI-FI cloud shadow (sample the beer shadow map
> instead of the local-fbm approximation):
>   96..99   cloudShadowHiFi      (enable, absorption, strength, _pad)
>   100..115 cloudShadowSunViewVP (mat4 — world ECEF → sun ortho clip)
> When `enable` (offset 96) < 0.5 the scattering kernel's `sampleCloudShadow`
> takes the existing local-fbm branch byte-for-byte, so the OFF default
> consumes NONE of these floats → byte-identical to pre-Batch-437.
>
> 124 floats (496 bytes) after Batch 440 (FOG-MS) — appended 8 floats at
> offsets 116–123 for the opt-in MULTIPLE-SCATTERING octaves:
>   116..119 multiScatter      (enable, octaves, decayA, decayB)
>   120..123 multiScatterPhase (decayC, _pad, _pad, _pad)
> When `enable` (offset 116) < 0.5 OR `octaves` (offset 117) <= 1, the
> scattering kernel takes the existing single HG-phase term byte-for-byte
> (octave 1 == single-scatter), so the OFF default consumes NONE of these
> floats → byte-identical to pre-Batch-440.
>
> NEW-WEBGPU-GROUND-FOG-RENDERS-NOTHING — no growth: the ground-fog band's
> GROUND DATUM claims the first pad of the existing `altitudeCurvature` vec4
> (offset 69). It belongs with the other altitude-frame terms and the slot was
> already reserved, so the buffer size, every bind group, and the WGSL struct
> size are unchanged. Written as 0 whenever ground fog is off, so the OFF
> path's uniform bytes are identical to pre-fix.

The uniform buffer's growth ledger, block by block, with the flag-off byte-identity argument each addition was landed under. The rewritten comment states the current slot map and the general invariant; this is the only record of which block arrived when, which is what a bisect through a fog-parity regression needs.

### `packages/engine/Source/Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts` — `WebGPUVolumetricFogRenderer#_groundFogDiagnostics`

_Moved 2026-08-09._

> NEW-WEBGPU-GROUND-FOG-RENDERS-NOTHING (Batch 845) — the ground-fog band's
> SHIPPED inputs, recorded as they are packed. Batch 844 measured a rendered
> mist ~10x weaker than the band model predicted and could not tell whether
> the density was wrong or the datum was, because nothing on the frame
> reported what the shader had actually been handed. `probe-ground-fog.mjs`
> now reads these back and compares them against the CPU twin, so the same
> question is a measurement rather than an argument. Pure recording — nothing
> here is read by the render path.

Records the measurement that motivated the diagnostics block — a rendered mist about ten times weaker than the band model predicted, with no way to tell a wrong density from a wrong datum. The rewritten comment states what the field is for; this preserves the specific failure that made read-back necessary.

### `packages/engine/Source/Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts` — `WebGPUVolumetricFogRenderer#update` — froxel march distance

_Moved 2026-08-09._

> Batch 420 — `vf` is normally always defined (the AtmosphericConditions
> facade always builds `volumetricFog`), but the ground-fog-only
> activation path can technically reach here with `vf` falsy. Use
> optional chaining + the `?? default` fallbacks already present below
> so the base height-fog parameters resolve to their sensible defaults
> when only ground fog is driving the render.
>     const quality = this._resolveQuality(vf?.quality, scene);
>     const r = this._ensureResources(quality);
>
> Phase 6 audit fix — snapshot mode integration. When the snapshot
> service has frozen the scene, the integrated 3D volume from the
> previous frame is still visually correct (the camera is locked,
> sun direction is locked, density field is unchanged). Skipping

The correction of a stale claim: a prior comment on both sides asserted the ground-fog-only path capped the march to a few kilometres, and no such cap was ever written. Kept because a reader who finds the old wording in history should be able to see it was refuted, not merely reworded.

### `packages/engine/Source/Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts` — `WebGPUVolumetricFogRenderer#update` — ground-fog peak extinction, slot 87

_Moved 2026-08-09._

```text
       NEW-WEBGPU-GROUND-FOG-RENDERS-NOTHING — the value is now DERIVED
       from meteorological visibility (Koschmieder, see
       `GROUND_FOG_PEAK_EXTINCTION`) rather than tuned. Batch 421's
       1.2e-4 was tuned against a whiteout that was DENSITY-INDEPENDENT
       (the pre-421 integrate took a degenerate `select(scattered ×
       sliceThickness, …)` branch for optical depth < 1e-6, which is
       exactly what the then-always-zero ground-fog density produced),
       so it never measured this coefficient. 1.2e-4 is 32 km of
       visibility — clear air, and under the 8-bit floor of a frame.
    const groundFogIntensity =
```

The refuted derivation of the peak extinction: the earlier 1.2e-4 was tuned against a whiteout that turned out to be density-independent, because the integrate pass took a degenerate branch below an optical depth of 1e-6, which is exactly what an always-zero ground-fog density produces. The code now states only that the value is derived and must not become a literal.

### `packages/engine/Source/Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts` — `WebGPUVolumetricFogRenderer#update` — MS optical-depth scale, slot 122

_Moved 2026-08-09._

> ONE HOME: this reference MUST be the same `GROUND_FOG_PEAK_EXTINCTION` that
> slot 87 carries (line ~1353) — the WGSL injects `groundFogIntensity ×
> peakDensity × exp(-h/bandHeight)`, so the densest froxel IS slot 85 × slot
> 87. Batch 843 re-derived the constant (Koschmieder, 3.912/2000) at slot 87
> but left a second copy of the refuted 1.2e-4 here, which overstated the
> scale 16.3x and pinned the MS lift at the slot-121 clamp across the whole
> band instead of only its core. Do not re-introduce a literal.

The measured magnitude of the second-copy defect — a scale overstated 16.3x, pinning the multiple-scattering lift at the slot-121 clamp across the whole band. The rewritten comment carries the one-home constraint without the number.

### `packages/engine/Source/Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts` — `WebGPUVolumetricFogRenderer#update` — compute-pass encoder choice

_Moved 2026-08-09._

```text
Batch 420 — PRESENT-PATH FIX. Record the compute passes into the
MAIN frame command encoder when one is active, instead of creating a
private encoder and submitting it mid-frame. The mid-frame
`device.queue.submit()` of a private encoder splits the frame's GPU
work across two command buffers; the canvas write that the
`composite()` pass records into the main encoder afterward was being
lost (the magenta present-path probe showed 0% reaching the canvas,
while ProceduralClouds — which records entirely into the main encoder
and never submits mid-frame — reached the canvas at ~87%). Recording
the compute into the main encoder keeps the whole fog pipeline
(compute → composite → present) in a single ordered command buffer,
matching the proven ProceduralClouds path. Falls back to a private
encoder + immediate submit only when no main encoder exists (test
harnesses that bypass `beginFrame`).
```

The present-path measurement: a magenta probe showed 0% of the fog reaching the canvas through a privately-submitted encoder against about 87% for a renderer recording entirely into the main encoder. The code states the constraint; the numbers are the evidence for it and exist nowhere else.

### `packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessPipeline.ts` — (module docblock) — TAA pipeline order

_Moved 2026-08-09._

> 4. TAA (Audit B.16, Batch 155 — runs in linear/HDR domain BEFORE
>    Tonemap. NEW-TAA-PIPELINE-ORDER-RECONCILE (Batch 290) — RESOLVED:
>    pre-tonemap (linear/HDR) is the CORRECT placement and the existing
>    clamp constants already suit linear input. Rationale:
>      • TAA.wgsl's resolve does its OWN reversible tonemap-weighting
>        (`tonemapWeight` = c/(1+luma), the Karis HDR anti-firefly
>        map [0,∞)→[0,1)) before the neighborhood-AABB clamp + blend,
>        then `inverseTonemapWeight` = c/(1-luma) to recover HDR. That
>        weighting is well-defined ONLY for linear/HDR input: on
>        already-tonemapped SDR [0,1] the inverse divides by (1-luma)
>        which → 0 / negative as highlights approach luma=1, yielding
>        Inf/NaN. So the clamp domain is the tonemap-WEIGHT space, not
>        raw HDR — the constants (3×3 AABB, 0.1 blend, 0.13 normal-
>        divergence, 0.1 motion-length gate) are already domain-correct
>        and need NO retune for linear input.
>      • Running TAA post-tonemap would double-apply a tone curve
>        (display tonemap, then the internal Reinhard weight) and break
>        HDR history accumulation — the 8/16-bit history would clamp
>        highlights the tonemapper hadn't yet rolled off.
>      • WebGL Cesium has no built-in TAA stage, so there's no upstream
>        reference that contradicts the linear-domain placement; the
>        decision rests on the resolve shader's own math + standard
>        HDR-resolve practice (UE/Frostbite resolve in linear with a
>        reversible weight).
>    History buffers therefore use `_intermediateFormat` (rgba16float
>    in HDR) — see addTAA / NEW-POSTPROCESS-HDR-INTERMEDIATES.)

The full decision record for resolving TAA before the tonemap, including the point that WebGL Cesium has no built-in TAA stage, so no upstream reference contradicts the linear-domain placement and the decision rests on the resolve shader's own math. That last observation is a cross-backend divergence with no local consequence, and the rewritten docblock does not carry it.

### `packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessPipeline.ts` — `WebGPUPostProcessPipeline#execute` — single-pass stage targets

_Moved 2026-08-09._

```text
Batch 110 (HDR fix) — every single-pass stage's pipeline is
compiled with `targets: [{ format: _intermediateFormat }]` (see
`_compileStage` callers). When HDR is on, intermediateFormat is
`rgba16float` while the canvas swap chain stays at the canvas
format. Writing the LAST stage straight to `destView` (canvas)
would produce a pipeline-vs-attachment format mismatch and the
canvas would render black with a validation warning.

Fix: every single-pass stage writes to a ping-pong view (which
matches `_intermediateFormat`), and an extra identity-blit at
the end downconverts to `destView` (canvas format). The blit is
a single fullscreen-triangle pass with no uniforms — cheap. In
SDR mode `_intermediateFormat === canvasFormat` so the blit is
an over-call, but the cost is negligible compared to one stage's
worth of fragment shading.
```

The failure mode behind the final identity blit: a pipeline compiled against `_intermediateFormat` writing straight to the canvas view is a format mismatch, and the canvas renders black with a validation warning. The rewritten comment keeps the constraint; this keeps the symptom, which is what someone debugging a black canvas will search for.

### `packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessStageCollection.ts` — `getWebGPUPostProcessCache` — tonemap default

_Moved 2026-08-09._

```text
Session 65 cont. fix — default to FALSE to match WebGL's
`PostProcessStageCollection` (line 57: `tonemapping.enabled =
false; // will be enabled if necessary in update`).

Previously defaulted to true, which caused the Tonemap stage to
run with Reinhard + sRGB encode on every frame on the bgra8unorm
SDR pipeline. The result: globe imagery (linear 0.1, 0.2, 0.4)
got tonemapped to (~0.725, 0.831, 0.902) before reaching the
canvas — root cause of NEW-VR2-3 "imagery wash-out" (Session 65
triage). Verified via a debug-return probe: globe shader emits
(0.1, 0.2, 0.4); canvas reads back (185, 212, 230) ≈ same
x/(x+0.087) Reinhard + pow(., 1/2.2) curve.

Cesium's WebGL path tonemap.enabled flips to true only when
`useHdr === true` (PostProcessStageCollection.update line 575).
The sync layer below honors that via the `_tonemapping.enabled`
read — but if the WebGL collection has never been touched
(e.g., the WebGPU FR for POST_PROCESS_COLLECTION runs before
PostProcessStageCollection's constructor finishes setting
`_tonemapping`), the cache stays at this default. False matches
SDR-by-default; HDR turns it on via the cache.tonemappingEnabled
read below.
```

The measurement that settled the tonemap default: globe imagery emitted at linear (0.1, 0.2, 0.4) read back from the canvas as (185, 212, 230), matching an x/(x+0.087) Reinhard followed by a 1/2.2 encode. The rewritten comment states the rule and the approximate result; this preserves the probe readings and the exact upstream line references.

### `packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessStageCollection.ts` — `configureWebGPUPostProcessPipeline` — auto-exposure opt-in

_Moved 2026-08-09._

```text
--- Auto-exposure: match WebGL (NEW-WEBGPU-SKYBOX-HDR-FAINT-STAR-PARITY,
    Batch 364) ---
WebGL only runs the auto-exposure reduction when the user opts in
(`PostProcessStageCollection._autoExposureEnabled`, default false).
`addAutoExposure` is wired unconditionally on WebGPU (B.14) and
`WebGPUAutoExposure.enabled` defaults true, and nothing here synced the
flag down — so WebGPU auto-exposed EVERY frame. On a near-black HDR
night sky the adaptive exposure collapsed the whole frame to black
(diag-stars-hdr-autoexposure: maxLum 0 with AE-on vs 761 / 5 saturated
bloom-feeding star points with AE-off), crushing the bright catalog
stars and their bloom halos. Honor the same opt-in flag WebGL uses so
the two backends expose identically by default; the always-on B.14
behavior (SDR day/night recovery) is itself a WebGL divergence and is
dropped in favor of parity. Users who set `autoExposure = true` get the
adaptive path on both backends.
```

The measurement behind honouring WebGL's auto-exposure opt-in: on a near-black HDR night sky the adaptive exposure collapsed the frame to a maximum luminance of 0, against 761 and five saturated bloom-feeding star points with it off. Also records that the always-on behaviour was itself a WebGL divergence that was dropped in favour of parity.

### `packages/engine/Source/Renderer/WebGPU/WebGPUBloomEffect.ts` — `BloomConfig` — per-layer reflective bloom

_Moved 2026-08-09._

```text
─────────────────────────────────────────────────────────────────
FUTURE WORK — per-layer reflective bloom (orbit polish §13.x)
─────────────────────────────────────────────────────────────────
The bloom bright-pass currently runs a SINGLE contrast/brightness
curve over the composite scene color. Real-world bloom is camera-lens
light bleed proportional to per-surface RADIANCE, which varies
sharply by material type:
  - Ocean: high specular at sun-glint angles, low diffuse →
    bright tight glint that SHOULD bloom even at orbit.
  - Clouds: high diffuse reflectance (albedo ~0.7-0.9) → soft
    wide bloom across the cloud band.
  - Land terrain: mid diffuse reflectance (~0.15-0.35) → subtle
    bloom only on direct sun-facing slopes.
  - Snow / ice: very high diffuse (~0.85) → strong bloom.
  - Atmosphere haze (Rayleigh): wavelength-dependent → blue
    channel blooms more than red (matches dusk sky reads).

Implementing this requires the model + globe fragment shaders to
export a separate "bloom contribution" channel (similar to how
they already export velocity for TAA), feeding a multi-channel
bright-pass that integrates contribution-weighted luminance per
material type. The infrastructure for additional FS output
channels exists (velocity texture) but per-material bloom-weight
tables would be a new design.

Tracked in `migration_doc/DEFERRED_WORK.md::
NEW-ORBIT-PER-LAYER-REFLECTIVE-BLOOM` for the next celestial /
atmosphere sprint.
```

A deferred design with its backlog id and its per-material albedo estimates. The rewritten comment keeps the physics and the reason it is not implemented; this keeps the tracker pointer so the ledger row and the code can still be joined up.

### `packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js` — `createEffectsBindGroup` — clipping-polygon atlas dimension

_Moved 2026-08-09._

```text
      const usedCount = Math.min(extentsCount, CLIPPING_POLYGON_EXTENTS_MAX);
Atlas grid math MUST mirror `PolygonSignedDistance.wgsl:53-56`
— the SDF compute pass writes its atlas using the FULL
  dim = (extentsCount > 2) ? ceil(log2(extentsCount)) : extentsCount
formula, NOT the capped count. Batch 163 fixes a Batch 160 bug
where `dim` was derived from `usedCount`: in scenes with > 8
merged-extent groups the SDF compute writes (say) a 4×4 atlas
but we'd publish `invDim = 1/3`, sampling the wrong slots for
every region. The UBO array is still capped at
`CLIPPING_POLYGON_EXTENTS_MAX`, so regions ≥ 8 simply don't
clip — but regions 0..7 now sample at the correct slot.
```

A refuted derivation: deriving the atlas dimension from the capped `usedCount` rather than the full extents count publishes a wrong `invDim` and makes every region sample the wrong slot once there are more than eight merged-extent groups. The code states the rule; this records the shape of the bug it came from.

### `packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js` — `createEffectsBindGroup` — effects bind-group cache

_Moved 2026-08-09._

> C-R11-EFFECTS-BGL-COLLECTION-CACHE (Batch 55):
>
> Build the resource tuple from the resolved-or-placeholder views/
> samplers/buffers. Then cache the (UBO + GPUBindGroup) pair under a
> stable owner/resource identity. Camera, edge, and viewport values live
> only in the bounded slot bytes; they never become permanent cache keys.
>
> Why this works for the per-tile globe path: every tile in a frame
> shares the same shadowMap, clippingPlanes collection, atmosphere
> LUT views, csm resources, and `cameraInPlaneSpace = uniformState.
> cameraPosition` (globe modelMatrix is identity). All ~200 tiles in
> a frame therefore produce the same key → 1 cache entry, written
> ONCE on the frame's first call. The previous code allocated 200
> GPUBuffers + 200 GPUBindGroups + ~600 GPUTextureViews per frame.
>
> Why correctness holds when content varies (model path, non-identity
> modelMatrix): distinct byte payloads used during the same frame acquire
> distinct slots. On a later frame those slots can be rewritten, because

The allocation measurement behind the cache: roughly 200 GPUBuffers, 200 GPUBindGroups and 600 GPUTextureViews per frame on the per-tile globe path before it existed. The rewritten comment keeps the correctness argument; the count is the reason the cache is worth its complexity.

### `packages/engine/Source/Renderer/WebGPU/WebGPUTAAEffect.ts` — `WebGPUTAAEffect#_depthSampler`

_Moved 2026-08-09._

> Batch 244 — dedicated NEAREST sampler for the depth binding.
> WebGPU forbids TextureSampleType::Depth + a Filtering sampler in
> the same static texture/sampler pair; TAA_Pipeline creation failed
> on exactly that for the effect's whole dormant life (surfaced on
> first activation, NEW-TAA-EFFECT-NEVER-ADDED). NEW-4-B (Batch 66)
> pattern, same as WebGPUGlobeDepth / WebGPUDebugDepthOverlay.

Records that the TAA pipeline failed creation for the effect's entire dormant life on a depth-plus-filtering-sampler pairing, and that the failure only surfaced on first activation. The rewritten comment states the WebGPU rule; this is the record that an untested effect can carry a fatal defect indefinitely.

### `packages/engine/Source/Renderer/WebGPU/WebGPUTAAEffect.ts` — `WebGPUTAAEffect#_resolveCount`

_Moved 2026-08-09._

```text
Batch 244 (NEW-TAA-EFFECT-NEVER-ADDED) — debug-only resolve counter.
Counts how many times the temporal-resolve render pass was actually
ENCODED (i.e., past every early-return guard in `execute()`).
Incremented under a debug pragma, so production builds report 0 via
`getStatistics().resolveCount`; unminified builds let probes assert
the resolve stage runs (vs. the pre-Batch-244 dormancy where
`_taaEffect` was never instantiated at all).
```

Explains what the debug resolve counter was added to disprove — a dormancy in which the effect was never instantiated at all, so no pass ran. The counter's value is only interpretable against that history.

### `packages/engine/Source/Renderer/WebGPU/WebGPUVolumetricFogResources.ts` — `buildVolumetricFogResources` — composite depth binding

_Moved 2026-08-09._

> Batch 420 — LATENT FIX. Was `{ sampleType: "depth" }`, but the
> renderer binds the FLOAT depth-resolve texture here (sample type
> Float), so the depth sampleType made the bind group invalid the
> first time ground fog activated this composite. Plain float texture
> matches the bound view + the WGSL `texture_2d<f32>` declaration.

One of three latent defects in this file's composite path that could not fire until ground fog first activated it. The code now states the correct binding type; this records that the wrong one sat there undetected because nothing exercised the pass.

### `packages/engine/Source/Shaders/WebGPU/PostProcess/VolumetricFogComposite.wgsl` — (module) — vertex entry point and depth decode

_Moved 2026-08-09._

> Batch 420 — LATENT FIX. This was `texture_depth_2d`, but the view the
> renderer actually binds here is the scene framebuffer's FLOAT depth
> RESOLVE texture (`SceneFramebuffer-Color_depth_resolve_ss`), which has
> sample type Float — not Depth. A `texture_depth_2d` binding made the
> composite bind group invalid ("None of the supported sample types
> (Float|UnfilterableFloat) match the expected sample types (Depth)"),
> which silently never fired until ground fog (Batch 420) first activated
> this composite. Mirror the proven ProceduralClouds path: bind depth as
> a plain `texture_2d<f32>` and read `.r`.

The full latent-defect record for the fog composite: a depth binding declared `texture_depth_2d` against a float resolve view, with the exact validation message. Kept together with the two entries below because the three defects share one cause — a shader that had never compiled at runtime.

### `packages/engine/Source/Shaders/WebGPU/PostProcess/VolumetricFogComposite.wgsl` — `vertexMain`

_Moved 2026-08-09._

> NOTE: `out` is a WGSL reserved keyword and is invalid as an
> identifier; renamed to `vout` (Batch 420 — same latent-compile class
> as the `enable` rename in VolumetricFog.wgsl; the froxel fog composite
> had never compiled at runtime until ground fog activated it).
>
> Batch 420 — use the OVERSIZED fullscreen triangle pattern proven by
> ProceduralClouds.wgsl::vertexMain (verts (-1,-1),(3,-1),(-1,3)) so the
> whole [-1,1] clip square is rasterized. The prior triangle covered the
> square's corners but its hypotenuse grazed the (1,-1) corner; the
> oversized form is the robust, canonical pattern shared with the other
> env-effect composites.

Records that `out` is a WGSL reserved keyword and that the identifier collision was a latent compile error of the same class as the depth-binding one, alongside the fullscreen-triangle correction. The code keeps both constraints without the history.

### `packages/engine/Source/Shaders/WebGPU/PostProcess/VolumetricFogComposite.wgsl` — `logDepthToEyeDistance`

_Moved 2026-08-09._

> Batch 420 — LATENT FIX. The composite previously used a perspective
> reverse-Z `linearizeDepth`, but the WebGPU renderer writes LOGARITHMIC
> depth (the same `SceneFramebuffer-Color_depth_resolve_ss` the procedural
> clouds reverse). Using the wrong decode would have mapped fragments to
> the wrong froxel depth band — visibly wrong god rays + height fog. Reuse
> the renderer-wide log-depth → eye-distance reversal (byte-compatible with
> ProceduralClouds.wgsl::logDepthToEyeDistance / csm_reverseLogDepthToEye).

The third of the same set: a perspective reverse-Z decode where the renderer writes logarithmic depth. Recorded together so the pattern — three independent defects in one never-executed shader — is visible as a pattern.

### `packages/engine/Source/Renderer/WebGPU/WebGPUSSREffect.ts` — (module docblock) — march budget

_Moved 2026-08-09._

```text
Tuning notes (Batch 136):
  - Pre-Batch-136 defaults were maxDistance=50m, maxSteps=64. The
    50m march budget rarely reached reflectors more than a few
    meters from the reflective surface — a typical aerial scene
    with an object 50-200m away from a lake produced essentially
    zero visible reflection signal. Bumping to 200m + 96 steps
    covers the typical mid-range case (urban reflective surfaces
    with buildings up to ~200m away) without a major perf hit.
  - The trade is per-frame cost: 96 steps × ~1.4-4M ray-marched
    pixels per HD frame is bounded by the GPU's texture-sample
    throughput. SSR remains opt-in (off by default), so the cost
    only applies to scenes that explicitly enable it.

```

The prior defaults and the reasoning that replaced them, including the throughput estimate that bounded the cost. The rewritten docblock states the sizing argument; this preserves the specific before-and-after numbers a future retune would want.

### `packages/engine/Source/Renderer/WebGPU/WebGPUNPROutlineEffect.ts` — `WebGPUNPROutlineEffect#execute` — encoder ordering

_Moved 2026-08-09._

```text
Slice 5c-B Batch 127 — record into the MAIN frame command encoder
instead of a separate one. Pre-fix NPR + SSR + ProceduralClouds
created their own encoder and submitted eagerly via
`device.queue.submit([encoder.finish()])`. The main encoder
(which the SceneRenderer records scene rendering + post-process
into) submits LATER at end-of-frame. GPU executes in submission
order, so post-process's blit-to-canvas overwrote env effects'
canvas writes. Recording into the main encoder makes ordering
explicit: scene → post-process → env effects, all in one stream
where later commands see prior commands' results.
```

The clearest statement of a defect class that affected three environmental effects at once: an effect that submits its own encoder eagerly has its canvas write overwritten by the main encoder's later post-process blit. The individual code comments now state the rule; this records that it was a shared failure, not a local one.

### `packages/engine/Source/Renderer/WebGPU/WebGPUGroundFogBand.ts` — (module docblock) — ground datum

_Moved 2026-08-09._

```text
(NEW-WEBGPU-GROUND-FOG-RENDERS-NOTHING)

`VolumetricFog.wgsl::densityInjection` reconstructs a froxel's `altitude` as
a height above the ellipsoid's INSCRIBED SPHERE (radius = the minimum of the
three radii, i.e. the WGS84 polar radius 6,356,752 m). That frame is chosen
so a camera over a pole can never produce a negative altitude, and it is
perfectly adequate for the base height fog, whose falloff scale is ~10 km:
the sphere-vs-ellipsoid offset just scales the density globally.

The ground-fog band's falloff scale is ~120 m, and the same offset is 21,385 m
at the equator, 10,215 m at 46.4 deg N, and 0 only at the poles. Feeding the raw
`altitude` into `exp(-altitude / 120)` therefore evaluates `e^-85` at Alpine
latitudes — a denormal (2.1e-40), and an exact f32 zero nearer the equator. The
optical depth a ray accumulated over the whole march came to ~1e-44, which left
the f32 transmittance at EXACTLY 1.0 and the in-scatter at EXACTLY 0, so the
composite's `scene.rgb * transmittance + scatteredLight` returned the scene
colour bit for bit. That is the "ground fog renders nothing / the ON frame is
byte-identical to OFF" defect, present since Phase C landed in Batch 420.

The fix is to express a GROUND DATUM in the same inscribed-sphere frame and
subtract it in the shader. The sphere-vs-ellipsoid error is common to both
terms, so it cancels exactly and the band lands on the ground it is named
for.

── What the datum is

The camera-local ground elevation: the ellipsoid's geocentric radius along
the camera's radial direction, plus the terrain height directly beneath the
camera when a terrain surface can supply one (0 = sea level otherwise). A
single scalar per frame, which is the standard cheap approximation for a
level fog layer — real radiation fog pools with a roughly flat top, so a
level band is closer to the physics than a terrain-following one. Its known
limit is a camera parked on a peak high above the valley it is looking at;
a per-froxel-column datum reconstructed from the depth buffer is the tracked
follow-up (see migration_doc/DEFERRED_WORK.md).
/
```

The full derivation of the band's no-op defect, including the follow-up it names: a per-froxel-column datum reconstructed from the depth buffer, tracked in the deferred-work ledger. The rewritten docblock keeps the derivation and drops the pointer.

### `packages/engine/Source/Renderer/WebGPU/WebGPUUserPostProcessStage.ts` — `SCHEMA_TYPE_BYTES`

_Moved 2026-08-24._

```text
B204-N1 (Batch 205) — bytes actually WRITTEN by `_packUniforms` for
each schema type. Used by the collision check to decide if a schema
entry overlaps `PASS_INDEX_OFFSET`. Note vec3 only writes 3 floats
(12 bytes) here even though WGSL aligns vec3 to a 16-byte slot — the
collision is about JS writes clobbering the pass-index slot, not
WGSL layout. So vec3 declared at offset 48 (writes [48..60)) is safe;
vec4 at offset 48 (writes [48..64)) collides with [60..64).
```

This preserves the distinction between JavaScript write width and WGSL slot size, including one safe range and one collision range.

### `packages/engine/Source/Renderer/WebGPU/WebGPUUserPostProcessStage.ts` — `SCHEMA_TYPE_ALIGNS`

_Moved 2026-08-24._

```text
B205-N1 (Batch 213) — WGSL alignment requirements per type. The
shader-side struct layout follows these rules; if the JS-declared
offset doesn't match, the JS pack writes data the shader interprets
at the WRONG offset (silent miscompare — the shader reads garbage,
the visual result is wrong but no error is thrown).
  - float: 4-byte aligned, occupies 4 bytes
  - vec2:  8-byte aligned, occupies 8 bytes
  - vec3:  16-byte aligned (WGSL pads vec3 to 16), occupies 12 bytes
          in our pack but the shader reads from a 16-byte slot
  - vec4:  16-byte aligned, occupies 16 bytes
```

This records the silent-failure symptom and the exact alignment and write-width table behind schema validation.

### `packages/engine/Source/Renderer/WebGPU/WebGPUUserPostProcessStage.ts` — `WebGPUUserPostProcessStage#_packUniforms`

_Moved 2026-08-24._

```text
B204-N1 (Batch 205) — PASS_INDEX_OFFSET is reserved for the
framework. Detect range overlap, not just an exact-offset
match: a vec4 declared at offset 48 spans bytes [48..64) and
its .w component would silently be clobbered by the pass
index write at byte 60. Same shape for vec3@52, vec2@56,
float@60, plus any out-of-range offset >=64. Skip + warn so
the schema author can move the entry to a safe offset.
```

This preserves the exact mutant an offset-equality check misses and the complete set of overlap examples.

### `packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessStageCollection.ts` — `configureWebGPUPostProcessPipeline`

_Moved 2026-08-24._

```text
C4-PLAIN-HDR-GAMMA-TAILS (a) — sync the user's tonemap exposure.
WebGL drives its tonemap `exposure` uniform from
`PostProcessStageCollection._exposure` (the `scene.postProcessStages
.exposure` setter, default 1.0). Nothing synced it to the WebGPU tonemap
stage, so exposure changes were a silent no-op on WebGPU. Mirror it here.
Default 1.0 equals the value packed at addTonemapping → byte-identical off
path. When auto-exposure is enabled the per-frame dispatch multiplies this
manual base by the adaptive multiplier (see WebGPUPostProcessPipeline), so
feeding the manual value keeps both paths correct.
```

This records the silent WebGPU no-op and its interaction with adaptive exposure; the rewritten comment states only the current data flow.

### `packages/engine/Source/Renderer/WebGPU/WebGPUAmbientOcclusionEffect.ts` — `AmbientOcclusionEffect#constructor`

_Moved 2026-08-24._

> C6-SSGI-DIFFUSE defaults (RESEARCH_R-SSGI §9).

This preserves the original research-record link. The tracked summary and current code disagree on AO intensity and resolution, so the rewritten source does not claim that every default came from that research.

### `packages/engine/Source/Scene/GBufferFramebuffer.js` — (module docblock)

_Moved 2026-08-24._

> The depth side of the prepass is intentionally NOT a separate
> texture — Slice 2's compute producer samples the SCENE depth
> attachment (via `context.depthOnlyTextureView`) so we get the depth
> data "for free" without an extra prepass render. If a future slice
> needs a separate depth attachment (e.g., for a hardware-accelerated
> early-Z prepass), it can be added here without breaking existing
> consumers.

This records the rationale for sharing scene depth instead of adding another prepass. The named view is historical; current code reads the scene framebuffer's sampleable depth view.
