# Shader Pairs Lockstep — WebGL ↔ WebGPU Manual Parity Plan

**Status:** Phases 1–3 shipped; Phase 4 + Naga-verifier outstanding · Owner: WebGPU migration · First batch: Imagery reproject pair

**2026-08-21 convention change:** Campaign 16 shards had already removed the stamped,
boxed pair header from `GlobeTerrain.wgsl`, `GlobeFS.glsl`, `GlobeVS.glsl`,
`ReprojectWebMercator.wgsl`, `ReprojectWebMercatorVS.glsl`,
`ReprojectWebMercatorFS.glsl`, `SkyAtmosphere.wgsl`,
`SkyAtmosphere{VS,FS,Common}.glsl`, and `SkyBoxFS.glsl`, while retaining prose
pairing constraints (with this-document pointers where present). Plain pair comments
are now canonical, and audit dates live only in the ledger below.

---

## Goal

For every functional GPU computation that exists on both backends, maintain
a **matched pair** of shader files — one GLSL, one WGSL — that express the
**same algorithm line-by-line** to the maximum extent the two languages allow.

Byte-exact output across vendors is not the target: driver implementations of
`sin`, `log`, and sampling differ within spec tolerance. The target is identical
**algorithmic intent**, so that:

1. Bugs in one backend's shader can't drift apart from the other over time.
2. A reader can place the two files side-by-side and verify equivalence at
   a glance.
3. Reviewers of a change can refuse a PR that touches one shader without
   the matching edit to the other.

This is the manual, lower-bar version of the Naga WGSL→GLSL transpilation
plan. Manual lockstep comes first because:

- It requires zero new build infrastructure.
- It preserves full line-by-line control of both languages.
- It establishes the discipline (write-the-pair, review-the-pair) that
  any future transpilation strategy depends on anyway.
- Naga can land later as a build-time check that the two shaders stay
  semantically equivalent, not as the source of truth.

---

## Non-goals

- **Byte-exact output across vendors.** The shader output's cross-vendor
  divergence is bounded by hardware `sin`/`log`/sampler precision and is
  not chasable without specialized math kernels. Document and accept.
- **CPU reprojection / WASM fallback.** Performance-critical paths stay
  on the GPU. The reproject is one example: ~0.1-0.5 ms on GPU per tile
  vs. ~5-10 ms on CPU per tile in pure JS. It remains on the GPU.
- **Naga WGSL→GLSL transpilation.** Deferred to a later batch. This plan
  is the prerequisite — once the shader pairs are aligned line-by-line,
  Naga becomes a verifier rather than a translator.
- **Refactoring shaders for parity that are already in lockstep.** Upstream
  Cesium shaders with no WebGPU counterpart are singletons, not pairs. They
  remain alone until a WebGPU counterpart is needed.

---

## Background: how the shaders diverged

Cesium's WebGL shaders are hand-written GLSL with `#ifdef` preprocessor
defines, `czm_*` automatic uniforms, and an `out_FragColor` output. The
WebGPU shaders are hand-written WGSL with `//>>ifdef` preprocessor blocks
(see `WebGPUShaderPreprocessor.ts`), explicit binding/group layout, and
`@location(0)` outputs.

The two shader sets were developed in parallel during the WebGPU
migration. Each maintainer chose conventions independently:

- Variable names: WGSL uses `texCoord` vs. GLSL `v_textureCoordinates`.
- Uniform organization: WGSL uses `struct` bundles, GLSL uses individual
  uniforms.
- Math expressions: same intent but different formula sequencing.
- Per-fragment vs per-vertex math: see the recent Batch 66 work on
  reprojection, where the two backends diverged on this dimension for
  ~10 years before being aligned.
- Upload-side settings differ: WebGL's `Texture` constructor defaults to
  `flipY: true`, while WebGPU's `copyExternalImageToTexture` defaults to
  `flipY: false`. The complete upload chains now land the same source-v
  convention, and both reproject fragment shaders use
  `srcV = mercatorFraction`. The remaining vertex/interpolation mapping is
  recorded in the convention ledger below.

The cumulative result: shaders that produce equivalent rendering but look
nothing alike side-by-side. That makes future maintenance fragile —
nothing prevents a fix landing in one shader and not the other.

---

## Approach

### Co-located shader-pair files

For each functional pair maintained in lockstep, the participating source files
retain the existing layout:

```
packages/engine/Source/Shaders/
  GlobeFS.glsl              <- WebGL (existing layout)
  GlobeVS.glsl              <- WebGL
  ReprojectWebMercatorFS.glsl
  ReprojectWebMercatorVS.glsl
  ...
  WebGPU/
    Globe/
      GlobeTerrain.wgsl     <- WebGPU (existing layout)
    ReprojectWebMercator.wgsl
    ...
```

The canonical pair marker is a short plain comment block (typically two to
four lines) in each shader. It names the partner file or logical group, states
that behavior changes land together, and points to `SHADER_PAIRS_LOCKSTEP.md`.
The wording is not normative — the three elements are. A combined shader may place
the marker beside its paired section instead of at the top. The marker carries
no audit date and no batch number; audit currency lives in the ledger below.

```glsl
// Paired shader: Shaders/WebGPU/ReprojectWebMercator.wgsl
// A change here must land with the matching change there.
// See SHADER_PAIRS_LOCKSTEP.md.
```

And the matching WGSL marker:

```wgsl
// Paired shader: Shaders/ReprojectWebMercator{VS,FS}.glsl
// A change here must land with the matching change there.
// See SHADER_PAIRS_LOCKSTEP.md.
```

Here, "a change" means a change to paired shader behavior or to the lockstep
obligation itself. Pair-comment formatting alone does not require a no-op edit
to an already-compliant counterpart.

### Lockstep audit ledger

This table is the single mutable record of audit currency. It has one row per
logical pair or group inventoried by this document. `unrecorded` means that the
document and retired source headers carried no audit date for that group; an
introduction or feature date is not an audit date. The carried-record column
preserves every retired source-header date and commit exactly as recorded.
Where a group's stamps were retired before this ledger existed, the record is
recovered from the retiring commit's diff and the audited state is that
commit's parent. A carried commit is the landing commit for the audited state
and may post-date the audit itself. The Phase 3.3 shadow group is inventoried
at architecture level: line-by-line alignment is not applicable there, so it
deliberately carries no line-audit row.

| Pair or group | Last lockstep audit | Carried source-header record |
| --- | --- | --- |
| `Shaders/ReprojectWebMercator{VS,FS}.glsl` ↔ `Shaders/WebGPU/ReprojectWebMercator.wgsl` | 2026-05-18 | All three files: 2026-05-18 (Batch 67); audited state `652bba3ba37285af9f4b7fe2809b24643f8f324a`, stamps retired by `7aac6086e6` |
| `Shaders/Globe{VS,FS}.glsl` ↔ `Shaders/WebGPU/Globe/GlobeTerrain.wgsl` | 2026-08-07 | Per-section stamps, audited state `652bba3ba37285af9f4b7fe2809b24643f8f324a`, retired by `7aac6086e6` — GlobeFS: 2026-05-18 (Batch 68), 2026-05-19 (Batch 72), 2026-05-20 (Batch 78), 2026-07-26 (C12-29 S5), 2026-08-07 (Batch 925, CO-18 ramp-law); GlobeVS: 2026-05-19 (Batch 75); GlobeTerrain: 2026-05-19 (Batch 72), 2026-05-19 (Batch 75), 2026-05-20 (Batch 79), 2026-07-24 (C11-172), 2026-08-07 (Batch 925) |
| `Shaders/SkyAtmosphere{VS,FS,Common}.glsl` ↔ `Shaders/WebGPU/Environment/SkyAtmosphere.wgsl` | 2026-08-01 | VS and Common: 2026-05-19 @ `e6975f3bd19a52b762978c168d97d251198bcbda`; FS and WGSL group: 2026-08-01 @ `e7481810653558b71784cc558e19c77258b934a9` |
| `Shaders/PostProcessStages/AdditiveBlend.glsl` ↔ `Shaders/WebGPU/PostProcess/AdditiveBlend.wgsl` | unrecorded | — |
| `Shaders/PostProcessStages/AmbientOcclusionGenerate.glsl` ↔ `Shaders/WebGPU/PostProcess/AmbientOcclusionGenerate.wgsl` | unrecorded | — |
| `Shaders/PostProcessStages/AmbientOcclusionModulate.glsl` ↔ `Shaders/WebGPU/PostProcess/AmbientOcclusionModulate.wgsl` | unrecorded | — |
| `Shaders/PostProcessStages/BlackAndWhite.glsl` ↔ `Shaders/WebGPU/PostProcess/BlackAndWhite.wgsl` | unrecorded | — |
| `Shaders/PostProcessStages/BloomComposite.glsl` ↔ `Shaders/WebGPU/PostProcess/BloomComposite.wgsl` | unrecorded | — |
| `Shaders/PostProcessStages/Brightness.glsl` ↔ `Shaders/WebGPU/PostProcess/Brightness.wgsl` | unrecorded | — |
| `Shaders/PostProcessStages/CompositeTranslucentClassification.glsl` ↔ `Shaders/WebGPU/PostProcess/CompositeTranslucentClassification.wgsl` | unrecorded | — |
| `Shaders/PostProcessStages/ContrastBias.glsl` ↔ {`Shaders/WebGPU/PostProcess/ContrastBias.wgsl`, `Shaders/WebGPU/PostProcess/BrightPass.wgsl`} | unrecorded | — |
| `Shaders/PostProcessStages/DepthOfField.glsl` ↔ `Shaders/WebGPU/PostProcess/DepthOfField.wgsl` | unrecorded | — |
| `Shaders/PostProcessStages/DepthView.glsl` ↔ `Shaders/WebGPU/PostProcess/DepthView.wgsl` | unrecorded | — |
| `Shaders/PostProcessStages/EdgeDetection.glsl` ↔ `Shaders/WebGPU/PostProcess/EdgeDetection.wgsl` | unrecorded | — |
| `Shaders/PostProcessStages/FXAA.glsl` ↔ `Shaders/WebGPU/PostProcess/FXAA.wgsl` | unrecorded | — |
| `Shaders/PostProcessStages/LensFlare.glsl` ↔ `Shaders/WebGPU/PostProcess/LensFlare.wgsl` | unrecorded | — |
| `Shaders/PostProcessStages/NightVision.glsl` ↔ `Shaders/WebGPU/PostProcess/NightVision.wgsl` | unrecorded | — |
| `Shaders/PostProcessStages/PassThrough.glsl` ↔ `Shaders/WebGPU/PostProcess/PassThrough.wgsl` | unrecorded | — |
| `Shaders/PostProcessStages/PassThroughDepth.glsl` ↔ `Shaders/WebGPU/PostProcess/PassThroughDepth.wgsl` | unrecorded | — |
| `Shaders/PostProcessStages/Silhouette.glsl` ↔ `Shaders/WebGPU/PostProcess/Silhouette.wgsl` | unrecorded | — |
| `Shaders/PostProcessStages/PointCloudEyeDomeLighting.glsl` ↔ `{Shaders/WebGPU/PointCloud/PointCloudEDLDepth.wgsl, Shaders/WebGPU/Advanced/PointCloudEDL.wgsl}` | unrecorded | — |
| `Shaders/{SunVS,SunFS}.glsl` ↔ `Renderer/WebGPU/WebGPUEnvironmentRenderer.js::SUN_SHADER_WGSL` | unrecorded | — |
| `Shaders/SunTextureFS.glsl` ↔ `Renderer/WebGPU/WebGPUEnvironmentRenderer.js::createSunTexture` | unrecorded | — |
| `Shaders/CubeMapPanoramaVS.glsl` ↔ `{Shaders/WebGPU/CubeMapPanorama.wgsl, Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js embedded copy}` | unrecorded | — |
| `Shaders/{StarFieldVS,StarFieldFS}.glsl` ↔ `Shaders/WebGPU/Catalog/StarField.wgsl` | unrecorded | — |
| `Shaders/SkyBoxFS.glsl` ↔ `{Shaders/WebGPU/CubeMapPanorama.wgsl, Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js embedded copy}` | 2026-07-25 | 2026-07-25 @ `0679b0e456a7dfc956386dd7c1b7a9899f5493ab` |
| `Shaders/EllipsoidFS.glsl` ↔ `Shaders/WebGPU/Environment/Moon.wgsl` | unrecorded | — |
| `Shaders/WebGPU/Environment/ProceduralClouds.wgsl` ↔ `Scene/Weather/WeatherMapSeam.ts` CPU contract | unrecorded | — |
| `Shaders/PostProcessStages/SolarHalo.glsl` ↔ `Shaders/WebGPU/PostProcess/SolarHalo.wgsl` | unrecorded | — |
| `Shaders/PostProcessStages/BrightPass.glsl` ↔ `Shaders/WebGPU/PostProcess/SunBrightPass.wgsl` | unrecorded | — |
| `Shaders/PostProcessStages/GaussianBlur1D.glsl` ↔ `Shaders/WebGPU/PostProcess/{GaussianBlur1D,GaussianBlur1D_f16}.wgsl` | unrecorded | — |
| `Shaders/ComputeRadianceMapFS.glsl` ↔ `Shaders/WebGPU/Compute/ProceduralSkyCubemap.wgsl` | unrecorded | — |
| `Shaders/{BillboardCollectionVS,BillboardCollectionFS}.glsl` ↔ `Shaders/WebGPU/Collections/BillboardCollection.wgsl` | unrecorded | — |
| `Shaders/BillboardCollectionFS.glsl` ↔ `Shaders/WebGPU/Collections/BillboardCollectionSDF.wgsl` | unrecorded | — |
| `Shaders/BillboardCollectionFS.glsl` ↔ `Shaders/WebGPU/Collections/BillboardCollectionPick.wgsl` | unrecorded | — |

### Inline WGSL remains migration debt where it exists

Some WebGPU code still has WGSL inline in TypeScript or JavaScript strings.
The imagery-reprojection pair is no longer one of those cases:
`WebGPUImageryReprojection.ts` imports the built `.js` wrapper generated from
`ReprojectWebMercator.wgsl`, which is its runtime source of truth. Where both
an inline copy and an equivalent `.wgsl` file remain, the pattern creates three
sources of truth (inline WGSL, `.wgsl` file, GLSL pair).

**Each remaining pair's lockstep work** collapses to one WGSL file:

- The `.wgsl` file becomes the single source of truth for WebGPU.
- The owning TypeScript or JavaScript module imports the compiled `.js`
  wrapper that `gulp build` already produces (`Source/Shaders/WebGPU/...js`).
- The inline template literal is deleted.

Where the equivalent `.wgsl` file already exists for diagnostic purposes,
this is a pure cleanup with no behavior change: the existing file is promoted.

### Matching naming conventions inside the shader

Within matched files, use the same identifier names where the languages allow:

| GLSL | WGSL | Note |
|---|---|---|
| `u_southLatitude` | `u.southLatitude` | Same scalar concept; GLSL uses `u_` prefix, WGSL uses uniform struct |
| `v_textureCoordinates` | `in.texCoord` | Same VS→FS varying; differ in form due to language conventions |
| `mercatorFraction` | `mercatorFraction` | Local variables match exactly |
| `latitude` | `latitude` | Local variables match exactly |
| `sin(latitude)` | `sin(latitude)` | Library call matches exactly |

Local variables (the bulk of any shader function body) should be **identical
in spelling and ordering**. The differences should be confined to:

- Type declarations (`float` vs. `f32`)
- Function decorators (`@fragment` vs. `void main()`)
- Uniform access syntax (`u_foo` vs. `u.foo`)
- Texture sampling syntax (`texture(t, uv)` vs. `textureSample(t, s, uv)`)
- Output assignment (`out_FragColor =` vs. `return`)

### Matching comments

Each significant paired line gets the same comment in all counterpart files.
Comments explain the *math* / *intent* / *constraint*, not the syntax. Example:

```glsl
// Per-fragment Mercator math: same closed-form expression on both
// backends. Vendor sin/log precision varies within spec tolerance
// (~3 ULP), which dominates the cross-vendor pixel residual at high
// latitudes. See SHADER_PAIRS_LOCKSTEP.md "Convention ledger".
float sinLat = sin(latitude);
float mercatorY = 0.5 * log((1.0 + sinLat) / (1.0 - sinLat));
```

```wgsl
// Per-fragment Mercator math: same closed-form expression on both
// backends. Vendor sin/log precision varies within spec tolerance
// (~3 ULP), which dominates the cross-vendor pixel residual at high
// latitudes. See SHADER_PAIRS_LOCKSTEP.md "Convention ledger".
let sinLat = sin(latitude);
let mercatorY = 0.5 * log((1.0 + sinLat) / (1.0 - sinLat));
```

### Same operation ordering

Floating-point arithmetic is not commutative across reorderings — `(a + b)
+ c` may differ from `a + (b + c)` in the last few ULPs. To keep math
maximally equivalent across vendors, the same operation order is used in
both shaders. Avoid GLSL's habit of inlining sub-expressions into a
single statement while WGSL spreads them across multiple `let`s.

If WGSL uses three named locals, GLSL uses three named locals with the
same names. No "inline this for terseness" allowed.

### Texture sampling convention

Pick the corresponding sampling-function family unless a documented language
or control-flow constraint requires a mapped exception between the two
languages:

| Use case | GLSL | WGSL | When |
|---|---|---|---|
| Uniform CF, mip auto-select | `texture(tex, uv)` | `textureSample(tex, samp, uv)` | Default for any shader without `discard` before the sample |
| Non-uniform CF (post-discard) | `textureGrad(tex, uv, dx, dy)` | `textureSampleGrad(tex, samp, uv, dx, dy)` | When `discard` precedes the sample |
| Explicit LOD | `textureLod(tex, uv, lod)` | `textureSampleLevel(tex, samp, uv, lod)` | When mip selection is part of the algorithm |

Reprojection FS: no discard before the sample → both use the "auto-mip"
family (`texture` / `textureSample`).

Globe terrain FS is a documented mapped exception. `GlobeFS.glsl` currently
samples imagery inline with `texture(textureToSample, textureCoordinates)`.
`GlobeTerrain.wgsl` uses `textureSampleGrad` with pre-computed derivatives to
satisfy WGSL's non-uniform-control-flow rules. Preserve the shared coordinates
and derivative intent rather than forcing the function names to match.

---

## Convention ledger — the hidden divergences

Some divergences are *outside* the shader files (in CPU upload code, in
vertex attribute layout, etc.) but they affect the values flowing into
the shaders. These can produce equivalent rendering with shaders that
look different. The table documents each one explicitly:

| Convention | WebGL | WebGPU | Notes |
|---|---|---|---|
| Imagery upload flipY | `flipY: true` (Texture default) on a pre-flipped ImageBitmap → double-flip → texture v=0 = south (in sampling) | `flipY: false` (default) on the same pre-flipped ImageBitmap; the `imageOrientation:"flipY"` is baked into the pixels `copyExternalImageToTexture` consumes → texture v=0 = south (in sampling) too | **Corrected 2026-07-02 (GLOBE-POLAR-STRETCH).** Both upload chains land the same source-V convention (v=0 = south). The Batch-67 "metadata-only flipY → v=0 = north on WebGPU" theory was false — it was contradicted by the direct-Mercator binding path (`useWebMercatorT=true` tiles sample the same uploaded texture with v=0=south semantics and render right-side-up). The double-flip it justified in `ReprojectWebMercator.wgsl` (`v_geo = 1-y`, `srcV = 1-mercatorFraction`) cancels only for equator-symmetric imagery tiles and latitude-mirror-warped asymmetric tiles — the far-zoom WebGPU "polar stretch". Both reproject FS bodies are now line-for-line identical (`srcV = mercatorFraction`). |
| Imagery composite blend math (globe FS) | Premultiplied-alpha over composite: `outAlpha = mix(prevA, 1, srcA)`, `outColor = mix(prevC * prevA, color, srcA) / outAlpha`. | Same premultiplied-alpha over composite (Batch 79). | **Shipped.** Pre-Batch-79 the WGSL used `mix(prevColor, adjusted, srcA)` + `max(prevAlpha, srcA)`, which Batch 69 proved pixel-equivalent to over when `prevAlpha = 1` (the dominant case). Batch 68 attempted the switch and saw an apparent regression that turned out to be probe-level clock-noise; with clock pinning landed in Batch 70, Batch 79 made the switch cleanly and re-verified the baseline pixel-identical. The switch closes the divergence on multi-frustum subsequent passes (where `prevAlpha = 0` and the first layer's srcA < 1 — pre-Batch-79 attenuated; post-Batch-79 matches WebGL). |
| Ground atmosphere — pipeline gating | Three `#ifdef` defines control inclusion: `GROUND_ATMOSPHERE`, `FOG`, `PER_FRAGMENT_GROUND_ATMOSPHERE`. Pipeline cache emits the right variant per-tile. | Runtime UBO scalars: `tile.fogDensity > 0`, `tile.groundAtmosphereControl.x > 0.5`, `camera.atmosphereParams.w > 1.5`. WGSL evaluates all branches with runtime gates. | Same semantics. WGSL pays a few branch ops per fragment that GLSL avoids at shader-compile time; difference is sub-noise on every device measured. |
| Ground atmosphere — per-vertex vs per-fragment ray-march | Two paths gated by `PER_FRAGMENT_GROUND_ATMOSPHERE` (CPU-set when `cameraDist > nightFadeOutDistance` ≈ 10 Mm). Per-vertex uses `v_atmosphereRayleighColor` / `v_atmosphereMieColor` varyings; per-fragment calls `computeAtmosphereScattering` per pixel. | Always per-fragment (`computeAtmosphereScatteringGround`). Batch 56 chose per-fragment-always to avoid mesh-pattern artifacts from interpolated optical depths at orbit altitudes. The WGSL vertex stage still computes the atmosphere varyings; ordinary shading does not consume them, but debug outputs can read them. | WGSL output matches WebGL's per-fragment path at orbit; close-camera output also matches because the per-vertex computation collapses to the same answer when optical depths are short and uniform. No visible divergence. |
| Ground atmosphere — LUT integration | None. Always uses the inline `computeAtmosphereColor` analytic. | Optional `effects.atmosphereLutControl.x > 0.5` samples a compute-shader-pre-computed LUT for physically-accurate inscatter. Falls back to the same inline analytic when LUT unavailable. | WebGL has no equivalent (no WebGL2 compute). LUT-off fallback verified by `probe-atmo-lut-off.mjs` (Batch 79): 2.4-6.4% mismatch across three atmosphere-prominent views with WebGPU marginally brighter (~1.5 brightness units per channel, consistent sign) — within cross-vendor numerical drift band. WGSL diverges (more accurate) when LUT is active. Documented as an intentional one-way enhancement, not a parity bug. |
| Ground atmosphere — HDR gate | `#ifndef HDR` → inline `1 - exp(-fExposure × x)` tonemap; `#else` → skip and let post-process compress | `tile.groundAtmosphereControl.w > 0.5` (= HDR enabled) → skip; else → inline tonemap | Same toggle, different gate mechanism. Output identical. |
| Moon texture mip/LOD — C12-33 | The private opaque Moon Image material uses `textureGrad` (WebGL2) or `texture2DGradEXT` (capable WebGL1). `EllipsoidFS.glsl` computes both hit UVs and longitude-unwrapped derivatives before its miss discard. WebGL1 NPOT/extension fallback remains single-level LINEAR. Generic Image materials are untouched. | `Moon.wgsl` analytically selects one opaque hit, computes finite closest-approach helper UVs on miss lanes, unwraps only longitude derivatives, then uses `textureSampleGrad` for both albedo and LOLA normal maps. | **Lockstep policy, different legal fallbacks.** A shared normalized gradient does not force a shared mip: each texture's dimensions enter its own lambda calculation, so 2K albedo and 1K normal select independently. Never replace this with implicit sampling after discard or a single CPU LOD. Moving close/seam/limb/~16 px acceptance is owned by `probe-moon-mip-motion-edge.mjs`; thresholds/manual seam review remain pending. |
| Water/ocean — algorithm | `computeWaterColor` (hand-written GLSL, `#ifdef SHOW_REFLECTIVE_OCEAN`): **additive** blend `color = imageryColor + diffuseHighlight + nonDiffuseHighlight + specular`. Imagery is the base; ocean highlights add on top. | `computeEnhancedOcean` (hand-inlined, Batch 58): same **additive** blend `color = imagery + diffuse + nonDiffuse (Batch 78) + specular`. Matched. | **Shipped.** Batches 58 + 78 closed the alignment gap. The pre-Batch-58 WGSL incorrectly used a `mix(imagery, deepColor × darkening, 0.6)` replacement blend (the historical "WebGPU/WebGL brightness gap"). Batch 58 rewrote to additive; Batch 78 added the remaining `nonDiffuseHighlight` (low-light wave highlight under SHOW_OCEAN_WAVES) and waveIntensity-modulated `surfaceReflectance` patterns. Polar-multi probe doesn't exercise this code path (WGS84 ellipsoid has no water mask). |
| Water/ocean — UV Y-flip | `GlobeFS.glsl` applies `waterMaskTextureCoordinates.y = 1.0 - .y` after translation/scale. | `GlobeTerrain.wgsl` applies the same `1.0 - y` shader flip. `WebGPUGlobeSurfaceTextures` uploads typed arrays unchanged and uses `flipY: false` for ImageBitmap input, preserving north-first source rows. | Both backends now perform the flip in the shader; the WebGPU upload path deliberately preserves the source row order. `GlobeSurfaceTile.js` retains the payload on `texture._webgpuSource`. |
| Water/ocean — function home | `computeWaterColor` is hand-written in `GlobeFS.glsl`, gated by `#ifdef SHOW_REFLECTIVE_OCEAN`, and forward-declared earlier in that file. Earlier notes that attributed it to material code generation were incorrect; Batch 78 corrected the record. | `computeEnhancedOcean` is hand-written directly in `GlobeTerrain.wgsl`. | Neither implementation is generated. New water behavior requires edits to both files. |
| Water/ocean — wave-normal sampling | 2 altitude layers (`czm_getWaterNoise(u_oceanNormalMap, ...)` high + low frequencies, blended over `positionToEyeECLength` ∈ [20km, 60km]). Wave UVs use `czm_ellipsoidTextureCoordinates(normalMC)` (global lon/lat). `czm_getWaterNoise` samples with `texture()` (auto-LOD → mip-averaged); its 4 taps divide the UV by 103/107/(897,983)/(991,877). | **C11-172 v3** (2026-07-24): 3 octaves in the same global ellipsoid (lon/lat) UV at integer repeats `OCEAN_OCTAVE_REPEATS_*` = round(circumference/λ) (267167/801500/2671668 ≈ 150/50/15 m zonal), replacing the old scale-invariant tile-UV ×400/200/800 (sub-pixel at every altitude ⇒ animated aliasing = the "noisy" bug). RTE-decomposed for f32: the CPU packs per-tile per-octave f64 phase offsets `fract(rectOriginNorm×Rᵢ)` + the normalized span into the tile UB (add-only, floats 484-491); the FS reconstructs `phaseᵢ + geoUV×spanNorm×Rᵢ + fract(time)` from small quantities (absolute `euv×R` reached ~2.7e6 ⇒ f32 ulp ~0.25 repeat ⇒ v2 staircase banding + frozen advection). Integer Rᵢ ⇒ exact ±180° wrap; packed span ⇒ no east−west cancellation seam. Honesty: U normalized by 1/2π, V by 1/π ⇒ meridional λ is half the zonal + zonal metric λ shrinks by cos(lat); the footprint fade self-tracks it (no aliasing); quoted λ are equatorial-zonal. | **v2/v3 converged the coordinate onto WebGL's** (both physically-anchored ellipsoid UV). Per-layer scale still differs by design (WGSL explicit repeats vs WebGL's czm_getWaterNoise divisors), so appearance is similar-but-not-identical — strict pixel parity is not a goal. |
| Water/ocean — wave-normal LOD (C11-172 v2, 2026-07-24) | **Conservative** per-layer footprint fade: `oceanOctaveLodWeight(oceanFrequency/OCEAN_GETWATERNOISE_DIVISOR × fwidth(textureCoordinates))` fades each layer's `.xy` only at extreme footprint (far/orbit), calibrated on czm_getWaterNoise's coarsest-tap divisor (D2: keying on raw oceanFrequency, as v1 did, fired ~3 decades too early and would regress WebGL). Hard cutoff skips both `czm_getWaterNoise` calls once negligible. Max-axis footprint (isotropic `texture()`). | **Physical-wavelength**, mip+aniso-aware `textureSampleGrad` (sampler `maxAnisotropy: 8`); footprint = octave repeats × per-pixel UV footprint. amplitude fade: each octave's `.xy` scaled by its weight, `.z` kept (v1 scaled whole vectors inside `normalize` = a scale-invariant no-op; D3). Min-axis footprint (aniso resolves the long axis). Hard cutoff skips the 3 fetches. | **Shared vs mapped.** Shared verbatim (pinned by `Tools/visual-regression/ocean-wave-lod.spec.mjs`): the fade band `OCEAN_OCTAVE_FADE_LO/HI` (repeats/pixel) + `OCEAN_WAVE_MARCH_CUTOFF`. Not shared (intentional): per-layer scale (WGSL integer `OCEAN_OCTAVE_REPEATS_*`, also mirrored in `WebGPUGlobeSurfaceTypes.ts` for the CPU phase packer; GLSL czm_getWaterNoise + `OCEAN_GETWATERNOISE_DIVISOR`) and footprint axis (WGSL min / GLSL max — each matches its sampler's anisotropy). WebGL is not broken (it already mip-averages + is physically anchored) so its change is conservative/far-only; the fix is WebGPU's coordinate+sampling switch. Requirement-2 "earlier low-camera fade" is subsumed by the footprint metric; legacy `waveIntensity` (70km–1Mm) untouched for orbit sun-glint parity. |
| Water/ocean — specular model | `czm_getSpecular` (Phong-like, exponent=10) × `mix(u_zoomedOutOceanSpecularIntensity, oceanSpecularIntensity, waveIntensity) × mask`. Runs unconditionally (no enableLighting gate — `czm_lightDirectionEC` defaults to the sun) and has no orbit-altitude fade. | Same since GLOBE-POLAR-STRETCH-POLISH (2026-07-02): Phong port `pow(max(dot(reflect(-L, N), V), 0), 10)` × waveIntensity-modulated surfaceReflectance × mask, unconditional. `distributionGGX` remains defined but unused. | **Matched.** The earlier WGSL-only GGX + `enableLighting` gate + orbit smoothstep fade suppressed the zoomed-out ocean sun glint that WebGL shows at orbital altitudes — it was 63% of the far-zoom (25 Mm) WebGL↔WebGPU pixel mismatch (probe-globe-polar-stretch bucket decomposition). |
| Water/ocean — foam | None. | `computeFoam(waveNormal, distance)` overlays white pixels where wave normals are steep, with distance falloff over 50km–200km. | **WGSL-only enhancement.** |
| Water/ocean — subsurface scattering | None. | `computeSubsurfaceScattering` helper defined in WGSL but **currently unused** (scaffolding for future enhancement). | **WGSL scaffolding.** Per CLAUDE.md Principle 7 (Dead Code Audit), do not remove. |
| Water/ocean — wave-normal coordinate space | `normalEC_water = enuToEye × normalTangentSpace` — tangent-space wave normal is rotated to eye-space via `czm_eastNorthUpToEyeCoordinates(positionMC, normalEC)` before any further math (GlobeFS.glsl::computeWaterColor L814). | Same: WGSL ports `czm_eastNorthUpToEyeCoordinates` as `eastNorthUpToEyeCoordinates(positionMC, normalEC)`, transforms `waveN` to eye-space, then perturbs `normalEC` (Batch 79). | **Shipped (Batch 79).** Pre-Batch-79 the WGSL added tangent-space `waveN` directly to eye-space `normalEC` without rotation — mixed coordinate frames, producing a subtle "moving mesh" artifact where waves were anchored to camera orientation instead of the local ENU frame. Visible on close-zoom coastal orbits; not visible on the polar-multi baseline (WGS84 has no water mask). |
| Lighting — variant gating | Three #ifdef variants: `ENABLE_VERTEX_LIGHTING` (tile-provider-driven, custom uniforms × `czm_lightColor`), `ENABLE_DAYNIGHT_SHADING` (`NdotL × 5 + 0.3` × `czm_lightColor`, mixed with full brightness by `fade`), or pass-through. | One runtime gate on `camera.enableLighting > 0.5`, selecting the same two arms via `camera.lighting.z` (hasVertexNormals). | Same intent, same coefficients since CLT-B4/CO-18 (see the day/night ramp law row below); the gate mechanism differs by construction — WebGL forks the shader, WGSL branches at runtime. |
| **day/night ramp law — the pair contract (CLT-B4, CO-18, Batch 925)** | **`GlobeFS.glsl` is the reference and is unchanged.** two distinct expressions over one `czm_getLambertDiffuse(czm_lightDirectionEC, normalEC) * 5.0` core, with two consumers: **(1) imagery day/night alpha + night-lights emission gate** — `:601` `float nightBlend = 1.0 - clamp(czm_getLambertDiffuse(czm_lightDirectionEC, normalEC) * 5.0, 0.0, 1.0);` that is dayFade = `clamp(N·L*5, 0, 1)`, fully night at N·L ≤ 0, ramp entirely on the day side, saturating at N·L = 0.2. **(2) ENABLE_DAYNIGHT_SHADING diffuse** — `:851-852` `float diffuseIntensity = clamp(czm_getLambertDiffuse(czm_lightDirectionEC, normalEC) * 5.0 + 0.3, 0.0, 1.0); diffuseIntensity = mix(1.0, diffuseIntensity, fade);` where `fade` is the camera-distance clamp at `:620-644`. Both read the analytic per-fragment normal from `:595-597`. | **`GlobeTerrain.wgsl` adopts both, byte-identically where WGSL allows.** `fn computeDayNightFade(normalEC, sunDirEC) -> f32 { let lambertDiffuse = max(dot(sunDirEC, normalEC), 0.0); return clamp(lambertDiffuse * 5.0, 0.0, 1.0); }` feeds the imagery alpha (`dayFade`) and the night-lights gate (`nightBlend = 1.0 - dayFade`). `fn computeDayNightDiffuse(normalEC, sunDirEC) -> f32 { … return clamp(lambertDiffuse * 5.0 + 0.3, 0.0, 1.0); }` feeds the DAYNIGHT arm as `diffuse = mix(1.0, computeDayNightDiffuse(dayNightNormalEC, sunDir), clamp(tile.lightingFade, 0.0, 1.0));`. Both take `dayNightNormalEC`, the analytic normal (CO-15). `tile.lightingFade` (TileUniforms float 463) is GLSL `:620-644`'s clamp, transcribed CPU-side in `WebGPUGlobeSurfaceTileUB.ts::computeLightingFade` because the WGSL carries neither `czm_view` nor `czm_frustumPlanes`. | **The obligation, stated so a future edit cannot drift silently: the `* 5.0` core is shared; the `+ 0.3` belongs to the lighting expression only; the `mix(1.0, …, fade)` belongs to the lighting consumer only; the alpha ramp carries no offset and no fade.** Any change to any of the four clauses lands in both files plus `Tools/visual-regression/globe-daynight-ramp-law.spec.mjs`, which transcribes both backends and requires the evaluated ramps to agree over an N·L grid. Before CO-18 the WGSL had one function, `clamp(N·L*5 + 0.5, 0, 1)`, serving both consumers, and drove the diffuse from `mix(0.025, N·L*0.88 + 0.12, dayFade)` with no camera-distance term at all. Measured, not inferred: `probe-daynight-terminator-law.mjs` run 2 (tip `679cbf5173`) read a **+0.485 terminator delta** (lane A: WebGL 0.012 `glsl-law` vs WebGPU 0.496 `wgsl-offset-law`) and a night/day luminance ratio of **0.312 / 0.0896** against WebGL's **1.000 / 0.300** at 3 Mm / 25 Mm (lane D). WebGL's two lane-D readings are that expression's exact closed form (`mix(1, 0.3, 0)/1` and `0.3/1`), because 3 Mm sits below `lightingFadeOutDistance` = π/2 × Rmin ≈ 9.98 Mm and 25 Mm above `lightingFadeInDistance` = π × Rmin ≈ 19.97 Mm. **Not byte-identical, by design — the WebGPU look moves onto WebGL's; the WebGL look does not move.** |
| Lighting — day/night camera-distance fade (CLT-B4, CO-18) | `fade = clamp((cameraDist - fadeOutDist) / (fadeInDist - fadeOutDist), 0, 1)` at `GlobeFS.glsl:620-644`, computed under `ENABLE_DAYNIGHT_SHADING \|\| GROUND_ATMOSPHERE`, with `cameraDist` selected per scene mode (`czm_frustumPlanes` span × 0.5 in 2D, `-czm_view[3].z` in Columbus View, `length(czm_view[3])` otherwise) and both distances reduced by the ellipsoid's maximum radius outside SCENE3D. | `tile.lightingFade` — TileUniforms float 463, packed by `computeLightingFade(frameState.mode, frameState.camera, tileProvider.lightingFadeOutDistance, tileProvider.lightingFadeInDistance, ellipsoid.maximumRadius)`. All three `cameraDist` arms and the non-3D radius reduction are transcribed, reading `camera.viewMatrix[12..14]` for `czm_view[3]` and `frustum.offCenterFrustum ?? frustum` for `czm_frustumPlanes` (the same indirection `UniformState.js:794-802` applies). | **Deliberately not `groundAtmosphereControl.y`**, which carries the identical clamp but is forced to 0 when `showGroundAtmosphere` is false or the aerial-perspective post-process owns the haze. WebGL applies no such gate to the lighting fade, so reusing that slot would flat-light the WebGPU globe whenever the drape is off. The drape slot is unchanged by CO-18. |
| Lighting — custom light color | Multiplies by `czm_lightColor` (allows scene-provided custom light color) | Multiplies by `camera.lightColor.rgb` packed from `uniformState.lightColor` (Batch 76). Default white (1,1,1) preserves pre-Batch-76 behavior for scenes without a custom `scene.light`. | **Shipped.** Layout: `camera.lightColor: vec4<f32>` at `CAMERA_UNIFORM_FLOATS` offset 132-135. `.w` reserved for future ambient-color scalar / HDR multiplier. |
| Eclipse globe shadow — C12-29 S5 (2026-07-26; integrated, final certification open) | `GlobeFS.glsl::eclipseFragmentFactor` reads one command-local `mat4` captured from the active logical `View`; its columns are the shared four-`vec4` payload. A WebGL-only bit-33 cache flag emits `ENABLE_ECLIPSE_GLOBE_SHADOW` only for gates 1-4, so the ordinary compiled globe variant has no eclipse uniform or helper semantic IR and performs no S5 composition/atmosphere correction. The raw combined GLSL string still contains the preprocessor-guarded helper source; physically omitting that source is measure-first follow-up work. The fragment uses direct exaggerated `v_positionMC`, multiplied by inverse astronomical range before subtraction, plus the existing automatic `czm_ellipsoidInverseRadii`. | `GlobeTerrain.wgsl::globe_eclipseFragmentFactor` reads the same payload from a dedicated 64-byte group-0/binding-2 dynamic UBO and consumes direct `input.v_positionMC`. One allocation-epoch-memoized active slice is reused by tile, imagery, wireframe, pick, and capture commands; ordinary frames bind one stable inert renderer-owned slice without a ring allocation/upload. `CameraUniforms` remains 232 floats / 928 bytes. | **Algorithmically paired; source/RTE gate 14/14 and both-backend WGS84 pixel probe passed.** CPU f64 publishes `uS = normalize(S)`, `a = 1/\|S\|`, `dU = normalize(M)-uS`, `b = 1/\|M\|`. Both shaders form `s=uS-P*a`, `D=dU+P*(a-b)`, `m=s+D`, run an exact algebraic disc-support reject, use `atan2(length(cross(s,D)), dot(s,m))`, analytic circle overlap, the fitted limb-darkening cubic, and the same S2 absolute/relative composition. The horizon test transforms the Sun ray by the rendered ellipsoid inverse radii and uses the stable cross-product closest-distance form. Source/math coverage includes elevated terrain and custom ellipsoids without an antipodal false shadow; real rendered custom-ellipsoid/exaggeration certification remains open. Direct Earth-scale f32 `positionMC` has sub-metre quantization; there is no mutable pass-camera reconstruction and no `acos(dot)` of independently rounded rays. The WebGL cache flag is not a scarce cross-backend `WebGPUShaderDefines` bit. Any payload, support, horizon, composition, or variant-gate change must land in both shaders plus `eclipse-globe-umbra-rte.spec.mjs`. |
| Lighting — vertex-lighting uniforms | `u_lambertDiffuseMultiplier` + `u_vertexShadowDarkness` (tile-provider config), gated by `#ifdef ENABLE_VERTEX_LIGHTING` (defined when terrain has vertex normals). | Bridged via `camera.lighting.x` (`lambertDiffuseMultiplier`) and `camera.lighting.y` (`vertexShadowDarkness`) packed in the camera UB (Batch 77). The gate is a runtime branch on `camera.lighting.z` (`hasVertexNormals` flag, set from `tileProvider.terrainProvider.hasVertexNormals`). When the flag is on, WGSL uses the WebGL ENABLE_VERTEX_LIGHTING formula directly: `clamp(NdotL × mult × shadowFactor + darkness, 0, 1)`. When the flag is off, WGSL falls back to the existing DAYNIGHT_SHADING-analogue path. | **Shipped.** Layout: `camera.lighting: vec4<f32>` at `CAMERA_UNIFORM_FLOATS` offset 136-139. `.w` carries `zoomedOutOceanSpecularIntensity` since GLOBE-POLAR-STRETCH-POLISH (a future DAYNIGHT_SHADING `fade` bridge needs a new pad). |
| Lighting — diffuse coefficients (no vertex normals) | `clamp(NdotL × 5 + 0.3, 0, 1)` mixed by `fade` toward 1.0 at close range | `mix(1.0, computeDayNightDiffuse(dayNightNormalEC, sunDir), clamp(tile.lightingFade, 0, 1))` — the same expression and the same mix. Only used when `camera.lighting.z ≤ 0.5` (terrain has no vertex normals — DAYNIGHT_SHADING-equivalent path on WebGL). | **Matched as of CLT-B4 / CO-18 (Batch 925) — this row used to read "intentional algorithmic rewrite, not a parity bug", and that was wrong.** The old WGSL `mix(0.025, NdotL × 0.88 + 0.12, dayFade)` differed in three independent ways at once (coefficients, night floor, and the missing camera-distance mix), and lane D of `probe-daynight-terminator-law.mjs` measured the result: night/day luminance 0.312 / 0.0896 against WebGL's 1.000 / 0.300. See the day/night ramp law row above for the full contract. The `.w` slot in `camera.lighting` was never spent on this — the fade rides in `TileUniforms.lightingFade` instead. |
| Lighting — terminator glow (CLT-B3 local implementation, 2026-08-09) | `computeTerminatorGlow(normalEC, sunDirectionEC)` returns the analytic-normal, raw-signed-dot, warm `(0.95,0.45,0.15)`, `exp(-40·NdotL²)`, 0.15-amplitude term; the caller multiplies by dynamic `u_terminatorGlowStrength` and absolute eclipse visibility exactly once after base lighting. | The exact same two-argument function/law in `GlobeTerrain.wgsl`; the caller multiplies by `tile.tileControls.z` and absolute eclipse visibility once. | **Lockstep contract:** `Globe.terminatorGlowStrength` sanitizes non-finite/negative values to 0; default 0 is an exact natural/parity identity and branches before `exp`; value 1 preserves the former WebGPU stylized appearance on both backends. The term deliberately uses neither day/night ramp. Any coefficient, normal, eclipse, or application-order change lands in both shaders plus `globe-daynight-ramp-law.spec.mjs`. Local implementation is 59/59 contract-green; terminator-specific browser acceptance and landing remain owed. |
| Day/night term — normal source (CO-15, Batch 919) | `GlobeFS.glsl:595-597` recomputes the analytic geocentric normal per fragment (`czm_geodeticSurfaceNormal(v_positionMC, vec3(0), vec3(1))` → `czm_normal3D × normalMC`) and feeds it to both the day/night imagery alpha (`:600`) and the ENABLE_DAYNIGHT_SHADING diffuse. `GlobeVS.glsl:267` does not even write `v_normalEC` outside `ENABLE_VERTEX_LIGHTING \|\| GENERATE_POSITION_AND_NORMAL \|\| APPLY_MATERIAL`, so the day/night path has no mesh normal available. | `GlobeTerrain.wgsl::fragmentMain` derives `dayNightNormalEC = normalize((camera.modifiedModelView × vec4(normalize(v_positionMC), 0)).xyz)` — the same analytic normal in the same space — and feeds it to `computeDayNightFade`, the DAYNIGHT_SHADING Lambert (`dayNightNdotL`) and `computeTerminatorGlow`. Unconditional: no `ShaderDefine` bit, `//>>ifdef` depth 0. The VERTEX_LIGHTING Lambert, the G-buffer normal slot and the CSM slope bias keep the interpolated mesh normal, matching WebGL. | **WebGPU-side correction toward the existing WebGL law — no GLSL twin change needed, and the lockstep obligation is discharged by the GLSL already being correct.** Before CO-15 the WGSL fed the day/night family `input.v_normalEC`, which on normal-less terrain is `octDecode(0.0)` = a constant (0,0,-1) (the uncompressed no-extras pipeline declares that attribute `float32x2`, so the `.z` read is the WebGPU default 0.0) — every offline provider reports `hasVertexNormals === false`, so the default WebGPU globe had a globally-uniform day/night term with no terminator at all. Pixel-confirmed at Batch 915 (day-fade slope 0.000). Not byte-identical by design. Pinned by `Tools/visual-regression/globe-daynight-normal-source.spec.mjs`. The `+0.5` ramp offset it left open (CLT-B4) is closed at Batch 925 — see the day/night ramp law row above. Still divergent and tracked separately: the vertex-normal gating split (CLT-B1 finding (c)). |
| Shadow receive — code location | Not in `GlobeFS.glsl` source. WebGL pipeline cache injects shadow-sampling GLSL via `ShadowMapShader.js` per-pipeline based on the shadow-map config. | Inlined directly in `GlobeTerrain.wgsl`: `globeComputeShadowFactor` (single map), `globeComputeShadowFactorPointLight` (cube shadow point light), `globeComputeShadowFactorCSM` (cascaded shadow maps). Gated at runtime in fragmentMain. | Architecture difference forced by the pipeline-cache model: WebGL injects per-config GLSL strings; WebGPU uses fixed shaders with runtime gates. Both produce equivalent shadow visibility for matching shadow-map config. |
| VS — entry point structure | Single `void main()` (~286 lines) with #ifdef variants for every terrain encoding (QUANTIZATION_BITS12, INCLUDE_WEB_MERCATOR_Y, ENABLE_VERTEX_LIGHTING, GEODETIC_SURFACE_NORMALS, EXAGGERATION, ENABLE_CLIPPING_POLYGONS, FOG/GROUND_ATMOSPHERE/UNDERGROUND_COLOR/TRANSLUCENT, 2D-mode variants). Pipeline cache compiles per-define-set. | Six explicit `@vertex` entry points (`vertexMain`, `vertexMainWebMerc`, `vertexMainWebMercNormals`, `vertexMainQuantized`, `vertexMainQuantizedWebMerc`, `vertexMainQuantizedWebMercNormals`), each decoding a specific vertex layout, then handing off to a shared `processVertex()` helper for the layout-agnostic math. Pipeline picks the entry point based on terrain encoding. | Forced by language + pipeline-creation model: WGSL has no full preprocessor and WebGPU pipelines prefer a single shader module with multiple entries. Shared varying contract (see VS pair-section header) keeps the downstream FS math identical across backends. |
| VS preprocessor scope | Full C-style preprocessor handles all variant branching | Custom `//>>ifdef FLAG_NAME` subset gated by uint32 `ShaderDefine` bitmask (see `WebGPUShaderDefines.ts` / `WebGPUShaderPreprocessor.ts`). `GlobeTerrain.wgsl` currently uses `CAPTURE_MODE`, `ENHANCED_OCEAN`, `GEODETIC_NORMAL`, `GLOBE_IMAGERY_REDUCED`, `LOG_DEPTH`, and `MATERIAL_APPLY`. Add-only; never renumber. | Variants that GLSL handles via preprocessor are split between WGSL entry points, runtime gates, and this limited directive set. |
| VS shared math home | Inlined in `main()` | Hoisted to a `processVertex()` helper (called by all six entry points), so the position/normal/varying-setup math lives in one place. | Refactor of WebGPU side (Batch 20) removed an earlier proliferation of 6 parallel `*_Geo` entry points. Future WGSL VS additions should add their decoding logic and call into `processVertex()`. |
| Globe-FS V convention | `geoUV.y = 0` means terrain south edge | `geoUV.y = 0` means terrain south edge | Same convention. Imagery textures sampled at `geoUV.y` must have south at v=0 in the sampling space. |
| Reprojected-texture V convention | Output row 0 is south; `ReprojectWebMercatorFS.glsl` sets `srcV = mercatorFraction`. | Output row 0 is south; `ReprojectWebMercator.wgsl` also sets `srcV = mercatorFraction`. | Both shader bodies now use the same source-v expression and produce v=0 = south in the sampling convention. |
| NDC y-axis | NDC y=+1 = top of viewport = OpenGL framebuffer y=H-1 = texture memory row N-1 (OpenGL "top" of texture, sampled at v=1) | NDC y=+1 = top of viewport = WebGPU texture pixel row 0 (D3D-style top-left origin) | Affects reproject VS clip-space coords; FS texCoord interpolation must be set up to compensate. Reproject VS computes texCoord differently in each shader to bake out this difference. |
| Depth range | [-1, 1] | [0, 1] | Affects projection matrix row 2 only. Handled by `Matrix4.setDepthRangeType()`. Same vertex outputs visible to the FS. |
| Draped vector-tile polylines — lookup storage (C11-213 / UP144-VECTOR-LAYER-WGSL, 2026-08-06) | `VectorCommon.glsl` declares five `highp sampler2D`s (`u_vectorSegmentTexture`, `u_vectorWidthTexture`, `u_vectorColorTexture`, `u_vectorSegmentPrimitiveIndicesTexture`, `u_vectorGridCellIndicesTexture`) and reads them with `texelFetch` + `vectorIndexToUv` over power-of-two-padded textures. Uploaded by `VectorPipeline.packPolylineTextures`. | `GlobeTerrain.wgsl` declares one `@group(2) @binding(11) var<storage, read> vectorTileData: array<u32>` and indexes an 8-word header + four contiguous runs. Packed by `WebGPUVectorTileResources.packVectorTileWords`, realized through the `GLOBE_SURFACE` feature renderer's `prepareVectorTileData` hook. | **Mapped, not shared — and forced.** `texelFetch` on those five is WebGL2's only fragment-stage random-access buffer read, not sampling. Binding five sampled textures on WebGPU would take the C11-208 reduced low-limit globe layout from exactly 16 to 21, over the `maxSampledTexturesPerShaderStage` spec floor, and the globe pipeline would fail to create on default-limit adapters; `GLOBE_NON_IMAGERY_FRAGMENT_TEXTURES` stays 12 because a storage buffer costs none of that budget. **Any change to the word layout, the header indices, the cell-offset convention, the primitive record, or the RGBA byte order must land in `VectorCommon.glsl`, `GlobeTerrain.wgsl`, and `WebGPUVectorTileResources.ts` together** — pinned by `Tools/visual-regression/vector-layer-draping.spec.mjs` (21/21), whose oracle evaluates the GLSL algorithm over the raw `VectorTileData` and whose subject evaluates the WGSL index arithmetic over the real packer output. |
| Draped vector-tile polylines — per-tile gating (C11-213) | Compile-time: `#ifdef HAS_VECTOR_LAYER`, emitted by `GlobeSurfaceShaderSet` under shader-set flag bit `0x400000000` (upstream's `0x200000000` collides with the fork's `enableEclipseGlobeShadow`). `VectorCommon` is `unshift`ed ahead of `GlobeFS`. | Runtime: `vectorTileData[0]` (`gridWidth`) `== 0u` early-outs. Tiles with no draped geometry share one 32-byte all-zero placeholder buffer. The WebGL flag bit is untouched and remains WebGL-only. | Same shape as the ground-atmosphere and shadow-receive rows: WebGL forks the shader, WGSL uses a runtime gate. A per-tile define here would fork every globe pipeline variant (color/pick/depth-only/translucent/wireframe/capture/debug). Default-path cost is one u32 load per globe fragment. |
| Draped vector-tile polylines — screen-space width Jacobian (C11-213) | `mat2 screenFromUv = inverse(mat2(dFdx(vectorUv), dFdy(vectorUv)))`, taken inside `vectorPolylineRender`. | `vectorInverse2x2(uvJacobian, uvJacobianDet)`, with the Jacobian built from `dpdx`/`dpdy` of the raw (unclamped) `v_textureCoordinates.xy` at fragment entry and passed in. WGSL has no `inverse()` builtin, so the 2×2 inverse is written out with a singular-determinant guard. | **Forced by WGSL, and load-bearing.** WGSL rejects a derivative builtin reached through non-uniform control flow, and every `var<storage>` read is non-uniform by definition, so an inline `dpdx` under the `gridWidth` gate is a shader-creation error (naga catches it). Same hoisting discipline as `geoUV_dx`/`geoUV_dy` for `textureSampleGrad`. Both sides use the unclamped tile UV; the WGSL's seam-clamped `geoUV` would zero the derivative on a fragment quad that clamps to one edge value. |
| Draped vector-tile polylines — composite position (C11-213) | `GlobeFS.glsl` main tail: after `#ifdef UNDERGROUND_COLOR`, before `#ifdef TRANSLUCENT`. Alpha-composite, no discard. | `GlobeTerrain.wgsl` `fragmentMain` tail: after the `GLOBE-UNDERGROUND-COLOR` block, before `GLOBE-TRANSLUCENCY-ALPHA`. Same alpha-composite expression. | **Matched, and the ordering is semantic, not cosmetic:** a draped line over a translucent globe must fade with the globe rather than punch through it. Pinned by spec `D4`, which reads both files' block order. |
| Sky atmosphere — file layout | Three files: `SkyAtmosphereVS.glsl`, `SkyAtmosphereFS.glsl`, and `SkyAtmosphereCommon.glsl`, plus `czm_*` builtin includes for scattering, atmosphere color, tonemap, gamma, HSB shift, and ray-sphere. | One `Shaders/WebGPU/Environment/SkyAtmosphere.wgsl` file with vertex and fragment entry points and all helpers inlined because WGSL has no preprocessor includes. | Different file-organization model; algorithmic content matched section-for-section. |
| Sky atmosphere — ray-march steps | `Builtin/Functions/computeScattering.glsl` defines 16 primary steps, four light steps, and the adaptive `rayStepLengthIncrease` curve. Planet-striking rays march through the planet interior; exponential density overflow extinguishes the ray and shapes the limb extinction tail. | A 1:1 port of `czm_computeScattering` (Batch 247) uses the same step counts and adaptive curve. Planet-striking rays also march through; underground sample heights are floored at −150 km so extinction remains deterministic where WGSL `exp()` overflow is indeterminate. | Same visual result: black through-planet rays plus matching limb peak and tail. |
| Sky atmosphere — per-vertex vs per-fragment | `#ifdef PER_FRAGMENT_ATMOSPHERE` selects per-fragment evaluation; the other branch interpolates `v_mieColor`/`v_rayleighColor` varyings. | Always per-fragment (same logic as ground atmosphere Batch 56). `VertexOutput` carries position, world position, camera-to-vertex delta, and UV; none is an interpolated scattering-color result. | WGSL output matches GLSL's per-fragment path; per-vertex scattering would re-introduce mesh-pattern artifacts at orbit altitudes. |
| Sky atmosphere — LUT fast-path | None (WebGL2 has no compute shaders). Always inline ray-march. | `useLut > 0.5` branch replaces 64-step ray march with single inscatter LUT sample (LUT baked once per sun-direction change by `WebGPUPerformanceManager`). Falls back to inline ray-march when LUT unavailable or camera is well above the atmosphere shell. | **Intentional WGSL-only enhancement (Phase 4).** Documented as such. |
| Sky atmosphere — dual-light scattering | Single light source only. | Optional sun + moon scattering when `dualLightControl.x > 0.5`. Samples a second inscatter LUT (`moonInscatterLut`) baked separately for the moon direction; sums contributions scaled by moon phase × moon intensity. | **Intentional WGSL-only enhancement (Phase 1.3c).** Not visible in default scenes (`dualLightControl.x = 0`). |
| Sky atmosphere — debug bypass | None. WebGL debug uses external CesiumDebug commands. | `u.debug.x > 0.5` → flat magenta output. Lets user isolate scattering math bugs from LUT/composite errors. | WGSL-only diagnostic. Off by default. |
| Sky atmosphere — wind state | None. | `windDirectionAndSpeed: vec4` plumbed through UBO ahead of Phase 5/6 (volumetric fog advection, cloud motion). Currently unused by the FS. | Scaffolding only. No visible effect today. |
| Sky atmosphere — tonemap chain gating | `#ifndef HDR` gates `czm_pbrNeutralTonemapping` + `czm_inverseGamma`; `#ifdef COLOR_CORRECT` gates `czm_applyHSBShift`. | Always applies `pbrNeutralTonemapSky` (ported czm_pbrNeutralTonemapping) + sRGB encode via `pow(x, 1/2.2)`; HSB shift gated on `abs(hsbShift.x/y/z) > 0.001`. HDR mode handled separately in WebGPU post-process pipeline. | Same intent; different gating mechanism. Output matches in non-HDR mode. |
| Sky atmosphere — vertex transform | `czm_model * position` (no RTE — single precision suffices because atmosphere shell mesh is centered at planet origin). | `mvpRelativeToEye × translateRelativeToEye(positionHigh, positionLow, encodedCameraHigh, encodedCameraLow)` — RTE used uniformly across all WGSL shaders for consistency. | WGSL vertex buffer carries `positionHigh`/`positionLow`; CPU-side packer emits split-precision attributes for the atmosphere shell mesh. |
| Sky atmosphere — translucent globe brightening | `#ifdef GLOBE_TRANSLUCENT` path in computeAtmosphereScattering brightens the inside-globe view when globe-translucency is enabled. | Ported as a runtime gate: `u.atmosControl.w > 0.5` (packed from `frameState.globeTranslucencyState.translucent`) takes the distance/angle-faded horizon-gradient branch inside `skyColorForRay` (GLOBE-TRANSLUCENCY-ALPHA, Batch 488). 0 by default → byte-identical non-translucent path. | Compile-time define vs runtime flag is the only divergence; math matches SkyAtmosphereCommon.glsl L63-90. |
| Sky atmosphere — ellipsoid math | Pulls `czm_ellipsoidRadii`, `czm_ellipsoidInverseRadii`, `czm_eyeHeight`, `czm_viewerPositionWC` from automatic uniforms. Computes runtime `distanceAdjust`. | Pulls `radiiAndDynamicAtmosphere` + `cameraPositionWC` from explicit Uniforms struct. The `distanceAdjust` math runs CPU-side in `WebGPUSkyAtmosphereRenderer` so the shader-side `innerRadius` is already adjusted. | Same downstream math; the adjustment lives in the renderer for WebGPU. |
| Sky atmosphere — light-direction selection (C12-31, 2026-08-01) | New shared builtin `czm_getSkyAtmosphereLightDirection` (`Builtin/Functions/getSkyAtmosphereLightDirection.glsl`), called from both `SkyAtmosphereVS.glsl` and `SkyAtmosphereFS.glsl`. Four arms: NONE(0)/SUNLIGHT(2) → `czm_sunDirectionWC`, SCENE_LIGHT(1) → `czm_lightDirectionWC`, LEGACY_OVERHEAD(3) → `positionWC`. | The same selection inlined in `skyColorForRay` as the `isLegacyOverhead` block (WGSL has no builtin include mechanism). Two arms rather than three because the renderer packs the scene light into `sunDirectionWC` for enum 1 (`useSceneLight === 1`, `WebGPUSkyAtmosphereRenderer.js`). | **Matched — this row is a lockstep obligation, not a divergence.** Before C12-31 both backends substituted local up for the astronomical Sun on the NONE path, which is the default whenever `globe.enableLighting` is false: `cosAngle` in `computeAtmosphereColor` went to ≈1 along every ray, parking the Mie phase on a forward peak 4869.9× its 90° value (default `g = 0.9`) and painting a view-locked white aureole. The enum value is deliberately unchanged, so the `!= 0` day/night alpha gates in `SkyAtmosphereCommon.glsl` and the WGSL stay byte-identical. Pinned by `Tools/visual-regression/sky-light-direction.spec.mjs` (24/24). |

The convention ledger is the load-bearing part of this plan. When a pair
is in lockstep, the shader files look identical (modulo language syntax)
*because* the convention table is the place where the cross-backend
boilerplate is concentrated. The shader math itself is convention-free.

---

## Lockstep discipline

### When editing a shader

1. **Keep behavior changes in lockstep.** Edit every affected counterpart in
   the same commit. A PR that changes paired shader behavior without the
   matching counterpart edits fails review; pair-comment formatting follows
   the exception stated with the canonical marker above.
2. **After a paired behavior change is re-verified and lands, update this
   lockstep audit table** with the audit date and the landed commit SHA for
   the re-verified shader state. Pair-comment formatting alone does not create
   a new audit record, and shader files never carry audit dates or batch numbers.
3. **Add or update a convention-ledger entry** if the change touches a
   cross-backend convention (upload, NDC, depth, attribute layout, …).
4. **Use the same comment text** for any change that affects the algorithm.

### When reviewing a shader change

1. Open all files in the pair side-by-side. Confirm the diffs mirror each
   other.
2. Run the matching-pair regression probe (one per pair; see "Validation").
3. Confirm the convention ledger is unchanged or correctly extended.

### When a divergence is discovered

1. File it under the convention ledger if it's a backend-API difference
   that the shaders must encode differently.
2. Fix it if it's a backend-shader bug.
3. Document the resolution in `WEBGPU_DEBUGGING_LOG.md` for the historical
   trail.

---

## Validation

Each pair gets one regression probe in `Tools/visual-regression/` that:

1. Loads the WebGL viewer; renders a known view; captures pixels.
2. Loads the WebGPU viewer; renders the same view; captures pixels.
3. Reports per-channel mean delta and mismatch%.

The reproject pair already has:
- `probe-reprojected-texture-compare.mjs` — dumps source + output textures
- `probe-polar-multi-plain.mjs` — captures polar views, diffs them
- `probe-batch65-state.mjs` — validates dual-texture state

No fixed percentage threshold is used: driver-level precision drift is real
and accepted. The probe's role is to detect *new*
divergence introduced by a change. CI compares against the most-recent
golden baseline.

---

## Phased rollout

### Phase 1 — Imagery reproject pair (shipped; historical plan)

Phase 1 is complete. The original work list below is retained as historical
planning context and is not a set of open instructions.

**Smallest pair. Cleanest target. Already mathematically aligned post-Batch 66.**

Pair files:
- `Source/Shaders/ReprojectWebMercatorFS.glsl`
- `Source/Shaders/ReprojectWebMercatorVS.glsl`
- `Source/Shaders/WebGPU/ReprojectWebMercator.wgsl` ← promoted from doc-only to source-of-truth
- `Source/Renderer/WebGPU/WebGPUImageryReprojection.ts` ← inline WGSL string removed, loads .wgsl via `.js` wrapper

Work items:
1. Add the canonical plain pair comments to the three shader files.
2. Promote `ReprojectWebMercator.wgsl` from documentation copy to runtime
   source — `WebGPUImageryReprojection.ts` imports the compiled `.js`
   wrapper, drops the inline string.
3. Align variable names, local-binding ordering, and comments between
   GLSL and WGSL.
4. Resolve the texCoord-interpolation convention divergence (currently
   GLSL passes `position.xy` directly, WGSL flips Y in the VS). Decide on
   one convention and update both shaders so the FS math is identical.
5. Update the convention ledger above with any leftover backend-API
   differences that the shaders must encode differently.
6. Run `probe-reprojected-texture-compare` and `probe-polar-multi-plain`;
   confirm no regression.
7. Document the result in `WEBGPU_DEBUGGING_LOG.md`.

### Phase 2 — Globe terrain pair (largest pair, multi-batch)

Pair files:
- `Source/Shaders/GlobeFS.glsl`
- `Source/Shaders/GlobeVS.glsl`
- `Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` (combined VS, FS, and variants)

This is a multi-batch effort. The WGSL file is much larger because it
combines VS+FS+multiple terrain-encoding variants into a single module
(necessitated by how Cesium structures WebGPU pipelines). Line-for-line size
is not the target; sections are matched section-for-section.

Sub-phases:
1. **Imagery composite section.** ~100 lines each side. Smallest sub-phase.
2. **Per-fragment ground atmosphere.** ~250 lines each side.
3. **Water/ocean.** ~200 lines each side.
4. **Lighting + shadows.** ~150 lines each side.
5. **Fog + drape.** ~120 lines each side.
6. **VS path** (uncompressed / quantized / quantized-with-WebMercT / with-normals).

Estimated total: 4-6 batches, one per sub-phase.

### Phase 3 — Other shader pairs

In rough priority order:

- Phase 3.1 — Sky atmosphere (Batch 76, **shipped**)
- Phase 3.2 — Post-process collection (Batch 81, **documented**; see below)
- Phase 3.3 — Shadow cast (CSM, point lights) (Batch 82)
- Phase 3.4 — Cube map panorama (Batch 83)
- Phase 3.5 — Particle system (Batch 84)

Each is its own pair-alignment batch.

---

#### Phase 3.2 — Post-process collection inventory (Batch 81)

The post-process collection diverges from the globe / sky atmosphere pattern in two important ways:

1. **No line-by-line port intent.** Most WGSL post-process shaders are standalone re-implementations of the same algorithm rather than line-by-line ports — the GLSL versions rely on `czm_*` automatic uniforms and the upstream Cesium build's `Builtin/Functions/` include path, while WGSL has neither (no `#include` and no automatic uniforms — every uniform must be a declared binding). FXAA is the clearest example: GLSL imports an `FxaaPixelShader(...)` helper that hand-bundles 200+ lines of NVIDIA's reference FXAA 3.11; WGSL inlines the same algorithm directly in `FXAA.wgsl`. Both produce the same anti-aliased output; one concise canonical marker is sufficient and should not be repeated at every section.
2. **Each effect is a leaf-level shader, not part of a larger composite.** Each
   leaf still gets the canonical one- or two-line marker; the ledger below owns
   the detailed relationship and audit state.

**Matched-pair inventory** (both backends ship the effect):

| Effect | GLSL | WGSL | Algorithm match |
|---|---|---|---|
| AdditiveBlend | `Shaders/PostProcessStages/AdditiveBlend.glsl` | `Shaders/WebGPU/PostProcess/AdditiveBlend.wgsl` | Same radial bounded composite, with WGSL's required y-origin conversion and zero-radius guard |
| Ambient occlusion — generate | `AmbientOcclusionGenerate.glsl` | `AmbientOcclusionGenerate.wgsl` | Same Crytek-style SSAO with view-space depth reconstruction |
| Ambient occlusion — modulate | `AmbientOcclusionModulate.glsl` | `AmbientOcclusionModulate.wgsl` | Same (scene color × ao map) |
| Black and white | `BlackAndWhite.glsl` | `BlackAndWhite.wgsl` | Same (luminance + grad ramp) |
| Bloom composite | `BloomComposite.glsl` | `BloomComposite.wgsl` | Same (scene + blurred bright pass) |
| Brightness | `Brightness.glsl` | `Brightness.wgsl` | Same multiplicative scale |
| Composite translucent classification | `CompositeTranslucentClassification.glsl` | `CompositeTranslucentClassification.wgsl` | Same over composite with classification mask |
| Contrast bias | `ContrastBias.glsl` | `ContrastBias.wgsl` | Same (color − bias) × contrast |
| Depth of field | `DepthOfField.glsl` | `DepthOfField.wgsl` | Same effect role, different current blur law: frustum-normalized asymmetric falloff vs focal-range smoothstep |
| Depth view | `DepthView.glsl` | `DepthView.wgsl` | Same grayscale depth visualization |
| Edge detection | `EdgeDetection.glsl` | `EdgeDetection.wgsl` | Same Sobel-style discriminator |
| FXAA | `FXAA.glsl` (calls `FxaaPixelShader` helper) | `FXAA.wgsl` (inlines FXAA 3.11) | NVIDIA FXAA 3.11 — same algorithm, different source layout |
| Gaussian blur 1D | `GaussianBlur1D.glsl` | `GaussianBlur1D.wgsl` + `GaussianBlur1D_f16.wgsl` | Live separable blur pair; the f16 shader is kept in sync with the f32 WGSL reference |
| Lens flare | `LensFlare.glsl` | `LensFlare.wgsl` | Core ghost/halo path ported; WGSL currently omits the dirt overlay and replaces star-texture modulation with 1.0 |
| Night vision | `NightVision.glsl` | `NightVision.wgsl` | Same noise + green tint + vignette |
| PassThrough | `PassThrough.glsl` | `PassThrough.wgsl` | Identity (1-line shader) |
| PassThroughDepth | `PassThroughDepth.glsl` | `PassThroughDepth.wgsl` | Source-divergent: GLSL packs depth while WGSL emits raw depth as grayscale |
| Silhouette | `Silhouette.glsl` | `Silhouette.wgsl` | Same edge-detection + color overlay |
| Point-cloud eye-dome lighting | `PointCloudEyeDomeLighting.glsl` + WebGL derived depth shader | `PointCloud/PointCloudEDLDepth.wgsl` + `Advanced/PointCloudEDL.wgsl` | Live two-pass WebGPU port: depth-writing draw followed by neighbor-depth blend |

`PostProcess/BrightPass.wgsl` is the HSB/contrast bloom stage, not the
counterpart of the luminance-threshold `PostProcessStages/BrightPass.glsl`.
That GLSL shader's lockstep counterpart is `PostProcess/SunBrightPass.wgsl`,
listed in the environment/sun-bloom group below. `BrightPass.wgsl` is itself a
port of `ContrastBias.glsl` and shares that pair's lockstep obligation.

**WebGPU-only effects** (intentional Phase 4+ enhancements, no WebGL counterpart by design):

- **TAA (Temporal Anti-Aliasing)** — `TAA.wgsl`. WebGL has FXAA only; TAA is a fork-WGSL-only enhancement requiring motion-vector + history buffer infrastructure (DP-H41 + Phase 8a). Slices 2-4 still pending per Tier 2.
- **GTAO (Ground-Truth Ambient Occlusion)** — `GTAOGenerate.wgsl`. Higher-quality SSAO alternative; WebGL backend has the older SSAO only.
- **SSR (Screen-Space Reflections)** — `ScreenSpaceReflections.wgsl`. WebGL backend has no reflections; SSR is a fork-only addition (`FEAT-SURVEY-36`).
- **God Rays (volumetric light shafts)** — `GodRayGenerate.wgsl` + `GodRayComposite.wgsl`. Fork-only Phase 3 effect.
- **Volumetric Fog** — `PostProcess/VolumetricFogComposite.wgsl` **and its froxel compute module `Compute/VolumetricFog.wgsl`** (named explicitly since 2026-08-06: the compute half carries the density/scattering/integrate/temporal kernels and the cheap cloud-shadow gate, and a reader looking only at the composite could mistake it for the whole effect and go hunting for a GLSL twin). Fork-only Phase 5 effect (compute-shader-baked); WebGL2 has no compute, so neither file has a GLSL counterpart and no lockstep row is owed for either. **Not twin-free, though:** the compute module is compiled as `CloudDensityDomain.wgsl + VolumetricFog.wgsl` and shares `cloudEffectiveCoverage` with `ProceduralClouds.wgsl` / `ProceduralSkyCubemap.wgsl`, and its `normalizeFogCheapCloudField` has a CPU twin in `WebGPUCloudDensityDomain.ts` — both pinned by `Tools/visual-regression/fog-cheap-coverage-gate.spec.mjs`.
- **Tonemapping (unified)** + `Tonemapping_f16.wgsl` — fork-only consolidated tonemapper. WebGL ships five separate tonemap shaders (Aces, Filmic, ModifiedReinhard, PbrNeutral, Reinhard); WGSL unifies them into one shader with a runtime `tonemapperType` uniform branch. The PBR-Neutral branch (default tonemapper) is an exact port of `czm_pbrNeutralTonemapping` since `NEW-PP-LIBRARY-TONEMAP-ORDER` (2026-07-03; previously a per-channel soft-clamp approximation that over-brightened highlights, 1.0 → sRGB 249 vs the reference 239). The other four branches have not yet been parity-audited against their `czm_*` references.
- **ColorGrading** — `ColorGrading.wgsl`. WebGL fakes this via tonemap+brightness+contrast chain.
- **OITComposite** — `OITComposite.wgsl`. Order-independent transparency composite; WebGL backend uses a different OIT scheme (multi-target depth peeling) with no equivalent single shader.
- **DeferredGBuffer + DeferredLighting** — `DeferredGBuffer.wgsl` + `DeferredLighting.wgsl`. The opt-in deferred path has a current MRT producer in `WebGPUSceneRenderer._executeGBufferProducer`; it is no longer producer-pending scaffolding.
- **DepthPlane / AdjustTranslucent / CompareAndPackTranslucentDepth** — multi-frustum translucent classification helpers (`C-R8`); WebGL uses stencil-based classification with no equivalent shader.

**WebGL-only source factoring** (legacy):

- **AcesTonemappingStage, FilmicTonemapping, ModifiedReinhardTonemapping, PbrNeutralTonemapping, ReinhardTonemapping** — superseded by WGSL's unified `Tonemapping.wgsl`. Each WebGL variant lives as its own shader file because WebGL's `PostProcessStageComposite` swaps shaders rather than uniforms; WGSL is the better factoring.
**Net status:** the post-process collection is functionally matched for shipped
WebGL effects, including the live Gaussian blur and point-cloud EDL paths. The
WGSL collection also adds intentional effects with no WebGL counterpart.

---

#### Phase 3.3 — Shadow cast inventory (Batch 82)

Shadow architecture is **fundamentally different** between backends; line-by-line pair alignment isn't applicable. Recording the architectural divergence + the matched-functionality inventory.

**WebGL architecture (runtime string-concat):**

- `packages/engine/Source/Scene/ShadowMapShader.js` generates GLSL **at runtime** by concatenating strings based on the shadow-map config (single vs cascaded vs cube point-light, PCF kernel size, debug visualization toggles). The generated GLSL is **injected into every receive-pipeline's fragment shader** by the WebGL pipeline cache during shader compilation.
- `packages/engine/Source/Shaders/Builtin/Functions/shadowDepthCompare.glsl` + `shadowVisibility.glsl` are static helper functions called by the generated code.
- Effect: every receiving shader (GlobeFS, ModelFS, primitives, etc.) has its own variant compiled with shadow code baked in.

**WebGPU architecture (static WGSL with runtime gates):**

- `packages/engine/Source/Shaders/WebGPU/Shadow/ShadowMap.wgsl` — cast (depth-only) shader.
- `packages/engine/Source/Shaders/WebGPU/Shadow/ShadowReceiveCSM.wgsl` — standalone CSM receive shader for primitives without an inline path.
- `packages/engine/Source/Shaders/WebGPU/chunks/functions/csm_samplePointShadow.wgsl` — point-light cube shadow sampling helper.
- Receive logic is **inlined directly into each receiver shader's WGSL source** as `globeComputeShadowFactor`, `globeComputeShadowFactorPointLight`, and `globeComputeShadowFactorCSM`, gated at runtime by `csmControl.x > 0.5` and `pointLightShadow > 0.5` flags in the effects UBO.

Why the divergence is forced (not avoidable):

- WGSL has **no preprocessor strong enough** to support WebGL's pipeline-cache string-concat model. The custom `//>>ifdef FLAG_NAME` over a uint32 bitmask handles boolean variants but can't fold in dynamically-generated kernels or per-config sampling loops.
- WebGPU pipeline creation strongly prefers a **single shader module with multiple entry points** over per-config shader compilation. The runtime gate model fits this pattern naturally.

**Matched-functionality inventory:**

| Shadow feature | WebGL | WebGPU | Status |
|---|---|---|---|
| Single shadow map (point/spot/directional light) | `ShadowMapShader.js` generates per-config GLSL | `globeComputeShadowFactor` inlined in receivers; `ShadowMap.wgsl` cast shader for the depth pass | **Matched** |
| Point-light cube shadow | `ShadowMapShader.js` cube path + `czm_samplePointShadow` helper | `globeComputeShadowFactorPointLight` inlined; `csm_samplePointShadow.wgsl` helper | **Matched** |
| Cascaded shadow maps (CSM) | `ShadowMapShader.js` cascade path with kernel-size config | `globeComputeShadowFactorCSM` inlined; `ShadowReceiveCSM.wgsl` for primitives. CSM Slice 1+2 shipped per session-handoff memory. | **Matched (Slice 1+2)** |
| PCF (Percentage-Closer Filtering) kernel | Generated, kernel size from config | Runtime `pcfRadius` from `effects.csmControl.y`; zero selects one hard tap and positive values select a 3×3, nine-tap box | **Functionally matched**; WGSL exposes runtime radius rather than a compile-time kernel generator. |
| Depth-bias + slope-scaled bias | Per-shadow-map uniforms | `csmControl.zw` + per-cascade scratch | **Matched** |
| Cast depth-only pipeline | Hand-bundled in `ShadowMap.js` orchestrator | `ShadowMap.wgsl` cast pipeline + render-bundle reuse via `WebGPURenderBundleManager` | **Matched** |
| Cube-face cast | `ShadowMap.js` 6-face render loop | `ShadowMap.wgsl` parameterized by face index, called 6× per frame | **Matched** |

**WebGPU-only enhancements** (intentional):

- **Variance Shadow Maps (VSM)** — CSM Slice 3 (pending). Not in WebGL backend.
- **Altitude-adaptive cascade splits** — CSM Slice 3 (pending). WebGL uses fixed logarithmic split distances.
- **Moon dual-light shadows** — CSM Slice 3 (pending). WebGL has single-light shadows only.
- **3D Tiles per-tile shadow cull** — CSM Slice 4 (pending). WebGL casts all 3D Tiles regardless.
- **Render-bundle pre-recorded cast** — `WebGPURenderBundleManager` caches the cast command sequence per-shadow-map for reuse. WebGL has no render-bundle equivalent.

**Net status:** shadow cast + receive is **architecturally matched** at the feature level — every WebGL shadow capability has a WebGPU equivalent, just implemented through inline-runtime-gates rather than runtime-generated-strings. CSM Slice 3-4 add fork-only enhancements (VSM, adaptive splits, dual-light, 3D Tiles culling) per the Tier 1 roadmap.

---

#### Phase 3.4 — Cube map + environment inventory (Batch 83)

The environment/cube-map shader collection diverges by design — WebGL ships a small set of legacy environment shaders; WebGPU replaces and extends them with a fork-specific set keyed on compute-shader pre-baked cubemaps and runtime-generated procedural environments.

**Matched pairs:**

| Effect | GLSL | WGSL | Algorithm match |
| --- | --- | --- | --- |
| Sun billboard | `SunFS.glsl` + `SunVS.glsl` | Production inline `SUN_SHADER_WGSL` in `WebGPUEnvironmentRenderer.js` (`Environment/Sun.wgsl` is a reference/prototype, not the compiled billboard shader) | Same disc + corona algorithm. The WebGPU draw path is RTE-safe and resource-stable: immutable quad directions are uploaded once, the moving ECEF center is high/low encoded in the per-frame uniform payload, and the vertex buffer/bind group/draw command are reused across clock ticks unless a real device/pipeline/bake invalidator fires. **C12-19 (2026-08-07) adds a live lockstep pair to this row: the disc radiance.** `SunFS.glsl`'s `out_FragColor.rgb *= u_discRadiance` ↔ the WGSL's `color = vec4f(color.rgb * u.discRadiance, color.a)`. Three things are contract, not style: (1) it runs **after** the gamma decode on both sides — a radiance is linear, and a pre-decode multiply would raise it to the gamma (a 2x sun landing at 4.6x); (2) it touches **RGB only** — alpha is this billboard's ALPHA_BLEND destination weight since C11-115, and an alpha above 1 makes `1 - a` negative, that is the sun subtracts the sky; (3) both sides read one published number, `frameState.sunHalo.discRadiance` from `Scene/SunHaloAppearance.js`, so the WebGL uniform closure and the WGSL slot (the former `_sunPad1` pad at offset 39 — renamed, not added, so there is no uniform-layout delta and no new ShaderDefine bit) cannot disagree about how bright the sun is. `Tools/visual-regression/sun-hdr-radiance.spec.mjs` asserts the ordering, the rgb-only restriction and the shared publication, and rejects the alpha-multiply mutant on both backends. |
| Sun disc bake (C12-15 / C12-16, 2026-07-25) — **an unusual pair: GLSL vs a JS CPU loop, not GLSL vs WGSL** | `SunTextureFS.glsl`, run once per texture rebuild as a `ComputeCommand` full-screen pass | `WebGPUEnvironmentRenderer.createSunTexture` — a JS double loop that writes the texels directly (`Environment/Sun.wgsl` exists but is not the production shader; the renderer compiles an inline `SUN_SHADER_WGSL` string for the billboard, and the bake never reaches the GPU) | **Matched, and matched structurally rather than by convention.** Both sides read one resolved payload, `frameState.sunDiscAppearance`, published by `Sun.update` before the backend branch from `Scene/SunDiscAppearance.js` over the constants in `Scene/SolarDiscModel.js`. The GLSL takes it as `u_limbDarkening` (vec3) + `u_glareProfile` (vec4) and holds no numeric copy; the JS loop imports it. So the limb-darkening triple, the glare core/pedestal/legacy-edge and the legacy-branch selector cannot drift — there is no second literal to drift. The JS `sunGlare()` closure is the explicit twin of the GLSL `sunGlare()` function and is commented as such on both sides. Differences that remain and are intentional: bake size + format (C12-17 — both now follow `2^(ceil(log2(max(dbW, dbH))) - 2)` and select half-float under HDR, but WebGPU caps at 1024 because its loop runs on the CPU), and f32-vs-f64 evaluation (both quantise to 8/16-bit afterwards, so the difference is below one code). Pinned by `Tools/visual-regression/solar-disc-model.spec.mjs` (asserts the GLSL carries no literal and that the JS bake reads `appearance.*`) and measured by `probe-sun-glow-profile.mjs` (`geometry_lockstep` + `c12_16_support` + `c12_15_appearance` gate the two backends against each other). |
| Cube map panorama (loader for HDR environment textures) | `CubeMapPanoramaVS.glsl` (VS only — FS lives in the JS-side panorama orchestrator) | `WebGPU/CubeMapPanorama.wgsl` (single file with VS+FS, mirrored by the renderer's embedded production source) | Same equirectangular → cube-face projection. Star brightness, cloud attenuation and the **C12-27 angular solar-glare washout** are additionally paired only when `CubeMapPanorama.isStarMap === true`; the option defaults false and `SkyBox` opts in, so generic/Street View panoramas retain exact identity. |
| **Star sprite catalogue (C12-27 pair, 2026-08-06)** | `StarFieldVS.glsl` + `StarFieldFS.glsl` | `WebGPU/Catalog/StarField.wgsl` | **Already a full pair for the PSF (C12-05/06/07: `STAR_PSF_SIGMA/ALPHA/BETA/K_HALO` are literal-identical in both fragment shaders, pinned by `starfield-psf.spec.mjs`) and for the C7 extinction. C12-27 adds a VERTEX-stage pair:** an identical `solarGlareVeil(cosSeparation, core, pedestal, support)` function, fed by `u_solarGlare` / `u_solarGlareCurve` (GLSL) and the `solarGlare` / `solarGlareCurve` UB members (WGSL), both written from one CPU resolution (`frameState.solarGlareAppearance`, `Scene/SolarGlareAppearance.js`, constants in `Scene/SolarDiscModel.js`). **Two frame facts are part of the contract:** (1) both shaders dot against the raw `directionFixed` attribute — the TEME catalogue direction — never the rotated `dirFixed`, because the published Sun vector is resolved into TEME; (2) the glare rides last in both `v_color` / `output.color` multiply chains, so the disabled position (`glare == 1.0`) is an exact identity rather than a re-association of the product. Pinned by `Tools/visual-regression/solar-glare-star-washout.spec.mjs`, which extracts and compiles both bodies and requires 1e-15 agreement with the JS reference. |
| Sky atmosphere | `SkyAtmosphereVS/FS/Common.glsl` | `Environment/SkyAtmosphere.wgsl` | Documented Phase 3.1 (Batch 76) |

**WebGL-only legacy** (not migrated, intentional):

- **SkyBox (`SkyBoxFS.glsl` + `SkyBoxVS.glsl`)** — the WebGL legacy
  skybox renderer. On WebGPU, `Scene/SkyBox.js` delegates the scene skybox to
  `CubeMapPanorama`; `ProceduralSkyCubemap.wgsl` instead serves the separate
  dynamic environment-map/IBL bake. The panorama path is not a line-by-line
  port of the complete upstream SkyBox shaders, but the paired celestial
  modulation below remains a lockstep obligation.
  - **Partial lockstep pair since C12-29 S6 (2026-07-25).** `SkyBoxFS.glsl` is no longer nine lines and no longer unpaired: it carries the star-brightness modulation and the cloud-cover occlusion, byte-for-byte the same expressions as `CubeMapPanorama.wgsl` (and its JS-embedded production copy in `WebGPUCubeMapPanoramaRenderer.js`), fed by `u_starModulation` (inflection, steepness, enableFlag, cloudCover) + `u_skyBrightness` from `CubeMapPanorama.js` — the WebGL twin of `params.w` + `starModulation`. **The order is part of the contract**: modulate → cloud-occlude → gamma. `czm_gammaCorrect` is a no-op without HDR, but with HDR on it is an sRGB→linear decode, and `k·x^g ≠ (k·x)^g`, so moving the multiply across it silently desynchronises the two backends. Ruling E3 makes this a default-on path on both backends **for the `SkyBox` celestial panorama only**. `CubeMapPanorama.isStarMap` defaults false, and the shared CPU resolver forces both multipliers to identity for generic and Google Street View panoramas. Pinned by `Tools/visual-regression/eclipse-sky-totality.spec.mjs` ("one expression, four implementations" + ordering + panorama-isolation tests). The cubemap sampling and the procedural bake remain unpaired as described above.
  - **C12-27 extends this pair (2026-08-06).** `SkyBoxFS.glsl` and both WGSL copies now also carry an identical `solarGlareVeil(cosSeparation, core, pedestal, support)` — the angular solar-glare star washout — fed by `u_solarGlare` / `u_solarGlareCurve` and the `solarGlare` / `solarGlareCurve` UB members from one CPU resolution (`frameState.solarGlareAppearance`). **The contract order grows one step: modulate → cloud-occlude → glare → gamma**, for the same reason the previous two multiplies sit before `czm_gammaCorrect`. Both twins sample and dot the same `normalize(v_texCoord)` / `normalize(input.texCoord)` direction, which is the cube map's TEME lookup frame on both backends (WebGL applies `czm_temeToPseudoFixed` in `SkyBoxVS.glsl`; WebGPU passes it as `panoramaTransform`). Unlike the star modulation, the glare is **not gated on `frameState.skyAtmosphereVisible`** and must not become so: veiling glare is scattering in the observer's optics, not in an atmospheric column, and the orbital viewpoint is exactly where the row was reported from. The WebGPU UB grew add-only 256 → 288 bytes (new vec4s at offsets 240/256; no BGL or bind-group churn). Pinned by `Tools/visual-regression/solar-glare-star-washout.spec.mjs`. **Watch item for anyone editing the JS-embedded WGSL: keep that template literal free of backticks.** The specs slice it out by scanning for the first backtick immediately followed by a semicolon, so one inside the string truncates the extracted shader and the naga check then validates a fragment — that regression was introduced and caught within this batch.

**C12-29 S6 CPU/runtime lockstep correction (2026-07-26).** Shader parity
depends on feeding the pair the same current state and executing it once:

- `Moon.update` publishes current-frame direction and phase before
  `frameState.skyBrightness`; a request-render-mode clock step therefore
  cannot leave the shaders modulating from the previous rendered Moon.
- Scene passes ellipsoidal `camera.positionCartographic.height`. The cubemap
  brightness estimator and catalogue sprite path share the continuous 60–111
  km `computeAtmosphericColumnFactor`; the former hard 100 km catalogue step
  and hard-coded Earth-radius subtraction are gone.
- WebGPU StarField, SkyAtmosphere, and Sun are return-only feature renderers.
  Scene owns visibility and environment order; none also inserts a binned copy
  into `frameState.commandList`.
- Scene canonicalizes the `skyBox -> starField` prefix in place. The already
  canonical path is idempotent, while one stable compaction removes legacy or
  repeated identities without allocating a temporary command list.
- Pixel-pair probes must synchronously freeze the live GPU canvas in the render
  task. Awaiting decode of the immutable PNG is valid; awaiting before the
  live-canvas read is not.
- S2 manual-equivalence captures isolate S6 horizon twilight on the engine
  reference only for that comparison and restore it immediately. The
  dedicated S6 totality probe keeps the shipped horizon effect default-on, so
  shader lockstep is certified without asking the S2 twin to reproduce an
  additional S6 term.

**Additional environment lockstep groups and one-way enhancements:**

- **`Environment/Moon.wgsl` ↔ `Shaders/EllipsoidFS.glsl`** — current ray-marched
  analytic-moon pair. WebGL reaches `EllipsoidFS.glsl` through `Scene/Moon.js`
  and `EllipsoidPrimitive`; WGSL is a deliberate port of that fragment path.
  The lockstep contracts include extinction/in-scatter, C12-20
  Lommel-Seeliger, and C12-23 opposition surge (record corrected 2026-08-02).
  - **C12-25 LOLA relief — the pair that has to be edited together.** GLSL `EllipsoidFS.glsl`'s `#ifdef LUNAR_NORMAL_MAP` block ↔ WGSL `Moon.wgsl`'s `if (u.normalStrength > 0.0)` block. **Four things are part of the contract and cannot be edited alone:**
    1. **The decode** — `sample.xyz * 2.0 - 1.0` on both sides, with the strength scaling **only** `.xy`. Scaling `.z` too would change the perturbation's character rather than its magnitude.
    2. **The tangent frame**, rebuilt in **model space** on both sides from the same expression: `up = normalMC`, `east = normalize(-positionMC.y, positionMC.x, 0)` (pole-guarded at `1.0e-6`), `north = cross(up, east)`, then `normalize(east·x + north·y + up·z)`. The GLSL deliberately does **not** call `czm_eastNorthUpToEyeCoordinates` even though it builds the identical basis — the WGSL has no `czm_normal` and lights in model space, so doing it inline on both keeps the twins the same expression instead of "equivalent if you work it out", and the inline form guards the pole degeneracy the builtin does not.
    3. **The upload convention** — `flipY: true` on both backends (WebGL via `Texture`'s default, WebGPU via an explicit option). This is stronger than the C12-24 albedo case: the green channel encodes **north**, so a v-flip does not merely misplace the relief, it lights every crater from the wrong side on one backend only.
    4. **What gets perturbed** — the **lighting** normal (`material.normal` / `m.normal`), not the UV normal, so the relief rides whichever disc law C12-20 selected.
  - **Deliberate wiring asymmetry, not a math asymmetry.** WebGL gates the sampler behind the `LUNAR_NORMAL_MAP` define because `EllipsoidFS.glsl` is shared by **every** `EllipsoidPrimitive` and must not grow an unconditional sampler; WebGPU keeps binding 3 always present against a 1×1 flat placeholder because `Moon.wgsl` is moon-only and one variant-free pipeline is strictly better. Both reach the **exact** identity when off — strength 0 drives `nTS` to `(0,0,z)` and `normalize(east·0 + north·0 + up·z) = up` bit-for-bit. The strength itself is resolved **once, backend-agnostically** in `Moon.update()` and published as `frameState.moonNormalMapStrength`, so the two backends cannot disagree about whether relief is on.
  - `Tools/visual-regression/moon-normal-map-asset.spec.mjs` pins all four contract items plus the asset's own orientation, and it is a pure-Node spec — run it on any change to the moon shader pair.
  - **C12-21 earthshine + C12-22 soft terminator — two more pairs, added 2026-08-06.** GLSL `#ifdef EARTHSHINE` (`u_earthshinePhaseScale`) ↔ WGSL `u.earthshinePhaseScale`; GLSL `#ifdef SOFT_TERMINATOR` (`softTerminatorMu0` + `u_terminatorSoftness`) ↔ WGSL `softTerminatorMu0` + `u.terminatorSoftness`. **Three contract items:**
    1. **Earthshine had no GLSL implementation before C12-21** — it was a WebGPU-only celestial term for the whole of Phase 1.2, which is precisely the class of drift this document exists to stop. The GLSL block is now the primary reason the pair is enumerated here; do not let it fall out again.
    2. **`softTerminatorMu0` is character-identical in both languages** — same guard (`softness <= 0.0` → return the hard clip), same `clamp`, same `(clamped + softness)² / (4·softness)`. `Tools/visual-regression/moon-phase-terminator.spec.mjs` **extracts both bodies, compiles them as JavaScript, and requires them to agree with the JS reference in `Scene/MoonPhaseAppearance.js` to 1e-15** — so "character-identical" is enforced computationally, not by eye.
    3. **Where it is applied** — the Lommel-Seeliger branch only, on both backends. The WebGL phong fallbacks run inside `czm_private_phong` / `czm_phong`, shared builtins used by every lit primitive in the engine; softening only the WGSL side would recreate the WebGPU-only asymmetry. The fallback stays hard-clipped on both.
  - Both scalars are resolved **once, backend-agnostically** by `Scene/MoonPhaseAppearance.js` in `Moon.update()` and published as `frameState.moonEarthshinePhaseScale` / `frameState.moonTerminatorSoftness`, the same discipline C12-25 uses for `moonNormalMapStrength`. Off positions are exact identities (1.0 and 0.0 respectively), not approximations.
- **`Environment/ProceduralClouds.wgsl`** — Phase 6 fork-only volumetric cloud layer (raymarched). No WebGL equivalent — would require a compute-shader bake step that WebGL2 can't provide.
  - **It does carry one lockstep pair, and it is CPU↔WGSL, not GLSL↔WGSL (C13-07, 2026-08-01).** `worldToWeatherUV` and its texel convention are mirrored on the CPU by `weatherUVFromLonLat` / `weatherTexelCenterLonLat` in `packages/engine/Source/Scene/Weather/WeatherMapSeam.ts`, because both weather-map producers (`ProceduralWeatherMap.ts` and `WeatherTexPacker.ts`) have to write the same texel centres the sampler reconstructs. Three things are part of that contract and cannot be edited alone: the two UV expressions in the WGSL, the four `weatherTexBounds` floats the renderer packs, and the weather sampler's `addressModeU: "repeat"` / `addressModeV: "clamp-to-edge"` (the dateline fix assumes the wrap filter exists; the pole fix assumes the polar row is what a pole sample reads). `Tools/visual-regression/weather-map-seam.spec.mjs` pins all three plus the CPU producers, and it is a pure-Node spec — run it on any change to the cloud weather path.
- **`PostProcess/SolarHalo.wgsl` ↔ `PostProcessStages/SolarHalo.glsl`** — C12-18's screen-space solar veiling glare, and a **new pair born twinned** (2026-08-07). Both are line-for-line translations of `solarScreenHaloProfile` in `Scene/SolarDiscModel.js`; the JS function is the reference implementation, not a comment about one. **Four things are part of the contract and cannot be edited alone:** (1) the three-line veil body (`rho` → `t` → `veil`), which `Tools/visual-regression/sun-halo-composition.spec.mjs` extracts from both shader texts, compiles as JavaScript and requires to agree with the JS reference to 1e-15; (2) the y convention — `gl_FragCoord` is y-up, `@builtin(position)` is y-down, and the published centre is in the GL convention, so **exactly one** flip exists and it lives in the WGSL (`viewport.x - in.position.y`); (3) the halo is additive in rgb only and must never touch alpha, because the rest of the post-process chain carries it; (4) the amplitude is `0.75 x eclipseFactor` on both sides — CLT-C4, the eclipse factor multiplies the halo input or the halo survives totality. **The bake half of the same row is a third member of this lockstep group:** `SunTextureFS.glsl`'s `u_haloGain` ↔ the WebGPU CPU bake's `haloGain` in `WebGPUEnvironmentRenderer.createSunTexture`, both derived from one boolean in `Scene/SunHaloAppearance.js` so a double halo (bake + screen) is unrepresentable rather than merely avoided. Editing the halo on one backend is the exact failure this document exists to prevent.
- **`PostProcess/SunBrightPass.wgsl` ↔ `PostProcessStages/BrightPass.glsl`** and **`PostProcess/AdditiveBlend.wgsl` ↔ `PostProcessStages/AdditiveBlend.glsl`** — C12-34's WebGPU sun-bloom mirror, and **two new pairs born twinned** (2026-08-11). They are the first and last stages of the sun-glow chain; the middle two are `GaussianBlur1D`, which was already a twinned pair, so the WebGPU effect reuses it rather than adding a third shader. **Five things are part of the contract and cannot be edited alone:** (1) the bright pass's three-line extraction body (`scaledLum` → `brightLum` → `brightness`), which `Tools/visual-regression/webgpu-sun-bloom-mirror.spec.mjs` extracts from both shader texts, compiles as JavaScript and requires to agree to 1e-15 across four disc radiances × seven luminances; (2) the `czm_RGBToXYZ` / `czm_XYZToRGB` round trip including both degenerate-chromaticity guards — an exactly-black pixel without them is a NaN that the two blur passes spread across the whole glow, which is the B947 black rectangle; (3) the composite's radial term (`x` → `smoothstep(0.5, 0.8, x)` → `mix`), which is what bounds the glow — there is no other limit on its reach; (4) the y convention, same rule as `SolarHalo`: `gl_FragCoord` is y-up, `@builtin(position)` is y-down, the published centre is in the GL convention, so **exactly one** flip exists and it lives in the WGSL; (5) the shape constants — texture scale, blur delta/sigma, the `30 x 2` box and the `0.15` composite fraction — which live once in `Scene/SolarDiscModel.js` and are re-read out of the shipped `SunPostProcess.js` text by the same spec, so a WebGL-side retune that forgets the mirror fails offline. **The blur's buffer sizing is the third member of this group:** `PostProcessStageTextureCache` scales both dimensions, takes the minimum and rounds up to a power of two, producing a square buffer — and the blur's screen-space footprint is `sigma` texels of that buffer, so `solarBloomBlurBufferSize` reproducing that rule is not a convenience, it is what makes the two glows the same size. The square buffer is also why one `step` uniform can describe both directions on WebGL and a per-axis texel size can reproduce it on WebGPU.
- **`Compute/ProceduralSkyCubemap.wgsl` ↔ `Shaders/ComputeRadianceMapFS.glsl`** —
  current radiance-bake pair. The 2026-08-01 correction retired the pre-Batch
  346/530 claim that WebGL used only pre-baked offline cubemaps. Both sources
  use the same scattering model, intensity and gamma, face mapping, and
  light-direction policy; `Tools/visual-regression/sky-light-direction.spec.mjs`
  compares that policy mode by mode. Its opt-in multi-scatter/cloud extensions
  and compute delivery remain WebGPU-only.
  - **C13-41 (2026-08-07) — the eclipse dims this pair's CPU feed, symmetrically, with neither shader edited.** The solar-eclipse response for the environment bake lands on the pair's manager-level intensity: WebGPU `SkyUniforms.scatteringIntensity` (slot 34, written as `data[34] = skyColorScattering` in `WebGPUDynamicEnvironmentMapManager.ts`) and WebGL `u_brightnessSaturationGammaIntensity.w` (written as `adjustments.w` in `Scene/DynamicEnvironmentMapManager.js`). Both are the multiplier on the final sky/ground radiance in their respective sources (`skyColor * scatteringIntensity` / `atmopshereColor.rgb * intensity`), so a single backend-neutral multiply on each side keeps the twins in lockstep without touching WGSL or GLSL. **Do not confuse this with `SkyUniforms.intensity` (slot 15) / `czm_atmosphereLightIntensity`**, which is baked inside the phase-weighted scattering and is a scene-global automatic uniform on WebGL — dimming that one for the bake alone is not possible today, which is why the ground-facing texels' additive inscatter term stays undimmed on both backends (`C13-41-ENV-GROUND-INSCATTER-ADDEND-UNDIMMED` in `DEFERRED_WORK.md`). Each manager's refresh gate also gained a quantized eclipse level term on the shared `1/256` grid; **dimming either bake without that term latches the environment dark past totality**, which is exactly why C12-29 S2 left both bakes alone. A future edit that dims one side must dim the other and carry the refresh input, or `Tools/visual-regression/eclipse-cloud-ibl-response.spec.mjs` groups D3/D4 fail with the missing half named.
  - Everything outside the shared bake is genuinely fork-only and has no GLSL twin: the multi-scatter LUT sky source (`ENV-AERIAL-MS`, opt-in), the coarse cloud darkening and the full per-face cloud march (`CLOUD-IBL` / `CLOUD-IBL-FULL`, opt-in), and the compute-shader delivery mechanism itself. All are default-off/parity-default, so the default fill stays byte-comparable to the GLSL bake.

**Net status:** environment shader pairs are **architecturally matched** for
shipped WebGL features (Sun, sky atmosphere, and cube-map panorama loading).
WebGPU SkyBox uses the panorama path while sharing the celestial-modulation
contract. `Moon.wgsl` is twinned with `EllipsoidFS.glsl`; `SolarHalo.wgsl` is
twinned with `PostProcessStages/SolarHalo.glsl`; and `SunBrightPass.wgsl`,
`AdditiveBlend.wgsl`, and `GaussianBlur1D.wgsl` complete the two-backend
sun-glow chain. ProceduralClouds remains a fork-specific renderer enhancement
except for its CPU↔WGSL weather-map contract. ProceduralSkyCubemap's IBL
radiance bake is twinned with `ComputeRadianceMapFS.glsl`; only its opt-in
multi-scatter/cloud extensions and compute delivery are fork-only.

---

#### Phase 3.5 — Particle system inventory (Batch 84)

Upstream Cesium's `ParticleSystem` does **not have dedicated particle shaders** — particles are billboarded sprites rendered through the BillboardCollection pipeline. So "particle lockstep" in the upstream sense really means BillboardCollection lockstep, which was already part of the C-R5 Collections work and is functionally matched on both backends.

**Matched (via BillboardCollection):**

| Component | GLSL | WGSL |
|---|---|---|
| Particle render (per-particle billboard quad) | `BillboardCollectionVS.glsl` + `BillboardCollectionFS.glsl` | `Collections/BillboardCollection.wgsl` |
| Particle SDF text rendering (when particles use a label/glyph image) | `BillboardCollectionFS.glsl` (`#ifdef SDF`) | `Collections/BillboardCollectionSDF.wgsl` |
| Particle pick | `BillboardCollectionFS.glsl` (`#ifdef RENDER_FOR_PICK`) | `Collections/BillboardCollectionPick.wgsl` |

CPU-side: `Scene/ParticleSystem.js` + `Scene/ParticleEmitter.js` + `Scene/Particle.js` + `Scene/ParticleBurst.js` are shared across both backends — they update particle positions on the CPU and submit them to whichever BillboardCollection is active.

**WebGPU-only enhancement: GPU-driven weather particles (Phase 6)**

- **`WebGPU/Compute/WeatherParticles.wgsl`** — compute-shader-driven particle simulation. Runs N×N particle integration on GPU (positions, velocities, lifetimes) without CPU readback. Used for rain, snow, ash, dust — high-count atmospheric particle systems that would overwhelm the CPU `ParticleSystem` path.
- **`WebGPU/Compute/WeatherParticleRender.wgsl`** — render shader for the compute-stepped particles. Reads the simulation output buffer directly via SSBO; no per-particle JS update loop.

**No WebGL counterpart by design** — this requires compute shaders (WebGL2 has none) and SSBO read-back which WebGL2 cannot provide. WebGL particle systems are capped at ~10k particles before CPU update + per-frame buffer upload dominates frame time; the WGSL weather system handles 100k+ at 60fps.

**Net status:** upstream `ParticleSystem` (CPU-driven, BillboardCollection-rendered) is **functionally matched** between backends — particles render identically on both. WeatherParticles is a fork-only enhancement that lifts the particle count ceiling by 10× via compute, with no WebGL parity gap because the underlying compute primitive is unavailable on WebGL2.

---

### Phase 3 — Net summary (Batches 76, 81, 82, 83, 84)

After Batches 76-84, every shipped WebGL shader feature has a WebGPU equivalent. Where the source code differs is documented in this ledger:

- **Line-by-line matched pairs**: globe terrain (Phase 2, Batches 56-79), sky atmosphere (Phase 3.1).
- **Architecturally matched but source-divergent**: post-process (Phase 3.2), shadow (Phase 3.3), environment (Phase 3.4), particle (Phase 3.5). Reason: WGSL has no preprocessor strong enough for WebGL's runtime-generated-GLSL pattern; the WebGPU equivalents use static WGSL with runtime gates instead.
- **Fork-only WGSL enhancements** (no WebGL counterpart by design): TAA,
  GTAO, SSR, GodRays, VolumetricFog, unified Tonemapping, ColorGrading,
  OITComposite, the opt-in deferred renderer, ProceduralClouds rendering,
  ProceduralSkyCubemap's opt-in multi-scatter/cloud extensions and compute
  delivery, and WeatherParticles. The Moon and procedural-radiance-bake paths
  are excluded because each has a current GLSL twin.
- **WebGL-only legacy source factoring**: five individual tonemap variants map
  to unified `Tonemapping.wgsl`; SkyBox rendering maps to the panorama path.
  Gaussian blur and point-cloud EDL are current on WebGPU and
  are not legacy-only exceptions.

The shader-pair migration arc is now **complete at the architectural level**. Remaining work is Phase 8 (G-buffer + GPU-resident tiles, kicked off in Batch 80) and Tier 2 quality items (CSM Slice 3-4, TAA Slice 2-4, 3D Tiles styling, classification migration) per the parity audit.

### Phase 4 — Singletons → pairs

Singleton shaders (WebGL-only) that gain a WebGPU counterpart, or
WebGPU-only (e.g., compute shaders for HiZ occlusion) that gain a WebGL
fallback. New pairs follow the same conventions from day one.

---

## Risk / trade-offs

**Why this might be wrong:**
- Hand-maintaining matched pairs is fragile against drift. The discipline
  has to be enforced by code review forever.
- The convention ledger could grow unbounded as backend-API differences
  accumulate. Growth past ~10-15 entries should trigger a re-evaluation of
  Naga as the unification mechanism.

**Why this approach remains selected:**
- Naga adds a build-step dependency and a new failure mode (transpilation
  errors). For shaders simple enough to hand-match, the discipline of
  manual lockstep is lower-risk.
- Once shaders are line-matched, swapping to Naga later is mechanical —
  the WGSL source is already canonical.

---

## Future: Naga as a verifier, not a translator

After Phase 3, the hand-matched shader pairs can support a CI step that:

1. Transpiles each WGSL shader to GLSL via Naga.
2. Diffs the transpiled GLSL against the hand-written GLSL pair file.
3. Fails CI if they're not algorithmically equivalent (modulo whitespace
   and trivial rewrites that Naga makes).

This catches accidental drift without ever making Naga the source of
truth. The hand-written GLSL stays as the WebGL source, the hand-written
WGSL stays as the WebGPU source, and Naga is the third leg that
guarantees they stay in step.

This is the "best of both worlds" endgame, but it requires Phase 1+ to
exist first.
