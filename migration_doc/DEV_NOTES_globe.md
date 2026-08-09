# DEV notes — globe & imagery

Comments moved out of `packages/*/Source` by the Campaign 16 comment
remediation, preserved verbatim. Format:
[DEV_NOTES_FORMAT.md](DEV_NOTES_FORMAT.md). These are historical records, not
current documentation — verify any claim here against the code before acting
on it.

Covers the WebGPU globe surface renderer and its pipeline/bind-group/texture
plumbing, the globe camera and tile uniform buffers, `GlobeTerrain.wgsl` and
the `GlobeFS`/`GlobeVS` GLSL pair, imagery reprojection on both backends,
imagery layer realization and source identity, and the ocean, water-mask and
globe-water surfaces that render with the globe.

## Globe terrain shader (WGSL)

### `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` — (default ocean and night parameter getters)

_Moved 2026-08-08._

```text
CLT-B2 — "unset" is a NEGATIVE slot, not `0.0`.

These six getters used to read `== 0.0` as "the CPU configured nothing,
substitute my built-in default". Every tunable below has a legitimate zero
(`Globe.nightIntensity = 0` is documented as "no emission"; foam threshold 0
is "foam everywhere"; darkening 0 is "no darkening"), so the zero was
UNREACHABLE and any off path that wrote 0.0 silently aliased onto default-on.
That is what made `globe.enableNightLights = false` a visual no-op on WebGPU.

The domains are all non-negative magnitudes, so the negative half-line is
unreachable from the API and carries "unset" without colliding with anything
a caller can ask for. `WebGPUGlobeTunables.GLOBE_UB_UNSET` (-1.0) is the
CPU twin of this test; the two must move together.

Default-path identity: the shipped defaults write real, positive values
(nightIntensity 2.5, fresnel 5.0, reflectivity 0.04, foam 0.35, darkening
0.6, deep colour 0.008/0.045/0.12), so both the old `== 0.0` law and this
`< 0.0` law take the pass-through arm and emit the same bits.
```

The only written record that the six getters once read `== 0.0` as the unset marker, and that the collision made `globe.enableNightLights = false` a visual no-op on WebGPU. The rewritten comment states the negative-slot rule as a standing constraint; this preserves the failure that produced it and the default-path identity argument.

### `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` — `czm_gammaCorrect`

_Moved 2026-08-08._

```text
Batch 54 — match the GLSL `czm_gammaCorrect` (gammaCorrect.glsl) which
is GATED on `#ifdef HDR` and acts as a NO-OP in the default SDR path.
The pre-Batch-54 WGSL unconditionally applied `pow(c, 2.2)` (sRGB →
linear decode), making every globe fragment ~4.2x darker than WebGL
— verified via probe-saved-view.mjs (meanBrightnessRatio 4.221 on
default-3D between WebGL and WebGPU).
```

Keeps the measured size of the unconditional-decode error — meanBrightnessRatio 4.221 on default-3D — and names the probe that read it. The rewritten comment keeps the ~4.2x figure but not the instrument.

### `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` — `computeAtmosphereScatteringGround` (module block)

_Moved 2026-08-08._

```text
The previous WGSL fragment-side `computeAtmosphereColor` used fixed
(0.18, 0.38, 0.72) skyBlue scaled by 0.3 — qualitatively wrong magnitude
AND missing the view-direction-dependent thickness integral. That made
the fog color collapse to ~(0.04, 0.07, 0.10) at all view angles, which
in turn dragged imagery toward the same dark blue at low altitudes
(the Cluster 2b "dark-blue close-zoom" symptom).
```

Records the specific refuted substitute for the scattering integral, its constants, and the symptom it produced. The rewritten comment says only that a fixed tint is not an adequate substitute.

### `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` — `raySphereIntersectionInterval`

_Moved 2026-08-08._

```text
Defensive correctness fix only: this did NOT visibly resolve the WGS84
orbit catastrophe on its own (the per-vertex-vs-per-fragment ground-
atmosphere switch did — see fragmentMain below). WebGL has the same
imprecision in its `czm_raySphereIntersectionInterval` and renders
correctly via per-fragment scattering at orbit. We keep this fix
because (a) it's correct, (b) it's cheap, and (c) ray-sphere
intersection shows up in other render paths (sky atmosphere LUT,
volumetric clouds, planetary collision) where the precision loss
could matter independently.
```

A negative result: the precision fix did not, on its own, resolve the orbit rendering. Worth keeping because the fix looks causal next to the symptom it did not cause.

### `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` — `CameraUniforms.lighting`

_Moved 2026-08-08._

```text
      formula `mix(1, clamp(NdotL × 5 + 0.3, 0, 1), fade)` (CLT-B4, CO-18;
      it was a hardcoded `NdotL × 0.88 + 0.12` aesthetic before that).
  w = zoomedOutOceanSpecularIntensity (GLOBE-POLAR-STRETCH-POLISH).
      Mirrors WebGL's `u_zoomedOutOceanSpecularIntensity`, which
      `Globe.beginFrame` sets per-frame: 0.4 when showGroundAtmosphere
      (the default), 0.5 otherwise, 0.0 outside SCENE3D. Consumed by
      `computeEnhancedOcean`'s specular surfaceReflectance. (This slot
      was once reserved for a DAYNIGHT_SHADING `fade` bridge; CO-18 built
      that bridge as `TileUniforms.lightingFade` instead, because the fade
      is a per-tile-UB scalar in the same pass as `nightFade*Distance`.)
```

Records that the `.w` slot was once reserved for a day/night fade bridge and that the bridge was built as `TileUniforms.lightingFade` instead, plus the hardcoded `NdotL × 0.88 + 0.12` ramp that preceded WebGL's law. The rewritten comment states where the fade lives without the history of the alternative.

### `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` — `applyImageryLayer`

_Moved 2026-08-08._

```text
Pre-Batch-79 the WGSL used a straight `mix(prev, color, srcA)` +
`max(prevA, srcA)` formula. That was algebraically identical to the
OVER composite when `prevAlpha = 1` (Batch 69 proved this pixel-
equivalent at the default midlat-mid view), but diverged on
multi-frustum subsequent passes where the first imagery layer hits
with `prevAlpha = 0` and `srcA < 1`. Under straight-mix the first
contribution was attenuated by srcA; under OVER it contributes at
full brightness with `outAlpha = srcA`. Batch 68 attempted this
switch and saw an apparent 1.09 → 7.01% regression that turned out
to be probe-level clock-noise (Batch 69). With clock pinning landed
in Batch 70 the regression test is now reliable, so the switch is
applied here.
```

The straight-mix composite and the probe episode that mis-measured its replacement as a regression before clock pinning landed. Kept because the apparent 1.09 -> 7.01% reading was instrument noise, not a real divergence, and that is the kind of result worth not re-deriving.

### `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` — `applyImageryLayer` (bounds coordinates)

_Moved 2026-08-08._

```text
HISTORY: Session 65 Batch 8 fed geoUV (geographic-V) to the texCoordsRect
test to fix "dark blue at close zoom." That was correct ONLY under the then
single-texture model (one geographic reprojected texture, but
`useWebMercatorT` still true → Mercator-V test vs a geographic-bound rect
zeroed the mask → imagery-base fallback = the dark blue). Batch 65's
dual-texture model superseded it: the rect now tracks the bound texture's
space, so the correct test V is the per-layer selected V (= the sample V),
NOT a global geographic-V. For `useWebMercatorT=false` layers `selectLayerUV`
returns geoUV, so this is byte-identical to Batch-8 on the polar/reprojected
tiles that were the dark-blue victims — dark-blue cannot return. See
migration_doc/IMAGERY_PROJECTION.md "Imagery alpha-mask V-space".
```

The full account of why the alpha-mask test V was geographic under the single-texture model and why the dual-texture model made the per-layer selected V correct. The rewritten comment states the current law and the dark-blue failure mode, but not the two-model history behind it.

### `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` — `computeDayNightFade` / `computeDayNightDiffuse`

_Moved 2026-08-08._

```text
there. MEASURED at pixels by `probe-daynight-terminator-law.mjs` run 2 (tip
`679cbf5173`): lane A read WebGL 0.012 vs WebGPU 0.496 day-fade at the
terminator, shapes classified `glsl-law` vs `wgsl-offset-law`.
```

The pixel measurement behind the ramp-law reconciliation, with the probe, the run and the tip that produced it. The rewritten comment keeps the 0.496-against-0.012 figure but not its provenance.

### `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` — `fragmentMain` (lighting and shadow receive)

_Moved 2026-08-08._

```text
   `clamp(NdotL × 5 + 0.5, 0, 1)` and drove the diffuse from
   `mix(0.025, NdotL × 0.88 + 0.12, dayFade)` with no camera-distance term.
   Measured, not inferred: `probe-daynight-terminator-law.mjs` run 2 read a
   +0.485 terminator delta (lane A) and a night/day luminance ratio of
   0.312/0.0896 against WebGL's 1.000/0.300 (lane D).
```

The collapsed single-ramp expression and the luminance ratios measured against WebGL. Kept because it names the exact wrong expression, which a future reader could otherwise reintroduce as a simplification.

### `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` — `fragmentMain` (far-from-ground drape)

_Moved 2026-08-08._

```text
The previous Batches 30+31 fix capped the per-channel radiance
at 1.5 then scaled by 0.15 to perceptually match WebGL at
orbit altitudes. The root cause was NOT the ray-march — the
WGSL `computeScatteringGround` port is byte-equivalent to
`AtmosphereCommon.glsl::computeScattering`. The over-
accumulation came from the WGSL VS always tracing toward the
packed sun direction, while WebGL (with the default
DynamicAtmosphereLighting.NONE) substitutes
`normalize(positionWC)` per-vertex — every vertex sees a
"straight up" light ray, so optical depth stays uniform and
the integrated radiance lands in the 0.3-0.6 range that
matches real orbital photography.
```

The refuted cap-and-rescale correction (1.5 cap, 0.15 scale) and the reasoning that located the real cause in the light direction rather than the ray-march. The rewritten comment says the branch carries no empirical correction factors and why; this preserves the one that was tried.

## Globe surface renderer and pipelines

### `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts` — `GlobeEffectsHandleSnapshot`

_Moved 2026-08-08._

```text
C9-13 (NEW-GLOBE-EFFECTS-PER-VIEW-PREPARED-HANDLE) — the terrain-global
group-3 effects state (shadow receive / CSM / atmosphere LUT / clipping
planes+polygons) is identical for every selected tile in a frame/view, yet
the pre-C9-13 path re-resolved and re-packed it once per tile per imagery
pass (~200 tiles → ~200 identical repacks: a 480-byte `fill(0)`+repack,
`computeClipPlaneDPrimes`, 22 WeakMap identity lookups, 3 string concats, and
several wrapper-object literals). This snapshot records the exact inputs that
determine those bytes and the placeholder-vs-active decision, so tiles 2..N
reuse one prepared `GPUBindGroup`. The memo lives on the CONTEXT (not the
per-GPUDevice renderer instance): post-Sol multi-context work shares pooled
devices across Scenes, so a renderer-scoped memo keyed by frameNumber alone
would alias Scene A's camera bytes into Scene B (see the same rationale in
`WebGPUEffectsBindGroup.js` `_ensureEffectsBgCache`, and the primitive
precedent `_getOrCreateSharedPrimitiveEffectsBG`).
```

Kept for the measured cost of the per-tile repack this memo replaced — the
480-byte fill, the 22 WeakMap lookups and the ~200-tile multiplier are the only
record of what the memo is worth, and they have no place in a comment that
states the current arrangement.

### `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts` — `WebGPUGlobeSurfaceRenderer.pipeline`

_Moved 2026-08-08._

```text
C-R7-RENDERER-MIGRATION (Batch 75), repaired 2026-08-01 — these four
legacy accessors named a semantic variant ("uncompressed, with normals,
opaque, no extra defines") but looked it up through a hardcoded key
string. `831e2f189b` (2026-04-04) inserted the webMercatorT marker as a
fourth letter, so `UNO_28|0` and its three siblings stopped matching any
key the producer writes and all four returned `null` unconditionally for
~15 months, with no caller and no signal.

They now resolve through `findGlobePipelineVariant`, which parses the key
grammar from its single owning module and compares only the axes these
getters actually mean:

  quantized / normals / opaque / no clip-distances / cull enabled /
  no active shader defines

Two axes the old keys pinned by accident are deliberately left FREE:
  - webMercatorT — never part of any getter's name; pinning it is the
    precise bug being fixed.
  - stride — varies with the terrain encoding actually loaded (12/16/
    20/24/28/32/36/40+ bytes depending on quantization, webMercatorT,
    normals and DP-H25 geodetic surface normals), so the single
    hardcoded value was never more than a guess at one encoding.

SHAPE CHANGE, deliberate: several materialized variants can satisfy one
getter. The lexicographically-smallest key wins so repeat calls are
stable rather than load-order dependent. Callers needing every match
should use `listPipelineVariants()`. Still returns `null` when no
matching variant has materialized — unchanged, and now for the honest
reason rather than because the key could never match.
```

Kept because it names the exact commit (`831e2f189b`) and the exact stale key
(`UNO_28|0`) behind a reader/producer key-grammar divergence that returned
`null` silently for fifteen months — the failure mode `listPipelineVariants`'s
`fields: null` row now exists to expose. The rewritten comment states the
selection semantics, not the incident.

### `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfacePipelines.ts` — `buildPipelineDescriptor`

_Moved 2026-08-08._

```text
GLOBE-UNDERGROUND-COLOR — the central pipeline cache keys on the
descriptor NAME (see `generateCacheKey` in WebGPURenderPipelineCache:
`parts = [descriptor.name]` when no variant is passed, and the globe's
`resolveGlobePipelineEntry` passes none). The no-cull (C-R1 underground /
provider-cull-off) variant previously differed ONLY in `primitive.cullMode`
with an identical name, so it ALIASED to whichever same-named pipeline
resolved first — usually the above-ground cull-back one. Symptom: with the
camera underground the terrain-surface back-faces never rasterized (only
the skirt walls, whose winding faces the camera, were visible) and the
result was nondeterministic across sessions (a creation race decided which
cull mode won). The `, noCull` marker keeps the central-cache key distinct,
matching the dob/tbf/cd/img labels that already follow this convention.
```

Kept for the visual fingerprint of a globe pipeline-cache aliasing bug — only
the skirt walls rasterize under an underground camera, and the outcome flips
between sessions on a creation race. The central cache now folds shader-module
identity, so the aliasing itself is structurally impossible; the symptom
description is the part still worth recognising.

### `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfacePipelines.ts` — `buildPipelineDescriptor`

_Moved 2026-08-08._

```text
NEW-WEBGPU-PIPELINE-KEY-LOG-DEPTH — `logDepthOn` selects a DIFFERENT
GlobeTerrain module (the `//>>ifdef LOG_DEPTH` frag_depth branch) through
the `defines` bitmask above, but the central cache's `generateCacheKey`
hashes only this NAME plus structural fields (multisample / depth format /
target signature / vertex layout) — it never reads `vertex.module`,
`fragment.module`, `entryPoint`, or the define mask. Without this marker the
log-depth and hyperbolic globe pipelines collapse onto one key and whichever
materialized first silently serves both. Same bug class as the `noCull`,
`imagery4` and `enhOcean` markers above. `ld=` matches the spelling already
used by Ocean / Cloud / FlowField / ComputeInstance / GaussianSplat.
Also covers the PICK descriptor (its name derives from this one) and the
env-map CAPTURE descriptor, both of which route through this function.

The RENDERER-LOCAL caches are already safe on this axis — Batch 788 moved
their key format into `buildGlobePipelineCacheKey`, which ends every key
with `|${defines.toString(16)}`. This marker closes the CENTRAL cache only.

NEW-WEBGPU-PIPELINE-KEY-DEFINE-AXIS-GENERAL (2026-08-06) — the paragraph
above describes the PRE-FIX central cache. `generateCacheKey` now folds
shader-module IDENTITY (`sh:` segment) unconditionally, so this marker —
and `noCull` / `imagery4` / `enhOcean` / `capture` — are no longer what
stands between the two globe modules and a collision. They are retained as
defense-in-depth and, more usefully, as human-readable provenance in
`describeCacheKey()` / `listPipelineVariants()` / devtools labels: a bare
`sh:41.…` tells you the variants are separate but not WHICH variant a row
is. Do not remove them; do not treat a new one as mandatory.
```

Kept because it records why the whole descriptor-name marker fleet exists: the
central cache once hashed the descriptor name and structural fields only, so
per-axis markers were the sole thing separating two globe pipelines built from
different shader modules. Module identity is now folded into the key, which
demotes every marker to provenance — a maintainer weighing whether a new marker
is mandatory needs that sequence.

## Globe uniform buffers, textures and layouts

### `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTextures.ts` — `noteUploadForStormDetection`

_Moved 2026-08-08._

```text
PERMANENT SENTINEL — detects a texture re-upload storm.

`uploadImageSource` does NOT read the cache it is handed (see its docblock),
so a caller that forgets its own cache-hit guard silently re-uploads the same
image every frame. That exact defect (`NEW-WEBGPU-OCEANNORMAL-PER-CALL-REUPLOAD`)
cost ~9.6 ms/frame and hid for two campaigns, because the per-pass CPU
profiler is structurally blind to it — 99% of the frame lived outside every
instrumented pass.

Deliberately NOT pragma-stripped, per the permanent-sentinel rule for
loop/re-entry detectors. The cost argument is airtight: in correct operation
uploads are rare (once per source), so this Map op is noise next to a
`copyExternalImageToTexture`; in broken operation the frequency IS the bug and
we want the error. The tally is per cacheKey, so many DIFFERENT tiles
uploading during load never trip it — only the same key repeating does.
```

Kept for the measurement (~9.6 ms/frame) and for the instrument finding behind
it: the per-pass CPU profiler cannot see this defect class because almost the
whole frame lives outside every instrumented pass. The rewritten comment states
the sentinel's contract; this preserves the evidence that motivated making it
permanent.

### `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts` — `computeModifiedModelView`

_Moved 2026-08-08._

```text
Session 65 Batch 41 (NEW-VR2-1) — renamed the second argument from
`surfaceTile` to `mesh` to make it impossible to repeat the bug
where the caller passed a `GlobeSurfaceTile` and the function looked
up `surfaceTile.center` which doesn't exist on that class — the
`if (!center) return new Float64Array(view);` fallback then handed
back a plain view matrix, leaving every fragment with a HUGE
(>100 km) `v_positionEC` magnitude at ground-altitude camera
positions. The visible symptom was Bloom.html + Particle System.html
rendering as a flat uniform fog color across the entire below-
horizon area (NEW-VR2-1 "still deferred" since 2026-05-10).
```

Kept because it names the two demos that reproduce the failure and the exact
call shape that produced it. The rewritten comment states the constraint (the
argument must carry a `center`, and the fallback silently degrades to a plain
view matrix); this preserves the reproduction.

### `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts` — `createCameraUniformBuffer`

_Moved 2026-08-08._

```text
Split center3D into high/low on the FULL f64 value, matching
EncodedCartesian3.encode (incl. the sign branch) and the encodedCamera
side this is subtracted from in GlobeTerrain.wgsl. The prior code did
Math.fround(center) FIRST — truncating to f32 and destroying the
sub-meter residual that `low` must carry. That produced a per-tile
world-space offset (~0.012 m near Earth radius): sub-pixel up close, but
at far/orbit camera distance it threw far/limb tile vertices to garbage,
squishing and TEARING the globe mesh (radial wedge-gaps → a detached
floating ring). Splitting the f64 value keeps `low` to ~sub-cm before it
is stored as f32. (DP — far-camera globe RTE precision fix.)
```

Kept for the measured error of the refuted approach (~0.012 m per-tile
world-space offset from rounding the centre to f32 before the split) and for
the visual signature it produced at orbit — a torn mesh with radial wedge gaps
that reads as a detached floating ring, which is how the defect is recognised
in a capture.

### `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts` — `createTileUniformBuffer`

_Moved 2026-08-08._

```text
Batch 58 — `flags.x` controls whether the WGSL `computeEnhancedOcean`
path runs for ocean fragments. WebGL gates the equivalent
`computeWaterColor` on the `SHOW_REFLECTIVE_OCEAN` shader define,
which is only emitted when BOTH:
  1. the terrain provider supplies a water mask (`hasWaterMask`)
  2. the user enabled water rendering (`globe.showWaterEffect`,
     default FALSE)
Previously the WGSL only checked condition 1, so every ocean
fragment ran the enhanced shader (which blends 40% imagery + 60%
deep color, dimming the satellite Bing aerial by ~5×). That was
the dominant source of the WebGPU/WebGL brightness gap at
mid/orbit distances over ocean.
```

Kept for the measurement: running the enhanced ocean path unconditionally over
water dims satellite imagery by roughly 5x and was the dominant term in the
WebGPU-versus-WebGL brightness gap at mid and orbital range. That number is the
reason the two-condition gate is not merely a parity nicety.

## Scene layer and the GLSL pair

### `packages/engine/Source/Shaders/GlobeFS.glsl` — `sampleAndBlend`

_Moved 2026-08-08._

```text
KNOWN ALGORITHMIC DIVERGENCE (deferred to follow-up batch)
The WGSL counterpart uses a simpler straight-mix final blend:
  outColor = mix(prevColor, adjusted, effectiveAlpha)
  outAlpha = max(prevAlpha, effectiveAlpha)
vs this function's premultiplied-alpha OVER composite at lines
272-296. For opaque imagery (textureAlpha = 1), both formulas
produce identical output. For partial alpha (e.g., day/night
terminator with both dayAlpha and nightAlpha < 1) this function
preserves source brightness while the WGSL math attenuates it by
the source alpha. A Batch 68 attempt to align the WGSL math
regressed midlat-mid from 1.09% to 7.01% diff — root cause not yet
isolated. Documented here for future bisection-led alignment.
```

Records a refuted alignment attempt and its measurement. The rewritten comment
keeps the divergence itself; this is the only record that aligning the WGSL to
the OVER composite has been tried, and that it made the midlat-mid diff
6.4x worse rather than better.

---

### `packages/engine/Source/Shaders/GlobeFS.glsl` — `main` (water mask / reflective ocean block)

_Moved 2026-08-08._

```text
Pre-Batch-58 the WGSL incorrectly used a `mix(imagery, deepColor ×
darkening, 0.6)` REPLACEMENT blend, which dimmed Bing aerial ocean
by ~5× at orbit altitudes — the dominant source of the historical
WebGL/WebGPU brightness gap. Batch 58 rewrote the WGSL to match this
file's additive intent. Batch 78 then closed remaining gaps:
`nonDiffuseHighlight` (low-light wave highlight) and the
waveIntensity-modulated surfaceReflectance pattern are now bridged
to WGSL too. See WEBGPU_DEBUGGING_LOG.md Batch 58 + Batch 78.
```

Identifies a replacement-blend formulation as the cause of a measured ~5x
ocean-brightness gap between the backends at orbit altitude. The rewritten
comment states the additive contract and the 5x consequence, but not that this
was once the shipped WGSL behaviour or which imagery set it was measured on.

---

### `packages/engine/Source/Shaders/GlobeFS.glsl` — `main` (lighting / shadow-receive block)

_Moved 2026-08-08._

```text
THIS FILE IS THE REFERENCE. As of CLT-B4 (CO-18) the WGSL runs the two
expressions below verbatim; the earlier "intentional algorithmic rewrite"
note here was describing a measured visual divergence, and it is closed.
The two expressions are DISTINCT ON PURPOSE and must stay distinct:
```

```text
The `+ 0.3` is the LIGHTING expression's night floor only. Folding it (or
any other offset) into the alpha ramp moves the terminator; the WGSL did
exactly that with a `+ 0.5` until CO-18, measured at +0.485 night-alpha at
the geometric terminator by `probe-daynight-terminator-law.mjs` run 2.
```

```text
- Day/night imagery-alpha applicability: this file emits
  ENABLE_VERTEX_LIGHTING *instead of* ENABLE_DAYNIGHT_SHADING when the
  terrain has vertex normals (`GlobeSurfaceShaderSet.js:435-442`), so the
  day/night alpha does not exist at all there; WGSL still applies the ramp.
  Open as CLT-B1 finding (c) — it needs a vertex-normal provider to decide
  at pixels and is NOT closed by CO-18.
```

Three things with no home in the rewrite: the phrase
`intentional algorithmic rewrite`, which `eclipse-scene-dimming.spec.mjs`
asserts on the probe text and which named the closed divergence; the instrument
that produced the +0.485 measurement; and the fact that the vertex-normal
divergence is an open finding awaiting a vertex-normal provider to decide it at
pixels, rather than an accepted design.

---

### `packages/engine/Source/Shaders/GlobeFS.glsl` — `computeWaterColor` (ocean-wave footprint LOD constants)

_Moved 2026-08-08._

```text
SHARED vs MAPPED (Principle 5): the fade BAND (OCEAN_OCTAVE_FADE_LO/HI, in
normal-map repeats spanned per screen pixel) and OCEAN_WAVE_MARCH_CUTOFF are
shared VERBATIM with the WGSL march (pinned by ocean-wave-lod.spec.mjs). The
per-layer SCALE is backend-native and does NOT match: WGSL picks explicit
physical wavelengths (OCEAN_WAVELENGTH_*_M) for the WebGPU look, whereas WebGL
keeps czm_getWaterNoise's scale. czm_getWaterNoise divides the incoming UV by
103/107/(897,983)/(991,877) across its 4 taps (Builtin/Functions/
getWaterNoise.glsl), so the map's EFFECTIVE repeat rate is oceanFrequency /
(~divisor), NOT the raw oceanFrequency — v1's bug (D2). We key the fade on the
COARSEST tap divisor (the last structure to go sub-pixel), so a layer only
fades once even its largest content is sub-pixel — the safe, WebGL-preserving
calibration. Footprint uses the MAX screen axis here (WebGL's texture() is
isotropic — no anisotropy — so the long axis is the limiter; the WGSL twin
uses MIN because its sampler has maxAnisotropy 8).
```

Names `ocean-wave-lod.spec.mjs` as the pin that holds OCEAN_OCTAVE_FADE_LO/HI
and OCEAN_WAVE_MARCH_CUTOFF byte-identical across the two shaders, and records
that the first calibration keyed the fade on the raw `oceanFrequency`. The
rewritten comment keeps the divisor rule and the three-orders-of-magnitude
consequence, but not the spec that enforces the shared half.

---

### `packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js` — `addWebGPUDrawCommandsForTile`

_Moved 2026-08-08._

```text
Shadow-cast tags — routes the command through the right
WebGPUShadowMapRenderer variant when the globe casts shadows.

Batch 24 — every globe terrain tile now uses an explicit
shadow-cast layout:
  * quantized tiles (TerrainQuantization.BITS12) → `quantized12`
    (BITS12 decode in the cast shader).
  * uncompressed tiles, regardless of whether they carry vertex
    normals / webMercT / geodetic surface normal (DP-H25) →
    `terrainUncompressed` (reads `position3DAndHeight` as vec4
    at location 0, stride-aware so the variable post-position
    bytes don't misalign the GPU's per-vertex walk).

Before Batch 24 uncompressed tiles fell through to the `rte24`
variant via stride inference. `rte24` reads two vec3s at
offsets 0 and 12 — the first hits `position.xyz` correctly but
the second hits `(height, u, v)`, which is tex-coord garbage,
not a positionLow. The resulting RTE math produced shadow
coordinates unrelated to the actual terrain, so shadows
visibly missed the surface. The new `terrainUncompressed`
variant fixes that at the source.

DP-H25 geodetic-terrain shadow cast — the `__skip_geodetic_terrain`
sentinel from Batch 19 is removed: geodetic tiles have their
stride reported correctly via `vertexStride` below, and the
stride-aware pipeline registry (Batch 24) handles it.
```

Records the removed `__skip_geodetic_terrain` sentinel, so a future reader who
finds that name in the shadow-map renderer or in an old branch knows it was
retired deliberately once `vertexStride` began reporting geodetic strides
correctly. The rewritten comment keeps the `rte24` misinterpretation as the
reason the layout is named explicitly.

---

### `packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js` — `addWebGPUDrawCommandsForTile` (non-3D bounding volume)

_Moved 2026-08-08._

```text
NEW-WEBGPU-GLOBE-2D-REGIONAL-ZOOM (Batch 167) — in non-3D scene modes
the per-command frustum cull must NOT use the tile's 3D-ECEF bounding
volume. `tileBR.boundingSphere` / `.boundingVolume` live in 3D ECEF
space (centered ~6.4 Mm from the origin); culling them against the
2D / Columbus PROJECTED frustum rejected EVERY tile at regional zoom
(the small frustum's planes are nowhere near the ECEF sphere), so the
WebGPU globe rendered blank when zoomed in. SCENE3D keeps the 3D
volume for its per-command cull optimization.

NEW-SCENE2D-GLOBE-PASS-OVERWRITE (Batch 268) — Batch 167 fixed the cull
by dropping the bounding volume ENTIRELY in non-3D, but a command with
NO bounding volume forces `View.createPotentiallyVisibleSet` down its
worst-case branch: `commandNear = frustum.near (=1 in 2D)`,
`commandFar = frustum.far (=500 Mm)`. That collapses the scene near to 1
and explodes the 2D multi-frustum split from 1 to ~9 uniform frustums,
binning the globe into ALL of them (no-BV commands match every bin in
`insertIntoBin`). Because color accumulates across frustums while depth
clears per-frustum, the OPAQUE globe in the NEAR frustums overwrites the
coplanar translucent billboard/point/label that only binned into the FAR
frustums (their tight bounding volumes sit ~12.76 Mm out) — markers went
to 0 px in SCENE2D. WebGL never hits this: it always supplies a bounding
volume and relies on `command.cull = false` (not a missing volume) to
avoid the 2D-frustum-mismatch cull (`Scene.isVisible` short-circuits on
`!command.cull` BEFORE touching the volume). Mirror WebGL exactly:
supply the 2D-PROJECTED bounding sphere (correct near/far → 1 frustum,
matching WebGL's split) AND set `cull = false` so the projected sphere is
never used to wrongly reject a tile. This keeps Batch 167's fix intact
while restoring the correct frustum count. See WebGL
`addDrawCommandsForTile` (this file, ~line 1721) for the reference 2D
bounding-sphere computation.
```

Two defects sit one inside the other here, and the second was caused by the
first fix. The rewritten comment states both constraints — never the 3D volume,
never no volume — but this preserves the ordering, which is what tells a future
reader that "just drop the bounding volume in 2D" has already been tried and
costs every translucent marker in SCENE2D.

---

### `packages/engine/Source/Scene/Globe.js` — `Globe#beginFrame`

_Moved 2026-08-08._

```text
── Enhanced WebGPU rendering properties ──
CLT-B2 — the enable and the value travel as SEPARATE signals.

These lines used to fold the enable into the value (`enableNightLights
? nightIntensity : 0.0`). The WebGPU tile UB then handed that number to
`GlobeTerrain.wgsl::getNightIntensity()`, which read `0.0` as "the CPU
configured nothing — use my built-in default of 2.5". So the OFF value
aliased exactly onto default-ON: `globe.enableNightLights = false` was
a visual no-op, `tileProvider.enableNightLights` was written and never
read, and C11-159's ratified "default OFF, keep the toggle" had no
reachable off state to ratify. The same fold hid `nightIntensity = 0`,
which this class documents as "no emission".

The enable flags below are now READ by `WebGPUGlobeSurfaceTileUB`,
which owns the encoding (`resolveGlobeTunable` +
`GLOBE_UB_UNSET`). Nothing here decides what OFF looks like.
```

Records that a ratified `default OFF, keep the toggle` decision was vacuous for
a period because the off state aliased onto default-on, and that
`tileProvider.enableNightLights` was a written-but-never-read field.
`globe-night-ocean-sentinel.spec.mjs` quotes this wording. The rewritten
comment keeps the constraint — never fold the enable into the value — without
the ratification history.

---

### `packages/engine/Source/Scene/OceanSurfacePrimitive.js` — (module docblock)

_Moved 2026-08-08._

```text
VERTICAL DATUM + TIDE (C6-FFT-OCEAN-TIDE-DATUM, rulings T1/T2/T3/T6). The
patch used to anchor at `scaleToGeodeticSurface(camera)` — ELLIPSOIDAL height
0 — while real terrain publishes ORTHOMETRIC heights, so Cesium World
Terrain's baked sea sits on the geoid. `probe-ocean-datum.mjs` measured the
disagreement at 101.64 m at the Sri Lanka coast (patch floating above the
baked sea as a raised water plateau). The anchor is now displaced along
`_a0Up` by

    h  = geoidUndulation(anchor)          // 0 when the datum is ELLIPSOID
       + tideHeight(time, anchor) * tideExaggeration
    h' = (h - relativeHeight) * verticalExaggeration + relativeHeight

in that order. The exaggeration map is applied LAST because the ocean lid is
itself displaced by it — measured, Batch 759 lane 3: the India site's lid
moves -104 m -> -313 m at exaggeration 3.0, exactly `(h-0)*3`. Composing the
other way would leave the patch behind at high exaggeration.
```

Names the instruments behind two numbers the rewritten comment keeps: the
101.64 m ellipsoid-versus-geoid disagreement (`probe-ocean-datum.mjs`, Sri
Lanka coast) and the -104 m to -313 m lid displacement at exaggeration 3.0.
Anyone re-deriving the composition order needs to know which probe and which
site produced them.

## Imagery reprojection, ocean and water

### `packages/engine/Source/Shaders/WebGPU/ReprojectWebMercator.wgsl` — `(module docblock)`

_Moved 2026-08-08._

```text
HISTORY: until 2026-07-02 this file double-flipped (v_geo = 1-y AND
srcV = 1-mercatorFraction) based on the false "flipY is metadata-only"
theory. The two flips cancel ONLY for imagery tiles symmetric about
the equator; for asymmetric tiles they produce a latitude-MIRRORED
Mercator warp (content at geographic fraction g came from mercator
fraction 1-mercFrac(mirror(g)) instead of mercFrac(g)), which dragged
high-latitude imagery toward the equator at far zoom — the
long-standing "polar stretch" of the zoomed-out WebGPU globe.
```

The only in-code record of the refuted "flipY is metadata-only" theory and of
why a compare probe on equator-symmetric tiles reported the double flip as
clean. The rewritten comment states the surviving constraint (a flip on either
end must not be re-added); this preserves the failure mode and the name of the
theory so it is not re-derived.

---

### `packages/engine/Source/Shaders/ReprojectWebMercatorFS.glsl` — `(module docblock)`

_Moved 2026-08-08._

```text
Both FS bodies therefore sample at (u, mercatorFraction) directly and
are line-for-line identical. (Until 2026-07-02 the WGSL pair carried a
spurious double-flip based on a "flipY is metadata-only" theory; the
flips cancel only for equator-symmetric imagery tiles and produced the
far-zoom polar-stretch warp on asymmetric tiles.)
```

The GLSL half of the same record, kept because the two files are maintained as
a pair and a reader arriving from the WebGL side would otherwise have no trace
of why the WGSL counterpart once differed.

---

### `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererGlobePass.ts` — `executeGlobeDispatch`

_Moved 2026-08-08._

```text
NEW-GLOBE-RENDERBUNDLE-CACHE (Batch 292) — the inline per-frame
`GPURenderBundle` that used to wrap the opaque-terrain dispatch was
REMOVED. Render bundles only pay off when cached and replayed across
many frames; this one was rebuilt from scratch every frame (create
encoder → record every tile command → `finish()` → `executeBundles`),
so it paid the full bundle-construction cost with zero amortization.
Measured cost (probe-globe-bundle-cost.mjs, 55-tile low view): the
bundle path ran ~0.3-0.4 ms SLOWER at the median than direct
`executeBatch`, with a markedly worse p90 (build-cost spikes).

It also can't be safely cached: each globe command records
`setBindGroup(0, bg0, [cameraOffset, tileOffset, eclipseOffset])` with
the ring-allocator byte offsets BAKED IN at record time. Those
offsets rotate every frame (the per-frame ring allocator cycles
pages by design — NEW-GLOBE-DYNAMIC-OFFSET-UBO made the bind-GROUP
object stable across motion, but the dynamic-OFFSET values still
change frame-to-frame), so a cached bundle would replay stale offsets
and bind the wrong UB slices. A signature-keyed cache that included
the offsets would miss every frame — no better than rebuilding.

The path therefore drops straight through to `executeBatch`. Do not
re-add an inline bundle here without first making the per-tile UBs
frame-stable (i.e. not ring-allocated) — see the cost probe before
assuming a bundle helps.
```

Carries the measured cost of a design that was tried and rejected — median
~0.3-0.4 ms slower with a worse p90 on a named 55-tile probe view. The
rewritten comment keeps the standing prohibition and the structural reason a
bundle cannot be cached; this preserves the number and the probe that produced
it, so the option is not re-opened on intuition.

---

### `packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatWaterFlat.wgsl` — `vertexMain` (`VertexOutput.eyePosition`)

_Moved 2026-08-08._

```text
FEAT-GAP-09 — eye-space position for the aerial-perspective fog block.
Declaration restored (Batch 97 wired the read/write but omitted the
VertexOutput field in 18 of 19 Mat*Flat shaders).
```

Records a family-wide omission: the aerial-perspective read and write were
wired into the `Mat*Flat` shaders while the `VertexOutput` field that carries
the value was declared in only one of nineteen. Kept so anyone auditing the
other `Mat*Flat` shaders knows the shape of the defect to look for.

---

### `packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatWaterLit.wgsl` — `fragmentMain` (`FragOutput`)

_Moved 2026-08-08._

```text
Slice 5c-B Batch 121 — G-buffer MRT output struct (added by
Tools/batch-121-wrap-lit-shaders.mjs). Slot 0 = lit color, slot 1 =
eye-space normal + roughness. NormalMap / BumpMap variants emit the
geometric vertex normal for now; a follow-up batch can switch them
to their perturbed-normal variable for wider Slice 4 divergence.
```

Two facts with no home in this file: the MRT wrapper across the `*Lit` shader
family was applied by a generator script, `Tools/batch-121-wrap-lit-shaders.mjs`
(so a hand edit to one shader will not match its siblings), and the
NormalMap / BumpMap variants deliberately still emit the geometric vertex
normal rather than their perturbed normal.
