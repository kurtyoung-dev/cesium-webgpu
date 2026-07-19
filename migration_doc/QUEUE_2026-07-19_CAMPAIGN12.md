# Campaign 12 — Celestial Appearance: from "present" to "photographic"

**Status: DRAFT — NOT LAUNCHED.** Constructed 2026-07-19 at maintainer direction ("use the findings to start constructing campaign 12"). **Four maintainer decisions (Q1–Q4, §6) gate launch**; two of them (Q1 asset licensing, Q3 HDR default) change what actually gets built. Campaign 11 is the live campaign and continues to run.

**Source of truth for every claim here:** [CELESTIAL_APPEARANCE_RESEARCH_2026-07-19.md](CELESTIAL_APPEARANCE_RESEARCH_2026-07-19.md) — 8 research lanes, every load-bearing claim adversarially verified (20 of 20 heavy claims refuted and dropped; what remains survived attack).

---

## 1. Theme

> Close the last default-ON WebGPU-only celestial divergences, replace flat-disc point-source rendering with a physically-motivated glare PSF **on both backends**, upgrade the star map within the licence we already hold, and make the Sun and Moon photometrically honest.

Two hard bounds:

- **(a) Everything shader-side lands on BOTH backends** (Principle 5). The "white blobs" symptom is **shared code**, not a parity defect — `StarFieldFS.glsl:18-21` and `StarField.wgsl:140-143` are character-identical and both consume `StarFieldMath.ts`. Fixing one alone would *create* a parity gap.
- **(b) No asset enters the repo whose licence is not stated exactly** and verified public-domain or permissive-attribution. This is an MIT repo; a non-commercial asset cannot be sublicensed.

---

## 2. What already landed (do not re-scope)

| Item | Status |
|---|---|
| **`C11-176` skybox star-map fade** | ✅ **FIXED, Batch 722.** WebGPU-only `enableStarBrightnessModulation` shipped ON, halving the star map whenever the Sun was ≥ ~23.6° above the camera's local horizon. WebGL's `SkyBoxFS.glsl` (9 lines) has no such term. Measured `0.493 → 1.001` mean, star pixels `4.01% → 21.20%`. Default flipped; **capability preserved** (forcing it true still dims — the gate asserts this). Also fixed the `{0.3,4.0}` fallback curve that would have caused a **total blackout**, and annotated `enableNightSkyDimming` (zero consumers). |

**Consequence for C12:** the fade is closed. C12 inherits the *asset* problem (the map is genuinely sparse) and the *blob* problem (shared code), which are different defects.

---

## 3. Split — C11 tail vs C12

**These belong in C11's W9 tail, not here.** One-line defaults and comment corrections with an existing P1 home; they should not wait for a new campaign.

| ID | Item | Effort |
|---|---|---|
| `C11-176b` | **Moon `phaseGate` deletion** (`Moon.wgsl:345-346`) — **the same class of bug as the skybox fade**: `enableMoonPhase` defaults **true**, and `phaseFraction`/`earthshine` appear in **no GLSL file**. It is also a physical double-count — N·L against the real Simon1994 sun direction already yields the correct terminator and phase, while the extra `smoothstep(0,0.3,phaseFraction)` additionally blacks out real crescents. Requires re-baselining the Batch-517 crescent probe. | XS + re-baseline |
| `C11-176c` | **Stale-comment corrections** that actively mislead diagnosis: four comments asserting a float target + bloom that are **off by default** (`StarField.wgsl:14-16,145-146`, `StarFieldFS.glsl:23-24`, `StarFieldMath.ts:118-119`); `StarField.js:63` says "~0.34°" for `0.0042` rad (actual **0.2406°**); `SkyBox.js:49-51` calls StarField "an inert no-op" on WebGL, falsified by the WebGL twin at `Renderer/Context.js:766-788`; `LICENSE.md:1042` dead URLs. | XS |
| `C11-SEED-07` | Fold `NEW-SUN-MOON-FIDELITY` into `C11-179` — duplicate scope. | XS |

---

## 4. Waves

### W1 — Foundation and measurement (nothing visual ships; everything depends on it)

| ID | Item | Effort | Deps |
|---|---|---|---|
| `C12-01` | **Celestial gate harness** — implement metrics M1/M2/M2e/M3/M6 on the existing probe scene; emit the 14-field manifest; baseline both backends for all four gates. | M | `C11-176a` |
| `C12-02` | **Exposure-bracket capture** (1×/8×/64× stitch). **An 8-bit readback cannot measure a halo to 1e-3 of peak — the halo is exactly what the current capture discards.** Required by every PSF gate. | M | `C12-01` |
| `C12-03` | **Adapter provenance** — consume `C11-175`'s `adapter.info` logging so a PASS records which physical GPU produced it. | XS | `C11-175` |
| `C12-04` | **Sequencing audit vs `C11-79`/`C11-80`** (starfield single-submission retains star commands). C12 edits the same renderer; confirm no conflict. | XS | `C11-80` landed |

### W2 — Bright-star appearance model (the "white blobs" fix) — shader + data only, no framebuffer risk

**The mechanism, quantified:** output is `rgb = color * alpha` with `color` peaking at `HI × intensityScale = 2.0`, so it clips wherever `alpha ≥ 0.5`. With the shipped profile that is `dist ≤ ~0.53` — **the inner ~53% of the sprite radius (~28% of its area) is a flat, colourless, fully-saturated white plateau.** That is the blob. The code's own escape valve does not exist: `Scene.js:1458` `highDynamicRange = false` and `PostProcessStageCollection.js:56` `bloom.enabled = false`, so the intended overflow is destroyed by the ROP and the bloom that would have made it a halo never runs.

| ID | Item | Effort | Deps |
|---|---|---|---|
| `C12-05` | **Moffat core+wing PSF**, paired WGSL + GLSL. `I(r) = I₀[1+(r/α)²]^(−β)` — a power-law wing with constant log–log slope, which is the analytic description of "wide smooth halo over many core radii". **Includes moving the AA window from `smoothstep(1.0,0.45)` to `(1.0,0.92)` — without which the new wing is multiplied to zero and the change is inert.** Use **β ≈ 2.0–2.6**, not the ground-based-seeing 4.765: in vacuum the halo is instrument/ocular response, so the Stiles–Holladay inverse-square glare model is the right regime. | S | `C12-02` |
| `C12-06` | **Quad enlargement** driven through the existing `sizeBoost` plumbing as **halo extent, not core size**; clamp total glare diameter to 1°. Today the sprite is only ~7.5 px, of which ~4 px is plateau — the Polaris reference look is **geometrically unreachable** without this. | S | `C12-05` |
| `C12-07` | **Amplitude restructure** — stop the core saturating across half the sprite; chroma-preserving split so the core may clip white while the halo stays below 1.0 and keeps blackbody hue. **This is the increment that actually kills the blob, and it needs no HDR.** ⚠ Adding a wing to a still-clipping core makes a *bigger* blob; **do not raise `HI`** (that widens the white disc). | S | `C12-05` |
| `C12-08` | **Dynamic-range restoration** — remove the baked `FLUX_GAMMA=0.5`, keep flux linear (Pogson), move compression into an explicit exposure term. Today the true 38.4:1 flux range across rendered stars is pre-crushed to **2.70:1**, then clipped — Sirius and a 2nd-magnitude star arrive nearly identical. | M | `C12-07` |
| `C12-09` | **Catalogue depth** toward mag ~5.5 (BSC5, public domain). **Last in the wave** — before the above it just adds more blobs. Note the full 9,110-entry BSC5 is **not vendored**; this is a data ingest, not raising a constant. | M | `C12-08`, `C12-11` |
| **Gate** | **G2** — must pass identically on **both** backends (shared code). | | |

### W3 — Star-map asset (licence-gated; parallel to W2 once Q1 is answered)

**The single cheapest high-value finding in the whole sweep: the fork ships the *faintest* variant of its own star map.** SVS 3572 publishes three: `t3` — *"the Milky Way is very faint"* (**what we ship**, at 1024/face), `t4` — *"fainter"*, and `t5` — ***"the Milky Way is very bright and bright stars are large"*** at **16384×8192**. Same NASA product, same creators, **same existing `LICENSE.md:1042` entry**, US public domain.

| ID | Item | Effort | Deps |
|---|---|---|---|
| `C12-10` | **Offline bake pipeline, checked in:** `TychoSkymapII.t5_16384x08192` → **gamma-1.8 → sRGB correction** (SVS states the product is gamma 1.8 and the shipped JPEGs carry no ICC profile — decoding it as sRGB darkens and flattens it; shared by both backends, so not the parity fade but a real contributor to the absolute faint look) → six cube faces at 4096 → KTX2/BC6H. Reproducible — the current faces are a hand-edited Paint.NET downsample. | L | **Q1** |
| `C12-11` | **Seam reconciliation.** The cubemap is a threshold-mag-3.0 render with fainter stars *boosted*; the sprite pass cuts at `MAG_CUTOFF = 2.5`, so **stars ≤2.5 are drawn twice** — over-brightening exactly the stars called blobs. Moving to t5 (threshold 5.0) **widens** that overlap. Blocking for `C12-09`. | M | `C12-10` |
| `C12-12` | **VRAM/streaming policy** — 2048/face default, 4096 opt-in, KTX2 compressed (4096/face RGBA8 uncompressed ≈ 402 MB). | S | `C12-10` |
| `C12-13` | **`LICENSE.md` refresh** — live SVS URLs, exact product name + variant, verbatim credit line, current NASA terms URL. | XS | `C12-10` |
| `C12-14` | *(opportunistic)* Expose the baked cubemap as a **samplable star texture**, discharging the `C11-163` celestial-water-reflection blocker for free. | S | `C12-10` |
| **Gate** | **G3**, both backends. | | |

### W4 — Sun (depends on already-queued PP wiring)

| ID | Item | Effort | Deps |
|---|---|---|---|
| `C12-15` | **Limb darkening** in both bakes (`a₀=0.3, a₁=0.93, a₂=−0.23`; limb ≈ 30% of centre). WebGL's bake is `step(radius, u_radiusTS)` — a **binary, perfectly flat disc**. Cheapest realism win in this lane; start from the existing prototype in the unreferenced `Environment/Sun.wgsl`. | S | — |
| `C12-16` | **Inverse-square glare falloff** replacing `1-smoothstep(0,0.55,r)`, which reaches **exactly zero at 0.55 and stays there** — real glare never terminates. | S | — |
| `C12-17` | **WebGPU sun-texture format/size parity** — WebGPU hardcodes `rgba8unorm` at 256², WebGL selects HALF_FLOAT under HDR and sizes from the drawing buffer. 8-bit quantization of a smooth glow ramp bands visibly. | S–M | — |
| `C12-18` | **Reconcile bake vs screen-space halo** once `C11-160` lands: disc at true 0.53°, all halo from the PP chain. | M | `C11-160`, `C11-115` |
| `C12-19` | **True HDR sun radiance** — remove the `clamp(...,0,1)` in both bakes, retune BrightPass. ⚠ **Must be probed against both AE-on and AE-off lanes** — introducing ~10⁵ energy without that re-creates the inverse of the Batch-364 failure (the sun crushes everything else). | L | `C12-17`, `C12-18`, `C11-161` |
| **Gate** | **G4** sun half. | | |

### W5 — Moon (almost entirely shader one-liners)

| ID | Item | Effort |
|---|---|---|
| `C12-20` | **Lommel-Seeliger reflectance** — the Moon is currently a **pure Lambert sphere** (`specularStrength = 0.0`), which is why the full moon reads as a shaded ball instead of a flat bright disc. Replace `rawNdotL` with `2·NdotL/(NdotL+NdotV+ε)`; `toEyeMC` is already computed. | XS |
| `C12-21` | **Phase-dependent earthshine** — currently a **constant** with no phase term, which is physically backwards: Earth's phase from the Moon is the exact complement of the Moon's phase from Earth, so earthshine should peak at new moon and vanish at full. Multiply by `(1 − phaseFraction)`, already in the uniform block. | XS |
| `C12-22` | **Soft terminator** from the Sun's finite ~0.5° disc (±0.0044 in N·L). One `smoothstep`. | XS |
| `C12-23` | **Opposition surge** — lunar brightness rises >40% between phase angles 4° and 0°, beyond anything Lambert or Lommel-Seeliger predicts. Cheap here: for a distant decorative moon α is effectively constant across the disc, so compute once CPU-side and pass one uniform. **Zero per-pixel cost.** | S |
| `C12-24` | **NASA CGI Moon Kit albedo swap** (1k/2k). `moonSmall.jpg` is **256×128**, so the visible hemisphere is 128 texels over a ~190 px disc = **0.67 texels/px, under-resolved**. Re-opens `C4-CELESTIAL-HIRES-MOON` on corrected premises — **drop its altitude-blend half** (that would open a parity gap). | S |
| `C12-25` | **LOLA-derived normal map** for terminator relief (NASA ships displacement, not normals — offline derivation step). | M |
| **Gate** | **G4** moon half — gate the **phase curve**, not a single frame: a single image cannot distinguish Lambertian from Hapke, the full:quarter brightness ratio can. | |

**Do NOT spend effort on** libration (already exact — IAU 2000 E1–E13 series supplies physical libration implicitly and optical libration falls out of the real ephemeris) or angular size (real radius at real ephemeris distance, 32.9′ perigee / 29.5′ apogee). Both are explicit non-goals in `FEATURE_INVENTORY.md:1076-1078`.

### W6 — Adjacent: file, don't fold

| ID | Item | Effort |
|---|---|---|
| `C12-26` | **`NEW-EARTH-LIMB-AIRGLOW-EMISSION`.** The green band in the maintainer's ISS reference is O I 557.7 nm nightglow (~90–105 km); the red-orange band above is O I 630.0 nm from the F region. These are **emissive and sun-independent**. `SkyAtmosphere` is a *scattering* model whose `nightAlpha` drives the shell to zero opacity on the dark side — **there is no code path in which it could produce a limb band at night.** This is a new emissive limb shell. **File as its own row; do NOT expand `C11-176..179` to cover it.** | M–L |

---

## 5. Gates and exit

**Acceptance is measured, never eyeballed — and never by mean luminance.** Convolution with any normalized kernel preserves the mean exactly, so mip-averaging, bilinear magnification, MSAA resolve and JPEG smoothing all move **zero** on a mean diff. A tonemap shoulder is worse than mean-neutral: it can *raise* the mean while flattening the highlight tail. Every gate below is second-order.

| Gate | Covers | Headline criterion |
|---|---|---|
| **G1** | Skybox fade | Camera **on the sunlit side, Sun ≥ 25° above local horizon** — the only framing that reaches the failure state. M1 source-count ratio ≥ 0.90; RMS-contrast and P99.9−P50 ratios ∈ [0.85, 1.15]. **Mean luminance is diagnostic only and explicitly non-certifying.** |
| **G2** | White blobs | **`r_1e-3 / r_core ≥ 8`** — a Gaussian truncated at `d=1.0` cannot exceed ~1.8, so this one number separates blob from star. Plus: two agreeing log-log slopes in [−5,−2]; <25 clipped px/star; rendered brightest:faintest ≥ 15:1 (today **4:1** by construction). |
| **G3** | Asset upgrade | ≤ 2.0 arcmin/px; ≥10× sources/steradian vs the t3 baseline; median chroma ≥ 0.20 (**fails immediately under 4:2:0 JPEG**, so it doubles as the format gate); **dust-lane structure** via low-pass residual IQR ≥ 3× current. |
| **G4** | Sun + Moon | Sun: `r_1e-3/r_core ≥ 10`; angular diameter within 5% of 0.5334°; `I(0.95R)/I(0)` ∈ [0.3,0.5]. Moon: full:quarter integrated-brightness ratio must exceed the Lambertian ~3:1. |

**C12 closes when all four gates pass on both backends at HEAD, with:**

1. Every manifest attributable to a commit **and a recorded adapter pairing** (`C12-03`/`C11-175`).
2. **Zero default-ON WebGPU-only celestial multipliers remaining** — an audit asserting that for every celestial uniform gate (`enableStarBrightnessModulation`, cloud-cover occlusion, `enableMoonPhase`, `enableEarthshine`, `enableNightSkyDimming`) either a GLSL consumer exists **or** the default is off. **The exit gate closes the CLASS, not the instance** — this bug family has now produced three separate defects.
3. `FEATURE_INVENTORY.md` updated (celestial WIP §C → §B; airglow added to §D).
4. `LICENSE.md` third-party attributions current with live URLs and exact credit strings.
5. **No new `ShaderDefine` bits consumed** — the registry is exhausted, so any C12 quality toggle uses a **runtime uniform float** (the pattern `C11-163` already mandates).

---

## 6. MAINTAINER DECISIONS — ANSWERED 2026-07-19

**Q1 — Gaia-derived imagery → ANSWERED: take the t5 path.** SVS 3572 `TychoSkymapII.t5_16384x08192`. Sidesteps the CC BY-NC 3.0 IGO incompatibility entirely; same product family, already covered by `LICENSE.md:1042`. **NASA SVS 4851 Deep Star Maps is DISQUALIFIED — do not revisit.**

**Q2 — Where observed → ANSWERED: "Both while in orbit."** This is load-bearing and it *re-scopes the symptom*:

- **Measured at HEAD (post-Batch-722), WebGPU and WebGL are at parity on BOTH sides.** Night lane (`skyBrightness = 0`, so the fixed modulation is inert by construction): mean **1.002**, star pixels **0.999**, contrast 1.033, brightest-0.1% 1.064. **`secondCausePresent: false`.** Sunlit lane: mean 1.002. Evidence: `probe-skybox-star-modulation.mjs`, night + sunlit lanes.
- **Therefore the residual "faded" impression on the night side is NOT a WebGPU-vs-WebGL defect — it is ABSOLUTE faintness that both backends share**, and its cause is already identified: the fork ships **t3, the variant SVS itself describes as *"the Milky Way is very faint"***. That is exactly what `C12-10` (t5 re-bake) fixes. Two different defects were being reported as one symptom; the parity half is closed, the asset half is not.

**Q2b — NEW REQUIREMENT surfaced by the same answer:** *"I understand that looking towards the sun should dim stars near it but I am not seeing that effect either."* **This is correct physics and the fork implements the wrong model for it.** The removed `enableStarBrightnessModulation` was a **global** dim keyed to the Sun's *elevation above the camera's local horizon* — it dimmed the entire sky uniformly, including stars 180° away from the Sun. In orbit there is no atmosphere, so there is no sky glow and no global dim; what genuinely washes out stars near the Sun is **ocular / instrument glare, which is ANGULAR** — a function of each star's angular separation from the Sun, not of the Sun's elevation. So the maintainer is asking for a feature the codebase never had, while the thing that *was* there was a physically wrong stand-in for it. Filed as `C12-27`.

**Q3 — HDR default → ANSWERED: on by default only where the browser/display actually reports HDR.** Not a blanket flip. Filed as `C12-28`.

**Q4 — Seam magnitude → deferred pending explanation; `C12-11` holds the decision.** Default if unanswered: option (a), a bright-star-free cubemap bake.

### New items from these answers

| ID | Item | Effort | Wave |
|---|---|---|---|
| `C12-27` | **`NEW-ANGULAR-SOLAR-GLARE-STAR-WASHOUT`.** Dim/wash stars as a function of **angular separation from the Sun**, replacing the deleted global elevation-keyed model. Physically this is the same glare-spread function as `C12-05` (Stiles–Holladay inverse-square, `Lv(θ) ∝ 1/θ²`) applied to the *sky* rather than to a single sprite — so it should reuse that math, not invent a second curve. Must land on **both** backends (the deleted model was WebGPU-only; re-adding a WebGPU-only version would recreate the exact parity bug just fixed). Applies to both the cubemap and the sprite pass. Gate: stars at small angular separation dim measurably while stars at >90° separation are byte-identical to the no-Sun frame. | M | W2 (with the PSF work) |
| `C12-28` | **`NEW-HDR-DEFAULT-ON-HDR-CAPABLE-DISPLAYS`.** Default `highDynamicRange` from actual display capability rather than a hardcoded `false` — `window.matchMedia("(dynamic-range: high)")` (and/or `(video-dynamic-range: high)`), with the WebGPU canvas configured for extended range where supported. **Constraints:** must remain explicitly overridable by the app; must not change behaviour on SDR displays (byte-identical); and because enabling HDR engages PBR Neutral's highlight compression, `C12-07` (the chroma-preserving profile that fixes the blob **without** HDR) stays the first increment and this lands **after** it. ⚠ Do NOT switch the default tonemap operator to ACES as part of this — `acesTonemap` ends in a per-channel `clamp(0,1)` that maximizes hue-shift-to-white on exactly these pixels. | M | W4 (after `C12-07`) |

---

## 6b. Original decision text (retained for context)

### MAINTAINER DECISIONS REQUIRED BEFORE LAUNCH

**Q1 — Gaia-derived NASA imagery: acceptable or disqualified?** *(blocks `C12-10`, therefore all of W3)*
NASA SVS 4851 "Deep Star Maps 2020" is technically the best asset available (1.7 B stars, native OpenEXR, pre-split diffuse-vs-bright) — but two of its three layers are **Gaia DR2-derived**, and ESA states verbatim that Gaia data are **CC BY-NC 3.0 IGO**. Non-commercial is **incompatible with MIT**. NASA redistributes the result as public domain without marking it third-party-copyrighted; the counter-argument (raw astrometry is arguably uncopyrightable under *Feist*) is **not something engineering should rely on** — a rendered image is a creative work. **Recommendation: take the SVS 3572 t5 path instead** — same product family, same attribution, already covered by `LICENSE.md:1042`, and it directly delivers the dense Milky Way requested. **Default if unanswered: t5.**

**Q2 — Where exactly was the fade observed?** *(determines whether the Batch-722 fix is the whole answer)*
The fixed mechanism only fires when the Sun is **above the camera's local horizon** (50% dim at ≥ ~24° elevation, **zero dim at night**). If the WebGL-vs-WebGPU comparison was made on the **night side**, that bug contributed nothing and there is a second cause still at large. A saved-view URL or a rough description (day side / night side / terminator; altitude) settles it.

**Q3 — HDR default: hold at off, or opt in for celestial scenes?** *(determines whether `C12-07` is the destination or a stepping stone)*
`highDynamicRange` is false by default on both backends, which is *why* bright stars clip to an 8-bit plateau. The chroma-preserving profile (`C12-07`) fixes the blob **without** HDR — recommended first increment. The physically correct end state (halo from real HDR energy through bloom) needs HDR on, which engages PBR Neutral's highlight compression and has a broad parity blast radius across the whole PP chain. ⚠ Related trap: **do not switch the default tonemap operator to ACES to "fix the sun"** — `acesTonemap` ends in a per-channel `clamp(0,1)`, maximizing hue-shift-to-white on exactly these pixels.

**Q4 — Star-map / sprite seam magnitude.** *(blocks `C12-09` and `C12-11`)*
Either (a) bake a **bright-star-free** cubemap — more work, requires custom rendering rather than using an SVS product as-shipped, but architecturally correct and what makes "thousands of resolved stars" reachable; or (b) accept a small overlap and compensate in sprite intensities. **Recommendation: (a).**


---

## 6c. DECISION RECORD DR-01 — star-map / sprite seam (answers Q4)

**Decided 2026-07-19 by the maintainer: option (a), implemented via (c).** The cubemap carries **diffuse light only**; **every resolved star comes from the sprite catalogue**. Explicitly **CONDITIONAL ON LICENSING** — maintainer's words: *"if there are no license restrictions to doing this and shipping it."* See §6d.

### What was chosen

| Option | Description | Chosen |
|---|---|---|
| (a) | Bright-star-free texture; sprites are the sole source of resolved stars | ✅ **YES** |
| (b) | Keep stars in the texture, accept the double-draw, compensate sprite intensity | ❌ fallback — see reversal plan |
| (c) | Practical implementation of (a): low-pass the t5 bake to destroy point sources, keeping only the diffuse Milky Way | ✅ **the method** |

### Why (not just "it's cleaner")

1. **Painted stars are dead pixels.** They cannot receive *any* of the work C12 exists to do — no Moffat halo (`C12-05`), no B−V blackbody colour, and critically **no angular sun-glare** (`C12-27`), because a baked texel cannot respond to sun angle. Leaving bright stars in the texture would produce a visibly inconsistent sky: sprite stars with halos beside painted blobs without them.
2. **The double-draw over-brightens exactly the stars reported as blobs.** The texture contains every star; the sprite pass redraws the ~80 brightest on top. t5 makes this worse — SVS describes it as *"bright stars are large"*.
3. **(b) is more fragile than it looks.** SVS deliberately non-linearizes the magnitude→intensity curve (boosting faint stars for visibility). A compensation factor would be reverse-engineering a curve we do not control and which differs per variant.

### Binding scope consequence (maintainer-stated)

> *"This means we need to have the same bright star effects for WebGL & WebGPU."*

**Confirmed and binding.** This is natural rather than costly — `StarFieldFS.glsl` and `StarField.wgsl` are already character-identical and share `StarFieldMath.ts`. But it makes three things non-negotiable: every new uniform/attribute is plumbed on **both** backends in the **same** slice; **G2 must pass identically on both**; and no sprite feature may be WebGPU-only. Re-introducing a WebGPU-only celestial effect would recreate the exact bug class `C11-176` just closed (three instances and counting).

### Cost accepted

`C12-09` (catalogue extension toward mag ~6, ~5,000 stars) is **promoted from optional to load-bearing**. With the texture no longer supplying point sources, the catalogue is the *only* source of star density — the ISS-reference look now depends on it. `BrightStarCatalog.js` currently holds ~230 entries and the full 9,110-entry BSC5 is **not vendored**, so this is a real data ingest.

### REVERSAL PLAN — how to fall back to (b) after seeing results

The design is **deliberately reversible**, and the reversal is cheap because the blur is the *last* stage of the bake pipeline.

1. **Keep both bake artifacts.** `C12-10` must emit **the un-blurred cube faces as well as the blurred ones** and check in both (or make the blur a documented one-command re-run). This is the single most important reversibility requirement — **if only the blurred artifact survives, reversal costs a full re-bake.**
2. Ship the un-blurred faces; restore `MAG_CUTOFF` to the overlap value.
3. Apply a compensation factor to sprite intensity across the overlap band.
4. **Do NOT revert `C12-05/06/07`** (PSF, quad extent, amplitude restructure). Those are independent of the seam decision and improve option (b) as well.
5. **Do NOT revert `C12-27`** (angular sun-glare) for sprites; accept that texture-painted stars will not participate — that asymmetry is precisely the cost of (b).
6. Cap sprite magnitude at the texture's threshold so the extended catalogue does not double-draw faint stars.

### What would justify reversing (decide on evidence, not impression)

- The blurred Milky Way reads as a **smear** rather than granular structure — i.e. `G3`'s dust-lane metric passes but the result still looks wrong to the eye. *(Capture both bakes through G3 to compare.)*
- Sprite count required for ISS-reference density proves **prohibitive** at low altitude / wide FOV.
- The `C12-09` catalogue ingest proves materially harder than budgeted.
- Faint-star sprites **alias or twinkle** unacceptably under camera motion (sub-pixel sprites are the classic failure).

### Evidence to capture during W3 so this is decidable

- `G3` dust-lane + source-density metrics on **blurred vs un-blurred** bakes, side by side.
- The `M6` split (sprites-only vs texture-only) — already specified, and it directly measures where density comes from.
- Frame-cost delta from ~5,000 sprites on both backends.

---

## 7. Cross-campaign dependencies (do NOT double-schedule)

| Already-queued C11 ID | Interaction |
|---|---|
| **`C11-160`** sunBloom → PP wiring | **The single largest contributor to "the sun looks like a blob."** `sunBloom` defaults **true** and drives the full `SunPostProcess` chain on WebGL, but is gated off on WebGPU. WebGL ships a wide blurred halo by default; WebGPU ships the bare quad. It is a **routing** task against existing tested WGSL, not new authoring. C12 W4 depends on it. |
| **`C11-115`** sun blend → ALPHA_BLEND | RESOLVED-as-decision. Additive over a bright sky independently pushes the sun core to flat white. Do not re-open. |
| **`C11-161`** AutoExposure demand-gate | A **perf** item, not a parity fix. Do not re-scope it as a celestial cause. |
| **`C11-79` / `C11-80`** celestial retained resources / starfield single submission | **W1 — imminent.** `C11-80` retains star commands and must land before `C11-79`. **Any C12 starfield renderer change must sequence against these or it will conflict.** |
| **`C11-163`** celestial water reflection | `C12-14` would discharge its documented biggest blocker (no samplable star cubemap) for free. |

---

## 8. Scaffolding notice (Principle 7 — do NOT delete)

`Shaders/WebGPU/Environment/Sun.wgsl` is **not** the production shader (the renderer compiles an inline `SUN_SHADER_WGSL` string), but it already contains a **limb-darkening prototype**, a corona term, and a `generateSunTexture` compute entry point that would replace the CPU bake — it is a starting point for `C12-15`/`C12-17`, not dead code. The same trap applies to `Shaders/WebGPU/CubeMapPanorama.wgsl`, which has drifted from the production embedded string and still carries a "TODO: decode sRGB → linear" that **is already implemented** in the renderer. **Anyone diagnosing from the `.wgsl` files will chase already-fixed bugs.**
