# Cloud-Taxonomy Roadmap — how far can we go beyond the 11 genera?

Answer to "do we support all cloud/weather types, and can we add rarer ones like
mammatus?" Short version: **the 11 WMO genera are planned (enum exists); the full
WMO taxonomy is ~100+ named forms; and our baked-density-field architecture can
express MOST of them as density-shaping, with the iconic "supplementary features"
(mammatus, asperitas, Kelvin-Helmholtz, lenticular…) each a bounded add-on.**

Companion to [CLOUD_RENDERING_STRATEGY.md](CLOUD_RENDERING_STRATEGY.md) (the
rendering core) and [WEATHER_RECREATION_ROADMAP.md](WEATHER_RECREATION_ROADMAP.md)
(the weather-data axis).

---

## What exists / is already planned

- **`Scene/CloudType.js`** — all **11 genera** enumerated: cumulus, cirrus,
  cirrostratus, cirrocumulus, altostratus, altocumulus, nimbostratus, stratus,
  stratocumulus, cumulus congestus, cumulonimbus.
- **`Scene/CloudTypeProfile.js`** — per-genus profile slots (shape / base density
  / extinction / erosion / phase). **All five axes now reach the renderer as of
  `C13-16` (IMPLEMENTED, Edge acceptance owed)**: `erosion` and `phaseG` were
  dead until then, so a genus differed only in deck, height gradient, density
  scale, and extinction — cirrus rendered as a faint scaled-down cumulus. The
  companion `CloudTypeProfile.FIBRE_MORPHOLOGY` table drives `genusFibreFactor`
  in `ProceduralClouds.wgsl` (a wind-aligned, fallstreak-sheared, anisotropic
  carve; the ice-crystal analogue of the cumuliform Worley erosion) and
  `genusForwardG` offsets the Henyey-Greenstein forward lobe because ice
  scatters far more forward-peaked than water. Default CUMULUS is byte-identical
  by explicit early return. Note the layering: this is the GENUS grain, always
  on for an ice genus; `speciesFactor`'s fibratus/uncinus mode remains the
  user's optional finer SPECIES form on top of it — genus then species, as the
  WMO hierarchy has it. Guarded by
  `Tools/visual-regression/cloud-genus-morphology.spec.mjs`.
- **Campaign 3 v2 wiring:** **V4** (shipped) added the morphology *pipeline*
  (mean-preserving erosion + `erosionStrength` dial). **V11** drives per-genus
  vertical density profiles through it (stratus flat sheet, cumulus billowy,
  cumulonimbus towering + anvil). **V12** adds multi-deck (cirrus ice + mid +
  low coexisting) + ice/water phase.

The 11 genera + their profiles cover **~95% of observed skies**. The rest is the
long tail below.

## The full WMO taxonomy (there are MANY more than 11)

Clouds are classified on five axes that combine into 100+ named forms:

| Axis | Count | Examples |
|---|---|---|
| **Genera** | 10 | cirrus … cumulonimbus (we have these) |
| **Species** | ~15 | fibratus, uncinus, spissatus, castellanus, floccus, stratiformis, nebulosus, **lenticularis**, fractus, humilis, mediocris, congestus, calvus, capillatus, volutus |
| **Varieties** | ~9 | intortus, vertebratus, **undulatus**, radiatus, lacunosus, duplicatus, translucidus, perlucidus, opacus |
| **Supplementary features** | ~12 | incus (anvil), **mamma (mammatus)**, virga, praecipitatio, arcus (shelf/roll), tuba (funnel), **asperitas**, **fluctus (Kelvin-Helmholtz)**, cavum (fallstreak hole), murus (wall), cauda, flumen |
| **Accessory clouds** | 3 | pileus, velum, pannus |
| **Special / other** | — | **noctilucent**, nacreous, contrails (homogenitus), pyrocumulus (flammagenitus), orographic lenticular |

**Mammatus** is the supplementary feature **mamma** — pendulous pouches hanging
*beneath* a cloud base (classically under a cumulonimbus anvil). It's a *shape*
feature, not a genus.

## Feasibility on our architecture

Our core is a **baked 3D density field** sampled by a raymarcher, shaped by
height-gradient profiles + a coverage/weather map + curl advection. That maps
onto the taxonomy cleanly:

- **Species & varieties = density-shaping → mostly "free" once V11/V12 land.**
  lenticularis = smooth wind-aligned lens density (orographic); fibratus/uncinus
  = curl-advected wispy ice strands (V8 curl + high deck); undulatus/radiatus =
  wave/stripe-modulated coverage; stratiformis/nebulosus = flat sheet profile.
  These are profile + coverage-pattern variations, not new machinery.
- **Supplementary features = bounded targeted add-ons** (each a small shader
  feature + probe):
  - **incus (anvil)** — already V11 (cumulonimbus height profile).
  - **mamma (mammatus)** — **SHIPPED (Batch 555, E2)**. A downward-bulging density
    modulation on the cloud UNDERSIDE: `mammatusFactor()` in `ProceduralClouds.wgsl`
    carves density BETWEEN rounded Worley lobe cells inside the base band so the
    flat underside reads as a field of pendulous pouches. Opt-in via
    `globe.cloudMammatusStrength` (+`Scale`/`Depth`); default 0 → factor 1.0 →
    byte-identical. Applied identically in `cloudDensity` + the `cloudBaseDensity`
    oracle so the W5 `base >= full` skip invariant holds. Probe
    `probe-cloud-mammatus.mjs`.
  - **virga / praecipitatio** — a density tail trailing below the base → pairs
    with **V15 precipitation**.
  - **asperitas** — turbulent wavy underside (curl/wave displacement on the base).
  - **fluctus (Kelvin-Helmholtz)** — sheared breaking-wave billows (a directional
    wave modulation).
  - **arcus (shelf/roll)** — a horizontal roll structure at a storm's leading edge.
- **Special clouds = new decks / sources:** noctilucent + nacreous = a separate
  high (meso/stratospheric) thin shell + iridescent shading; contrails =
  line-shaped sources written into the weather map (procedural or flight data);
  pyrocumulus = event/data-driven. These need new infrastructure, not just
  shaping.

## Proposed tiered "exotic clouds" roadmap (post-core)

After the Campaign-3 v2 core (V5–V18) + V11/V12 (per-genus + multi-deck):

- **Tier E1 — species/varieties (density shaping):** lenticular, fibratus/uncinus
  (wispy cirrus), undulatus/radiatus (wave coverage), castellanus/floccus
  (turreted). Mostly reuse V8 curl + V11 profiles + weather-map patterns.
- **Tier E2 — iconic supplementary features (targeted displacements):**
  **mammatus**, asperitas, Kelvin-Helmholtz (fluctus), arcus, virga. Each a
  bounded underside/wave density mode, per-genus gated. *This is where mammatus
  lands.*
- **Tier E3 — special clouds (new decks/sources):** noctilucent + nacreous
  (high iridescent shell), contrails (line sources), pyrocumulus (event-driven).

**Recommendation:** the full ~100-form set is a long tail; prioritize the
**visually iconic** forms a viewer actually recognizes — anvil (V11), mammatus,
lenticular, Kelvin-Helmholtz, asperitas, virga, noctilucent, contrails (~8
high-impact additions) — rather than every species×variety×feature permutation.
Each iconic form is a small batch (density mode + probe) on the V11/V12
foundation.

## Status

- **Now:** finishing the Campaign-3 v2 rendering core (V5–V8) → then V11/V12
  (per-genus profiles + multi-deck = the 11 genera rendered distinctly).
- **Then (this roadmap):** E1 → E2 (mammatus et al.) → E3. **E2 mammatus SHIPPED
  (Batch 555)** — the first exotic supplementary feature on the baked-density-field
  arch. **E1 species SHIPPED (Batch 610)** — lenticularis (smooth wind-aligned
  stacked lens plates) + fibratus/uncinus (wind-aligned wispy filaments, with a
  height-sheared fallstreak hook for uncinus) as a single `speciesFactor()` density
  multiplier in [0,1], opt-in via `globe.cloudSpecies`, default-OFF byte-identical,
  applied identically in `cloudDensity` + the `cloudBaseDensity` W5 oracle.
  **E2 remaining features SHIPPED (Batch 611)** — asperitas (chaotic wavy underside),
  Kelvin-Helmholtz/fluctus (breaking-wave billows along the top), arcus (shelf/roll
  leading edge), and virga/praecipitatio (fallstreak tail below the base) as a single
  `featureFactor()` density multiplier in [0,1], opt-in via `globe.cloudFeature`
  (`"asperitas"` | `"fluctus"`/`"kelvin-helmholtz"` | `"arcus"` | `"virga"` |
  `"praecipitatio"`) or numeric `globe.cloudFeatureMode` (1-4), default-OFF
  byte-identical, applied identically in `cloudDensity` + the `cloudBaseDensity` W5
  oracle. **E3 special (iridescent shading) SHIPPED (Batch 612)** — noctilucent
  (mesospheric NLC — electric silvery-blue billow bands, red/green attenuated so blue
  survives the Reinhard tone-map) + nacreous (stratospheric mother-of-pearl — pastel
  iridescent bands keyed to the sun/view scattering angle via an Iñigo-Quilez cosine
  spectral palette) as a `specialShadeTint()` COLOR multiplier (in [0,1]³) on the
  view-ray radiance in `marchDeck` (NOT on density, so the W5 `base >= full` oracle is
  untouched). Opt-in via `globe.cloudSpecial` (`"noctilucent"`/`"nlc"` |
  `"nacreous"`/`"psc"`) or numeric `globe.cloudSpecialShadeMode` (1/2), default-OFF
  byte-identical (specialShadeMode=0 → tint vec3(1.0) → radiance × 1.0). The
  high-altitude deck placement reuses the existing multi-deck `deckBoundsHigh` bounds
  (Batch 443). The remaining E1 forms (undulatus/radiatus wave coverage,
  castellanus/floccus turrets) and the remaining E3 SOURCE-based forms — **contrails**
  (line sources into the weather map) and **pyrocumulus** (event/data-driven) — stay
  OPEN; those two need genuinely new source infrastructure, not a shading/shaping mode
  on the existing shell. Acceptance probes:
  **GENUS grain landed under `C13-16` (2026-08-06, Edge acceptance owed)** — the
  cirrus family no longer needs an explicit species selection to stop reading as
  cumulus: `CloudTypeProfile.FIBRE_MORPHOLOGY` + `genusFibreFactor` give every
  FIBROUS genus a wind-aligned, fallstreak-sheared filament grain automatically,
  and `genusForwardG` gives it an ice-appropriate forward-scattering lobe. The
  E1 `speciesFactor` modes are unchanged and still layer on top; what changed is
  that the BASELINE for an ice genus is now ice-shaped. Spec:
  `Tools/visual-regression/cloud-genus-morphology.spec.mjs`. Still open on this
  axis: a per-genus species DEFAULT, and the per-REGION genus/deck MIXTURES that
  are the rest of the `C13-16` row (blocked on `C13-14`/`C13-15`). Acceptance
  probes:
  `Tools/visual-regression/probe-cloud-species.mjs` (E1),
  `Tools/visual-regression/probe-cloud-features.mjs` (E2 remaining),
  `Tools/visual-regression/probe-cloud-special.mjs` (E3 noctilucent/nacreous).
