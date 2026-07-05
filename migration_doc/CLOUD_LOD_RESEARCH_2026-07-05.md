# Cloud LOD & Smart-Cloud Feature Comparison — Our Fork vs the Ecosystem

**Date:** 2026-07-05
**Scope:** LOD strategy + "smart cloud" feature parity for our WebGPU env-phase volumetric cloud system, deduped against three.js (drei / takram / Maxime Heckel / FarazzShaikh / CK42BB), Babylon.js, and AAA (Guerrilla Nubis, Frostbite, RDR2, NVIDIA STBN, Epic octahedral impostors).
**Method note:** Research was READ-ONLY web synthesis; I additionally grepped our own `ProceduralClouds.wgsl`, `CloudTemporalResolve.wgsl`, and `WebGPUProceduralCloudRenderer.ts` to correct two stale "missing" flags in the incoming research (see §Corrections).

---

## 1. Our LOD vs the field — are we ahead, behind, or comparable?

**Verdict: comparable-to-ahead on breadth, behind only on two specific axes (STBN reconstruction depth + in-march distance step-growth) and one structural gap (orbit impostors).**

| LOD mechanism | Our fork | three.js drei | Maxime Heckel | @takram/three-clouds | Babylon | AAA (Nubis/Frostbite) |
|---|---|---|---|---|---|---|
| Quality tiers (step budgets) | ✅ 0–3 (24/48/96 primary; 3/4/8 light) | instance-count only | ❌ constant | ✅ Low/Med/High/Ultra (200–500 iter) | ❌ (eat cost) | ✅ |
| **Altitude-auto tier select** | ✅ **orbit→low, close→cinematic** | ❌ | ❌ | ❌ (manual preset) | ❌ | partial (art-driven) |
| Half-res + bilateral upscale | ✅ (Batch 432/433) | ❌ | ✅ half-res bicubic | ✅ | ❌ | ✅ (Frostbite) |
| Temporal history / reprojection | ✅ + variance clamp resolve | ❌ | ❌ | ✅ TAAU | ❌ | ✅ |
| Amortization aggressiveness | **1/4 (half-res)** | — | — | **1/16 (4×4 texel)** | — | 1/16 (Frostbite) |
| Blue-noise sampling | ⚠️ **Bayer/frameCounter dither, NOT STBN** | ❌ | white/blue jitter | ✅ **STBN** | ❌ | ✅ **STBN** |
| Empty-space skipping (coarse→fine) | ✅ **W5 base-density skip oracle** | ❌ | ❌ | ✅ | ❌ | ✅ |
| Transmittance early-out | ✅ (`trans < 0.01 break`) | ❌ | ❌ | ✅ (minTransmittance 1e-2) | ❌ | ✅ |
| **In-march distance step-growth** | ❌ **fixed fineStep = layer/steps** | ❌ | ❌ | ✅ **perspectiveStepScale 1.01** | ❌ (froxel instead) | ✅ |
| maxRayDistance cap | ⚠️ shell-bounded, no explicit far cap | ❌ | ❌ | ✅ 200km | — | ✅ |
| Cascaded cloud-shadow LOD | ⚠️ single Beer-Shadow-Map | ❌ | ❌ | ✅ **3 cascades** | ❌ | ✅ |
| Aerial-perspective froxel (view-aligned 3D LUT) | ❌ (we do per-fragment aerial LUT) | ❌ | ❌ | ❌ | ✅ **[64,64,32] froxel** (9.0 addon) | ✅ |
| **View-correct orbit impostor** | ❌ **(still low-step marches whole shell)** | flat billboard only | ❌ | ❌ | ❌ (2D noise dome) | ✅ **octahedral (Epic)** |

**Bottom line:** Nobody in the *open-source* ecosystem has a more complete cloud-LOD stack than us except @takram/three-clouds, which is our closest same-domain peer (geospatial, on-globe volumetric). Against Takram we are ahead on altitude-auto tiering and equal on empty-space skip / early-out / half-res+temporal, but **behind on three concrete items**: (1) STBN reconstruction, (2) 1/16 amortization depth, (3) in-march perspective step-growth + far-distance cap. Against AAA we match the shader-level toolbox but lack the two *structural* LODs they rely on at extreme range: **octahedral impostors** and a **view-aligned aerial-perspective froxel**.

---

## 2. Missing smart-cloud / LOD features we genuinely LACK (deduped)

Dropped everything confirmed `have-it` (Perlin-Worley, weather map, Beer-powder, dual-lobe HG, multi-scatter octave decay, Beer-Shadow-Map + ground projection, cloud IBL/reflection, curl turbulence, aerial-perspective, ambient sky/ground coupling, cone-tap light march, empty-space skipping, transmittance early-out, per-genus profiles, exotic species/virga geometry). Ranked by (fork value × 1/effort).

| # | Missing feature | Why it matters / fork value | Priority | Effort |
|---|---|---|---|---|
| 1 | **In-march perspective step-growth (`stepSize *= ~1.01`) + explicit `maxRayDistance` cap** | Our fineStep is fixed `(tEnd−tStart)/steps` for the whole ray — we pay uniform detail on far shell samples that read as 1–2px. Takram + all AAA coarsen far samples geometrically. Single cheapest LOD win: near-free orbit cost cut, one tier serves near+far. Pairs with our existing W5 skip. | **high** | low (few lines in march loop; W5 skip structure already there) |
| 2 | **STBN (spatiotemporal blue-noise) ray-start + light jitter** | We use a Bayer/`frameCounter` dither (float slot 76) — structured, bands/shimmers under motion and blocks going more aggressive than half-res. STBN is the *enabler* for item 3 and immediately improves current half-res quality. Public-domain STBN sets exist; one baked texture + sample. | **high** | low-med (bake/embed texture, index by pixel+frame%N, feed existing jitter slot) |
| 3 | **1/16 (4×4) texel-amortized march** | We march every half-res (1/4) texel every frame; Takram/Frostbite march 1/16 and reproject the rest → ~4× march cost cut, ideal for the expensive cinematic tier at orbit. Gated on item 2 to avoid banding. | **high** | med (extend temporal path with per-frame update mask; reuse history buffer) |
| 4 | **View-correct orbit impostor (octahedral atlas)** | THE stated gap — at orbit we still low-step-march the whole shell. See §3 for full design. Novel for clouds (nobody ships it), high differentiator, but the perf case is weaker than we assumed (Takram hits orbit-viable WITHOUT it via items 1+3). Reframe as quality/battery option, not the sole orbit bridge. | **high** | high (offline/async bake pass + octa-blend WGSL + threshold switch; multi-batch) |
| 5 | **Cascaded cloud-shadow map (3 cascades + per-cascade step reduction + opticalDepthTailScale)** | We have a single Beer-Shadow-Map; shadow resolution falls off across orbit→ground camera ranges. Cascade it (reuse our terrain-CSM split infra) for crisp near / cheap far cloud shadows. `opticalDepthTailScale` is a one-liner to fake density beyond the marched range. | **medium** | med (reuse CSM cascade infra; extra 512² targets) |
| 6 | **Aerial-perspective / cloud-radiance froxel ([64,64,32] view-aligned 3D LUT)** | Babylon 9.0 (Hillaire 2020) amortizes long-distance scattering into a coarse view-aligned froxel sampled by (screen xy, depth) — a *structural* distance-step-reduction and a principled alternative to impostors for the far shell. Also answers cloud-shadow/reflection LOD. Combinable with our half-res+temporal. | **medium** | med-high (allocate view-aligned 3D target + compute fill + depth-sampled composite; we have compute infra) |
| 7 | **Cloud lightning / internal emissive flash** | Genuine content gap (Nubis3 superstorms, UE emissive). High payoff for storm demos; ride the weather-map/precip channel + existing multi-deck storm cells. | **medium** | med (emissive scatter term in march + flash driver uniform/buffer) |
| 8 | **Full precipitation coupling (rain shafts + ground wetness/fog, driven by precip channel)** | We shape virga/praecipitatio *geometry* only (Batch 611). Missing actual shaft rendering + ground darkening/wetness + intensity from weather-map precip channel. | **medium** | med-high (geometry hook exists; particles/shafts + ground coupling new) |
| 9 | **Hierarchical / quadtree planet-scale cloud tiling** | Single 256×128 weather map for the whole globe (Skybolt uses 8096² + tiling detail + mip LOD). Orbit views get coarse, potentially-repeating cover. This is the substrate an orbit impostor renders from. | **medium** | high (higher-res/streamed coverage + multi-scale tiling + camera-distance mip select) |
| 10 | **Temporal cloud-TYPE morphing (time-blended genus transitions)** | We have per-genus profiles (Batch 408) + weather-map genus channel (G) but no confirmed time-blended genus lerp — fronts hard-swap instead of evolving. | **low-med** | med (per-column blend weight + interp in WGSL profile lookup) |
| 11 | **Mid-tier instanced soft-particle sphere clusters** (CK42BB) | An intermediate LOD between flat billboard and full volumetric — more view-stable than a flat card at mid-orbit. Optional if we do octahedral impostors (item 4). | **watch** | med (standard instancing; wire as a renderMode/auto-tier) |
| 12 | **Distant coverage/altitude cheat** (Guerrilla HFW) + **per-instance billboard roll** (Venolabs) + **secondaryStepScale ×2** on light march (Takram) + **accurateSunSkyLight toggle** (Takram) | Cheap polish grab-bag: bias coverage up / altitude down for far samples so low-step silhouettes stay smooth; random billboard roll breaks the all-facing tell; ×2 growth on the light march; per-tier accurate-vs-interpolated irradiance dial. | **watch** | trivial each (pure shader tweaks / one flag) |
| 13 | **Low-res non-temporal cloud pass into env cubemap for reflection/IBL** | Our cloud IBL publishes coverage + march params, but there's no dedicated *low-res, temporal-off* cloud render feeding reflection probes (temporal is unstable on cubemaps). Makes water/PBR reflect the actual sky state consistently. | **low-med** | med (run existing march low-res into cube faces, slow cadence, skip temporal) |

---

## 3. Impostor findings — how others do view-correct billboard cloud LOD, and what our CLOUD-VOLUMETRIC-IMPOSTOR-LOD epic should adopt

**Ecosystem reality check:** *No one ships a view-correct impostor for clouds specifically.* The techniques exist only for opaque meshes (trees). So our epic is genuinely novel and we must adapt, not port.

**How each camp degrades at range:**
- **three.js drei `<Clouds>`** — flat camera-facing quads only. LOD = depth-sorted instance cap by `range` + distance-fade opacity. View-*incorrect* (always faces camera; no parallax). Good policy to reuse for the *billboard* side of our renderMode toggle (range cap + distance fade).
- **Babylon** — no impostor at all. Degradation = swap to a cheap **2D fbm noise painted on the sky dome** (`CloudProceduralTexture`) or eat the raymarch. The dome is a viable near-zero-cost "tier −1" far-field, but not view-correct.
- **@takram/three-clouds** (closest peer) — **deliberately NO impostor.** Reaches orbit-viable perf purely via perspective step-growth + maxRayDistance cap + 1/16 STBN TAAU. **Key strategic finding: the mature geospatial peer proves impostors are not required for orbit performance.**
- **Epic / Ryan Brucks octahedral impostors** (Fortnite, trees) — bake N views arranged on an octahedron into an atlas; at runtime blend the **3 nearest captured views** by camera direction → view-correct + parallax-approximate + smooth transitions + automatic distance LOD switch. This is the technique to adapt.
- **GPU Gems 3 Ch.21 "True Impostors"** — per-pixel ray-into-a-stored-depth/density card from a single quad → correct silhouette + parallax + per-pixel LOD. Better fit for *per-puff* CloudCollection billboards than a whole-shell atlas; candidate for a hybrid blend band.
- **MSFS / RDR2** — bake cloud contribution into coarse sky-irradiance probe grid + reflection maps rather than per-ray marching (this is the IBL-LOD item, not a primary-view impostor).

**What our epic should adopt (recommended sequencing):**

1. **Do items 1–3 (step-growth + STBN + 1/16 amortization) FIRST.** Takram's negative result is decisive: those three may make the orbit march cheap enough that impostors become a quality/power option, not a necessity. Ship them before investing multi-batch effort in the atlas bake. This de-risks the epic.
2. **Then build the octahedral impostor as a third `renderMode`** under the already-unified CloudCollection toggle:
   - **Bake:** reuse the existing volumetric march to render the cloud shell into an octahedral atlas asynchronously (offline or on a slow cadence), from N directions on the octahedron sphere.
   - **Runtime:** octa-unwrap + **3-nearest-view blend** WGSL shader on a single billboard card; switch to it beyond an altitude/distance threshold (drive from our existing altitude-auto selector).
   - **Cloud-specific novel problems to solve (the actual research work):** atlas **staleness vs wind drift** (re-bake cadence tied to wind speed / weather-map delta), **HDR premultiplied-alpha** blending of a semi-transparent shell (not opaque like trees), and a **transition band** that cross-fades impostor↔march to hide the pop. Pair the transition band with the "distant coverage cheat" (item 12) so the marched side of the band already reads smooth.
3. **Consider the aerial-perspective froxel (item 6) as the principled alternative** to impostors for the far shell — it may be a cleaner, more general solution than the atlas for the pure-distance case, reserving the octahedral impostor for the mid-orbit "still recognizably 3D" band.
4. **Optional mid-tier** (item 11): instanced soft-particle spheres between flat billboard and impostor for mid distances if the impostor pop proves hard to hide.

---

## 4. Where we already BEAT the ecosystem

- **Altitude-auto tier selection** — orbit→low, close→cinematic. Neither Takram (manual presets), drei, Babylon, nor most AAA open impls do automatic altitude-driven quality. **Confirmed fork advantage — keep it.**
- **Empty-space skipping + transmittance early-out already shipped** (W5 base-density skip oracle + `trans < 0.01 break`). The Takram/game-engine research flagged these as gaps for us — they are **not**; we match Takram here. (See Corrections.)
- **Feature breadth vs every open-source peer:** we ship WMO genera + exotic species (mammatus, virga geometry), per-genus vertical profiles, multi-deck shells, curl turbulence, physical aerial-perspective LUT modes, sky/ground ambient hemisphere coupling, cloud IBL with real march params, and ground cloud-shadow projection onto terrain — a superset of drei, Babylon, Maxime Heckel, FarazzShaikh, and CK42BB combined. Only Guerrilla's Nubis3 (closed-source AAA) clearly exceeds our feature surface.
- **Ground cloud-shadow projection to terrain/aerial/fog/env** is wired (Batch 437 Beer-Shadow-Map stashed for consumers) — Babylon and the three.js libs have nothing comparable; only RDR2/Skybolt-class systems match it.
- **Multi-scatter octave decay + dual-lobe HG + Beer-powder** matches the Nubis/Frostbite reference exactly — we are at AAA parity on the core scattering model, ahead of every JS-ecosystem peer.

---

## Corrections to incoming research (verified against our source)

1. **Empty-space skipping / adaptive coarse→fine march** — research (Takram + game-engine angles) flagged "partial/missing." **Actually HAVE:** `ProceduralClouds.wgsl:1435-1464` (W5) implements a coarse→fine march with a cheap base-density skip oracle that preserves the fixed-march sample grid. Reclassified to `have-it`.
2. **Transmittance early-out** — flagged "partial/verify." **Confirmed HAVE:** `if (transmittance < 0.01) break;` in the primary march (and `< 0.005` per-deck in the multi-deck path).
3. **STBN** — flagged "unclear/partial." **Confirmed MISSING as true STBN:** our jitter is a **Bayer/`frameCounter` dither** (float slot 76, `bIndex = frameCounter & 15u`) plus a golden-ratio cone jitter — structured, not a blue-noise mask. Item 2 stands as a genuine gap.
4. **In-march distance step-growth** — confirmed MISSING: `fineStep = (tEnd - tStart) / f32(steps)` is fixed per ray; no `perspectiveStepScale`, no explicit `maxRayDistance` far cap (shell geometry bounds the ray instead). Item 1 stands.
5. **Orbit impostor / octahedral** — confirmed MISSING: no `impostor`/`octahedral`/`renderMode` symbols in `WebGPUProceduralCloudRenderer.ts`.
