# QUEUE 2026-08-28 — VISUAL WAVE (Night-Earth epic armed; three lanes staged)

**Charter.** Maintainer directive, 2026-08-28 morning session: with the wave-3 correctness
batches (1198–1213) landed, move to visually impressive improvements; review the research
backlog and promote candidates; the flagship concern is that **the night side of the globe
does not look like night** — day imagery renders full-bright at midnight, and the maintainer
wants a night-texture interpolation option with a procedural-darkening fallback.

**This is a wave dispatch view, not a new campaign.** Campaign numbering stays ratified
add-only; every row here either homes in an existing campaign/deferred-work entry (named per
row) or files a new `NEW-*` entry at landing. Governing rulings:
[MAINTAINER_RULINGS_2026-08-28.md](MAINTAINER_RULINGS_2026-08-28.md) `R-2026-08-28-3`
(night defaults ON, bundled public-domain pyramid, size gate, compatibility bounds),
`R-2026-08-28-4` (only the Night-Earth epic arms in this wave), `R-2026-08-28-5` (two
maintainer sessions scheduled: G3 Milky Way re-bake + C11-163 sub-decisions).

**Worker-tier note.** The codex MCP server is down (not respawning since the 2026-08-28 infra
reset). Until an interactive `/mcp` reconnect, "Sol-bounded" rows dispatch Opus-direct under
the established A1 precedent with executed mutants substituting for the review tier, with
provenance stated in each landing message.

---

## §1 Evidence base

- **Backlog sweep (2026-08-28, 14-agent workflow):** 321 candidates extracted from
  `DEFERRED_WORK.md`, `FEATURE_INVENTORY.md` §C/§D, the research corpus (Takram, celestial,
  atmospheric, eclipse, cloud, meshlets, gsplat-rig, weather-ingest, water), and campaign
  queues C11–C18; 121 scored visual-impact ≥ 4; **24 premise-verified** against the tree at
  `1f724e17b6`. Verification coverage is disclosed honestly: only the top 24 by impact were
  verified this pass; any row promoted from the unverified remainder MUST be premise-verified
  at brief time (Principle 10). Verdict table in §4.
- **Night-side code investigation:** full chain re-derived with `file:line` citations at tip
  `1f724e17b6` — the load-bearing facts are inlined per row below. Key architecture facts:
  per-layer `dayAlpha`/`nightAlpha` pairs are wired through BOTH backends
  (`GlobeSurfaceTileProviderRendering.js:1996-2006` WebGL raw pack;
  `WebGPUGlobeSurfaceTileUB.ts:372-391` WebGPU with Function-resolution); the twilight ramp
  `clamp(NdotL*5, 0, 1)` is one verbatim contract on both backends (CLT-B4, Batch 927); the
  WebGPU emissive night-lights branch is live but triple-gated off by default
  (`Globe.js:385`, `GlobeTerrain.wgsl:2224-2239`); everything is gated on
  `enableLighting = false` (`Globe.js:204`).
- **CLT-B status (from [C17_CELESTIAL_LIGHT_TRANSPORT_SCOPE_2026-08-28.md](C17_CELESTIAL_LIGHT_TRANSPORT_SCOPE_2026-08-28.md) §4):**
  CLT-B2 DONE (Batch 913), CLT-B4 COMPLETE (Batch 927), CLT-B3 implementation landed with
  **both-backend terminator browser acceptance still owed**, CLT-B1 SUPERSEDED except residual
  (c) — the WebGL vertex-normal gating split. This wave discharges residual (c) (VW-N2) and
  the CLT-B3 acceptance (VW-N7); nothing else in CLT-B may be re-briefed.

---

## §2 ARMED — the Night-Earth epic (rows VW-N1..VW-N8)

**Product statement.** By default, the fork's night side looks like night: day imagery fades
through a configurable dusk ramp into a bundled Black Marble night layer (city lights,
optionally emissive on WebGPU), and where no night layer exists the terrain darkens
procedurally — at every altitude, on both backends, with `globe.nightImagery = false`
restoring byte-identical upstream behaviour.

### Dependency order

```
VW-N1 (asset)  ─┐
                ├→ VW-N3 (API + default) → VW-N6 (demo/docs), VW-N8 (variant sizes)
VW-N2 (blend)  ─┘        ↓
VW-N4 (fallback) ← after VW-N2      VW-N7 (Edge acceptance) ← after N3/N4 land + rebuild
VW-N5 (WebGL fn-alpha) — independent, any time
```

### VW-N1 — Bundled night pyramid asset (executor-assisted; NOT Sol — needs network)

Mirror the `Assets/Textures/NaturalEarthII` offline pattern (540 KB, 42 JPEG tiles, TMS
levels 0–2, `tilemapresource.xml`, consumed by `TileMapServiceImageryProvider` over
`buildModuleUrl` — `UrlTemplateImageryProvider.js:151`, `buildModuleUrl.js:104`) with
`Assets/Textures/BlackMarble`: NASA Black Marble (Suomi NPP VIIRS composite; US-government
PUBLIC DOMAIN) downsampled by a new `Tools/bake-black-marble-pyramid.mjs` into the identical
TMS layout. Courtesy attribution (NASA Earth Observatory / NOAA NGDC) in the asset folder
README and the repo README license section. **Size gate per R-2026-08-28-3:** levels 0–2
expected ≤ ~0.5 MB; a level-3 variant (~2 MB) only with re-measured build variants and
maintainer acceptance. Bake script is deterministic (source SHA recorded), re-runnable, and
the tile grid is validated against NE2's `tilemapresource.xml` schema.

### VW-N2 — Decouple the night blend from enableLighting, both backends (Opus-judgment)

The one new signal the whole epic hangs on: `dayNightAlphaActive`, computable WITHOUT full
globe lighting.
- WebGPU: widen the `camera.enableLighting > 0.5` gate on `nightBlend`
  (`GlobeTerrain.wgsl:4195-4202`) to `enableLighting || dayNightAlphaActive`; the flag rides
  an existing camera/tile UB pad slot — **no new ShaderDefine bit required** (runtime-uniform
  architecture; per the registry rules a bit is add-only forever, so do not spend one).
- WebGL: `nightBlend` currently exists only under
  `APPLY_DAY_NIGHT_ALPHA && ENABLE_DAYNIGHT_SHADING` (`GlobeFS.glsl:602-605`); make
  `APPLY_DAY_NIGHT_ALPHA` alone sufficient, computing from the analytic geocentric normal —
  **including under `ENABLE_VERTEX_LIGHTING`**, which today kills day/night alpha entirely on
  vertex-normal terrain (the fork's own viewer requests vertex normals,
  `Apps/CesiumViewer/CesiumViewer.js:64-66`). This discharges **CLT-B1 residual (c)** — cite
  the C17 scope doc §4 row in the landing message.
- Dusk width: the shared `*5.0` ramp slope becomes one packed scalar (default 5.0 —
  byte-identical output when untouched), `globe.duskRampSlope` or equivalent, BOTH shaders in
  the same batch (paired-contract comment `GlobeFS.glsl:755-800` must be updated with it).
- Acceptance: node spec driving both shader sources' generated variants; absence + inertness
  mutants on the new flag in each backend; the existing CLT-B4 ramp-contract spec must stay
  green unmodified.

### VW-N3 — `globe.nightImagery` + default-ON wiring (Opus-judgment)

- New `Globe` option `nightImagery`: `true` (default) → the bundled BlackMarble provider;
  an `ImageryProvider`/promise → user-supplied (e.g. ion 3812 for token holders); `false`/
  `undefined` provider → fully off, **byte-identical upstream behaviour** (R-3 bound).
- Mechanism: auto-managed `ImageryLayer` (dayAlpha 0, nightAlpha 1, kept above the base
  layer), added ONLY on the default base-layer path — never injected into an
  application-managed imagery stack (R-3 bound). Layer lifecycle owned by Globe (destroyed /
  re-created on option flips; the split-screen cache-outlives-imagery lesson applies).
- Sets `dayNightAlphaActive` (VW-N2) — night appearance works WITHOUT `enableLighting`.
- WebGPU night-lights emission (`globe.enableNightLights`) stays default-off and WebGPU-only
  per its ratified contract (`Globe.js:370-381`); flipping that default or adding WebGL
  parity is an **open maintainer question**, deliberately NOT armed here.
- Acceptance: specs for option shapes, layer lifecycle, non-default-stack non-injection, and
  the off-path byte-identity (compare generated shader inputs / uniform packs).

### VW-N4 — Procedural fallback `globe.nightDarkness` (Sol-bounded, after VW-N2)

When no night layer is present (nightImagery off/failed), darken the composited night-side
color: `mix(1.0, nightDarkness, nightBlend)` applied WITHOUT the `lightingFade`
camera-distance gate (`WebGPUGlobeSurfaceTileUB.ts:691-697` packs that fade; the fallback
deliberately bypasses it so night is dark at street altitude too — the audit's Gap 2).
Default `nightDarkness` tuned in VW-N7's sweep (start 0.15). One tile-UB scalar + multiply
near `GlobeTerrain.wgsl:4786`; one uniform + term in the `GlobeFS.glsl:803-811` arm. Both
backends, one batch. Mutants: absence, inertness, and a wrong-arm mutant (applied on the day
side) that the spec must kill.

### VW-N5 — WebGL function-valued day/night alpha (Sol-bounded, independent)

`GlobeSurfaceTileProviderRendering.js:1996-2006` writes `imageryLayer.nightAlpha`/`dayAlpha`
raw into the uniform float arrays — a Function-valued alpha (documented API,
`ImageryLayer.js:48,54`) silently becomes NaN garbage on WebGL while WebGPU resolves it
(`WebGPUGlobeSurfaceTypes.ts:370-400` `resolveImageryLayerValue`, with the documented
`(frameState, layer, x, y, level)` signature and NaN guard). Port the resolution (JS twin,
same guard semantics) into the WebGL pack. Spec: function alphas produce identical packed
values on both backends for the same tile.

### VW-N6 — Demo + docs (Sol-bounded, after VW-N3)

- Upgrade `packages/sandcastle/gallery/earth-at-night` to the new API: one-line
  `nightImagery` usage replacing the manual two-layer wiring, toggles for
  dusk ramp slope, `nightDarkness`, and (WebGPU) `enableNightLights`/`nightIntensity`.
- `FEATURE_INVENTORY.md`: move/add the night rows (§B with SHIPPED tags); update the CLT-B
  ledger lines in the C17 scope doc per its §4 do-not-re-brief rule.
- README: default-night note + Black Marble attribution (with R-3 citation).

### VW-N7 — Edge terminator acceptance sweep (executor lane; after N3/N4 land + rebuild)

One probe, both backends, matched cameras: dawn / dusk / midnight at orbit AND street
altitude, with and without `nightImagery`, pixel-diffed and the PNGs read (Principle 8).
Sensitivity anchors: a probe leg that flips `nightImagery` off must move the night-side
luminance, else the run is void. **This run also discharges CLT-B3's owed both-backend
terminator browser acceptance** — reconcile its containment with C12 exit-gate item 2 (same
class, ONE owner, per the C17 scope doc note) in the run log and the C12 queue, rather than
leaving two owners recorded. Evidence banks per the repatriation rule.

### VW-N8 — Variant size + packaging re-measure (Sol-bounded, after N1/N3)

Assets ship beside the JS bundles; verify `Assets/Textures/BlackMarble` reaches all three
build variants' output layouts, re-measure the minified `Cesium.js` sizes AND the assets
payload for the size table in CLAUDE.md, and confirm no bundler side-effect regressions
(the `"./Source/Cesium*.js"` side-effects line untouched). Record the night-pyramid bytes
against R-3's size gate.

---

## S2b ARMED - the Lunar Earth-shadow appearance (rows VW-L1..VW-L4; R-2026-08-28-6)

**Product statement.** During a lunar eclipse the Moon shows the umbral bite and the copper
umbral coloring, and moonlight dims accordingly - showcased by the eclipse-explorer
`lunar-porto-velho-deep-partial-2026` preset (landed with this wave: greatest 04:12 UTC,
umbral magnitude 0.9319 per NASA SVS 5672 / EclipseWise; engine Simon1994 independently
gives 04:11 UTC, sub-lunar point 9.4S 63.1W - Porto Velho at the zenith).

### VW-L1 - Umbra/penumbra geometry + disc appearance (Opus-judgment)

Productize the shadow-cone math (banked as `Tools/derive-lunar-eclipse-circumstances.mjs`,
Danjon-enlarged cone radii from the engine Simon1994 sun/moon states) into a per-frame
lunar-eclipse state: moon-center distance from the shadow axis, umbral/penumbral radii at
the Moon plane, per-point disc coverage. Project onto the lunar disc in the moon appearance
shading: penumbral gradient outside, umbral darkening inside, with a chromatic copper ramp
deepening toward the umbra center (atmospheric transmission approximation). BRIEF-TIME
PREMISE CHECK REQUIRED: which shader(s) own the moon disc appearance on each backend (the
atmosphericConditions lunar BRDF / phase / normal-map stack) - the brief names the exact
files after reading them, not from this row.

### VW-L2 - Moonlight dimming + the EclipseState contract amendment (Opus-judgment)

Scale the scene moon light by the uneclipsed disc fraction through the umbral window.
EclipseState scene-light factor is SOLAR-ONLY BY CONTRACT (verified in the sweep) - this
row explicitly amends that contract with a lunar arm, states the amendment in the landing
message, and keeps the solar path byte-identical when no lunar eclipse is in progress.

### VW-L3 - Goldens + Edge acceptance (Sol-bounded spec; executor for pixels)

Node spec pins the geometry against the published 2026-08-28 circumstances as goldens
(greatest 04:12-04:13 UTC, umbral magnitude 0.9319, contacts 02:33/05:52, plus a
no-eclipse control date where coverage must be exactly zero); tolerance stated per value
(Simon1994-vs-catalog spread is ~1-2 min / ~0.02 mag). Edge leg: the Porto Velho preset at
greatest on both backends - bite visible, copper hue present, moonlight dimmed vs a
pre-eclipse frame; PNGs read; a sensitivity anchor (appearance toggled off) must move the
disc luminance or the run is void.

### VW-L4 - Demo + disclosure close-out (Sol-bounded, after VW-L1..L3 land)

Update the eclipse-explorer yaml disclosure (remove Earth-shadow from the unsupported list),
refresh the preset eventStage/context to say the bite is rendered, and move the
NEW-LUNAR-ECLIPSE-EARTH-SHADOW-APPEARANCE row from open to shipped in DEFERRED_WORK and
FEATURE_INVENTORY.


---

## §3 STAGED lanes (verified, NOT armed — R-2026-08-28-4)

| Lane | Verified status at `1f724e17b6` | What arming requires |
|---|---|---|
| **C12 close-out sprint** | Open exit items: `C12-29` S3 REOPENED (closure vacated 2026-08-25), S5 browser cert lanes, C12-11 packet HELD (ruled out of exit gate, R-2026-08-21-16), G3 re-bake NOT EXECUTED (R-2026-08-10-4, manual maintainer session — **scheduled next session per R-2026-08-28-5**). Closing C12 lifts R4 (aurora C15-01..08) and satisfies C14's launch bar (R1) — the single gate in front of BOTH showpiece campaigns. | Maintainer arms the lane; the G3 session happens regardless. |
| **Celestial water reflection (C11-163)** | NOT STARTED, Tier-4/gated, opt-in default-OFF by ratified decision; its C12-14 samplable star cube LANDED Batch 865 (`193393790c`) with **Edge acceptance owed** (small executor row worth folding into any tranche); 4 sub-decisions (C11 queue §7.0) — **scheduled next session per R-2026-08-28-5**. | Sub-decisions ruled, then dispatchable. |
| **Vegetation V1** | FUTURE, design complete (`VEGETATION_SYSTEM_DESIGN.md`), zero code, NO hard gate, seed `C11-SEED-26`. Intake caution verified: the V1 scope-lock's pinned `FeatureRendererKey` numbers are STALE (registry now `FFT_OCEAN: 53, COUNT: 54`) — arming starts with a scope-lock refresh batch. CC-BY-4.0 attribution rider on the biome data stack. | Maintainer arms; scope-lock refresh is the first row. |
| **Storm visuals (C13)** | `C13-25` in-cloud lightning reland: NOT STARTED, deps `C13-17` and `C13-19` BOTH NOT STARTED (verified in the C13 ledger) — not dispatchable as a single row; the C7-era lightning was fully reverted pre-land (zero lightning code in Source, verified). Precipitation coupling + per-region cloud-type mixtures are adjacent C13 rows. | Either arm the dep chain (C13-17 → C13-19 → C13-25) or a maintainer re-scope of the reland. |

---

## §4 Backlog register (sweep of 2026-08-28)

**Premise-verified verdicts (24 of the top 121 by impact — the verification cap is disclosed;
everything below impact-5-verified was NOT re-derived this pass):**

| Verdict | Item | Key evidence |
|---|---|---|
| GATED_HARD | Aurora + space weather (C15-01..08, all phrasings) | Every row `PENDING — HELD (R4) until C12 closes`; C12 open at HEAD; zero aurora code in Source |
| GATED_HARD | Dynamic Ocean & Wind epic / FFT full stack (C14) | Plan complete; bar = C12 completion only (R1); C12 open; only Phillips v1 cascade exists |
| GATED_HARD | Solar corona + prominences (CLT-C3/C3P) | Split ownership; C17 not launched; C15-06P held (R4) |
| OPEN | Vegetation system V1–V6 | FUTURE, design complete, zero code, no gate; stale registry pins noted |
| OPEN | Baily's beads + diamond ring | Gated on the high-precision local-circumstances solver landing first |
| OPEN | Lunar-eclipse Earth-shadow (blood moon) | Nothing renders umbra/penumbra on the lunar disc; open as recorded |
| OPEN | Celestial water reflection (C11-163, both phrasings) | NOT STARTED, Tier-4; C12-14 star cube LANDED B865, Edge acceptance owed; 4 sub-decisions |
| OPEN | Water phases 1–9 (C11-SEED-19) | P3 seed, none C11-schedulable without its own gate |
| STATUS_DRIFTED | Water Phase 1+ WaterClassificationProvider | Seam + lake mask LANDED B636 behind `globe.lakeWaterMask`; remainder gated behind C14 |
| STATUS_DRIFTED | Planar reflections (C11-131) | Owned by C11 W7 (after C10-08b/reversed-Z disposition), not an unowned §D item |
| STATUS_DRIFTED | Lightning / storm effects | Owned by C13-25; C7 version fully reverted pre-land; deps C13-17/19 NOT STARTED |
| STATUS_DRIFTED | Eclipse S5 umbra/penumbra sweep | Implementation DONE both backends; only the seven-lane cert matrix's browser lanes remain |
| STATUS_DRIFTED | Milky Way re-bake (C12-10..13) | Pipeline landed; sole open deliverable = R-2026-08-10-4 4096/face re-bake, manual maintainer session |
| STATUS_DRIFTED | Cloud lightning emissive flash | Same C13-25 ownership as above |
| ALREADY_DONE | Night-lights day/night machinery (CLT-B) | B2 done B913, B4 complete B927, B3 landed (browser acceptance owed → **VW-N7**), B1 residual (c) → **VW-N2** |
| ALREADY_DONE | Eclipse S6 totality phenomena | Landed, Node 51/51 certified 2026-07-28; do not re-dispatch |

**Impact-5 candidates not yet verified** (leads, NOT premises — verify before any brief):
per-region cloud-type/vertical-deck mixtures (C13), precipitation coupling: rain shafts +
ground wetness (C13), water classification RGBA multi-type mask (Phase design), C14 refreshed
wave-1 row set (C14-01..08 readiness proposal, `C14_READINESS_REVIEW_2026-08-28.md`), plus
duplicate phrasings of the verified epics above. Full 321-candidate sweep output banked in
the session scratchpad; this table is the durable record.

---

## §5 Wave rules

Standard discipline applies unchanged: quiet hours (no commits/pushes weekdays 07:00–19:00
ET, machine clock authoritative); workers never touch git/browsers/builds; one Edge job at a
time through the gated executor; C16 comment standard in all new code; both-backend parity
for every renderer-agnostic feature; evidence repatriation before any clone reset; every
brief carries premises re-verified at the cited `file:line` on the day it dispatches.

---

## Live status ledger (update on every landing; rows above are the frozen dispatch text)

| Row | Status |
|---|---|
| VW-N1 | LANDED Batch 1217 - 42 tiles / 128 KB, orientation eye-verified at two levels |
| VW-N2 | LANDED Batch 1218 - discharges CLT-B1 residual (c) from the WebGL side; four ratified pins inverted in place; terminator-law probe lane C now refutes BY DESIGN until its own re-baseline |
| VW-N5 | LANDED Batch 1219 - widened to all eight scalar-or-callback properties through one shared leaf |
| VW-N3 / VW-N4 | UNBLOCKED by N1+N2; dispatched to the re-armed night lane |
| VW-N9 (new) | Dusk-slope scalar: REFUTED as briefed - a runtime slope cannot coexist with the frozen ramp law pinning the literal in three places. Lands only as its own row carrying a CLT-B4 amendment (single source of truth for the default, both backends' defaults asserted equal). Maintainer/orchestrator arming decision |
| VW-N6 / VW-N7 / VW-N8 | pending (N6 after N3; N7 after N3/N4 land + rebuild; N8 after N3) |
| VW-L1 / VW-L2 | lane in flight |

