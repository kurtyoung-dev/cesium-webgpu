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
  / extinction / erosion).
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
  - **mamma (mammatus)** — a downward-bulging density modulation on the cloud
    UNDERSIDE (invert the height gradient near the base + add lobed displacement).
    A real but small shader mode, gated per-genus (Cb/anvil).
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
- **Then (this roadmap):** E1 → E2 (mammatus et al.) → E3. Tracked here; not yet
  scheduled into the queue. **Mammatus is feasible and explicitly planned (E2).**
