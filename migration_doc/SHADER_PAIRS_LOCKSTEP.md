# Shader Pairs Lockstep — WebGL ↔ WebGPU Manual Parity Plan

**Status:** Phases 1–3 shipped; Phase 4 + Naga-verifier outstanding · Owner: WebGPU migration · First batch: Imagery reproject pair

---

## Goal

For every functional GPU computation that exists on both backends, maintain
a **matched pair** of shader files — one GLSL, one WGSL — that express the
**same algorithm line-by-line** to the maximum extent the two languages allow.

We're not trying to be byte-exact across vendors (impossible — driver
implementations of `sin`/`log`/sampling differ within spec tolerance). We
*are* trying to make the **algorithmic intent** identical, so that:

1. Bugs in one backend's shader can't drift apart from the other over time.
2. A reader can place the two files side-by-side and verify equivalence at
   a glance.
3. Reviewers of a change can refuse a PR that touches one shader without
   the matching edit to the other.

This is the manual, lower-bar version of the Naga WGSL→GLSL transpilation
plan. We're choosing manual lockstep first because:

- It requires zero new build infrastructure.
- It keeps us in full line-by-line control of both languages.
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
  vs. ~5-10 ms on CPU per tile in pure JS. We do not move it.
- **Naga WGSL→GLSL transpilation.** Deferred to a later batch. This plan
  is the prerequisite — once the shader pairs are aligned line-by-line,
  Naga becomes a verifier rather than a translator.
- **Refactoring shaders for parity that are already in lockstep.** Some
  upstream Cesium shaders (e.g. SkyBoxFS) only ever ran on WebGL and have
  no WebGPU counterpart yet — those aren't pairs, they're singletons. We
  leave them alone until a WebGPU counterpart is needed.

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
- Upload-side conventions: WebGL's `Texture` constructor defaults to
  `flipY: true`; WebGPU's `copyExternalImageToTexture` defaults to
  `flipY: false`. The reproject FS in each backend compensates
  differently. This is a **convention-difference**, not an algorithmic
  one, and it's invisible at the shader-source level. See "Convention
  ledger" below.

The cumulative result: shaders that produce equivalent rendering but look
nothing alike side-by-side. That makes future maintenance fragile —
nothing prevents a fix landing in one shader and not the other.

---

## Approach

### Co-located shader-pair files

For each functional pair we maintain in lockstep, the two source files
live in a canonical layout:

```
packages/engine/Source/Shaders/
  GlobeFS.glsl              ◄── WebGL (existing layout)
  GlobeVS.glsl              ◄── WebGL
  ReprojectWebMercatorFS.glsl
  ReprojectWebMercatorVS.glsl
  ...
  WebGPU/
    Globe/
      GlobeTerrain.wgsl     ◄── WebGPU (existing layout)
    ReprojectWebMercator.wgsl
    ...
```

We keep the existing directory structure. Each shader file gets a
**pair-header** comment block at the top:

```glsl
// ┌─────────────────────────────────────────────────────────────────────┐
// │ PAIR: WebGL GLSL (this file)                                         │
// │       WebGPU WGSL: Shaders/WebGPU/ReprojectWebMercator.wgsl          │
// │ Last lockstep audit: 2026-05-18, Batch 67                            │
// └─────────────────────────────────────────────────────────────────────┘
// Any change in this file MUST land with a matching change in the WGSL
// counterpart. See migration_doc/SHADER_PAIRS_LOCKSTEP.md.
```

And the matching WGSL header:

```wgsl
// ┌─────────────────────────────────────────────────────────────────────┐
// │ PAIR: WebGPU WGSL (this file)                                        │
// │       WebGL GLSL: Shaders/ReprojectWebMercator{VS,FS}.glsl           │
// │ Last lockstep audit: 2026-05-18, Batch 67                            │
// └─────────────────────────────────────────────────────────────────────┘
// Any change in this file MUST land with a matching change in the GLSL
// counterpart. See migration_doc/SHADER_PAIRS_LOCKSTEP.md.
```

### Inline-WGSL-in-TS is the WGSL source of truth (where it exists today)

Some WebGPU code still has WGSL inline in TypeScript strings (e.g.
`WebGPUImageryReprojection.ts` has the reproject WGSL as a template
literal). The current pattern is "inline TS WGSL is the runtime source;
the `.wgsl` file is a documentation copy that must be kept in sync."
This is bad — three sources of truth (TS inline, .wgsl file, GLSL pair).

**As part of each pair's lockstep work**, we collapse to one WGSL file:

- The `.wgsl` file becomes the single source of truth for WebGPU.
- The TS code imports the compiled `.js` wrapper that `gulp build`
  already produces (`Source/Shaders/WebGPU/...js`).
- The inline template literal is deleted.

This is a pure cleanup with no behavior change — the .wgsl file already
exists for diagnostic purposes; we're just promoting it.

### Matching naming conventions inside the shader

Within the matched files, we use the SAME identifier names where the
languages allow:

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

Each significant line gets the SAME comment in both files. Comments
explain the *math* / *intent* / *constraint*, not the syntax. Example:

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

Floating-point arithmetic is NOT commutative across reorderings — `(a + b)
+ c` may differ from `a + (b + c)` in the last few ULPs. To keep math
maximally equivalent across vendors, the SAME operation order is used in
both shaders. Avoid GLSL's habit of inlining sub-expressions into a
single statement while WGSL spreads them across multiple `let`s.

If WGSL uses three named locals, GLSL uses three named locals with the
same names. No "inline this for terseness" allowed.

### Texture sampling convention

Pick one sampling function family per shader and use the SAME family in
both languages:

| Use case | GLSL | WGSL | When |
|---|---|---|---|
| Uniform CF, mip auto-select | `texture(tex, uv)` | `textureSample(tex, samp, uv)` | Default for any shader without `discard` before the sample |
| Non-uniform CF (post-discard) | `textureGrad(tex, uv, dx, dy)` | `textureSampleGrad(tex, samp, uv, dx, dy)` | When `discard` precedes the sample |
| Explicit LOD | `textureLod(tex, uv, lod)` | `textureSampleLevel(tex, samp, uv, lod)` | When mip selection is part of the algorithm |

Reprojection FS: no discard before the sample → both use the "auto-mip"
family (`texture` / `textureSample`).

Globe terrain FS: has discards (clipping planes etc.) before sampling
imagery → currently uses `textureGrad`/`textureSampleGrad` with
pre-computed derivatives. Stays.

---

## Convention ledger — the hidden divergences

Some divergences are *outside* the shader files (in CPU upload code, in
vertex attribute layout, etc.) but they affect the values flowing into
the shaders. These can produce equivalent rendering with shaders that
look different. We document each one explicitly:

| Convention | WebGL | WebGPU | Notes |
|---|---|---|---|
| Imagery upload flipY | `flipY: true` (Texture default) on a pre-flipped ImageBitmap → double-flip → texture v=0 = SOUTH (in sampling) | `flipY: false` (default) on the same pre-flipped ImageBitmap; the `imageOrientation:"flipY"` IS baked into the pixels `copyExternalImageToTexture` consumes → texture v=0 = SOUTH (in sampling) too | **Corrected 2026-07-02 (GLOBE-POLAR-STRETCH).** Both upload chains land the SAME source-V convention (v=0 = south). The Batch-67 "metadata-only flipY → v=0 = NORTH on WebGPU" theory was false — it was contradicted by the direct-Mercator binding path (`useWebMercatorT=true` tiles sample the same uploaded texture with v=0=south semantics and render right-side-up). The double-flip it justified in `ReprojectWebMercator.wgsl` (`v_geo = 1-y`, `srcV = 1-mercatorFraction`) cancels only for equator-symmetric imagery tiles and latitude-mirror-warped asymmetric tiles — the far-zoom WebGPU "polar stretch". Both reproject FS bodies are now line-for-line identical (`srcV = mercatorFraction`). |
| Imagery composite blend math (globe FS) | Premultiplied-alpha OVER composite: `outAlpha = mix(prevA, 1, srcA)`, `outColor = mix(prevC * prevA, color, srcA) / outAlpha`. | Same premultiplied-alpha OVER composite (Batch 79). | **Shipped.** Pre-Batch-79 the WGSL used `mix(prevColor, adjusted, srcA)` + `max(prevAlpha, srcA)`, which Batch 69 proved pixel-equivalent to OVER when `prevAlpha = 1` (the dominant case). Batch 68 attempted the switch and saw an apparent regression that turned out to be probe-level clock-noise; with clock pinning landed in Batch 70, Batch 79 made the switch cleanly and re-verified the baseline pixel-identical. The switch closes the divergence on multi-frustum subsequent passes (where `prevAlpha = 0` and the first layer's srcA < 1 — pre-Batch-79 attenuated; post-Batch-79 matches WebGL). |
| Ground atmosphere — pipeline gating | Three `#ifdef` defines control inclusion: `GROUND_ATMOSPHERE`, `FOG`, `PER_FRAGMENT_GROUND_ATMOSPHERE`. Pipeline cache emits the right variant per-tile. | Runtime UBO scalars: `tile.fogDensity > 0`, `tile.groundAtmosphereControl.x > 0.5`, `camera.atmosphereParams.w > 1.5`. WGSL evaluates all branches with runtime gates. | Same semantics. WGSL pays a few branch ops per fragment that GLSL avoids at shader-compile time; difference is sub-noise on every device measured. |
| Ground atmosphere — per-vertex vs per-fragment ray-march | Two paths gated by `PER_FRAGMENT_GROUND_ATMOSPHERE` (CPU-set when `cameraDist > nightFadeOutDistance` ≈ 10 Mm). Per-vertex uses `v_atmosphereRayleighColor` / `v_atmosphereMieColor` varyings; per-fragment calls `computeAtmosphereScattering` per pixel. | Always per-fragment (`computeAtmosphereScatteringGround`). Batch 56 chose per-fragment-always to avoid mesh-pattern artifacts from interpolated optical depths at orbit altitudes. The per-vertex varyings are still computed in the WGSL VS (currently unused, retained for future close-camera optimization). | WGSL output matches WebGL's per-fragment path at orbit; close-camera output also matches because the per-vertex computation collapses to the same answer when optical depths are short and uniform. No visible divergence. |
| Ground atmosphere — LUT integration | None. Always uses the inline `computeAtmosphereColor` analytic. | Optional `effects.atmosphereLutControl.x > 0.5` samples a compute-shader-pre-computed LUT for physically-accurate inscatter. Falls back to the same inline analytic when LUT unavailable. | WebGL has no equivalent (no WebGL2 compute). LUT-off fallback verified by `probe-atmo-lut-off.mjs` (Batch 79): 2.4-6.4% mismatch across three atmosphere-prominent views with WebGPU marginally brighter (~1.5 brightness units per channel, consistent sign) — within cross-vendor numerical drift band. WGSL diverges (more accurate) when LUT is active. Documented as an intentional one-way enhancement, not a parity bug. |
| Ground atmosphere — HDR gate | `#ifndef HDR` → inline `1 - exp(-fExposure × x)` tonemap; `#else` → skip and let post-process compress | `tile.groundAtmosphereControl.w > 0.5` (= HDR enabled) → skip; else → inline tonemap | Same toggle, different gate mechanism. Output identical. |
| Moon texture mip/LOD — C12-33 | The private opaque Moon Image material uses `textureGrad` (WebGL2) or `texture2DGradEXT` (capable WebGL1). `EllipsoidFS.glsl` computes both hit UVs and longitude-unwrapped derivatives before its miss discard. WebGL1 NPOT/extension fallback remains single-level LINEAR. Generic Image materials are untouched. | `Moon.wgsl` analytically selects one opaque hit, computes finite closest-approach helper UVs on miss lanes, unwraps only longitude derivatives, then uses `textureSampleGrad` for both albedo and LOLA normal maps. | **Lockstep policy, different legal fallbacks.** A shared normalized gradient does not force a shared mip: each texture's dimensions enter its own lambda calculation, so 2K albedo and 1K normal select independently. Never replace this with implicit sampling after discard or a single CPU LOD. Moving close/seam/limb/~16 px acceptance is owned by `probe-moon-mip-motion-edge.mjs`; thresholds/manual seam review remain pending. |
| Water/ocean — algorithm | `computeWaterColor` (hand-written GLSL, `#ifdef SHOW_REFLECTIVE_OCEAN`): **additive** blend `color = imageryColor + diffuseHighlight + nonDiffuseHighlight + specular`. Imagery is the base; ocean highlights add on top. | `computeEnhancedOcean` (hand-inlined, Batch 58): same **additive** blend `color = imagery + diffuse + nonDiffuse (Batch 78) + specular`. Matched. | **Shipped.** Batches 58 + 78 closed the alignment gap. The pre-Batch-58 WGSL incorrectly used a `mix(imagery, deepColor × darkening, 0.6)` REPLACEMENT blend (the historical "WebGPU/WebGL brightness gap"). Batch 58 rewrote to additive; Batch 78 added the remaining `nonDiffuseHighlight` (low-light wave highlight under SHOW_OCEAN_WAVES) and waveIntensity-modulated `surfaceReflectance` patterns. Polar-multi probe doesn't exercise this code path (WGS84 ellipsoid has no water mask). |
| Water/ocean — UV Y-flip | GLSL applies `waterMaskTextureCoordinates.y = 1.0 - .y` after translation/scale. | WGSL omits the flip — the water-mask uploader (`WebGPUGlobeSurfaceTextures.getOrCreateWaterMaskTexture`, NEW-GLOBE-BELOWSURFACE-FIX) reverses the mask's row order at upload (typed-array masks: CPU row flip into `r8unorm`; bitmap masks: `copyExternalImageToTexture` with `flipY: true`), landing the data south-first for direct sampling at `geoUV * wmTS.zw + wmTS.xy`. | Both reach the correct mask texel; the flip lives in the GLSL FS, the equivalent lives in the WGSL upload path. NOTE: before NEW-GLOBE-BELOWSURFACE-FIX this row was aspirational — the uploader extracted `wm._source \|\| wm.image`, which the WebGL `Texture` class never retains, so NO mask ever uploaded and every water-masked tile bound the 1×1 WHITE placeholder (waterMask=1.0 → whole-tile ocean shading; the Batch 510 dominant darkening term). `GlobeSurfaceTile.js` now retains the payload on `texture._webgpuSource`. |
| Water/ocean — function home | `computeWaterColor` is **hand-written GLSL** in `GlobeFS.glsl` L777-849, gated by `#ifdef SHOW_REFLECTIVE_OCEAN`. Forward-declared at L337. Earlier audit notes that claimed Cesium's material codegen generated it were incorrect — Batch 78 corrects the documentation. | `computeEnhancedOcean` is hand-inlined directly in `GlobeTerrain.wgsl` at lines 1861-1933. | Both implementations are hand-written; neither is generated. Adding new water features requires editing both files (lockstep discipline). |
| Water/ocean — wave-normal sampling | 2 altitude layers (`czm_getWaterNoise(u_oceanNormalMap, ...)` high + low frequencies, blended over `positionToEyeECLength` ∈ [20km, 60km]). Wave UVs use `czm_ellipsoidTextureCoordinates(normalMC)` (GLOBAL lon/lat). `czm_getWaterNoise` samples with `texture()` (auto-LOD → mip-averaged); its 4 taps divide the UV by 103/107/(897,983)/(991,877). | **C11-172 v3** (2026-07-24): 3 octaves in the SAME global ellipsoid (lon/lat) UV at INTEGER repeats `OCEAN_OCTAVE_REPEATS_*` = round(circumference/λ) (267167/801500/2671668 ≈ 150/50/15 m zonal), replacing the old scale-invariant tile-UV ×400/200/800 (sub-pixel at every altitude ⇒ animated aliasing = the "noisy" bug). RTE-decomposed for f32: the CPU packs per-tile per-octave f64 phase offsets `fract(rectOriginNorm×Rᵢ)` + the normalized span into the tile UB (add-only, floats 484-491); the FS reconstructs `phaseᵢ + geoUV×spanNorm×Rᵢ + fract(time)` from small quantities (absolute `euv×R` reached ~2.7e6 ⇒ f32 ulp ~0.25 repeat ⇒ v2 staircase banding + frozen advection). Integer Rᵢ ⇒ exact ±180° wrap; packed span ⇒ no east−west cancellation seam. HONESTY: U normalized by 1/2π, V by 1/π ⇒ meridional λ is HALF the zonal + zonal metric λ shrinks by cos(lat); the footprint fade self-tracks it (no aliasing); quoted λ are equatorial-zonal. | **v2/v3 converged the coordinate onto WebGL's** (both physically-anchored ellipsoid UV). Per-layer SCALE still differs by design (WGSL explicit repeats vs WebGL's czm_getWaterNoise divisors), so appearance is similar-but-not-identical — strict pixel parity is not a goal. |
| Water/ocean — wave-normal LOD (C11-172 v2, 2026-07-24) | **Conservative** per-layer footprint fade: `oceanOctaveLodWeight(oceanFrequency/OCEAN_GETWATERNOISE_DIVISOR × fwidth(textureCoordinates))` fades each layer's `.xy` only at EXTREME footprint (far/orbit), calibrated on czm_getWaterNoise's coarsest-tap divisor (D2: keying on raw oceanFrequency, as v1 did, fired ~3 decades too early and would regress WebGL). Hard cutoff skips both `czm_getWaterNoise` calls once negligible. MAX-axis footprint (isotropic `texture()`). | **Physical-wavelength**, mip+aniso-aware `textureSampleGrad` (sampler `maxAnisotropy: 8`); footprint = octave repeats × per-pixel UV footprint. AMPLITUDE fade: each octave's `.xy` scaled by its weight, `.z` kept (v1 scaled whole vectors inside `normalize` = a scale-invariant no-op; D3). MIN-axis footprint (aniso resolves the long axis). Hard cutoff skips the 3 fetches. | **Shared vs mapped.** SHARED VERBATIM (pinned by `Tools/visual-regression/ocean-wave-lod.spec.mjs`): the fade band `OCEAN_OCTAVE_FADE_LO/HI` (repeats/pixel) + `OCEAN_WAVE_MARCH_CUTOFF`. NOT shared (intentional): per-layer scale (WGSL integer `OCEAN_OCTAVE_REPEATS_*`, also mirrored in `WebGPUGlobeSurfaceTypes.ts` for the CPU phase packer; GLSL czm_getWaterNoise + `OCEAN_GETWATERNOISE_DIVISOR`) and footprint axis (WGSL min / GLSL max — each matches its sampler's anisotropy). WebGL is NOT broken (it already mip-averages + is physically anchored) so its change is conservative/far-only; the fix is WebGPU's coordinate+sampling switch. Requirement-2 "earlier low-camera fade" is SUBSUMED by the footprint metric; legacy `waveIntensity` (70km–1Mm) untouched for orbit sun-glint parity. |
| Water/ocean — specular model | `czm_getSpecular` (Phong-like, exponent=10) × `mix(u_zoomedOutOceanSpecularIntensity, oceanSpecularIntensity, waveIntensity) × mask`. Runs unconditionally (no enableLighting gate — `czm_lightDirectionEC` defaults to the sun) and has no orbit-altitude fade. | Same since GLOBE-POLAR-STRETCH-POLISH (2026-07-02): Phong port `pow(max(dot(reflect(-L, N), V), 0), 10)` × waveIntensity-modulated surfaceReflectance × mask, unconditional. `distributionGGX` remains defined but unused. | **Matched.** The earlier WGSL-only GGX + `enableLighting` gate + orbit smoothstep fade suppressed the zoomed-out ocean sun glint that WebGL shows at orbital altitudes — it was 63% of the far-zoom (25 Mm) WebGL↔WebGPU pixel mismatch (probe-globe-polar-stretch bucket decomposition). |
| Water/ocean — foam | None. | `computeFoam(waveNormal, distance)` overlays white pixels where wave normals are steep, with distance falloff over 50km–200km. | **WGSL-only enhancement.** |
| Water/ocean — subsurface scattering | None. | `computeSubsurfaceScattering` helper defined in WGSL but **currently unused** (scaffolding for future enhancement). | **WGSL scaffolding.** Per CLAUDE.md Principle 7 (Dead Code Audit), do not remove. |
| Water/ocean — wave-normal coordinate space | `normalEC_water = enuToEye × normalTangentSpace` — tangent-space wave normal is rotated to eye-space via `czm_eastNorthUpToEyeCoordinates(positionMC, normalEC)` before any further math (GlobeFS.glsl::computeWaterColor L814). | Same: WGSL ports `czm_eastNorthUpToEyeCoordinates` as `eastNorthUpToEyeCoordinates(positionMC, normalEC)`, transforms `waveN` to eye-space, then perturbs `normalEC` (Batch 79). | **Shipped (Batch 79).** Pre-Batch-79 the WGSL added tangent-space `waveN` directly to eye-space `normalEC` without rotation — mixed coordinate frames, producing a subtle "moving mesh" artifact where waves were anchored to camera orientation instead of the local ENU frame. Visible on close-zoom coastal orbits; not visible on the polar-multi baseline (WGS84 has no water mask). |
| Lighting — variant gating | Three #ifdef variants: `ENABLE_VERTEX_LIGHTING` (tile-provider-driven, custom uniforms × `czm_lightColor`), `ENABLE_DAYNIGHT_SHADING` (`NdotL × 5 + 0.3` × `czm_lightColor`, mixed with full brightness by `fade`), or pass-through. | One unified runtime path gated on `camera.enableLighting > 0.5`. | Same intent (Lambert diffuse), different coefficients and gate mechanism. |
| Lighting — diffuse coefficients | `NdotL × 5 + 0.3` (high-contrast, dark night) | `NdotL × 0.88 + 0.12` (gentler transition, brighter ambient) | Visually distinct day/night terminator shape between backends. Documented as intentional rewrite. |
| Lighting — custom light color | Multiplies by `czm_lightColor` (allows scene-provided custom light color) | Multiplies by `camera.lightColor.rgb` packed from `uniformState.lightColor` (Batch 76). Default white (1,1,1) preserves pre-Batch-76 behavior for scenes without a custom `scene.light`. | **Shipped.** Layout: `camera.lightColor: vec4<f32>` at `CAMERA_UNIFORM_FLOATS` offset 132-135. `.w` reserved for future ambient-color scalar / HDR multiplier. |
| Eclipse globe shadow — C12-29 S5 (2026-07-26; integrated, final certification open) | `GlobeFS.glsl::eclipseFragmentFactor` reads one command-local `mat4` captured from the active logical `View`; its columns are the shared four-`vec4` payload. A WebGL-only bit-33 cache flag emits `ENABLE_ECLIPSE_GLOBE_SHADOW` only for gates 1-4, so the ordinary compiled globe variant has no eclipse uniform or helper semantic IR and performs no S5 composition/atmosphere correction. The raw combined GLSL string still contains the preprocessor-guarded helper source; physically omitting that source is measure-first follow-up work. The fragment uses direct exaggerated `v_positionMC`, multiplied by inverse astronomical range before subtraction, plus the existing automatic `czm_ellipsoidInverseRadii`. | `GlobeTerrain.wgsl::globe_eclipseFragmentFactor` reads the same payload from a dedicated 64-byte group-0/binding-2 dynamic UBO and consumes direct `input.v_positionMC`. One allocation-epoch-memoized active slice is reused by tile, imagery, wireframe, pick, and capture commands; ordinary frames bind one stable inert renderer-owned slice without a ring allocation/upload. `CameraUniforms` remains 232 floats / 928 bytes. | **Algorithmically paired; source/RTE gate 14/14 and both-backend WGS84 pixel probe PASS.** CPU f64 publishes `uS = normalize(S)`, `a = 1/|S|`, `dU = normalize(M)-uS`, `b = 1/|M|`. Both shaders form `s=uS-P*a`, `D=dU+P*(a-b)`, `m=s+D`, run an exact algebraic disc-support reject, use `atan2(length(cross(s,D)), dot(s,m))`, analytic circle overlap, the fitted limb-darkening cubic, and the same S2 absolute/relative composition. The horizon test transforms the Sun ray by the rendered ellipsoid inverse radii and uses the stable cross-product closest-distance form. Source/math coverage includes elevated terrain and custom ellipsoids without an antipodal false shadow; real rendered custom-ellipsoid/exaggeration certification remains open. Direct Earth-scale f32 `positionMC` has sub-metre quantization; there is no mutable pass-camera reconstruction and no `acos(dot)` of independently rounded rays. The WebGL cache flag is not a scarce cross-backend `WebGPUShaderDefines` bit. Any payload, support, horizon, composition, or variant-gate change must land in both shaders plus `eclipse-globe-umbra-rte.spec.mjs`. |
| Lighting — vertex-lighting uniforms | `u_lambertDiffuseMultiplier` + `u_vertexShadowDarkness` (tile-provider config), gated by `#ifdef ENABLE_VERTEX_LIGHTING` (defined when terrain has vertex normals). | Bridged via `camera.lighting.x` (`lambertDiffuseMultiplier`) and `camera.lighting.y` (`vertexShadowDarkness`) packed in the camera UB (Batch 77). The gate is a runtime branch on `camera.lighting.z` (`hasVertexNormals` flag, set from `tileProvider.terrainProvider.hasVertexNormals`). When the flag is on, WGSL uses the WebGL ENABLE_VERTEX_LIGHTING formula directly: `clamp(NdotL × mult × shadowFactor + darkness, 0, 1)`. When the flag is off, WGSL falls back to the existing DAYNIGHT_SHADING-analogue path. | **Shipped.** Layout: `camera.lighting: vec4<f32>` at `CAMERA_UNIFORM_FLOATS` offset 136-139. `.w` carries `zoomedOutOceanSpecularIntensity` since GLOBE-POLAR-STRETCH-POLISH (a future DAYNIGHT_SHADING `fade` bridge needs a new pad). |
| Lighting — diffuse coefficients (no vertex normals) | `NdotL × 5 + 0.3` (high-contrast, dark night) mixed by `fade` toward 1.0 at orbit | `NdotL × 0.88 × shadowFactor + 0.12` (gentler transition), mixed against `nightAmbient = 0.025` by `dayFade`. Only used when `camera.lighting.z ≤ 0.5` (terrain has no vertex normals — DAYNIGHT_SHADING-equivalent path on WebGL). | **Intentional algorithmic rewrite, NOT a parity bug.** The WGSL formula stays distinct here because the WebGL DAYNIGHT_SHADING path is documented as having a sharp/dark terminator the WGSL deliberately smooths. The `.w` slot in `camera.lighting` is reserved for a future exact-match toggle if cross-backend pixel parity for this path is ever needed. |
| Lighting — terminator glow | None | `computeTerminatorGlow(normal, sunDir)` — warm orange/pink band at the day/night boundary | WGSL-only visual enhancement (intentional). |
| Shadow receive — code location | NOT in `GlobeFS.glsl` source. WebGL pipeline cache injects shadow-sampling GLSL via `ShadowMapShader.js` per-pipeline based on the shadow-map config. | Inlined directly in `GlobeTerrain.wgsl`: `globeComputeShadowFactor` (single map), `globeComputeShadowFactorPointLight` (cube shadow point light), `globeComputeShadowFactorCSM` (cascaded shadow maps). Gated at runtime in fragmentMain. | Architecture difference forced by the pipeline-cache model: WebGL injects per-config GLSL strings; WebGPU uses fixed shaders with runtime gates. Both produce equivalent shadow visibility for matching shadow-map config. |
| VS — entry point structure | Single `void main()` (~286 lines) with #ifdef variants for every terrain encoding (QUANTIZATION_BITS12, INCLUDE_WEB_MERCATOR_Y, ENABLE_VERTEX_LIGHTING, GEODETIC_SURFACE_NORMALS, EXAGGERATION, ENABLE_CLIPPING_POLYGONS, FOG/GROUND_ATMOSPHERE/UNDERGROUND_COLOR/TRANSLUCENT, 2D-mode variants). Pipeline cache compiles per-define-set. | Six explicit `@vertex` entry points (`vertexMain`, `vertexMainWebMerc`, `vertexMainWebMercNormals`, `vertexMainQuantized`, `vertexMainQuantizedWebMerc`, `vertexMainQuantizedWebMercNormals`), each decoding a specific vertex layout, then handing off to a shared `processVertex()` helper for the layout-agnostic math. Pipeline picks the entry point based on terrain encoding. | Forced by language + pipeline-creation model: WGSL has no full preprocessor and WebGPU pipelines prefer a single shader module with multiple entries. Shared varying contract (see VS pair-section header) keeps the downstream FS math identical across backends. |
| VS preprocessor scope | Full C-style preprocessor handles all variant branching | Custom `//>>ifdef FLAG_NAME` subset gated by uint32 `ShaderDefine` bitmask (see `WebGPUShaderDefines.ts` / `WebGPUShaderPreprocessor.ts`). Currently used only for `GEODETIC_NORMAL`, `DISABLE_DEPTH_DISTANCE`, `SPLIT_ENABLED`, `COMPRESSED_VERTICES`. Add-only; never renumber. | Variants that GLSL handles via preprocessor are split across separate WGSL entry points instead, keeping the preprocessor surface minimal. |
| VS shared math home | Inlined in `main()` | Hoisted to a `processVertex()` helper (called by all six entry points), so the position/normal/varying-setup math lives in one place. | Refactor of WebGPU side (Batch 20) removed an earlier proliferation of 6 parallel `*_Geo` entry points. Future WGSL VS additions should add their decoding logic and call into `processVertex()`. |
| Globe-FS V convention | `geoUV.y = 0` means terrain south edge | `geoUV.y = 0` means terrain south edge | Same convention. Imagery textures sampled at `geoUV.y` must have south at v=0 in the SAMPLING space. |
| Reprojected-texture V convention | Output texture row 0 (memory) = south (because WGL reproject samples source v=mercatorFraction, which at south target = 0 = NORTH-source per upload). Net: row 0 stores SOUTH-source-content. | Output texture row 0 (storage) = south (because WGPU reproject samples source v=1-mercatorFraction, which at south target = 1 = SOUTH-source per upload). Net: row 0 stores SOUTH-source-content. | Both end up with v=0 = south in the SAMPLING convention. Visible rendering is equivalent. |
| NDC y-axis | NDC y=+1 = top of viewport = OpenGL framebuffer y=H-1 = texture memory row N-1 (OpenGL "top" of texture, sampled at v=1) | NDC y=+1 = top of viewport = WebGPU texture pixel row 0 (D3D-style top-left origin) | Affects reproject VS clip-space coords; FS texCoord interpolation must be set up to compensate. Reproject VS computes texCoord differently in each shader to bake out this difference. |
| Depth range | [-1, 1] | [0, 1] | Affects projection matrix row 2 only. Handled by `Matrix4.setDepthRangeType()`. Same vertex outputs visible to the FS. |
| Draped vector-tile polylines — lookup storage (C11-213 / UP144-VECTOR-LAYER-WGSL, 2026-08-06) | `VectorCommon.glsl` declares five `highp sampler2D`s (`u_vectorSegmentTexture`, `u_vectorWidthTexture`, `u_vectorColorTexture`, `u_vectorSegmentPrimitiveIndicesTexture`, `u_vectorGridCellIndicesTexture`) and reads them with `texelFetch` + `vectorIndexToUv` over power-of-two-padded textures. Uploaded by `VectorPipeline.packPolylineTextures`. | `GlobeTerrain.wgsl` declares ONE `@group(2) @binding(11) var<storage, read> vectorTileData: array<u32>` and indexes an 8-word header + four contiguous runs. Packed by `WebGPUVectorTileResources.packVectorTileWords`, realized through the `GLOBE_SURFACE` feature renderer's `prepareVectorTileData` hook. | **Mapped, not shared — and forced.** `texelFetch` on those five is WebGL2's only fragment-stage random-access buffer read, not sampling. Binding five sampled textures on WebGPU would take the C11-208 reduced low-limit globe layout from exactly 16 to 21, over the `maxSampledTexturesPerShaderStage` spec floor, and the globe pipeline would fail to create on default-limit adapters; `GLOBE_NON_IMAGERY_FRAGMENT_TEXTURES` stays 12 because a storage buffer costs none of that budget. **Any change to the word layout, the header indices, the cell-offset convention, the primitive record, or the RGBA byte order must land in `VectorCommon.glsl`, `GlobeTerrain.wgsl`, AND `WebGPUVectorTileResources.ts` together** — pinned by `Tools/visual-regression/vector-layer-draping.spec.mjs` (21/21), whose oracle evaluates the GLSL algorithm over the raw `VectorTileData` and whose subject evaluates the WGSL index arithmetic over the real packer output. |
| Draped vector-tile polylines — per-tile gating (C11-213) | Compile-time: `#ifdef HAS_VECTOR_LAYER`, emitted by `GlobeSurfaceShaderSet` under shader-set flag bit `0x400000000` (upstream's `0x200000000` collides with the fork's `enableEclipseGlobeShadow`). `VectorCommon` is `unshift`ed ahead of `GlobeFS`. | Runtime: `vectorTileData[0]` (`gridWidth`) `== 0u` early-outs. Tiles with no draped geometry share one 32-byte all-zero placeholder buffer. The WebGL flag bit is untouched and remains WebGL-only. | Same shape as the ground-atmosphere and shadow-receive rows: WebGL forks the shader, WGSL uses a runtime gate. A per-tile define here would fork every globe pipeline variant (color/pick/depth-only/translucent/wireframe/capture/debug). Default-path cost is one u32 load per globe fragment. |
| Draped vector-tile polylines — screen-space width Jacobian (C11-213) | `mat2 screenFromUv = inverse(mat2(dFdx(vectorUv), dFdy(vectorUv)))`, taken INSIDE `vectorPolylineRender`. | `vectorInverse2x2(mat2x2<f32>(uvDx, uvDy))`, with `uvDx`/`uvDy` taken by `dpdx`/`dpdy` of the RAW (unclamped) `v_textureCoordinates.xy` at FRAGMENT ENTRY and passed in. WGSL has no `inverse()` builtin, so the 2×2 inverse is written out with a singular-determinant guard. | **Forced by WGSL, and load-bearing.** WGSL rejects a derivative builtin reached through non-uniform control flow, and every `var<storage>` read is non-uniform by definition, so an inline `dpdx` under the `gridWidth` gate is a shader-creation error (naga catches it). Same hoisting discipline as `geoUV_dx`/`geoUV_dy` for `textureSampleGrad`. Both sides use the UNCLAMPED tile UV; the WGSL's seam-clamped `geoUV` would zero the derivative on a fragment quad that clamps to one edge value. |
| Draped vector-tile polylines — composite position (C11-213) | `GlobeFS.glsl` main tail: after `#ifdef UNDERGROUND_COLOR`, before `#ifdef TRANSLUCENT`. Alpha-composite, no discard. | `GlobeTerrain.wgsl` `fragmentMain` tail: after the `GLOBE-UNDERGROUND-COLOR` block, before `GLOBE-TRANSLUCENCY-ALPHA`. Same alpha-composite expression. | **Matched, and the ordering is semantic, not cosmetic:** a draped line over a translucent globe must fade with the globe rather than punch through it. Pinned by spec `D4`, which reads both files' block order. |
| Sky atmosphere — file layout | Three files: `SkyAtmosphereVS.glsl` (32), `SkyAtmosphereFS.glsl` (59), `SkyAtmosphereCommon.glsl` (81) — plus czm_* builtin includes for scattering, atmosphere color, tonemap, gamma, HSB shift, ray-sphere. | Single file `Shaders/WebGPU/Environment/SkyAtmosphere.wgsl` (~575 lines) with @vertex + @fragment + all helpers inlined (no preprocessor includes available in WGSL). | Different file-organization model; algorithmic content matched section-for-section. |
| Sky atmosphere — ray-march steps | 16 with adaptive `rayStepLengthIncrease` curve (AtmosphereCommon.glsl L81). Planet-striking rays march THROUGH the planet interior; the exponential density overflows f32 there, extinguishing the ray (this is what blacks out the disk interior when the globe is hidden and shapes the ~10 px limb extinction tail). | 1:1 port of `czm_computeScattering` (Batch 247): same 16-step adaptive curve, `PRIMARY_STEPS_MAX = 16` / `LIGHT_STEPS_MAX = 4`. Planet-striking rays also march through (NEW-GLOBE-DRAPE-LIMB-CLOSEOUT — the pre-2026-07-03 `rayEnd = earthIntersect.x` surface clip is REMOVED); underground sample heights are floored at −150 km so the extinction is deterministic (WGSL `exp()` overflow is indeterminate per spec) while above −150 km the math is bit-identical. | Same visual result: black through-planet rays + matching limb peak/tail (probe-limb-halo-width gate: WebGL 14 px vs WebGPU 16 px median, ±6 px tol). |
| Sky atmosphere — per-vertex vs per-fragment | `#ifdef PER_FRAGMENT_ATMOSPHERE` selects per-fragment evaluation; the other branch interpolates `v_mieColor`/`v_rayleighColor` varyings. | Always per-fragment (same logic as ground atmosphere Batch 56). VertexOutput carries only position + camera-to-vertex delta. | WGSL output matches GLSL's per-fragment path; per-vertex would re-introduce mesh-pattern artifacts at orbit altitudes. |
| Sky atmosphere — LUT fast-path | None (WebGL2 has no compute shaders). Always inline ray-march. | `useLut > 0.5` branch replaces 64-step ray march with single inscatter LUT sample (LUT baked once per sun-direction change by `WebGPUPerformanceManager`). Falls back to inline ray-march when LUT unavailable or camera is well above the atmosphere shell. | **Intentional WGSL-only enhancement (Phase 4).** Documented as such. |
| Sky atmosphere — dual-light scattering | Single light source only. | Optional sun + moon scattering when `dualLightControl.x > 0.5`. Samples a SECOND inscatter LUT (`moonInscatterLut`) baked separately for the moon direction; sums contributions scaled by moon phase × moon intensity. | **Intentional WGSL-only enhancement (Phase 1.3c).** Not visible in default scenes (`dualLightControl.x = 0`). |
| Sky atmosphere — debug bypass | None. WebGL debug uses external CesiumDebug commands. | `u.debug.x > 0.5` → flat magenta output. Lets user isolate scattering math bugs from LUT/composite errors. | WGSL-only diagnostic. Off by default. |
| Sky atmosphere — wind state | None. | `windDirectionAndSpeed: vec4` plumbed through UBO ahead of Phase 5/6 (volumetric fog advection, cloud motion). Currently unused by the FS. | Scaffolding only. No visible effect today. |
| Sky atmosphere — tonemap chain gating | `#ifndef HDR` gates `czm_pbrNeutralTonemapping` + `czm_inverseGamma`; `#ifdef COLOR_CORRECT` gates `czm_applyHSBShift`. | Always applies `pbrNeutralTonemapSky` (ported czm_pbrNeutralTonemapping) + sRGB encode via `pow(x, 1/2.2)`; HSB shift gated on `abs(hsbShift.x/y/z) > 0.001`. HDR mode handled separately in WebGPU post-process pipeline. | Same intent; different gating mechanism. Output matches in non-HDR mode. |
| Sky atmosphere — vertex transform | `czm_model * position` (no RTE — single precision suffices because atmosphere shell mesh is centered at planet origin). | `mvpRelativeToEye × translateRelativeToEye(positionHigh, positionLow, encodedCameraHigh, encodedCameraLow)` — RTE used uniformly across all WGSL shaders for consistency. | WGSL vertex buffer carries `positionHigh`/`positionLow`; CPU-side packer emits split-precision attributes for the atmosphere shell mesh. |
| Sky atmosphere — translucent globe brightening | `#ifdef GLOBE_TRANSLUCENT` path in computeAtmosphereScattering brightens the inside-globe view when globe-translucency is enabled. | Ported as a runtime gate: `u.atmosControl.w > 0.5` (packed from `frameState.globeTranslucencyState.translucent`) takes the distance/angle-faded horizon-gradient branch inside `skyColorForRay` (GLOBE-TRANSLUCENCY-ALPHA, Batch 488). 0 by default → byte-identical non-translucent path. | Compile-time define vs runtime flag is the only divergence; math matches SkyAtmosphereCommon.glsl L63-90. |
| Sky atmosphere — ellipsoid math | Pulls `czm_ellipsoidRadii`, `czm_ellipsoidInverseRadii`, `czm_eyeHeight`, `czm_viewerPositionWC` from automatic uniforms. Computes runtime `distanceAdjust`. | Pulls `radiiAndDynamicAtmosphere` + `cameraPositionWC` from explicit Uniforms struct. The `distanceAdjust` math runs CPU-side in `WebGPUSkyAtmosphereRenderer` so the shader-side `innerRadius` is already adjusted. | Same downstream math; the adjustment lives in the renderer for WebGPU. |
| Sky atmosphere — light-direction selection (C12-31, 2026-08-01) | New shared builtin `czm_getSkyAtmosphereLightDirection` (`Builtin/Functions/getSkyAtmosphereLightDirection.glsl`), called from BOTH `SkyAtmosphereVS.glsl` and `SkyAtmosphereFS.glsl`. Four arms: NONE(0)/SUNLIGHT(2) → `czm_sunDirectionWC`, SCENE_LIGHT(1) → `czm_lightDirectionWC`, LEGACY_OVERHEAD(3) → `positionWC`. | The same selection inlined in `skyColorForRay` as the `isLegacyOverhead` block (WGSL has no builtin include mechanism). Two arms rather than three because the renderer packs the scene light INTO `sunDirectionWC` for enum 1 (`useSceneLight === 1`, `WebGPUSkyAtmosphereRenderer.js`). | **MATCHED — this row is a lockstep obligation, not a divergence.** Before C12-31 both backends substituted local up for the astronomical Sun on the NONE path, which is the DEFAULT whenever `globe.enableLighting` is false: `cosAngle` in `computeAtmosphereColor` went to ≈1 along every ray, parking the Mie phase on a forward peak 4869.9× its 90° value (default `g = 0.9`) and painting a view-locked white aureole. The enum VALUE is deliberately unchanged, so the `!= 0` day/night alpha gates in `SkyAtmosphereCommon.glsl` and the WGSL stay byte-identical. Pinned by `Tools/visual-regression/sky-light-direction.spec.mjs` (16/16). |

The convention ledger is the LOAD-BEARING part of this plan. When a pair
is in lockstep, the shader files look identical (modulo language syntax)
*because* the convention table is the place where the cross-backend
boilerplate is concentrated. The shader math itself is convention-free.

---

## Lockstep discipline

### When editing a shader

1. **Always edit both files in the same commit.** A PR that touches one
   shader without the matching edit fails review.
2. **Update the pair-header "Last lockstep audit" date** when you've
   re-verified the equivalence after the edit.
3. **Add or update a convention-ledger entry** if your change touches a
   cross-backend convention (upload, NDC, depth, attribute layout, …).
4. **Use the same comment text** for any change that affects the algorithm.

### When reviewing a shader change

1. Open both files side-by-side. Confirm the diffs mirror each other.
2. Run the matching-pair regression probe (one per pair; see "Validation").
3. Confirm the convention ledger is unchanged or correctly extended.

### When a divergence is discovered

1. File it under the convention ledger if it's a backend-API difference
   that the shaders MUST encode differently.
2. Fix it if it's a backend-shader bug.
3. Document the resolution in `WEBGPU_DEBUGGING_LOG.md` for the historical
   trail.

---

## Validation

Each pair gets one regression probe in `Tools/visual-regression/` that:

1. Loads the WebGL viewer; renders a known view; captures pixels.
2. Loads the WebGPU viewer; renders the same view; captures pixels.
3. Reports per-channel mean delta and mismatch%.

For the reproject pair we already have:
- `probe-reprojected-texture-compare.mjs` — dumps source + output textures
- `probe-polar-multi-plain.mjs` — captures polar views, diffs them
- `probe-batch65-state.mjs` — validates dual-texture state

We're not gating on a fixed percentage threshold — driver-level precision
drift is real and we accept it. The probe's role is to detect *new*
divergence introduced by a change. CI compares against the most-recent
golden baseline.

---

## Phased rollout

### Phase 1 — Imagery reproject pair (this batch / next)

**Smallest pair. Cleanest target. Already mathematically aligned post-Batch 66.**

Pair files:
- `Source/Shaders/ReprojectWebMercatorFS.glsl`
- `Source/Shaders/ReprojectWebMercatorVS.glsl`
- `Source/Shaders/WebGPU/ReprojectWebMercator.wgsl` ← promoted from doc-only to source-of-truth
- `Source/Renderer/WebGPU/WebGPUImageryReprojection.ts` ← inline WGSL string removed, loads .wgsl via `.js` wrapper

Work items:
1. Add pair-header comment blocks to all four shader-source files.
2. Promote `ReprojectWebMercator.wgsl` from documentation copy to runtime
   source — `WebGPUImageryReprojection.ts` imports the compiled `.js`
   wrapper, drops the inline string.
3. Align variable names, local-binding ordering, and comments between
   GLSL and WGSL.
4. Resolve the texCoord-interpolation convention divergence (currently
   GLSL passes `position.xy` directly, WGSL flips Y in the VS). Decide on
   one convention and update both shaders so the FS math is identical.
5. Update the convention ledger above with any leftover backend-API
   differences that the shaders MUST encode differently.
6. Run `probe-reprojected-texture-compare` and `probe-polar-multi-plain`;
   confirm no regression.
7. Document the result in `WEBGPU_DEBUGGING_LOG.md`.

### Phase 2 — Globe terrain pair (largest pair, multi-batch)

Pair files:
- `Source/Shaders/GlobeFS.glsl` (~700 lines)
- `Source/Shaders/GlobeVS.glsl` (~200 lines)
- `Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` (~3100 lines combined VS+FS+all variants)

This is a multi-batch effort. The WGSL file is much larger because it
combines VS+FS+multiple terrain-encoding variants into a single module
(necessitated by how Cesium structures WebGPU pipelines). We don't try
to match line-for-line size; we match section-for-section.

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

1. **No line-by-line port intent.** Most WGSL post-process shaders are standalone re-implementations of the same algorithm rather than line-by-line ports — the GLSL versions rely on `czm_*` automatic uniforms and the upstream Cesium build's `Builtin/Functions/` include path, while WGSL has neither (no `#include` and no automatic uniforms — every uniform must be a declared binding). FXAA is the clearest example: GLSL imports an `FxaaPixelShader(...)` helper that hand-bundles 200+ lines of NVIDIA's reference FXAA 3.11; WGSL inlines the same algorithm directly in `FXAA.wgsl`. Both produce the same anti-aliased output; the SOURCE files don't share text. Pair-section headers per file would add noise without enabling line-level review.
2. **Each effect is a leaf-level shader, not part of a larger composite.** Adding a per-file pair header would multiply the documentation burden by 18+ files with little reviewer value. A ledger-level inventory is the right granularity.

**Matched-pair inventory** (both backends ship the effect):

| Effect | GLSL | WGSL | Algorithm match |
|---|---|---|---|
| AdditiveBlend | `Shaders/PostProcessStages/AdditiveBlend.glsl` | `Shaders/WebGPU/PostProcess/AdditiveBlend.wgsl` | Identical (3-line shader) |
| Ambient occlusion — generate | `AmbientOcclusionGenerate.glsl` | `AmbientOcclusionGenerate.wgsl` | Same Crytek-style SSAO with view-space depth reconstruction |
| Ambient occlusion — modulate | `AmbientOcclusionModulate.glsl` | `AmbientOcclusionModulate.wgsl` | Same (scene color × ao map) |
| Black and white | `BlackAndWhite.glsl` | `BlackAndWhite.wgsl` | Same (luminance + grad ramp) |
| Bloom composite | `BloomComposite.glsl` | `BloomComposite.wgsl` | Same (scene + blurred bright pass) |
| Bright pass | `BrightPass.glsl` | `BrightPass.wgsl` | Same threshold extraction |
| Brightness | `Brightness.glsl` | `Brightness.wgsl` | Same multiplicative scale |
| Composite translucent classification | `CompositeTranslucentClassification.glsl` | `CompositeTranslucentClassification.wgsl` | Same OVER composite with classification mask |
| Contrast bias | `ContrastBias.glsl` | `ContrastBias.wgsl` | Same (color − bias) × contrast |
| Depth of field | `DepthOfField.glsl` | `DepthOfField.wgsl` | Same near/far blur falloff |
| Depth view | `DepthView.glsl` | `DepthView.wgsl` | Same grayscale depth visualization |
| Edge detection | `EdgeDetection.glsl` | `EdgeDetection.wgsl` | Same Sobel-style discriminator |
| FXAA | `FXAA.glsl` (calls `FxaaPixelShader` helper) | `FXAA.wgsl` (inlines FXAA 3.11) | NVIDIA FXAA 3.11 — same algorithm, different source layout |
| Lens flare | `LensFlare.glsl` | `LensFlare.wgsl` | Same ghost + halo + dirt overlay |
| Night vision | `NightVision.glsl` | `NightVision.wgsl` | Same noise + green tint + vignette |
| PassThrough | `PassThrough.glsl` | `PassThrough.wgsl` | Identity (1-line shader) |
| PassThroughDepth | `PassThroughDepth.glsl` | `PassThroughDepth.wgsl` | Identity for depth target |
| Silhouette | `Silhouette.glsl` | `Silhouette.wgsl` | Same edge-detection + color overlay |

**WebGPU-only effects** (intentional Phase 4+ enhancements, no WebGL counterpart by design):

- **TAA (Temporal Anti-Aliasing)** — `TAA.wgsl`. WebGL has FXAA only; TAA is a fork-WGSL-only enhancement requiring motion-vector + history buffer infrastructure (DP-H41 + Phase 8a). Slices 2-4 still pending per Tier 2.
- **GTAO (Ground-Truth Ambient Occlusion)** — `GTAOGenerate.wgsl`. Higher-quality SSAO alternative; WebGL backend has the older SSAO only.
- **SSR (Screen-Space Reflections)** — `ScreenSpaceReflections.wgsl`. WebGL backend has no reflections; SSR is a fork-only addition (`FEAT-SURVEY-36`).
- **God Rays (volumetric light shafts)** — `GodRayGenerate.wgsl` + `GodRayComposite.wgsl`. Fork-only Phase 3 effect.
- **Volumetric Fog** — `PostProcess/VolumetricFogComposite.wgsl` **and its froxel compute module `Compute/VolumetricFog.wgsl`** (named explicitly since 2026-08-06: the compute half carries the density/scattering/integrate/temporal kernels and the cheap cloud-shadow gate, and a reader looking only at the composite could mistake it for the whole effect and go hunting for a GLSL twin). Fork-only Phase 5 effect (compute-shader-baked); WebGL2 has no compute, so neither file has a GLSL counterpart and no lockstep row is owed for either. **Not twin-free, though:** the compute module is compiled as `CloudDensityDomain.wgsl + VolumetricFog.wgsl` and shares `cloudEffectiveCoverage` with `ProceduralClouds.wgsl` / `ProceduralSkyCubemap.wgsl`, and its `normalizeFogCheapCloudField` has a CPU twin in `WebGPUCloudDensityDomain.ts` — both pinned by `Tools/visual-regression/fog-cheap-coverage-gate.spec.mjs`.
- **Tonemapping (unified)** + `Tonemapping_f16.wgsl` — fork-only consolidated tonemapper. WebGL ships 5 separate tonemap shaders (Aces, Filmic, ModifiedReinhard, PbrNeutral, Reinhard); WGSL unifies them into one shader with a runtime `tonemapperType` uniform branch. The PBR-Neutral branch (default tonemapper) is an EXACT port of `czm_pbrNeutralTonemapping` since NEW-PP-LIBRARY-TONEMAP-ORDER (2026-07-03; previously a per-channel soft-clamp approximation that over-brightened highlights, 1.0 → sRGB 249 vs the reference 239). The other four branches have NOT yet been parity-audited against their `czm_*` references.
- **ColorGrading** — `ColorGrading.wgsl`. WebGL fakes this via tonemap+brightness+contrast chain.
- **OITComposite** — `OITComposite.wgsl`. Order-independent transparency composite; WebGL backend uses a different OIT scheme (multi-target depth peeling) with no equivalent single shader.
- **DeferredGBuffer + DeferredLighting** — `DeferredGBuffer.wgsl` + `DeferredLighting.wgsl`. Phase 8a Slice 2+ scaffolding (per Batch 80). Producer half pending.
- **DepthPlane / AdjustTranslucent / CompareAndPackTranslucentDepth** — multi-frustum translucent classification helpers (`C-R8`); WebGL uses stencil-based classification with no equivalent shader.

**WebGL-only effects** (legacy / not yet migrated):

- **AcesTonemappingStage, FilmicTonemapping, ModifiedReinhardTonemapping, PbrNeutralTonemapping, ReinhardTonemapping** — superseded by WGSL's unified `Tonemapping.wgsl`. Each WebGL variant lives as its own shader file because WebGL's `PostProcessStageComposite` swaps shaders rather than uniforms; WGSL is the better factoring.
- **GaussianBlur1D** — WebGL bloom pipeline uses a separable 1D blur. WGSL bloom uses a different blur shader (or could inline if needed); no parity gap because the blur is wrapped in `BloomComposite`.
- **PointCloudEyeDomeLighting** — point-cloud EDL is a WebGL-only feature (`POINTCLOUD-EDL-WGSL`). Tracked as deferred, not a regression.

**Net status:** post-process collection is functionally matched for every shipped WebGL effect except point-cloud EDL (deferred). The WGSL collection adds 10+ effects with no WebGL counterpart — these are documented intentional enhancements, not parity bugs.

---

#### Phase 3.3 — Shadow cast inventory (Batch 82)

Shadow architecture is **fundamentally different** between backends; line-by-line pair alignment isn't applicable. Recording the architectural divergence + the matched-functionality inventory.

**WebGL architecture (runtime string-concat):**

- `packages/engine/Source/Scene/ShadowMapShader.js` (395 lines) generates GLSL **at runtime** by concatenating strings based on the shadow-map config (single vs cascaded vs cube point-light, PCF kernel size, debug visualization toggles). The generated GLSL is **injected into every receive-pipeline's fragment shader** by the WebGL pipeline cache during shader compilation.
- `packages/engine/Source/Shaders/Builtin/Functions/shadowDepthCompare.glsl` + `shadowVisibility.glsl` are static helper functions called by the generated code.
- Effect: every receiving shader (GlobeFS, ModelFS, primitives, etc.) has its own variant compiled with shadow code baked in.

**WebGPU architecture (static WGSL with runtime gates):**

- `packages/engine/Source/Shaders/WebGPU/Shadow/ShadowMap.wgsl` (125 lines) — cast (depth-only) shader.
- `packages/engine/Source/Shaders/WebGPU/Shadow/ShadowReceiveCSM.wgsl` (146 lines) — standalone CSM receive shader for primitives without an inline path.
- `packages/engine/Source/Shaders/WebGPU/chunks/functions/csm_samplePointShadow.wgsl` — point-light cube shadow sampling helper.
- Receive logic is **inlined directly into each receiver shader's WGSL source** as `globeComputeShadowFactor` / `globeComputeShadowFactorPointLight` / `globeComputeShadowFactorCSM` (GlobeTerrain.wgsl lines ~2390-2440), gated at runtime by `csmControl.x > 0.5` and `pointLightShadow > 0.5` flags in the effects UBO.

Why the divergence is forced (not avoidable):

- WGSL has **no preprocessor strong enough** to support WebGL's pipeline-cache string-concat model. The custom `//>>ifdef FLAG_NAME` over a uint32 bitmask handles boolean variants but can't fold in dynamically-generated kernels or per-config sampling loops.
- WebGPU pipeline creation strongly prefers a **single shader module with multiple entry points** over per-config shader compilation. The runtime gate model fits this pattern naturally.

**Matched-functionality inventory:**

| Shadow feature | WebGL | WebGPU | Status |
|---|---|---|---|
| Single shadow map (point/spot/directional light) | `ShadowMapShader.js` generates per-config GLSL | `globeComputeShadowFactor` inlined in receivers; `ShadowMap.wgsl` cast shader for the depth pass | **Matched** |
| Point-light cube shadow | `ShadowMapShader.js` cube path + `czm_samplePointShadow` helper | `globeComputeShadowFactorPointLight` inlined; `csm_samplePointShadow.wgsl` helper | **Matched** |
| Cascaded shadow maps (CSM) | `ShadowMapShader.js` cascade path with kernel-size config | `globeComputeShadowFactorCSM` inlined; `ShadowReceiveCSM.wgsl` for primitives. CSM Slice 1+2 shipped per session-handoff memory. | **Matched (Slice 1+2)** |
| PCF (Percentage-Closer Filtering) kernel | Generated, kernel size from config | Fixed 4-tap PCF in `csmControl`-gated path | **Functionally matched**; WGSL kernel size not yet runtime-configurable (Slice 3 follow-up). |
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
| Sun billboard | `SunFS.glsl` + `SunVS.glsl` | Production inline `SUN_SHADER_WGSL` in `WebGPUEnvironmentRenderer.js` (`Environment/Sun.wgsl` is a reference/prototype, not the compiled billboard shader) | Same disc + corona algorithm. The WebGPU draw path is RTE-safe and resource-stable: immutable quad directions are uploaded once, the moving ECEF center is high/low encoded in the per-frame uniform payload, and the vertex buffer/bind group/draw command are reused across clock ticks unless a real device/pipeline/bake invalidator fires. |
| Sun DISC BAKE (C12-15 / C12-16, 2026-07-25) — **an unusual pair: GLSL vs a JS CPU LOOP, not GLSL vs WGSL** | `SunTextureFS.glsl`, run once per texture rebuild as a `ComputeCommand` full-screen pass | `WebGPUEnvironmentRenderer.createSunTexture` — a JS double loop that writes the texels directly (`Environment/Sun.wgsl` exists but is NOT the production shader; the renderer compiles an inline `SUN_SHADER_WGSL` string for the BILLBOARD, and the bake never reaches the GPU) | **Matched, and matched STRUCTURALLY rather than by convention.** Both sides read one resolved payload, `frameState.sunDiscAppearance`, published by `Sun.update` before the backend branch from `Scene/SunDiscAppearance.js` over the constants in `Scene/SolarDiscModel.js`. The GLSL takes it as `u_limbDarkening` (vec3) + `u_glareProfile` (vec4) and holds NO numeric copy; the JS loop imports it. So the limb-darkening triple, the glare core/pedestal/legacy-edge and the legacy-branch selector cannot drift — there is no second literal to drift. The JS `sunGlare()` closure is the explicit twin of the GLSL `sunGlare()` function and is commented as such on both sides. Differences that remain and are INTENTIONAL: bake SIZE + FORMAT (C12-17 — both now follow `2^(ceil(log2(max(dbW, dbH))) - 2)` and select half-float under HDR, but WebGPU caps at 1024 because its loop runs on the CPU), and f32-vs-f64 evaluation (both quantise to 8/16-bit afterwards, so the difference is below one code). Pinned by `Tools/visual-regression/solar-disc-model.spec.mjs` (asserts the GLSL carries no literal and that the JS bake reads `appearance.*`) and measured by `probe-sun-glow-profile.mjs` (`geometry_lockstep` + `c12_16_support` + `c12_15_appearance` gate the two backends against each other). |
| Cube map panorama (loader for HDR environment textures) | `CubeMapPanoramaVS.glsl` (VS only — FS lives in the JS-side panorama orchestrator) | `WebGPU/CubeMapPanorama.wgsl` (single file with VS+FS, mirrored by the renderer's embedded production source) | Same equirectangular → cube-face projection. Star brightness, cloud attenuation and the **C12-27 angular solar-glare washout** are additionally paired only when `CubeMapPanorama.isStarMap === true`; the option defaults false and `SkyBox` opts in, so generic/Street View panoramas retain exact identity. |
| **Star sprite catalogue (C12-27 pair, 2026-08-06)** | `StarFieldVS.glsl` + `StarFieldFS.glsl` | `WebGPU/Catalog/StarField.wgsl` | **Already a full pair for the PSF (C12-05/06/07: `STAR_PSF_SIGMA/ALPHA/BETA/K_HALO` are literal-identical in both fragment shaders, pinned by `starfield-psf.spec.mjs`) and for the C7 extinction. C12-27 adds a VERTEX-stage pair:** an identical `solarGlareVeil(cosSeparation, core, pedestal, support)` function, fed by `u_solarGlare` / `u_solarGlareCurve` (GLSL) and the `solarGlare` / `solarGlareCurve` UB members (WGSL), both written from one CPU resolution (`frameState.solarGlareAppearance`, `Scene/SolarGlareAppearance.js`, constants in `Scene/SolarDiscModel.js`). **Two frame facts are part of the contract:** (1) both shaders dot against the RAW `directionFixed` attribute — the TEME catalogue direction — never the rotated `dirFixed`, because the published Sun vector is resolved into TEME; (2) the glare rides LAST in both `v_color` / `output.color` multiply chains, so the disabled position (`glare == 1.0`) is an exact identity rather than a re-association of the product. Pinned by `Tools/visual-regression/solar-glare-star-washout.spec.mjs`, which extracts and compiles both bodies and requires 1e-15 agreement with the JS reference. |
| Sky atmosphere | `SkyAtmosphereVS/FS/Common.glsl` | `Environment/SkyAtmosphere.wgsl` | Documented Phase 3.1 (Batch 76) |

**WebGL-only legacy** (not migrated, intentional):

- **SkyBox (`SkyBoxFS.glsl` + `SkyBoxVS.glsl`)** — the WebGL legacy skybox renderer. WGSL replaces this with `ProceduralSkyCubemap.wgsl` (compute-baked) + `CubeMapPanorama.wgsl` (HDR equirect loader) — neither is a line-by-line port of the upstream SkyBox shaders, but both subsume its functionality. The WebGL skybox stays for backwards compatibility with apps that explicitly set `scene.skyBox`; WebGPU routes the same scene through the procedural/panorama path automatically.
  - **PARTIAL LOCKSTEP PAIR SINCE C12-29 S6 (2026-07-25).** `SkyBoxFS.glsl` is no longer nine lines and no longer unpaired: it carries the star-brightness modulation and the cloud-cover occlusion, byte-for-byte the same expressions as `CubeMapPanorama.wgsl` (and its JS-embedded production copy in `WebGPUCubeMapPanoramaRenderer.js`), fed by `u_starModulation` (inflection, steepness, enableFlag, cloudCover) + `u_skyBrightness` from `CubeMapPanorama.js` — the WebGL twin of `params.w` + `starModulation`. **The ORDER is part of the contract**: modulate → cloud-occlude → gamma. `czm_gammaCorrect` is a no-op without HDR, but with HDR on it is an sRGB→linear decode, and `k·x^g ≠ (k·x)^g`, so moving the multiply across it silently desynchronises the two backends. Ruling E3 makes this a DEFAULT-ON path on both backends **for the `SkyBox` celestial panorama only**. `CubeMapPanorama.isStarMap` defaults false, and the shared CPU resolver forces both multipliers to identity for generic and Google Street View panoramas. Pinned by `Tools/visual-regression/eclipse-sky-totality.spec.mjs` ("one expression, four implementations" + ordering + panorama-isolation tests). The cubemap SAMPLING and the procedural bake remain unpaired as described above.
  - **C12-27 EXTENDS THIS PAIR (2026-08-06).** `SkyBoxFS.glsl` and both WGSL copies now also carry an identical `solarGlareVeil(cosSeparation, core, pedestal, support)` — the angular solar-glare star washout — fed by `u_solarGlare` / `u_solarGlareCurve` and the `solarGlare` / `solarGlareCurve` UB members from one CPU resolution (`frameState.solarGlareAppearance`). **The contract order grows one step: modulate → cloud-occlude → GLARE → gamma**, for the same reason the previous two multiplies sit before `czm_gammaCorrect`. Both twins sample and dot the SAME `normalize(v_texCoord)` / `normalize(input.texCoord)` direction, which is the cube map's TEME lookup frame on both backends (WebGL applies `czm_temeToPseudoFixed` in `SkyBoxVS.glsl`; WebGPU passes it as `panoramaTransform`). Unlike the star modulation, the glare is **NOT gated on `frameState.skyAtmosphereVisible`** and must not become so: veiling glare is scattering in the observer's optics, not in an atmospheric column, and the orbital viewpoint is exactly where the row was reported from. The WebGPU UB grew ADD-ONLY 256 → 288 bytes (new vec4s at offsets 240/256; no BGL or bind-group churn). Pinned by `Tools/visual-regression/solar-glare-star-washout.spec.mjs`. **Watch item for anyone editing the JS-embedded WGSL: keep that template literal free of backticks.** The specs slice it out by scanning for the first backtick immediately followed by a semicolon, so one inside the string truncates the extracted shader and the naga check then validates a fragment — that regression was introduced and caught within this batch.

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

**WebGPU-only enhancements** (intentional Phase 1.3c / Phase 4 / Phase 6 additions):

- **`Environment/Moon.wgsl`** — the ray-marched analytic moon ellipsoid.
  - ⛔ **CORRECTION (2026-08-02, C12-25): this file is NOT WebGPU-only, and the sentence that used to sit here — "WebGL has no moon billboard (only sun); the moon is rendered through a CzmL/Entity path on WebGL" — was wrong on both counts.** WebGL renders the moon through `Scene/Moon.js` → `EllipsoidPrimitive` → **`Shaders/EllipsoidFS.glsl`**, not through any CZML/Entity path, and `Moon.wgsl` is a deliberate port of that FS (bounding-cube rasterization + analytic ray-ellipsoid intersection + the same `czm_ellipsoidTextureCoordinates` unwrap + `czm_private_phong`-equivalent lighting). The two have been carrying **lockstep pairs since the C12 moon wave (2026-07-24)**: C12-20 Lommel-Seeliger (`LUNAR_BRDF` define ↔ `lunarBRDF` uniform) and C12-23 opposition surge (`OPPOSITION_SURGE` ↔ `oppositionSurge`), plus the older extinction/in-scatter pair. A stale "fork-only" note here is exactly what lets a one-backend edit through, so the pairs are enumerated below.
  - **C12-25 LOLA relief — the pair that has to be edited together.** GLSL `EllipsoidFS.glsl`'s `#ifdef LUNAR_NORMAL_MAP` block ↔ WGSL `Moon.wgsl`'s `if (u.normalStrength > 0.0)` block. **Four things are part of the contract and cannot be edited alone:**
    1. **The decode** — `sample.xyz * 2.0 - 1.0` on both sides, with the strength scaling **only** `.xy`. Scaling `.z` too would change the perturbation's character rather than its magnitude.
    2. **The tangent frame**, rebuilt in **MODEL space** on both sides from the same expression: `up = normalMC`, `east = normalize(-positionMC.y, positionMC.x, 0)` (pole-guarded at `1.0e-6`), `north = cross(up, east)`, then `normalize(east·x + north·y + up·z)`. The GLSL deliberately does **not** call `czm_eastNorthUpToEyeCoordinates` even though it builds the identical basis — the WGSL has no `czm_normal` and lights in model space, so doing it inline on both keeps the twins the same expression instead of "equivalent if you work it out", and the inline form guards the pole degeneracy the builtin does not.
    3. **The upload convention** — `flipY: true` on BOTH backends (WebGL via `Texture`'s default, WebGPU via an explicit option). This is stronger than the C12-24 albedo case: the green channel encodes **NORTH**, so a v-flip does not merely misplace the relief, it lights every crater from the wrong side on one backend only.
    4. **What gets perturbed** — the **lighting** normal (`material.normal` / `m.normal`), not the UV normal, so the relief rides whichever disc law C12-20 selected.
  - **Deliberate WIRING asymmetry, not a math asymmetry.** WebGL gates the sampler behind the `LUNAR_NORMAL_MAP` define because `EllipsoidFS.glsl` is shared by **every** `EllipsoidPrimitive` and must not grow an unconditional sampler; WebGPU keeps binding 3 always present against a 1×1 flat placeholder because `Moon.wgsl` is moon-only and one variant-free pipeline is strictly better. Both reach the **exact** identity when off — strength 0 drives `nTS` to `(0,0,z)` and `normalize(east·0 + north·0 + up·z) = up` bit-for-bit. The strength itself is resolved **once, backend-agnostically** in `Moon.update()` and published as `frameState.moonNormalMapStrength`, so the two backends cannot disagree about whether relief is on.
  - `Tools/visual-regression/moon-normal-map-asset.spec.mjs` pins all four contract items plus the asset's own orientation, and it is a pure-Node spec — run it on any change to the moon shader pair.
  - **C12-21 earthshine + C12-22 soft terminator — two more pairs, added 2026-08-06.** GLSL `#ifdef EARTHSHINE` (`u_earthshinePhaseScale`) ↔ WGSL `u.earthshinePhaseScale`; GLSL `#ifdef SOFT_TERMINATOR` (`softTerminatorMu0` + `u_terminatorSoftness`) ↔ WGSL `softTerminatorMu0` + `u.terminatorSoftness`. **Three contract items:**
    1. **Earthshine had NO GLSL implementation before C12-21** — it was a WebGPU-only celestial term for the whole of Phase 1.2, which is precisely the class of drift this document exists to stop. The GLSL block is now the primary reason the pair is enumerated here; do not let it fall out again.
    2. **`softTerminatorMu0` is character-identical in both languages** — same guard (`softness <= 0.0` → return the hard clip), same `clamp`, same `(clamped + softness)² / (4·softness)`. `Tools/visual-regression/moon-phase-terminator.spec.mjs` **extracts both bodies, compiles them as JavaScript, and requires them to agree with the JS reference in `Scene/MoonPhaseAppearance.js` to 1e-15** — so "character-identical" is enforced computationally, not by eye.
    3. **Where it is applied** — the Lommel-Seeliger branch only, on BOTH backends. The WebGL phong fallbacks run inside `czm_private_phong` / `czm_phong`, shared builtins used by every lit primitive in the engine; softening only the WGSL side would recreate the WebGPU-only asymmetry. The fallback stays hard-clipped on both.
  - Both scalars are resolved **once, backend-agnostically** by `Scene/MoonPhaseAppearance.js` in `Moon.update()` and published as `frameState.moonEarthshinePhaseScale` / `frameState.moonTerminatorSoftness`, the same discipline C12-25 uses for `moonNormalMapStrength`. Off positions are exact identities (1.0 and 0.0 respectively), not approximations.
- **`Environment/ProceduralClouds.wgsl`** — Phase 6 fork-only volumetric cloud layer (raymarched). No WebGL equivalent — would require a compute-shader bake step that WebGL2 can't provide.
  - **It does carry ONE lockstep pair, and it is CPU↔WGSL, not GLSL↔WGSL (C13-07, 2026-08-01).** `worldToWeatherUV` and its texel convention are mirrored on the CPU by `weatherUVFromLonLat` / `weatherTexelCenterLonLat` in `packages/engine/Source/Scene/Weather/WeatherMapSeam.ts`, because both weather-map PRODUCERS (`ProceduralWeatherMap.ts` and `WeatherTexPacker.ts`) have to write the same texel centres the sampler reconstructs. Three things are part of that contract and cannot be edited alone: the two UV expressions in the WGSL, the four `weatherTexBounds` floats the renderer packs, and the weather sampler's `addressModeU: "repeat"` / `addressModeV: "clamp-to-edge"` (the dateline fix assumes the wrap filter exists; the pole fix assumes the polar row is what a pole sample reads). `Tools/visual-regression/weather-map-seam.spec.mjs` pins all three plus the CPU producers, and it is a pure-Node spec — run it on any change to the cloud weather path.
- **`PostProcess/SolarHalo.wgsl` ↔ `PostProcessStages/SolarHalo.glsl`** — C12-18's screen-space solar veiling glare, and a **NEW pair born twinned** (2026-08-07). Both are line-for-line translations of `solarScreenHaloProfile` in `Scene/SolarDiscModel.js`; the JS function is the reference implementation, not a comment about one. **Four things are part of the contract and cannot be edited alone:** (1) the three-line veil body (`rho` → `t` → `veil`), which `Tools/visual-regression/sun-halo-composition.spec.mjs` EXTRACTS from both shader texts, compiles as JavaScript and requires to agree with the JS reference to 1e-15; (2) the y convention — `gl_FragCoord` is y-UP, `@builtin(position)` is y-DOWN, and the published centre is in the GL convention, so **exactly one** flip exists and it lives in the WGSL (`viewport.x - in.position.y`); (3) the halo is ADDITIVE in rgb only and must never touch alpha, because the rest of the post-process chain carries it; (4) the amplitude is `0.75 x eclipseFactor` on both sides — CLT-C4, the eclipse factor multiplies the halo INPUT or the halo survives totality. **The bake half of the same row is a THIRD member of this lockstep group:** `SunTextureFS.glsl`'s `u_haloGain` ↔ the WebGPU CPU bake's `haloGain` in `WebGPUEnvironmentRenderer.createSunTexture`, both derived from ONE boolean in `Scene/SunHaloAppearance.js` so a double halo (bake + screen) is unrepresentable rather than merely avoided. Editing the halo on one backend is the exact failure this document exists to prevent.
- **`Environment/GroundAtmosphere.wgsl`** — the environment-side half of the ground-atmosphere pair (the other half is inlined in `GlobeTerrain.wgsl`, documented in Phase 2.2 Batches 56-72).
- **`Compute/ProceduralSkyCubemap.wgsl`** — compute-shader baked cubemap for fork-only physically-based ambient lighting.
  - **CORRECTION (2026-08-01, IBL-PARITY-GATE-ATTRIBUTION): this file DOES carry a GLSL lockstep twin, and the sentence that used to sit here ("WebGL backend uses pre-baked offline cubemaps") was stale from before Batch 346/530.** WebGL's `DynamicEnvironmentMapManager` bakes its radiance cube procedurally with **`Shaders/ComputeRadianceMapFS.glsl`**, and the WGSL has been a port of it since Batch 346 (`NEW-MODEL-PBR-DIRECT-LIGHT-IBL-PARITY` D1) — same `czm_computeScattering` / `czm_computeAtmosphereColor` model, same intensity + gamma, same ENU→fixed face mapping. The two are the IBL source for `probe-model-ibl`'s cross-backend parity gate: if their **light-direction policy** ever differs per mode, the two backends' environment maps disagree by construction and every IBL-lit model diverges. That policy is `NONE → local up` (deliberately NOT the astronomical sun the sky shell moved to in C12-31 — see `C12-31-FOLLOWUP-B`), `SCENE_LIGHT → the scene light`, `SUNLIGHT → the sun`, `LEGACY_OVERHEAD → local up`; the GLSL reaches it through `czm_getDynamicAtmosphereLightDirection`, the WGSL through its `enumVal` arm plus the renderer's `lightVec` pack. `Tools/visual-regression/sky-light-direction.spec.mjs` §6 resolves the policy out of BOTH sources and compares it mode by mode, so a one-backend migration fails offline with the mode named. **Migrating the NONE arm is a both-backends-or-neither edit.** A false claim that C12-31 had already moved the WGSL arm alone survived a five-round bisect partly because this entry said the WGSL had no WebGL counterpart to be out of lockstep with.
  - **C13-41 (2026-08-07) — the eclipse dims this pair's CPU FEED, symmetrically, with neither shader edited.** The solar-eclipse response for the environment bake lands on the pair's manager-level intensity: WebGPU `SkyUniforms.scatteringIntensity` (slot 34, written as `data[34] = skyColorScattering` in `WebGPUDynamicEnvironmentMapManager.ts`) and WebGL `u_brightnessSaturationGammaIntensity.w` (written as `adjustments.w` in `Scene/DynamicEnvironmentMapManager.js`). Both are the multiplier on the FINAL sky/ground radiance in their respective sources (`skyColor * scatteringIntensity` / `atmopshereColor.rgb * intensity`), so a single backend-neutral multiply on each side keeps the twins in lockstep without touching WGSL or GLSL. **Do NOT confuse this with `SkyUniforms.intensity` (slot 15) / `czm_atmosphereLightIntensity`**, which is baked INSIDE the phase-weighted scattering and is a scene-global automatic uniform on WebGL — dimming that one for the bake alone is not possible today, which is why the ground-facing texels' additive inscatter term stays undimmed on BOTH backends (`C13-41-ENV-GROUND-INSCATTER-ADDEND-UNDIMMED` in `DEFERRED_WORK.md`). Each manager's refresh gate also gained a quantized eclipse level term on the shared `1/256` grid; **dimming either bake without that term latches the environment dark past totality**, which is exactly why C12-29 S2 left both bakes alone. A future edit that dims one side must dim the other AND carry the refresh input, or `Tools/visual-regression/eclipse-cloud-ibl-response.spec.mjs` groups D3/D4 fail with the missing half named.
  - Everything OUTSIDE the shared bake is genuinely fork-only and has no GLSL twin: the multi-scatter LUT sky source (`ENV-AERIAL-MS`, opt-in), the coarse cloud darkening and the full per-face cloud march (`CLOUD-IBL` / `CLOUD-IBL-FULL`, opt-in), and the compute-shader delivery mechanism itself. All are default-off/parity-default, so the default fill stays byte-comparable to the GLSL bake.

**Net status:** environment shader pairs are **architecturally matched** for shipped WebGL features (Sun + sky atmosphere + cube map panorama loader). WGSL replaces the legacy SkyBox implementation with a richer procedural + HDR-loader pair while sharing the now-default celestial modulation contract. **`Moon.wgsl` is TWINNED, not fork-only** — its counterpart is `EllipsoidFS.glsl`, and it carries live lockstep pairs for extinction, in-scatter, C12-20 Lommel-Seeliger, C12-23 opposition surge, C12-25 LOLA relief (corrected 2026-08-02, see above), **C12-21 earthshine, and C12-22 soft terminator** (added 2026-08-06 at Batch 858; this roll-up sentence was reconciled with the bullet above on 2026-08-07 — it had been left listing only the five older pairs, which is exactly the stale-summary shape that this document records twice as having already let a one-backend edit through). **`SolarHalo.wgsl` is TWINNED from birth** (C12-18, 2026-08-07) — its counterpart is `PostProcessStages/SolarHalo.glsl` and both are translations of one JS reference; the sun BAKE's halo gain is the third member of that same group. ProceduralClouds remains a fork-specific renderer enhancement, save for its one CPU↔WGSL weather-map pair. ProceduralSkyCubemap is **half fork-specific and half twinned** — its IBL radiance bake is a lockstep port of `ComputeRadianceMapFS.glsl` (corrected 2026-08-01, see above); only its opt-in MS/cloud extensions and its compute delivery are fork-only.

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
- **Fork-only WGSL enhancements** (no WebGL counterpart by design): TAA, GTAO, SSR, GodRays, VolumetricFog, unified Tonemapping, ColorGrading, OITComposite, DeferredGBuffer + DeferredLighting (Phase 8a scaffolding), ProceduralClouds, ProceduralSkyCubemap, WeatherParticles. All require compute or pre-baked LUT mechanics that WebGL2 cannot provide. (**`Moon` was removed from this list on 2026-08-02** — it is twinned with `EllipsoidFS.glsl` and has been since the C12 moon wave; see the Phase 3.4 correction above.)
- **WebGL-only legacy** (superseded by WGSL factoring, not regressed): 5 individual tonemap variants → unified Tonemapping.wgsl; GaussianBlur1D → folded into BloomComposite; SkyBox → replaced by ProceduralSkyCubemap + CubeMapPanorama; PointCloudEyeDomeLighting (deferred).

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
- The convention ledger could grow unbounded if we keep accumulating
  backend-API differences. If it grows past ~10-15 entries, we should
  re-evaluate Naga as the unification mechanism.

**Why we're choosing this anyway:**
- Naga adds a build-step dependency and a new failure mode (transpilation
  errors). For shaders simple enough to hand-match, the discipline of
  manual lockstep is lower-risk.
- Once shaders are line-matched, swapping to Naga later is mechanical —
  the WGSL source is already canonical.

---

## Future: Naga as a verifier, not a translator

After Phase 3, we have N shader pairs all hand-matched. We can then add
a CI step that:

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
