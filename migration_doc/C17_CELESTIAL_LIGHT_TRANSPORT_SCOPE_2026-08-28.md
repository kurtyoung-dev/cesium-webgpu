# Campaign 17 (Celestial Light Transport & Eye Adaptation) — Scope Refresh

**Date:** 2026-08-28. **Status: PROPOSED — NOT LAUNCHED.**

This document is **not** a launch ruling and must not be read as one. It refreshes the scope
of a **proposed** epic whose planning artifact is
[`CELESTIAL_LIGHT_TRANSPORT_PLAN_2026-08-07.md`](CELESTIAL_LIGHT_TRANSPORT_PLAN_2026-08-07.md),
which declares its own standing as **"PLANNED / RESEARCH-VERIFIED / NOT LAUNCHED"** and says
of itself that it "is not a launch ruling, and launch is a maintainer call"
(`CELESTIAL_LIGHT_TRANSPORT_PLAN_2026-08-07.md:3-16`).

**Campaign numbering is ratified add-only.** C17 is the *proposed* identity for this epic,
renumbered from 16 on 2026-08-08 after the maintainer's launch of Comment Remediation &
Attribution claimed Campaign 16 (`:9-13`). Nothing here renumbers a campaign. C14 = Dynamic
Ocean & Wind retains its identity.

**Why this refresh exists.** The plan landed at **Batch 900 (`3d2ce64660`)**, and **413
commits** separate that landing from this refresh's tip `41aad98761` — it was written before
the bulk of Campaign 12's close-out. A large fraction of what it scoped has since landed
inside C12 — and a
smaller but important fraction has landed *inside the plan's own tracks* without the plan's
front matter reflecting it. A scope document that does not subtract landed work will
re-brief work that is already done. §3 and §4 are that subtraction. §5 is what actually
remains.

**Reading rules.** Statuses come from the owning campaign queue, cited `file:line`. Batch
numbers and commit hashes are reproduced **as the owning queue prints them**; commit
subjects in this repo are known to overstate their diffs, so a subject is never the warrant.
Line numbers were re-derived at tip `41aad98761` and will drift. §8 records what this
document does not know.

---

## 1. What the epic covers

Four maintainer asks, restated in the plan (`:18-32`):

1. **Star brightness scaled by real light exposure at the camera** (eye adaptation) —
   occlusion-aware, so stars actually appear at night and during eclipses.
2. **Day→night global imagery interpolation**, camera-independent: each surface point
   blends by its own rotation relative to the sun.
3. **Globe eclipsing the sun for the camera** — extended-source sun with true angular size,
   plus glow and crepuscular-like rays past the limb.
4. **Moon eclipsing the sun for the camera** — the Apollo 11 / Artemis 2 look: corona around
   the dark disc, earthlight on the near side, zodiacal light along the ecliptic.

A fifth area was added by maintainer directive 2026-08-08 as **Track D — Atmosphere fidelity
at dawn/dusk** (`:460`): ozone in the extinction integral, energy-conserving multiple
scattering, a sky-view LUT, aerial perspective, and the shell-extent canonicity ruling.

Stated as physics, the epic is: **make the sun, moon, stars, sky and camera share one
radiometric chain** — one extended-source occlusion kernel, one exposure state, one
extinction integral — instead of the per-body approximations that currently produce
individually plausible bodies that do not agree with each other.

The plan's own headline finding is that the hardest prerequisite is already built: the
camera-anchored, limb-darkened, f64 analytic circle-vs-circle solar-disc occlusion against
both Earth limb and Moon exists and publishes `sunVisibleFraction`, per-occluder fractions,
all three angular radii and both separations. **"The gap is consumers, not the test"** —
`sunVisibleFraction` reaches only two consumers today (`:34-50`).

---

## 2. Structure as the plan defines it

**41 primary rows across four tracks** (`:139-210`, `:219-320`, `:324-381`, `:487-498`):

| Track | Title | Rows | Character |
|---|---|---|---|
| **A** | Eye adaptation & exposure | `CLT-A0` … `CLT-A12` (13) | Exposure state, star response, tonemapping seam, mesopic blend |
| **B** | Day/night imagery interpolation | `CLT-B1` … `CLT-B9` (9) | Terminator law, night raster, opt-in twilight blend, cost guard |
| **C** | Camera-side eclipse visuals | `CLT-C0` … `CLT-C8` (9) | Generic occlusion kernel, crescent, corona, halo, god rays, earthshine |
| **D** | Atmosphere fidelity at dawn/dusk | `CLT-D1` … `CLT-D10` (10) | Ozone, multiple scattering, sky-view LUT, aerial perspective, shell extent |

`CLT-C5a/b` are parts of the single `CLT-C5` row, not separate rows.
`CLT-B1-VERTEX-NORMAL-LANE-NEEDS-A-NETWORK-LANE` is a residual tracking name inside `CLT-B1`.

The plan's own recommended first slice is **A0 → A1 → C0 → C1** (all S, cheap, publish-only,
byte-identical), then A3, B1, C2 in parallel lanes; `CLT-A3` and `CLT-C8` must be designed
together because they are one publisher/consumer pair (`:383-390`).

---

## 3. What Campaign 12 already discharges

This is a **subtraction ledger, not a new verdict.** Sole status source:
`QUEUE_2026-07-19_CAMPAIGN12.md`. Every hash below is printed by that queue and was
confirmed to resolve.

### 3a. The sun

| C12 row | What it delivered | Batch / hash | Evidence state per the queue |
|---|---|---|---|
| `C12-15` | Three-coefficient limb-darkening law shared by both backends, replacing the flat solar disc | B766 | LANDED; G4 later certifies limb-darkening presence and shape |
| `C12-16` | Pedestal-subtracted Lorentzian / inverse-square glare tail | B766 | LANDED |
| `C12-17` | WebGPU sun bake matched to WebGL's format/size/radial support | B766 | LANDED |
| `C12-18` | True 0.53° disc (it had been undersized by exactly √2 on **both** backends), halo moved into the post-process chain on both, WebGPU sun blends `ALPHA_BLEND` | B906 `ca964bc1da`; B984 `943e13b571` | LANDED; Edge acceptance **discharged at the G4 close** |
| `C12-19` | True-HDR solar radiance as a **derived linear** scale with exact identity/off safety | B937 `794ece043a`; B994 `0697b93a5b` | LANDED; Edge-delta obligation **DISCHARGED**, exit 0 both backends, NO-EXCESS on live captures |
| `C12-34` | The **WebGPU sun-bloom mirror** of WebGL's `SunPostProcess` bright-pass glow, one shared tuning/shape contract, no double-counted C12-18 halo | B967 `68bf6e78d4`; B984 `943e13b571` | LANDED; **CERTIFIED**, acceptance discharged at the G4 close |

### 3b. The moon

| C12 row | What it delivered | Batch / hash | Evidence state |
|---|---|---|---|
| `C12-20` | Lommel–Seeliger lunar reflectance, so partial phases stop reading as an over-dark Lambert sphere | B756 `89dcd0da08` | LANDED; targeted gate passes |
| `C12-21` | CPU-resolved phase-dependent **earthshine**, and earthshine's first GLSL consumer, default-on with backend parity | B858 `2cb7d29fec`; B984 | LANDED; Edge acceptance discharged at G4 close |
| `C12-22` | Finite-Sun C1 quadratic-wrap lunar **terminator** using the true per-frame solar angular radius, both backends | B858 `2cb7d29fec`; B984 | LANDED; Edge acceptance discharged at G4 close |
| `C12-23` | Hapke SHOE **opposition surge** multiplier with a 1.0 identity, matching uniforms both backends | B756 `89dcd0da08` | LANDED |
| `C12-24` | NASA/LROC 2K Moon albedo; fixed WebGPU's vertically mirrored lunar upload | B801 | LANDED / PROBE-VERIFIED |
| `C12-25` | LOLA-derived 1K normal map + lunar-normal shader paths for terminator relief | B811, B813 | LANDED; EDGE VERIFIED / GATE PASS |
| `C12-30` | Closed the size/distance premise as physically correct; landed the real daytime-Moon defect (sky wash) | B752, B756 | MEASURED AND CLOSED / LANDED |
| `C12-33` | Moon-local explicit-gradient mip/LOD selection + frame-owned WebGPU mip generation, removing the moving seam | B819, B1087 `73221e8ec1`, B1100 `1d22e2c737` | Acceptance executed and certified PASS/exit 0 — **banking and countersign debts remain** |
| `C12-35` | Moon texture-request / device-lifecycle prerequisite incl. destruction and recovery | B819 | COMPLETE / LANDED / GATE PASS |
| `C12-37` | Conditional RTE/log-depth, depth-writing `Pass.OPAQUE` Moon route giving Moon/Earth overlap the **physical** winner while preserving the ordinary environment route | `6d4a2376fc` | RESOLVED / LANDED / EDGE VERIFIED; **discharged** |

**Gate G4 (Sun + Moon) CLOSED at Batch 984 (`943e13b571`)** — ninth run, first exit 0 on both
backends; every criterion certifies and measured limb deviations match the offline prediction
to four decimals (`QUEUE_2026-07-19_CAMPAIGN12.md:23`).

### 3c. Stars and sky

`C12-05` … `C12-08` (Moffat core+wing PSF on both backends; halo-extent quad sizing;
amplitude split so a clipped white core coexists with a sub-1.0 blackbody-hued halo; linear
Pogson flux restored with compression moved into an explicit exposure anchor) all landed at
**Batch 748 (`e0e20625ff`)**. `C12-09` deepened the shared catalog to **2,868** stars to
visual magnitude 5.5 on both renderers (B804 `6794488107`). `C12-27` applied inverse-square
angular solar-glare washout to nearby stars while keeping stars beyond 90° byte-identical
(B865 `193393790c`, B905 `ced8c1256f`), its **Edge acceptance discharged** at the first-ever
G2 pass. `C12-36` replaced the twilight double-smoothstep with a zenith-photometry /
log-luminance Sun+Moon model with `p^3.64` lunar phase flux and derived NELM transfer (B823
`f7c617304d`). **Gate G2 (white blobs) is effectively CLOSED**, passing its first run ever on
both backends at Batch 905 (`:22`).

### 3d. The eclipse chain — the largest single subtraction

| Slice | What it delivered | State |
|---|---|---|
| `C12-29` research | The missing-subsystem design: one f64 CPU `EclipseState` feeding sun alpha, lighting, atmosphere, sky brightness, clouds/IBL, bloom and globe umbra (B749) | DEEP RESEARCH COMPLETE |
| **S1** | Per-frame f64 `EclipseState` from real Simon1994 Moon/Earth-limb dual-cone overlap, driving sun-billboard alpha on both backends with exact off/invalid identity (B760) | LANDED |
| **S2** | Eclipse illumination routed into direct scene light, atmosphere/fog/sky brightness, and WebGPU model light, with a ~5-lux never-black totality floor | LANDED; targeted S6/S2 integration gate discharged |
| **S3** | Clouds/IBL eclipse response (`9c043987a5`) | **REOPENED** — see §5 |
| **S4** | Verified and wired the existing per-channel orbital extinction/reddening ramp on both backends — the queue is explicit that **"NO new limb-glow physics was written"** | COMPLETE / EDGE VERIFIED; PASS exit 0 |
| **S5** | Per-fragment lunar-shadow uniforms and GLSL/WGSL globe twins, the seven-lane gate stack, NASA SVS fixture provenance | Engine twins landed; **the final seven-lane matrix is OPEN** |
| **S6** | The **sky half**: one cached star command, star-map-only modulation, current Moon phase/direction, a continuous 60–111 km atmospheric-column law, stable Sun resources, totality/horizon-twilight integration | LANDED |

**A correction future readers need.** S6's original scope named "totality corona (Baumbach) +
360° twilight + ratified star reveal", but the landing prose proves only the sky half and
does not assert a Baumbach corona implementation. The plan's own §2 finding 4 records the
same drift: the C12 overlay says "S6 landed" unqualified, while the research found **no
corona code** (`CELESTIAL_LIGHT_TRANSPORT_PLAN_2026-08-07.md:113-118`). **`CLT-C3`
(Moon-totality corona) is therefore NOT discharged by S6.**

### 3e. Two claims this refresh had to correct

Both were carried into this work as premises and did not survive re-derivation. They are
recorded because the same beliefs will otherwise propagate.

1. **The sun-disc chroma/occlusion split is NOT in flight and NOT landed.** `C12-38`
   (`NEW-SUN-DISC-CENTRE-DARK-SPOT`, the dark centre appearing "mainly at dawn and sunrise",
   filed Batch 1148) is **TRIAGED 2026-08-25 — "diagnosis + instrument landed; NO VERDICT
   CLAIMED, Edge run OWED"**; the engine delta is **COMMENT-ONLY** and **"The rendering fix
   is HELD as a maintainer decision"** (`QUEUE_2026-07-19_CAMPAIGN12.md:2282`). The gate was
   authored and left unrun, every bound is null, and the queue says even a perfect sweep
   would fold to STRUCTURAL, so "this landing earns no verdict". The C12 queue's own dispatch
   line reads **"IN FLIGHT: nothing dispatched on C12 at this batch"** (`:54`). The
   chroma/occlusion split — apply only the *chromatic* part of transmittance to RGB and route
   achromatic dimming through alpha — is a **proposed option (B)**, not an implementation.
   **Its diagnosis is nonetheless a genuine input to this epic**: limb darkening supplies the
   artifact's shape, extinction its darkness and hue, and that is exactly a Track-D coupling
   question.
2. **STBN is not C12 celestial work.** "STBN" occurs **zero** times in the C12 queue. It is
   `C13-11` (STBN provenance), whose Part 1 landed at Batch 961 (`b288bfc7bb`) with Part 2
   (cloud consumption) a named open row (`CLOSEOUT_PLAN_2026-08-07.md:259`). It does not
   discharge any C17 scope and should not be listed as doing so.

---

## 4. What the CLT plan's own tracks have already discharged

The plan's front matter still reads as though nothing in it has moved. It has. These rows
are recorded complete **inside the plan itself** and must not be re-briefed:

| Row | State per the plan | Evidence |
|---|---|---|
| `CLT-B1` | **SUPERSEDED — do not schedule.** Only residual finding (c) survives: the vertex-normal gating split, which needs a provider with `hasVertexNormals === true` and is therefore an Ion/network lane | `:219-230` |
| `CLT-B2` | **DONE — Batch 913.** The `enableNightLights = false` no-op on WebGPU is fixed: enable is carried explicitly via a new `GLOBE_UB_UNSET = -1.0` law; the `oceanFoamThreshold` sibling was a **live** instance of the same hole and was fixed in-slice; four further latent siblings fixed | `:231-242`, `:90-101` |
| `CLT-B3` | Implementation **complete and landed**; the terminator-specific both-backend **browser acceptance remains**. Its containment should be reconciled with C12 exit-gate item 2 — same class, one owner not two | `:243-257`, `:391-392` |
| `CLT-B4` | **COMPLETE**, acceptance met at run 3. The day/night ramp law is now **one contract on both backends** | `:258-292` |

**And one more subtraction the plan's own tracks do not record — `CLT-C4` is SATISFIED.** This
was missed on the first pass of this refresh and is recorded here as a correction. Three
independent sources agree: `DEFERRED_WORK.md:11151-11153` states *"The `CLT-C4` coordination
rider is **SATISFIED** by the landed `C12-18`/`C12-19` halo, HDR, bloom, and exposure
composition; this does not close `CLT-C3` or the new prominence/flare owners below"*;
`FEATURE_INVENTORY.md:697` says *"`CLT-C4` is satisfied by landed `C12-18`/`C12-19`"*; and
`QUEUE_2026-08-02_CAMPAIGN15.md:535` refers to *"the satisfied `CLT-C4` seam"*. `CLT-C4` was
always scoped as a **coordination rider** on `C11-160`/`C12-18` rather than independent
scope, so its satisfaction is exactly what landing those rows was supposed to achieve.

**The `CLT-C3` neighbourhood has also been split and partly re-homed**, which the CLT plan
predates (`DEFERRED_WORK.md:11147-11158`, under `NEW-ECLIPSE-CORONA-PROMINENCE-SPACE-WEATHER-VISUALS`,
**OPEN / SPLIT OWNERSHIP**). `CLT-C3` remains **exactly** the corona — "an analytic,
energy-bounded shape revealed through the last fraction of occultation" — while three
adjacent owners now exist outside it: `CLT-C3P` / `NEW-ECLIPSE-LOCATED-PROMINENCE-RENDERER`
(the actual WebGL/WebGPU prominence rendering), `C15-06P` (attributed located-prominence
state and provenance only), and `NEW-VISIBLE-LIGHT-SOLAR-FLARE-PHOTOMETRIC-TRANSFER`. A C17
launch packet must not re-absorb those into `CLT-C3`; Campaign 15 owns the state, ingest,
facade and certification boundaries.

`CLT-B4`'s history is the most instructive artifact in the plan and is worth reading before
briefing any Track-B or Track-D work. The recorded mechanism (a `+0.5` offset) was **refuted
by its own first probe run**, which found the WebGPU day/night term did not vary with N·L at
all because it read a constant mesh normal on normal-less terrain. The normal source was
fixed first (Batch 919), which made the original divergence *measurable for the first time*;
the real defect then proved to be **three divergences wearing one mechanism** — the offset on
the alpha ramp, the lighting term being driven by that ramp instead of its own expression,
and a missing camera-distance mix — all resolved at Batch 927. Two lanes read **REFUTED** at
acceptance, and that REFUTED *was the fix reporting itself*. The plan states the reading rule
plainly: **read the metrics, not the exit code.**

---

## 5. What remains genuinely open

Excluding pure banking, countersign, held-packet and hardware-confirmation debt.

### 5a. Carried into C17 by explicit ruling

- **`CLT-D10` — shell-extent alpha canonicity.** This is C12's gate **G1**, ruled acceptable
  red at C12 close by `R-2026-08-21-14` and **carried to proposed C17 as `CLT-D10`**
  (`QUEUE_2026-07-19_CAMPAIGN12.md:20`). The underlying item is
  `NEW-WEBGPU-SKYATMOSPHERE-SHELL-EXTENT-ALPHA`: WebGL's fixed ray-exit clip versus WebGPU's
  full-coverage shell. `CLT-D10` is an **alias for that blocker, not a second item**. It is
  ruling-gated and must be **ruled at epic launch before any Track-D twilight probe**
  (`CELESTIAL_LIGHT_TRANSPORT_PLAN_2026-08-07.md:498`), because until the canonicity is
  settled the `starEnergyRatio` measurement is reading the shell's alpha rather than the
  modulation term (`QUEUE_2026-07-19_CAMPAIGN12.md:20`). **This is the epic's first
  decision, and it arrives already red.**
- **`C12-26` — nightglow.** Ruled **OUT of the C12 exit gate and deferred to C17 as new
  light-transport physics** by `R-2026-08-21-16` (`QUEUE_2026-07-19_CAMPAIGN12.md:2280`,
  `:50`). O I 557.7 / 630.0 nm emission is sun-independent, and the scattering shell has no
  path that can produce a night-side Earth-limb band.

### 5b. Genuinely open celestial physics still sitting in C12

These are C12's to close, but they define the boundary C17 inherits:

- **`C12-29` S3 / `C13-41`** — eclipse response of clouds and IBL. REOPENED; the remaining
  exit condition is a **mechanism** investigation of the 1.0496 `shadowContrastInvariant`
  reading, and the queue is explicit that naming the known confound "is not the same as
  explaining the 1.0496" (`QUEUE_2026-07-23_CAMPAIGN13.md:783-787`).
- **`C12-29` S4 deferred polish** — "Differential extinction across the disc now sits beside
  refraction lift/flattening as deferred polish; **neither is implemented**"
  (`QUEUE_2026-07-19_CAMPAIGN12.md:2006`). `CLT-D9` (sun-disc cross-limb extinction
  gradient) is scoped to discharge exactly this deferral (`CLT plan:497`).
- **`C12-29` S5** — the seven-lane certification matrix, including absolute NASA-SVS
  geospatial/terrain umbra behaviour.
- **`C12-31`** — the full aureole acceptance sweep; findings #4 and #6 remain open in-source
  and the row is "NOT freeze-ready" (`:43`, `:2009`).
- **`C12-38`** — the dawn sun-disc defect: diagnosed, instrument authored, **fix held**
  (§3e).
- **`G3` / `C12-12`** — the star cubemap misses its ratified angular-resolution, chroma and
  dust bars; the ordered 4096/face re-bake is not executed. Appearance data rather than
  transport physics, but it caps what any star-brightness work can demonstrate.

### 5c. Open within the CLT plan's own tracks

- **Track A is entirely unstarted** (A0–A12). Its foundation is `CLT-A0` (premise
  re-verification at HEAD plus an absolute-luminance ledger and a fresh twilight baseline) —
  note that the plan's premises were verified at `9d7fa308ca` and the tree has moved
  substantially since, so A0 is not optional bookkeeping.
- **`CLT-C6` has no home yet.** Two sun/limb divergences are **prose-only** and the plan asks
  for `DEFERRED_WORK` rows to be minted: `NEW-WEBGPU-SUN-COMMAND-NO-BOUNDING-VOLUME` (the
  WebGPU sun is never culled) and `NEW-WEBGPU-NEAR-LIMB-GLOBE-ABSENT` — the latter described
  as **"the largest divergence in the entire measurement"**, which **"makes every Earth-limb
  camera-side visual un-probeable on WebGPU until diagnosed"** (`CLT plan:5`, `:367-369`).
  **`CLT-C6` is a hard prerequisite for accepting `CLT-C2`'s Earth-limb leg and all of
  `CLT-C5`.** It is the highest-leverage unstarted item in the epic. **Re-verified for this
  refresh:** both identifiers still return **zero** occurrences in `DEFERRED_WORK.md`, so the
  minting the plan asked for on 2026-08-07 has still not happened, 413 commits later. Minting
  them is cheap, is dispatchable without launching the epic, and stops the two divergences
  from living only in prose.
- **`CLT-A5` / `enableNightSkyDimming`** — declared default-true but with **zero consumers on
  either backend**; wire it or retire it (`CLT plan:6`, `:175-177`). **Re-verified in current
  source for this refresh:** the declaration is at `Scene/AtmosphericConditions.js:590` (not
  `:641` as the plan cites), and the source now documents the gap itself — *"Reserved and
  currently unwired: this is the only reference to `enableNightSkyDimming` under
  `packages/engine/Source`. It is intended for a night-side dim in the sky-atmosphere shader,
  but no consumer reads it, so setting it has no effect until one exists."* (`:586-589`).
  C12's EXIT-2 audit independently records it as UNWIRED.
- **`CLT-C3`** — the Baumbach-shape totality corona, *not* discharged by S6 (§3d).
  **Independently confirmed for this refresh:** a case-insensitive sweep of
  `packages/engine/Source/` for `baumbach`, `corona`, `k-corona` and `f-corona` returns **no
  implementation** — every hit is prose (docstrings in `WebGPUEllipsoidRenderer.ts`, comments
  in `AtmosphericConditions.js`, `EclipseState.js`, `SunHaloAppearance.js` and
  `SunPostProcess.js`), the constellation name "Corona Borealis" in `BrightStarCatalog.js`,
  or a *diffraction* corona in `ProceduralClouds.wgsl`, which is a different phenomenon.
  `CLT-C3` is genuinely unstarted.
- **Track D beyond D10** — ozone in the celestial extinction integral and its GLSL twin,
  energy-conserving multiple scattering, the sky-view LUT, aerial perspective certification,
  and the cross-limb extinction gradient.

### 5d. Rulings the epic cannot start without

`CLT-A9` (Schaefer NELM law — moves ratified C12 anchors), `CLT-B6` (three composition
rulings), `CLT-D5` (ozone default-on), `CLT-D8` (aerial-perspective default), `CLT-D10`
(shell-extent canonicity), and `CLT-A2`/`CLT-A5` defaults are all recorded in the plan as
maintainer calls (`:197-200`, `:300-305`, `:493`, `:496`, `:498`, `:155-156`, `:175-177`).
**Six-plus rulings is a launch-time batch, not a per-row trickle** — they should be put as
one packet.

---

## 6. Candidate row breakdown and dependency order

**PROPOSAL.** Row identifiers are the plan's own; the grouping and ordering below are this
document's recommendation, not a ratified sequence.

```text
  ── PRE-LAUNCH (dispatchable without launching the epic) ──
  CLT-C6-mint ......... mint the two DEFERRED_WORK rows for the sun/limb divergences
  CLT-A0 .............. premise re-verification at HEAD (the plan's premises are from 9d7fa308ca)

  ── SLICE 1: FOUNDATIONS (cheap, publish-only, byte-identical) ──
  CLT-A0 ──> CLT-A1 ──> CLT-C0 ──> CLT-C1
             (μ + luminance)  (generic occlusion kernel)  (limb dir/bearing/radius/contact class)
                    │
                    └──> CLT-C8 ──┐
                                  ├── designed together, one publisher
                         CLT-A3 ──┘  (SceneLightExposure state)

  ── SLICE 2: UNBLOCK THE EARTH-LIMB LANE (gating everything camera-side) ──
  CLT-C6 (diagnose near-limb-globe-absent + sun bounding volume)
        └──> CLT-C2 (partially occulted sun crescent — Earth-limb leg)
        └──> CLT-C5 (WebGPU god rays + the missing WebGL twin)

  ── SLICE 3: RESPONSE + VISUALS (parallel lanes) ──
  CLT-A4 (star brightness through adapted state) ──> CLT-A5 (wire or retire nightSkyDimming)
  CLT-C3 (Baumbach corona — corona ONLY; prominence/flare are re-homed)   CLT-C7 (earthshine)
  CLT-B3 browser acceptance    CLT-B5 / B7 / B8 / B9 (night raster, twilight blend, cost, probe)

  ── SLICE 4: TRACK D ATMOSPHERE (ruling-gated at its head) ──
  CLT-D10 (RULING — must precede any Track-D twilight probe)
        └──> CLT-D3 ──> CLT-D4 ──> CLT-D5 (ruling)        [ozone chain]
        └──> CLT-D1 / CLT-D2                              [cloud transmittance + parity twin]
        └──> CLT-D6 + CLT-D7 ──> CLT-D8 (ruling)          [multi-scatter + LUT -> aerial persp.]
        └──> CLT-D9                                        [discharges the S4 deferral]

  ── SLICE 5: EXPOSURE TAIL ──
  CLT-A6 ──> CLT-A7 ──> CLT-A8 ──> CLT-A9 (ruling) ──> CLT-A10 ──> CLT-A11 ──> CLT-A12
```

Three ordering facts drive this shape, and each is the plan's own:

1. **`CLT-C0`/`CLT-C1` and `CLT-A1` are the foundations** — every visual row hangs off them,
   and they are cheap, publish-only and byte-identical (`:383-386`).
2. **`CLT-A3` and `CLT-C8` must be designed together** — one publisher, one consumer
   (`:389-390`).
3. **`CLT-C6` gates the entire Earth-limb camera-side lane** (`:367-369`). Promoting it ahead
   of the visual rows is the single change this refresh most recommends against the plan's
   original ordering, because a diagnosis that lands late invalidates acceptance runs taken
   before it.

---

## 7. Browser/hardware versus node-provable — the dispatch-shape split

This split determines whether a row can go to a bounded worker lane or must wait on a machine
lane, and it is the practical reason to read this section before planning capacity.

**NODE-PROVABLE (spec-verifiable, no browser).** Anything whose subject is CPU-side f64 state,
a published scalar, a packing law, or a shader-pair contract:

- `CLT-C0`, `CLT-C1`, `CLT-C8` — the occlusion kernel and its published outputs are CPU f64
  and analytic; their correctness is a math property.
- `CLT-A1` (the physics/perceptual split and exported μ), `CLT-A2` (`moonVisibleFraction`
  from Earth-limb occultation), `CLT-A3` (the dt-based exposure state — publish-only, "zero
  consumers in this row").
- `CLT-A9`/`CLT-A10` magnitude-law and magnitude-order arithmetic.
- Uniform-packing and sentinel laws throughout Track B and Track D, on the `CLT-B2` /
  `GLOBE_UB_UNSET` precedent — that fix shipped with a 25-test spec including six mutants and
  a 64-define-set expansion plus a naga sweep.
- Shader-pair lockstep contracts, on the `globe-daynight-ramp-law.spec.mjs` precedent (31
  tests, six mutants **including a GLSL-side mutation**).

**BROWSER-OWED (needs a live WebGPU context on Edge).** Anything whose subject is a rendered
pixel, a route flip, a temporal effect, or a cross-backend appearance comparison:

- `CLT-B3`'s remaining terminator both-backend acceptance.
- `CLT-C2`, `CLT-C3`, `CLT-C5`, `CLT-C7` — the camera-side visuals that remain open
  (`CLT-C4` is satisfied — §4).
- `CLT-A4`, `CLT-A11`, `CLT-A12` — star response and the both-backend acceptance suite.
- All of Track D's twilight and aerial-perspective legs.
- `CLT-A6`'s AutoExposure reachability and `CLT-A8`'s WebGL 1×1 readback cost measurement,
  which the plan requires be **measured before** choosing the parity-safe candidate
  (`:194-196`).

**MIXED / DIAGNOSTIC-FIRST.** `CLT-C6` is browser-owed but is a *diagnosis*, not an
acceptance — it needs an investigative lane, not a gate run. `CLT-A0` is mixed: the premise
re-verification is node work, the fresh twilight baseline is a browser capture.

**Coverage of this classification — stated so it is not mistaken for complete.** The lists
above classify **20 of the 41 rows** with a stated reason. Five more are already discharged
and need no lane (`CLT-B1` superseded, `CLT-B2` done, `CLT-B4` complete, `CLT-C4` satisfied,
and `CLT-B3`'s implementation half). The remaining **16 are UNCLASSIFIED here**: `CLT-A5`, `CLT-A7`,
`CLT-B5` … `CLT-B9`, and `CLT-D1` … `CLT-D10` individually — Track D is covered above only
as a group, which is not good enough to plan capacity against. Classifying those 16 is a
launch-packet task, and it should be done by reading each row rather than by extending the
pattern of its neighbours: `CLT-D5`, `CLT-D8` and `CLT-D10` are **rulings**, which are
neither node nor browser work, and mixing them into a lane estimate would overstate the
machine-lane load.

**A caution the plan's own history earns.** `CLT-B4` needed **three probe runs**, and its
first run refuted the recorded mechanism outright. Every Track-C row should be budgeted for
a refutation round rather than a single acceptance run, and no Track-C acceptance should be
scheduled before `CLT-C6` lands. Additionally, per this fork's instrument doctrine, a spec
written from the same brief as its fix is not an independent check — Track-D and Track-A
rows in particular need their acceptance derived from the *behaviour*, not from the brief.

---

## 8. What this document does NOT know

**Not verified because it needs a machine lane:**

- **No measurement was taken for this refresh.** No build, no browser, no probe was run. Every
  number here is quoted from a queue or a plan.
- Whether the plan's §1 premises still hold at HEAD. They were verified at **`9d7fa308ca`**
  and the tree has moved substantially — that is precisely what `CLT-A0` exists to re-check,
  and this document did **not** do `CLT-A0`'s job.
- The two `CLT-C6` divergences are **prose-only** in `WEBGPU_DEBUGGING_LOG.md:15210-15212`
  and a queue cell; this document did not read that log passage and cannot characterise the
  near-limb defect beyond the plan's description of it.
- Whether `CLT-B3`'s landed implementation is still byte-identical-off at HEAD.

**Not verified because it was out of scope:**

- **Track A's 13 rows were not individually re-derived** against current source. The Track-A
  summaries in §2 and §6 come from the plan's row table, not from reading the exposure and
  star code. Track A is the least-audited part of this refresh.
- **`FEATURE_INVENTORY.md` — EXIT-3 checked, and the result is PARTIAL.** C12's **EXIT-3**
  asserts the inventory was updated (celestial WIP §C → §B, airglow added to §D), discharged
  at Batch 1144 (`QUEUE_2026-07-19_CAMPAIGN12.md:44`). **The airglow half verifies:** §D
  carries `C12-26` / `NEW-EARTH-LIMB-AIRGLOW-EMISSION` at `FEATURE_INVENTORY.md:1279`, and
  that entry states in its own words that it stays in §D because *"C17 is unlaunched"* — an
  independent confirmation of this epic's standing. **The §C → §B half is only partial:** §C
  (`:993-1193`) still carries live celestial WIP, including *"CSM Slice 3 moon dual-light
  cascades pending"* and *"Sun-below-horizon depth test against inner sphere needs wiring
  into Sun.wgsl"*. Whether those were meant to be in EXIT-3's scope is **NOT SETTLED HERE** —
  but a launch packet should not assume the inventory's celestial picture is fully current.
- **The licence position for Track C/D reference material was not re-verified.** The plan
  carries a §10 reference pre-registration (2026-08-09); its verification levels were not
  re-read here, and `LICENSE_VETTING_AURORA_OCEAN_2026-08-21.md` exists and was not consulted.
- **`CELESTIAL_ATMOSPHERE_DESIGN.md`, `CELESTIAL_APPEARANCE_RESEARCH_2026-07-19.md`,
  `DEV_NOTES_celestial.md` and `CELESTIAL_WATER_REFLECTION_RESEARCH.md` were not read.** They
  are large adjacent artifacts that may already answer several Track-A and Track-D questions,
  or may contradict the plan. A launch packet should sweep them.

**Premises that need re-derivation before dispatch:**

- Every line number here. Correct at `41aad98761`; the identifiers and quotes are the durable
  half.
- The C12 subtraction in §3 is a snapshot of a queue that changes with every landing. C12 is
  **still open**, so §3 will grow. Re-read §0 of the C12 queue — it declares itself
  authoritative over its own prose, and therefore over this table too.
- **The S6 corona gap in §3d began as an inference** — reading landing prose for what it does
  not claim — but it has since been **confirmed directly against the engine source** (§5c):
  no corona implementation exists. The inference and the grep agree, so this one is settled.
  It is recorded here because the *method* matters: two documents agreeing was not sufficient,
  and it should not have been treated as sufficient.

**A standing caution.** This is a dated planning artifact and by the fork's own Principle 10
it is a **lead, not a premise**. **Three** claims did not survive verification while this
refresh was being written: two carried in from the brief — that the sun-disc fix was in
flight, and that STBN was C12 celestial work, both corrected in §3e — and one this document
itself asserted on its first pass, that `CLT-C4` was open, corrected in §4 after three
independent sources said it was satisfied. The third is the instructive one: **a scope
document is just as capable of failing to subtract as a brief is of over-claiming**, and the
only thing that caught it was reading `FEATURE_INVENTORY.md` and `DEFERRED_WORK.md` rather
than trusting the CLT plan's own row table. That is the ordinary rate at which beliefs about
this codebase go stale. Re-read the cited lines before briefing from them.
