# Campaign 3 — PACKED execution specs (25 batches, ready to go)

**Live progress / what's shipped / what's next:**
[CAMPAIGN3_PROGRESS.md](CAMPAIGN3_PROGRESS.md) (the dashboard).

Companion to **QUEUE_2026-06-24_CAMPAIGN3_WEATHER.md** (the why + arc overview).
This file is the **execution-ready** detail: each batch bundles everything that
must ship in one atomic commit (shader + JS packer + BGL + new files + probe +
docs), grounded in the real code by a 5-architect design workflow (one architect
per arc, each reading the actual `ProceduralClouds.wgsl` / renderer / subsystem).

## How to run a batch (in-loop — NOT auto-runnable by a Workflow)

Each batch is **one atomic commit**. A Workflow/subagent cannot ship these — the
verification (build + Playwright probe + visually reading the PNGs) must run in
the main loop. Per batch:

1. Implement **all** the "Bundled work" bullets together (never leave a
   half-feature for a later batch).
2. `npx gulp build` (compiles the WGSL `.wgsl` → `.js`; never edit the `.js`).
3. Run the batch's Playwright probe (Edge/msedge, dev server on `:8080`).
4. **READ the output PNG(s) yourself** — confirm the visual claim and no new
   artifact (Principle 8). Filter the known `Atmosphere ?LUT`/`SkyAtmosphere`
   device error (until P1 fixes it).
5. Commit + push as **kurtyoung-dev** (`gh auth switch` if 403). Never
   `--no-verify`.

## Recommended execution order

**A (W1→W4) → B (W5→W8) → C (W9→W11) → D (W12→W14) → E (P1→P11).** Lighting first
(biggest visual jump on the current full-res path, no deps), then perf headroom,
then shape detail (spends the headroom), then scene integration, then the parity
sweep. P1 (atmosphere-LUT device-error fix) can jump earlier if the filtered
error becomes noisy. The detailed specs below are grouped **by owning architect**
(so Arc A and Arc C share one block — the cloud-internals architect owns both).

## MASTER `CloudUniforms` byte layout (reconciled — single source of truth)

Owned by the cloud-internals architect; **the only struct every cloud batch
edits**. Current real struct = **80 floats** (`CLOUD_UNIFORM_FLOATS = 80`).
New fields reuse the Phase-1 pad holes (66/67, 72–79) then append at 80+; the
WGSL struct and the JS packer move **byte-identically**. vec3 fields start on
4-float (16-byte) boundaries per WGSL alignment.

| Floats | Field | Batch | Note |
|---|---|---|---|
| 0–63 | (camera/sun/layer/quality/wind/colors/resolution) | — | unchanged |
| 64–65 | `weatherMapEnabled`, `weatherStrength` | W-P1 | unchanged |
| 66 | `phaseG2` (back-lobe g) | **W1** | was `_pad3.x` |
| 67 | `phaseBlend` (fwd/back weight) | **W1** | was `_pad3.y` |
| 68–71 | `weatherTexBounds` (vec4) | W-P1 | unchanged |
| 72 | `phaseG1` (fwd-lobe g) | **W1** | was `_pad4` lane 0 |
| 73 | `ambientIntensity` | **W2** | pad lane |
| 74–75 | `curlAmplitude`, `curlFrequency` | **W9** | pad lanes |
| 76 | `frameCounter` (jitter/temporal) | **W8** | claims `_padA` lane 0 (reconciliation) |
| 77–79 | `_padA` reserve | — | aligned reserve |
| 80–83 | `skyAmbientColor` (vec3 + pad) | **W2** | new vec4 slot |
| 84–87 | `groundAmbientColor` (vec3 + pad) | **W2** | new vec4 slot |
| 88–91 | `sunLightColor` (vec3) + `aerialStrength` (w) | **W3 / W4** | W3 rgb, W4 .w |
| 92–95 | `aerialColor` (vec3 inscatter tint + pad) | **W4** | new vec4 slot |
| 96–99 | `profileBaseDensity`, `profileExtinction`, `profileShape`, `profileErosion` | **W10** | active-genus profile |
| 100 | `deckCount` (1–3) | **W11** | |
| 101–103 | `deckBottoms` (vec3) | **W11** | |
| 104–106 | `deckTops` (vec3) | **W11** | |
| 107 | `cirrusTint` | **W11** | completes the vec4 |

**Final `CLOUD_UNIFORM_FLOATS = 108`** (432 bytes; buffer already
`max(bytes, 256)`-sized). Per-batch caveat (from the architect): a batch that
ships standalone must keep the struct float-count it declares matching the JS
packer — rename pad holes **in place**, only grow the struct when the batch that
claims the new slot lands. Each batch claiming a slot in 72–107 must also replace
the matching write in the renderer's trailing zero-fill loop
(`for (let i = 72; i < CLOUD_UNIFORM_FLOATS; i++)`).

## Reconciliation notes (cross-arc)

- **W8** is the only perf batch that touches `CloudUniforms` — its `frameCounter`
  lives at **float 76** (above). Arc B's other batches (W5/W6/W7) add **no**
  cloud uniforms; they own renderer-local UBOs instead.
- **Arc B** introduces renderer-local UBOs **`UpscaleUniforms`** (W6) and
  **`ReprojectUniforms`** (W7) + new half-res / history render targets — separate
  from `CloudUniforms`.
- **Arc D** (cloud shadows / god rays) produces **textures/FS outputs**, not
  cloud uniforms (transmittance is an FS output; the cloud-shadow map is a new
  texture bound into `GlobeTerrain.wgsl`).
- **Arc E** P7 (WeatherSystem) adds a TS-side `weatherVersion`/field, not a render
  uniform; the weather-map builder UBO is independent of `CloudUniforms`.

---

# Detailed packed specs (by owning architect / arc)


---

## Arcs A + C — Cloud lighting fidelity (W1–W4) + shape/detail (W9–W11)

## CloudUniforms byte-layout evolution table (SOLE OWNER)

Current real struct (`ProceduralClouds.wgsl` lines 19-57) = **80 floats** (`CLOUD_UNIFORM_FLOATS = 80`, line 30 of the renderer). Floats 0-63 are the dense camera/sun/layer/quality/wind/color/resolution block; floats 64-79 are the Weather-Phase-1 seam. Within that seam, **floats 66-67** (`_pad3`) and **floats 72-79** (`_pad4`, 8 floats) are currently zero-filled reserve. All my new fields are appended at float 80+ and the two existing pad holes are consumed — the WGSL struct and the JS packer move byte-identically.

Allocation (all offsets are float indices; ×4 = byte offset):

| Floats | WGSL field | Batch | Notes |
|---|---|---|---|
| 0-63 | (existing camera/sun/layer/quality/wind/colors/resolution) | — | unchanged |
| 64-65 | `weatherMapEnabled`, `weatherStrength` | (W-P1) | unchanged |
| 66 | `phaseG2` (back-lobe g, was `_pad3.x`) | **W1** | reuse existing pad hole |
| 67 | `phaseBlend` (forward/back weight, was `_pad3.y`) | **W1** | reuse existing pad hole |
| 68-71 | `weatherTexBounds` (vec4) | (W-P1) | unchanged |
| 72 | `phaseG1` (forward-lobe g, was `_pad4`) | **W1** | reuse pad |
| 73 | `ambientIntensity` | **W2** | reuse pad |
| 74-75 | `curlAmplitude`, `curlFrequency` | **W9** | reuse pad |
| 76-79 | `_padA` (vec4 reserve) | — | keep aligned reserve |
| 80-83 | `skyAmbientColor` (vec3 + pad@83) | **W2** | new vec4 slot |
| 84-87 | `groundAmbientColor` (vec3 + pad@87) | **W2** | new vec4 slot |
| 88-91 | `sunLightColor` (vec3 + `aerialStrength`@91) | **W3+W4** | W3 writes rgb, W4 writes .w |
| 92-95 | `aerialColor` (vec3 inscatter tint + pad@95) | **W4** | new vec4 slot |
| 96 | `profileBaseDensity` | **W10** | active-genus profile |
| 97 | `profileExtinction` | **W10** | |
| 98 | `profileShape` (0=SLAB,1=BILLOWY,2=TOWER) | **W10** | |
| 99 | `profileErosion` (0=FIBROUS,1=PUFFY) | **W10** | |
| 100 | `deckCount` (1, 2, or 3) | **W11** | |
| 101-103 | `deckBottoms` (vec3: low/mid/high deck floors, m) | **W11** | |
| 104-106 | `deckTops` (vec3: deck ceilings, m) | **W11** | |
| 107 | `cirrusTint` (blue-shift weight for ice deck) | **W11** | (pad-completes the vec4 at 104-107) |

**Final `CLOUD_UNIFORM_FLOATS = 108`** (was 80). 108 is a multiple of 4 (vec4-aligned, 432 bytes < the 256-min/16-aligned buffer already sized `Math.max(CLOUD_UNIFORM_BYTES, 256)` → rounds to 432 fine). vec3 fields at 80/84/88/92/101/104 all start on 16-byte (4-float) boundaries per WGSL `vec3` alignment rules — verified each vec3 begins at a float index divisible by 4. The renderer's trailing zero-fill loop (`for (let i = 72; i < CLOUD_UNIFORM_FLOATS; i++)`) currently starts at 72; **each batch that claims a slot in 72-107 must replace the relevant write inside/after that loop** — I call this out per-batch.

---

### W1 — Dual-lobe (two-term) Henyey-Greenstein phase
- **EXECUTION NOTE (SHIPPED Batch 391):** the phase change alone was VISUALLY INERT — the probe + PNG read showed the clouds clip to flat pure-white (HDR radiance: forward phase peak ~6 × sunIntensity ~10 ≫ 1, no tone-mapping), so no silver lining could read. Folded in the real unblock: a **Reinhard tone-map + exposure (`CLOUD_EXPOSURE=0.22`) at the composite** (`ProceduralClouds.wgsl` end of `raymarchClouds`). Result: clouds went from flat-white blobs to shaded volumetric puffs with tonal range + a backlit silver lining — and this unblocks ALL of Arc A (W2/W3/W4 lighting terms were equally invisible under saturation). `CLOUD_EXPOSURE` is a const for now (a later batch may promote it to a uniform; NO CloudUniforms layout change here).
- Goal: Replace the hardcoded `cloudPhase` constants with uniform-driven dual-lobe HG so a tunable silver-lining rim appears toward the sun.
- Bundled work (single commit):
  - WGSL: rewrite `cloudPhase(cosTheta)` (lines 232-236) to `dualLobeHG(cosTheta, g1, g2, w)` reading `cloud.phaseG1/phaseG2/phaseBlend`; keep `hgPhase` helper as-is.
  - Struct: rename `_pad3.x`→`phaseG2` (66), `_pad3.y`→`phaseBlend` (67); rename first lane of `_pad4`→`phaseG1` (72); shrink `_pad4: vec4` to `_padA` covering 76-79 (and add the 4 new vec4 slots from the layout table only as needed — see "Risk" re: keeping the struct compiling at 80 if W2+ not yet landed).
  - JS packer: write floats 66, 67, 72 with g1/g2/w; new probe `probe-cloud-phase.mjs`; FEATURE_INVENTORY move line for W1.
- Exact files: `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl`; `packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`; new `Tools/visual-regression/probe-cloud-phase.mjs`; `migration_doc/FEATURE_INVENTORY.md`.
- Shader changes: add `fn dualLobeHG(cosTheta, g1, g2, w) -> f32 { return mix(hgPhase(cosTheta,g2), hgPhase(cosTheta,g1), w); }`. Call site is the existing `let phase = cloudPhase(cosTheta);` at line 349 → `let phase = dualLobeHG(cosTheta, cloud.phaseG1, cloud.phaseG2, cloud.phaseBlend);`. `phase` already multiplies `lightTransmittance` at line 379 — no other call site.
- Uniform/struct + JS packer: 80→80 floats (W1 alone consumes only pad holes, no growth). New offsets: `phaseG2`=66, `phaseBlend`=67, `phaseG1`=72. Packer: in the seam block (currently `data[offset++] = 0` for floats 66/67 at lines 466-467) write `0.8`-ish g1 later — actually write `phaseG2≈-0.3` at 66, `phaseBlend≈0.7` at 67; and replace the first iteration of the `for (let i = 72; ...)` zero-fill with `data[offset++] = 0.8` (phaseG1) then continue the loop from 73. WGSL struct: `phaseG2: f32` (66), `phaseBlend: f32` (67) replace `_pad3: vec2<f32>`; `phaseG1: f32` (72) takes the first lane of old `_pad4`.
- BGL / bind-group: none.
- Probe: `probe-cloud-phase.mjs`. Scene: globe off, `showProceduralClouds=true`, `cloudWeatherMap=true`, coverage 0.6, sun low on horizon (e.g. sunDir near +X). Render two camera azimuths — one looking toward the sun, one 180° away. Measure mean luminance of the upper-half cloud band each. Pass: `sunSideMeanLum / antiSunSideMeanLum >= 1.5` AND sun-side has a brighter top-edge row than its interior (rim). READ `output/cloud-phase-toward-sun.png` (expect a bright rim along the sun-facing cloud edges) and `output/cloud-phase-away-sun.png` (flatter, no rim).
- Depends on / sequence: none — first batch of Arc A.
- Risk / gotcha: WGSL requires the struct's total size match the JS `CLOUD_UNIFORM_FLOATS`. If W1 ships standalone the struct must stay exactly 80 floats — so rename pads in place, do NOT append new vec4 slots until W2. The single likely failure: forgetting that `_pad4` was `vec4` (4 floats 72-75) and only renaming float 72, leaving 73-75 as a 3-float remainder that misaligns the next struct field — keep 73-75 as an explicit `_pad4b: vec3<f32>` until W2/W9 claim them.

---

### W2 — Sky-ambient gradient + ground bounce
- **EXECUTION NOTE (SHIPPED Batch 392):** implemented as specced (CloudUniforms 80→88: ambientIntensity@73, skyAmbientColor@80-82, groundAmbientColor@84-86; per-step ambient folded into the tone-mapped radiance; old hardcoded ambient deleted). Probe metric adjusted: the camera frames the layer from BELOW (sees cloud undersides = ground-bounce), so the blue-top-vs-warm-bottom row gradient isn't in frame — verified the core (shadow p10 lifted to 0.298 off near-black + lit-to-shadow range 0.263 preserved) numerically, the blue/warm gradient by PNG read. ambientIntensity=1.5.
- Goal: Add a height-fraction ambient term (blue sky on tops, ground-albedo on bottoms) so the shadow side of clouds is no longer near-black.
- Bundled work (single commit):
  - WGSL: add `skyAmbientColor`, `groundAmbientColor` (vec3 each) + `ambientIntensity` (f32) to struct; add an ambient lerp by `heightFraction` inside the march accumulation; replace the existing hardcoded `ambientColor` block (lines 396-402) with uniform-driven values.
  - JS packer: write the two colors + intensity; new `probe-cloud-ambient.mjs`; FEATURE_INVENTORY move.
- Exact files: `ProceduralClouds.wgsl`; `WebGPUProceduralCloudRenderer.ts`; new `Tools/visual-regression/probe-cloud-ambient.mjs`; `migration_doc/FEATURE_INVENTORY.md`.
- Shader changes: in the per-step loop after `cloudColor` (line 383), add `let ambient = mix(cloud.groundAmbientColor, cloud.skyAmbientColor, heightFraction) * cloud.ambientIntensity;` and fold into `scatteredLight` → either add `ambient` to the lit color before the `weightedColor +=` (line 389), i.e. `weightedColor += (cloudColor * scatteredLight + ambient) * sampleWeight;`. Delete the post-loop hardcoded ambient (lines 395-402) and its `weightedColor += ambientContribution;`.
- Uniform/struct + JS packer: 80→88 floats. New: `ambientIntensity`=73 (claims a `_pad4b` lane from W1); `skyAmbientColor`=floats 80-82 (pad 83); `groundAmbientColor`=floats 84-86 (pad 87). Packer: set `data[73]` in the seam zero-fill; after the existing weather-bounds writes, append `skyAmbientColor` (e.g. `0.5,0.65,0.95,0`) and `groundAmbientColor` (e.g. `0.35,0.35,0.32,0`). Bump `CLOUD_UNIFORM_FLOATS` 80→88. WGSL struct appends after `_padA` (76-79): `skyAmbientColor: vec3<f32>, _padB: f32, groundAmbientColor: vec3<f32>, _padC: f32,`.
- BGL / bind-group: none.
- Probe: `probe-cloud-ambient.mjs`. Scene: weather map on, coverage 0.6, sun roughly side-on so clouds have a clear lit face and shadow face. Measure mean luminance of the anti-sun (shadow) cloud face. Pass: shadow-face mean luminance rises into `[0.12, 0.45]` (no longer <0.05 near-black, not blown out) AND top-vs-bottom gradient present (mean lum of top 25% rows > bottom 25% rows by ≥10%). READ `output/cloud-ambient.png` — shadow side reads soft grey-blue, not black; tops slightly bluer than bottoms.
- Depends on / sequence: after **W1** (shares the struct edit region; W1 must have renamed the pad lanes first so float 73 is free).
- Risk / gotcha: double-counting ambient if the old hardcoded post-loop block isn't deleted — the single most likely failure is leaving lines 395-402 in, which blows out transmittance-weighted ambient on top of the new per-step ambient. Delete it.

---

### W3 — Time-of-day cloud color from the atmosphere LUT
- **EXECUTION NOTE (SHIPPED Batch 393):** CloudUniforms 88→92 (sunLightColor@88-90, aerialStrength@91 packed 1.0 for W4). Corrected the elevation keying — the spec's raw `sunDir.y` is ECEF Y, not local elevation; keyed instead on `dot(sunDir, normalize(camPos))` (true local sin-elevation) so the warm/neutral ramp tracks the actual sun height. **Sun-control technique for cloud probes (W4 reuses):** the RAF render path ignores the clock; set `viewer.useDefaultRenderLoop=false` then `scene.render(jd)` to make the sun follow a JulianDate. Verified dawn 6.9°→R/B 1.32, noon 74.6°→0.96, dusk 5.7°→1.44; PNGs READ (dusk orange, noon white-grey). GREEN.
- Goal: Drive the cloud direct-sun color (and tint the sky-ambient) warm at low sun / neutral at noon, from the atmosphere transmittance.
- Bundled work (single commit):
  - JS: CPU-side sample the atmosphere transmittance along the sun zenith (cheapest correct path — no new BGL binding into the cloud pipeline) and pack a `sunLightColor` vec3; multiply it into the sun term in WGSL.
  - WGSL: add `sunLightColor` (vec3) to struct; multiply `cloud.sunIntensity` term by it.
  - New `probe-cloud-tod.mjs`; FEATURE_INVENTORY move.
- Exact files: `ProceduralClouds.wgsl`; `WebGPUProceduralCloudRenderer.ts`; new `Tools/visual-regression/probe-cloud-tod.mjs`; `migration_doc/FEATURE_INVENTORY.md`.
- Shader changes: at line 379 the sun term is `(lightTransmittance * phase + silverLining) * cloud.sunIntensity`. Change to multiply by `cloud.sunLightColor` (vec3): `let scatteredLight = (lightTransmittance * phase + silverLining) * cloud.sunIntensity;` stays scalar; instead apply color at composite: `weightedColor += (cloudColor * cloud.sunLightColor * scatteredLight + ambient) * sampleWeight;`. Also tint W2's `skyAmbientColor` usage is untouched (W3 only sets sun color).
- Uniform/struct + JS packer: 88→92 floats. New: `sunLightColor`=floats 88-90; float 91 is reserved here for W4's `aerialStrength` (W3 packs 91=1.0 neutral so the struct slot is valid even before W4). Packer: compute a TOD warm/neutral color in JS from `sunDir.y` (sun elevation) — e.g. `t = clamp(sunDir.y, 0,1); color = mix(vec3(1.0,0.55,0.25)/*low*/, vec3(1.0,1.0,0.98)/*noon*/, smoothstep(0.0,0.35,t))`. (If the perf manager's `_atmosphereLutResources` is reachable via `context` at this call site, prefer reading the actual transmittance; otherwise the analytic sun-elevation ramp is the documented fallback — the queue explicitly allows "pass sampled colors as uniforms".) Append `sunLightColor` rgb + `1.0` at floats 88-91. Bump `CLOUD_UNIFORM_FLOATS` 88→92. WGSL struct: `sunLightColor: vec3<f32>, aerialStrength: f32,` (the `.w` is W4's, declared now, written 1.0 by W3).
- BGL / bind-group: none (CPU-sampled color path). If the team later wants true LUT sampling, that adds bindings 6 (texture) + reuses sampler 5 — note only, not in this batch.
- Probe: `probe-cloud-tod.mjs`. Scene: weather map on; render 3 frames at sun elevations dawn (`sunDir.y≈0.05`), noon (`sunDir.y≈0.95`), dusk (`sunDir.y≈0.05` opposite azimuth). Measure mean cloud R and B channels. Pass: dawn AND dusk `meanR / meanB >= 1.15` (warm); noon `0.95 <= meanR/meanB <= 1.08` (neutral). READ `output/cloud-tod-dawn.png`, `-noon.png`, `-dusk.png` — dawn/dusk clouds visibly orange-tinted, noon white-grey.
- Depends on / sequence: after **W2** (struct append region; reuses the per-step `weightedColor +=` line W2 introduced).
- Risk / gotcha: declaring `aerialStrength` at float 91 now but W4 not yet landed — must pack 1.0 (neutral multiplier) so the not-yet-implemented aerial lerp is a no-op. The single likely failure: packing 0.0 there, which (once W4's shader code lands) would zero distant clouds; until W4 lands the field is simply unread, so 1.0 is safe either way.

---

### W4 — Aerial-perspective blend on distant clouds
- Goal: Blend distant cloud color toward an atmosphere-inscatter haze color by view distance so far clouds desaturate into the horizon instead of popping.
- Bundled work (single commit):
  - WGSL: add `aerialColor` (vec3 haze tint) to struct; at composite, lerp `finalColor` toward `aerialColor` by a distance factor derived from `tStart`/march distance and `cloud.aerialStrength`.
  - JS: pack `aerialColor` (CPU-sampled horizon inscatter or analytic sky color) and set `aerialStrength` (float 91, declared in W3) to its real value.
  - New `probe-cloud-aerial.mjs`; FEATURE_INVENTORY move.
- Exact files: `ProceduralClouds.wgsl`; `WebGPUProceduralCloudRenderer.ts`; new `Tools/visual-regression/probe-cloud-aerial.mjs`; `migration_doc/FEATURE_INVENTORY.md`.
- Shader changes: the composite is `let finalColor = mix(sceneColor.rgb, weightedColor, cloudAlpha);` (line 406). Add before it: `let camToCloud = tStart;` (meters along ray to first cloud sample) `let aerial = clamp(camToCloud / 60000.0 * cloud.aerialStrength, 0.0, 0.85);` then `let hazed = mix(weightedColor, cloud.aerialColor * (cloudAlpha + 0.0001), aerial);` and composite with `hazed` instead of `weightedColor`. (Distance constant tunable; 60 km is a reasonable horizon-haze scale.)
- Uniform/struct + JS packer: 92→96 floats. New: `aerialStrength` already at float 91 (W3 declared it, W4 now writes the real value, e.g. 1.0); `aerialColor`=floats 92-94 (pad 95). Packer: change the W3 write of float 91 from `1.0` to the tuned strength; append `aerialColor` rgb + 0 at 92-95 (analytic horizon color, e.g. desaturated sky-blue `0.6,0.7,0.85`, or sampled inscatter if LUT reachable). Bump `CLOUD_UNIFORM_FLOATS` 92→96. WGSL struct: append `aerialColor: vec3<f32>, _padD: f32,`.
- BGL / bind-group: none.
- Probe: `probe-cloud-aerial.mjs`. Scene: weather map on, camera high enough that the cloud band recedes to the horizon (so near and far cloud regions both visible). Sample a NEAR cloud patch (bottom of frame) and a FAR cloud patch (near horizon line). Pass: far-patch saturation < near-patch saturation by ≥25%, AND far-patch mean color within `[0.85,1.15]×` the sky/horizon color sampled just above it. READ `output/cloud-aerial.png` — far clouds fade into the haze band, near clouds stay crisp/white.
- Depends on / sequence: after **W3** (consumes the `aerialStrength` slot W3 declared at float 91; must land in order so the slot isn't double-declared).
- Risk / gotcha: `tStart` can be 0 when the camera is inside/below the cloud layer, collapsing the aerial term unevenly. The single likely failure: keying haze on `tStart` alone when the camera is below clouds (tStart≈0 everywhere) — guard by using the per-pixel march midpoint distance `tStart + 0.5*(tEnd-tStart)` or clamp so near-nadir views don't haze the whole sky.

---

### W9 — Curl-noise wispy edges
- Goal: Advect the high-frequency Worley erosion sample position by a curl-noise field so cloud edges turn turbulent/wispy instead of uniformly eroded.
- Bundled work (single commit):
  - WGSL: add `curlNoise(p) -> vec3<f32>` (finite-difference curl of a vec3 value-noise potential, reusing `hash33`/`valueNoise`); offset the Worley erosion `samplePos` in `cloudDensity` by it; gate amplitude/frequency on new uniforms.
  - JS: pack `curlAmplitude`, `curlFrequency`; new `probe-cloud-detail.mjs`; FEATURE_INVENTORY move.
- Exact files: `ProceduralClouds.wgsl`; `WebGPUProceduralCloudRenderer.ts`; new `Tools/visual-regression/probe-cloud-detail.mjs`; `migration_doc/FEATURE_INVENTORY.md`.
- Shader changes: add `fn curlNoise(p: vec3<f32>) -> vec3<f32>` using central differences of three `valueNoise` lobes (offset seeds) — standard `(∂Pz/∂y−∂Py/∂z, ∂Px/∂z−∂Pz/∂x, ∂Py/∂x−∂Px/∂y)`, eps≈0.01. In `cloudDensity`, the erosion line is `let worleyDetail = worleyF1(samplePos * 5.0 + windOffset * 0.001);` (line 208). Change to `let curl = curlNoise(samplePos * cloud.curlFrequency) * cloud.curlAmplitude;` then `let worleyDetail = worleyF1(samplePos * 5.0 + curl + windOffset * 0.001);`.
- Uniform/struct + JS packer: no growth from W9 itself — `curlAmplitude`=74, `curlFrequency`=75 occupy W1's `_padA`/reserved lanes (floats 74-75). If W9 lands AFTER W1-4, `CLOUD_UNIFORM_FLOATS` is already 96; W9 just fills 74/75 (currently zero-filled). Packer: set `data[74]=curlAmp` (e.g. 0.6), `data[75]=curlFreq` (e.g. 2.0) — replace the zero-fill writes for those indices in the seam loop. WGSL struct: rename the 74-75 reserve lanes to `curlAmplitude: f32, curlFrequency: f32` (these sit inside the 72-79 block — re-declare that block as discrete fields: `phaseG1`(72), `ambientIntensity`(73), `curlAmplitude`(74), `curlFrequency`(75), `_padA: vec4`(76-79)).
- BGL / bind-group: none.
- Probe: `probe-cloud-detail.mjs`. Scene: weather map on, single dense cloud region, camera close enough to resolve edge texture. Compute high-frequency energy along cloud/sky boundary rows (count luminance sign-changes / local variance in a band around the silhouette). Pass: edge high-frequency energy rises ≥20% vs the pre-batch baseline image (probe stores both and diffs), AND interior mean density essentially unchanged (≤3% mean-luminance drift — curl must not add/remove bulk density, only perturb edges). READ `output/cloud-detail.png` — edges feathered/wispy, not melted or uniformly scalloped.
- Depends on / sequence: after **W1** (W1 re-declares the 72-79 pad block into discrete fields; W9 claims floats 74-75 from it). Independent of W2-4 functionally but shares the struct region — sequence after Arc A struct settles.
- Risk / gotcha: curl offset applied in noise-space units that are too large will *displace* whole lobes (looks like motion, not wispiness) rather than perturb edges. The single likely failure: `curlFrequency`/`curlAmplitude` scaled so the offset magnitude rivals the `*5.0` Worley frequency — keep `curlAmplitude` small (offset ≪ one Worley cell) so it only feathers the erosion boundary.

---

### W10 — Cloud-type vertical density profiles from `CloudTypeProfile`
- Goal: Wire the active genus's `CloudTypeProfile` (shape / base density / extinction / erosion) into `cloudDensity` so stratus reads flat, cumulus billowy, cumulonimbus towering — instead of one global height gradient.
- Bundled work (single commit):
  - WGSL: replace the single hardcoded `heightGradient` (lines 200-201) with a `heightGradientForShape(hf, shape)` selector (SLAB/BILLOWY/TOWER); scale base density by `profileBaseDensity`; feed `profileExtinction` into the light/extinction; gate Worley erosion strength on `profileErosion`.
  - JS: read the active genus from the weather-map type channel default (or `globe.cloudType`), call `CloudTypeProfile.get(...)`, pack the 4 scalars; new `probe-cloud-types.mjs`; FEATURE_INVENTORY move; possibly a `CloudTypeProfile.get` re-export check (no edit expected).
- Exact files: `ProceduralClouds.wgsl`; `WebGPUProceduralCloudRenderer.ts`; new `Tools/visual-regression/probe-cloud-types.mjs`; `migration_doc/FEATURE_INVENTORY.md` (and read-only `CloudTypeProfile.js`).
- Shader changes: add `fn heightGradientForShape(hf: f32, shape: f32) -> f32` — SLAB: `smoothstep(0,0.1,hf)*smoothstep(1.0,0.85,hf)` (flat, thin top falloff); BILLOWY: the current `smoothstep(0,0.15,hf)*smoothstep(1.0,0.7,hf)`; TOWER: `smoothstep(0,0.05,hf)*smoothstep(1.0,0.95,hf)` with a widened anvil near top. Replace lines 200-202 with `density *= heightGradientForShape(heightFraction, cloud.profileShape);`. Multiply base shape by `cloud.profileBaseDensity` after the coverage threshold (line 197). Replace the erosion constant `0.18` with `mix(0.10, 0.18, cloud.profileErosion)` (fibrous ice less puffy-eroded). Use `cloud.profileExtinction` to scale `cloud.absorptionCoeff` in `beerPowder`/`multiScatterLight` (multiply at the call site, or pass through).
- Uniform/struct + JS packer: 96→100 floats. New: `profileBaseDensity`=96, `profileExtinction`=97, `profileShape`=98, `profileErosion`=99. Packer: import `CloudTypeProfile` + `CloudType`; resolve active genus (default CUMULUS, or `globe.cloudType`), `const prof = CloudTypeProfile.get(genus);` then `data[96]=prof.baseDensity; data[97]=prof.extinction; data[98]=prof.shape; data[99]=prof.erosion;`. Bump `CLOUD_UNIFORM_FLOATS` 96→100. WGSL struct: append `profileBaseDensity: f32, profileExtinction: f32, profileShape: f32, profileErosion: f32,`.
- BGL / bind-group: none (scalar uniforms; per-genus packed CPU-side).
- Probe: `probe-cloud-types.mjs`. Scene: render 3 frames forcing `globe.cloudType = STRATUS(7)`, `CUMULUS(0)`, `CUMULONIMBUS(10)` with identical camera/coverage. For each, measure the cloud band's vertical extent (top minus bottom bright-pixel row) and top-edge roughness. Pass: vertical extents ordered `cumulonimbus > cumulus > stratus` with ≥25% extent difference between stratus and cumulonimbus; stratus top-edge roughness < cumulus (flatter). READ `output/cloud-type-stratus.png` (flat low sheet), `-cumulus.png` (rounded mid puffs), `-cumulonimbus.png` (tall, anvil-ish top).
- Depends on / sequence: after **W4** (struct grows on top of the Arc-A appends; needs `CLOUD_UNIFORM_FLOATS=96` as its base). Independent of W9 logic but sequence after it for a clean struct.
- Risk / gotcha: the weather map's G channel is hardcoded `128` (mid type) in `buildProceduralWeatherMap` (line 134), so the map alone can't select genera — must drive the active profile from a CPU scalar (`globe.cloudType`) this batch, not from the G channel. The single likely failure: trying to read per-position genus from the (uniform-128) weather texture and seeing no variation; that's a W11/multi-deck concern, keep W10 a single active profile.

---

### W11 — Multi-deck clouds: high cirrus + low stratus (+ ice-vs-water phase)
- Goal: Render up to three altitude decks (low stratus, mid cumulus, high cirrus) from the pre-declared `texture_2d_array` weather map, with cirrus using a sharper-forward phase, lower extinction, and a bluer tint than the water-droplet decks.
- Bundled work (single commit):
  - WGSL: restructure the march to iterate `cloud.deckCount` shells using `deckBottoms`/`deckTops`; per deck, sample its weather array layer, apply its profile (cirrus=ice → sharper `phaseG1`, lower extinction, `cirrusTint` blue-shift; cumulus=water rounder). Composite decks front-to-back.
  - JS: fill weather `texture_2d_array` to depth 3 (one layer per deck) in `buildProceduralWeatherMap`/`ensureWeatherView`; pack `deckCount`, `deckBottoms`, `deckTops`, `cirrusTint`; new `probe-cloud-multideck.mjs`; FEATURE_INVENTORY move; weather-map builder edit.
- Exact files: `ProceduralClouds.wgsl`; `WebGPUProceduralCloudRenderer.ts` (weather-map builder + array texture + packer); new `Tools/visual-regression/probe-cloud-multideck.mjs`; `migration_doc/FEATURE_INVENTORY.md`.
- Shader changes: `textureSampleLevel(weatherTex, weatherSampler, wuv, 0, 0.0)` (line 188) already passes array-layer `0` — generalize `cloudDensity` to take a `deckIndex: i32` and sample `..., deckIndex, 0.0)`. Add a per-deck loop around the existing single march (or run the march per deck with that deck's `innerR/outerR` from `deckBottoms[d]`/`deckTops[d]`). For the high deck, apply ice params: phase `dualLobeHG(cosTheta, sharperG1, g2, w)` and tint `mix(cloudColor, cloudColor*vec3(0.85,0.9,1.05), cloud.cirrusTint)`, extinction scaled down. Composite each deck's `(color, transmittance)` over the accumulator far→near.
- Uniform/struct + JS packer: 100→108 floats. New: `deckCount`=100; `deckBottoms`(vec3)=101-103; `deckTops`(vec3)=104-106; `cirrusTint`=107. Packer: build weather array with `depthOrArrayLayers: 3` and fill 3 layers (low/mid/high coverage fields — vary octave/threshold per layer so decks differ); `data[100]=deckCount; data[101..103]=lowBot,midBot,highBot; data[104..106]=lowTop,midTop,highTop; data[107]=cirrusTint`. Use `CloudDeck.bounds` from `CloudTypeProfile.js` for the meter values (`[0,2000],[2000,7000],[5000,13000]`). Bump `CLOUD_UNIFORM_FLOATS` 100→108. WGSL struct: append `deckCount: f32, deckBottoms: vec3<f32>, deckTops: vec3<f32>, cirrusTint: f32,` (note: `deckBottoms` vec3 must start at a 4-float boundary — float 101 is NOT divisible by 4; re-pad so `deckCount` sits at 100 then `_padE` to push `deckBottoms` to 104). **Corrected layout:** `deckCount`=100, `_padE0/1/2`=101-103, `deckBottoms`=104-106, `pad`=107, `deckTops`=108-110, `cirrusTint`=111 → **CLOUD_UNIFORM_FLOATS=112**. (vec3 16-byte alignment forces this; final count is 112, not 108. Update the table's tail accordingly.)
- BGL / bind-group: none new — binding 4 is already `texture_2d_array` (declared depth-1, "Phase-1 foresight" per the WGSL comment lines 63-66); this batch fills it to depth 3. The fallback `weatherFallbackView` (1×1) is created `dimension: "2d-array"` already, so the disabled path still validates.
- Probe: `probe-cloud-multideck.mjs`. Scene: weather map on, `deckCount=3`, camera at altitude that frames both a low and high band. Detect two separated bright bands at distinct image heights (gap of clear sky between them). Measure each band's mean color and edge roughness. Pass: ≥2 distinct vertical cloud bands with a clear-sky gap (≥20 px of low-luminance rows between them); the upper (cirrus) band `meanB/meanR > lower band's meanB/meanR` (cooler) AND upper band edge roughness > lower (wispier). READ `output/cloud-multideck.png` — a high thin cooler wispy band above a lower rounder warmer band.
- Depends on / sequence: after **W10** (extends the profile path; needs the per-genus profile fields in place). Last Arc-C batch.
- Risk / gotcha: vec3 alignment — `deckBottoms`/`deckTops` must each begin on a 16-byte (4-float) boundary or the WGSL struct offsets silently diverge from the JS packer and every field after shifts. The single likely failure: packing `deckBottoms` at float 101 (the naive table value) while WGSL aligns it to 104 — pad explicitly (`_padE` 101-103) and land at **CLOUD_UNIFORM_FLOATS=112**; verify the JS write offsets match the WGSL byte offsets field-by-field before building.

### Critical Files for Implementation
- f:\Dev\GH\cesium-webgpu\packages\engine\Source\Shaders\WebGPU\Environment\ProceduralClouds.wgsl
- f:\Dev\GH\cesium-webgpu\packages\engine\Source\Renderer\WebGPU\WebGPUProceduralCloudRenderer.ts
- f:\Dev\GH\cesium-webgpu\packages\engine\Source\Scene\CloudTypeProfile.js
- f:\Dev\GH\cesium-webgpu\Tools\visual-regression\probe-cloud-volumetric-parity.mjs
- f:\Dev\GH\cesium-webgpu\migration_doc\FEATURE_INVENTORY.md

---

## Arc B — Cloud performance pipeline (W5–W8)

### W5 — Adaptive coarse→fine raymarch (empty-space skipping)
- Goal: Restructure the single fixed-step march in `ProceduralClouds.wgsl` `fragmentMain` into a two-phase coarse-skip / fine-integrate loop so equal-quality clouds cost far fewer density taps, creating the headroom W6–W8 spend.
- Bundled work (everything in this single commit):
  - Rewrite the `for (var i ...)` integration loop (lines 357–393) into: a coarse pointer `t` advancing by `coarseStep = (tEnd - tStart)/coarseCount`; on first `cloudDensity > 0.001` hit, step back one `coarseStep` and switch to `fineStep = coarseStep / FINE_RATIO`; integrate fine while density present; after `EMPTY_RUN` consecutive empty fine samples, snap back to coarse. No new uniforms — derive `coarseCount = max(8, i32(cloud.maxSteps) / 4)` and `FINE_RATIO = 4` as WGSL consts so the existing `maxSteps` quality dial still governs the budget.
  - Keep `lightMarch`/`multiScatterLight`/composite math byte-identical so the image is preserved.
  - Add `probe-cloud-perf.mjs` (new) asserting tap-count drop + ≤2% image mismatch vs a pre-batch reference capture.
  - FEATURE_INVENTORY: move W5 from §C to §B (in the doc-reconciliation note, W5 line).
- Exact files (edit/new):
  - edit `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl`
  - new `Tools/visual-regression/probe-cloud-perf.mjs`
  - edit `migration_doc/FEATURE_INVENTORY.md`
- Shader changes: Replace the body of `fragmentMain` from line 344 (`// Cloud march`) through line 393 (loop end). Keep `tStart/tEnd` setup (lines 309–342), `phase`/`cosTheta` (lines 347–349), and the ambient+composite tail (lines 395–408) unchanged. Inside the new loop reuse existing `cloudDensity(samplePos, heightFraction)` (line 367), `lightMarch` (line 372), `multiScatterLight` (line 373), and the accumulation block (lines 386–392) verbatim — only the stepping cadence changes. Add the early-out `if (transmittance < 0.01) { break; }` to the coarse loop too.
- Uniform/struct + JS packer: none. No `CloudUniforms` change — `maxSteps`/`lightSteps` (packed at the quality lane, renderer lines 430–431) drive it. Stays 80 floats. (If a tunable `coarseStep`/`emptyRun` scalar is later wanted, reconcile with the lighting spec which owns `CloudUniforms`; for this batch use WGSL consts.)
- BGL / bind-group: none.
- Probe: `probe-cloud-perf.mjs`. Scene: `g.showProceduralClouds=true`, `cloudCoverage=0.5`, `cloudDensity=0.6`, camera at `-95,39, 2500m` pitch 5°, skyAtmosphere off, sun off, black bg (mirror `probe-cloud-clockbind.mjs` setup lines 41–59). Capture full-res reference PNG first, then the adaptive PNG. NUMERIC thresholds: per-pixel mean-abs luminance mismatch ≤ 2% (≤ 5/255); cloud-cells (luminance > 150) within ±5% of reference count. READ `cloud-perf-after.png` and compare to `cloud-perf-ref.png`: silhouette and internal shading must be visually indistinguishable (no banding introduced, no thinned tops).
- Depends on / sequence: none — lands first in Arc B (it is the prerequisite headroom for W6/W7).
- Risk / gotcha: the back-up-one-step on first hit must clamp `t = max(t - coarseStep, tStart)` or the fine phase reads before `tStart` and the near cloud edge gets a dark/incorrect band; missing the empty-run reset re-entry to coarse re-introduces full cost (no perf win).

---

### W6 — Half-resolution cloud pass + depth-aware bilateral upscale
- Goal: Render the raymarch into a half-resolution `rgba16float` cloud target, then composite it onto the canvas with a joint-bilateral upscale keyed on scene depth so cloud/sky and cloud/terrain edges stay crisp at ~4× the per-pixel ray budget.
- Bundled work (everything in this single commit):
  - Split the cloud pass into two passes inside `executeProceduralClouds`: (1) the existing raymarch pipeline now renders into a half-res offscreen `cloudHalfTex` (`rgba16float`) writing premultiplied `vec4(weightedColor, cloudAlpha)` instead of `mix`-ing over `sceneColor`; (2) a new full-res upscale pass (new `CloudUpscale.wgsl`) that samples `cloudHalfTex` + half-res cloud-depth + full-res scene color/depth and bilateral-upsamples, then composites over scene color into `outputView`.
  - New `CloudUpscale.wgsl` (full-screen triangle vertex reused from clouds; FS does a 2×2 joint-bilateral with depth+spatial weights).
  - Renderer: allocate `cloudHalfTex`/`cloudHalfView` + a half-res scene-depth (down-sample of the bound depth, or sample full depth in the upscale and reconstruct — see below) at `floor(w/2) x floor(h/2)`; realloc on canvas resize (mirror `_allocateHistoryTextures` resize guard in `WebGPUTAAEffect.ts` lines 525–534). Add an upscale pipeline + BGL + sampler to `CloudCache`.
  - The raymarch fragment must EMIT cloud color+alpha (change the return at line 404–408 to output `vec4(weightedColor, cloudAlpha)` — guarded by a `RENDER_TO_HALF` path; keep the old composite for the non-half fallback). The over-composite moves to the upscale FS.
  - `probe-cloud-halfres.mjs` (new); FEATURE_INVENTORY W6 §C→§B.
- Exact files (edit/new):
  - edit `packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`
  - edit `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl` (output color+alpha to half target)
  - new `packages/engine/Source/Shaders/WebGPU/Environment/CloudUpscale.wgsl`
  - new `Tools/visual-regression/probe-cloud-halfres.mjs`
  - edit `migration_doc/FEATURE_INVENTORY.md`
- Shader changes:
  - `ProceduralClouds.wgsl`: change `fragmentMain` to `return vec4<f32>(weightedColor, cloudAlpha);` (color is already light-scaled and ambient-added at lines 389–402); drop the `mix(sceneColor.rgb, …)` at line 406. The half target is `rgba16float` so HDR cloud energy survives. Scene-depth stop test (line 303 `sceneDepth`) stays — clouds behind terrain still cull, sampled at half-res UV.
  - `CloudUpscale.wgsl` (new): bindings — `@group(0) @binding(0) cloudHalfTex: texture_2d<f32>`, `binding(1) sceneColorTex: texture_2d<f32>`, `binding(2) sceneDepthTex: texture_2d<f32>`, `binding(3) cloudHalfDepthTex: texture_2d<f32>`, `binding(4) linearSampler`, `binding(5) var<uniform> up: UpscaleUniforms { resolution: vec2, invResolution: vec2, depthSigma: f32, _pad: vec3 }`. FS: for each of the 4 nearest half-res taps compute `w = spatialGauss * exp(-abs(sceneDepth - tapCloudDepth)/depthSigma)`, normalize, then `finalColor = mix(sceneColor.rgb, cloudRGB, cloudAlpha)`. Reuse the cloud `vertexMain` full-screen triangle pattern (lines 77–85).
- Uniform/struct + JS packer: no change to `CloudUniforms` (stays 80 floats, packer lines 349–474 untouched). NEW small `UpscaleUniforms` UBO owned by this renderer (not `CloudUniforms`): 8 floats / 32 bytes (pad buffer to 256), packed in the renderer: floats 0–1 `resolution` (full w,h), 2–3 `invResolution`, 4 `depthSigma` (start `0.001` in NDC-depth units), 5–7 pad. This is renderer-local, not a `CloudUniforms` offset.
- BGL / bind-group: 
  - Cloud raymarch BGL unchanged (bindings 0–5 as in renderer lines 209–217), but its pipeline target format becomes `rgba16float` and the pass renders into `cloudHalfView`.
  - NEW upscale BGL: `texture(0)` cloud-half, `texture(1)` scene-color, `texture(2)` scene-depth, `texture(3)` cloud-half-depth, `sampler(4)`, `uniformBuffer(5)` — all `Stage.FRAGMENT`. Half-res cloud-depth: write it as a 2nd render target (MRT `@location(1)`) from the raymarch pass (`r32float`), recording the per-pixel `t/tEnd` of first hit; or simpler, sample full-res `sceneDepthTex` directly in the upscale and use a fixed spatial-only weight for v1 — but the depth-aware edge test needs the cloud's own front depth, so emit it MRT.
- Probe: `probe-cloud-halfres.mjs`. Scene as W5. Capture: full-res reference (W5 pipeline path, `cloudHalf` off) vs half-res+upscale. NUMERIC thresholds: whole-frame mean mismatch ≤ 3%; EDGE test — along a vertical scan crossing a cloud/sky boundary, the max single-step luminance gradient must be ≥ 80% of the reference gradient (no halo/blur softening), and there must be NO ring of intermediate-luminance pixels wider than 2px straddling the boundary. READ `cloud-halfres.png`: edges crisp, no checkerboard, no haloing at the cloud rim against sky or against terrain horizon.
- Depends on / sequence: after W5 (W6's half-res budget is what makes the W5 step counts affordable per half-pixel; sequence is W5 → W6).
- Risk / gotcha: the joint-bilateral falls back to a plain blur (visible halos) if `cloudHalfDepth` isn't emitted or the `depthSigma` is in the wrong units — the bound depth here is the `depthSampleableView` aspect sampled as `texture_2d<f32>` (renderer binding 1) holding nonlinear NDC depth, so `depthSigma` must be tuned in NDC space, not meters.

---

### W7 — Temporal reprojection + accumulation
- Goal: Reproject the prior half-res cloud buffer by camera motion using `UniformState.previousViewProjection` and accumulate, so the half-res raymarch (jittered each frame by W8) converges to full quality over N frames, with disocclusion rejection to kill ghosting.
- Bundled work (everything in this single commit):
  - Add a half-res history ping-pong (two `rgba16float` textures at half-res) to `CloudCache`, managed by a `WebGPUParityManager` instance (mirror `WebGPUTAAEffect.ts` lines 333–354, 847–887) — register one slot `"cloud-history"`, `advanceFrame()` once per `executeProceduralClouds`, `read()`=previous, `write()`=current.
  - New `CloudReproject.wgsl`: samples this-frame raw half-res cloud (`cloudHalfTex`), reprojects the history sample via `previousViewProjection * worldPosFromDepth(currentUV)` → previous UV, neighborhood-clamps the history to the current 3×3 min/max (AABB clamp like TAA), and blends `mix(history, current, blendWeight)` with `blendWeight=1` on disocclusion. Output feeds the W6 upscale.
  - Renderer: pack reproject uniforms (`currentViewProjection`, `previousViewProjection`, `inverseViewProjection`, `historyValid`) into a renderer-local UBO; CPU-invert is unnecessary — `us.inverseViewProjection` (UniformState line 487) already exists. Set `historyValid=0` on first frame / after resize (mirror `_skipNextBlend`, TAA lines 352–354, 588–591).
  - Pipeline order in `executeProceduralClouds`: raymarch→`cloudHalfTex` (W6) → reproject (history read + write) → upscale composite (W6 reads the reprojected buffer). 
  - `probe-cloud-temporal.mjs` (new); FEATURE_INVENTORY W7 §C→§B.
- Exact files (edit/new):
  - edit `packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`
  - new `packages/engine/Source/Shaders/WebGPU/Environment/CloudReproject.wgsl`
  - edit `migration_doc/FEATURE_INVENTORY.md`
- Shader changes:
  - `CloudReproject.wgsl` (new): bindings — `texture(0)` current half cloud, `texture(1)` history (parity read view), `texture(2)` cloud-half-depth (the `r32float` MRT from W6, gives front-of-cloud world reconstruction), `sampler(3)`, `uniformBuffer(4)`. FS: reconstruct current-pixel world pos from `cloudHalfDepth` + `inverseViewProjection`; project with `previousViewProjection` to get `prevUV`; if `prevUV` out of [0,1] → reject (use current); sample history at `prevUV`; clamp to current 3×3 luminance/color AABB; `out = mix(historyClamped, current, blendWeight)`, `blendWeight = mix(0.1, 1.0, disoccluded)`. Disocclusion = depth delta between reprojected-history depth and current depth exceeding a threshold OR clamp pushing history far. Reuse cloud `vertexMain` triangle.
  - No edit to `ProceduralClouds.wgsl` (W6 already emits color+alpha+depth).
- Uniform/struct + JS packer: NO `CloudUniforms` change (still 80 floats; main packer untouched). NEW renderer-local `ReprojectUniforms` UBO: 16 (currentVP) + 16 (previousVP) + 16 (inverseVP) + 4 tail (`historyValid` u32 at float 48, `blendWeight` at 49, `resolution` at 50–51) = 52 floats / 208 bytes, pad to 256. Source matrices: `us.viewProjection`, `us.previousViewProjection` (line 423), `us.inverseViewProjection` (line 487) — all column-major Float32 like the existing `invProj`/`invView` packs at renderer lines 351–364. The first-frame `historyValid=0` mirrors TAA's `historyValid` (TAA layout offset 24, TAA file lines 602–605). If a user-facing `cloudTemporalBlend` scalar is desired, reconcile with the lighting spec (owns `CloudUniforms`); otherwise keep it renderer-local.
- BGL / bind-group: NEW reproject BGL: `texture(0)` current, `texture(1)` history-read, `texture(2)` cloud-half-depth, `sampler(3)`, `uniformBuffer(4)` — all `Stage.FRAGMENT`. The history WRITE view is the reproject pass's color attachment (parity `write()` view), `rgba16float`, `loadOp:"clear"` (TAA pattern lines 657–667). The upscale (W6) then binds this write view as its `cloudHalfTex` input.
- Probe: `probe-cloud-temporal.mjs`. Scene as W5/W6. Test A (STATIC camera): render N=16 frames, capture, compare to a full-res non-temporal reference — mean mismatch ≤ 2% after convergence (early frames may exceed; assert frame 16 passes). Test B (PANNING camera): apply `camera.rotateRight` a small delta per frame across 30 frames; assert NO persistent ghost — measure max temporal luminance lag at a high-contrast cloud edge ≤ 12/255 two frames after the edge passes. READ `cloud-temporal-static-N16.png` (must equal reference) and `cloud-temporal-pan.png` (no trailing smear behind moving cloud edges).
- Depends on / sequence: after W6 (needs the half-res target + cloud-half-depth MRT) and benefits from W5; sequence W5 → W6 → W7. W8's jitter is what this resolves, but W7 must land first so W8 has an accumulator to converge into.
- Risk / gotcha: ghosting on disocclusion if the neighborhood clamp / reject is too lax — the single most likely failure is reconstructing world pos from `cloudHalfDepth` incorrectly (the half-depth is NDC, and `inverseViewProjection` expects clip coords `(uv*2-1, depth, 1)` then perspective-divide); a sign/flip error there sends `prevUV` off-screen every frame so accumulation silently never converges (looks like W7 "does nothing").

---

### W8 — Blue-noise / interleaved-gradient ray-start jitter + dither
- Goal: Offset each pixel's march start `t` by a per-pixel + per-frame IGN/R1 sequence and dither the final density so low step counts stop banding, feeding non-redundant sub-pixel samples into W7's accumulator.
- Bundled work (everything in this single commit):
  - Add `interleavedGradientNoise(pixel, frame)` and an R1 golden-ratio advance to `ProceduralClouds.wgsl`, matching the Jimenez IGN formula already used CPU-side in `WebGPUTAAEffect.ts` `ignJitter` (lines 285–300) so GPU jitter and any TAA share one noise distribution.
  - Apply the jitter at the march start: `t = tStart + jitter * stepSize` (offsets the `+0.5` sample center in the W5 loop) using `input.position.xy` (pixel coords) and a per-frame counter.
  - Dither the accumulated density/alpha by a small blue-noise term before composite to break smooth gradients.
  - Needs a per-frame counter in the shader: pack a `frameCounter` (incrementing u32→f32). This is the one scalar that must live in `CloudUniforms` — list under "reconcile with lighting spec".
  - `probe-cloud-banding.mjs` (new); FEATURE_INVENTORY W8 §C→§B.
- Exact files (edit/new):
  - edit `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl`
  - edit `packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts` (increment + pack `frameCounter`)
  - new `Tools/visual-regression/probe-cloud-banding.mjs`
  - edit `migration_doc/FEATURE_INVENTORY.md`
- Shader changes: Add `fn ign(p: vec2<f32>, frame: f32) -> f32` (the `fract(52.9829189 * fract(0.06711056*x + 0.00583715*y))` formula from TAA lines 286–299, with `frame` folded into `y` via the golden-ratio `1.6180339887` offset as in `ignJitter`). In `fragmentMain`, after computing `stepSize` (line ~345/W5-equivalent), compute `let jitter = ign(input.position.xy, cloud.frameCounter);` and start the march at `t = tStart + jitter * coarseStep` (jitter the coarse pointer, W5). Before the final composite, `cloudAlpha = clamp(cloudAlpha + (ign(...) - 0.5) * ditherAmt, 0.0, 1.0)` with `ditherAmt ≈ 1/255`. Reuse `input.position` (already `@builtin(position)` via `VertexOutput`, line 70).
- Uniform/struct + JS packer: needs ONE scalar `frameCounter`. The current `CloudUniforms` reserved tail `_pad4: vec4<f32>` (WGSL line 56, floats 72–79) has free lanes; the renderer zero-fills floats 72–79 at lines 473–474. RECONCILE WITH LIGHTING SPEC (it owns `CloudUniforms`): claim ONE float in the 72–79 reserved block for `frameCounter` (proposed float 72) — do not move the 80-float total. Packer change: replace the `data[offset++] = 0` for float 72 with `data[offset++] = (cache.frameCounter = (cache.frameCounter + 1) >>> 0);` and add `frameCounter: number` to `CloudCache` (init 0 at lines 54–69). If the lighting architect has already assigned float 72, take the next free reserved lane and update the WGSL struct field name accordingly. No float-count change (stays 80), no BGL change.
- BGL / bind-group: none.
- Probe: `probe-cloud-banding.mjs`. Scene as W5 but force LOW quality (`globe.cloudQuality=24` → fewer steps, worst banding) to make the effect visible; static camera; render 1 frame (jitter visible even single-frame, fully resolved after W7 accumulation). NUMERIC threshold: along a vertical luminance scan through a cloud body, count "hard steps" = adjacent-pixel luminance jumps > 12/255 within otherwise-smooth regions; jittered count must drop ≥ 50% vs a pre-batch (no-jitter) capture. READ `cloud-banding-after.png` vs `cloud-banding-before.png`: the concentric luminance contour bands inside the cloud must dissolve into smooth/noisy gradient.
- Depends on / sequence: after W5 (jitters the coarse pointer it introduces) and pairs with W7 (accumulation resolves the jitter to clean detail); sequence W5 → W6 → W7 → W8. Standalone-visible without W7 (single-frame banding drop) but only fully clean once W7 accumulates it.
- Risk / gotcha: jittering without an accumulator (if probed before W7 lands or with W7 disabled) trades banding for per-frame noise — the probe must measure banding reduction on a STATIC single frame and accept added high-frequency noise; over-large `ditherAmt` or jitter `> 1*stepSize` will read as sparkle/grain instead of dissolved bands and fail the "smooth gradient" READ.

### Critical Files for Implementation
- f:\Dev\GH\cesium-webgpu\packages\engine\Source\Renderer\WebGPU\WebGPUProceduralCloudRenderer.ts
- f:\Dev\GH\cesium-webgpu\packages\engine\Source\Shaders\WebGPU\Environment\ProceduralClouds.wgsl
- f:\Dev\GH\cesium-webgpu\packages\engine\Source\Renderer\WebGPU\WebGPUTAAEffect.ts
- f:\Dev\GH\cesium-webgpu\packages\engine\Source\Renderer\WebGPU\WebGPUParityManager.ts
- f:\Dev\GH\cesium-webgpu\packages\engine\Source\Renderer\WebGPU\WebGPUSceneRendererEnvironmentalEffects.ts

---

## Arc D — Cloud ↔ scene integration (W12–W14)

### W12 — Cloud shadows on the ground/terrain
- Goal: March cloud density toward the sun to build a coarse world-keyed cloud-shadow map, then darken the lit globe/terrain fragment under cloud cover, keyed by `worldToWeatherUV(positionWC)`.
- Bundled work (everything in this single commit):
  - **New `CloudShadowMap.wgsl`** (compute): for each texel of a 256×128 lon/lat shadow texture, reconstruct the world ECEF point on the cloud base shell from the texel's `(lon,lat)`, march toward `cloud.sunDirection` through the cloud shell summing `cloudDensity` (reusing the SAME density/coverage/weather-map sampling as `ProceduralClouds.wgsl`), and write `shadowFactor = exp(-opticalDepth * absorptionCoeff)` to `R` (1.0 = fully lit, →0 under thick cloud). Must `@import`/inline the shared density helpers — copy `worldToWeatherUV`, `cloudDensity`, `fbmNoise`, `valueNoise`, `hash3`, `hash33`, `worleyF1` (these are self-contained in the source today) into the compute shader, reading a compute-side `CloudShadowUniforms` (sunDirection, planetRadius, cloudLayerBottom/Top, coverage, weatherStrength, weatherTexBounds, windDirection/windSpeed/time, densityMultiplier, absorptionCoeff, weatherMapEnabled).
  - **`WebGPUProceduralCloudRenderer.ts`**: produce the shadow texture. Add `shadowTexture`/`shadowView`/`shadowUniformBuffer`/`shadowPipeline`/`shadowBindGroupLayout` + `shadowSampler` to `CloudCache`; add `executeCloudShadowPass(device, cache, frameState, globe)` that packs the compute uniforms (reusing the same source values already packed for the render uniforms — sun, layer radii, coverage, weatherStrength, weatherTexBounds, wind, time, density) and dispatches `ceil(256/8) × ceil(128/8)` workgroups into `shadowTexture`. Export `getCloudShadowView(context): GPUTextureView | null` and `getCloudShadowBounds(context)` so the globe renderer can fetch them. Gate the pass on `globe.showProceduralClouds && globe.cloudShadowsOnGround === true` (new flag, default false).
  - **`WebGPUEffectsBindGroup.js`**: extend the effects BGL with **binding 23** = `texture(23, Stage.FRAGMENT, {sampleType:"float"})` (cloud-shadow R-tex) and **binding 24** = `sampler(24, Stage.FRAGMENT)`; add a 1×1 white (R=1.0) placeholder bound at 23/24 in `getPlaceholderEffects` AND in `createEffectsBindGroup`. Grow `EFFECTS_UNIFORM_SIZE` 480→496 (add `cloudShadowControl: vec4<f32>` at offset 480 = float 120: x=enable, yzww=weatherTexBounds-derived lon/lat min+range OR keep bounds in xyzw and enable folded into a 5th slot — use TWO vec4s 480→512 to hold `cloudShadowControl`(x=enable, y=darkness) + `cloudShadowBounds`(minLon,minLat,lonRange,latRange); `EFFECTS_UNIFORM_SIZE` 480→512). Add `CLOUD_SHADOW_CONTROL_OFFSET = 120`, `CLOUD_SHADOW_BOUNDS_OFFSET = 124`. Thread an `options.cloudShadow = {enabled, view, sampler, bounds, darkness}` param through `createEffectsBindGroup` (wired from the globe renderer).
  - **`GlobeTerrain.wgsl`**: add `cloudShadowControl: vec4<f32>` + `cloudShadowBounds: vec4<f32>` to the `EffectsUniforms` struct tail (after `pointLightPositionWC`), declare `@group(3) @binding(23) var cloudShadowTex: texture_2d<f32>;` + `@group(3) @binding(24) var cloudShadowSampler: sampler;`. Add `fn sampleCloudShadow(positionWC: vec3<f32>) -> f32` that computes lon/lat→UV from `effects.cloudShadowBounds` (same equirect math as `worldToWeatherUV`) and returns the sampled R. In `fragmentMain`, gated on `effects.cloudShadowControl.x > 0.5`, multiply the lit `color` by `mix(1.0, sampleCloudShadow(input.v_positionMC), effects.cloudShadowControl.y)` immediately AFTER the existing `color = color * shadowFactor;` (line 3510).
  - **`WebGPUGlobeSurfaceRenderer.ts`** (and/or `WebGPUGlobeSurfaceCameraUB.ts`/the effects-BG call site): pass `cloudShadow` into `createEffectsBindGroup` by fetching `getCloudShadowView(context)` + bounds when `globe.cloudShadowsOnGround`.
  - **New `probe-cloud-shadow.mjs`**, **FEATURE_INVENTORY** move W12 from §C/§D Scene-integration to §B.3, and a one-line **DEBUGGING_GUIDE.md** entry.
- Exact files (edit/new):
  - NEW `packages/engine/Source/Shaders/WebGPU/Environment/CloudShadowMap.wgsl`
  - EDIT `packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`
  - EDIT `packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js`
  - EDIT `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl`
  - EDIT `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts` (effects-BG call site)
  - NEW `Tools/visual-regression/probe-cloud-shadow.mjs`; EDIT `migration_doc/FEATURE_INVENTORY.md`, `migration_doc/DEBUGGING_GUIDE.md`
- Shader changes:
  - `CloudShadowMap.wgsl`: new `@compute @workgroup_size(8,8)` `main`; inline copies of `worldToWeatherUV`, `cloudDensity`, `fbmNoise`, `valueNoise`, `hash3`, `hash33`, `worleyF1` from `ProceduralClouds.wgsl` lines 88-213; write `textureStore(shadowTexOut, gid.xy, vec4(shadowFactor,0,0,1))`.
  - `GlobeTerrain.wgsl`: new `sampleCloudShadow` fn; struct fields appended to `EffectsUniforms` (after line 397); new bindings 23/24 after line 455; the darken multiply inserted after line 3510.
- Uniform/struct + JS packer: byte-locked.
  - `EffectsUniforms` (WebGPUEffectsBindGroup.js): current `EFFECTS_UNIFORM_SIZE = 480` (120 floats). New = **512** (128 floats). New fields: `cloudShadowControl` at byte 480 (float 120; x=enable, y=darkness 0..1), `cloudShadowBounds` at byte 496 (float 124; minLon,minLat,lonRange,latRange radians). Packer writes them in `createEffectsBindGroup` from `options.cloudShadow`. WGSL `EffectsUniforms` gains the two matching `vec4<f32>` at the tail.
  - `CloudShadowUniforms` (new, in `WebGPUProceduralCloudRenderer.ts`): a fresh ~24-float buffer (sunDirection.xyz + time, planetRadius + bottom + top + coverage, weatherStrength + weatherMapEnabled + densityMultiplier + absorptionCoeff, windDirection.xy + windSpeed + lightSteps, weatherTexBounds.xyzw) — independent of the 80-float render uniform; NO change to `CLOUD_UNIFORM_FLOATS` (stays 80). Floats 72-79 of the render `CloudUniforms` are untouched here.
- BGL / bind-group:
  - Compute pass BGL (new, in cloud renderer): binding 0 `uniformBuffer(0, COMPUTE)`, binding 1 `texture(1, COMPUTE, {viewDimension:"2d-array"})` (weather tex), binding 2 `sampler(2, COMPUTE)`, binding 3 storage `textureStorage(3, COMPUTE, {format:"rgba8unorm", access:"write-only"})` (shadow out). Shadow texture: 256×128 `rgba8unorm`, usage `STORAGE_BINDING | TEXTURE_BINDING`.
  - Effects group 3 (shared globe BGL): NEW binding 23 (texture, FRAGMENT, float) + binding 24 (sampler, FRAGMENT).
- Probe: `probe-cloud-shadow.mjs`. Scene: camera at lon -95 lat 39 height ~120 000 m, pitch -50 (look down at terrain), `globe.showProceduralClouds=true`, `globe.cloudWeatherMap=true`, `globe.cloudShadowsOnGround=true`, `coverage 0.6`, noon sun (`timeIso 2026-06-21T18:20:00Z`), lighting on. Capture WebGPU PNG with shadows ON vs a second PNG with `cloudShadowsOnGround=false`. Pass thresholds: mean ground luminance with shadows ON must be **≥ 6% lower** than OFF (cloud cover darkens ground), AND luminance **variance/stddev ON must be ≥ 1.3× OFF** (patchy shadows, not a uniform global dim). READ `output/cloud-shadow/cloudshadow-on.png` — look for darker irregular patches on the terrain that spatially correlate with cloud cover above; gaps stay bright.
- Depends on / sequence: none hard (the weather-map seam is already shipped). Best AFTER W2/W3 (lighting) so the darkening reads against properly lit ground, but technically independent.
- Risk / gotcha: the single biggest risk is the equirect UV math drifting between the compute producer and the globe consumer — the compute shader keys texels by `(lon,lat)` and the globe samples by `worldToWeatherUV`-style math; if the `v` flip or bounds differ, shadows land in the wrong hemisphere. Pin BOTH to the exact `worldToWeatherUV` formula (line 162-170: `v = 1.0 - (lat - minLat)/latRange`) and pass identical `cloudShadowBounds`.

---

### W13 — God-ray / crepuscular integration with clouds
- Goal: Feed a screen-space cloud-transmittance buffer into the god-ray generate pass so light shafts emanate from gaps between clouds, not just the hard sun disk.
- Bundled work (everything in this single commit):
  - **`ProceduralClouds.wgsl`**: add a SECOND color attachment to `fragmentMain` so the cloud pass exports per-pixel transmittance. Change the return type to a struct `struct CloudOutput { @location(0) color: vec4<f32>, @location(1) transmittance: vec4<f32> }`; write `out.transmittance = vec4<f32>(transmittance, transmittance, transmittance, 1.0)` (the existing `transmittance` var at line 405 — 1.0 = clear sky, →0 = opaque cloud). Where the ray misses the shell (early returns at lines 318, 341), output `transmittance = 1.0` (clear).
  - **`WebGPUProceduralCloudRenderer.ts`**: allocate a screen-res `cloudTransmittanceTexture` (`r8unorm` or canvas-format, `RENDER_ATTACHMENT | TEXTURE_BINDING`), add it as the second `colorAttachments` entry in the cloud render pass, add `targets: [{format: canvasFormat}, {format: transmittanceFormat}]` to the pipeline `fragment.targets`. Export `getCloudTransmittanceView(context): GPUTextureView | null`. Resize-aware (recreate on canvas resize). Only allocate/render the 2nd target when `globe.showProceduralClouds` — keep the single-target path for when clouds are off (or always allocate and clear to 1.0).
  - **`GodRayGenerate.wgsl`**: add `@group(0) @binding(4) var cloudTransmittanceTex: texture_2d<f32>;` and extend `GodRayUniforms` with a `cloudControl: vec4<f32>` (x = useCloudTransmittance flag, y = cloud shaft weight). In the march loop, when the flag is on, multiply each sample's `isSky`/contribution by `textureSampleLevel(cloudTransmittanceTex, texSampler, stepUV, 0).r` so cloud-occluded sky contributes less and gaps shine through.
  - **`WebGPUGodRayEffect.ts`**: extend `_generateLayout` with `texture(4, Stage.FRAGMENT)`; extend `execute()` signature to accept an optional `cloudTransmittanceView` (bound at 4, else a 1×1 white placeholder); grow `_buildUniformData` from 12→16 floats (add the `cloudControl` vec4); add `setCloudTransmittance(view, enabled, weight)`.
  - **`WebGPUPostProcessPipeline.ts`** + **`WebGPUPostProcessStageCollection.ts`**: plumb `getCloudTransmittanceView(context)` into the god-ray `execute` call (pass it through `_godRayEffect.execute`), and in the configure pass set `useCloudTransmittance` when `globe.showProceduralClouds && scene.godRayEnabled`.
  - **New `probe-cloud-godrays.mjs`**, **FEATURE_INVENTORY** move + **DEBUGGING_GUIDE.md** line.
- Exact files (edit/new):
  - EDIT `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl`
  - EDIT `packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`
  - EDIT `packages/engine/Source/Shaders/WebGPU/PostProcess/GodRayGenerate.wgsl`
  - EDIT `packages/engine/Source/Renderer/WebGPU/WebGPUGodRayEffect.ts`
  - EDIT `packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessPipeline.ts`, `packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessStageCollection.ts`
  - NEW `Tools/visual-regression/probe-cloud-godrays.mjs`; EDIT `migration_doc/FEATURE_INVENTORY.md`, `migration_doc/DEBUGGING_GUIDE.md`
- Shader changes:
  - `ProceduralClouds.wgsl`: `fragmentMain` return type `@location(0) vec4 → CloudOutput`; the three return sites (line 318 `return sceneColor;`, 341, and the final 408) become struct returns with `transmittance` set (1.0 at the two early sky returns, the live `transmittance` var at the end).
  - `GodRayGenerate.wgsl`: new binding 4, `GodRayUniforms.cloudControl`, and the per-sample multiply at line 110-113 (`sample = ... * isSky * cloudFactor`).
- Uniform/struct + JS packer: byte-locked.
  - `GodRayUniforms` (`GodRayGenerate.wgsl` + `_buildUniformData`): current 12 floats (3 vec4s: params0, params1, frustum). New = **16 floats** (4 vec4s) — append `cloudControl` vec4 (x=useCloudTransmittance 0/1, y=cloudShaftWeight default 1.0, z/w reserved). `_buildUniformData` returns `Float32Array(16)` adding the 4 trailing floats. No offset shift of existing fields.
  - Cloud render `CloudUniforms` (80 floats) is UNCHANGED — transmittance is an FS output, not a uniform.
- BGL / bind-group:
  - Cloud render pipeline: SECOND color target added (`@location(1)` transmittance); cloud BGL bindings 0-5 unchanged.
  - GodRay generate BGL: NEW binding 4 = `texture(4, Stage.FRAGMENT)` (cloud transmittance), FRAGMENT stage. Placeholder = 1×1 white (R=1.0).
- Probe: `probe-cloud-godrays.mjs`. Scene: backlit broken cloud cover — camera low (`height ~2000 m`), looking toward a low sun (dawn/dusk `timeIso 2026-06-21T12:50:00Z`), `globe.showProceduralClouds=true`, `coverage 0.55` (broken — gaps present), `scene.godRayEnabled=true`. Capture WebGPU PNG with god-ray cloud-coupling ON vs OFF (`useCloudTransmittance` toggled). Pass thresholds: the shaft region (a vertical band from the sun toward the cloud base) must show **mean luminance ≥ 8% higher** with coupling ON in the gap columns AND **lower** in the cloud-occluded columns (i.e., the variance/contrast between gap-columns and cloud-columns ON must be **≥ 1.25× OFF**) — shafts localize to gaps rather than a uniform sun glow. READ `output/cloud-godrays/godrays-on.png` — look for distinct bright shafts fanning out through the breaks in the cloud deck, dark where cloud is thick.
- Depends on / sequence: independent of W12. Pairs naturally after W1-W4 lighting (the shafts read better against warm clouds) but no hard dependency.
- Risk / gotcha: the cloud pass and the god-ray generate pass run at DIFFERENT stages — clouds composite in `executeEnvironmentalEffects` (before post-process), god rays run inside the post-process pipeline. The transmittance texture must survive between them (persistent, not transient) AND be correctly oriented (the cloud FS uses `uv = (x*0.5+0.5, 1.0-(y*0.5+0.5))` flip at line 83 while GodRay uses `(x+1)*0.5, (1-y)*0.5`). Verify the V orientation matches the god-ray sample UV or the shafts will read from the mirrored gap.

---

### W14 — Precipitation (rain/snow) gated by coverage/type
- Goal: Gate the EXISTING GPU weather-particle system (`WebGPUWeatherRenderer`) by the local weather-map coverage + genus so rain/snow only falls under raining cloud types, and auto-select rain vs snow vs none from the cloud type and altitude.
- Bundled work (everything in this single commit):
  - **`WebGPUProceduralCloudRenderer.ts`**: expose a CPU-readable sampler of the procedural weather map at the camera's lon/lat. The map data (`buildProceduralWeatherMap`) is already computed on the CPU; add a module-level cached `Uint8Array` of the last-built map + `getWeatherSampleAt(context, lon, lat): {coverage, typeY, base, densityBias} | null` that does the same equirect lookup the WGSL `worldToWeatherUV` does (bilinear over `WEATHER_TEX_W×WEATHER_TEX_H`). This is the cross-subsystem bridge — no new texture; reuse the existing weather map.
  - **`WebGPUWeatherRenderer.ts`**: in `updateWeatherParticles`, before packing `typeParams`, if `weatherConfig.gateByClouds === true` (new flag), call `getWeatherSampleAt(context, cameraLon, cameraLat)`; compute `gatedIntensity = baseIntensity * smoothstep(rainCoverageThreshold, 1.0, sample.coverage)` and derive `effectiveType`: snow when `cameraTempProxy` (camera altitude > snowAltitude OR `weatherConfig.cold`) else rain; force `gatedIntensity = 0` (skip emit) when `sample.coverage < threshold`. Pack the gated values into `typeParams.x`(type) and `typeParams.y`(intensity) at `data[16]`/`data[17]` AND into the render uniform `data[31]` (intensity) / `data[30]` (weatherType u32). When intensity is 0, skip the emit dispatch (existing pass structure) so no particles spawn.
  - **New `Precipitation.wgsl`** is NOT needed as a separate render path — the existing `WeatherParticles.js`/`WeatherParticleRender.js` compute+render shaders already draw rain/snow. The batch BUNDLES the gating logic + a doc note that precipitation rides the existing particle infra (the queue says "or fold into the cloud renderer" — folding into the gate is the lighter, correct choice). If a screen-space fallback is wanted for the no-particle path, that is out of scope for this atomic batch.
  - **`cesium-js-types.d.ts`**: extend `CesiumWeatherConfig` with optional `gateByClouds?: boolean`, `rainCoverageThreshold?: number` (default 0.55), `snowAltitude?: number`, `cold?: boolean`.
  - **`WebGPUSceneRendererEnvironmentalEffects.ts`**: ensure the weather `update` runs after the cloud pass produced/refreshed the weather map (clouds are stage 1, weather is stage 3 — ordering already correct), so `getWeatherSampleAt` reads a fresh map.
  - **New `probe-precip.mjs`**, **FEATURE_INVENTORY** move + **DEBUGGING_GUIDE.md** line.
- Exact files (edit/new):
  - EDIT `packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts` (CPU weather sampler export)
  - EDIT `packages/engine/Source/Renderer/WebGPU/WebGPUWeatherRenderer.ts` (gating in `updateWeatherParticles`)
  - EDIT `packages/engine/Source/Renderer/WebGPU/cesium-js-types.d.ts` (`CesiumWeatherConfig` fields)
  - NEW `Tools/visual-regression/probe-precip.mjs`; EDIT `migration_doc/FEATURE_INVENTORY.md`, `migration_doc/DEBUGGING_GUIDE.md`
- Shader changes: NONE required — precipitation reuses `Shaders/WebGPU/Compute/WeatherParticles.wgsl` + `WeatherParticleRender.wgsl` unchanged. (Confirm: the gate is entirely CPU-side in the uniform packer. If the type-blend per-particle is wanted in-shader later, that's a follow-up.)
- Uniform/struct + JS packer: byte-locked.
  - `WeatherParams` is 24 floats (`WEATHER_PARAMS_FLOATS = 24`). The gate writes the SAME existing lanes: `typeParams` = floats 16-19 → `data[16]` = type (0 rain / 1 snow), `data[17]` = gated intensity (0..1), `data[18]` lifetime, `data[19]` size (unchanged). No struct width change.
  - Render uniforms (`RENDER_UNIFORM_SIZE = 192`, 48 floats): `data[30]` = weatherType (u32 bit pattern), `data[31]` = gated intensity — written in `renderWeatherParticles` from the same gated values. No width change.
  - The CPU weather sample uses the existing `WEATHER_TEX_W=256 × WEATHER_TEX_H=128` map and `weatherTexBounds` (-PI, -PI/2, 2PI, PI) — no new GPU buffer.
- BGL / bind-group: none (no new bindings; the gate is CPU-side uniform packing into existing buffers).
- Probe: `probe-precip.mjs`. Scene: TWO sub-scenes captured. (A) camera over a known CLOUDY weather-map cell (`globe.showProceduralClouds=true`, `globe.cloudWeatherMap=true`, `scene.weather={enabled:true, gateByClouds:true, type:'rain'}`, camera at a lon/lat where the procedural map's R is high — pick via `getWeatherSampleAt` in the page, e.g. a cell with coverage>0.7); (B) camera over a CLEAR cell (coverage<0.2). Pass thresholds: scene A must show a **particle-count / streak-pixel metric ≥ 5%** of frame pixels carrying rain streaks (count of bright near-vertical short segments), scene B must show **≤ 0.5%** (essentially none). A cold/high variant (`cold:true` or camera height > snowAltitude) must classify `weatherType == 1` (snow) — assert via the packed type readback or a snow-vs-rain pixel-shape metric. READ `output/precip/precip-cloudy.png` (visible rain under cloud) and `output/precip/precip-clear.png` (no rain) — confirm rain appears only under the raining cell.
- Depends on / sequence: depends on the W11/W10 type channel being meaningful if genus-based snow/rain selection is wanted (the weather map's G channel = type-y is currently a flat 128). For THIS batch, derive snow/rain from camera altitude + `cold` flag (independent of W10/W11). If you want true genus→precip mapping, sequence AFTER W10 (cloud-type profiles) so the G channel carries genus; note that as a follow-up. Otherwise W14 stands alone.
- Risk / gotcha: the single most likely failure is the camera-lon/lat → weather-cell sample disagreeing with where the VOLUMETRIC clouds actually render (the GPU samples `worldToWeatherUV(samplePos)` along the ray; the CPU gate samples at the camera's ground lon/lat). Under a high oblique camera the cloud visible on screen is NOT over the camera's ground point, so rain can fall under clear sky on screen. Mitigation: sample the weather map at the camera's GROUND-projected lon/lat (camera `positionCartographic.longitude/latitude`) and document that precipitation is keyed to the cell the viewer is standing in, not the distant clouds on the horizon — keep the probe camera near-nadir over the target cell so the gate and the visible clouds coincide.

### Critical Files for Implementation
- packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl
- packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts
- packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl
- packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js
- packages/engine/Source/Renderer/WebGPU/WebGPUGodRayEffect.ts (and packages/engine/Source/Renderer/WebGPU/WebGPUWeatherRenderer.ts for W14)

---

## Arc E (render fixes) — Parity P1–P5

### P1 — NEW-WEBGPU-ATMOSPHERE-LUT-BGL-INCOMPAT (fix the "SkyAtmosphere LUT dispatch" invalid-command-buffer device error)

- **Goal:** Eliminate the genuine WebGPU device error fired at init by the atmosphere-LUT extended compute passes (`computeMultipleScattering` / `computeIrradiance`), whose explicit 6-entry bind group is bound against an incompatible `layout:"auto"`-derived pipeline layout, invalidating the `"SkyAtmosphere LUT dispatch"` command buffer.

- **Root cause (grounded):** `WebGPUAtmosphereLUT.ts:dispatchAtmosphereExtendedLUT` builds `lut.extendedBindGroup` against the explicit 6-binding `lut.extendedBindGroupLayout` (`AtmosphereLUT.wgsl @group(1) @binding(0..5)`: extParams, lutSampler, transmittanceTex, singleScatterTex, multipleScatterOutput, irradianceOutput) and binds it at `index: 1` via `host.dispatchCompute(...)`. But `dispatchCompute` (`WebGPUPerformanceManager.ts:1273-1315`) calls `computeEngine.getOrCreatePipeline(cacheKey, source, entryPoint)` with **no** `bindGroupLayouts` arg → `WebGPUComputeEngine.ts:412-417` falls to `layout: "auto"`. Under `layout:"auto"`, WGSL auto-derives each entry point's group-1 layout from only the bindings it **statically uses**: `computeMultipleScattering` (AtmosphereLUT.wgsl:337) uses bindings 0,1,2,3,**4** (never 5); `computeIrradiance` (AtmosphereLUT.wgsl:453) uses 0,1,2,3,**5** (never 4). Neither auto layout equals the explicit 6-entry `extendedBindGroupLayout`, so `setBindGroup(1, extendedBindGroup)` trips "bind group not compatible with pipeline layout" and the encoder's finished command buffer is invalid at `device.queue.submit([encoder.finish()])` (`WebGPUSkyAtmosphereRenderer.js:548`). The original two passes (`computeTransmittance`/`computeInscatter`, group 0 only) are fine — they're why every probe filters `/Atmosphere ?LUT|SkyAtmosphere|default layout/`.

- **Bundled work (single commit):**
  - WGSL fix in `AtmosphereLUT.wgsl`: make BOTH extended entry points statically reference BOTH storage outputs so their auto-derived group-1 layouts are identical to each other AND to the 6-entry `extendedBindGroupLayout`. Simplest correct form: in `computeMultipleScattering`, after the existing `textureStore(multipleScatterOutput, …)`, the irradiance store is absent — instead add a guarded no-op write to `irradianceOutput` only at an out-of-range guard so it doesn't corrupt the irradiance LUT (e.g. keep the early-out `if (gid.x >= dims.x …) { textureStore(multipleScatterOutput, …, 0); return; }` and there is no clean way to also touch irradiance without clobbering). **Preferred fix instead is on the JS side (below)** — keep WGSL untouched and supply explicit layouts so each pipeline uses the full 6-binding group-1 layout regardless of static use.
  - JS fix (the real fix): thread an explicit pipeline layout into the extended dispatch. Add a `bindGroupLayouts?` pass-through param to `WebGPUPerformanceManager.dispatchCompute` (forward it as the 4th arg to `getOrCreatePipeline`), and in `dispatchAtmosphereExtendedLUT` pass `[emptyGroup0BGL, lut.extendedBindGroupLayout]` so group 0 is an explicit empty BGL and group 1 is the full 6-entry layout. Build the empty group-0 BGL once (`makeBindGroupLayout(device, "AtmosphereLUT_Extended_Group0_Empty", [])`) and cache it on `lut`. Distinct `dispatchCompute` cacheKey is already per-entryPoint (`perfmgr:atmosphereLUT:computeMultipleScattering` etc.), so the explicit-layout pipelines cache cleanly and never collide with the sun/inscatter auto pipelines.
  - Remove the now-dead filter from probes: drop the `Atmosphere ?LUT|SkyAtmosphere|default layout` filter in `probe-fork41-occlusion-v2.mjs:230-233` and the `ATMO_LUT_RE` in `probe-polyline-appearance-logdepth.mjs:35` (and any sibling) so the gate actually asserts zero device errors.
  - New probe `probe-atmo-lut-no-device-error.mjs` (below).
  - `DEFERRED_WORK.md`: mark NEW-WEBGPU-ATMOSPHERE-LUT-BGL-INCOMPAT RESOLVED with the root cause; `FEATURE_INVENTORY.md` move if it tracks the atmosphere-LUT item.

- **Exact files (edit):**
  - `packages/engine/Source/Renderer/WebGPU/WebGPUAtmosphereLUT.ts` (`dispatchAtmosphereExtendedLUT`, ~359-434; add cached empty group-0 BGL, pass explicit layouts)
  - `packages/engine/Source/Renderer/WebGPU/WebGPUPerformanceManager.ts` (`dispatchCompute` ~1273; add `bindGroupLayouts?` param forwarded to `getOrCreatePipeline`)
  - `Tools/visual-regression/probe-fork41-occlusion-v2.mjs`, `Tools/visual-regression/probe-polyline-appearance-logdepth.mjs` (drop the filters)
  - new `Tools/visual-regression/probe-atmo-lut-no-device-error.mjs`
  - `migration_doc/DEFERRED_WORK.md`, `migration_doc/FEATURE_INVENTORY.md`

- **Shader changes:** None required if the JS explicit-layout path is taken (preferred — WGSL `.wgsl` stays byte-identical, no gulp regen of `AtmosphereLUT.js`). The `@group(1) @binding(0..5)` declarations at AtmosphereLUT.wgsl:90-95 are already correct; the bug is purely the JS `layout:"auto"` choice.

- **Uniform/struct + JS packer:** No struct/byte changes. `AtmosphereParams` (20 floats / 256-byte UBO, `WebGPUAtmosphereLUT.ts:172`) unchanged. The only JS change is the `getOrCreatePipeline` 4th arg (`bindGroupLayouts`) now being supplied for the two extended entry points.

- **BGL / bind-group:** Group 0 = new explicit EMPTY BGL (no entries) for the extended pipelines; Group 1 = existing `extendedBindGroupLayout` — `uniformBuffer(0,COMPUTE)`, `sampler(1,COMPUTE,"filtering")`, `texture(2,COMPUTE)`, `texture(3,COMPUTE)`, `storageTexture(4,COMPUTE,"rgba16float")`, `storageTexture(5,COMPUTE,"rgba16float")` (WebGPUAtmosphereLUT.ts:378-390). Pipeline layout for `computeMultipleScattering`/`computeIrradiance` = `[emptyGroup0, extendedBindGroupLayout]`. Sun/moon passes (`computeTransmittance`/`computeInscatter`) keep their existing auto layout + `AtmosphereLUT_BGL` group-0 bind group — untouched.

- **Probe:** `probe-atmo-lut-no-device-error.mjs` — boot the WebGPU viewer at a noon sky view (`scene.skyAtmosphere.show=true`, globe on, sun on); arm the WebGPU error gate (`armWebGPUDevices`/`collectGateErrors` from `lib/webgpu-error-gate.mjs`) with NO atmosphere filter; force the LUT recompute by stepping the clock so the sun direction moves (triggers `sunDirty` → extended dispatch); render ~10 frames. PASS: `gate.errors.length === 0` (specifically zero entries matching `/command buffer is invalid|bind group .* not compatible|SkyAtmosphere LUT dispatch/`). READ `atmo-lut-sky.png`: the sky must still show a normal blue gradient with limb glow (no black sky / no flat tan) — confirms the now-valid extended LUTs didn't regress sky color.

- **Depends on / sequence:** None — land first; P3 reuses the de-filtered error gate.

- **Risk / gotcha:** WGSL `layout:"auto"` for a single entry point that references only a subset of a group's bindings produces a SMALLER auto layout than the explicit BGL — so if the explicit-layout JS fix is mis-wired (e.g. forgetting the empty group-0 BGL, leaving a hole at index 0), `createComputePipeline` throws at creation. Verify the empty group-0 BGL is at array index 0 and `extendedBindGroupLayout` at index 1, matching the WGSL group numbers exactly.

### P2 — NEW-WEBGPU-DEPTHFAIL-MATERIAL (mirror the C2-23 depth-fail twin into createWebGPUMaterialCommands)

- **Goal:** Emit the depth-fail "x-ray" twin for material-appearance primitives (Entity polygon/polyline with `depthFailMaterial`, GroundPrimitive) by porting the `createWebGPUCommands` C2-23 twin into `createWebGPUMaterialCommands`, so depth-fail is no longer `PerInstanceColorAppearance`-only.

- **Bundled work (single commit):**
  - In `createWebGPUMaterialCommands`, read `primitive._depthFailAppearance` and `primitive._batchTableAttributeIndices?.depthFailColor` (mirror `createWebGPUCommands:2252-2255`).
  - Build a depth-fail pipeline using `PrimitiveDepthFailColorSource`, but with the **material vertex layout** (`vertexLayout.layout` from `getMaterialVertexLayout(shaderInfo.type)` — posHigh(3)+posLow(3)+normal+st), NOT the flat 10-float color layout. Adapt the shader: `PrimitiveDepthFailColor.wgsl` declares `@location(2) color: vec4<f32>` which material geometry lacks. Add a `//>>ifdef MATERIAL_DEPTHFAIL` variant in the WGSL whose `VertexInput` matches the material layout (location 0/1 = posHigh/posLow, location 2 = normal, location 3 = st), ignoring both — the FS still returns the uniform `material.depthFailColor`. Gate via a new `ShaderDefine` bit.
  - Per-geometry 16-byte depthFail material UB packing (mirror `createWebGPUCommands:3000-3047`: default sentinel `[1,0,0,1]`, read `batchTable.getBatchedAttribute(i, depthFailColorIndex)` with the `.red`/`.x` dual-form decode).
  - Emit the depth-fail twin command AFTER the main material command (mirror `:3130-3163`): bind `[cameraBindGroups[i], depthFailMaterialBindGroups[i], matEffectsPlaceholder.bindGroup]`, reuse the material vertex/index buffers, `pass`, `renderState: primitive.appearance?.renderState`, `_webgpuShaderType="primitiveDepthFailColor"`, `_shadowCastLayout="rte24"`. Pipeline: `depthCompare:"greater"`, `depthWriteEnabled:false`, `cullMode:"none"`, MSAA from `context._msaaSamples`.
  - Extend `probe-depthfail-appearance.mjs` with a material primitive case (below).
  - `DEFERRED_WORK.md`: mark NEW-WEBGPU-DEPTHFAIL-MATERIAL resolved; `FEATURE_INVENTORY.md` move.

- **Exact files (edit/new):**
  - `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js` (`createWebGPUMaterialCommands`, def 3751; add depthFail block alongside the camera-bindgroup loop at ~4095-4161 and the pipeline build near `createMaterialPipelineAndCache` 3496/the cache init 3778)
  - `packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveDepthFailColor.wgsl` (add the `MATERIAL_DEPTHFAIL` VertexInput variant — gulp regenerates `PrimitiveDepthFailColor.js`)
  - `Tools/visual-regression/probe-depthfail-appearance.mjs` (add material case)
  - `migration_doc/DEFERRED_WORK.md`, `migration_doc/FEATURE_INVENTORY.md`

- **Shader changes:** `PrimitiveDepthFailColor.wgsl` — wrap the existing `struct VertexInput` (location 0/1/2 = posHigh/posLow/color, lines 16-20) in `//>>ifdef MATERIAL_DEPTHFAIL` / `//>>else`, adding the material variant: `@location(0) positionHigh`, `@location(1) positionLow`, `@location(2) normal: vec3<f32>`, `@location(3) st: vec2<f32>`. `vertexMain` (103-115) drops `output.color = input.color;` under the material define (or sets a dummy). FS (`fragmentMain` 137-158) is unchanged — already returns `material.depthFailColor` (line 151), ignoring vertex color. Group layout (camera@0, material@1, effects@2) is identical between paths.

- **Uniform/struct + JS packer:** `MaterialUniforms { depthFailColor: vec4<f32> }` (16 bytes, WGSL line 45-47) is unchanged and matches the material path's group(1) `materialBindGroupLayout` (`uniformBuffer(0, VERTEX_FRAGMENT)`, line 3589-3593). The depthFail UB is its own 16-byte buffer per geometry instance `i` (NOT the material's larger MaterialUniformBuffer). New cache fields `cache.depthFailShaderModule/depthFailPipeline/depthFailMaterialBuffers[]/depthFailMaterialBindGroups[]`. No change to the material camera UB (`LIT_CAMERA_BYTES`/`FLAT_CAMERA_BYTES`); the depth-fail VS reuses the material camera bind group at group 0 — but note `PrimitiveDepthFailColor.wgsl`'s `CameraUniforms` (mvpRelativeToEye + encodedCamera + previousViewProjection + optional logDepth) must byte-match whichever camera layout the material path packed (flat vs lit). Use the FLAT camera variant of the depth-fail shader and bind the flat camera; if `isLit`, pack a parallel flat camera buffer for the twin (mirror how the color path always uses the flat depth-fail camera).

- **BGL / bind-group:** group(0) camera `uniformBuffer(0, VERTEX_FRAGMENT)`; group(1) depthFail material `uniformBuffer(0, VERTEX_FRAGMENT)` (reuse `cache.materialBindGroupLayout`); group(2) effects = `getEffectsBindGroupLayout(device)` / `getPlaceholderEffects(device).bindGroup`. Pipeline layout `[cameraBGL, materialBGL, effectsBGL]` — identical to the color-path depthFail (`:2595-2599`).

- **Probe:** extend `probe-depthfail-appearance.mjs` — add a second scene: a translucent/opaque `EntityCollection` polygon (or `Primitive` with `MaterialAppearance`) given a `depthFailMaterial` of solid RED, partially behind the existing GREY occluder, same nadir framing. PASS: WebGPU material-case `redPx > 1%` of canvas AND base material color present > 1%, AND WebGPU redPx within 0.6–1.6x of WebGL redPx (same tolerance band the existing test uses, probe lines 13-17). READ `depthfail-material-webgpu.png` vs `depthfail-material-webgl.png`: the occluded region of the material primitive must show the RED depth-fail highlight on both backends, comparable area.

- **Depends on / sequence:** Independent of P1/P3/P4/P5. Uses the C2-23 color twin (`createWebGPUCommands`) as the template — that already landed, so no dependency.

- **Risk / gotcha:** The material vertex layout differs from the flat color layout, so reusing `PrimitiveDepthFailColor.wgsl` as-is (which declares `@location(2) color`) against a material vertex buffer mismatches the pipeline vertex state → validation error or garbage. The `MATERIAL_DEPTHFAIL` VertexInput variant is mandatory; do not bind the material vertex buffer to the unmodified color-variant pipeline.

### P3 — HiZ dense-3D-tiles moving-camera A/B verification (C2-21 follow-up)

- **Goal:** Verify the now-default Hi-Z occlusion cull (`_hiZConsumeEnabled = true`) introduces no visible false-cull shimmer on a dense real 3D-tiles scene under a panning camera (the 1-frame-latency bound), and add a silhouette-dilation guard band to `OcclusionTest.wgsl` ONLY if the measured shimmer exceeds budget.

- **Bundled work (single commit):**
  - New `probe-hiz-tiles-moving.mjs` (below) — the primary deliverable; this batch is verification-first.
  - IF shimmer exceeds budget: dilate the projected screen rect in `OcclusionTest.wgsl:projectSphereToScreen` (lines 69-102) by a guard-band epsilon (grow `radiusUV` by a few texels of the sampled mip) so a sphere straddling an occluder edge under 1-frame-stale depth stays VISIBLE — turning a potential false-cull into conservative under-cull. This is the ONLY shader edit and is conditional.
  - `DEFERRED_WORK.md` / `CAMPAIGN_ROADMAP`: record the A/B result (shimmer measured ≤ budget → guard band not needed → close C2-21 follow-up; or guard band added with the measured delta).
  - Relies on P1 being landed so the error gate runs unfiltered; if P1 not yet landed, keep the atmosphere filter local to this probe.

- **Exact files (edit/new):**
  - new `Tools/visual-regression/probe-hiz-tiles-moving.mjs`
  - `packages/engine/Source/Shaders/WebGPU/Compute/OcclusionTest.wgsl` (ONLY if guard band needed — `projectSphereToScreen` 69-102)
  - `migration_doc/DEFERRED_WORK.md`, `migration_doc/CAMPAIGN_ROADMAP_2026-06.md`

- **Shader changes (conditional):** In `OcclusionTest.wgsl:projectSphereToScreen`, after computing `radiusUV` (lines 90-93), add a guard-band grow: `let guardTexels = 2.0; let guardUV = vec2<f32>(guardTexels / params.screenWidth, guardTexels / params.screenHeight); ... centerUV ± (radiusUV + guardUV)`. This widens the screen footprint so the 4-corner `maxHiZ` sample (lines 176-183) reads a slightly larger neighborhood → harder to declare OCCLUDED → fewer false culls at edges. No struct/binding change (still `OcclusionParams` at group(0) binding 0, all SOA bindings unchanged).

- **Uniform/struct + JS packer:** No change in the no-guard-band case. If guard band added: the texel count is a shader constant, no new uniform; `OcclusionParams` (group 0 binding 0) unchanged. No packer edits.

- **BGL / bind-group:** None. The HiZ dispatch (`WebGPUSceneRenderer.ts:_dispatchHiZForNextFrame` 3503) and consume (`_filterByHiZVisibility` / `_hiZConsumeEnabled` 945/3493) are read-only references for the probe.

- **Probe:** `probe-hiz-tiles-moving.mjs` — load a dense 3D-tiles set (e.g. a photogrammetry/OSM-buildings tileset), animate a horizontal pan over N≈30 frames. A/B: run twice — once with consume ON (default) and once `CesiumDebug.hiZConsume=false` (or `WebGPUSceneRenderer.setHiZConsumeEnabled(false)`), capturing a PNG per frame for each. Per matching frame, compute pixel mismatch% between ON and OFF. PASS thresholds: per-frame mismatch ≤ 0.5% AND max across the pan ≤ 1.0% (consume-ON must be near-identical to consume-OFF since dropped tiles were occluded anyway — same bound C2-21 verified: 0.007% on the synthetic scene). Zero device errors. READ the worst-mismatch frame's ON vs OFF pair: there must be NO popping silhouette / no missing building that reappears — any tile that vanishes in ON but is visible in OFF is a false-cull (FAIL → add guard band). If FAIL, re-run with the guard band and re-assert ≤ budget.

- **Depends on / sequence:** Best after P1 (clean error gate). Functionally independent — the cull is already default-on.

- **Risk / gotcha:** The 1-frame latency (`_filterByHiZVisibility` applies last frame's visibility to this frame's commands, `:3493`) means a fast pan can momentarily cull a tile that just became un-occluded → a one-frame flicker. The probe MUST capture consecutive frames during motion (not a settled frame) or it will miss the only condition that produces the shimmer; a settled-camera A/B would falsely pass.

### P4 — NEW-GROUND-ATMOSPHERE-DRAPE-LIMB-WIDTH (WGSL ground-atmosphere drape limb-width parity)

- **Goal:** Match the WGSL far-from-ground ground-atmosphere drape's limb-band width / falloff to WebGL's `GlobeFS.glsl` + `AtmosphereCommon.glsl` so the WebGPU limb halo is the same angular width as WebGL (currently the WGSL drape band is wider/narrower at the limb).

- **Bundled work (single commit):**
  - In `GlobeTerrain.wgsl` far-from-ground drape branch (3719-3866), reconcile the `transmittance`/`fadeAmount` limb falloff with WebGL. The WGSL uses `transmittanceModifier = 0.5` + `opacityForDrape` (3738-3747) then `color + groundAtmoColor * transmittance` (3768), gated by `fadeAmount = tile.groundAtmosphereControl.y` (3833) in the final `mix(color, draped, fadeAmount)` (3866). WebGL's limb width is governed by the per-vertex atmosphere opacity from `computeAtmosphereScattering` (AtmosphereCommon.glsl) and the `fade` ramp. Match the `transmittanceModifier` constant and the opacity-to-width mapping to WebGL's `GlobeFS.glsl` drape lines (the `transmittance = 0.5 + clamp(1 - opacity)` formula the WGSL comment cites at 3728 — verify the WebGL constant is exactly 0.5 and the clamp bounds match).
  - The `fadeAmount` is precomputed CPU-side; verify the JS packer that writes `groundAtmosphereControl.y` uses the same `nightFadeOutDistance`/`nightFadeInDistance` ramp WebGL uses (`tile.nightFadeOutDistance`/`nightFadeInDistance`, 3803-3805). If the CPU fade ramp endpoints differ, fix them in the globe-surface camera/tile UB packer (the producer of `groundAtmosphereControl`).
  - Reuse `probe-limb-halo-width.mjs` (below).
  - `DEFERRED_WORK.md` resolve NEW-GROUND-ATMOSPHERE-DRAPE-LIMB-WIDTH; update `SHADER_PAIRS_LOCKSTEP.md` lockstep-audit date for this paired section.

- **Exact files (edit):**
  - `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` (drape branch 3719-3866; `groundAtmosphereControl` is the UBO slot at struct line 292)
  - the JS that packs `groundAtmosphereControl.y` (the per-tile/camera UB packer — grep `groundAtmosphereControl` under `Renderer/WebGPU` for the writer) if the CPU fade ramp differs
  - `packages/engine/Source/Shaders/GlobeFS.glsl` + `AtmosphereCommon.glsl` are READ-ONLY references for the target math
  - `migration_doc/DEFERRED_WORK.md`, `migration_doc/SHADER_PAIRS_LOCKSTEP.md`

- **Shader changes:** `GlobeTerrain.wgsl` only — adjust `transmittanceModifier` (3738) and/or the `opacityForDrape` clamp (3742-3746) and/or the final `fadeAmount` mapping (3866) to match WebGL's drape limb-width. Do NOT touch the close-to-ground FOG branch or the `camera.atmosphereParams.w > 1.5` day/night darken sub-block (3793-3812) unless the limb-width regression traces there. Strip the Batch-56 debug `tile.time` visualizers (3834-3865) only if they're confirmed inert (they gate on `tile.time` 9.5e9–16.5e9 — leave in place to avoid scope creep unless they interfere).

- **Uniform/struct + JS packer:** `groundAtmosphereControl: vec4<f32>` at `TileUniforms` struct line 292: `.x` = enable flag, `.y` = fade scalar (the limb-width-relevant lane), `.z` = ground intensity (3310), `.w` = HDR flag (3713/3827). No new floats; the fix is the VALUE packed into `.y` (and the `nightFadeOutDistance`/`nightFadeInDistance` scalars at struct 244-245) matching WebGL's `fade` and `lightingFadeInDistance`/`lightingFadeOutDistance`. If only the WGSL constants change, NO packer edit; if the CPU ramp endpoints are wrong, fix the writer of `.y`.

- **BGL / bind-group:** None.

- **Probe:** reuse `probe-limb-halo-width.mjs` — orbital view of the limb (camera above `Fog.maxHeight` 800 km so FOG is off and only the GROUND_ATMOSPHERE drape applies), `globe.showGroundAtmosphere=true`. Measure the limb halo band width (radial scan from disk edge outward: count pixels from the terrain edge to where the atmospheric drape decays below a luminance threshold) on both backends. PASS: WebGPU limb band width within ±10% of WebGL's measured width (or the tolerance the probe already encodes). READ the limb crop PNGs side by side: the WebGPU drape gradient must start and fade at the same radius as WebGL — no visibly thicker/thinner halo, no hard edge.

- **Depends on / sequence:** Best after P1 (so the LUT-derived `groundAtmoColor`/opacity path is error-free — the drape samples LUT opacity via `effects.atmosphereLutControl.x > 0.5` at 3589). Otherwise independent.

- **Risk / gotcha:** The limb width depends on BOTH the per-vertex Nishita opacity (`atmosphereOpacity`/`camera.atmosphereParams.w` path, 3742-3746) AND the CPU `fadeAmount` ramp. Changing the WGSL `transmittanceModifier` alone may fix the brightness but not the width if the actual width divergence is the CPU fade-distance endpoints (`nightFadeOut/InDistance`). Bisect with the existing Batch-56 `fadeAmount` grayscale debug (`tile.time` 9.5e9–10.5e9, line 3851) to confirm whether the width is set by `.y` (CPU) or the per-fragment opacity (WGSL) before editing.

### P5 — NEW-WEBGPU-EXAG-WATER-STREAKS (high-exaggeration bright-blue water-streak parity)

- **Goal:** Remove the bright-blue glacial-lake/water streaks WebGPU renders under high vertical exaggeration where WebGL renders them muted, by matching the WGSL globe water-fragment shading to WebGL's `czm_phong` + `materialInput.waterMask` darkening.

- **Root cause (grounded, from the Batch-379/365 diagnosis):** NOT terrain-LOD (identical tile histograms), NOT atmosphere/fog (streaks persist with atmosphere off, `meanRGB(18,17,123)` ~constant), NOT `computeEnhancedOcean`'s additive highlights (zeroing `oceanContribution` left streaks unchanged). The streaks are the **base Bing imagery** of turquoise glacial lakes surviving brighter on WebGPU — WebGL feeds `materialInput.waterMask = mask` into `czm_phong` (`GlobeFS.glsl:515`) which darkens/desaturates water fragments, while the WGSL water path (`computeEnhancedOcean`, GlobeTerrain.wgsl:2066-2213) only ADDS highlights to `baseColor` and never applies the water-mask material darkening. `GlobeTerrain.wgsl:3309` literally has `matInput.waterMask = 0.0; // TODO wire from water-mask texture path`.

- **Bundled work (single commit):**
  - In `GlobeTerrain.wgsl`, apply a water-mask-gated darkening/desaturation to water fragments that mirrors WebGL's `czm_phong` water-mask path, instead of preserving full-bright base imagery. Concretely: in the `computeEnhancedOcean` final composite (2204-2212) or at the water-mask call site (3384-3394), reduce the base imagery contribution for high-mask water fragments to match WebGL's muted water (the diagnosis measured WebGL water `meanRGB ~ (167,176,198)` grey vs WebGPU `(18,17,123)` saturated blue — so WebGPU is both TOO DARK and TOO SATURATED in raw value; reconcile to the WebGL desaturated-grey water look). Wire the real `waterMask` into `matInput.waterMask` (replace the `= 0.0` TODO at 3309) if the lighting block consumes it.
  - Be careful NOT to regress the Batch-58 fix (imagery-preserving + additive highlights) for normal sea-level ocean — gate the darkening on the water-mask value AND keep the `coastBlend` smoothstep (2211).
  - Reuse `probe-exaggeration-3d.mjs` (below) and the kept `diag-exag-water-streaks-source.mjs` / `diag-exag-water-streaks-2x2.mjs` diagnostics.
  - `DEFERRED_WORK.md` resolve NEW-WEBGPU-EXAG-WATER-STREAKS; `SHADER_PAIRS_LOCKSTEP.md` re-audit the water section.

- **Exact files (edit):**
  - `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` (`computeEnhancedOcean` 2066-2213, the water-mask call site 3384-3394, and the `matInput.waterMask` TODO at 3309)
  - `packages/engine/Source/Shaders/GlobeFS.glsl` (`computeWaterColor` 785-851 + the `czm_phong` water-mask composite ~515) — READ-ONLY reference
  - `Tools/visual-regression/probe-exaggeration-3d.mjs`
  - `migration_doc/DEFERRED_WORK.md`, `migration_doc/SHADER_PAIRS_LOCKSTEP.md`

- **Shader changes:** `GlobeTerrain.wgsl` only. In `computeEnhancedOcean`, the final `return mix(baseColor, color, coastBlend)` (2211-2212) currently returns near-full base imagery for water. Replace with a WebGL-matched water material: desaturate + tonally match the water fragment toward WebGL's muted result before adding highlights (use the WebGL `computeWaterColor` structure — imagery + `diffuseHighlight + nonDiffuseHighlight + specular`, but the KEY missing piece is that WebGL's water still goes through `czm_phong` diffuse/ambient which the WGSL water path bypasses). Verify against the GlobeFS `computeWaterColor` non-HDR branch (the `vec3 color = imageryColor.rgb + ...` at line 851 and its HDR variant). The fix is likely a water-mask-gated reduction of saturation/value on `baseColor` to land water near `meanRGB(167,176,198)` at the EXAG=10 repro.

- **Uniform/struct + JS packer:** No struct/byte change. `waterMaskTranslationAndScale: vec4<f32>` (struct line 242) and `flags.x` (hasWaterMask, line 248) are already packed and consumed (3385-3387). The `waterMaskTexture`/`waterMaskSampler` at group(2) binding 0/1 (337-338) are already bound. No packer edits.

- **BGL / bind-group:** None — water-mask texture group(2) binding 0/1 already exists.

- **Probe:** reuse `probe-exaggeration-3d.mjs` at the documented repro (Himalaya, lon 86.9, lat 27.0, h 250 km, `globe.terrainExaggeration = 10` / `verticalExaggeration`). Metric: count bright-blue water-streak pixels (the diag's blue-streak metric: saturated-blue pixels in the glacial-lake valleys) on WebGPU vs WebGL. PASS: WebGPU blue-streak pixel count drops from ~2452 to within ~1.5x of WebGL's count (WebGL atmo-on ~3635 from the drape, atmo-off ~12; target WebGPU to track WebGL's muted/grey water, not stay saturated-blue), AND WebGPU water `meanRGB` moves from `(18,17,123)` toward WebGL's `~(167,176,198)`. READ the WebGPU vs WebGL EXAG=10 PNGs: the thin bright-blue streaks in the deepened valleys must be gone / muted to match WebGL. Confirm normal sea-level ocean (a separate coastal view) is unregressed (byte-stable vs its baseline) so the Batch-58 imagery-preservation isn't broken.

- **Depends on / sequence:** Best AFTER P4 (P4 also edits `GlobeTerrain.wgsl`; sequencing them avoids merge churn in the same file and lets P4's drape changes settle before P5 touches the water composite). Functionally independent otherwise.

- **Risk / gotcha:** The diagnosis already RULED OUT the two obvious suspects (`computeEnhancedOcean` additive highlights, atmosphere/fog) — so a naive "tone down the ocean highlights" change will do NOTHING (it was tried, streaks unchanged). The darkening MUST be applied to the BASE imagery / water-mask material path (the `mix(baseColor, ...)` return and the lighting block), and it must be water-mask-gated + coast-blended so it does not dim or grey-out normal land imagery or sea-level ocean — the blast radius touches every water fragment, so the no-regression check on normal ocean is mandatory.

### Critical Files for Implementation
- packages/engine/Source/Renderer/WebGPU/WebGPUAtmosphereLUT.ts
- packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js
- packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl
- packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveDepthFailColor.wgsl
- packages/engine/Source/Shaders/WebGPU/Compute/OcclusionTest.wgsl

---

## Arc E (structural + infra) — Parity P6–P11

### P6 — Collections 2D/CV morph fix (billboards/points/labels)
- Goal: Make `BillboardCollection` / `PointPrimitiveCollection` / `LabelCollection` render at the correct map location and full coverage on WebGPU in SCENE2D and COLUMBUS_VIEW (and settled-morph), matching WebGL, by repacking instance positions from the projected `_actualPosition` whenever the per-slice projection changes — closing the divergence the existing `recomputeActualPositions` + per-slice camera-UB plumbing leaves open.
- Bundled work (everything in this single commit):
  - **Root-cause the remaining divergence first** (the bones already exist): `BillboardCollection.updateMode()` → `recomputeActualPositions()` (BillboardCollection.js:1992–2031) already projects `Billboard._computeActualPosition` into `_actualPosition` for 2D/CV/MORPHING, and `packBillboardInstance` (WebGPUBillboardRenderer.js:203) already reads `bb._actualPosition || bb._position`. The per-slice MVP repack exists (`repackPerSlice = frameState.mode !== SceneMode.SCENE3D`, WebGPUBillboardRenderer.js:1212) and the coplanar-depth `noDepthTest` exists (line 1011/1473). So P6 is the *finisher*: confirm via probe which of {position re-pack staleness, RTE frame mismatch, instance-rebuild gating} still breaks each collection, then patch the failing collection(s).
  - The likely fix surface (apply to whichever the probe shows broken): the instance-buffer **full-rebuild gate** must re-pack on every 2D/CV frame that re-projects. Today `forceFullRebuild` includes `frameState.mode === SceneMode.MORPHING` and `cache._instanceSceneMode !== frameState.mode` (WebGPUBillboardRenderer.js:1247–1252) but a *settled* 2D/CV frame where the camera/projection changed without a mode flip does NOT force a re-pack, while `recomputeActualPositions` only refreshes the **dirty subset** (`_billboardsToUpdate`, BillboardCollection.js:2072–2081) — a billboard whose `_actualPosition` was projected once and never re-dirtied keeps a stale slot. Mirror the same fix into PointPrimitive + Label renderers' `forceFullRebuild` and confirm Point/Label have the equivalent `_actualPosition` projection path (point packer at WebGPUPointPrimitiveRenderer.js:162 reads `point._actualPosition || point._position`).
  - Ensure the per-slice camera-UB `repackPerSlice` branch is present and identical in all three renderers (billboard has it at line 1212; verify+add to point/label if absent).
  - Verify the coplanar `noDepthTest` 2D/CV depth-disable (WebGPUBillboardRenderer.js:461–473, `computeNoDepthTest`) is wired in all three so quads aren't z-fought-discarded against the flat map.
  - Update `probe-collections-2dcv-morph.mjs` PROBE_BASE default `8134`→`8080` (line 21) to match the campaign's dev server, OR run with `PROBE_BASE=http://localhost:8080`.
  - FEATURE_INVENTORY move of the P6 item from §C/§D into §B (§A.5 Collections, FEATURE_INVENTORY.md:198–203 region) noting 2D/CV/morph parity achieved.
- Exact files (edit):
  - `packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js`
  - `packages/engine/Source/Renderer/WebGPU/WebGPUPointPrimitiveRenderer.js`
  - `packages/engine/Source/Renderer/WebGPU/WebGPULabelRenderer.js`
  - `packages/engine/Source/Scene/BillboardCollection.js` (only if `recomputeActualPositions` must run full, not dirty-subset, in settled 2D/CV — see Risk)
  - `Tools/visual-regression/probe-collections-2dcv-morph.mjs`
  - `migration_doc/FEATURE_INVENTORY.md`
- Shader changes: none expected — this is a JS instance-packing / pipeline-gating fix. The WGSL VS already consumes RTE positions via the per-slice camera UB (`mvpRelativeToEye`). Only touch WGSL if the probe shows a 3D regression from the depth-disable, which it should not.
- Uniform/struct + JS packer: byte-locked, **no struct size change**. Billboard `FLOATS_PER_INSTANCE = 44` (WebGPUBillboardRenderer.js:78), Point `FLOATS_PER_INSTANCE = 28` (WebGPUPointPrimitiveRenderer.js:74), uniform buffers stay `UNIFORM_BUFFER_SIZE = 256`. The change is *when* `packBillboardInstance`/`packPointInstance`/`packLabelInstance` are re-invoked (via `forceFullRebuild`/`syncInstancesAndConsume`, WebGPUBillboardRenderer.js:1247–1279), not the layout. Position lanes already source `_actualPosition` (floats 0–2 high, 4–6 low after `EncodedCartesian3.fromCartesian`).
- BGL / bind-group: none — bindings unchanged (group 0: uniform@0, atlas tex@1, sampler@2, globe-depth tex@3, sampler@4 for billboard; the per-slice resolver `cache.cameraResolver` already rebinds group 0 per frustum slice).
- Probe: `Tools/visual-regression/probe-collections-2dcv-morph.mjs` (run `PROBE_BASE=http://localhost:8080`). Scene: one billboard(magenta), point(yellow), polyline(cyan), label(lime) at fixed lon/lat, camera straight-down at 1.5e6 m, morph to each of 3d/2d/cv instant, settle 120+30 frames. PASS thresholds: for **2d** and **cv**, WebGPU colored-pixel count per collection within ratio **0.7–1.4** of WebGL (`ratio = GPU/GL`, printed by the probe lines 189–192); none may be `0` or `INF` when WebGL is non-zero. READ `Tools/visual-regression/output/coll2dcv-2d-webgpu.png` and `coll2dcv-cv-webgpu.png` vs the `-webgl` PNGs: all four colored marks must appear at the **same screen position and similar size** as WebGL (no off-screen drift, no shrunk-to-nothing quads, no all-zero frame). Confirm `coll2dcv-3d-*` did NOT regress.
- Depends on / sequence: none. First parity batch; independent of W1–W14. Land before P11 (P11 regression-locks collection baselines).
- Risk / gotcha: The single most likely failure is that `recomputeActualPositions` in settled 2D/CV only refreshes the **dirty subset** (`_billboardsToUpdate`, BillboardCollection.js:2072–2081), so forcing a full instance re-pack in the renderer re-reads **stale** `_actualPosition` for non-dirty items and nothing visibly changes. If the probe still shows drift, the fix must be in `BillboardCollection.updateMode` (run the full `recomputeActualPositions` over all items, not just `_billboardsToUpdate`, when the WebGPU feature renderer is active and the slice projection changed) — which is why `BillboardCollection.js` is in scope. Do NOT disable depth in 3D (keep `less-equal`) or you re-break terrain occlusion + the 3-point clamp check.

---

### P7 — WeatherSystem API skeleton (backend-neutral WeatherField + WeatherProvider + honest WebGL degradation)
- Goal: Introduce a backend-neutral `WeatherField` data class + `WeatherProvider`/`WeatherSystem` interface so the cloud renderer reads its weather map from a swappable provider (procedural now, ERA5/GFS later) instead of inline FBM, with `showProceduralClouds` documented as a WebGPU-only no-op on WebGL — Roadmap Phase 3, contract-first.
- Bundled work (everything in this single commit):
  - NEW `packages/engine/Source/Scene/WeatherField.js` — backend-neutral data class: CPU `Uint8Array` buffer `W*H*layers*4` (default `1440×720×1`, or the renderer's current `256×128` — match `WEATHER_TEX_W/H` at WebGPUProceduralCloudRenderer.ts:33–34 to avoid a texture-size change this batch), a `version` counter, `setCell(x,y,layer,r,g,b,a)`, `setFromGrid(...)`, `getBuffer()`. MUST NOT import `Renderer/WebGPU/` or branch on `isWebGPU` (mirrors `BrightStarCatalog`/`StarFieldMath`). Channels R=coverage, G=type-y, B=base/deck, A=density-bias (matches `buildProceduralWeatherMap`, WebGPUProceduralCloudRenderer.ts:79–130 comment).
  - NEW `packages/engine/Source/Scene/WeatherProvider.js` — abstract interface mirroring `ImageryProvider`: `rectangle`, `ready`/`readyPromise`, `requestWeatherGrid(time)` → returns/fills a `WeatherField`.
  - NEW `packages/engine/Source/Scene/ProceduralWeatherProvider.js` — moves the FBM synthesis (currently `buildProceduralWeatherMap`, WebGPUProceduralCloudRenderer.ts:79) behind the provider so procedural + historical share one consumer contract.
  - NEW `packages/engine/Source/Scene/WeatherSystem.js` — stateful owner intended as `scene.weather`: holds a provider, a `WeatherField`, `update(frameState, time)`; exposes the field's buffer + version. Does NOT directly touch WebGPU — it owns data only.
  - HOOK in `WebGPUProceduralCloudRenderer.ts`: replace the `cache.weatherFilled` one-shot fill (lines 168–180) with a **version-gated** upload reading `globe._weatherField`/`scene.weather.field` buffer when present, else fall back to the existing procedural fill (keep `buildProceduralWeatherMap` as the default provider's body so default scenes are byte-identical). Add a `cache.weatherVersion` field to `CloudCache` (interface at line 36) and re-`writeTexture` only when `field.version !== cache.weatherVersion`.
  - HONEST WebGL degradation: in `Globe.js` `showProceduralClouds` JSDoc (Globe.js:404) document that the volumetric raymarcher is WebGPU-only and `showProceduralClouds` is a no-op on WebGL; the shared `WeatherField` is the documented seam for a future WebGL overlay/billboard degradation.
  - FEATURE_INVENTORY §C entry: volumetric clouds = WebGPU-only by design, weather FIELD = backend-shared, rendering parity N/A.
- Exact files (new): `Scene/WeatherField.js`, `Scene/WeatherProvider.js`, `Scene/ProceduralWeatherProvider.js`, `Scene/WeatherSystem.js`. (edit): `packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`, `packages/engine/Source/Scene/Globe.js`, `packages/engine/Source/Scene/index.js` (export the 4 new classes), `migration_doc/FEATURE_INVENTORY.md`.
- Shader changes: none. `ProceduralClouds.wgsl` already declares the weather texture (`@binding(4) weatherTex` 2d-array + `@binding(5) weatherSampler`, per roadmap line 80) and samples R/G/B/A; P7 only changes *who fills the bytes*, not the WGSL.
- Uniform/struct + JS packer: **no CloudUniforms size change** — stays `CLOUD_UNIFORM_FLOATS = 80` (WebGPUProceduralCloudRenderer.ts:30). Add one TS field `weatherVersion: number | null` to the `CloudCache` interface (line 36) and to `ensureCloudCache` (line 56), initialized `null`. The upload swaps from the `weatherFilled` boolean (line 51/168) to version comparison. No new GPU uniform lanes.
- BGL / bind-group: none — weather tex/sampler bindings 4/5 already exist; the new field just supplies the upload bytes via the existing `device.queue.writeTexture` (line 180).
- Probe: NEW `Tools/visual-regression/probe-weather-provider.mjs` (model on `probe-weather-map.mjs`, PROBE_BASE default `http://localhost:8080`). Scene: enable `globe.showProceduralClouds=true; globe.cloudWeatherMap=true`, attach `scene.weather = new WeatherSystem({ provider: new ProceduralWeatherProvider(...) })`, render. PASS: spatial coverage variance — sample a cloudy region vs a clear region crop; cloudy-crop mean non-sky luminance must exceed clear-crop by a margin (reuse `probe-weather-map.mjs`'s region-A-vs-B coverage delta, assert ≥ the same threshold it uses). Then mutate the field via a second provider instance and bump version; assert the rendered pattern CHANGES between two frames. READ `output/weather-provider-frame1.png` and `weather-provider-frame2.png`: distinct cloud patterns, no all-clear/all-overcast collapse, zero device errors.
- Depends on / sequence: independent of W1–W14 and P6/P8/P9/P10. Should land before P11 (P11 reconciles roadmap Phase 3 markers). If W10/W11 (CloudTypeProfile wiring) ship first they don't conflict — they read different uniform lanes.
- Risk / gotcha: The single most likely failure is the abstraction silently dropping the procedural default — if the version-gated upload skips the fallback when no `WeatherField` is attached, default `cloudWeatherMap` scenes go blank/clear. Keep `buildProceduralWeatherMap` as the `ProceduralWeatherProvider` body AND as the in-renderer fallback so a scene with no `scene.weather` is byte-identical to today. Also: `WeatherField.js` must not import anything under `Renderer/WebGPU/` (build-variant compat) — keep it pure data.

---

### P8 — glTF Model accurate-2D `projectTo2D` WGSL path (position2D + u_modelView2D + USE_2D)
- Goal: Add the accurate-2D projection path to the WebGPU glTF model shader so a `Model` with `projectTo2D:true` renders at the correct location in SCENE2D/COLUMBUS_VIEW, matching WebGL's `SceneMode2DPipelineStage` (`position2D` attribute + `u_modelView2D` + a `USE_2D` define), instead of using only the 3D `mvpRelativeToEye`.
- Bundled work (everything in this single commit):
  - WGSL `ModelPBRComplete.wgsl`: add a `position2D: vec3<f32>` vertex input attribute (new `@location` after the current highest, e.g. `@location(12)` — current max is featureId0 @location(8) for the FS-side VertexInput; pick the next free VS-input location), add `modelView2D: mat4x4<f32>` to `CameraUniforms` (struct at line 76), and a `//>>ifdef USE_2D` branch in the VS that computes `output.position` from the 2D model-view + the scene projection instead of `camera.mvpRelativeToEye * rte` (line 868). The default (no `USE_2D`) path stays byte-identical.
  - Model renderer `WebGPUModelRenderer.js`: in `packCameraUniforms` (line 267) pack `modelView2D` into the new `CameraUniforms` lanes when `frameState.mode !== SCENE3D` and the model has `_projectTo2D`; add a `USE_2D` ShaderDefine to the pipeline key when active; supply the `position2D` vertex buffer (computed from the 2D-projected node positions, mirroring WebGL's `SceneMode2DPipelineStage`).
  - FEATURE_INVENTORY move of MORPH-MODEL-PROJECT2D into the shipped/§B section.
- Exact files (edit): `packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl`, `packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js`, `migration_doc/FEATURE_INVENTORY.md`. (new): `Tools/visual-regression/probe-model-2d.mjs`.
- Shader changes: in `ModelPBRComplete.wgsl` — (1) extend `CameraUniforms` (line 76) with `modelView2D: mat4x4<f32>` (append after `previousViewProjection`, 16 floats / 64 bytes); (2) add `position2D` to the VS `VertexInput` (the `@location(0) positionMC` block near line 692); (3) wrap the clip-position write at line 868 (`output.position = camera.mvpRelativeToEye * vec4<f32>(rte, 1.0);`) in `//>>ifndef USE_2D` and add a `//>>ifdef USE_2D` branch using `modelView2D` × the scene projection on `position2D`. Keep `positionEC`/normals from the 3D path so lighting is unchanged.
- Uniform/struct + JS packer: byte-locked. Current `CameraUniforms` (ModelPBRComplete.wgsl:76–95) is mat4(16)+mat4(16)+mat4(16)+vec3+f32 lanes... ending with `previousViewProjection: mat4x4` — **append** `modelView2D: mat4x4<f32>` (64 bytes) as the new trailing field. Grow the model camera uniform buffer allocation in `WebGPUModelRenderer.js` accordingly (find the `cameraData` Float32Array sizing near `packCameraUniforms`, line 267/2237) by +16 floats. `packCameraUniforms` writes `modelView2D` only when 2D-active (identity otherwise so 3D is inert). New `USE_2D` bit added to `ShaderDefine`.
- BGL / bind-group: none — `modelView2D` rides in the existing `@group(0) @binding(0) var<uniform> camera` buffer (line 344). The `position2D` data is a new **vertex buffer**, not a bind group. Only the vertex-buffer layout list grows by one attribute under `USE_2D`.
- Probe: NEW `Tools/visual-regression/probe-model-2d.mjs` (PROBE_BASE default `http://localhost:8080`), run on BOTH `webgl` and `webgpu`. Scene: load a small glTF (e.g. a box/duck) at a known lon/lat with `projectTo2D:true`, `morphTo2D(0)`, camera straight-down, settle. PASS: non-background pixel-coverage of the model crop on WebGPU within ratio **0.7–1.4** of WebGL, and the model's centroid screen-position within **~10 px** of WebGL's. READ `output/model-2d-webgpu.png` vs `model-2d-webgl.png`: model appears at the same map location, not at the 3D ECEF position or off-screen. Confirm a 3D capture is unchanged (no regression in `probe-model-pbr-audit.mjs` baseline).
- Depends on / sequence: independent of P6/P7/cloud arcs. Land before P11. Reuses the same SceneMode plumbing P6 exercises but does not depend on P6.
- Risk / gotcha: The single most likely failure is the `USE_2D` branch double-applying RTE — the 2D path must NOT reuse the `rte = instTrans - encodedCamera + positionMC` cancellation (line 864) which is built for the 3D `mvpRelativeToEye` frame. The 2D `modelView2D` expects raw projected `position2D`; mixing the two frames drifts the model by continental distances. Gate cleanly with `//>>ifdef`/`//>>ifndef` so exactly one path writes `output.position`.

---

### P9 — WGSLShaderPreprocessor.ts `@private`→`@internal` TS-debt
- Goal: Correct the 5 redundant `@private` JSDoc tags on `WGSLShaderPreprocessor`'s TS-`private` helper methods to `@internal` (TSDoc-accurate; these are class-internal, not API), keeping the build/typecheck green.
- Bundled work (everything in this single commit):
  - Change `@private` → `@internal` in the JSDoc blocks for the five methods: `_indexCsmIdentifiers` (line 226), `_findAutoImports` (line 540), `_resolveDependencies` (line 586), `_topologicalSort` (line 698), `_processConditionals` (line 760). All five are already TS `private` methods called only intra-class (`this._...`, lines 153/321/375/543/546/571/692) — no external callers exist (verified: only the generated `Build/Specs/SpecList.js` mirror references them).
  - **Honest scope note for the executor:** the queue text also says "drop the now-unneeded `as`-casts at call sites." Grep finds **no `as`-casts** reaching these methods anywhere in `packages/`, `Specs/`, `Tools/` — the only nearby casts are unrelated (`uniformState as unknown as ...` in WebGPUBufferPrimitiveRenderer.ts:288; `(wrapped as any)` in WebGPUShaderCache.ts:398). So this batch is purely the 5 JSDoc-tag edits; there are no as-casts to drop. If the executor finds a cast during build, remove it, but none is expected.
- Exact files (edit): `packages/engine/Source/Renderer/WebGPU/WGSLShaderPreprocessor.ts`.
- Shader changes: none (TS-only).
- Uniform/struct + JS packer: none.
- BGL / bind-group: none.
- Probe: no Playwright probe. Verification = `npx tsc --noEmit` clean and `npx gulp build` green. Optionally re-run any one existing collection probe to confirm no shader-resolution regression (the preprocessor compiles every WGSL), e.g. `probe-collections-2dcv-morph.mjs` renders non-zero.
- Depends on / sequence: fully independent; can land any time. Smallest batch.
- Risk / gotcha: The single most likely failure is the executor over-reaching on the (non-existent) "as-cast" half of the task and editing unrelated casts, breaking a type. Treat the cast removal as a no-op unless the build specifically demands it.

---

### P10 — FEATURE_RENDERER_ONBOARDING.md (refresh, not net-new)
- Goal: Refresh and complete the existing `migration_doc/FEATURE_RENDERER_ONBOARDING.md` (already 303 lines, already cross-linked from README:31) so the contract / template / registration site / Scene integration / backend-parity checklist reflect current code (FeatureRendererKey values, eager vs lazy registration, marker FRs, compat exemption).
- Bundled work (everything in this single commit):
  - The doc **already exists** (303 lines, headings: What an FR is / registry data model / 8 steps / Checklist) — P10 is a *reconciliation pass*, not authoring from scratch. Verify each cited symbol against code: `FeatureRendererKey` numbering (FeatureRendererKey.js — PROCEDURAL_CLOUDS=32, CLOUD_COLLECTION=3, POINT_CLOUD=17), eager `registerFeatureRenderer` vs lazy `registerFeatureRendererLoader` (WebGPUFeatureRenderers.ts:810–815 cloud loader is the canonical lazy example), the `execute(context, frameState, ...)` signature (match `executeProceduralClouds`, WebGPUProceduralCloudRenderer.ts:331), and the Scene dispatch via `context.getFeatureRenderer(key)` (WebGPUSceneRendererEnvironmentalEffects.ts:82–98).
  - Add/refresh the **backend-parity checklist** section to reference the WebGL-degradation-by-design pattern P7 establishes (volumetric = WebGPU-only, shared data field = backend-neutral).
  - Confirm the README link (migration_doc/README.md:31) still resolves and the description matches.
- Exact files (edit): `migration_doc/FEATURE_RENDERER_ONBOARDING.md`, and if any description drifted, `migration_doc/README.md`.
- Shader changes: none.
- Uniform/struct + JS packer: none.
- BGL / bind-group: none.
- Probe: no Playwright probe. Verify markdown lints clean (the repo's markdownlint/prettier pass per Batch 243 CI gate) and the README cross-link resolves.
- Depends on / sequence: best AFTER P7 lands so the WebGL-degradation pattern it documents is real. Otherwise independent.
- Risk / gotcha: The single most likely failure is documenting an `execute` signature or registration call that has drifted — open WebGPUFeatureRenderers.ts and WebGPUProceduralCloudRenderer.ts and copy the *actual* current signatures; do not write from the old doc's memory.

---

### P11 — Weather-visual baselines + FEATURE_INVENTORY/roadmap/DEFERRED reconciliation
- Goal: Regression-lock the shipped Arc A–D weather work by refreshing `probe-cloud-tour.mjs` baselines, and make the load-bearing docs honest — move shipped W/P items into the right inventory section, advance roadmap phase markers, prune closed DEFERRED entries, and register each new probe.
- Bundled work (everything in this single commit):
  - Refresh/capture baselines for `Tools/visual-regression/probe-cloud-tour.mjs` (and any new per-feature probes that shipped: `probe-cloud-phase`, `-ambient`, `-tod`, `-aerial`, `-detail`, `-types`, `-multideck`, `-shadow`, `-godrays`, `-precip`, plus `probe-weather-provider.mjs` from P7) under `Tools/visual-regression/` so the tour runs green against fresh references.
  - `migration_doc/FEATURE_INVENTORY.md`: move shipped W1–W14 cloud items from §C/§D into §B, and confirm P6/P7/P8 moves landed (don't double-move if those batches already did it).
  - `migration_doc/WEATHER_RECREATION_ROADMAP.md`: advance the Phase markers — mark Phase 3 (WeatherSystem API) shipped if P7 landed, and check Phase 1/2 box state against W1–W14.
  - `migration_doc/DEBUGGING_GUIDE.md`: add a one-line entry per new probe (filename + what it asserts + which PNG to read).
  - `migration_doc/DEFERRED_WORK.md`: prune entries closed by Campaign 3 (collections 2D/CV → closed by P6, model 2D → closed by P8, WeatherSystem → closed by P7, preprocessor TS-debt → closed by P9).
- Exact files (edit): baselines under `Tools/visual-regression/` (and its `output/` reference set), `migration_doc/DEBUGGING_GUIDE.md`, `migration_doc/FEATURE_INVENTORY.md`, `migration_doc/WEATHER_RECREATION_ROADMAP.md`, `migration_doc/DEFERRED_WORK.md`.
- Shader changes: none.
- Uniform/struct + JS packer: none.
- BGL / bind-group: none.
- Probe: `Tools/visual-regression/probe-cloud-tour.mjs` (PROBE_BASE `http://localhost:8080`) must run **green** against the freshly captured baselines (per-frame mismatch under the tour's existing tolerance). READ each tour PNG to confirm the new lighting/shape/integration is actually present (silver-lining rim, lit shadow side, distinct genera, ground shadows, god rays, precip) — not just numerically matching a stale baseline. Docs must lint clean.
- Depends on / sequence: MUST land LAST in the campaign — after all W1–W14 and P6–P10 it reconciles. Baselines are only valid once the visual features are final.
- Risk / gotcha: The single most likely failure is baking a baseline from a frame that still has a half-shipped feature (capturing before the relevant W/P batch's visual was final), permanently locking in a regression. Capture only after confirming via the per-feature probe PNG that each effect is correct, and only move an inventory item to §B if its probe actually passed in its own batch.

### Critical Files for Implementation
- packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js
- packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts
- packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl
- packages/engine/Source/Scene/BillboardCollection.js
- packages/engine/Source/Renderer/WebGPU/WGSLShaderPreprocessor.ts
