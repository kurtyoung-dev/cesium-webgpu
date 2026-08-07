# Celestial Light Transport & Eye Adaptation — Research + Queue (2026-08-07)

**Status: PLANNED / RESEARCH-VERIFIED / NOT LAUNCHED.** Authored at maintainer
request (2026-08-07): _"queue these tasks up after we get them researched and
documented."_ Research executed by a four-agent Opus fan-out (workflow
`wf_b9b40051-931`: in-fork exposure/star inventory, day/night imagery, camera-side
eclipse, eye-adaptation literature) with every in-fork claim carrying file:line
evidence. **This epic is NOT part of Campaign 12's closure scope** — C12's
four-gate exit is literal, and this work must not widen it. Proposed campaign
identity: **Campaign 16** (reservation only — campaign numbering is ratified
add-only; this document is not a launch ruling, and launch is a maintainer call
consistent with the bounded-active-campaign principle of ruling R4).

The maintainer's four asks, restated:

1. **Star brightness scaled by real light exposure at the camera** (eye
   adaptation): occlusion-aware — sun blocked by globe or moon, camera looking
   away — so stars actually appear at night and during eclipses.
2. **Day→night global imagery interpolation**, camera-independent: each surface
   point blends by its own rotation relative to the sun.
3. **Globe eclipsing the sun for the camera**: extended-source sun (true
   angular size at distance, multiple-sample/disc occlusion rather than a point
   test) + the visual effects — glow and crepuscular-like rays past the limb.
4. **Moon eclipsing the sun for the camera** (camera behind the moon): the
   Apollo 11 / Artemis 2 reference look — corona around the dark disc,
   earthlight on the near side, zodiacal light along the ecliptic.

---

## 1. Headline findings — what already exists (verified at `9d7fa308ca`)

- **The extended-source refactor the asks assume is ALREADY LANDED.**
  `Scene/EclipseState.js` + `Scene/computeSolarObscuration.js` (C12-29 S1,
  Batch 760) compute a **camera-anchored**, limb-darkened, analytic
  circle-vs-circle occlusion of the solar disc in f64, every SCENE3D frame,
  against **both** occluders — Earth limb (radius from `frameState.occluder`)
  and Moon — publishing `sunVisibleFraction = (1−earth)·(1−moon)`,
  `earthOcclusionFraction`, `moonObscuration`, all three angular radii and
  both separations. The sun's angular radius already derives from true
  distance. **The gap is consumers, not the test**: `sunVisibleFraction`
  reaches exactly two consumers today (Sun billboard alpha, C12-27 veiling
  glare). It never reaches sky brightness, star brightness, scene light, or
  exposure.
- **A finite-solar-disc softness law is already shipped** (C12-22, lunar
  terminator) and the shader-side analytic overlap (`eclipseGeometricObscuration`
  / `eclipseLimbDarken`) already exists as GLSL+WGSL twins for the globe.
- **AutoExposure exists on BOTH backends and is unreachable**:
  `PostProcessStageCollection._autoExposureEnabled` is `false` with **no public
  setter**; the WebGL tonemapper bakes the flag into its shader variant at
  set-time, so even a private flip silently diverges the backends. Both EMAs
  are frame-count-based (invalid under request-render / variable fps), linear-
  mean (a sun disc nukes the meter), and clamped to [0.1, 10] — a window that
  can represent neither night sky nor sunlit ground.
- **Star brightness is already driven end-to-end by an analytic CPU estimator**
  (`SkyBrightness.js`, C12-34): zenith magnitude μ → perceptual 0..1 scalar →
  `computeStarBrightnessModulation` replicated in **five lockstep
  implementations** (4 shaders + 1 CPU twin, spec-pinned). The linear
  luminance intermediate μ is computed and **discarded** — exporting it is the
  enabling move for the whole exposure epic, with zero shader edits.
- **Day/night imagery blending already exists in kind**: upstream's per-layer
  `dayAlpha`/`nightAlpha` + per-fragment N·L terminator ramp, with a working
  Ion-token demo. The real work is the ramp law (see the bugs below), the
  `enableLighting` decoupling, a license-clean night raster (NASA Black
  Marble; the fork already has the LICENSE.md provenance-block pattern), and
  three composition rulings.
- **No corona exists anywhere** (zero `Baumbach` hits; the only prototype
  lives in the **unreferenced** `Shaders/WebGPU/Environment/Sun.wgsl` —
  Principle-7 scaffolding; the LIVE WebGPU sun shader is the inline
  `SUN_SHADER_WGSL` string in `WebGPUEnvironmentRenderer.js:73-143`). The sun
  during a 60% partial eclipse today renders as a dimmer full disc, not a
  crescent — no limb position angle is published, so a crescent cannot even be
  oriented from current state.
- **A complete god-ray effect exists and is unfed**: `WebGPUGodRayEffect.ts`
  (two-pass radial blur) has no WebGL twin and nothing calls
  `setSunScreenUV` — it cannot currently produce a sun-anchored shaft.
- **Key numbers from the literature survey**: moonless rural night ≈ EV100
  −9.4, sunlit ground ≈ +16.2 — a **25.6 EV span**; Unreal's shipped
  adaptation rates would take 8.5 s / 25.6 s to cross it (unusable when the
  clock or camera can jump), so this fork needs faster rates plus
  snap-to-goal on discontinuity; scotopic/mesopic band 0.005–5.0 cd/m² (CIE
  191-2010); corona ≈ 1e-6 of disc brightness and **no shipping renderer uses
  the true ratio** — ship the Baumbach profile
  (2.565R⁻¹⁷ + 1.425R⁻⁷ + 0.0532R⁻²·⁵) as the SHAPE with a disclosed
  perceptual gain (the `ECLIPSE_TWILIGHT_HORIZON_GAIN = 2.0` precedent).

## 2. Bugs found by this research — dispatchable into the close-out lanes NOW

These are defects at HEAD regardless of whether the epic launches; they should
be filed/fixed under the existing close-out plan, not held hostage to the epic:

1. **`globe.enableNightLights = false` is a NO-OP on WebGPU** —
   `Globe.js:1272` writes `nightIntensity = 0.0` on the off path;
   `GlobeTerrain.wgsl:790` reads `0.0` as the "use default 2.5" sentinel; the
   off value aliases onto default-on, and `tileProvider.enableNightLights`
   (`Globe.js:1271`) is write-only. **This makes C11-159's ratified "default
   OFF, keep the toggle" vacuous as written.** Sibling sentinels in the same
   vec4 (`oceanReflectivity`/`oceanFoamThreshold`/`oceanDarkening`,
   `oceanFresnelPower`) may have the identical hole via
   `enableEnhancedOcean = false` — unverified, audit together. **FIXED 2026-08-07 (Batch 913, CO-13): enable carried explicitly via `GLOBE_UB_UNSET = -1.0` (new `WebGPUGlobeTunables.ts` leaf); the write-only provider flag is now read by the tile-UB packer; `enableNightLights = false` produces zero emission and `nightIntensity = 0` is reachable; default look proven unchanged by enumeration over both laws; the `oceanFoamThreshold` sibling was a LIVE instance of the same hole, fixed in-slice; the other four latent siblings fixed with scaffolding retained; no GLSL twin exists so parity is discharged by absence.** (→ CLT-B2)
2. **The two backends disagree about the terminator by 0.5 night-alpha**:
   GLSL `1−clamp(N·L×5,0,1)` ramps entirely on the DAY side (fully night at
   h≤0); WGSL `computeDayNightFade` adds `+0.5`, centring the ramp on the
   terminator. At the geometric terminator GLSL says 1.0 night, WGSL says 0.5.
   The WGSL comment "Matches the GLSL path" is factually wrong. Two further
   structural splits: WebGL gates day/night alpha off entirely on
   vertex-normal terrain (`ENABLE_DAYNIGHT_SHADING` emission rule) while
   WebGPU keeps it; and WebGL applies a camera-distance lighting fade the WGSL
   path lacks. **PROBE AUTHORED 2026-08-07 (CO-13, `probe-daynight-terminator-law.mjs` — calibration-ladder design, synthetic layers, no Ion): not yet run; and a FIFTH divergence was filed while authoring it (`NEW-WEBGPU-GLOBE-DAYNIGHT-NORMAL-SOURCE` — the WGSL feeds the day/night term the MESH normal where GLSL recomputes the analytic one; on normal-less terrain the mesh normal is a CONSTANT, which would mimic the 0.5 reading with the OPPOSITE fix; lane E at a solstice is the decider). The 0.5-divergence mechanism is NOT banked until that run.** **FIRST RUN 2026-08-07 (tip `6e9c997287`): the probe REFUTED the recorded mechanism and CONFIRMED the fifth divergence as operative — the WebGPU day/night term does not vary with N·L AT ALL (day-fade slope 0.000 across the fit window; the term reads a CONSTANT normal on normal-less terrain, per `NEW-WEBGPU-GLOBE-DAYNIGHT-NORMAL-SOURCE`). The recorded +0.5-offset mechanism is NOT what produces the 0.5 reading; the ramp-law reconciliation (CLT-B4) must fix the NORMAL SOURCE FIRST, then re-measure the ramp. Lane B REFUTED the sentinel finding — which is CLT-B2's acceptance, discharged. Lanes C/D/E structural with named reasons (C needs a vertex-normal network lane; D/E cannot attribute while the normal is constant).** **NORMAL SOURCE FIXED 2026-08-07 (Batch 919, CO-15): `GlobeTerrain.wgsl`'s day/night family — the imagery day/night alpha, the night-lights emission gate, the DAYNIGHT_SHADING Lambert and `computeTerminatorGlow` — now takes `dayNightNormalEC`, the analytic geocentric surface normal recomputed per fragment and carried into eye space by `camera.modifiedModelView` (the WGSL equivalent of GLSL's `czm_normal3D × czm_geodeticSurfaceNormal(v_positionMC, …)` at `GlobeFS.glsl:595-597`). UNCONDITIONAL, no new define: `GlobeSurfaceShaderSet.js:435-442` makes `ENABLE_VERTEX_LIGHTING` / `ENABLE_DAYNIGHT_SHADING` mutually exclusive, so WebGL's day/night term exists only on normal-less terrain and reads the analytic normal there, while on vertex-normal terrain it does not exist at all (and `GlobeVS.glsl:267` does not even emit `v_normalEC` for that path) — the mesh normal is the right answer on NEITHER kind. The VERTEX_LIGHTING Lambert, the G-buffer normal slot and the CSM slope bias deliberately keep the mesh normal. Guard: `Tools/visual-regression/globe-daynight-normal-source.spec.mjs` (25 tests, six mutants, 64-define-set expansion + naga sweep). NOT byte-identical by design — the WebGPU globe gains a real terminator on default terrain.** **THE +0.5 DIVERGENCE THIS BULLET RECORDS IS STILL OPEN — and is MEASURABLE FOR THE FIRST TIME.** A constant term had no ramp to compare against a ramp law, which is why run 1 could only return STRUCTURAL. CLT-B4 now has a readable subject; the second run's expected readings are PRE-REGISTERED in `DEFERRED_WORK.md` under `NEW-WEBGPU-GLOBE-DAYNIGHT-RAMP-OFFSET` (lane A → CONFIRMED with `webgpu_shape` `wgsl-offset-law`, slope 5.000, range 1.000, `terminator_delta` +0.485; lane E → `webgpu_normalSource` `per-fragment`; lane D scores for the first time; **exit code stays 1 because lane B's REFUTED IS the CLT-B2 fix working — do not read it as a regression**). Findings (c) and (d) are likewise untouched by CO-15. **RUN 2 (post-B920 normal-source fix, tip `679cbf5173`): the pre-registration hit — lane A CONFIRMED (WebGL glsl-law terminator 0.012 vs WebGPU wgsl-offset-law 0.496/0.497; the ORIGINAL +0.5 divergence is now MEASURED, not mimicked), lane E CONFIRMED (per-fragment normal at solstice). Lane D REFUTED AS FILED — the altitude fade EXISTS on both backends and matches (both drop x0.30 low->high within ~5%: WebGL 1.000->0.300, WebGPU 0.312->0.0896); the REAL divergence is a near-constant x0.30 night-side scale on WebGPU at BOTH altitudes — the same ramp-offset mechanism expressed through the lighting term. Finding (d) folds INTO CLT-B4's scope (one law fix addresses both) rather than standing as a separate missing-fade defect.** **RESOLVED 2026-08-07 (Batch 927, CO-18): findings (a) and (d) are FIXED and this stamp is discharged. `GlobeFS.glsl` is the reference and is UNCHANGED (comments only); the WGSL adopted BOTH of its expressions — `computeDayNightFade` = `clamp(N·L*5, 0, 1)` for the imagery day/night alpha + night-lights gate (the `+0.5` is gone), and a NEW, SEPARATE `computeDayNightDiffuse` = `clamp(N·L*5 + 0.3, 0, 1)` for the DAYNIGHT_SHADING term, applied as `mix(1.0, …, tile.lightingFade)` — the camera-distance fade WebGL has at `GlobeFS.glsl:852`, packed CPU-side by the new leaf `WebGPUGlobeLightingFade.ts` into TileUniforms float 463 (the former `_tilePad0`, so nothing realigned). THE RECORDED MECHANISM WAS RIGHT AS FAR AS IT WENT AND INCOMPLETE: the `+0.5` was one of THREE divergences wearing one mechanism — the offset on the alpha ramp, the lighting term being driven by that ramp instead of its own expression, and the missing camera-distance mix. The ×0.30 lane-D residual is derived: WebGL's night/day ratio is the closed form of `mix(1.0, clamp(N·L*5+0.3,0,1), fade)` — 1.000 at 3 Mm (below `lightingFadeOutDistance` = π/2 × Rmin = 9.985 Mm ⇒ fade 0) and 0.300 at 25 Mm (above `lightingFadeInDistance` = π × Rmin = 19.970 Mm ⇒ fade 1), i.e. the `0.3` night floor over the saturated `1.0` day value; run 2 measured exactly those two numbers, which is what licensed reading WebGPU's 0.312/0.0896 as an expression difference. `computeTerminatorGlow` takes the raw signed dot and is provably unmoved by the law change (checked, recorded, not assumed) — it stays CLT-B3's subject. Law written into `SHADER_PAIRS_LOCKSTEP.md` as the DAY/NIGHT RAMP LAW pair row. Guard: `Tools/visual-regression/globe-daynight-ramp-law.spec.mjs` (31 tests, six mutants incl. a GLSL-SIDE mutation, 64-define-set expansion + naga sweep). NOT byte-identical by design — the WebGPU look moves onto WebGL's. Acceptance is the probe's THIRD run, pre-registered in `DEFERRED_WORK.md` under `NEW-WEBGPU-GLOBE-DAYNIGHT-RAMP-OFFSET`; lanes A and D will BOTH read REFUTED, and that REFUTED is the fix reporting itself — read the metrics, not the exit code. Finding (c) — the vertex-normal gate — is NOT closed and needs a network lane.** **RUN 3 (tip `5aec156b93`): CLT-B4 ACCEPTANCE MET — lane A refuted with the pre-registered verbatim strings (both backends glsl-law, terminator 0.012), lane D cross-backend in band at both altitudes (1.056/1.084, glow-direction consistent), lane E confirmed. The ramp law is ONE CONTRACT on both backends. Residual instrument note: lane B saturates post-fix (night emission now at full GLSL strength) and needs a dimmer synthetic scene.** (→ CLT-B4)
3. **`computeTerminatorGlow` (`GlobeTerrain.wgsl:2237`, unconditional at
   `:4795`) is a default-ON, WebGPU-only, untoggleable additive band** peaking
   exactly at N·L≈0 — the same class C12 exit-gate item 2 exists to close,
   sitting on the globe instead of a celestial body. Candidate to be swept
   INTO that audit. (→ CLT-B3)
4. **C12 ledger drift**: the 2026-07-28 overlay records C12-29 "S6 landed"
   without qualification, but S6-as-landed is the 360° horizon twilight + star
   reveal only — the research's S6 corona pass never shipped (consistent with
   finding zero corona code). Reconcile in the next docs-reconciliation batch.
5. **Two sun/limb divergences have no findable home** (prose-only in
   `WEBGPU_DEBUGGING_LOG.md:15210-15212` + the C12-29 queue cell):
   `NEW-WEBGPU-SUN-COMMAND-NO-BOUNDING-VOLUME` (WebGPU sun never culled) and
   `NEW-WEBGPU-NEAR-LIMB-GLOBE-ABSENT` (WebGPU globe renders nothing in the
   near-limb ROI — "the largest divergence in the entire measurement"; it
   makes every Earth-limb camera-side visual **un-probeable on WebGPU** until
   diagnosed). Mint DEFERRED_WORK rows. (→ CLT-C6, hard prereq for C2/C5
   acceptance.)
6. **`enableNightSkyDimming` has zero consumers** on either backend
   (declared default-true in `AtmosphericConditions.js:641`) — the last live
   instance of the class C12 exit-gate item 2 audits. Wire it or retire it.
   (→ CLT-A5)

## 3. Track A — Eye adaptation & exposure (merged EA rows from both researchers)

Execution order top-to-bottom; sizes are estimates.

- **CLT-A0 (S)** — Premise re-verification at HEAD + the absolute-luminance
  ledger (μ → cd/m² → EV100), separating constants the epic RE-EXPRESSES from
  constants it would MOVE (chiefly `NELM_PER_ZENITH_MAGNITUDE = 0.5` and the
  ratified full-moon 4.55 / totality −3.00 mag anchors). Docs + read-only
  verification; produces the maintainer decision list. Re-run the repaired
  `probe-sky-twilight-range.mjs` for fresh baselines (pre-2026-08-07 star-pixel
  numbers are VOID).
- **CLT-A1 (S)** — Split `SkyBrightness` into physics + perceptual transfer
  **bit-exactly** and export the linear zenith magnitude (plus
  `computeZenithLuminance(μ) = 1.08e5·10^(−0.4μ)`), published as
  `frameState.adaptationSkyLuminance` alongside the untouched 0..1 scalar.
  Purely additive; the S2 totality anchor (day = exactly 1.0) must hold.
  Mutation-tested bit-exactness sweep.
- **CLT-A2 (M)** — `moonVisibleFraction` from the camera: Earth-limb
  occultation of the MOON (reuse the generic disc-overlap) + a lunar-umbra
  term from vectors `EclipseState` already holds. Today a moon behind the
  Earth still lights the sky at full strength. New toggle with exact identity
  in the off position; default is a maintainer call (behaviour change).
- **CLT-A3 (L)** — `SceneLightExposure`: the one dt-based adaptation state.
  Analytic goal luminance from A1's μ + direct sun/moon terms gated by
  `sunVisibleFraction`/`moonVisibleFraction`; asymmetric rate-limited EV
  integrator (fast light ≈ 8 EV/s-class, slow dark ≈ 3 EV/s-class, exponential
  terminal; constants recorded as derived-from-published-ranges); **dt from
  `frameState.time`**, snap-to-goal on first frame / teleport / morph / clock
  jump; request-render contract (`scene.requestRender()` while unconverged).
  **Publish-only — zero consumers in this row**, so the frame is provably
  byte-identical while every later row gets a stable attachment point. Spec:
  identical wall-clock settling at 15/30/60/144 fps + a 10 s gap; mutation
  test rejects frame-count smoothing.
- **CLT-A4 (M)** — Route star brightness through the adapted state by mapping
  adapted μ back through the SAME perceptual transfer onto the existing
  `u_skyBrightness`/`params.w` uniform — reaching all five lockstep
  implementations with **zero shader edits, zero new uniforms, zero define
  bits**. Toggle default OFF (star reveal now lags sunset — the desired
  effect, but a visible default change → maintainer). Totality anchor
  0.062810 asserted in both toggle positions.
- **CLT-A5 (S)** — `enableNightSkyDimming`: wire it as the sky-shell's
  response gate to the adapted state, or retire it with a tombstone —
  maintainer's call; do not leave the class instance live.
- **CLT-A6 (M)** — AutoExposure reachability + parity + metering repair: real
  public accessor that REBUILDS the WebGL tonemap stage; port or default-off
  the WebGPU-only altitude gate; make `AutoExposureConfig` reachable; convert
  both EMAs to dt-based; replace linear mean with log-average + percentile
  clipping; widen the [0.1,10] clamp to an EV window. AE stays DEFAULT OFF
  (Batch-364 black-night-sky precedent). Negative control: old metering must
  fail the new spec.
- **CLT-A7 (M)** — EV100 exposure seam wired to both tonemappers in the same
  slice (K=12.5), `atmosphericConditions.eyeAdaptation` config block, default
  OFF; resolves the LDR question (highDynamicRange requirement vs pre-tonemap
  gain). Off = byte-identical both backends; the
  `eclipseAutoExposure = false` human-eye branch stays EXEMPT (ruling E2's
  preserved darkness).
- **CLT-A8 (L)** — Bounded framebuffer refinement:
  `EV_final = EV_analytic + clamp(EV_measured − EV_analytic, ±1.5 EV)` —
  occlusion-for-free from content the analytic model can't know, with the
  feedback loop caged (anchor is prior-frame-independent). WebGL has NO
  luminance readback today — measure the 1×1 readback cost before choosing
  the parity-safe candidate; oscillation canaries; interleaved A/B GPU timing.
- **CLT-A9 (M, RULING REQUIRED)** — Schaefer NELM
  (`7.93 − 5·log10(10^(4.316−μ/5)+1)`) replacing the linear 0.5 slope —
  **moves ratified C12 anchors** (full-moon 4.55 → 3.97; totality reveal off
  −3.00 mag). Behind a flag, current law default, both models spec-pinned.
- **CLT-A10 (L)** — Per-star magnitude-limited rendering: soft rolloff at the
  adapted NELM in shared `StarFieldMath` (all four render paths inherit one
  law). Acceptance: stars vanish in MAGNITUDE ORDER (Spearman ≥ 0.95 vs
  catalogue) — impossible for the current global multiplier by construction.
- **CLT-A11 (M)** — Mesopic/scotopic blend: CIE 191-2010 band
  (0.005–5.0 cd/m²), rod-weighted desaturation + blue shift, GLSL+WGSL twins
  in one slice (new ShaderDefineHi bit), SHADER_PAIRS_LOCKSTEP entry. This is
  the row that makes earthlit/moonlit scenes READ as night — directly serving
  the Apollo/Artemis reference imagery.
- **CLT-A12 (M)** — Acceptance suite on both backends: scripted-sunset star
  lag (equal wall-clock at 30/60/144 fps + request-render), orbital terminator
  crossing (day-side stars stay factor 1.0 — the C11-176 regression guard),
  Earth-limb sun occultation continuity (graceful when `frameState.occluder`
  is undefined), toggle-off byte-identity, `CesiumDebug.eyeAdaptation()`
  diagnostics.

## 4. Track B — Day/night imagery interpolation

- **CLT-B1 (S)** — Premise-verification probe (BLOCKING PREREQ): extend
  `probe-dusk-terminator.mjs` with a terminator-crossing scanline; pixel-confirm
  the four static findings (0.5 alpha disagreement; sentinel no-op;
  vertex-normal gating split; camera-fade split). Numbers table, no fix.
- **CLT-B2 (S)** — Fix the `nightIntensity` 0.0 sentinel collision (§2 bug 1):
  carry the enable explicitly, wire or drop the write-only
  `tileProvider.enableNightLights`, make C11-159 actually flippable; audit the
  sibling ocean sentinels in the same slice.
- **CLT-B3 (S)** — Contain `computeTerminatorGlow` (§2 bug 3): port to GLSL as
  a real lockstep pair or gate behind a default-off toggle. Check with the C12
  owner whether it lands via C12 exit-gate-2's audit instead — do not
  double-schedule.
- **CLT-B4 (M)** — **DONE 2026-08-07 (Batch 927, CO-18), pending the terminator
  probe's third Edge run as acceptance.** Reconcile the terminator ramp law
  across backends (§2 bug 2), untangle the imagery-alpha vs lighting
  expressions, correct the false WGSL comment, decide the camera-fade question;
  write the target law into `SHADER_PAIRS_LOCKSTEP.md`. **PREREQ DISCHARGED
  2026-08-07 (Batch 919, CO-15):** the row's blocking half — the constant normal
  source — was fixed, so the ramp existed and the `+0.5` offset became
  measurable for the first time; the second run then measured it (+0.485).
  **DELIVERED:** one law = WebGL's, on both backends — the `+0.5` dropped from
  the alpha ramp, a separate `computeDayNightDiffuse` (`N·L*5 + 0.3`) for the
  lighting term so the two expressions are no longer one, and `mix(1.0, …,
  tile.lightingFade)` for the camera fade (finding (d), new leaf
  `WebGPUGlobeLightingFade.ts`, TileUniforms float 463). The false "Matches the
  GLSL path" comment is gone. Law written into `SHADER_PAIRS_LOCKSTEP.md` as
  the DAY/NIGHT RAMP LAW pair row; new guard
  `Tools/visual-regression/globe-daynight-ramp-law.spec.mjs` (31 tests).
  **NOT DELIVERED, and NOT a silent drop:** finding (c)'s vertex-normal gate —
  WebGL emits `ENABLE_VERTEX_LIGHTING` _instead of_ `ENABLE_DAYNIGHT_SHADING`
  on vertex-normal terrain, so its day/night alpha does not exist there at all,
  while WGSL still applies the ramp. Its render half needs a provider reporting
  `hasVertexNormals === true` (an Ion/network dependency), so it stays open as
  `CLT-B1-VERTEX-NORMAL-LANE-NEEDS-A-NETWORK-LANE`. The guards that pinned the
  `+0.5` and the wrong comment ON PURPOSE
  (`daynight-terminator-law.spec.mjs` A2/A3/A5,
  `globe-daynight-normal-source.spec.mjs` E1) were INVERTED rather than
  deleted, so a re-introduction is still caught. Third-run readings are
  pre-registered in `DEFERRED_WORK.md` under
  `NEW-WEBGPU-GLOBE-DAYNIGHT-RAMP-OFFSET`; **lanes A and D will both read
  REFUTED and that is the fix reporting itself** — read the metrics, not the
  exit code.
- **CLT-B5 (M)** — License-clean night raster: verify GIBS
  `VIIRS_Black_Marble` capabilities (TIME dimension — unverified), bake a
  bundled levels-0–3 pyramid from NASA SVS Black Marble (~0.5–2 MB, mirroring
  the `NaturalEarthII` shape) with a reproducible `Tools/` baker, full
  LICENSE.md provenance block **mirrored into `packages/engine/LICENSE.md`**
  per the 2026-08-07 rule, GIBS acknowledgment string for the opt-in high-res
  path. Can run parallel to B1–B4.
- **CLT-B6 (S, RULINGS)** — Composition rulings: (a) is emissive night imagery
  exempt from the ground-atmosphere drape? (b) is it dimmed by
  `eclipseAbsolute` during totality (city lights physically switch ON; the
  umbral track is narrower than the twilight band — both visible in one
  frame)? (c) confirm it COMPOSES with `applyNightLightsEmission`. Ruling
  block in the R1–R6 shape.
- **CLT-B7 (L)** — The blend itself: `globe.dayNightImageryBlend` (default
  false), `twilightStartAngle`/`twilightEndAngle` (0° / −6° civil twilight),
  smoothstep on unclamped N·L, **independent of `enableLighting`** (the actual
  new capability), byte-identical shader text both backends, new WebGL define +
  ShaderDefineHi bit with `//>>else` preserving today's paths verbatim, two
  floats add-only in a spare tile-UB vec4. OFF = byte-identical to HEAD.
- **CLT-B8 (M)** — Cost + straddle guard: texture-unit budget on WebGL, the
  ≥17-layer subsequent-pass straddle (day layer pass 1 / night layer pass 2
  cross two blend equations — unprobed today), tile-request/VRAM deltas.
- **CLT-B9 (M)** — Acceptance probe (`probe-daynight-imagery-blend.mjs` with
  adversarial mutants: swapped smoothstep edges, degrees-not-sines,
  current-GLSL-law), Sandcastle demo on the bundled raster (keep
  `earth-at-night` as the upstream-parity reference), doc sync
  (`IMAGERY_PROJECTION.md`, `SHADER_PAIRS_LOCKSTEP.md`, `FEATURE_INVENTORY.md`,
  `DEBUGGING_GUIDE.md`, `WEBGPU_DEBUGGING_LOG.md`).

## 5. Track C — Camera-side eclipse visuals

- **CLT-C0 (S)** — Consolidate the extended-source occlusion kernel into
  `Scene/SolarOcclusion.js` (re-exports for back-compat; the two different
  angular-radius fallbacks are BOTH correct for their callers — parameterise,
  don't unify blindly). Byte-identical against the protected eclipse Node set
  (145/145) + `eclipse-state.spec.mjs` (32/32). One source for all four
  consumer families (camera visuals, surface dimming, terminator softness,
  eye adaptation).
- **CLT-C1 (S)** — Publish per-occluder limb geometry on `eclipseState`: the
  camera→occluder unit direction (computed today and discarded), the bearing
  as a 2D unit vector in the sun billboard's screen axes, occluder angular
  radius in billboard units, contact class. **The single missing input for
  every camera-side visual.** Publish-only.
- **CLT-C2 (M)** — Sun-disc **crescent** during partial occlusion, both
  backends: per-fragment occluder-disc test in `SunFS.glsl` + the **inline**
  `SUN_SHADER_WGSL` (NOT the dead `Environment/Sun.wgsl`), C12-22 quadratic
  limb softening, uniforms into the existing UB's free tail (no layout/define
  delta). **MANDATORY: modulate ALPHA, never RGB** — WebGL blends the sun
  ALPHA_BLEND, WebGPU additive (measured in C12-29 round 3); an RGB crescent
  produces two different pictures. Alpha-only keeps the row invariant to the
  C11-115 flip. Earth-limb leg un-probeable on WebGPU until C6 resolves.
- **CLT-C3 (L)** — Solar **corona** around a totally-occulting moon: Baumbach
  radial profile as the SHAPE (exponents −17/−7/−2.5, independently
  corroborated), runtime `coronaGain` ramping over the last ~0.5% of
  obscuration, gated on the total-vs-annular discriminator
  (`moonAngularRadius/sunAngularRadius > 1` with the existing hybrid
  smoothstep — NOT on instantaneous magnitude, which is algebraically the
  umbra branch and would step at second contact). Amplitude disclosed as a
  perceptual constant (no shipping renderer uses the true 1e-6). Probe on
  shape and gating, never amplitude. State which side of C12-18's
  bake-vs-PP-halo split it lands on; re-derive the gain under C12-19's HDR
  radiance when that lands.
- **CLT-C4 (M, coordination rider)** — Eclipse-aware screen-space halo +
  WebGPU sun-bloom parity: the eclipse factor must multiply the PP bloom
  INPUT or the halo survives totality (a corona inside an undimmed halo is
  the failure mode). Files as a rider on C11-160/C12-18 — not duplicated
  scope.
- **CLT-C5 (L)** — **Crepuscular rays past the Earth limb**: (a) WIRE the
  complete-but-unfed `WebGPUGodRayEffect` (project sun → `setSunScreenUV`,
  exposure gated by `sunVisibleFraction`); (b) author the missing WebGL twin
  (`createGodRayStage`, GLSL port of the two WGSL passes). Default-off both
  backends until measured. Honest framing: the reference photo's rays are
  lens optics + in-scatter; screen-space radial blur reproduces the READ, not
  the mechanism — say so on the row.
- **CLT-C6 (M)** — Mint real homes + fixes for the two divergences (§2
  bug 5): sun command bounding volume; near-limb globe-absent DIAGNOSIS row.
  **Hard prerequisite for accepting C2's Earth-limb leg and C5.**
- **CLT-C7 (M)** — Camera-relative **earthshine** for lunar-distance vantages:
  today `Moon.js:349` phase math is Earth-centred — right near Earth, wrong
  from lunar distance (the Apollo/Artemis vantage). Compute Earth's phase
  from the Moon directly (same Simon1994 positions); off position =
  byte-identical geocentric complement. **Zodiacal light exists NOWHERE in
  the fork** — named here as an unowned sibling (a future row for the epic;
  the reference photos show it), not claimed by this row.
- **CLT-C8 (S)** — The exposure seam: publish one named scalar from the full
  extended-source visibility for Track A to consume. Explicitly NOT routed
  through `getEclipseSceneLightFactor` (deliberately moonObscuration-only —
  the Earth term saturates through all of twilight; reusing it repeats the
  mistake S2's structural note exists to prevent).

## 6. Cross-track seams + execution order

- **C0/C1 and A1 are the epic's foundations** — cheap, publish-only,
  byte-identical, and every visual row hangs off them. Recommended first
  slice if/when launched: A0 → A1 → C0 → C1 (all S), then A3, B1, C2 in
  parallel lanes.
- Track A consumes C8's visibility scalar; A3 and C8 must be designed
  together (one publisher).
- B3's containment should be reconciled with C12 exit-gate item 2's audit
  (same class) — one owner, not two.
- The §2 bug list is dispatchable NOW under the close-out plan without
  launching the epic: B1+B2 (S+S) and C6's minting are natural near-term
  batches; B4's ruling half can ride the next maintainer ask.
- Everything visual obeys the parity principle: both backends in the same
  slice, additive-only defaults per the governing "never remove, only
  default-to-parity + toggle" rule, no new lo-word ShaderDefine bits
  (registry exhausted — ShaderDefineHi or runtime uniforms only).

## 7. Maintainer decisions embedded in this epic

1. **Launch + identity**: adopt as Campaign 16 (or keep as a deferred epic)?
   Recommended: hold launch until C12 closes (the R4 principle), but pull the
   §2 bug rows forward now.
2. **CLT-A9** Schaefer NELM — moves ratified anchors; needs an explicit
   ruling either way.
3. **CLT-A4 / CLT-A2 defaults** — star-reveal lag and moon-visibility
   occlusion are visible default changes; ship default-off, flip by ruling.
4. **CLT-B6** — the three composition rulings (atmosphere drape / eclipse
   dimming of city lights / compose-with-night-lights).
5. **CLT-A5** — wire vs retire `enableNightSkyDimming`.
6. **CLT-B3 ownership** — epic row vs C12 exit-gate-2 audit sweep.

## 8. Research provenance

Four structured reports (in-fork inventory ×2, external survey ×2) with
file:line evidence for every in-fork claim; key external sources: Baumbach
corona profile (independently corroborated), Crumey/Schaefer NELM relations,
CIE 191-2010 mesopic band, Pattanaik 2000 adaptation poles, Reinhard 2002
log-average metering, Narkowicz percentile clipping, NASA GIBS/SVS Black
Marble licensing (NASA non-copyright + acknowledgment string), Stellarium/PSI
corona-rendering practice. Raw reports live in the session workspace
(workflow `wf_b9b40051-931`); every load-bearing claim above is restated with
its evidence, so this document stands alone.
