# Sun-disc dawn probe expectation — 2026-08-27

## Status and scope

This is a preregistered expectation for
`Tools/visual-regression/probe-sun-disc-dawn.mjs`. The probe is authored but has
never run. No browser was used for this computation, no pixels were acquired,
and this document is not probe evidence or a gate verdict.

The calculation uses direct engine Source imports, the shipped `Atmosphere`
defaults, the default Simon-1994 ephemeris provider, and
`computeAtmosphereExtinction` with `Ellipsoid.default.maximumRadius`, matching
the radius used by `Sun.update`. Solar altitude is the arcsine of the probe's
normalized camera-to-Sun vector dotted with the site's east-north-up axis. The
registered site is longitude `107.5215780802716`, latitude
`35.05292293726632`, height `1175.3399698570242` metres. The sweep begins
`2026-08-24T22:10:00Z`, advances in five-minute steps, and has 13 samples.

For a sampled sun texel `S`, existing billboard alpha `a`, surrounding sky
`B`, RGB transmittance `T`, and the new scalar `k = min(1, max(T))`, the relevant
source-over laws are:

```text
pre-fix:  a (S * T) + (1 - a) B
post-fix: ak(S * T) + (1 - ak)B
```

The prediction assumes the measured dawn defect: the extincted disc centre is
darker and redder than the bright aureole behind it. Reducing the centre's
occlusion therefore moves both published ratios upward toward the surrounding
sky: centre/annulus mean luminance, and centre/annulus blue-over-red. A ratio
below `1` is an inversion of the shipped centre-brighter-than-limb intensity
law. The backend-independent black-sky limb reference is `1.4398`.

## Per-sample expectation

`T` is `(red, green, blue)`. “Up” means greater than the paired, as-yet-unrun
pre-fix baseline under otherwise identical probe conditions.

| # | UTC | Solar altitude (degrees) | `T` | `k` | Centre/annulus luminance | Centre/annulus blue/red |
| -: | --- | -----------------------: | --- | --: | ------------------------ | ------------------------- |
| 0 | 22:10 | -1.886619470001 | `(5.971123567061e-8, 3.161223548429e-10, 6.699711925866e-15)` | `5.971123567061e-8` | Runtime-dependent; strongly up if scored | Runtime-dependent; up negligibly if scored |
| 1 | 22:15 | -0.896283078951 | `(3.412526924471e-6, 5.539381514457e-8, 1.171616652549e-11)` | `3.412526924471e-6` | Runtime-dependent; strongly up if scored | Runtime-dependent; slightly up if scored |
| 2 | 22:20 | 0.097204050875 | `(8.286821026254e-5, 3.348847078352e-6, 4.608827174372e-9)` | `8.286821026254e-5` | Up most strongly among nominally scored rows | Up, but less than the mid-sweep chroma movement |
| 3 | 22:25 | 1.093666147256 | `(1.002704540300e-3, 8.289138252351e-5, 4.959525505418e-7)` | `1.002704540300e-3` | Strongly up | Strongly up |
| 4 | 22:30 | 2.092931384543 | `(5.960714081841e-3, 8.340712002446e-4, 1.470486540877e-5)` | `5.960714081841e-3` | Strongly up | Strongly up |
| 5 | 22:35 | 3.094831537667 | `(1.591864279916e-2, 3.174797003003e-3, 1.158756915286e-4)` | `1.591864279916e-2` | Strongly up | Strongly up |
| 6 | 22:40 | 4.099201640388 | `(3.301409370414e-2, 8.548973880689e-3, 5.333938335651e-4)` | `3.301409370414e-2` | Strongly up | Strongly up |
| 7 | 22:45 | 5.105879646921 | `(6.185653657473e-2, 1.969899148147e-2, 1.879564464206e-3)` | `6.185653657473e-2` | Strongly up | Strongly up |
| 8 | 22:50 | 6.114706095875 | `(9.501627700039e-2, 3.532292994243e-2, 4.630784866332e-3)` | `9.501627700039e-2` | Up | Up; largest-change group in the model |
| 9 | 22:55 | 7.125523775566 | `(1.297019046969e-1, 5.433224715142e-2, 9.101777860295e-3)` | `1.297019046969e-1` | Up | Up; largest-change group in the model |
| 10 | 23:00 | 8.138177389434 | `(1.642444634436e-1, 7.562458221893e-2, 1.538308150797e-2)` | `1.642444634436e-1` | Up | Up |
| 11 | 23:05 | 9.152513220626 | `(1.977411631346e-1, 9.828737589175e-2, 2.339414013371e-2)` | `1.977411631346e-1` | Up; least-change luminance group | Up; declining from the mid-sweep peak, still material |
| 12 | 23:10 | 10.168378794233 | `(2.297409651298e-1, 1.216255956431e-1, 3.295085390236e-2)` | `2.297409651298e-1` | Up; least luminance change, but still material | Up; declining from the mid-sweep peak, still material |

The reported screenshot instant, `23:01:41Z`, computes to
`8.479490222575` degrees and lies inside the sweep as registered.

## Anchors, strongest movement, and the high-Sun limit

The exact `+5.1059` degree row gives approximately
`(6.19e-2, 1.97e-2, 1.88e-3)` and `k = 0.0619`, consistent with the recorded
`+5` degree anchor of about `(5.95e-2, 1.87e-2, 1.74e-3)`. The `+8.1382`
degree row gives `(0.1642, 0.0756, 0.0154)` and `k = 0.1642`. At those two
anchors, centre occlusion that was near `1` becomes roughly `0.062` and one
sixth, respectively, allowing the bright aureole to contribute behind the
disc.

The deepest-extinction, lowest-Sun samples should move the luminance ratio
most. If the two below-horizon rows are excluded as authored, sample 2 is the
deepest nominally scored row. Blue/red must also move upward, but its absolute
movement is nearly zero when the extincted source is practically black; the
model's largest blue/red change is around samples 8–9.

Samples 11–12 should move the luminance ratio least within this registered
window. They are not, however, numerically “nearly unchanged”: the last sample
has `k = 0.22974`, a 77 percent reduction in blend weight. The gate fixture's
warm-sky model still moves its luminance ratio from about `0.39089` to
`0.93229`. Blue/red change is on the declining side of its samples 8–9 peak at
rows 11–12, but remains larger than the change in rows 0–6. Near-identity
behavior is expected only at substantially higher solar altitude outside this
sweep, where `k` actually approaches `1`.

## Visibility and scoring caveat

The authored probe prose says below-horizon samples publish
`sunVisible: false`; `sampleIsScored` excludes every sample that actually
publishes false, and backend disagreement about visibility is a parity finding.
The executable gate does not exclude by altitude, however, so rows 0–1 are
excluded only if the engine publishes false at runtime.

There is a source-level caveat that the first browser run must resolve. Exact
Node evaluation of the current engine's cull geometry predicts
`environmentState.isSunVisible === true` for all 13 rows, including the two
negative-altitude rows. The occluder uses the ellipsoid's minimum radius while
the Sun command uses a six-solar-radius bounding sphere, so this binary cull
does not become false until roughly `-5.8` degrees. The existing gate fixture
also models row 0 as false and row 1 as true rather than excluding every
negative-altitude row. Because the browser probe has never run, neither
publication outcome may be represented as observed evidence. If rows 0–1
publish true, score them according to the registered gate and record the
visibility mismatch as a probe-contract finding; it is not evidence against
the alpha repair.

## Backend parity and falsifiable refutation

WebGL and WebGPU should both move under the same law. The scalar is resolved in
shared scene code, then consumed by twin fragment paths. A WebGL-versus-WebGPU
divergence is therefore a parity finding first, not evidence for or against the
shared repair.

Sample 7 is the preregistered discriminator: altitude `+5.105879646921`,
`k = 0.06185653657473`. Under the gate fixture's documented warm-sky law, its
luminance ratio is predicted to move from `0.1322829154` to `0.9811731468`,
and its centre/annulus blue/red ratio from `0.2579768694` to `0.9987745514`.
In a valid paired pre-fix/post-fix acquisition, a non-positive delta for either
metric on both backends at this sample refutes the corresponding co-fade
prediction. A change confined to one backend is instead a shader-parity
finding. An unusable geometry, visibility disagreement, or missing paired
baseline is blindness and cannot confirm or refute the repair.
