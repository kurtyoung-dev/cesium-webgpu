# Campaign 12 — Celestial Appearance: from "present" to "photographic"

**Status: ✅ LAUNCHED 2026-07-23** (LD-1/LD-2 answered — see §6g). Runs under the orchestrator pattern (Opus + Fable subagents, model-matched per task) interleaved with C11 (certification HELD; body continues) and C13 (in-flight Sol work taken over by the orchestrator).

**Source of truth for every claim here:** [CELESTIAL_APPEARANCE_RESEARCH_2026-07-19.md](CELESTIAL_APPEARANCE_RESEARCH_2026-07-19.md) — 8 research lanes, every load-bearing claim adversarially verified (20 of 20 heavy claims refuted and dropped; what remains survived attack).

---

## 1. Theme

> Close the last default-ON WebGPU-only celestial divergences, replace flat-disc point-source rendering with a physically-motivated glare PSF **on both backends**, upgrade the star map **to the SVS 3572 t5 variant — cleared for this project's scope per §6f and shipped under its own documented terms in `LICENSE.md`'s Bundled Engine Assets section (never under the blanket MIT grant)**, and make the Sun and Moon photometrically honest.

⚠ **Corrected 2026-07-19.** This theme originally read *"upgrade the star map within the licence we already hold."* **That was wrong and is withdrawn.** We hold no licence for the current star map. `LICENSE.md:1042` was, at authoring, an **attribution record** — a heading, two source URLs, and a pointer to *NASA's* terms — not a grant; the only grant language in `LICENSE.md` was the Apache-2.0 boilerplate covering Cesium's own code. *(Since Batch 730 the entry is the `# Bundled Engine Assets` section at `LICENSE.md:1024-1044`, which states the assets' own terms and carves them out of the blanket grant; the old stub location carries a "Moved." tombstone at `LICENSE.md:1066`.)* The shipped `t3` faces and the proposed `t5` are the **same SVS 3572 product rendered from the same two ESA catalogues, so their legal status is identical** (see §6d). The difference between them is not rights but posture: `t3` is an inherited upstream condition predating any examination of the chain, whereas `t5` would be a new deliberate download-derive-ship **after** we documented that we understand the test. Do not let the presence of an attribution entry be read as clearance for anything.

Two hard bounds:

- **(a) Everything shader-side lands on BOTH backends** (Principle 5). The "white blobs" symptom is **shared code**, not a parity defect — `StarFieldFS.glsl:18-21` and `StarField.wgsl:140-143` are character-identical and both consume `StarFieldMath.ts`. Fixing one alone would *create* a parity gap.
- **(b) No asset enters the repo whose terms are not stated exactly** in `LICENSE.md`'s **Bundled Engine Assets** section (Batch 730), carved out of the blanket MIT grant. Under the §6f scope ruling a non-commercially-licensed asset is acceptable for THIS project; the §6f reopen triggers (redistribution, commercial use, third-party grant, downstream consumer) bind every asset admitted under this bound.

---

## 2. What already landed (do not re-scope)

| Item | Status |
|---|---|
| **`C11-176` skybox star-map fade** | ✅ **FIXED, Batch 722.** WebGPU-only `enableStarBrightnessModulation` shipped ON, halving the star map whenever the Sun was ≥ ~23.6° above the camera's local horizon. WebGL's `SkyBoxFS.glsl` (9 lines) has no such term. Measured `0.493 → 1.001` mean, star pixels `4.01% → 21.20%`. Default flipped; **capability preserved** (forcing it true still dims — the gate asserts this). Also fixed the `{0.3,4.0}` fallback curve that would have caused a **total blackout**, and annotated `enableNightSkyDimming` (zero consumers). |
| **`SkyBox.Variant` selection** | ✅ **SHIPPED, Batch 728.** `TYCHO_T3`/`TYCHO_T5` enum + `defaultVariant` + descriptor table in `SkyBox.js:219-267`. t5 is registered but **NOT BUNDLED** (jpg-hardcoded descriptor; selecting it 404s). `C12-10` fills in the asset, updates the descriptor for KTX2, and flips `defaultVariant` (a one-line change per the code's own note). |
| **`LICENSE.md` Bundled Engine Assets** | ✅ **SHIPPED, Batch 730.** Carves the skybox faces out of the blanket MIT grant (`LICENSE.md:1024-1044`) with full provenance, both credits, and the terms-position analysis; its Files line (`LICENSE.md:1030`) already covers future variants of the same SVS product. **Re-scopes `C12-13` to an extension of this section.** Note: this queue's live-section `LICENSE.md:1042` citations describe the PRE-Batch-730 stub — treat them as historical line references, not current content. |

**Consequence for C12:** the fade is closed. C12 inherits the *asset* problem (the map is genuinely sparse) and the *blob* problem (shared code), which are different defects.

---

## 3. Split — C11 tail vs C12

**These belong in C11's W9 tail, not here.** One-line defaults and comment corrections with an existing P1 home; they should not wait for a new campaign. **⚠ 2026-07-23: that home does not exist — no `C11-176b`/`C11-176c` rows were ever appended to the C11 queue, and C11 is now PAUSED, so as filed these WILL wait indefinitely, defeating the rationale. Decision at C12 launch (LD-2): pull them in as C12 W1 riders, IDs retained (recommended — `C11-176b` is open in code at HEAD (`Moon.wgsl:345-346`), gates `C12-21`/`C12-22` per the research dep table (`CELESTIAL_APPEARANCE_RESEARCH_2026-07-19.md:353-354`), and edits the same `Moon.wgsl` phase region W5 touches, so landing it BEFORE `C12-20..23` re-baselines the Batch-517 crescent probe once, not twice; Batch 730 already discharged the `LICENSE.md:1042` dead-URL bullet of `C11-176c`) — or explicitly accept they sleep until C11 resumes.**

| ID | Item | Effort |
|---|---|---|
| `C11-176b` | **Moon `phaseGate` deletion** (`Moon.wgsl:345-346`) — **the same class of bug as the skybox fade**: `enableMoonPhase` defaults **true**, and `phaseFraction`/`earthshine` appear in **no GLSL file**. It is also a physical double-count — N·L against the real Simon1994 sun direction already yields the correct terminator and phase, while the extra `smoothstep(0,0.3,phaseFraction)` additionally blacks out real crescents. Requires re-baselining the Batch-517 crescent probe. | XS + re-baseline |
| `C11-176c` | **Stale-comment corrections** that actively mislead diagnosis: four comments asserting a float target + bloom that are **off by default** (`StarField.wgsl:14-16,145-146`, `StarFieldFS.glsl:23-24`, `StarFieldMath.ts:118-119`); `StarField.js:63` says "~0.34°" for `0.0042` rad (actual **0.2406°**); `SkyBox.js:49-55` (phrase at :52) calls StarField "an inert no-op" on WebGL, falsified by the WebGL twin at `Renderer/Context.js:766-789`. *(The `LICENSE.md:1042` dead-URL sub-item was discharged by Batch 730 — live URLs at `LICENSE.md:1034-1035`, the dead JPL URL kept as a provenance note at `:1036`.)* | XS |
| `C11-SEED-07` | Fold `NEW-SUN-MOON-FIDELITY` into `C11-179` — duplicate scope. | XS |

---

## 4. Waves

### W1 — Foundation and measurement (nothing visual ships; everything depends on it)

| ID | Item | Effort | Deps |
|---|---|---|---|
| `C12-01` | **Celestial gate harness** — implement metrics M1/M2/M2e/M3/M6 on the existing probe scene; emit the 14-field manifest; baseline both backends for all four gates. **ABSORBS `C11-176a`** (never appended to the C11 queue — research-doc row only, `CELESTIAL_APPEARANCE_RESEARCH_2026-07-19.md:297`). Already landed de facto in `probe-skybox-star-modulation.mjs` (Batches 722/724): sunlit-side + night cameras, default-pair assertion, RMS-contrast + top-0.1% metrics. Still missing and owed here: M1 source census, M2e sky floor, wiring `brightPct` + the default-pair assertion into `probe-env-skybox-stars.mjs` (camera there is still NOT sun-relative, `:83-86`; `brightPct` computed at `:154` but absent from pass criteria `:293-300`), and HARD exit-code gating (`probe-skybox-star-modulation.mjs:267` exits 0 unconditionally, even on GATE FAIL). | M | ✅ **LANDED Batch 745** — `celestial-metrics.mjs` (M1-M5 pure lib, 12/12 synthetic trust-anchor spec) + `probe-celestial-gates.mjs` (M6 splits, 14-field manifest, hard exit codes, all Batch-744 probe rules) + `probe-env-skybox-stars` retrofits. **FIRST G1 RUN = RED, and the instrument is right:** default pair healthy (M1 54/53=0.981, m2b 1.023, m3 1.007) but (1) `cubemap-only` split shows **WebGL 55 vs WebGPU 0 sources — `starField.show=false` kills the ENTIRE sky on WebGPU** (binned-copy/skybox-injection coupling, `Scene.js:3740-3765` region) → filed `C12-G1F1`; (2) default-pair RMS-contrast ratio **1.488** out of band → filed `C12-G1F2` (diagnose). G1 goes green when both are fixed — do NOT tune the gate. |
| `C12-02` | **Exposure-bracket capture** (1×/8×/64× stitch). **An 8-bit readback cannot measure a halo to 1e-3 of peak — the halo is exactly what the current capture discards.** Required by every PSF gate. | M | ✅ **LANDED Batch 745** — `--bracket` mode (1×/8×/64×, HDR-lane recorded in manifest, per-pixel unclipped stitch ≈4 decades); M4/M5 wired as DIAGNOSTIC until G2/G4 bind them (per wave structure). Off-browser stitch smoke recovered a Moffat composite at M4 ratio 9.27. |
| `C12-03` | **Adapter provenance** — consume `C11-175`'s `adapter.info` logging so a PASS records which physical GPU produced it. ✅ LD-1 ANSWERED (2026-07-23): `C11-175` TRANSFERRED into this item — dep resolved, `C12-03` is READY. Half pre-exists: `powerPreference:"high-performance"` is already the default (`WebGPUContext.ts:1126`, `WebGPUDevicePool.ts:761`) and a vendor-only init log exists (`WebGPUContext.ts:1222`); the missing piece is the structured `adapter.info` record beside the WebGL `RENDERER` string. | XS | `C11-175` (pull into C12 or fold in) |
| `C12-04` | **Sequencing audit vs `C11-79`/`C11-80`** (starfield single-submission retains star commands). C12 edits the same renderer; confirm no conflict. ✅ LD-1 ANSWERED (2026-07-23): `C11-79`/`C11-80` TRANSFERRED into C12 — this row now sequences them (audit first, then C11-80 → C11-79 → the W2 renderer edits). | XS | LD-1 (answered) |
| `C12-G1F1` | **NEW-WEBGPU-CUBEMAP-ONLY-SKY-BLACK (found by G1's first run, Batch 745):** with `skyBox.show=true, starField.show=false`, WebGPU renders NO sky at all (M1: WebGL 55 vs WebGPU 0) while the default pair renders 53 — the panorama dies when the starfield toggles off. Suspect: the WebGPU binned-starfield/skybox-injection interplay (`Scene.js:3740-3765`: the renderer pushes a binned copy; the skyBox inject 'would otherwise wipe the binned copy'). A user toggling the star catalogue off on WebGPU loses the whole sky. Blocks the G1 cubemap-only split. | S | — |
| `C12-G1F2` | **G1 default-pair RMS-contrast divergence 1.488 (band [0.85,1.15]) — DIAGNOSE-FIRST.** M1/m2b/m3 all in band, so this is contrast-specific; earlier star-modulation runs at a similar view measured stddev ratio 1.045. Attribute before fixing (sprite AA? capture timing? a real shading divergence). | S (diagnosis) | `C12-G1F1` (re-measure after) |
| `C12-G2-DEF` | **G2 r_core DEFINITION PIN (orchestrator ruling at Batch 748):** the analytic spec proves r_1e-3/r_core = **11.7 ≥ 8** on the CORE-COMPONENT HWHM definition; on the measurable COMPOSITE-HWHM definition the expected value is ~5.7 and **no in-range constants under the 1° glare cap can exceed ~6-7** (worker derivation). RULING: the Edge G2 gate binds on **composite HWHM ≥ 4** (old truncated-Gaussian composite ≈1.7-2, so ≥4 separates with margin both ways); the analytic ≥8 core-component proof remains the math-layer guard in `starfield-psf.spec.mjs`. Recorded so nobody reads the change as gate-weakening: it is a definitional calibration from new information, with both numbers preserved. Also recorded: catalogue truly spans mag −1.46…5.0 (263 stars, not "~230 to 3.6"); the 3.6–5.0 tail renders below the census floor — `C12-09` re-derives `MAG_CUTOFF`+anchors together (spec fails loudly if the catalogue deepens). | — | — |
| `C12-29` | **NEW-ECLIPSE-OCCLUSION-EFFECTS (maintainer, 2026-07-24 — DEEP RESEARCH IN FLIGHT, do not implement yet).** Two screenshots recorded the defect: the sun is BINARY-CULLED behind Earth's limb (frame N: nothing; frame N+1: full glow pop-in) and lunar occlusion has NO effect at all. Wanted: eclipse-grade effects in orbit AND in atmosphere — partial-occlusion sun fade, orbital-sunrise limb glow progression, moon-shadow (umbra/penumbra) on the globe, scene-light + skyBrightness + IBL dimming by eclipse fraction, totality phenomena. Sequencing: interacts with `C12-15..19` (sun), `C11-160`/`C11-115` (transferred sun PP items), and `frameState.skyBrightness`. Research report gates the design. | L (epic; slices TBD by research) | research report |

### W2 — Bright-star appearance model (the "white blobs" fix) — shader + data only, no framebuffer risk

**The mechanism, quantified:** output is `rgb = color * alpha` with `color` peaking at `HI × intensityScale = 2.0`, so it clips wherever `alpha ≥ 0.5`. With the shipped profile that is `dist ≤ ~0.53` — **the inner ~53% of the sprite radius (~28% of its area) is a flat, colourless, fully-saturated white plateau.** That is the blob. The code's own escape valve does not exist: `Scene.js:1458` `highDynamicRange = false` and `PostProcessStageCollection.js:56` `bloom.enabled = false`, so the intended overflow is destroyed by the ROP and the bloom that would have made it a halo never runs.

| ID | Item | Effort | Deps |
|---|---|---|---|
| `C12-05` | **Moffat core+wing PSF**, paired WGSL + GLSL. `I(r) = I₀[1+(r/α)²]^(−β)` — a power-law wing with constant log–log slope, which is the analytic description of "wide smooth halo over many core radii". **Includes moving the AA window from `smoothstep(1.0,0.45)` to `(1.0,0.92)` — without which the new wing is multiplied to zero and the change is inert.** Use **β ≈ 2.0–2.6**, not the ground-based-seeing 4.765: in vacuum the halo is instrument/ocular response, so the Stiles–Holladay inverse-square glare model is the right regime. | S | `C12-02` ✅ LANDED Batch 748 — Moffat core+wing (σ=0.12, α=0.15, β=2.0, K=0.08), AA window 0.45→0.92. |
| `C12-06` | **Quad enlargement** driven through the existing `sizeBoost` plumbing as **halo extent, not core size**; clamp total glare diameter to 1°. Today the sprite is only ~7.5 px, of which ~4 px is plateau — the Polaris reference look is **geometrically unreachable** without this. | S | `C12-05` ✅ LANDED Batch 748 — sizeBoost=√I−1 capped at 0.833° glare; core px-invariant via coreScale varying (σ inversely scaled, α quad-relative — the only reading under which the item does anything; deviation recorded). |
| `C12-07` | **Amplitude restructure** — stop the core saturating across half the sprite; chroma-preserving split so the core may clip white while the halo stays below 1.0 and keeps blackbody hue. **This is the increment that actually kills the blob, and it needs no HDR.** ⚠ Adding a wing to a still-clipping core makes a *bigger* blob; **do not raise `HI`** (that widens the white disc). | S | `C12-05` ✅ LANDED Batch 748 — chroma-preserving split, haloIntensity 0.470<1 by construction; clip radius 1.21 px ≈4.6 clipped px (Sirius only). |
| `C12-08` | **Dynamic-range restoration** — remove the baked `FLUX_GAMMA=0.5`, keep flux linear (Pogson), move compression into an explicit exposure term. Today the true 38.4:1 flux range across rendered stars is pre-crushed to **2.70:1**, then clipped — Sirius and a 2nd-magnitude star arrive nearly identical. | M | `C12-07` ✅ LANDED Batch 748 — linear Pogson, EXPOSURE anchored at mag 3.6→15.3/255; math-layer range 383.7:1 (was 4:1); FLUX_GAMMA/LO/HI retired w/ ledger comment. |
| `C12-09` | **Catalogue depth** toward mag ~5.5–6 (~5,000 stars). **DR-01 (§6c) promotes this from optional to LOAD-BEARING** — with the texture no longer supplying point sources, the catalogue is the only source of star density. BSC5 provenance UNCONFIRMED (DR-02, recorded in §6d and NOT retracted with §6d's t5 reasoning); gated on ALL THREE DR-02 conditions: source from NASA HEASARC (not VizieR), vendor only RA/Dec/Vmag/B−V, re-sort under our own schema rather than shipping V/50's row order. ⚠ OPEN DECISION for the maintainer (LD-3): does the §6f scope ruling relax the DR-02 conditions? Until answered they bind. **Last in the wave** — before the above it just adds more blobs. Note the full 9,110-entry BSC5 is **not vendored**; this is a data ingest, not raising a constant. | M | `C12-08`, `C12-11` |
| `C12-27` | **Angular solar glare star-washout** — full definition §6 (Q2b). Reuses the `C12-05` Stiles–Holladay math applied to the sky; BOTH backends; both cubemap and sprite pass. | M | `C12-05` |
| **Gate** | **G2** — must pass identically on **both** backends (shared code), **including the `C12-27` criterion: stars at small angular separation from the Sun dim measurably while stars at >90° separation are byte-identical to the no-Sun frame.** | | |

### W3 — Star-map asset (Q1 ANSWERED: t5; licence RESOLVED per §6f; runs parallel to W2)

**The single cheapest high-value finding in the whole sweep: the fork ships the *faintest* variant of its own star map.** SVS 3572 publishes three: `t3` — *"the Milky Way is very faint"* (**what we ship**, at 1024/face), `t4` — *"fainter"*, and `t5` — ***"the Milky Way is very bright and bright stars are large"*** at **16384×8192**. Same NASA product, same creators, same attribution entry (now `# Bundled Engine Assets`, `LICENSE.md:1024-1044`, Batch 730 — whose Files line already covers additional `SkyBox.Variant` entries derived from the same SVS product). **Licence history: §6d ruled this wave BLOCKED (retracted), §6e revised to CONDITIONAL GO, §6f RESOLVED it 2026-07-19 — t5 is cleared for this project's scope and W3 is UNBLOCKED.** The Batch-728 `SkyBox.Variant` plumbing already registers `TYCHO_T5` (NOT YET BUNDLED — jpg-hardcoded descriptor; selecting it 404s until `C12-10` lands).

| ID | Item | Effort | Deps |
|---|---|---|---|
| `C12-10` | **Offline bake pipeline, checked in:** `TychoSkymapII.t5_16384x08192` → **gamma-1.8 → sRGB correction** (SVS states the product is gamma 1.8 and the shipped JPEGs carry no ICC profile — decoding it as sRGB darkens and flattens it; shared by both backends, so not the parity fade but a real contributor to the absolute faint look) → **DR-01 low-pass stage destroying point sources (option (a) via (c), §6c)** → six cube faces at 4096 → KTX2/BC6H. **MUST emit and check in BOTH the blurred AND un-blurred faces (or a documented one-command blur re-run) — DR-01 reversal item 1; if only the blurred artifact survives, reversal costs a full re-bake.** Update the Batch-728 `SkyBox.Variant.TYCHO_T5` descriptor (currently jpg-hardcoded to `tycho2t5_80_*.jpg`, `SkyBox.js:246`) for the KTX2 output, refresh the stale `SkyBox.js:222-232` docblock (still calls acquisition licence-gated and cites the retracted §6d; superseded by §6f), and flip `SkyBox.defaultVariant` (`SkyBox.js:267`, a documented one-line change). Reproducible — the current faces are a hand-edited Paint.NET downsample. | L | — (Q1 ANSWERED: t5, §6; licence RESOLVED, §6f) |
| `C12-11` | **Seam implementation per DR-01 (§6c — DECIDED; no open decision here).** The cubemap carries diffuse light only (bright stars removed by the `C12-10` blur); every resolved star comes from the sprite catalogue. Implement: verify the blurred bake has no resolved point sources (M6 split), extend sprite coverage to what the t5 threshold-mag-5.0 render previously painted, and capture DR-01 reversal evidence (G3 on blurred vs un-blurred bakes; ~5,000-sprite frame-cost delta on both backends). Historical context: the t3 seam double-drew stars ≤2.5 — over-brightening exactly the stars called blobs — and t5 as-shipped would have widened it; DR-01 removes the overlap by construction. Blocking for `C12-09`. | M | `C12-10` |
| `C12-12` | **VRAM/streaming policy** — 2048/face default, 4096 opt-in, KTX2 compressed (4096/face RGBA8 uncompressed ≈ 402 MB). | S | `C12-10` |
| `C12-13` | **`LICENSE.md` refresh** — ✅ largely delivered for t3 by Batch 730 (`# Bundled Engine Assets`, `LICENSE.md:1024-1044`: live SVS + NASA-guidelines URLs, exact product name + variant, both credit lines, terms position). Residual: extend the entry's **Files** line with the baked t5 faces + a t5 variant description sentence and record the KTX2 bake derivation chain when `C12-10` lands (coverage of additional `SkyBox.Variant`s from the same product is already pre-stated at `LICENSE.md:1030`). | XS | `C12-10` |
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
| `C12-28` | **HDR default on HDR-capable displays** — full definition §6 (Q3). Lands AFTER `C12-07`; app-overridable; do NOT switch default tonemap to ACES. | M | `C12-07` |
| **Gate** | **G4** sun half, **plus the `C12-28` check: byte-identical behaviour on SDR displays.** | | |

### W5 — Moon (almost entirely shader one-liners)

| ID | Item | Effort |
|---|---|---|
| `C12-20` | **Lommel-Seeliger reflectance** — the Moon is currently a **pure Lambert sphere** (`specularStrength = 0.0`), which is why the full moon reads as a shaded ball instead of a flat bright disc. Replace `rawNdotL` with `2·NdotL/(NdotL+NdotV+ε)`; `toEyeMC` is already computed. | XS |
| `C12-21` | **Phase-dependent earthshine** — currently a **constant** with no phase term, which is physically backwards: Earth's phase from the Moon is the exact complement of the Moon's phase from Earth, so earthshine should peak at new moon and vanish at full. Multiply by `(1 − phaseFraction)`, already in the uniform block. **Dep: `C11-176b` (phaseGate deletion) — land it first or the phase terms compound.** | XS |
| `C12-22` | **Soft terminator** from the Sun's finite ~0.5° disc (±0.0044 in N·L). One `smoothstep`. **Dep: `C11-176b`.** | XS |
| `C12-23` | **Opposition surge** — lunar brightness rises >40% between phase angles 4° and 0°, beyond anything Lambert or Lommel-Seeliger predicts. Cheap here: for a distant decorative moon α is effectively constant across the disc, so compute once CPU-side and pass one uniform. **Zero per-pixel cost.** | S |
| `C12-24` | **NASA CGI Moon Kit albedo swap** (1k/2k). `moonSmall.jpg` is **256×128**, so the visible hemisphere is 128 texels over a ~190 px disc = **0.67 texels/px, under-resolved**. Re-opens `C4-CELESTIAL-HIRES-MOON` on corrected premises — **drop its altitude-blend half** (that would open a parity gap). | S |
| `C12-25` | **LOLA-derived normal map** for terminator relief (NASA ships displacement, not normals — offline derivation step). | M |
| **Gate** | **G4** moon half — gate the **phase curve**, not a single frame: a single image cannot distinguish Lambertian from Hapke, the full:quarter brightness ratio can. | |

**Do NOT spend effort on** libration (already exact — IAU 2000 E1–E13 series supplies physical libration implicitly and optical libration falls out of the real ephemeris) or angular size (real radius at real ephemeris distance, 32.9′ perigee / 29.5′ apogee). Libration is an explicit non-goal at `FEATURE_INVENTORY.md:1078`; angular size is a non-goal by construction (already exact — real radius at real ephemeris distance; the inventory carries no entry for it).

### W6 — Adjacent: file, don't fold

| ID | Item | Effort |
|---|---|---|
| `C12-26` | **`NEW-EARTH-LIMB-AIRGLOW-EMISSION`.** The green band in the maintainer's ISS reference is O I 557.7 nm nightglow (~90–105 km); the red-orange band above is O I 630.0 nm from the F region. These are **emissive and sun-independent**. `SkyAtmosphere` is a *scattering* model whose `nightAlpha` drives the shell to zero opacity on the dark side — **there is no code path in which it could produce a limb band at night.** This is a new emissive limb shell. **File as its own row; do NOT expand `C11-176..179` to cover it.** | M–L |

---

## 5. Gates and exit

**Acceptance is measured, never eyeballed — and never by mean luminance.** Convolution with any normalized kernel preserves the mean exactly, so mip-averaging, bilinear magnification, MSAA resolve and JPEG smoothing all move **zero** on a mean diff. A tonemap shoulder is worse than mean-neutral: it can *raise* the mean while flattening the highlight tail. Every gate below is second-order.

| Gate | Covers | Headline criterion |
|---|---|---|
| **G1** | Skybox fade | Camera **on the sunlit side, Sun ≥ 25° above local horizon** — the only framing that reaches the failure state. M1 source-count ratio ≥ 0.90; RMS-contrast and P99.9−P50 ratios ∈ [0.85, 1.15]. **Mean luminance is diagnostic only and explicitly non-certifying.** *Expected already-green at HEAD: Batch 722 landed the fix and the §6 Q2 measurements are effectively this gate passing — G1 is held as a REGRESSION gate, baselined by `C12-01` in W1.* |
| **G2** | White blobs | **`r_1e-3 / r_core ≥ 8`** — a Gaussian truncated at `d=1.0` cannot exceed ~1.8, so this one number separates blob from star. Plus: two agreeing log-log slopes in [−5,−2]; <25 clipped px/star; rendered brightest:faintest ≥ 15:1 (today **4:1** by construction). |
| **G3** | Asset upgrade | ≤ 2.0 arcmin/px; ≥10× sources/steradian vs the t3 baseline; median chroma ≥ 0.20 (**fails immediately under 4:2:0 JPEG**, so it doubles as the format gate); **dust-lane structure** via low-pass residual IQR ≥ 3× current. |
| **G4** | Sun + Moon | Sun: `r_1e-3/r_core ≥ 10`; angular diameter within 5% of 0.5334°; `I(0.95R)/I(0)` ∈ [0.3,0.5]. Moon: full:quarter integrated-brightness ratio must exceed the Lambertian ~3:1. |

**C12 closes when all four gates pass on both backends at HEAD, with:**

1. Every manifest attributable to a commit **and a recorded adapter pairing** (`C12-03`/`C11-175`).
2. **Zero default-ON WebGPU-only celestial multipliers remaining** — an audit asserting that for every celestial uniform gate (`enableStarBrightnessModulation`, cloud-cover occlusion, `enableMoonPhase`, `enableEarthshine`, `enableNightSkyDimming`) either a GLSL consumer exists **or** the default is off. **The exit gate closes the CLASS, not the instance** — this bug family has now produced three separate defects. **C13 coordination note (2026-07-23): the cloud-cover-occlusion half of this audit inspects code now owned by Campaign 13 — run it read-only against C13's HEAD and route any fix to C13; do not double-schedule.**
3. `FEATURE_INVENTORY.md` updated (celestial WIP §C → §B; airglow added to §D).
4. `LICENSE.md` third-party attributions current with live URLs and exact credit strings.
5. **No new `ShaderDefine` bits consumed** — the registry is exhausted, so any C12 quality toggle uses a **runtime uniform float** (the pattern `C11-163` already mandates). (Consequence: `C11-149` define-width is NOT a C12 dependency; needing it would itself be a scope violation.)

---

## 6. MAINTAINER DECISIONS — ANSWERED 2026-07-19

**Q1 — Gaia-derived imagery → ANSWERED: take the t5 path.** SVS 3572 `TychoSkymapII.t5_16384x08192`. Sidesteps the CC BY-NC 3.0 IGO incompatibility entirely; same product family, already covered by the `# Bundled Engine Assets` entry (`LICENSE.md:1024-1044`, Batch 730 — its Files line at `LICENSE.md:1030` explicitly extends coverage to any `SkyBox.Variant` derived from the same SVS product). **NASA SVS 4851 Deep Star Maps is DISQUALIFIED — do not revisit.**

**Q2 — Where observed → ANSWERED: "Both while in orbit."** This is load-bearing and it *re-scopes the symptom*:

- **Measured at HEAD (post-Batch-722), WebGPU and WebGL are at parity on BOTH sides.** Night lane (`skyBrightness = 0`, so the fixed modulation is inert by construction): mean **1.002**, star pixels **0.999**, contrast 1.033, brightest-0.1% 1.064. **`secondCausePresent: false`.** Sunlit lane: mean 1.002. Evidence: `probe-skybox-star-modulation.mjs`, night + sunlit lanes.
- **Therefore the residual "faded" impression on the night side is NOT a WebGPU-vs-WebGL defect — it is ABSOLUTE faintness that both backends share**, and its cause is already identified: the fork ships **t3, the variant SVS itself describes as *"the Milky Way is very faint"***. That is exactly what `C12-10` (t5 re-bake) fixes. Two different defects were being reported as one symptom; the parity half is closed, the asset half is not.

**Q2b — NEW REQUIREMENT surfaced by the same answer:** *"I understand that looking towards the sun should dim stars near it but I am not seeing that effect either."* **This is correct physics and the fork implements the wrong model for it.** The removed `enableStarBrightnessModulation` was a **global** dim keyed to the Sun's *elevation above the camera's local horizon* — it dimmed the entire sky uniformly, including stars 180° away from the Sun. In orbit there is no atmosphere, so there is no sky glow and no global dim; what genuinely washes out stars near the Sun is **ocular / instrument glare, which is ANGULAR** — a function of each star's angular separation from the Sun, not of the Sun's elevation. So the maintainer is asking for a feature the codebase never had, while the thing that *was* there was a physically wrong stand-in for it. Filed as `C12-27`.

**Q3 — HDR default → ANSWERED: on by default only where the browser/display actually reports HDR.** Not a blanket flip. Filed as `C12-28`.

**Q4 — Seam magnitude → ANSWERED: option (a) implemented via (c) — DECISION RECORD DR-01 (§6c), decided 2026-07-19 by the maintainer, with a documented reversal plan. Its licensing condition was discharged by §6f. `C12-10`/`C12-11` carry the implementation obligations; `C12-09` is promoted to load-bearing.**

### New items from these answers

| ID | Item | Effort | Wave |
|---|---|---|---|
| `C12-27` | **`NEW-ANGULAR-SOLAR-GLARE-STAR-WASHOUT`.** Dim/wash stars as a function of **angular separation from the Sun**, replacing the deleted global elevation-keyed model. Physically this is the same glare-spread function as `C12-05` (Stiles–Holladay inverse-square, `Lv(θ) ∝ 1/θ²`) applied to the *sky* rather than to a single sprite — so it should reuse that math, not invent a second curve. Must land on **both** backends (the deleted model was WebGPU-only; re-adding a WebGPU-only version would recreate the exact parity bug just fixed). Applies to both the cubemap and the sprite pass. Gate: stars at small angular separation dim measurably while stars at >90° separation are byte-identical to the no-Sun frame. | M | W2 (with the PSF work) |
| `C12-28` | **`NEW-HDR-DEFAULT-ON-HDR-CAPABLE-DISPLAYS`.** Default `highDynamicRange` from actual display capability rather than a hardcoded `false` — `window.matchMedia("(dynamic-range: high)")` (and/or `(video-dynamic-range: high)`), with the WebGPU canvas configured for extended range where supported. **Constraints:** must remain explicitly overridable by the app; must not change behaviour on SDR displays (byte-identical); and because enabling HDR engages PBR Neutral's highlight compression, `C12-07` (the chroma-preserving profile that fixes the blob **without** HDR) stays the first increment and this lands **after** it. ⚠ Do NOT switch the default tonemap operator to ACES as part of this — `acesTonemap` ends in a per-channel `clamp(0,1)` that maximizes hue-shift-to-white on exactly these pixels. | M | W4 (after `C12-07`) |

---

## 6g. LAUNCH DECISIONS — ANSWERED 2026-07-23 (maintainer)

**LD-1 — paused-C11 dependencies → TRANSFER (as recommended).** `C11-79`, `C11-80`, `C11-160`, the `C11-115` implementation (direction stays RESOLVED: ALPHA_BLEND), `C11-161`, and `C11-175` transfer into C12 with IDs retained as aliases (C13 precedent). Slotting: `C11-175`→`C12-03`; `C11-79`/`C11-80`→`C12-04` (C11-80 lands before C11-79 — it retains star commands); `C11-160`+`C11-115`-impl→`C12-18`; `C11-161`→`C12-19`. The C11 ledger rows are closed as TRANSFERRED.

**LD-2 — §3 split items → PULL IN (as recommended).** `C11-176b` and `C11-176c` become C12 W1 riders (IDs retained; 176c is in flight with the Phase-1 trio worker at time of ruling; 176b lands BEFORE `C12-20..23` so the Batch-517 crescent probe re-baselines once). `C11-SEED-07` folded into `C11-179` in the C11 queue; `C11-177`/`C11-179` deep design is C12-owned per the 2026-07-23 audit.

**LD-3 — DR-02 relaxation:** unanswered; safe default stands (the three DR-02 conditions BIND for `C12-09`: HEASARC sourcing, factual fields only, own schema).

**C12-10 STATUS: ✅ COMPLETE + VISUALLY VERIFIED (Batches 742/744).** t5 baked, bundled beside t3, default flipped; serial-Edge verification: gate PASS (backend parity mean 1.002 / contrast 1.045 / starPct identical 5.587; opt-in modulation dims to 0.477; night lane 1.002), PNGs read on both sides (crisp colored stars, true blacks, no seams). During verification a LATENT PROBE DEFECT was root-caused and fixed (Batch 744): bare `scene.render()` renders at wall-clock NOW while the widget's default loop renders at the pinned clock — two suns interleaving; exposed by Batch 734's cloud frame-demand. Probe now kills the default loop, renders at pinned time, and captures same-task. ⚠ FLEET NOTE: any probe that pins a clock AND calls bare `scene.render()` has the same latent defect — audit at next probe touch.

**C12-10 amendment (maintainer, 2026-07-23): "Yes but we want T3 available offline too."** The t5 bake must NOT displace t3: **both variants stay bundled in the repo** (t3 faces remain at `Assets/Textures/SkyBox/tycho2t3_80_*`; t5 lands beside them), both selectable via `SkyBox.Variant` with no network fetch, and `defaultVariant` flips to `TYCHO_T5` only once the t5 faces are in-tree. The Bundled Engine Assets LICENSE.md entry already covers both (its Files line spans variants of the same SVS product).

**Context ruling recorded with these:** C11 certification is **HELD** (maintainer 2026-07-23) — the body executes before any certification; and C13 execution transferred from Sol 5.6 (out of capacity) to the orchestrator, who takes over the in-flight C13-37 tree.

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

**Decided 2026-07-19 by the maintainer: option (a), implemented via (c).** The cubemap carries **diffuse light only**; **every resolved star comes from the sprite catalogue**. Explicitly **CONDITIONAL ON LICENSING** — maintainer's words: *"if there are no license restrictions to doing this and shipping it."* See §6d (since retracted by §6e). **That condition is DISCHARGED: §6f resolved the licence question for this project's scope on 2026-07-19. DR-01 is now unconditional unless a §6f reopen trigger fires.**

### What was chosen

| Option | Description | Chosen |
|---|---|---|
| (a) | Bright-star-free texture; sprites are the sole source of resolved stars | ✅ **YES** |
| (b) | Keep stars in the texture, accept the double-draw, compensate sprite intensity | ❌ fallback — see reversal plan |
| (c) | Practical implementation of (a): low-pass the t5 bake to destroy point sources, keeping only the diffuse Milky Way | ✅ **the method** |

### Why (not just "it's cleaner")

1. **Painted stars are dead pixels.** They cannot receive *any* of the work C12 exists to do — no Moffat halo (`C12-05`), no B−V blackbody colour, and critically **no angular sun-glare** (`C12-27`), because a baked texel cannot respond to sun angle. Leaving bright stars in the texture would produce a visibly inconsistent sky: sprite stars with halos beside painted blobs without them.
2. **The double-draw over-brightens exactly the stars reported as blobs.** The texture contains every star; the sprite pass redraws the 92 brightest on top (measured at HEAD: vmag ≤ 2.5 across the 263-entry catalog). t5 makes this worse — SVS describes it as *"bright stars are large"*.
3. **(b) is more fragile than it looks.** SVS deliberately non-linearizes the magnitude→intensity curve (boosting faint stars for visibility). A compensation factor would be reverse-engineering a curve we do not control and which differs per variant.

### Binding scope consequence (maintainer-stated)

> *"This means we need to have the same bright star effects for WebGL & WebGPU."*

**Confirmed and binding.** This is natural rather than costly — `StarFieldFS.glsl` and `StarField.wgsl` are already character-identical and share `StarFieldMath.ts`. But it makes three things non-negotiable: every new uniform/attribute is plumbed on **both** backends in the **same** slice; **G2 must pass identically on both**; and no sprite feature may be WebGPU-only. Re-introducing a WebGPU-only celestial effect would recreate the exact bug class `C11-176` just closed (three instances and counting).

### Cost accepted

`C12-09` (catalogue extension toward mag ~6, ~5,000 stars) is **promoted from optional to load-bearing**. With the texture no longer supplying point sources, the catalogue is the *only* source of star density — the ISS-reference look now depends on it. `BrightStarCatalog.js` currently holds 263 entries (measured at HEAD: `data.length` 1052 / `STRIDE` 4; the file's own docblock still says "~230") and the full 9,110-entry BSC5 is **not vendored**, so this is a real data ingest.

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

## 6f. ✅ RESOLVED — project scope makes this moot (2026-07-19, maintainer)

**Read this before §6e or §6d. The licence question is closed for this project's actual scope, and the earlier analysis is retained only for the case where that scope changes.**

**Maintainer-stated scope as of 2026-07-19:** a personal side project; **not affiliated with Cesium GS**; **not redistributing the fork or the code**; non-commercial.

**Under that scope both readings converge on GO:**

- **Permissive reading (§6e):** the NC term never attaches, because CC BY-NC 3.0 IGO §1 licenses a database only as to selection and arrangement, §2 disclaims reaching uses free from copyright, and the SVS rendering takes neither.
- **Most restrictive reading** (assume NC fully attaches): **personal, non-commercial, non-redistributed use is precisely what CC BY-NC affirmatively grants.** That is the licence operating as designed, not an exception carved out of it.

Substantially all of the §6e risk analysis was driven by **redistribution** and the **onward MIT grant** — CC §4(a) *"You may not sublicense the Work"*, the propagated-defective-grant problem, and the affirmative representation that a blanket MIT grant makes to downstream consumers. **With no downstream, none of those have anything to attach to.**

**The one residual wrinkle is already handled.** A public GitHub repository is arguably publication, and this repo carries an MIT licence file. The `# Bundled Engine Assets` section added to `LICENSE.md` (Batch 730) explicitly carves the skybox assets **out** of that blanket grant and states their own terms, so even the nominal onward grant does not sweep them in.

**Consequences:**

- **t5 is cleared to proceed** for this project. `C12-10` is unblocked; `W3` is no longer licence-blocked.
- **Keep the attribution** (`Credit: ESA` + NASA/GSFC SVS). It costs nothing, honours the BY term under either reading, and concedes nothing on NC.
- **Do NOT send the `data.licences@esa.int` email.** It was recommended only against commercial exposure that does not exist here; sending it would invite an adverse written record for no benefit.
- **§6e's mitigations 1, 2, 3 and 5 are already done** (credits, engine-section filing, analysis written into the repo, swappable asset path via `SkyBox.Variant`). Mitigation 6 (filing an upstream issue at CesiumGS) remains optional and is a courtesy, not a need.

**⚠ WHAT WOULD REOPEN THIS.** The scope statement above is the load-bearing fact. If **any** of the following becomes true, **stop and re-read §6e in full before shipping further**: the fork is redistributed or published as a package; it is used commercially or by an employer; a third party is granted rights to it; or it acquires a licensee or downstream consumer. The analysis in §6e is intact and directly applicable to that situation — it was not wrong, it was answering a harder question than this project actually poses.

---

## 6e. ⚠ THE §6d NO-GO IS RETRACTED — revised ruling: CONDITIONAL GO (2026-07-19, later same day)

**§6d below is superseded. Its reasoning was wrong and is formally retracted; read this section first.** Triggered by the maintainer's question: *"if upstream is already using t3 there must be a reason it can right? which should mean we can also use t5?"* A re-examination steelmanning **both** sides overturned the analysis.

### Where §6d went wrong

It reasoned "ESA states CC BY-NC → SVS 3572 names those catalogues → therefore encumbered" — **moving from a licence _statement_ to a legal _right_ without ever asking whether the licensor owns the thing being licensed.** It never engaged *Feist*, never read the licence text ESA itself chose, never checked the sui generis term, and never noticed that CC 3.0 does not license sui generis rights at all.

### The decisive finding — on ESA's own words, not contested doctrine

**CC BY-NC 3.0 IGO §2, verbatim:** *"Nothing in this License is intended to reduce, limit, or restrict any uses free from copyright protection."*
**§1**, defining the licensed object for databases: a database is a Work *"by reason of the selection and arrangement of its contents constitut[ing] an intellectual creation."*

ESA's instrument therefore claims exactly one thing about a catalogue — the intellectual creation in its **selection and arrangement** — and expressly disclaims reaching anything else. **The SVS rendering takes neither:** it plots ~2.4M of Tycho-2's ~2.5M stars (a take-everything, archetypally *unoriginal* selection), arranged by **physical sky position** in plate carrée (dictated by nature, not by ESA's table order), with every expressive choice NASA's own (gaussian PSFs, B−V → effective temperature → CIE tristimulus → RGB).

### Supporting findings, all fetched and verified

- **ESA's operative terms are archive-scoped** (data *"contained in the ESA Space Science Archives"*) and a targeted extraction for any derived-works, visualization, third-party or redistribution clause returned **ABSENT**.
- **NASA did not take Tycho from ESA.** SVS 3572 cites `archive.eso.org` — the European Southern Observatory, a different organisation. No privity with ESA's terms, which form only on archive access.
- **Sui generis right has EXPIRED.** Directive 96/9/EC Art. 10(2) gives 15 years from 1 Jan following publication: Hipparcos (1997) expired **2013-01-01**; Tycho-2 (2000) expired **2016-01-01**.
- **CC 3.0 IGO is silent on sui generis rights** (verified by direct fetch) — so even a live database right would not carry the NC condition. _This cuts both ways: it also means CC 3.0 grants no sui generis rights to anyone; only expiry confers permission._
- **EU copyright limb closes via CJEU C-604/10 _Football Dataco_**: *"the significant labour and skill required for setting up that database cannot as such justify such a protection if they do not express any originality in the selection or arrangement."* The EU's functional analogue to *Feist*.
- **Timing:** CC 3.0 IGO did not exist until 2013-12-06; SVS 3572 is dated 2009-01-26. Wayback places the CC BY-NC sentence's appearance on ESA's Hipparcos page between **2025-01-06 and 2025-05-26**. _Stated fairly: this is a fact about ESA's web publishing, not about ESA's rights — there is no notice formality — and our conduct would be prospective._

### The maintainer's inference — half falsified, half correct

- **"Upstream must have had a reason" → AFFIRMATIVELY FALSIFIED.** A controlled search of CesiumGS (control query "skybox" returned 25 issues, proving the index works) found **zero** issues, PRs, commits or discussions on Tycho/Hipparcos licensing. What exists: a one-line 2012 commit (`4c8b32dc7e` "Added images for sky box"); an attribution stub naming **no licence**, filed under the heading *"Example Applications"* despite the asset shipping from `packages/engine/Source/Assets/Textures/SkyBox/` **inside the published npm package**; a provenance URL that now 404s. Cesium's own `CONTRIBUTING.md:84` requires opening an issue before adding third-party material — **no such issue exists. The reason upstream can ship it is that nobody looked.**
- **"t3 fine ⇒ t5 fine" → CORRECT, and the step is legally EMPTY.** Same SVS 3572 product at different resolution tiers, identical provenance, no resolution-dependent term anywhere. So the real question was never t3-vs-t5; it was *"is either clear?"* — answered above, on the merits.
- **Consequence: §6d's "pre-existing condition" framing was also wrong.** Status quo is **not** the cautious option. If t5 were unshippable, so is the t3 already shipping. That option has no coherent rationale.

### The honest counterweight — the thing to sit with

The permissive case's own weakest point, found while *verifying* it rather than attacking it: **the sui generis analysis is weaker for Tycho-2 specifically than for Hipparcos**, because Tycho-2 expressly merges star-mapper data with ~144 pre-existing ground-based catalogues, which looks like qualifying *"obtaining"* investment under CJEU C-203/02 *BHB*. The ruling does **not** rely on BHB — expiry carries that limb on its own — but a careful reader should know the fallback is thinner than the headline.

**Still UNCONFIRMED:** whether ESA's sentence even nominally reaches Tycho-2 (a Copenhagen Obs./USNO/ARI/ESO product, not an ESA SP-1200 issue; ESA's own Tycho-2 page carries no licence statement at all); and whether any Art. 10(3) substantial-change event reset the term (no evidence found, absence not affirmatively verified).

### Calibrated risk

Only **ESA** could assert. They would have to claim copyright in a *rendering they did not make*, of *facts they cannot own*, against a party that **never accepted their terms**, under an instrument whose §2 disclaims exactly that reach — and for the sui generis limb, under an **expired** right. Likelihood of assertion: **very low**. Realistic consequence: a request to stop, an asset swap, a `LICENSE.md` correction. **Not damages.** Six JPEGs behind `SkyBox.createEarthSkyBox` is not a load-bearing dependency — and `SkyBox.Variant` (Batch 728) already makes replacement a config change.

**Scienter, stated plainly:** commissioning this review means proceeding *knowingly*. Cesium added t3 in 2012 in an innocent-inheritance posture; we would not be. That does not make a weak claim strong, but it converts an inherited exposure into an elected one.

### RECOMMENDATION — ship t5 under "option 2", ESA email in parallel (not as a gate)

**Decouple the asset from the blanket MIT grant.** Ship the skybox under its own documented terms in `LICENSE.md` — attribution + full provenance — rather than sweeping it into MIT's `sublicense`/`sell` grant. This costs a paragraph and removes the CC §4(a) *"You may not sublicense the Work"* exposure and the propagated-defective-grant problem **without conceding that NC ever attached**. It strictly dominates shipping it under blanket MIT.

Mitigations, all cheap, all worth doing whether or not the analysis is right:

1. Credit *"Credit: ESA"* and *"NASA/Goddard Space Flight Center Scientific Visualization Studio"*. **Do not conflate BY with NC** — only NC conflicts with MIT; the BY half is free to honour.
2. File under the **engine** section of `LICENSE.md` (not "Example Applications"), with the full provenance chain and its own terms line.
3. **Write this analysis and its gaps into the repo** — upstream's failure to do so is the concrete defect this research actually found; repeating it would be the real mistake.
4. Send the `data.licences@esa.int` email. A non-answer is itself informative.
5. Keep the texture behind the swappable asset path (`SkyBox.Variant` — already done).
6. Consider filing an upstream issue at CesiumGS so the t3 gap is documented rather than silently inherited by thousands more users.

**What flips this back to NO-GO:** any ESA response asserting rights; discovery of an Art. 10(3) term reset for Tycho-2; retrieval of 2009-era ESO/ESA terms showing NASA acquired under a restrictive grant; or the fork gaining a commercial licensee whose counsel wants documented clearance rather than a defensible theory. Substituting a clean-provenance skymap remains **an afternoon away** if any of those land.

**What must NOT be recorded:** the framing *"upstream does it, so we can."* That is the one justification the evidence positively rules out. Record this as **"we assessed a low residual risk on stated grounds and accepted it"** — never as *"it is clear."*

Confidence: high on US copyright, moderate-to-high on EU, moderate on contract. **Not legal advice; not counsel.** If the fork carries meaningful commercial exposure, route to a lawyer rather than acting on this analysis.

---

## 6d. ~~LICENSING RULING — NO-GO for the t5 path~~ (2026-07-19) — **SUPERSEDED BY §6e, REASONING RETRACTED**

**The maintainer's condition was *"if there are no license restrictions to doing this and shipping it."* There are. DR-01's asset half is BLOCKED.** Verified by a 4-lane primary-source review with independent confirmation; nothing was downloaded or baked.

### The blocker

SVS 3572 declares exactly two source datasets — **"Hipparcos Catalogue" and "Tycho 2 Catalogue"** ([svs.gsfc.nasa.gov/3572/](https://svs.gsfc.nasa.gov/3572/)) — and ESA states verbatim on its own catalogues page: **"The Hipparcos and Tycho Catalogues are distributed under the CC BY-NC 3.0 IGO licence"** ([cosmos.esa.int/web/hipparcos/catalogues](https://www.cosmos.esa.int/web/hipparcos/catalogues)).

That is the **identical licence instrument, from the identical rights holder**, that this project already used to disqualify SVS 4851. The operative precedent was never "Gaia is bad" — it was *"an ESA catalogue under CC BY-NC 3.0 IGO anywhere in the derivation chain is disqualifying."* **SVS 3572 fails that test on Hipparcos alone**, independently of any Tycho-1/Tycho-2 ambiguity. CC BY-NC's bar on use "primarily intended for or directed toward commercial advantage" cannot be reconciled with MIT's grant to "use, copy, modify, merge, publish, distribute, sublicense, and/or sell."

### Two defences that do NOT work

1. **Blurring does not launder it.** SVS 3572 has no separate diffuse layer — the Milky Way band _is_ the plotted catalogue stars: _"Stars fainter than the threshold magnitude… have their magnitude-intensity curve adjusted so they appear brighter than they really are. This makes the band of the Milky Way more visible."_ Low-passing **aggregates** catalogue content rather than destroying it, and the download step copies the full image verbatim regardless. **This invalidates option (c) as a _licensing_ strategy** — it remains sound as an image-processing technique for whatever source we are cleared to use.
2. **"NASA publishes it as public domain" does not reach the inputs.** NASA's guidelines carve out material where NASA has incorporated third-party content, and NASA neither indemnifies nor warrants. §105 is separately shaky for 3572 itself — both credited animators are non-civil-servants.

### Status of each asset

| Asset | Verdict |
| --- | --- |
| SVS 3572 t5 image | **ENCUMBERED via its declared source catalogues.** A hard stop, not a judgement call — an express contrary statement from the rights holder, not silence to interpret. |
| Hipparcos / Tycho-2 data | **ENCUMBERED.** CC BY-NC 3.0 IGO; ESA requires prior written authorisation (`data.licences@esa.int`) for any use generating financial gain. |
| Yale BSC5 (already vendored, ~230 stars) | **UNCONFIRMED — not cleared, and not prohibited either.** No licence instrument exists in either direction. See DR-02. |

### Routes forward, in cost order

1. **Drop 3572; source the Milky Way from a provider whose terms affirmatively permit commercial redistribution and derivatives.** Recommended. ⚠ **ESO GigaGalaxy Zoom (CC BY 4.0) was rejected earlier on _technical_ grounds only — it is licence-clean and should be re-evaluated now that licensing is the binding constraint.** Any replacement must be cleared by checking the licence of **every declared source dataset**, not by keyword-scanning for the mission name that burned us last time.
2. Email `data.licences@esa.int` for written clearance — must permit onward sublicensing by downstream MIT consumers, which is a high bar.
3. Obtain a written statement from NASA/GSFC SVS that 3572 is distributed free of third-party restriction.

### ⚠ Pre-existing condition — surfaced, NOT introduced by this work

**The fork already ships `tycho2t3_80_{px,py,pz,mx,my,mz}.jpg`, derived from the same SVS 3572 product**, attributed at `LICENSE.md:1042`. Established by `git log`: these files are **inherited from upstream CesiumJS** (present in `upstream/main`, first committed 2022-11-01 by a Cesium developer). Upstream ships them under Apache 2.0 — the same commercial grant as MIT. **This is an upstream condition the fork inherits, and it is a maintainer/counsel decision, not an engineering one.** Recorded because the analysis above makes it known; taking no action is a legitimate choice, but it should be a _chosen_ one.

### DR-02 — BSC5 provenance claim corrected (action already taken)

`BrightStarCatalog.js` is **fork-added** and its docblock asserted BSC5 _"is in the PUBLIC DOMAIN"_. **That claim was unsupported and has been withdrawn in code**, replaced with what is actually established: freely available but with no licence instrument in either direction; §105 inapplicable (Hoffleit = Yale, a private university; Warren = ST Systems Corporation, a contractor — federal hosting confers nothing); the vendored fields are uncopyrightable _facts_ under _Feist_ in the US; no ESA-catalogue encumbrance; higher exposure in the EU under the Database Directive.

**Consequences for `C12-09`** (extend to ~5,000 stars) — **gated, not blocked**. Required conditions: source from **NASA HEASARC**, not VizieR (removes EU sui-generis database-right exposure for what would be a substantial extract of 9,110 records); vendor only RA/Dec/Vmag/B−V, dropping remarks/notes/spectral commentary; re-sort under our own schema rather than shipping V/50's row order. Cheapest conversion from UNCONFIRMED to defensible is a one-line written confirmation from CDS (`cds-question@unistra.fr`) and/or Yale.

**Excluded substitutes — do not reach for these:** Hipparcos, Tycho, Tycho-2, any ESA Space Science Archive product (all CC BY-NC 3.0 IGO); HYG (CC BY-SA copyleft _and_ embeds Hipparcos); AT-HYG (Gaia DR3). "Use a Hipparcos-derived subset instead" walks straight back into the SVS-4851 failure mode.

### Effect on the campaign

- **W3 (`C12-10..14`) is BLOCKED** pending a cleared Milky Way source. Do not download or bake 3572.
- **W2 (`C12-05..08`) is UNAFFECTED and becomes the lead wave** — the PSF, quad-extent, amplitude and dynamic-range work operates on the _already-vendored_ catalogue and delivers most of the visible improvement with no new asset.
- **`C12-09` is gated** on the DR-02 conditions above.
- **DR-01's reversal plan is unaffected** — option (b) is now _more_ likely, since it requires no new asset at all.

---

## 7. Cross-campaign dependencies (do NOT double-schedule)

| Already-queued C11 ID | Interaction |
|---|---|
| **`C11-160`** sunBloom → PP wiring | **The single largest contributor to "the sun looks like a blob."** `sunBloom` defaults **true** and drives the full `SunPostProcess` chain on WebGL, but is gated off on WebGPU. WebGL ships a wide blurred halo by default; WebGPU ships the bare quad. It is a **routing** task against existing tested WGSL, not new authoring. C12 W4 depends on it. |
| **`C11-115`** sun blend → ALPHA_BLEND | RESOLVED-as-decision. Additive over a bright sky independently pushes the sun core to flat white. Do not re-open. |
| **`C11-161`** AutoExposure demand-gate | A **perf** item, not a parity fix. Do not re-scope it as a celestial cause. |
| **`C11-79` / `C11-80`** celestial retained resources / starfield single submission | **NOT STARTED and DORMANT — C11 is PAUSED (2026-07-23), "imminent" no longer holds** (`QUEUE_2026-07-18_CAMPAIGN11.md:690`). `C11-80` retains star commands and must land before `C11-79`. **LAUNCH DECISION (LD-1):** transfer both into C12 W1 with IDs retained (C13 precedent), or ratify C12-edits-first with a written rebase contract for the paused rows. Until decided, `C12-04` and every W2 renderer edit is blocked. |
| **`C11-163`** celestial water reflection | `C12-14` would discharge its documented biggest blocker (no samplable star cubemap) for free. |

**⚠ Launch precondition (2026-07-23, LD-1):** Campaign 11 is PAUSED. Every C11 row this queue depends on — `C11-79`/`C11-80` (C12-04 + W2 sequencing), `C11-160` (C12-18), `C11-161` (C12-19), `C11-175` (C12-03) — is NOT STARTED there (`QUEUE_2026-07-18_CAMPAIGN11.md:690,706,707,721`); `C11-115` is resolved-as-decision only (ALPHA_BLEND direction ratified, implementing code NOT STARTED). Maintainer must choose before launch: (i) execute these rows as C12-hosted prerequisites retaining their C11 IDs as aliases (the C13 transfer pattern — they are all celestial-scoped), or (ii) launch with `C12-03`/`C12-04` degraded and W4's `C12-18`/`C12-19` blocked until C11 resumes, which leaves G4's sun half unreachable at campaign close and requires re-scoping the exit criteria. Under either choice, schedule W4 as `C12-15/16/17` first (dependency-free today). Also note `C12-14` discharges the `C11-163` blocker into a paused campaign — still worth doing; the payoff waits on C11.

---

## 8. Scaffolding notice (Principle 7 — do NOT delete)

`Shaders/WebGPU/Environment/Sun.wgsl` is **not** the production shader (the renderer compiles an inline `SUN_SHADER_WGSL` string), but it already contains a **limb-darkening prototype**, a corona term, and a `generateSunTexture` compute entry point that would replace the CPU bake — it is a starting point for `C12-15`/`C12-17`, not dead code. The same trap applies to `Shaders/WebGPU/CubeMapPanorama.wgsl`, which has drifted from the production embedded string and still carries a "TODO: decode sRGB → linear" that **is already implemented** in the renderer. **Anyone diagnosing from the `.wgsl` files will chase already-fixed bugs.**
