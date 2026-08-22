# Celestial Appearance Research — 2026-07-19

**Status:** RESEARCH COMPLETE. Source of truth for Campaign 12 (`QUEUE_2026-07-19_CAMPAIGN12.md`) and for the C11 W9 tail rows `C11-176..179`.

**Origin.** Maintainer report 2026-07-19 (three reference images supplied): the WebGPU skybox star map reads significantly more faded than WebGL; added bright stars look like white blobs; the star map may need a denser asset; and the Sun and Moon should look better from orbit.

**Method.** 8 research lanes + adversarial verification of every load-bearing claim + synthesis. **20 of 20 heavy claims were REFUTED by verification and dropped** — what survives below is what an adversarial reader could not break. Repo claims are anchored to `file:line`; asset claims carry exact licences and URLs.

**§1 is DONE.** Its root cause was independently re-verified by the orchestrator and fixed in **Batch 722** (`C11-176`), with runtime A/B proving causation: WebGPU/WebGL mean luminance `0.493 → 1.001`, visible star pixels `4.01% → 21.20%` against WebGL's `21.22%`. The remainder (§2–§7) is Campaign-12 input.

---

# Campaign 12 — Celestial Appearance: construction proposal + C11-tail bug fix

**Scope note on method.** Every repo claim below is anchored to a line I read in this session. Where a research lane's claim was refuted by adversarial verification, I have dropped it and said so. Where I could not settle a question by static reading, I name the exact runtime measurement that would — I ran no browser (orchestrator owns that lane).

---

## 1. The WebGPU skybox fade — diagnosis

### Root cause (high confidence, anchored, and it is *not* on any suspect list in the C11-176 row)

**A WebGPU-only star-brightness modulation multiplier is shipping ON by default, and dims the star cubemap by up to 50% whenever the Sun is above the camera's local horizon. WebGL has no equivalent term at all.**

The chain, end to end:

| Step | File:line | Fact |
|---|---|---|
| Default value | `packages/engine/Source/Scene/AtmosphericConditions.js:368` | `enableStarBrightnessModulation: true` in `buildSkyAtmosphere()`'s leaf object |
| frameState wiring | `packages/engine/Source/Scene/Scene.js:5747-5748` | `frameState.atmosphericConditions = scene.globe.atmosphericConditions` — defined for every default viewer |
| Renderer gate | `packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js:548` | `const enableModulation = !!sky && sky.enableStarBrightnessModulation === true;` → **true at defaults** |
| Uniform | same file `:554` | `uniformData[54] = enableModulation ? 1.0 : 0.0` |
| Shader | same file `:131-136` (production WGSL is the embedded string, not the `.wgsl` file) | `let t = clamp((skyBrightness - inflection) * steepness, 0,1); let factor = 1.0 - smoothstep(0.0,1.0,t); modulated = modulated * factor;` |
| Curve constants | `AtmosphericConditions.js:365-366` | `inflection: 0.5, steepness: 1.0` |
| Driver | `Scene.js:5767` → `packages/engine/Source/Scene/SkyBrightness.js:102-105` | `skyBrightness = smoothstep(-0.1, 0.4, dot(sunDirWC, cameraUp)) + moonTerm` |
| WebGL counterpart | `packages/engine/Source/Shaders/SkyBoxFS.glsl` (whole file, 9 lines) | `out_FragColor = vec4(czm_gammaCorrect(color).rgb, czm_morphTime);` — **no modulation, no skyBrightness, nothing** |

Arithmetic with the shipped constants (`inflection=0.5`, `steepness=1.0`):

- `skyBrightness ≤ 0.5` → `t=0` → `factor = 1.0` (no dim). This is night / anti-solar.
- `skyBrightness = 0.75` → `t=0.25` → `factor = 0.844` (−16%).
- `skyBrightness = 1.0` → `t=0.5` → `smoothstep(0,1,0.5)=0.5` → **`factor = 0.5` (−50%)**.

`skyBrightness` reaches 1.0 whenever `dot(sunDir, cameraUp) ≥ 0.4`, i.e. the Sun ≥ ~23.6° above the camera's local horizon. For any orbital or high-altitude camera on the sunlit side, that is most of the hemisphere. The dim begins around `sunAlt ≈ 0.15` (~8.6°).

**This is the exact same defect shape as the already-fixed `ENV-SKYBOX-STARMAP` bug** — which was also a default-`0.5` WebGPU-only multiplier on the same `modulated` value (cloud cover, `WebGPUCubeMapPanoramaRenderer.js:566-573`, now correctly gated on `weather.enabled`). The cloud half was fixed; the star-modulation half was believed fixed but was not.

**The code believes it is off.** `WebGPUCubeMapPanoramaRenderer.js:540-547` carries an explicit comment: *"Default OFF for WebGL parity — the legacy SkyBox shader (SkyBoxFS.glsl) emits the cubemap unmodulated regardless of sun position… Apps that want the dimming behavior must opt in."* The `=== true` gate at `:548` was written to be fail-safe against an **absent** property. `AtmosphericConditions.js:368` then ships the property **present and `true`**, defeating it. Intent and shipped default contradict each other, in two different files, which is why this survived.

**A second, corroborating inconsistency:** the renderer's fallback curve is `{inflection: 0.3, steepness: 4.0}` (`:539`) but the live values are `0.5 / 1.0` (`AtmosphericConditions.js:365-366`). The B4-locked `0.3/4.0` pair would drive `factor` to **0.0** (total blackout of the star map) at `skyBrightness=1.0`. So the fade magnitude currently depends on which object initialized the curve — a latent worse-case.

### Minimal fix

```
packages/engine/Source/Scene/AtmosphericConditions.js:368
-    enableStarBrightnessModulation: true,
+    enableStarBrightnessModulation: false,
```

One line. Restores byte-parity with `SkyBoxFS.glsl` on the default path, preserves the additive WebGPU feature behind an opt-in (consistent with the C11 governing principle: never remove additive WebGPU, default to parity, keep the toggle). Also reconcile the `0.3/4.0` vs `0.5/1.0` curve-default disagreement in the same change so the opt-in path is deterministic.

**Rider, free:** `AtmosphericConditions.js:369` `enableNightSkyDimming: true` has **zero consumers** anywhere in `packages/engine/Source` (grep). Either wire it or mark it explicitly as reserved — do not silently leave a second default-ON celestial flag with no reader.

### Honest boundary — what would falsify this

If the maintainer's WebGL-vs-WebGPU comparison was made **at night / on the anti-solar side**, `factor = 1.0` and this mechanism contributes nothing. Two runtime measurements settle it in one probe run, both cheap:

1. **Read `frameState.skyBrightness` at the maintainer's exact repro view.** If it is > 0.5, the modulation is live and its exact magnitude is `1 - smoothstep(0,1,clamp((sb-0.5),0,1))`. If it is ≤ 0.5, this is not the cause and the fade lives elsewhere.
2. **A/B `scene.globe.atmosphericConditions.skyAtmosphere.enableStarBrightnessModulation = false`** on WebGPU only, same frame, and diff. A confirmed cause moves the WebGPU capture toward WebGL by exactly the predicted factor.

### Suspects to strike from the C11-176 row (all disproven at file:line)

| C11-176 suspect | Verdict | Anchor |
|---|---|---|
| "skybox tonemapped on WebGPU but not WebGL" | **DISPROVEN.** Both gate on HDR identically. | `WebGPUPostProcessStageCollection.ts:536` `setStageEnabled("Tonemap", useHdr && !hdrOutputMode)` vs `PostProcessStageCollection.js:575` `tonemapping.enabled = useHdr`; `Scene.js:1458` `highDynamicRange = false` |
| "sRGB-vs-linear cubemap format mismatch" | **DISPROVEN.** SDR path is byte-passthrough on both; HDR decode is implemented and gated. | `WebGPUCubeMapPanoramaRenderer.js:151-155` (`if (hdrGamma > 0.5)`), `:575-587` (`hdr.x` = czm_gamma only when `frameState.useHDR`), vs `SkyBoxFS.glsl` `czm_gammaCorrect` `#ifdef HDR` |
| "AutoExposure metering the limb down" | **DISPROVEN at defaults.** WebGPU now syncs WebGL's opt-in flag, default false. | `WebGPUPostProcessStageCollection.ts:631-633`; `PostProcessStageCollection.js:42-43` |
| "mip-averaging stars into grey mush" | **DISPROVEN.** No mips generated on the skybox path. | `loadCubeMapWebGPU.ts:137,160` (`generateMipmaps` default false) |
| "missing intensity multiplier" | **INVERTED** — there is an *extra* multiplier, above. | `WebGPUCubeMapPanoramaRenderer.js:548` |
| SkyAtmosphere ALPHA_BLEND veil (C11-116) | **NOT a divergence candidate.** Both backends composite the same alpha-over shell in the same shared draw order; it cannot produce a WebGPU-vs-WebGL delta. Do not promote C11-116 ahead of C11-176 on this reasoning. | — |

### Verification probe design (C12-G1, see §5)

Extend `Tools/visual-regression/probe-env-skybox-stars.mjs` rather than writing a new one. Two required changes before it is trusted as the C11-176 gate:

1. **Add a sunlit-side camera.** The current probe parks at `fromDegrees(0,0,5.0e7)` pitch +90° facing away from Earth — a framing in which `skyBrightness` is whatever the ephemeris gives and the limb is never in frame. Add a variant with the Sun ≥ 25° above the camera's local horizon; that is the only framing in which this bug is visible at all. A gate that cannot reach the failing state is not a gate.
2. **Add contrast metrics** (M1/M2 in §5). The existing `starPct` threshold-count *did* catch the B504 0.5× dim, so the probe is not blind — but a uniform 0.844× partial dim can sit inside its ±33% band. Report the floor and variance ratios alongside.

---

## 2. Why bright stars look like white blobs

**This is NOT a parity defect.** `packages/engine/Source/Shaders/StarFieldFS.glsl:18-21` and `packages/engine/Source/Shaders/WebGPU/Catalog/StarField.wgsl:140-143` are character-identical, and both backends consume the same `Scene/StarFieldMath.ts`. Whatever we change must land on both files or we *create* a parity gap (Principle 5). Symptom #2 is a shared design limitation; symptom #1 is the WebGPU-only bug in §1. Do not let one fix claim credit for the other.

### The mechanism, quantified

Four factors compound. Ordered by contribution:

**(a) The peak clips against an 8-bit target, and the HDR/bloom escape valve the code assumes does not exist.**

`StarFieldMath.ts:132` sets `HI = 2.0` with the comment *"overflows 1.0 → SUBTLE bloom, not a blob"*, and `StarField.wgsl:14-16` / `:145-146` assert *"bright stars overflow 1.0 in the scene FB float target and feed the bloom bright-pass."* **Both premises are false at defaults:**

- `Scene.js:1458` — `this.highDynamicRange = false`
- `WebGPUSceneFramebuffer.ts:282` — `const colorFormat = hdr ? this._pickHDRFormat(device) : canvasFormat;` → 8-bit unorm
- `SceneFramebuffer.js:34-38` — WebGL selects `PixelDatatype.UNSIGNED_BYTE` when `!hdr`
- `PostProcessStageCollection.js:56` — `bloom.enabled = false`

So the overflow is destroyed by the ROP at write time and the bloom that was supposed to convert it into a halo never runs.

Saturation radius: output is `rgb = color * alpha` with `color` peaking at `HI × intensityScale × extinction = 2.0` (extinction is `(1,1,1)` from orbit, `StarField.wgsl:127-129`). Clip when `alpha ≥ 0.5`. With `alpha = exp(-2.2d²)·smoothstep(1.0,0.45,d)`: `alpha(0.50)=0.564`, `alpha(0.55)=0.469` → **the inner ~53% of the sprite radius (~28% of its area) is a flat, colourless, fully-saturated white plateau.** That is the blob, exactly.

**(b) The profile has no wing, and is then hard-truncated while still carrying energy.** `edge = smoothstep(1.0, 0.45, dist)` forces `alpha` to *exactly* zero at `dist = 1.0`, where the Gaussian is still at `exp(-2.2) = 0.111`. There is no falloff outside the quad, by construction. The reference-2 (Polaris) look — a halo graduating over *many* core radii — is **geometrically unreachable** at the current quad size regardless of any brightness retune.

**(c) The quad is small.** `StarField.js:66` `_pointAngularSize = 0.0042` rad. On a 1024×768 canvas at Cesium's default 60° (horizontal) FOV, `proj[5] ≈ 2.31`, giving NDC half-extent `0.0097` → **~3.7 px half-extent, a ~7.5 px sprite** — of which ~4 px across is the saturated plateau. There is 1–2 px of budget for a "halo". Any wing term must be paired with a much larger quad.

**(d) Dynamic range is pre-crushed ~14×, so bright stars are near-interchangeable.** `StarFieldMath.ts:127-132`: `MAG_CUTOFF=2.5`, `FLUX_GAMMA=0.5`, `LO=0.5`, `HI=2.0`. True Pogson ratio across the rendered set (mag −1.46 … +2.5) is `10^(0.4·3.96) = 38.4:1`; delivered range is `0.742 … 2.000 = 2.70:1`. Then both ends clip. Sirius and a 2nd-magnitude star arrive at the framebuffer nearly identical — and then land in the same white plateau.

**(e) Colour is computed correctly and then destroyed for precisely the stars that matter.** `bvToRgb` (`StarFieldMath.ts:54-90`, Ballesteros 2012 + a public-domain Planckian-locus fit) renormalizes to peak-channel 1.0; the VS then scales by up to 2.0; the 8-bit clamp maps everything above 1.0 to `(1,1,1)`. The brightest stars are the *only* ones guaranteed to lose their hue. **This is second-order** — most of the top-16 stars are near-white in reality — but it is why the plateau is achromatic.

### Corrected model

**Magnitude → luminance.** Stop baking the gamma. Keep the mapping strictly linear in flux (`relative flux = 10^(-0.4·Δm)`, Pogson 1856) and put all compression in an explicit exposure term plus the display transform. `FLUX_GAMMA=0.5` permanently destroys ordering information before any exposure control can act on it.

**PSF shape.** Moffat (1969): `I(r) = I₀·[1 + (r/α)²]^(−β)`, whose defining property is a **power-law wing with constant log–log slope −2β** — the analytic description of "wide, smooth, graduated halo over many core radii". The current Gaussian is the `β → ∞` degenerate limit of the same family. Concretely, replacing `StarField.wgsl:140-143` and the mirrored `StarFieldFS.glsl:18-21`:

```
let r     = length(input.corner);
let core  = exp(-r*r/(2.0*SIGMA*SIGMA));                 // SIGMA ≈ 0.12–0.18 (tight)
let halo  = pow(1.0 + (r/ALPHA)*(r/ALPHA), -BETA);       // ALPHA ≈ 0.06–0.15, BETA ≈ 2.0–2.6
let prof  = core + K_HALO * halo;                        // K_HALO ≈ 0.05–0.15
let alpha = prof * smoothstep(1.0, 0.92, r);             // narrow AA window ONLY
```

Three things that make or break this:
- **The window must move from `0.45` to ~`0.92`.** Left at `0.45` it multiplies the new wing to zero across the outer 55% of the sprite and the change is inert.
- **`α` must be small relative to the quad** — that, not the profile family, is what produces "halo over many times the core radius".
- **Use β ≈ 2.0–2.6, not 4.765.** Trujillo et al. 2001's β=4.765 fits *ground-based atmospheric seeing*, which is the wrong regime — the maintainer's scenario is vacuum, so the halo is instrument/ocular response. The authoritative model there is the CIE/Vos–van den Berg glare spread function, whose classic Stiles–Holladay form is inverse-square in angle (`Lv(θ) = 10E/θ²`, log-log slope −2); Spencer, Shirley, Zimmerman & Greenberg, *Physically-Based Glare Effects for Digital Images*, SIGGRAPH '95 pp. 325-334 (https://www.graphics.cornell.edu/pubs/1995/SSZG95.pdf) is the canonical graphics formulation. Implement from the published equations; copy no code.

**Amplitude — the step that actually kills the blob.** Adding a wing to a clipping core makes a *bigger* blob. The peak must stop saturating: either lower the peak so the core clips over only 1–3 px and let the wing carry perceived brightness, or route through a highlight rolloff in-shader. **Do not raise `HI`** — under an LDR clamp that strictly widens the white disc (clip radius `0.53 → ~0.75` at `HI=4.0`).

**Chroma preservation.** Structure the output so only the core peak is allowed past 1.0: `rgb = chroma * (coreIntensity*core + haloIntensity*halo)` with `haloIntensity < 1.0` by construction. The core blows to white on clamp (correct — a saturated detector *does* go white, and the Polaris reference has a white core) while the graduated halo keeps full blackbody hue. **This works without touching the framebuffer format**, which makes it the recommended first increment.

**Size.** `sizeBoost` is hardcoded `0.0` (`StarFieldMath.ts:166`) with a physically-correct rationale (stars are unresolved point sources). Do **not** reinstate a naive size boost — that just scales the blob. The vertex path already plumbs it end-to-end (`StarField.wgsl:104-105`), so if bright stars must read larger, drive **halo extent** through it, not core size, and hard-clamp total glare angular diameter (Celestia adopted 1° after Gaussian approaches produced visible squares around bright stars — https://github.com/CelestiaProject/Celestia/issues/1948).

**HDR/bloom.** The correct end state is that the halo comes from real HDR energy through the bloom bright-pass, not a painted-on gradient — but that needs `highDynamicRange = true`, which also engages the tonemapper. Note the failure mode is already present: PBR Neutral (the default on both backends, `PostProcessStageCollection.js:50`) maps peak 2.0 → 0.961 and mixes 13.5% toward achromatic white by construction (`Shaders/WebGPU/PostProcess/Tonemapping.wgsl:106-126`) — so enabling HDR alone replaces a hard clamp with a 10% ramp that still reads flat. And **do not switch the default operator to ACES** to "fix the sun": `acesTonemap` ends in a per-channel `clamp(mapped,0,1)` (`Tonemapping.wgsl:58-66`), which maximizes hue-shift-to-white on exactly these pixels. Sequence HDR **last**.

**Stale comments to correct in the same change** (they are what made this hard to diagnose): `StarField.wgsl:14-16`, `:145-146`, `StarFieldFS.glsl:23-24`, `StarFieldMath.ts:118-119` (assert a float target + bloom that are off by default); `StarField.js:63` says "~0.34°" for `0.0042` rad (actual **0.2406°**); `StarField.js:69-71` documents `_minPointSize` as "~0.0030 ≈ 2.3 px" while the value is `0.0022` and the angular term is 3–5× larger, so the floor is never reached; `SkyBox.js:49-51` still says StarField is "an inert no-op" on WebGL, falsified by the WebGL twin registered at `Renderer/Context.js:766-788`.

---

## 3. Asset recommendation

### First, correct the record: the incumbent asset **is** attributed

`LICENSE.md:1042` carries `### Sky box images from NASA` with `http://svs.gsfc.nasa.gov/vis/a000000/a003500/a003572/` and `http://maps.jpl.nasa.gov/stars.html`. There is **no licensing compliance gap** — the earlier research lane's grep missed it because the heading reads "Sky box" (two words) and the product is identified by numeric ID, not by "tycho". Do not add a duplicate entry.

What *is* wrong: those URLs have rotted (`.../a003572/` 404s; live page is https://svs.gsfc.nasa.gov/3572/, and the NASA terms link is a dead legacy path — live: https://www.nasa.gov/nasa-brand-center/images-and-media/). That is a link refresh, not an emergency.

### The incumbent is the *faintest* variant of its own product family

Verified directly from https://svs.gsfc.nasa.gov/3572/ ("Tycho Catalog Skymap – Version 2.0", Tom Bridgman / Ernie Wright):

| Variant | SVS description (verbatim) | Highest resolution offered |
|---|---|---|
| **t3** (shipped) | "the Milky Way is very faint" | 8192×4096 |
| t4 | "the Milky Way is fainter and bright stars are smaller" | 8192×4096 |
| **t5** | **"the Milky Way is very bright and bright stars are large"** | **16384×8192** |

The fork ships six 1024×1024 JPEGs derived from **t3** (`packages/engine/Source/Scene/SkyBox.js:182`, `tycho2t3_80_${suffix}.jpg`; measured 118,775–167,980 bytes each, 868 KB total). EXIF Software = Paint.NET v3.5.10 — a hand-edited reprojection, not a pipeline output.

**Recommendation, and it is the cheapest high-value asset action available:** re-derive the six cube faces from **`TychoSkymapII.t5_16384x08192`** at **4096 px/face**.

- Same SVS product, same collection, same creators, **same existing `LICENSE.md` entry** — zero new provenance work beyond refreshing the two dead links.
- Directly serves the maintainer's dense-Milky-Way reference: t5 is the "very bright Milky Way" render.
- Resolution: 1024/face gives ~5.3 arcmin/px; 4096/face gives ~1.3 arcmin/px, matching the 16k equirect source almost exactly.
- **License: NASA/GSFC SVS, US public domain**, commercial use permitted, credit requested not required. Credit line to carry: *"NASA/Goddard Space Flight Center Scientific Visualization Studio."* **SAFE TO BUNDLE in an Apache-2.0 repo** (baseline corrected `R-2026-08-21-23`; the earlier "MIT repo" framing was wrong — public-domain intake is compatible either way).
- **One gotcha, flagged and UNVERIFIED as a mechanism:** SVS states the product's *"color standard to SMPTE with a gamma of 1.8"*, and the shipped JPEGs carry no ICC profile. Decoding gamma-1.8 content as sRGB (~2.2) darkens and flattens it. This is shared by both backends so it is **not** the parity fade — but it is a real contributor to the absolute "faint" look and should be corrected during the re-bake (convert to sRGB explicitly, don't just re-crop).
- Format: 4:2:0 chroma subsampling in the current JPEGs actively destroys per-star colour. Re-bake to 4:4:4, PNG, or KTX2. VRAM: 4096/face RGBA8 = ~402 MB uncompressed, so BC6H/ASTC via KTX2 is required, or ship 2048 default with 4096 opt-in.

### DISQUALIFIED / BLOCKED: NASA SVS Deep Star Maps 2020 (SVS 4851)

Technically the best asset available (1.7 billion stars, native OpenEXR float, layers split diffuse-vs-bright). **But its `milkyway_2020` and `starmap_2020` layers are Gaia DR2-derived, and ESA states verbatim that "Gaia data are distributed under the CC BY-NC 3.0 IGO license"** (verified: https://www.cosmos.esa.int/web/gaia-users/license). Non-commercial is **incompatible with MIT**, which grants unrestricted commercial use and cannot sublicense an NC asset.

- `milkyway_2020_*`, `starmap_2020_*` → **DO NOT BUNDLE, do not derive from.** Status: encumbered / maintainer-legal call.
- `hiptyc_2020_*` (Hipparcos-2 + Tycho-2, Gaia-free) is the only clean layer — but it is the *bright-star* layer, which we architecturally do not want as a texture (below). Still requires its own confirmation before bundling.
- The counter-argument (NASA marks third-party copyrighted material and did not so mark this; raw astrometry is arguably uncopyrightable under *Feist*) is **not something I will rely on** — a rendered image is a creative work. This is a maintainer/legal decision, not an engineering one. **Flagged as Open Question Q1.**

**Also hard-excluded, recorded so a future session does not reach for them:**
- Axel Mellinger All-Sky Milky Way Panorama (milkywaysky.com) — paid commercial license. **DISQUALIFIED.**
- ESO GigaGalaxy Zoom (eso0932a) — CC BY 4.0, so *licence-clean*, but rejected on technical grounds: the public download is only ~18 Mpx (below even the 8k NASA layer), and it is a terrestrial photograph with airglow, light pollution and atmospheric extinction baked in — exactly wrong for a from-orbit skybox where the engine applies its own extinction. **Use as an art-direction reference only.**
- Direct Gaia DR2/DR3 catalogue use — CC BY-NC 3.0 IGO. **DISQUALIFIED.**

### Architectural call: texture = diffuse, sprites = bright stars

**The fork already made this split, and it is correct.** Keep it. Supporting arguments: NASA independently ships the same split (diffuse `milkyway` vs bright `hiptyc`); a baked point source is bandwidth-limited to the texel grid while a sprite is resolution-independent; a sprite carries HDR intensity in a vertex attribute at zero storage cost; and runtime parameters (atmospheric extinction, the requested wide halo, twinkle, proper motion) need per-star control a texture cannot provide — the fork already exploits this for extinction (`StarField.js:6-10` → `computeAtmosphereExtinctionCached`).

**The defect is the *seam*, not the split.** Two concrete problems:

1. **Double-draw band.** The cubemap is the threshold-magnitude-3.0 render, and SVS states that stars *fainter* than the threshold have their magnitude-intensity curve adjusted so they appear brighter than they really are. The sprite pass cuts at `MAG_CUTOFF = 2.5`. So stars at mag ≤ 2.5 are drawn **twice** — once in the texture, once as a sprite — which over-brightens exactly the stars the maintainer says are blobs. Moving to t5 (threshold 5.0) *widens* that overlap and makes it worse unless the cutoff is reconciled in the same change.
2. **Population starvation.** Only ~80 stars are drawn as sprites (`StarFieldMath.ts:126-128`, the comment states "~80 stars at 2.5"), while `Scene/BrightStarCatalog.js` embeds 263 BSC5 factual records spanning visual magnitude -1.46 through 5.0; the renderer sizes buffers from `data.length / STRIDE`, so appending rows needs **no** renderer change. The earlier “public domain” assertion is withdrawn: BSC5 is freely available, but no public-domain dedication or redistribution licence has been found. See the catalog source and `C12-09` / DR-02. A sky with ~80 identical bright discs and nothing between them reads as scattered blobs; a graded population reads as stars.

**Correct target state:** the cubemap carries only unresolved diffuse light (no bright-star magnitude boost), the sprite catalogue extends beyond the current magnitude-5.0 floor to ~5.5–6.5, and the two meet at a single agreed magnitude with no overlap. The full 9,110-entry BSC5 is **not** currently vendored, so that extension is a new, rights-reviewed data ingest, not just raising a constant.

**Bonus:** `migration_doc/CELESTIAL_WATER_REFLECTION_RESEARCH.md:264` names "a samplable STAR cubemap" as C11-163's biggest blocker (`sampleStarField()` has no texture; `StarField.wgsl` is un-samplable point sprites). If C12 produces a re-baked cubemap, it discharges that blocker for free.

---

## 4. Sun and Moon improvements

Ranked by realism-per-effort. **Self-contained** = shader/CPU-bake only, no post-process chain dependency.

### Moon (all shader one-liners except the last)

| # | Change | Effort | Self-contained? | Anchor |
|---|---|---|---|---|
| M1 | **Lommel-Seeliger reflectance.** `phongCsmMaterial` returns `m.diffuse * rawNdotL * lightColor + spec` with `specularStrength = 0.0` — the moon is a **pure Lambert sphere**, which is why the full moon reads as a shaded ball instead of a flat bright disc. Replace `rawNdotL` with `2.0 * NdotL / (NdotL + NdotV + 1e-4)` (the 2.0 normalizes to 1.0 at opposition). `toEyeMC` is already computed at `Moon.wgsl:338`. | XS | ✅ | `Moon.wgsl:186-196, 344`; `WebGPUEnvironmentRenderer.js:1170-1171` |
| M2 | **Earthshine is physically backwards.** `vec3(0.4,0.5,0.7)*0.08*(1.0-rawNdotL)` is a **constant** with no phase dependence. Earth's phase as seen from the Moon is the exact complement of the Moon's phase from Earth: earthshine should peak at new moon and vanish at full. Multiply by `(1.0 - u.phaseFraction)` — already in the uniform block at `Moon.wgsl:99`. Keep the blue tint; real earthshine *is* bluer than sunlight. | XS | ✅ | `Moon.wgsl:351-355`; `Moon.js:154-155` |
| M3 | **`phaseGate` is a WebGPU-only default-ON parity divergence** — the same class of bug as §1. `enableMoonPhase` defaults **true** (`AtmosphericConditions.js:310`), and `phaseFraction`/`earthshine` appear in **no GLSL file** (grep across `Shaders/*.glsl` → only `Environment/Moon.wgsl` + its generated `.js`). It is also a physical double-count: N·L against the real Simon1994 sun direction already produces the correct terminator and phase for free; the extra `smoothstep(0.0,0.3,phaseFraction)` additionally blacks out real crescents. **Delete it and let N·L carry the phase** — which resolves the parity divergence at the same time. | XS | ✅ | `Moon.wgsl:345-346`; `AtmosphericConditions.js:310-311` |
| M4 | **Soft terminator** from the Sun's finite ~0.5° disc: a penumbra of ~±0.0044 in N·L. One `smoothstep`. | XS | ✅ | — |
| M5 | **Opposition surge.** Lunar brightness rises >40% between phase angles 4° and 0° — beyond anything Lambert or even Lommel-Seeliger predicts (Hapke et al., *Icarus* 1997). Cheap here because for a distant decorative moon the phase angle α is effectively **constant across the disc**: compute it once per frame CPU-side (already recoverable from the dot product at `Moon.js:154`), pass one uniform, apply `B(α) = 1 + B₀/(1 + tan(α/2)/h)` with B₀ ≈ 1.0–2.0, h ≈ 0.05–0.11. Zero per-pixel cost. | S | ✅ | — |
| M6 | **Texture swap.** `moonSmall.jpg` is **256×128** (18,196 bytes). Note the prior `C4-CELESTIAL-HIRES-MOON` WONT-DO rests on two false premises: (a) it claims no hi-res map can be licensed — NASA SVS **CGI Moon Kit** (https://svs.gsfc.nasa.gov/4720) publishes LROC-derived colour maps at 1k/2k/4k/8k/16k/27k, and NASA's brand-center terms name texture maps explicitly as not subject to US copyright; (b) its arithmetic is inverted — a 256-px-wide equirect map spans 360°, so the *visible hemisphere* is only 128 texels, stretched over the probe's own ~190 px disc = **0.67 texels/px, i.e. under-resolved and visibly soft**. `lroc_color_2k.jpg` (2048×1024, 447 KB) or `lroc_color_poles_1k.jpg` (136 KB) is a straight swap at `Moon.js:109` and is **parity-neutral by construction** (both backends read `textureUrl`). Drop the WONT-DO's altitude-blend half — that one *would* open a parity gap. | S | ✅ | `Moon.js:109`; https://svs.gsfc.nasa.gov/4720 |
| M7 | **LOLA-derived normal map** for terminator relief. NASA ships LDEM displacement (`ldem_4.tif` 1440×720 etc.) but **no ready-made normal map** — must be derived offline. Same public-domain status. | M | ✅ (needs an offline build step + a second binding) | https://svs.gsfc.nasa.gov/4720 |

**Do NOT spend effort on:** libration (already exact — the IAU 2000 E1–E13 series at `Core/Iau2000Orientation.js:44-104` supplies physical libration implicitly, and optical libration falls out of the real ephemeris; grep for "libration" returns zero hits *because it is not needed*), or angular size (a real 1,737,400 m sphere at real ephemeris distance, normally projected — 32.9′ perigee / 29.5′ apogee, matching reality). Both are also **explicit non-goals** in `FEATURE_INVENTORY.md:1076-1078`; do not silently reintroduce them.

### Sun

| # | Change | Effort | Self-contained? | Anchor |
|---|---|---|---|---|
| S1 | **Limb darkening.** WebGL's bake uses `float surface = step(radius, u_radiusTS)` — a **binary, perfectly flat disc**. Standard law `I(ψ)/I(0) = Σ aₖcosᵏψ` with a₀=0.3, a₁=0.93, a₂=−0.23 gives limb = 30% of centre. With `μ = sqrt(1-(r/R)²)`, ~4 lines per bake. Cheapest realism win in this lane. | S | ✅ | `Shaders/SunTextureFS.glsl:23`; `WebGPUEnvironmentRenderer.js:252` |
| S2 | **Replace the compact-support glow.** Both bakes use `1.0 - smoothstep(0.0, 0.55, radius)`, which reaches **exactly zero at 0.55 and stays zero** — a hard terminating edge. Real glare never terminates. Replace with `k/(θ²+ε)` per Stiles–Holladay. One expression per backend. | S | ✅ | `SunTextureFS.glsl:26`; `WebGPUEnvironmentRenderer.js:260` |
| S3 | **WebGPU sun texture is format- and resolution-degraded vs WebGL.** WebGPU allocates `rgba8unorm` at a hardcoded 256×256 (`:215`, `:456`); WebGL selects HALF_FLOAT under HDR and sizes from the drawing buffer (`Sun.js:215-234`) — e.g. 512² at 1920×1080. 8-bit quantization of a smooth glow ramp is visible banding. | S–M | ✅ | `WebGPUEnvironmentRenderer.js:215,456` vs `Sun.js:215-234` |
| S4 | **Physical-honesty architecture.** From orbit the Sun subtends ~0.53° and there is **no atmospheric halo in vacuum** — all glow is instrument/ocular response. So: render the disc at true angular size, produce all halo as a **screen-space** effect. The fork's substrate is already sound: `packSunUniforms` derives `angHalf = SOLAR_RADIUS / distance(sunPositionWC, camera)` with aspect-corrected projection terms, then scales the quad by `sunSizeScale = 1 + 2·glowLengthTS` = **11×** at default `glowFactor` — ~5.9° of billboard with the true disc at 1/11 of its width. The halo headroom already exists; only the falloff filling it is wrong. | M | ❌ (architecture decision) | `WebGPUEnvironmentRenderer.js:399-410` |
| S5 | **Neither backend carries true HDR sun energy.** WebGL's bake ends `clamp(color, 0, 1)`; WebGPU's clamps to 255/channel. So even with a HALF_FLOAT texture under HDR, the stored sun is LDR, and the BrightPass operates on a saturated flat 1.0 rather than energy ~10⁵× the frame. | L | ❌ | `SunTextureFS.glsl:54`; `WebGPUEnvironmentRenderer.js:280-283` |

**Scaffolding notice (Principle 7 — do NOT delete):** `packages/engine/Source/Shaders/WebGPU/Environment/Sun.wgsl` is **not** the production shader (the renderer compiles the inline `SUN_SHADER_WGSL` at `WebGPUEnvironmentRenderer.js:61`), but it already contains a **limb-darkening prototype** (`let limb = 1.0 - pow(dist*0.95, 4.0)`), a corona term, and a `generateSunTexture` **compute** entry point that would replace the CPU bake. It is a starting point for S1/S3, not dead code. The same trap applies to `Shaders/WebGPU/CubeMapPanorama.wgsl`, which has drifted from the production embedded string (it lacks the `hdr` uniform and still carries a "TODO: decode sRGB → linear" that is already implemented at `WebGPUCubeMapPanoramaRenderer.js:145-154`). **Anyone diagnosing from the `.wgsl` files will chase already-fixed bugs.**

### Already queued — DO NOT double-schedule

| ID | What | Status | Interaction with C12 |
|---|---|---|---|
| **C11-160** | `scene.sunBloom` → WebGPU PP Bloom/LensFlare wiring | NOT STARTED, W7 after C11-117 (`QUEUE:410,695`) | **This is the single largest contributor to the "sun looks like a blob".** `sunBloom` defaults **true** (`Scene.js:556`) and drives the full `SunPostProcess` chain on WebGL, but is gated off on WebGPU via `supportsLegacySunBloom` (`FramebufferOrchestrator.js:42-53`). WebGL ships a wide blurred halo by default; WebGPU ships the bare quad. It is a **routing** task against existing tested WGSL (`LensFlare.wgsl`, `BrightPass.wgsl`, `GaussianBlur1D.wgsl`, `BloomComposite.wgsl`, `WebGPUGodRayEffect`), not new authoring. C12 depends on it; do not re-file. |
| **C11-115** | WebGPU sun blend ADDITIVE → ALPHA_BLEND | **RESOLVED-as-decision 2026-07-18**, implementation in W7 (`QUEUE:291`) | Verified live divergence: WebGPU uses `src-alpha`/`one` (`WebGPUEnvironmentRenderer.js:519-530`) vs WebGL `BlendingState.ALPHA_BLEND` (`Sun.js:312-314`). Additive over a bright sky independently pushes the core to flat white. Direction is ratified — do not re-open. |
| **C11-161** | AutoExposure demand-gate | NOT STARTED, W7 (`QUEUE:411,696`) | **Perf** item, not a parity fix. AE parity already shipped in Batch 364. Do not re-scope it as the fade cause. |
| **C11-79 / C11-80** | Celestial retained resources / starfield single submission | NOT STARTED, **W1 — imminent** (`QUEUE:232-233`) | C11-80 retains star commands and must land **before** C11-79. **Any starfield renderer change in C12 must be sequenced against these two or it will conflict.** |
| **C11-SEED-07** | NEW-SUN-MOON-FIDELITY | seed, P3 (`QUEUE:292`) | **Overlaps C11-179 directly.** Fold one into the other before scheduling — queue hygiene, XS. |

---

## 5. Acceptance criteria

**Stated up front for the gate doc, so nobody re-proposes a mean diff:** convolution with any normalized kernel preserves the image mean exactly (`mean(I*k) = mean(I)` when `Σk=1`). Mip-averaging, bilinear magnification, MSAA resolve and JPEG DCT smoothing therefore move **zero** on a mean-luminance comparison. A tonemap shoulder is worse than mean-neutral — it can *raise* the mean while flattening the highlight tail. And a uniform multiplicative dim (the §1 bug) is the one fade a mean *does* catch — but a partial 0.844× dim sits comfortably inside the existing probe's ±33% band. **Every gate below is second-order.**

### Metrics

- **M1 — Point-source census.** Per pixel: local background `B` = median over an 11×11 annulus (r 3→5); local peak `P` if a strict 3×3 local maximum. Count a source when `(P−B) ≥ 12/255` in linear light **and** `P ≥ 1.6·B`. Immune to global exposure shifts, which is exactly what a fade-vs-brightness discriminator needs.
- **M2 — Contrast / tail shape.** (a) RMS contrast `σ(L)/mean(L)`; (b) `P99.9(L) − P50(L)`; (c) log-slope of the upper-1% histogram tail; (d) hard-clip census, count of `L ≥ 250/255`. A *faded* field: low (a), low (b), same mean. A *blobby* field: high (d), collapsed (c). **(c)+(d) separate the two symptoms.**
- **M2e — Sky-floor luminance.** Minimum sky luminance over the star-field region. The single most direct discriminator for any veil/pedestal mechanism, and near-free to compute.
- **M3 — Chroma.** Over M1-detected pixels: median HSV saturation and hue IQR. The fork already computes per-star blackbody RGB from B−V, so a monochrome field is a defect. Catalogue B−V spans ~−0.3 to +1.8, so a correct field is visibly bimodal in hue.
- **M4 — Radial falloff profile.** Azimuthally-averaged `I(r)` in linear light to r=40 px on the brightest source. Report `r_core` (HWHM), `r_1e-2`, `r_1e-3`, the ratio `r_1e-3/r_core`, and piecewise log-log slopes over `[2r_core, 5r_core]` and `[5r_core, 15r_core]`. **Discriminator: a Gaussian's slope steepens without bound (`s(r) = −2kr²`), so a blob shows `|s_outer| ≫ |s_inner|` plus a cliff; a power-law PSF has two *agreeing* slopes.**
- **M5 — Magnitude fidelity.** Cross-match M1 detections to catalogue Vmag by screen position (the existing probe already reproduces RA/Dec→TEME→fixed on the CPU, `probe-starfield-webgl-parity.mjs:145-165`). Report Spearman rank correlation, the fitted `log(peak)` vs `log(flux)` exponent, and the brightest:faintest rendered peak ratio.
- **M6 — Source-of-density split.** Run M1 **twice** — once with `skyBox.show=false` (catalogue only) and once with `skyBox.starField.show=false` (cubemap only) — or a cubemap regression is masked by the catalogue and vice versa. Both toggles already exist in the probe.

**M4 prerequisite (NEEDS-DESIGN):** an 8-bit canvas readback cannot measure a profile to 1e-3 of peak — the halo is exactly the part the current capture throws away. Requires a **3-stop exposure bracket** (1×/8×/64×, stitching the unclipped region of each, discarding `≥250/255`), which raises usable range to ~5 decades with no engine change. `scene.postProcessStages.exposure` is a public setter (`PostProcessStageCollection.js:377-381`) but takes effect **only on the HDR path**, so the bracketed scene must set `highDynamicRange = true` and record that in the manifest.

### Gates

**G1 — Skybox fade (C11-176).** Pinned clock, camera **on the sunlit side with the Sun ≥ 25° above local horizon** (the only framing that reaches the §1 failure state), globe/sun/moon/skyAtmosphere/fog off, ≥30 settle frames, run three ways per M6. **PASS requires all of:** M1 count ratio WebGPU/WebGL ≥ 0.90; M2a RMS-contrast ratio ∈ [0.85, 1.15]; M2b P99.9−P50 ratio ∈ [0.85, 1.15]; M3 median chroma ≥ 0.85× WebGL. **Additionally**, log `frameState.skyBrightness` and the derived `factor` in the manifest. **Mean luminance is reported as diagnostic only and is explicitly marked non-certifying.**

*Clock hygiene:* pin the JulianDate. An unpinned two-launch capture speckles the whole sky with false mismatch (documented: 6600 px → 102 px when pinned).

**G2 — White blobs (C11-177).** As G1 but `highDynamicRange = true`, 1920×1080, catalogue-only, with the exposure bracket. **PASS requires all of:** (1) `r_core ≤ 1.5 px`; (2) **`r_1e-3 / r_core ≥ 8`** — a Gaussian truncated at `d=1.0` cannot exceed ~1.8, so this single number separates blob from star; (3) the two M4 slopes agree within 0.8 and both lie in [−5, −2]; (4) fewer than 25 pixels at `L ≥ 250/255` per star at 1× exposure; (5) M5 Spearman ≥ 0.95 **and** rendered brightest:faintest peak ratio ≥ 15:1 (today it is 4:1 by construction). **Both backends must pass identically** — this is shared code.

**G3 — Asset upgrade (C11-178).** Cubemap-only, both backends. **PASS:** (1) angular sampling ≤ 2.0 arcmin/px (≥ 2700 px/face; 4096 recommended); (2) M1 sources per steradian ≥ 10× the tycho2t3 baseline; (3) M3 median chroma ≥ 0.20 — which fails immediately under 4:2:0 JPEG and so doubles as the format gate; (4) **dust-lane structure**: low-pass a Milky-Way-centred crop (σ≈16 px) to remove point sources, then require the IQR of the residual **diffuse** background ≥ 3× the current asset's. Dust lanes are large-scale *negative* structure in the diffuse component; no point-source metric can see them. The σ and 3× need one calibration pass against the chosen asset.

**G4 — Sun/Moon (C11-179).** Sun reuses M4 unchanged (its glow is `exp(-dist²·8.0)` and its disc `smoothstep(0.9,0.85,dist)` — same Gaussian-plus-hard-edge family). **PASS:** (1) `r_1e-3/r_core ≥ 10` (higher than stars — the brightest source has the widest halo); (2) constant-slope wing per G2(3); (3) rendered angular diameter within 5% of 0.5334° at 1 AU; (4) limb darkening measurable: `I(0.95R)/I(0)` ∈ [0.3, 0.5]. Moon: gate the **phase curve**, not a single frame — render full and quarter and require the integrated-brightness ratio to exceed the Lambertian prediction (~3:1); real lunar photometry with opposition surge gives closer to 10:1. A single image cannot distinguish Lambertian from Hapke; the ratio can.

**Provenance:** every gate run emits the 14-field manifest from `Tools/visual-regression/lib/visual-gate-policy.mjs:9-24` so a PASS is attributable to a commit *and an adapter* — cross-ref **C11-175**, which exists precisely because Chrome can silently hand WebGPU a weaker adapter than WebGL.

---

## 6. CAMPAIGN 12 PROPOSAL

### Theme

> **Celestial appearance: from "present" to "photographic."** Close the last default-ON WebGPU-only celestial divergences, replace flat-disc point-source rendering with a physically-motivated glare PSF on both backends, upgrade the star map within the licence we already hold, and make the Sun and Moon photometrically honest.

Two things bound the campaign: **(a)** everything shader-side lands on **both** backends (Principle 5) — the blob is shared code; **(b)** no asset enters the repo whose licence is not stated exactly and verified public-domain or permissive-attribution.

### Split: what belongs in C11's tail vs C12

**C11 TAIL — cheap parity fixes, land now, do not wait for a wave.** These are one-line defaults and comment corrections with an already-queued P1 home (`C11-176` is explicitly marked *promotable*).

| ID | Item | Effort | Dep |
|---|---|---|---|
| **C11-176** *(re-scoped)* | `enableStarBrightnessModulation: true → false` at `AtmosphericConditions.js:368`; reconcile the `0.3/4.0` vs `0.5/1.0` curve-default disagreement; resolve or document `enableNightSkyDimming` (no consumers). **Strike suspects 1–5 from the row** and record the disproofs. | **S** | Probe extension below |
| **C11-176a** | Extend `probe-env-skybox-stars.mjs`: add a **sunlit-side** camera, wire the already-computed-then-discarded `brightPct`, assert on the default (starField-ON) pair not just cubemap-vs-cubemap, and add M1/M2/M2e. **Run it at HEAD first** — if it is already red, it localizes the bug and no new probe reasoning is needed. | **S** | — |
| **C11-176b** | Moon `phaseGate` deletion (`Moon.wgsl:345-346`) — the same class of default-ON WebGPU-only divergence, with `enableMoonPhase` defaulting true and no GLSL consumer. Requires re-baselining the Batch-517 crescent probe. | **XS** + re-baseline | — |
| **C11-176c** | Comment/doc corrections: the four stale HDR-premise comments; `StarField.js:63` (0.34°→0.2406°) and `:69-71`; `SkyBox.js:49-51` "inert no-op on WebGL"; the superseded AE premise header in `diag-stars-hdr-autoexposure.mjs`; `LICENSE.md:1042` dead links. | **XS** | — |
| **C11-SEED-07** | Fold into C11-179 (duplicate scope). | **XS** | — |

**C12 — real feature work.** Everything below.

### Waves

**W1 — Foundation and measurement** *(nothing visual ships; everything after depends on it)*

| ID | Item | Effort | Deps |
|---|---|---|---|
| C12-01 | **Celestial gate harness.** Implement M1/M2/M2e/M3/M6 on the existing probe scene; emit the 14-field manifest; establish WebGL+WebGPU baselines for all four gates. | M | C11-176a |
| C12-02 | **Exposure-bracket capture** (1×/8×/64× stitch) enabling M4/M5. Needed by every PSF gate. | M | C12-01 |
| C12-03 | **Adapter provenance in celestial runs** — consume C11-175's `adapter.info` logging so a PASS records which physical GPU produced it. | XS | **C11-175** |
| C12-04 | **Sequencing audit** against `C11-79` / `C11-80` (starfield single-submission retains star commands). Confirm C12's renderer edits do not conflict. | XS | **C11-80 landed** |

**W2 — Bright-star appearance model (the "white blobs" fix)** *(shader + data only; no framebuffer risk)*

| ID | Item | Effort | Deps |
|---|---|---|---|
| C12-05 | **Moffat core+wing PSF**, paired WGSL (`StarField.wgsl:140-149`) + GLSL (`StarFieldFS.glsl:18-28`). Includes the `smoothstep(1.0,0.45)` → `(1.0,0.92)` window change, without which the wing is inert. | S | C12-02 |
| C12-06 | **Quad enlargement** driven through the existing `sizeBoost` plumbing as **halo extent**, not core size; 1° total glare-diameter clamp. ~80 sprites, so fill cost is negligible. | S | C12-05 |
| C12-07 | **Amplitude restructure** — stop the core saturating over half the sprite; chroma-preserving output split (core may clip white, halo stays below 1.0 and keeps blackbody hue). **This is the increment that actually kills the blob** and it needs no HDR. | S | C12-05 |
| C12-08 | **Dynamic-range restoration** — remove baked `FLUX_GAMMA`, keep flux linear, move compression into an explicit exposure term. | M | C12-07 |
| C12-09 | **Catalogue depth** — extend `BrightStarCatalog.js` toward mag ~5.5 (BSC5, public domain). **Do this last in the wave**: before C12-05..08 it just adds more blobs. Note the full 9,110-entry BSC5 is **not** vendored — this is a data ingest. | M | C12-08, **C12-11** (cutoff reconciliation) |
| **Gate** | **G2** must pass on both backends. | | |

**W3 — Star-map asset** *(licence-gated; can run parallel to W2 after Q1 is answered)*

| ID | Item | Effort | Deps |
|---|---|---|---|
| C12-10 | **Offline bake pipeline**, checked in: SVS `TychoSkymapII.t5_16384x08192` equirect → gamma-1.8→sRGB correction → six cube faces at 4096 → KTX2/BC6H. Reproducible, not another hand-edited Paint.NET downsample. | L | **Q1 answered** |
| C12-11 | **Seam reconciliation** — set the cubemap's bright-star handling and `MAG_CUTOFF` to a single agreed magnitude so the t5 threshold-5.0 boost does not double-draw against the sprite pass. **Blocking for C12-09.** | M | C12-10 |
| C12-12 | **VRAM/streaming policy** — 2048/face default, 4096 opt-in, KTX2 compressed. `SkyBox.js` already takes arbitrary sources, so no API change. | S | C12-10 |
| C12-13 | **LICENSE.md refresh** — live SVS URLs, exact product name ("Tycho Catalog Skymap – Version 2.0", variant t5), verbatim credit line, current NASA terms URL. | XS | C12-10 |
| C12-14 | *(opportunistic)* Expose the baked cubemap as a **samplable star texture**, discharging the `C11-163` S3 blocker. | S on top of C12-10 | C12-10 |
| **Gate** | **G3**, both backends. | | |

**W4 — Sun** *(depends on the already-queued PP wiring)*

| ID | Item | Effort | Deps |
|---|---|---|---|
| C12-15 | **Limb darkening** in both bakes (a₀=0.3, a₁=0.93, a₂=−0.23). Start from the existing prototype in the unreferenced `Environment/Sun.wgsl:92-114`. | S | — |
| C12-16 | **Inverse-square glare falloff** replacing `1-smoothstep(0,0.55,r)` in both bakes. | S | — |
| C12-17 | **WebGPU sun-texture format + size parity** — honour `useHdr` (rgba16float) and derive size from the drawing buffer as WebGL does; needs a Float16/32 bake variant since the current bake writes `Uint8Array`. | S–M | — |
| C12-18 | **Reconcile bake vs screen-space halo** once **C11-160** lands: the disc at true 0.53°, all halo from the PP chain. Decide whether the baked glow is then removed or reduced to an AA skirt. | M | **C11-160**, **C11-115** |
| C12-19 | **True HDR sun radiance** — remove the `clamp(...,0,1)` at `SunTextureFS.glsl:54` and the 255-clamp at `WebGPUEnvironmentRenderer.js:280-283`, retune BrightPass thresholds. **Must be probed against both AE-on and AE-off lanes** — introducing ~10⁵ energy without that re-creates the inverse of the Batch-364 failure (the sun crushes everything else). | **L** | C12-17, C12-18, **C11-161** |
| **Gate** | **G4** sun half. | | |

**W5 — Moon**

| ID | Item | Effort | Deps |
|---|---|---|---|
| C12-20 | Lommel-Seeliger reflectance (M1). | XS | — |
| C12-21 | Phase-dependent earthshine (M2). | XS | C11-176b |
| C12-22 | Soft terminator from the Sun's finite disc (M4). | XS | C11-176b |
| C12-23 | Opposition surge as a CPU-computed scalar uniform (M5). | S | C12-20 |
| C12-24 | NASA CGI Moon Kit albedo swap, 1k or 2k (M6). **Re-opens `C4-CELESTIAL-HIRES-MOON` on corrected premises** — drop its altitude-blend half. | S | — |
| C12-25 | LOLA-derived normal map + offline derivation step (M7). | M | C12-24 |
| **Gate** | **G4** moon half (phase-ratio harness). | | |

**W6 — Adjacent, file-don't-fold**

| ID | Item | Effort | Deps |
|---|---|---|---|
| C12-26 | **NEW-EARTH-LIMB-AIRGLOW-EMISSION.** The green band in reference 1 is O I 557.7 nm nightglow (layer peaking ~90–105 km, second peak 140–180 km); the red-orange band above is O I 630.0 nm from the F region. These are **emissive and sun-independent**. `SkyAtmosphere` is a *scattering* model whose `nightAlpha` drives the shell toward zero opacity on the dark side — **there is no code path in which it could produce a limb band at night.** This is a new emissive limb shell, and `CELESTIAL_ATMOSPHERE_DESIGN.md:1904-1907` already names airglow as what the flat `nightAmbient = 0.025` floor is standing in for. **File as its own row; do NOT expand C11-176..179 to cover it.** | M–L | — |

### Exit gate

C12 closes when **all four gates (G1–G4) pass on both backends at HEAD**, with:

1. Every G1–G4 manifest attributable to a commit **and** a recorded adapter pairing (C12-03 / C11-175).
2. Zero default-ON WebGPU-only celestial multipliers remaining. Concretely, an audit asserting that for every celestial uniform gate (`enableStarBrightnessModulation`, cloud-cover occlusion, `enableMoonPhase`, `enableEarthshine`, `enableNightSkyDimming`) either a GLSL consumer exists **or** the default is off. This is the *class* of bug §1 found, and the exit gate should close the class, not the instance.
3. `FEATURE_INVENTORY.md` updated — celestial WIP entries in §C moved to §B; the airglow row added to §D.
4. `LICENSE.md` third-party asset attributions current, with live URLs and exact credit strings.
5. No new `ShaderDefine` bits consumed — the registry is exhausted (bit 31 already folded at three call sites), so any C12 quality toggle uses a **runtime uniform float**, matching the pattern `C11-163` research already mandates.

---

## 7. Open questions for the maintainer

Only the four where the answer changes what gets built.

**Q1 — Gaia-derived NASA imagery: acceptable or disqualified?** *(blocks C12-10's source choice, and therefore all of W3)*
ESA states verbatim that Gaia data are distributed under **CC BY-NC 3.0 IGO** (verified). NASA's SVS 4851 "Deep Star Maps 2020" — technically the best available asset — has Gaia DR2 in two of its three layers and NASA redistributes the result as public domain without marking it third-party-copyrighted. My recommendation is to **not** rely on that and to take the SVS 3572 **t5** path instead, which is same-product, same-attribution, already covered by `LICENSE.md:1042`, and directly delivers the dense Milky Way you asked for. But if you want the 4851 quality, this is a legal call I will not make for you. **Default if you don't answer: t5.**

**Q2 — Where exactly did you observe the fade?** *(determines whether §1 is the whole answer or only part)*
The mechanism I found only fires when the Sun is above the camera's local horizon — 50% dim at ≥ ~24° elevation, zero dim at night. If your WebGL-vs-WebGPU comparison was on the **night side**, this bug contributed nothing and the fade is something else. A saved-view URL or a rough description (day side / night side / terminator; altitude) makes the difference between a one-line fix and a continued hunt. The probe in C11-176a can settle it either way, but knowing your framing saves a cycle.

**Q3 — HDR default: hold at off, or flip for celestial scenes?** *(determines whether C12-07 is the destination or a stepping stone)*
`highDynamicRange` is false by default on both backends, which is why every bright star clips to an 8-bit plateau. The chroma-preserving profile (C12-07) fixes the blob **without** HDR and is my recommended first increment. But the *physically correct* end state — halo from real HDR energy through bloom — needs HDR on, which also engages PBR Neutral's highlight compression and has a broad parity blast radius across the whole PP chain. **Is a per-scene / celestial-scene HDR opt-in acceptable, or must the default SDR path look right on its own?**

**Q4 — Star-map / sprite seam magnitude.** *(blocks C12-09 and C12-11)*
Moving to t5 (threshold magnitude 5.0) makes the cubemap much denser and *widens* the double-draw overlap with the sprite pass (currently mag ≤ 2.5 drawn twice). The clean fix is one agreed hand-off magnitude: texture carries strictly fainter-than-M, sprites carry strictly brighter-than-M. That means either (a) baking a bright-star-free cubemap, which requires custom rendering rather than using an SVS product as-shipped, or (b) accepting a small overlap and compensating in the sprite intensities. **(a)** is more work but is the architecturally correct answer and is what makes the "thousands of resolved stars" reference reachable. Which do you want?

---

### Files most worth reading first, if you want to check my work

- `packages/engine/Source/Scene/AtmosphericConditions.js:356-370` — the shipped defaults, including line 368
- `packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js:114-140` (shader) and `:527-556` (the gate + its contradicting comment)
- `packages/engine/Source/Scene/SkyBrightness.js:96-125` — what drives it
- `packages/engine/Source/Shaders/SkyBoxFS.glsl` — all 9 lines, showing WebGL has none of it
- `packages/engine/Source/Shaders/WebGPU/Catalog/StarField.wgsl:139-149` + `packages/engine/Source/Shaders/StarFieldFS.glsl:15-28` — the identical PSF
- `packages/engine/Source/Scene/StarFieldMath.ts:110-170` — the crushed magnitude mapping and `sizeBoost = 0.0`
- `packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl:184-196, 335-356` — Lambert + backwards earthshine + the default-ON phase gate
- `LICENSE.md:1038-1050` — the existing (correct, but link-rotted) NASA skybox attribution
