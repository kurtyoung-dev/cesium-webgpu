# DEV notes — celestial

Comments moved out of `packages/*/Source` by the Campaign 16 comment
remediation, preserved verbatim. Format:
[DEV_NOTES_FORMAT.md](DEV_NOTES_FORMAT.md). These are historical records, not
current documentation — verify any claim here against the code before acting
on it.

Covers the sun disc and its photometry, the sun bloom and screen-space halo,
the moon and its phase/appearance modules, the star catalogue and starfield
renderers, the eclipse family (state, obscuration, globe shadow, horizon
twilight), the celestial atmospheric extinction and sky-brightness
estimators, and the WebGPU environment-map renderers that bake them.

## Solar disc photometry

### `packages/engine/Source/Scene/SolarDiscModel.js` — `(module docblock)`

_Moved 2026-08-11._

```text
ONE CURVE, TWO PARAMETERISATIONS (C12-27)

C12-16's `solarGlareProfile` and C12-27's `solarAngularGlareVeil` are the
SAME pedestal-subtracted Lorentzian, `{@link pedestalLorentzian}`, evaluated
over two different domains:

  C12-16  x = bake `radius` (the billboard's own texture coordinate)
  C12-27  x = ANGULAR separation from the Sun, in radians

Both decay as `1/x^2` — the Stiles-Holladay / CIE disability-glare form
`L_veil ∝ E / theta^2`. The C12-27 queue row prescribes reusing "the C12-05
Stiles-Holladay math"; that identification is WRONG and is recorded here so
nobody re-derives it. `C12-05` DID land (Batch 748), but its Moffat wing is
`(1 + (r/alpha)^2)^(-beta)` with `STAR_PSF_BETA = 2.0`, i.e. a log-log slope
of `-2*beta = -4`: an inverse-FOURTH-power wing, deliberately, because it
models a single unresolved star's point-spread function and not the veiling
luminance across the sky. The landed inverse-SQUARE veiling form in this fork
is C12-16's, right here. So the glare curve has exactly one home, and it is
this module.
```

The only written record that a queue row instructed reuse of the star
point-spread function for the solar glare veil, and that the instruction was
refuted. The rewritten comment states the distinction between the two curves
as a standing fact; this preserves the identification that was rejected, so
the same reuse is not proposed again.

### `packages/engine/Source/Scene/SolarDiscModel.js` — `(module docblock)`

_Moved 2026-08-11._

```text
WHY THIS MODULE EXISTS. Before it, the limb-darkening triple lived only in
`computeSolarObscuration.js` (C12-29 S1's eclipse photometry) and the sun
billboard's own disc was a *binary* `step()` with no limb darkening at all,
while the glare falloff was a bare `1.0 - smoothstep(0.0, 0.55, r)` literal
duplicated between `Shaders/SunTextureFS.glsl` (WebGL) and the CPU bake in
`Renderer/WebGPU/WebGPUEnvironmentRenderer.js` (WebGPU). The C12-15 queue
row requires ONE constants source once the sun wave lands. Three consumers
now read this module:

  1. `computeSolarObscuration.js` — the eclipse flux quadrature.
  2. `Scene/Sun.js` — feeds the values to `SunTextureFS.glsl` as UNIFORMS
     (`u_limbDarkening`, `u_glareCore`, `u_glarePedestal`, `u_glareLegacy`),
     so the GLSL carries no numeric copy of them at all.
  3. `Renderer/WebGPU/WebGPUEnvironmentRenderer.js` — imports the pure
     functions directly for its CPU bake.
  4. `Scene/SolarGlareAppearance.js` — C12-27's per-frame resolver, which
     feeds the ANGULAR parameterisation of the same veiling-glare curve to
     four shaders (star sprites + star cube map, both backends) as uniforms.
```

Carries a stale count corrected during the rewrite: the text says "Three
consumers" and then lists four. The rewritten comment says four. Kept because
it also records where each of the four literals lived before consolidation,
which is the only place that duplication is written down.

### `packages/engine/Source/Scene/SolarDiscModel.js` — `solarGlareProfile`

_Moved 2026-08-11._

```text
That table
is also the arithmetic that rules C12-16 OUT as the cause of
`probe-eclipse-sun-fade`'s `glowOffRaw == 0` on WebGPU over the 1.5x..6x
annulus: BOTH curves put alpha (0.75 x profile) between 0.16 and 0.69
there, two orders of magnitude above the 1/255 quantisation floor and far
inside either support radius. Reshaping the falloff cannot turn a measured
zero into a non-zero, so the zero has a different cause — see
`probe-sun-glow-profile.mjs`.
```

An exoneration: the glare-profile change is not the cause of a measured zero
in the eclipse sun-fade probe, with the arithmetic that rules it out. It is
about a probe result rather than about the code, so it has no home in the
rewritten docblock, but it saves re-running the elimination.

### `packages/engine/Source/Scene/SolarDiscModel.js` — `SOLAR_DISC_SDR_RADIANCE`

_Moved 2026-08-11._

```text
C12-19 — TRUE HDR SUN RADIANCE

TWO PREMISE CORRECTIONS, recorded here because the row's own text and the
Batch-906 record both carry the older reading:

(1) THE BAKE CLAMP IS NOT WHAT MASKS LIMB DARKENING. `SunTextureFS.glsl`
    writes `rgb = (1, 1, surface + 0.2)` and `alpha = surface + 0.75*glow`,
    and the C12-18 default hands the halo to the post-process chain, which
    sets `bakeHaloGain = 0` and deletes the `0.75*glow` term. What is left
    is `alpha = surface = limb(x)`, which NEVER reaches the clamp, so the
    limb law composites straight through: over a dark sky the disc runs
    255 codes at centre to 77 at the extreme limb on BOTH backends AT HEAD.
    C12-18 was its own unmasking row. The clamp still binds on exactly one
    channel at the default — BLUE, over the inner disc, where
    `surface + 0.2 > 1` — and there it is doing real work: the `+0.2` is a
    HUE term (it makes the halo orange and the core white), so "removing
    the clamp" on blue turns the sun's core blue. It is a WHITE POINT, not
    a radiance clamp.

(2) REMOVING THE CLAMP FROM ALPHA IS UNSAFE. Since C11-115/C12-18 both
    backends blend the sun ALPHA_BLEND, where alpha is the DESTINATION
    weight: `dst = src.rgb*a + dst*(1 - a)`. An alpha above 1 makes
    `1 - a` negative and SUBTRACTS the sky — a dark ring around the sun,
    i.e. exactly the Batch-364 black-sky class this row's own warning
    names. On the `sunBloom = false` path the legacy baked halo drives
    alpha to ~1.9, so the ring would be strong. The alpha saturation is a
    BLEND WEIGHT clamp and must stay.
```

Records that two queue-level premises about the sun's `clamp(color, 0, 1)`
were wrong, and which measurements refuted them. The rewritten comment keeps
both constraints as standing facts about the clamp; this preserves the fact
that they were recorded the other way round in the row text and in the batch
record, so a reader who finds those documents is not misled.

### `packages/engine/Source/Scene/SolarDiscModel.js` — `SOLAR_DISC_RADIANCE_CONTRAST_CEILING`

_Moved 2026-08-11._

```text
i.e. the "~10^5 energy" the row's warning contemplates would render the
solar disc a flat white circle with the C12-15 law arithmetically invisible
— the inverse of the Batch-364 failure by a different route.
```

Names the failure class a very large disc radiance belongs to and ties it to
an earlier black-sky regression. The rewritten comment states the effect
without the cross-reference.

### `packages/engine/Source/Scene/SunHaloAppearance.js` — `readSunHaloAppearance`

_Moved 2026-08-11._

```text
C12-19 — THE B906 RE-DERIVATION THIS ROW OWED. `SOLAR_HALO_AMPLITUDE` is
the bake's own `0.75` glare weight, and B906 adopted it for the screen
halo so "the two compositions are continuous at the centre by
construction". That construction was written against a disc whose
composited peak was 1.0.
```

Records that the centre-continuity claim was made before the disc carried an
HDR radiance, so the claim held only at a peak of 1.0. The rewritten comment
states the scaling requirement directly; this preserves the reason the
unscaled form was ever correct.

## Sun billboard

### `packages/engine/Source/Scene/Sun.js` — `Sun#update`

_Moved 2026-08-11._

```text
C12-29 S4 CORRECTION (2026-07-25). This block used to claim "the
physics yields exactly Cartesian3.ONE from orbit (the ray never
crosses the shell), so the from-orbit case is byte-identical too".
That is FALSE in exactly the geometry S4 exists for. From a 400 km
vantage the 111 km shell subtends 73.1° from nadir and the solid
Earth 70.2°, so a 2.9°-wide annulus of directions produces
limb-GRAZING rays that traverse the entire atmosphere — the band the
sun crosses during an orbital sunset. Measured over that band
(`Tools/visual-regression/sun-orbital-limb-extinction.spec.mjs`): the
transmittance is EXACTLY (1,1,1) for tangent heights above 111 km,
then ramps monotonically to blue 8.3e-12 / red 1.7e-5 at a grazing
altitude of 0 km, with the red/blue ratio climbing 1.0 → 2.0e6. The
orbital-sunset reddening ramp S4 was scoped to build ALREADY EXISTS
here; what kept it invisible was the legacy binary cull (replaced by
S1's continuous fade) — see the S4 verdict in the debugging log.
```

The finding that a queue row scoped to build an orbital-sunset reddening ramp
was closed by an existing implementation, and that a previous revision of the
comment asserted the opposite. The rewritten comment states the measured ramp
as current behaviour; this preserves the refuted claim and the row outcome.

### `packages/engine/Source/Scene/Sun.js` — `Sun#update`

_Moved 2026-08-11._

```text
KNOWN LIMIT (deferred polish, recorded on the C12-29 S4 row): the
integral is evaluated on the camera→sun-CENTRE ray only, so the whole
billboard receives ONE uniform tint. A real setting sun is graded
ACROSS its disc. At this vantage the sun's 0.5327° angular diameter
maps to a 21.33 km span in tangent height, and the upper-limb /
lower-limb transmittance ratio measured with THIS integrator is
strongly altitude- and channel-dependent:

  tangent h | ratio red | ratio green | ratio blue
  ----------+-----------+-------------+-----------
     60 km  |    1.02   |     1.05    |    1.12
     40 km  |    1.18   |     1.47    |    2.33
     25 km  |    2.27   |     6.16    |   4.8e1
     20 km  |    5.03   |     2.6e1   |   7.7e2
     15 km  |    5.1e1  |     7.7e2   |   2.0e5
     10 km  |    1.7e5  |     1.4e7   |   1.2e11
      0 km  |    2.6e9  |     9.7e11  |   1.9e17

An earlier revision of this comment quoted "~5.6x in blue" as if it
were the figure; it is only reached in a narrow ~31.75–34.25 km band
and UNDERSTATES the deferred limit by many orders of magnitude across
the 0–15 km band, which is exactly where an orbital sunset is
visually interesting. Differential extinction across the disc and
refraction lift/flattening are deliberately not implemented.
```

The full seven-row measurement of differential extinction across the solar
disc, and the record that an earlier figure in the same comment understated it
by many orders of magnitude. The rewritten comment keeps the limitation and
three representative rows; the whole table and the correction live here.

## Eclipse

### `packages/engine/Source/Scene/EclipseState.js` — `(module docblock)`

_Moved 2026-08-11._

```text
WHAT THIS REPLACES. Sun occlusion in this engine was a boolean with no
intensity path. WebGL culled the whole sun billboard once its bounding
sphere (SOLAR_RADIUS * (1 + glowLengthTS), roughly 6 solar radii — see
`Sun.js`) fell entirely inside the Earth occluder's horizon cone
(`Occluder.isBoundingSphereVisible` via `Scene.updateEnvironment`), so the
glow snapped from absent to full in a single frame. WebGPU built its sun
command with NO bounding volume at all (`WebGPUEnvironmentRenderer.js`),
so it never culled and instead hard-clipped per pixel against the globe's
depth. Neither backend treated the Moon as an occluder anywhere: a solar
eclipse rendered as two independent bodies with zero light coupling.
```

A cross-backend divergence with no local consequence now that both backends
read `eclipseState`: WebGL culled the sun by bounding sphere while WebGPU
never culled at all and clipped per pixel instead. Kept because the two
behaviours are still reachable through the `enableEclipse` off position and
the binary cull that `Scene.updateEnvironment` still runs.

### `packages/engine/Source/Scene/EclipseState.js` — `(module docblock)`

_Moved 2026-08-11._

```text
THE FLOOR. Totality is civil twilight, not night: ~5 lux against ~100,000
lux full sun (AAS; Optica sky-brightness survey), and a full-moon night is
~10x darker still. `ECLIPSE_RADIOMETRIC_FLOOR = 5 / 100000` stands in for
the light the camera-anchored model cannot compute — the umbral sky lit by
multiple scattering from OUTSIDE the umbra (nonlocal; the exact treatment
is Schneegans' precomputed eclipse-shadow Bruneton extension, recorded as a
future L-item). It is what makes the multiplier bounded away from zero.
```

Names the exact technique the floor is standing in for — Schneegans'
precomputed eclipse-shadow extension of the Bruneton atmosphere model — and
records that it was filed as future work. The rewritten comment describes the
missing physics but not the reference implementation.

### `packages/engine/Source/Scene/EclipseState.js` — `computeHorizonTwilightStrength`

_Moved 2026-08-11._

```text
THE ONSET is keyed to obscuration, the same quantity S2 dims by (never
magnitude — the Stellarium #3720 trap is about driving the DIMMING SCALAR
from magnitude, and it still applies). Below `ECLIPSE_TWILIGHT_ONSET` the
strength is exactly 0, so every partial eclipse is byte-identical.
```

Cites the upstream issue (Stellarium #3720) behind the rule that eclipse
dimming is keyed to obscuration and never to magnitude. The rewritten comment
states the rule; this preserves the external report it came from.

## Sky brightness

### `packages/engine/Source/Scene/SkyBrightness.js` — `computeAtmosphericColumnFactor`

_Moved 2026-08-11._

```text
C12-29 S6 / ruling E3. `computeSkyBrightness` is a SKY brightness — it is
produced by sunlight scattering in the air above the observer. Above the
atmosphere there is no such air, the sky is black, and stars are visible on
the day side; that is why `StarFieldMath.computeStarDayFade` has carried a
100 km cutoff for the sprite starfield since it was written. Without the
same gate here, flipping `enableStarBrightnessModulation` on by default
would have zeroed the star cubemap across the entire sunlit hemisphere for
an orbital camera — the exact regression C11-176 turned the flag off for.
```

Records that a specific queue row disabled `enableStarBrightnessModulation`
because of this regression, and that the column factor is what allows it to be
enabled again. The rewritten comment states the gate and the failure it
prevents without the row reference.

### `packages/engine/Source/Scene/SkyBrightness.js` — `computeSkyBrightnessFromZenithMagnitude`

_Moved 2026-08-11._

```text
Those two fixed points pin the curve
constants at (inflection 0, steepness 23.0) — the C12-34 re-derivation
CONFIRMS the shipped pair rather than moving it — and therefore pin the
star-visibility window of the scalar to [0, 1/23].
```

Records that the log-luminance re-derivation arrived at the same
`(inflection 0, steepness 23.0)` pair that was already shipped, rather than
changing it. That agreement is evidence about the constants and not a property
of the code, so the rewritten comment states only that the fixed points pin
them.

## Sun bake and bloom

### `packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js` — `createSunTexture`

_Moved 2026-08-11._

```text
C12-15 — limb-darkened disc radiance in place of the binary step.
See the SDR-clamp caveat in SunTextureFS.glsl's main(): with the
0..1 clamp below still in place this is masked at defaults and
becomes visible under C12-19.
```

The WebGPU half of the same refuted premise as the entry above: it asserts the
limb law is masked at defaults, which the halo hand-off had already made false.
Kept so the two backends' copies of the claim are both on record.

### `packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js` — `updateWebGPUSun`

_Moved 2026-08-11._

```text
WHAT THIS FIXES, measured (C12-29 round 3, recorded on the
C12-15/16/17 rows). Under the previous additive blend
(`src-alpha` / `one`) the composite was `dst + src.rgb*src.a`, so a
BLACK billboard — which is exactly what the sun becomes once
atmospheric extinction drives its rgb to zero near the horizon —
was an EXACT IDENTITY on WebGPU while WebGL's ALPHA_BLEND darkened
the sky by `a*dst`. That single divergence reproduced every
observation in that investigation: a residual that appeared only
where the billboard was black, tracked `bgMean`, and collapsed to 0
at the one step where no billboard was drawn.
```

The measured evidence that identified the WebGPU sun blend divergence, from an
investigation into a horizon sky residual. The code now simply blends
`ALPHA_BLEND`, so the symptom list has no home there; this is what would let a
future reader recognise the same signature if the blend regressed.

### `packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js` — `updateWebGPUMoon`

_Moved 2026-08-11._

```text
Batch 244 — read the canonical `frameState.snapshotMode`
publication (Scene.updateFrameState). The old `frameState.scene`
read was ALWAYS undefined (that property is never populated —
same dormant-gate bug class as Batch 234's `taaEnabled` fix), so
this registration silently never fired and the moon kept packing
+ uploading uniforms every frame while the scene was frozen.
```

Names a recurring defect class — a gate read from a `frameState` property that
is never populated, so the gate silently never fires — and cites a second
instance of it in the `taaEnabled` path. The rewritten comment carries only the
local constraint, so the cross-instance pointer lives here.

## Moon

### `packages/engine/Source/Scene/Moon.js` — `moonNormalMapVariants`

_Moved 2026-08-11._

```text
The 2K variant's map remains 1024x512 until C12-33's moving-camera gate is
certified. Before C12-33 neither backend generated Moon mip chains, so at
the default ~16 px disc a 2048-wide normal map would have paid ~64:1
minification from mip 0 and visibly shimmered the lighting. The runtime now
generates complete chains and supplies seam-correct explicit gradients on
both backends; the smaller map is retained as the accepted baseline until
the close/seam/limb/minified motion probe proves that behavior in real Edge.
```

Records that the shipped 1024x512 normal map is a held baseline waiting on a
moving-camera probe in Edge, not a permanent resolution choice. The code
comment keeps the minification arithmetic and the re-bake command; this keeps
the outstanding acceptance condition.

### `packages/engine/Source/Scene/MoonPhaseAppearance.js` — `MEAN_SOLAR_ANGULAR_RADIUS`

_Moved 2026-08-11._

```text
`asin(CesiumMath.SOLAR_RADIUS / ASTRONOMICAL_UNIT)` = 4.6491e-3 rad =
0.26638°, i.e. a 0.5328° angular diameter. NOTE for anyone comparing
against the C12-22 queue row: that row quotes "±0.0044", which is the
half-angle of a solar diameter ROUNDED to 0.5° (0.25° = 4.3633e-3 rad). The
unrounded figure used here is 6.6% larger. The difference is far below one
pixel at any rendered disc size, but there is no reason to ship the rounded
number when the exact one costs the same.
```

Explains why the shipped solar angular radius does not match the number
written in the queue row that requested it. The rewritten comment keeps both
figures and the 6.6% gap; this keeps the pointer to the row, which is the only
place a reader would hit the discrepancy.

### `packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl` — `vs`

_Moved 2026-08-11._

```text
Reconstruct the eye-space position of this vertex by transforming the
RTE position through the same MV path used to build mvpRTE. The MVP-RTE
gives clip space; we want eye space. The simplest stable approach is
to transform `posMC` through a separate `modelView` uniform — but we
don't have one. Instead, we compute hitEC by inverting the projection
on `clip` (perspective divide cancels later).

Cleaner alternative: the FS doesn't need exact hitEC, only the
*direction* from the eye. We pass the cube vertex's eye-space
*direction* (interpolated) and the FS does:
    dirEC = normalize(hitEC_interpolated)
    dirMC = inverseModelView3x3 * dirEC
The numerical issue is that `hitEC` interpolated in clip space gives
wrong direction at perspective; perspective-correct interpolation
(which WebGPU does by default for non-flat varyings) handles this.

Compute hitEC by chasing through inverseProjection(clip):
  hitEC = (inverseProjection * clip).xyz / w
But we don't have inverseProjection either. The pragmatic fix: pass the
model-space cube vertex position through, and the FS rotates it to eye
space using the *inverse* of inverseModelView (= modelView). That's
also not in our uniforms.

OK, the cleanest path is to actually pass posMC straight through and
do the eye-space ray-direction reconstruction in the FS using the
ivmRow* matrix — model→eye is the *transpose* of (eye→model), and
since the matrix is orthonormal, transpose = inverse, so we already
have what we need: model-space position of the surface point at this
vertex IS posMC, and the eye position in model space IS u.cameraPositionMC.
The FS just uses (posMC - cameraPositionMC) as the model-space ray
direction directly. No matrix inversion needed.

hitEC field becomes "model-space hit point at this vertex" — renaming
would be cleaner but the field name `hitEC` is just a label.
```

Three eye-space reconstruction routes were considered and rejected before the
model-space pass-through: an added `modelView` uniform, inverting the
projection on `clip`, and rotating by the transpose of `ivmRow*`. The
rewritten comment states only the arrangement that shipped, so this preserves
the alternatives and why each was dropped.

## Starfield and catalogue

### `packages/engine/Source/Renderer/WebGPU/WebGPUStarFieldRenderer.ts` — `(module docblock)`

_Moved 2026-08-11._

```text
NEW-TS-CONVERT-JS-RENDERERS (Batch 314) — converted from JS to
TypeScript with ZERO behavior change. Types annotate the existing
logic; the module-level function shapes, exports, and runtime paths are
byte-for-byte equivalent to the prior `.js`.
```

Records that this renderer's TypeScript form was a pure annotation of a prior
`.js` file with no runtime change, which is the reason a behavioural diff
against that revision is expected to be empty.

### `packages/engine/Source/Renderer/WebGPU/WebGPUStarFieldRenderer.ts` — `updateWebGPUStarField`

_Moved 2026-08-11._

```text
C12-29 S6 — one cached command, not a binned+injected pair. The prior
dual path allocated two commands per contributing frame, pushed one into
the command list, then made Scene scan and splice it back out because
both copies would execute additively. Batch 761's
`EnvironmentFrustumDemand.hasInjectedEnvironmentContent` already treats
the returned `starFieldCommand` as sufficient sky-only frustum demand, so
the transient binned copy provides no remaining functionality.
```

Preserves the refuted bin-then-splice design and why it was removed, so a
future change that re-introduces a binned copy is recognisable as a
regression rather than an addition.

### `packages/engine/Source/Scene/StarFieldMath.ts` — `buildStarInstanceData`

_Moved 2026-08-11._

```text
Per-star brightness from visual magnitude — C12-08 dynamic-range
restoration. The magnitude→intensity mapping is STRICTLY LINEAR in
flux (Pogson 1856: relative flux = 10^(−0.4·mag)); the historical
FLUX_GAMMA=0.5 / LO / HI band is GONE. That band pre-crushed the true
38.4:1 flux range of the then-rendered set (mag −1.46…2.5) to 2.70:1
before any exposure control could act — Sirius and a 2nd-magnitude
star arrived nearly identical, then both clipped into the same white
plateau (CELESTIAL_APPEARANCE_RESEARCH_2026-07-19.md §2d).

Retired / re-derived constants (C12-08 ledger):
  FLUX_GAMMA — RETIRED. Gamma-compression destroyed flux ordering
    information permanently; linearity is the whole point.
  LO — RETIRED. The faint floor is now the FAINT_ANCHOR_PEAK exposure
    anchor above, expressed in framebuffer units, not a remap band.
  HI — RETIRED. The bright peak now emerges from physics (I_max ≈ 5.87
    for Sirius); the C12-07 shader amplitude split confines the
    resulting clip to a ≤~1.3 px core instead of a 4 px plateau.
    Raising brightness caps under an LDR clamp only widens the white
    disc — do not reintroduce HI.
  MAG_CUTOFF — SURVIVES, re-derived: now the vendored-catalogue
    inclusion bound (the faintest vendored star), not a bright-
    stars-only gate. The whole catalogue renders; stars between the
    3.6 anchor and the bound fall below the guaranteed M1 census floor
    but remain visible.
```

The only written record of the three retired remap constants and the measured
2.70:1 crush they produced. The rewritten comment states the linear-flux
constraint; this preserves the evidence that motivated it and the names a
future reader might otherwise reintroduce.

### `packages/engine/Source/Scene/StarFieldMath.ts` — `STAR_MODULATION_STEEPNESS`

_Moved 2026-08-11._

```text
OFF-ANCHOR VALUES, now DERIVED rather than recorded-as-defects (C12-34).
The two "measured consequences" this block used to carry — full moon
overhead at factor 0.01818 (NELM ~2.2 against a published ~4.5) and mid
civil twilight at exactly 0 — both followed from the pre-C12-34
`computeSkyBrightness` collapsing to exactly 0 once the sun was below
-5.74 deg: it had no dynamic range across the twilight decade, so no
choice of these two curve parameters could separate "late civil twilight"
from "astronomical night". The C12-34 log-luminance estimator (see
`SkyBrightness.js`) restores that range at the SOURCE and calibrates its
perceptual transfer against this curve, so the composition
`modulation(computeSkyBrightness(...))` now reproduces the published
naked-eye limits the old pair missed:

MEASURED CONSEQUENCES OF THE SWAP — what actually moves on screen, at which
solar elevations, and by how much. Every row is the shipped composition
`modulation(computeSkyBrightness(sun at h, moonless, ground camera))`, run
against the pre-C12-34 double-smoothstep and against the shipped estimator:

  sun elev |  old factor (NELM) |  new factor (NELM) |  change
  ---------|--------------------|--------------------|-------------------
   <= -18  |  1.000000 (6.50)   |  1.000000 (6.50)   |  BYTE-IDENTICAL
     -15   |  1.000000 (6.50)   |  0.604705 (5.95)   |  -0.55 mag
     -12   |  1.000000 (6.50)   |  0.363078 (5.40)   |  -1.10 mag
      -9   |  1.000000 (6.50)   |  0.098257 (3.98)   |  -2.52 mag
      -6   |  1.000000 (6.50)   |  0.026303 (2.55)   |  -3.95 mag
      -3   |  0.370549 (5.42)   |  0.006619 (1.05)   |  -4.37 mag
      -2   |  0.000000 (none)   |  0.004175 (0.55)   |  stars RETURN
       0   |  0.000000 (none)   |  0.001660 (-0.45)  |  ~none either way
  >= +23.6 |  0.000000 (none)   |  0.000000 (none)   |  BYTE-IDENTICAL

The single number that names the defect: across -18 deg to -6 deg — the
astronomical and nautical bands, half the twilight decade — the OLD
factor's total span was EXACTLY 0.000000. The new span is 0.973697. The
old curve did all of its work inside one 3.7-degree window (-5.74 deg,
factor 1, to -2 deg, factor 0) and none anywhere else; the new one is
monotone across the whole range and hands each band a distinct sky.

Moonlight moves too, and mostly at full phase, because the flat 4%
perceptual constant is replaced by the published full-moon sky brightness
plus the `p^3.64` phase-flux law (moon overhead, astronomical night):
  p = 0.25 -> 0.865634 -> 0.902705   (+0.05 mag; a quarter moon was being
              over-weighted ~6x by the old LINEAR phase scaling)
  p = 0.50 -> 0.559872 -> 0.510830   (-0.10 mag)
  p = 0.75 -> 0.228718 -> 0.273275   (+0.19 mag)
  p = 1.00 -> 0.018176 -> 0.165959   (+2.40 mag; 9.13x. This is the queue
              row's headline defect: NELM 2.15 -> 4.55 against a published
              full-moon limit of ~4.5.)

And the eclipse anchors, which had to survive unmoved and did: HIGH-sun
totality is still `1.0 * ECLIPSE_TWILIGHT_FLOOR` -> factor 0.062810
(-3.00 mag), bit-for-bit, because a saturated day is still exactly 1.0.
Only the LOW-sun totality moves, 0.5246 -> 0.664912 (-0.70 -> -0.44 mag),
and it moves in the correct direction for the same reason it always did.
```

A before/after measurement of the sky-brightness estimator swap rather than a
property of the shipped curve. The shipped column survives in the rewritten
comment; this keeps the retired estimator's numbers, which are what make the
size of the change legible and are the only record that the old curve had zero
span across the astronomical and nautical bands.

### `packages/engine/Source/Scene/StarCubeMapResource.js` — `(module docblock)`

_Moved 2026-08-11._

```text
─── PRINCIPLE 7: NOTHING CONSUMES THIS YET, AND THAT IS THE POINT ─────────

**Do not delete this module because grep shows no reader.** It exists to
discharge a named, recorded blocker:
`migration_doc/CELESTIAL_WATER_REFLECTION_RESEARCH.md` lists
*"Samplable STAR cubemap"* as the **biggest gap** for `C11-163`
(C11-CELESTIAL-WATER-REFLECTION), noting that `StarField.wgsl` is
un-samplable point sprites and `ProceduralSkyCubemap.wgsl` carries the
atmosphere only, so its planned `sampleStarField()` had no texture to read.
`C12-14` is the row that closes that gap; `C11-163` is the row that consumes
it. Between the two, this is scaffolding by design.
```

Names the queue rows on both sides of this module's scaffolding — the one that
produced it and the celestial-water-reflection row that is meant to consume it
— which is the record a future dead-code audit needs and which the rewritten
comment states only as a constraint.

### `packages/engine/Source/Scene/BrightStarCatalog.js` — `(module docblock)`

_Moved 2026-08-11._

```text
⚠ PROVENANCE CORRECTION (2026-07-19). This docblock previously asserted that
BSC5 "is in the PUBLIC DOMAIN". **That claim was not supported and has been
withdrawn.** A primary-source licensing review found no copyright notice,
licence, or public-domain dedication in the CDS V/50 ReadMe, the HEASARC
BSC5P page, or the BSC5 documentation — the catalogue is demonstrably
*freely available*, which is not the same thing as public domain.

**Do not restore the public-domain assertion without a written grant.**
The C12-09 ingest below **satisfied** DR-02's three conditions rather than
clearing the underlying question: it is sourced from **NASA HEASARC** (US
federal; no EU database-right maker) rather than VizieR/CDS, it vendors
**only** the four factual columns, and it is re-sorted under this file's own
schema rather than shipping V/50's row order.
```

Records that a public-domain claim was once made here and formally withdrawn,
and the three ingest conditions the current vendoring was designed to satisfy.
The rewritten docblock states the licensing position in the present tense; this
preserves the fact that the opposite claim shipped, so its reappearance reads
as a regression rather than a new finding.

### `packages/engine/Source/Scene/BrightStarCatalog.js` — `BrightStarCatalog.data`

_Moved 2026-08-11._

```text
The first 263 rows are the hand-curated, name-annotated core the fork
shipped through C12-08, in their historical order. **24 of them carried
transcription errors** — a named star placed where no BSC5 star of that
brightness exists, almost always a wrong right ascension with the
declination and photometry copied correctly (displacements 0.07° to 29.5°,
ν Hya the worst). C12-09 repositioned all 24 from the source; the pinned
correction table, and the evidence identifying each star, are in
`Tools/star-catalog-bake/bake-star-catalog.mjs` and the manifest beside it.
This mattered little while the cubemap painted every star anyway; under
DR-01 it is a named star visibly in the wrong constellation, drawn twice.
```

The measured error census of the hand-curated rows (24 of 263, displacements
0.07° to 29.5°) is about the historical table rather than the shipped one, and
it is the reason the curated block is no longer hand-edited.

## WebGPU environment maps

### `packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts` — `SKY_UNIFORM_FLOATS`

_Moved 2026-08-11._

```text
Item 4.2 (CLOUD-IBL, Batch 441) grew the struct 144→160 bytes (one new vec4
slot) for the effective cloud-coverage scalar. Item 3-C (CLOUD-IBL-FULL,
Batch 450) grew it 160→224 bytes (four new vec4 rows) for the full per-face
cloud-march controls. Add-only; the off path packs cloudMarch = 0 → the WGSL
march branch is skipped + the noise bindings are 1×1×1 placeholders →
byte-identical to the 4.2 fill. C13-37 grows it 224→272 bytes with three
CPU-f64 planet-domain origin-phase rows shared with the visible cloud march.
```

The size ledger for a uniform block that is in byte-exact lockstep with
`ProceduralSkyCubemap.wgsl`. Each recorded step names which feature added which
rows, which is the only written record of why the block is 272 bytes rather than
the original 144. The rewritten comment keeps the add-only constraint and the
off-path inertness; the byte-by-byte growth trail is about the work.

### `packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts` — `runIBLPrefilter`

_Moved 2026-08-11._

```text
Audit re-review (Batch 134) -- `generateIBLMaps` itself doesn't
read `sourceVersion` (only the explicit-IBL `WebGPUImageBasedLighting`
caller uses it as a regen gate), so the previous bump here was
dead. Existing C-P17 cleanup at `WebGPUIBLPipeline.ts:149/239`
destroys the old irradiance + radiance textures before recreating
them, so re-running prefilter on each sun-direction refresh does
not leak GPU memory.
```

Records a refuted change — bumping `sourceVersion` from this caller — together
with the two line numbers in `WebGPUIBLPipeline.ts` where the texture cleanup
that makes per-refresh prefiltering leak-free actually lives. The rewritten
comment keeps both facts as constraints; the line numbers and the fact that a
bump was once present and removed are about the work.

## Appendix — not remediated by this shard

Not a moved comment. Recorded here because it is the one part of the celestial
file set the rewrite could not reach, and because the cause is general rather
than celestial.

`packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js` defines
`SUN_SHADER_WGSL` as a **template literal** (lines 73-156 at the time of the
rewrite). The WGSL inside it carries nine marker-bearing lines — 79, 82, 92,
93, 137, 140, 144, 148 and 152 — with `C12-19`, `C12-29 S1`, `C11-115` and
`C7-SUN-STARS-EXTINCTION`, plus ALL-CAPS emphasis.

Two instruments disagree about what those bytes are, and both are behaving
correctly:

- `comment-marker-guard.mjs` tokenizes comments, and a template literal is a
  string, so it reports the file clean. That is why the file's entry in
  `comment-marker-cleanlist.txt` is honest on the guard's own terms while
  these markers stay in the shipped shader text.
- `comment-only-diff.mjs` classifies string literals as code, so editing them
  fails the gate every rewrite shard is bound by. The shard therefore cannot
  fix what the guard cannot see.

Census over `packages/*/Source`, restricted to template literals containing
shader source (`@vertex` / `@fragment` / `@compute` / `fn …(` / `void main(`):
**18 files, 223 marker-bearing lines.** Only one of the 18 is celestial scope;
the largest are `WebGPUVoxelRenderer.ts` (60), `WebGPUPointCloudRenderer.ts`
(29) and `WebGPUGaussianSplatRenderer.ts` (22), which belong to the splat,
point-cloud and voxel shards.

Closing this needs a campaign-level decision rather than a shard-level one,
because it is a batch that changes code bytes: either a pass explicitly
permitted to edit embedded-shader strings, or extraction of those literals into
real `.wgsl` files, which would additionally put them under the guard and under
the WGSL build pipeline.
