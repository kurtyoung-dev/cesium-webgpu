# three.js / WebGPU-Ecosystem Technique Mine — Fork-Actionable Candidate Register

**Date:** 2026-07-05
**Scope:** Synthesis of six research angles (Takram three-geospatial deep-mine, three.js post-FX ecosystem, frontier GI+AA, WebGPU/TSL+compute, water/terrain/atmosphere, notable forks) into a deduped, license-checked, fork-actionable register for the CesiumJS WebGPU fork.
**Method:** Every angle was pre-verified against a primary source (repo/paper/shader), not demo claims. This synthesis additionally **spot-checked the fork's own tree** to correct two mislabeled "novel" claims (see below). READ-ONLY; nothing written to the repo.

---

## Repo spot-checks that overturned research claims

| Research claim | Reality in our tree | Verdict |
|---|---|---|
| "We lack a ghost/halo lens flare" (Takram + three.js angles) | `Shaders/WebGPU/PostProcess/LensFlare.wgsl` + `LensFlare.glsl` — 4-ghost chromatic-distorted chain + halo + earth-disk masking, WGSL/GLSL parity twins | **DEDUP.** We ship it. Only gap: `dirtTexture` overlay + `starTexture` burst modulation unimplemented → minor watch item, not a new effect. |
| "We lack cloud turbulence / curl domain-warp" (Takram #1) | `ProceduralClouds.wgsl` Batch 439 (4.7 CLOUD-CURL): analytic curl-of-value-noise-potential domain warp on the detail sample, `curlAmplitude`/`curlFrequency` uniforms | **DEDUP (mostly).** We warp *detail* by analytic curl; Takram warps *both shape+detail* via a baked 3D vector texture. Minor delta → watch. |
| "We lack SSGI / dynamic diffuse GI" | `grep ssgi\|indirect.?diffuse` → no files | **CONFIRMED NOVEL.** |
| "Our cloud upscale isn't 1/16 STBN + variance clip" | `CloudUpscale.wgsl` — no STBN/variance/checkerboard | **CONFIRMED NOVEL refinement** (we do half-res temporal, not 1/16 STBN). |
| "No temporal super-resolution / FSR" | `grep FSR\|upscal\|super.?resolution` → cloud-only, no camera-resolution upscaler | **CONFIRMED NOVEL.** |
| "WebGPUSubgroupUtils scaffolded-but-unwired" | `WebGPUSubgroupUtils.ts` exists; no production kernel calls it | **CONFIRMED — scaffolding to finish.** |

---

## Honest read on the Takram deep-mine

The Takram three-geospatial mine is **MIT across all packages**, so anything it ships is portable-permissive. But after deduping against our shipped 10 (Bruneton 4-LUT, aerial-perspective froxel, derived+IBL lighting, full volumetric clouds, star catalog, sun/moon, god-rays, multi-body) **and** against our tree, most of its headline items collapse to refinements, and **two of its "we-lack-this" claims were simply wrong** (lens flare, curl warp — both already shipped). What genuinely survives from Takram is a cluster of **small, physically-motivated LUT/shader refinements** (higher-order-scattering LUT, full-RGB Mie LUT, fitted-Mie phase, `correctGeometricError`, TPDF dither) plus a couple of cloud-temporal perf ideas (STBN 1/16 TAAU, BSM temporal resolve, in-march shadow-length). None are big; several are 0.5–1 day and fork-relevant. The single most fork-tailored Takram item is **`correctGeometricError`** — it fixes exactly the coarse-tile horizon inaccuracy we keep hitting on L0/L1 globe tiles.

The genuinely *large* net-new capabilities come from the **other** angles: **FFT ocean** (water is deferred-by-design; zero ocean today), **FSR2 upscaling** (biggest perf lever, orthogonal to our same-res TAA), **SSGI** (only dynamic diffuse bounce we could add), **flow-field advection** (Windy/nullschool-class data-viz layer we lack), **meshlet virtualized geometry**, and **LTC area lights**.

---

## Candidate register (surviving, non-deduped)

Derivability legend: **P** = portable-permissive (MIT/BSD/Apache/CC0/ISC/Zlib — may port source) · **D** = derive-technique-only (paper/GPL/proprietary/unlicensed — reimplement fresh + cite) · **B** = blocked/unclear.

### A. Perf / GI / architecture

| # | Candidate | Source · License | Deriv | What it does · fork applicability | Parity-safe increment (opt-in, default-off) | Priority |
|---|---|---|---|---|---|---|
| 1 | **SSGI — screen-space diffuse GI** | three.js `SSGINode` (TSL/WebGPU) + 0beqz/realism-effects · MIT | P | Single-bounce indirect diffuse + AO purely from color/normal/depth MRT, temporally reprojected. We have GTAO (darkening) + static SH/specular IBL but **no dynamic color bleed**. Rides the exact MRT+TAA-history we already produce; survives planet-scale/RTE because it's screen-space. | New WebGPU post-process feature-renderer + WGSL horizon marcher, reusing depth/normal/color MRT and TAA reprojection. Off by default; gate behind a scene flag. | **high** |
| 2 | **FSR2 temporal super-resolution** | GPUOpen FSR2 (HLSL) · MIT | P | Render at 0.5–0.67× internal res, reconstruct full-res via motion-vectors + depth + history with lock/reactive masks. **Different goal from our TAA** (which is same-res AA, never lowers resolution). Globe is fill-rate bound (atmosphere LUTs, cloud march, froxel, PP stack) → single biggest perf lever. We already emit the two hard inputs (MRT motion vectors + depth). | New upscale pass + render-target resize plumbing + reactive/lock masks, reusing TAA history. Ship as an opt-in `resolutionScale<1` path; default 1.0 = today's behavior. | **high** |
| 3 | **Velocity-buffer motion blur** | 0beqz/realism-effects `MotionBlur` · MIT | P | Per-object+camera blur by sampling color along per-pixel velocity from the same MRT velocity we generate for TAA. Near-pure reuse of an existing buffer. | One WGSL full-screen pass + tile-max/neighbor-max dilation reading the existing velocity texture. Default off. | medium |
| 4 | **Radiance Cascades (screen-probe GI)** | three-rc (ref) · **no license**; technique freely published (radiance.wiki, Sannikov, arXiv 2505.02041 HRC) | D | Noiseless cascaded radiance-probe GI (no temporal denoise) — attractive for our `requestRenderMode` on-demand globe where TAA-style accumulation stalls. Only the **screen-space-probe** slice maps; the BVH/world-space half does **not** scale to streamed planet geometry. Reference code is unlicensed → reimplement from the paper. HRC (2025) is the SotA probe-structure fix to fold in if pursued. | Research prototype first: probe-cascade compute passes + reconstruction WGSL from the paper. High-quality alternative to SSGI if SSGI proves too noisy. | watch |
| 5 | **Subgroup-accelerated compute (finish `WebGPUSubgroupUtils`)** | gpuweb subgroups proposal · spec | D | `subgroupAdd/Ballot/Broadcast/Shuffle` for prefix-scan stream-compaction without shared-memory+barriers. We detect the capability and **built the utils class but never wired it** (flagged dead in ULTRA_REVIEW); the shared-mem cull path has a documented slot-255 off-by-one. Wiring subgroups into the point-cloud culler compaction + bitonic-sort bucket-scan speeds both and retires the buggy manual writeback (Principle 7/9 — finish scaffolding). | Add a subgroup-path variant to the existing culler + sort scan behind the already-detected capability flag; shared-memory path stays as fallback. | medium |
| 6 | **TSL-style dual-codegen node-graph shader IR** | three.js `src/nodes/*` (TSL) · MIT | P | Compose a shader node graph once, lower to **both** WGSL and GLSL at compile time. Directly attacks our biggest maintenance tax: hand-maintained WGSL/GLSL **lockstep pairs** (`SHADER_PAIRS_LOCKSTEP.md` + `IMAGERY_PROJECTION.md` drift rules — both dirty in the tree right now). Kills an entire class of parity-drift bugs. Must model our RTE 64-bit convention (`positionHigh/Low`, `mvpRelativeToEye`) as first-class nodes — three.js assumes single-precision vec3. Adopt the IR/lowering **architecture**, not the material library. | Large (multi-week). Pilot on ONE subsystem (imagery FS) behind a build flag; keep existing hand-written pairs until the pilot proves byte-parity. | watch (strategic) |
| 7 | **Node-based post-process graph** | three.js `PostProcessing` + `pass()`/`mrt()` nodes · MIT | P | Data-driven PP composition: `pass()`/`getTexture('depth')`/`setMRT()` expose G-buffer channels as graph inputs; effects chain by node composition; intermediate targets auto-managed. Our PP suite is comprehensive but wiring/order/target-alloc is static code. Adds a user-effect authoring surface. Best done *with* #6 (shares the node builder). | Medium-large; overlaps #6. Not a new effect — a composition layer. Keep static path as default. | low |
| 8 | **GPU-compute general particle system** | three.js `webgpu_compute_particles` · MIT | P | Fully GPU-resident emit→update→compact ping-pong with atomic free-list; 1M+ particles, CPU never touches per-particle state. Upstream Cesium `Scene.ParticleSystem` is **CPU-driven** (per-particle JS + re-upload). We already proved the pattern in `WeatherParticles.wgsl`. Generalize it to back the public ParticleSystem API. | Reuse WeatherParticles pass structure + atomic free-list compaction; new WebGPU feature-renderer behind the existing API, CPU path as WebGL fallback. | medium |
| 9 | **LTC analytic area lights** | PlayCanvas engine chunks · MIT; Heitz et al. 2016 paper + LUTs | P | Linearly-Transformed-Cosines: rect/disk area lights shaded analytically (no shadow-map, no noise) via a 2-LUT BRDF fit + polygon edge integral; supports textured emitters. Slots into our clustered forward light loop alongside point/spot/CSM. We ship only punctual/directional lights — **no area lights**. Great for building windows/signage/skylights on 3D-Tiles/glTF PBR. | Embed the two LTC LUTs, add WGSL edge-integral eval, extend the clustered light struct with a rect/disk type. Port MIT chunks or derive from the paper. | medium |

### B. Clouds / atmosphere / sky refinements (all Takram three-geospatial, MIT)

| # | Candidate | Deriv | What it does · fork applicability | Increment | Priority |
|---|---|---|---|---|---|
| 10 | **`correctGeometricError` in the aerial-perspective pass** | P | Snaps reconstructed world-position back onto the analytic ellipsoid to compensate the chordal sag of coarse LOD tiles (tessellated surface sits *below* true ellipsoid), fixing horizon-band inscatter color error. **Most fork-tailored Takram item** — we render coarse L0/L1 tiles and keep hitting horizon artifacts there. | Add ellipsoid-snap of reconstructed position in the aerial-perspective WGSL + toggle. ~1 day. | **high** |
| 11 | **Higher-order-scattering LUT (N≥2)** | P | Extra precomputed table storing N≥2 multiple-scattering separately so shadowed segments (behind terrain/clouds) still receive multi-scattered skylight instead of going black. Refines our Bruneton 4-LUT. | Extend the precompute compute pass + conditional sample in the scattering lookup. ~1 day. | med-high |
| 12 | **Full-RGB single-Mie scattering LUT** | P | Store real RGB single-Mie instead of Bruneton's packed-Mie-red reconstruction → fixes sunset/high-turbidity/low-sun hue error. | Extra precompute target + sampler branch, toggle-gated (default stays 4-LUT-compact). ~0.5–1 day. | medium |
| 13 | **Numerically-fitted Mie phase (d=10μm)** | P | `accuratePhaseFunction` swaps dual-lobe HG for a fitted-Mie eval reproducing the sharp forward peak + fogbow/glory side-lobes HG can't. Drop-in in the cloud scattering integrator. | Port the fitted-Mie WGSL fn + uniform toggle. ~0.5 day. | medium |
| 14 | **STBN 1/16 TAAU cloud upscale + variance clipping** | P | Ray-march only 1/16 of texels per frame (4×4 STBN checkerboard), reconstruct full-res via temporal reproject with NVIDIA-style neighborhood variance clip. Confirmed absent (our `CloudUpscale.wgsl` is half-res, no STBN/variance). Big march-count cut; slots into our TAA infra. | STBN texture + per-frame sample-mask schedule + variance-clip in the cloud resolve WGSL. ~1–2 days. Default to current half-res. | medium |
| 15 | **Beer-Shadow-Map temporal resolve** | P | TAA on the BSM itself (not just the beauty pass) to suppress aliasing high-freq cloud detail injects into the sun-orthographic optical-depth map before self-shadow readback. | One extra temporal-accumulate pass over the BSM texture. ~0.5 day. | low |
| 16 | **In-march shadow-length secondary ray (in-volume shafts)** | P | Secondary short march toward sun+ground during the cloud march accumulates a "shadow length" the atmosphere pass consumes → **physically-integrated** volumetric crepuscular rays through/under clouds (vs our screen-space god-rays). | Add shadow-length accumulation to the cloud march + read it in the atmosphere composite. ~1–2 days. | medium |
| 17 | **Analytic exponential-height haze layer under clouds** | P | Cheap non-marched exp-height fog term filling the low-altitude band the volumetric march skips, seating clouds into a hazy horizon. Distinct from Bruneton aerial perspective. | A few uniforms + analytic term in the cloud composite. ~0.5 day. | low |
| 18 | **Deferred-Lambertian scene lighting in the aerial pass + LightingMask** | P | Treat color buffer as albedo, light whole scene with sun transmittance + sky irradiance via an oct-encoded-normal G-buffer, applying atmospheric attenuation in the same pass; a mask keeps PBR models on the per-light path. Architectural — could cheapen how we apply atmosphere-derived lighting to terrain. | Needs an oct-normal G-buffer + mask pass. ~2–3 days; more architectural than a shader tweak. | low |
| 19 | **Per-star chromaticity + J2000 ECI→ECEF star rotation** | P | Stars carry real B-V-derived color (not white/intensity) and sit at astronomically-correct positions via a time-varying ECI→ECEF rotation. Refines our Yale-BSC starfield. | Fold B-V chromaticity into the star buffer + apply an ECI→ECEF rotation uniform. ~0.5–1 day. | low |
| 20 | **TPDF / blue-noise dithering final pass** | P | Triangular-PDF (or blue-noise) dither before 8-bit quantization to kill visible banding in smooth sky/atmosphere/fog gradients. We have no dedicated dithering pass; note `csm_stochasticDither` is CSM-only. Very relevant given our large smooth atmosphere gradients. | One WGSL line of TPDF/blue-noise in the final composite. ~2–4 hours. Highest value/effort ratio here. | **SHIPPED (C6-TPDF-DITHER-FINAL)** — TPDF dither added to the tonemap stage (`Tonemapping.wgsl`/`_f16`), opt-in `scene.ditherEnabled` (default-off byte-identical). Effective in the HDR post-process pipeline (rgba16float intermediates). SDR-path banding (8-bit scene FB, baked pre-post-process) is a tracked follow-up — see DEFERRED_WORK `C6-TPDF-DITHER-SDR-PATH`. |

### C. Water (deferred-by-design today — zero ocean surface shipped; these are RE-SCOPE candidates)

| # | Candidate | Source · License | Deriv | What it does · fork applicability | Increment | Priority |
|---|---|---|---|---|---|---|
| 21 | **FFT spectral ocean (Tessendorf)** | BarthPaleologue/WebTide (WGSL compute) · MIT; Tessendorf 2004 course notes (derive) | P | GPU compute FFT ocean: Phillips + JONSWAP spectra → IFFT to height+horizontal-displacement fields, Jacobian-fold foam mask, PBR ocean + sun specular, **spherical triplanar** to wrap onto a globe. Closes FEAT-SURVEY-41 / WATER §4.3 entirely. Main effort = re-host off BabylonJS onto a Cesium globe-patch + RTE-ize positions. | Port ~3–4 compute passes (spectrum init, time-evolve, IFFT butterfly, normal/foam) + a displacement VS hook + wind-speed uniform + an ocean surface primitive with planar-patch tiling. Large (several days). Opt-in ocean layer. | **high** (strategic) |
| 22 | **Planar reflection / refraction (Reflector/Refractor/Water/Water2)** | three.js addons · MIT | P | Mirror/water/glass via a reflected virtual camera + oblique near-plane clip, projective sampling — captures off-screen geometry SSR can't; Water2 adds flow-map river advection (closes WATER §4.1.1). Complements our SSR (screen-space, edge-limited) for flat water/glass/wet surfaces. | Extra reflection render pass + oblique clip matrix + water/glass material; Water2 flow-map adds ~1 day on top. Medium. Default off. | medium |
| 23 | **Gerstner / trochoidal waves** | GPU Gems Ch.1 (Finch) · paper | D | Sum-of-Gerstner directional waves with closed-form analytic normals — cheap, deterministic, controllable. Ideal low-risk **first** water increment and a far-field/LOD tier below FFT (#21). | Vertex-displacement WGSL fn + analytic normal. ~0.5–1 day. | medium |
| 24 | **Screen-space refraction (depth-perturbation)** | 3D Game Shaders for Beginners · BSD-3 (technique public) | D | Refract view ray at surface, march refracted vector against scene depth, sample scene color at the hit, apply Beer-Lambert absorption + deep-water tint. Closes FEAT-GAP-04 (refraction) reusing the Hi-Z/scene-depth/scene-color targets we already maintain for SSR. | A refraction-march variant of our SSR pass + Beer-Lambert tint. ~1 day. Default off. | medium |

### D. Terrain / geometry LOD

| # | Candidate | Source · License | Deriv | What it does · fork applicability | Increment | Priority |
|---|---|---|---|---|---|---|
| 25 | **Meshlet virtualized geometry (Nanite-style)** | Scthe/nanite-webgpu · MIT (deps meshoptimizer MIT + METIS Apache-2.0) | P | Full browser Nanite: WASM-built meshlet LOD DAG (meshoptimizer clusters + METIS partition), per-cluster error → continuous LOD, compute **software rasterizer** for sub-pixel triangles (packs to 32-bit atomics — documented WebGPU no-atomic<u64> workaround), 2-pass HZB per-instance+per-meshlet cull, billboard impostors. For 3D-Tiles/massive-glTF, a categorically higher LOD tier than screen-space-error tile swaps; composes with our GPU cull/Hi-Z/sort. | Very large / research-tier (multi-day→multi-week): offline DAG builder + visbuffer + SW raster + impostor baker. Strategic experimental 3D-Tiles pipeline stage; MIT source is a near-complete reference. | watch (strategic) |
| 26 | **CDLOD geomorph (anti-popping)** | fstrugar/CDLOD (perm.) + paper; felixpalmer/lod-terrain (ref) · derive | D | VS-side morph factor blends each vertex toward its lower-LOD parent across the transition band → **invisible LOD transitions + crack-free** with no CPU stitching. We have quadtree tile LOD but discrete swaps; this is the smooth-geomorph half we lack. Small, well-specified upgrade to code we own. | Per-tile morph-range uniform + compute morph factor from camera distance in the terrain VS + lerp position/UV toward parent-grid sample. Small. Derive from paper. | medium |
| 27 | **Compute terrain-tile synthesis (Proland-style)** | Proland (Bruneton/Neyret) · BSD-3 (TerrainView7 itself closed → derive from Proland) | D | GPU compute tile producer (height/normal/color) into a quadtree-keyed 2D-array atlas, replacing CPU decode/upload; enables procedural detail amplification between elevation LODs and cuts upload stalls. Our tiles are CPU-decoded today. | Compute tile-producer pass + quadtree-indexed array-atlas allocator + detail-amplification noise. Medium-large; verify against Proland's BSD source. | low |

### E. Geospatial data-viz & UX

| # | Candidate | Source · License | Deriv | What it does · fork applicability | Increment | Priority |
|---|---|---|---|---|---|---|
| 28 | **GPU flow-field particle advection (wind / currents)** | mapbox/webgl-wind · ISC; Cesium GPU-wind blog; hypatia-earth/zero · MIT | P | Encode N particle positions in a texture, ping-pong: sample a velocity field (u,v as a tile source, bilerp+temporal interp between forecast steps), advect, drop/respawn, accumulate fading trails. Extends to flow-lines + marching-squares isobars + advection-interpolation. Windy/earth.nullschool-class layer we **entirely lack**; velocity field is just another imagery tile source; Cesium's own blog documents the globe version. | One ping-pong compute/update pass over a particle-state texture + velocity-tile loader + trail-accumulate draw. Globe-specific piece: map lon/lat velocity to the particle tangent frame. Small–medium. | **high** |
| 29 | **Selection / edge outline post-effect** | pmndrs/postprocessing `OutlineEffect` · Zlib | P | Render selected objects to a mask, edge-detect, composite a depth/normal-aware glowing outline. Pairs with our pick framebuffer for highlight-picked-entity/feature/tile UX. We have picking but no selection-outline. | Mask render of picked ids (reuse pick id target) + edge WGSL pass. Small–medium. | low |

### F. Watch-tier (real gaps, low priority or mislabeled in source)

| # | Candidate | Source · License | Deriv | Note | Priority |
|---|---|---|---|---|---|
| 30 | **Nubis3 voxel cloud precompute** | Guerrilla/Schneider SIGGRAPH 2023 slides · proprietary (derive) | D | The frontier angle marked this `alreadyHaveEquivalent=true`, but its own `noveltyVsOurs` admits **we lack the precompute**. Separable compute pass bakes a 256×256×32 density voxel grid so the raymarch reads a cheap lookup → reported 30–40% cloud-cost cut + authored/voxel-modeled cloudscapes. Fits our WGSL compute + weatherTex system. Kept here (not deduped) because it's a real optimization gap. | One compute density-voxelization pass + a density-lookup path in the existing cloud raymarch. Medium. Derive from public slides (no code). | watch |
| 31 | **Hosek-Wilkie analytic clear-sky** | ebruneton/clear-sky-models `ArHosekSkyModel` · BSD-3 | P | Closed-form clear-sky radiance from sun-elevation+turbidity+albedo, negligible cost. Our Bruneton+Hillaire path supersedes it for realism — value is only a **cheap CPU/GPU fallback tier** for low-end devices and a turbidity knob for artistic/exoplanet skies. | Port the BSD-3 coeff eval into a WGSL fragment path. ~0.5 day. Low priority — atmosphere is saturated. | watch |
| 32 | **Holographic Radiance Cascades (HRC)** | arXiv 2505.02041 (2025) · paper | D | Not standalone-useful for a globe — it's the SotA **probe-structure fix** (penumbra fidelity, small apertures) to fold into an RC prototype **if** #4 is pursued. 1.85 ms @512² on a 3080 Laptop. | Modifier on an RC prototype, not independent work. | watch |

---

## Top recommendations (ranked)

1. **FSR2 temporal super-resolution** (#2, P, medium-large) — the single biggest perf lever for a fill-rate-bound globe; orthogonal to our same-res TAA and reuses the motion-vector + depth MRT we already emit. Ship as opt-in `resolutionScale<1`.
2. **SSGI — screen-space diffuse GI** (#1, P, medium) — the only dynamic indirect-diffuse/color-bleed we could add; rides existing depth/normal/color MRT + TAA history; survives planet-scale/RTE because it's screen-space. Highest *visual* payoff for models/tiles.
3. **FFT spectral ocean (WebTide/Tessendorf)** (#21, P, large) — closes the entire deferred WATER gap with a globe-ready spherical-triplanar reference; strategic, biggest net-new capability class.
4. **`correctGeometricError` aerial-perspective fix** (#10, P, ~1 day) — most fork-tailored Takram item; fixes the coarse-L0/L1-tile horizon inscatter error we keep hitting. Cheap, high relevance.
5. **GPU flow-field advection (wind/currents)** (#28, P, small-medium) — a Windy/nullschool-class data-viz layer we entirely lack; velocity field is just another imagery tile source; Cesium's own blog documents the globe version. Near-verbatim ISC port.
6. **TPDF / blue-noise dithering final pass** (#20, P, ~hours) — best value/effort ratio in the register; kills visible banding across our large smooth atmosphere/sky/fog gradients with one WGSL line.
7. **Higher-order-scattering LUT (N≥2)** (#11, P, ~1 day) — direct Bruneton 4-LUT refinement that stops shadowed terrain/eclipse/night-side segments going black.
8. **STBN 1/16 TAAU cloud upscale + variance clipping** (#14, P, 1–2 days) — confirmed-absent cloud-march perf cut that slots straight into our TAA infra.
9. **Planar reflection / refraction (three.js Reflector/Refractor/Water)** (#22, P, medium) — complements our SSR for flat water/glass where SSR fails at edges/grazing angles; also the vehicle for a first ocean surface.
10. **Velocity-buffer motion blur** (#3, P, low-medium) — near-pure reuse of the TAA motion-vector buffer; cheap new effect for fast camera moves / CZML playback.
11. **LTC analytic area lights** (#9, P, medium) — the missing light class (rect/disk/textured emitters) for 3D-Tiles/glTF PBR; two small LUTs + an edge-integral, slots into clustered forward.
12. **Finish subgroup-accelerated compute** (#5, D, medium) — Principle 7/9: wire the already-built `WebGPUSubgroupUtils` into the culler compaction + sort scan, retiring the slot-255 off-by-one. Perf + finishes scaffolding.

**Strategic watch (not top-12 but flagged for planning):** TSL dual-codegen node-graph IR (#6) — the only candidate that attacks our WGSL/GLSL **lockstep-pair maintenance tax** at the root (`SHADER_PAIRS_LOCKSTEP.md`/`IMAGERY_PROJECTION.md` are dirty in-tree right now); multi-week, pilot on imagery FS first. And meshlet virtualized geometry (#25) for a future 3D-Tiles LOD tier.

---

## License-blocked / non-portable

| Item | License reality | Disposition |
|---|---|---|
| **LYGIA shader library** | Prosperity License (non-commercial free / 30-day commercial trial) — **NOT MIT** despite WGSL variants | **Blocked for porting.** Do not vendor into our MIT repo. Reimplement individual algorithms fresh from their *original* public sources (many are standard). |
| **three-rc (Radiance Cascades reference)** | **No license** — author explicitly refuses to license | Code blocked; **RC technique itself is freely published** → derive-only (#4). |
| **webgiya (surfel GI)** | License unstated in repo/article | Blocked-or-unclear; also scene assumptions (static indoor, CPU-BVH, world-space surfels) disqualify globe use. Reference architecture only. |
| **R3F-Ultimate-Lens-Flare** | No license field | Rights unclear — moot anyway: **we already ship ghost/halo/chromatic lens flare.** Do not copy. |
| **FSR3 frame generation** | MIT (not license-blocked) but **interaction-model-blocked** | Interpolated frames add latency, aren't pickable/queryable, and the globe is often static — bad fit for interactive cartography + `requestRenderMode`. Take only the FSR2 upscaling half (#2). Consciously deferred. |
| **three-gpu-pathtracer** | MIT | Not blocked, but **not a runtime feature** — real-time globe-scale infeasible. Value is offline ground-truth reference-image generation for the visual-regression harness; out of scope as a shippable. |
| **VXGI (voxel cone tracing)** | MIT (Friduric) | Not license-blocked but **scale-blocked** — a voxel grid over a planet + per-frame re-voxelization of streamed RTE tiles is untenable. Ruled out; SSGI/RC cover the need more cheaply. |

---

## Deduped-out — already shipped (do not re-propose)

- **Ghost/halo/chromatic lens flare** — `LensFlare.wgsl`/`LensFlare.glsl` parity twins (4-ghost + halo + earth-mask). *(Only latent gap: `dirtTexture` overlay + `starTexture` burst modulation — minor watch, not a new effect.)*
- **Cloud turbulence / curl domain-warp** — Batch 439 analytic curl-noise domain warp (`curlAmplitude`/`curlFrequency`). *(Takram's baked-3D-vector-texture variant warping shape+detail is a minor delta — watch.)*
- **Hillaire 2020 sky-view LUT** — shipped in `AtmosphereLUT.wgsl` (256×128 relAzimuth × Hillaire-warped view-zenith SkyView LUT + Batch-429 Hillaire-domain multiple-scattering LUT + irradiance LUT), layered over full Bruneton LUTs + froxel aerial perspective.
- **N8AO / HBAO** — we ship N8-style AO / GTAO (GTAO subsumes HBAO). *(N8AO CC0 source is a clean quality cross-check only.)*
- **SMAA** — we ship FXAA + TAA; SMAA overlaps heavily.
- **3D `.cube` LUT color grading / HALD CLUT** — we ship color grading + tonemapping (incl PBR-Neutral); these are format/authoring conveniences over what we have.
- **pmndrs DoF / bokeh-tilt-shift / tonemap / god-rays / vignette / chromatic-aberration / NPR** — covered by our PP suite (DoF, tonemapping, god-rays/light-pillars). NPR modes low-priority for geospatial.
- **Geometry clipmaps** — subsumed by our quantized-mesh quadtree LOD (CDLOD geomorph #26 is the non-dup remainder).
- **IndirectStorageBufferAttribute / compute-writes-draw-args** — we already do MegaBuffer indirect draws + GPU cull. *(Real remaining gap = finishing the earmarked radix-sort→drawIndirect feed; tracked as scaffolding, not a new technique.)*
- **StorageTexture compute-write→sample pattern** — already used for sky/env-cube/LUT baking; extending to vector-outline SDF/grid masks is a pattern application, not a new capability.
- **CDLOD LOD *selection*** — our screen-space-error quadtree already covers it (only the geomorph *anti-popping* half survives as #26).
- **Hosek-Wilkie as a realism upgrade** — Bruneton+Hillaire supersedes it (kept only as a cheap fallback-tier watch, #31).
