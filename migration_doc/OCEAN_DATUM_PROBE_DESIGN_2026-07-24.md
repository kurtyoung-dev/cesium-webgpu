<!-- Batch 758 (probe + design, NOT YET RUN). Shared W0 artifact for the TIDES seed and the Dynamic Ocean & Wind epic. -->

# OCEAN-LID VERTICAL DATUM PROBE — design + decision tree (2026-07-24)

**Status: PROBE WRITTEN, NOT RUN.** The orchestrator runs it (it needs the dev
server + network to ion). This document is the reading guide for the numbers it
returns.

**Artifacts**

| File | Role |
|---|---|
| `Tools/visual-regression/probe-ocean-datum.mjs` | The probe (Playwright/Edge, three lanes). |
| `Tools/visual-regression/lib/ocean-datum-model.mjs` | All pure math + the EGM2008 reference table. No browser, no engine imports. |
| `Tools/visual-regression/ocean-datum.spec.mjs` | `node --test` spec pinning that math (39 tests, green). |
| `Tools/visual-regression/output/ocean-datum.json` | The manifest the run emits (schema in §6). |
| `Tools/visual-regression/output/ocean-datum-patch-{off,on}.png` | Canvas-element evidence for lane 2. **Read these.** |

**Authorities**

- `migration_doc/TIDES_FEASIBILITY_2026-07-24.md` §4 "First move regardless of
  placement" + §5a ruling **T2 (RATIFIED with scope expansion)** — the ocean
  anchor must support ellipsoid **and** geoid **and** multiple vertical datums
  derived from the selected terrain/imagery; the datum probe runs first to
  establish what Cesium World Terrain actually uses.
- `migration_doc/OCEAN_DYNAMICS_PLAN_2026-07-24.md` §5 phase **W0** and the
  UNCONFIRMED register entry *"Cesium-World-Terrain ocean-lid datum (W0 probe,
  shared with tides)"*.
- `migration_doc/DEFERRED_WORK.md` — `C6-FFT-OCEAN-TIDE-DATUM` seed.

---

## 1. The question

`OceanSurfacePrimitive` anchors its FFT patch at
`ellipsoid.scaleToGeodeticSurface(cameraPos)` — **ellipsoidal height 0 by
construction** (`packages/engine/Source/Scene/OceanSurfacePrimitive.js:115-167`,
comment *"Sea-level point under the camera (height 0 datum)"*), and the WGSL
patch is a spherical cap **through** that anchor
(`packages/engine/Source/Shaders/WebGPU/Ocean/OceanSurface.wgsl:99`,
`drop = -(e0² + n0²) · 0.5 · invRadius`). So the anchor's geodetic height **is**
the patch's sea-level datum — one number, exactly measurable.

What is **not** known is the datum of the surface it is drawn over: the Cesium
World Terrain "ocean lid". If CWT's sea sits at ellipsoidal 0 the two agree
everywhere. If CWT carries the geoid, they disagree by the local EGM2008
undulation — up to about **±100 m**, which is a visible plateau at any shoreline
framing and a latent defect in the *shipped* FFT ocean independent of tides.

Three answers are possible and each sends the design somewhere different:

| Answer | What Design A does | What T2's multi-vdatum architecture must carry |
|---|---|---|
| **ELLIPSOID_ZERO** | Tide offset rides **raw ellipsoidal heights**; the existing `scaleToGeodeticSurface` anchor is already correct; Design A adds tide alone along `_a0Up`. | Still built (other providers, other datums) — but CWT contributes a **zero** geoid term, so the v1 default path needs no correction. |
| **GEOID** | Per T2 the offset uniform carries **geoid + tide together**. | The geoid term is load-bearing on the default terrain, and the shipped FFT ocean has a **latent ~100 m datum defect** worth fixing on its own. |
| **MIXED / OTHER** | Blocked — no single offset is correct. | Escalate to the full T2 adapter: per-provider datum metadata + manual override, regional vdatum offsets riding the same uniform. |

---

## 2. What is measured, and why that instrument

### Lane 1 — datum survey (six open-ocean sites)

**Instrument: `sampleTerrainMostDetailed` + `sampleTerrain` at fixed levels**
(`packages/engine/Source/Core/sampleTerrainMostDetailed.js`,
`.../sampleTerrain.js`), against the **app's own** provider
(`scene.globe.terrainProvider`).

*Justification.* These read the **decoded terrain-tile height** directly. That
makes the measurement:

- **backend-independent** — no WebGL/WebGPU shader is in the path, so the number
  is a property of the *data*, which is the question asked;
- **exaggeration-independent** — `sampleTerrain*` never applies
  `VerticalExaggeration` (it is the raw control lane 3 relies on);
- **camera-independent** — no tile must be on screen, no LOD must be reached by
  SSE, no pick ray can miss;
- **precise in metres**, not pixels — a screen-space or `pickPosition`
  measurement would fold in projection, log-depth and sub-pixel error to answer
  a question whose whole content is "is this 0 or is this −100?".

The app's provider is used rather than a freshly constructed one so the survey
measures **the terrain the FFT ocean is actually drawn over**. Its identity
(constructor, water mask, vertex normals, credit, redacted resource URL,
tiling-scheme ellipsoid) is recorded in the manifest; the ion asset id (**1**) is
recorded as a static fact traced to
`Apps/CesiumViewer/CesiumViewer.js:58-62` → `Core/createWorldTerrainAsync.js:44`
(`CesiumTerrainProvider.fromIonAssetId(1, …)`).

Each site is also sampled at **levels 4, 8, 11**. Levels 0–3 are deliberately
**not** sampled: a level-0 quantized-mesh tile spans 90° of longitude, so an
open-ocean point there is interpolated across triangles that can reach
continental land — a coarse-LOD difference would be a tessellation artifact, not
a datum signal. Only levels ≥ 8 feed the LOD-dependence verdict; coarser levels
are reported as `coarseLevelSpreadM` and never gate.

The tiling-scheme ellipsoid and both `Ellipsoid.WGS84` / `Ellipsoid.default`
radii are recorded too: an ellipsoid mismatch is a **third** vertical-datum axis
the T2 adapter would have to carry, and it is free to check here.

### Lane 2 — FFT patch anchor vs the CWT waterline

**Instrument: API reads, corroborated by a canvas PNG pair.**

- `prim._a0` and `prim._anchor` → `Cartographic.fromCartesian(…, Ellipsoid.WGS84)`
  → the patch's sea-level datum in metres.
- `sampleTerrainMostDetailed` at the **anchor's own lon/lat** (apples to apples,
  not at a nominal site coordinate) → the raw CWT lid.
- `globe.getHeight(carto)` at the same point → the **rendered** lid (this picks
  the rendered mesh, so it also cross-checks raw-vs-rendered agreement).
- Offset = `terrain − anchor`. Sign convention: **positive ⇒ the patch is BELOW
  the waterline** (occluded by the opaque baked sea); **negative ⇒ the patch
  floats ABOVE it** (the visible-plateau failure a geoid lid would produce).

API reads are preferred over a screen-space measurement — the task's stated
preference and the better instrument (metres, not pixels). The PNG pair is
corroboration per Principle 8 step 4: **read the images**, do not trust the
number alone.

**A null result cannot masquerade as agreement.** The lane captures three
frames: `off1` after settling, `off2` after a further 120 frames with the ocean
still **off**, and `on` after 120 frames with it **on**. `off1→off2` is the
animated water-mask temporal **baseline**; the patch counts as "in frame" only if
the `off2→on` delta beats `max(0.5, 2 × baseline)`. Without that control, the
base globe's own animated waves would report "something changed" and a
0 m offset from an *absent* patch would read as success.

Lane 2 is **WebGPU-only** — `OceanSurfacePrimitive.update` returns early unless
`context.isWebGPU` (documented WebGL no-op, `Scene/GlobeWaterOcean.js:9-14`).

### Lane 3 — does `scene.verticalExaggeration` displace the lid?

**Instrument: `globe.getHeight()` at exaggeration 1.0 vs 3.0, with
`sampleTerrainMostDetailed` as the invariant control.**

*Justification.* Cesium's exaggeration is applied in the vertex stage, but the
CPU-side terrain **picker is rebuilt** when the encoding's exaggeration changes
(`Core/TerrainMesh.js:244-250`, `Scene/GlobeSurfaceTile.js:250-291`), so
`globe.getHeight()` — which picks `renderedMesh` — reports the **displaced**
surface. `sampleTerrain*` does not, which is exactly the renderer-vs-CPU
divergence the tides report lists in Design B's artifact bill; measuring both in
one lane turns that bullet into a number.

The model is `h' = (h − relativeHeight) · scale + relativeHeight`
(`Core/VerticalExaggeration.js:18-28`) with `relativeHeight = 0`, so:

- an **ellipsoid-0** lid is a **fixed point** — `0 × 3 = 0`, nothing moves;
- a **geoid** lid at −100 m goes to **−300 m** at scale 3.

Two sites: `IND-LOW` (maximum lever) and `PAC-MID` (near-zero control). The
verdict distinguishes `NO_DISPLACEMENT` / `DISPLACES_AS_MODELED` /
`DISPLACES_UNMODELED` — the last would itself be a finding (something other than
the documented map is moving the lid).

---

## 3. The sites, and why each one

All six are **open ocean**, far enough offshore that the CWT surface there is
unambiguously the water lid rather than a coastal DEM.

| id | lon | lat | EGM2008 N (m) | ± | confidence | why this site |
|---|---:|---:|---:|---:|---|---|
| `IND-LOW` | 78.0 E | 4.0 N | **−100** | 15 | HIGH | Indian Ocean geoid low SW of Sri Lanka — the EGM2008 **global minimum** region (≈ −106 m near 4.7 N / 78.8 E). The strongest single lever: a geoid lid reads ≈ −100 m here. |
| `ICE-HIGH` | 20.0 W | 62.0 N | **+60** | 15 | MEDIUM_HIGH | North Atlantic high south of Iceland — the opposite-sign anchor. With `IND-LOW` it gives a ~160 m signed span no flat lid can imitate. |
| `NGUI-HIGH` | 146.0 E | 1.0 N | **+65** | 20 | MEDIUM | West Pacific high north of New Guinea, on the flank of the EGM2008 **global maximum** (≈ +86 m, New Guinea highlands). A second positive site in a different basin guards against a basin-local artifact. |
| `HUDSON-LOW` | 85.0 W | 59.5 N | **−40** | 15 | MEDIUM | Hudson Bay geoid low (post-glacial-rebound mass deficit). A **high-latitude** negative site — separates a real geoid from any latitude-banded artifact — and it is enclosed sea, so it also probes whether CWT treats inland sea like open ocean. |
| `PAC-MID` | 150.0 W | 10.0 N | **+5** | 15 | MEDIUM_LOW | Central North Pacific neutral band. **The control**: reads ≈ 0 under *both* hypotheses, so a non-zero value here with zeros elsewhere (or the reverse) is the tell for a mixed datum. |
| `ATL-MID` | 30.0 W | 30.0 N | **+30** | 20 | LOW | Mid North Atlantic — an intermediate lever so the slope-1 regression is not driven only by the two extremes. Lowest-confidence value; its wide band keeps it from dominating the fit. |

**Source (hardcoded, never fetched at runtime).** EGM2008 — Pavlis, Holmes,
Kenyon & Factor, *"The development and evaluation of the Earth Gravitational
Model 2008 (EGM2008)"*, J. Geophys. Res. **117**, B04406 (2012); NGA EGM2008
model documentation and the standard published geoid-undulation map derived from
it. Values are read off that map at the stated coordinates and are therefore
**approximate**; each carries an explicit tolerance band and confidence tag.

**Honest limitation, stated up front.** These reference values are
map-resolution reads, not per-point evaluations of the spherical-harmonic model.
That is why the probe is built so the **primary discriminator does not depend on
them at all**:

- *table-independent*: is `max|h|` under 2 m (flat at 0), or does the set spread
  over tens of metres?
- *table-dependent, secondary*: does the height **sign** agree with the
  undulation sign at the strong sites, and does the regression slope land near 1?

If the spread is geoid-shaped but the slope misses the [0.7, 1.3] band, the
classifier returns `GEOID_SHAPED_SLOPE_MISMATCH`, whose stated meaning is
**"refine the table against an authoritative EGM2008 calculator first"** — not
"the datum is mixed". Refining a value here is a one-line edit in
`lib/ocean-datum-model.mjs`; the spec's ±110 m physical-range assertion and the
classifier's wide bands both survive it unchanged.

---

## 4. Expected outcomes under each hypothesis

| Observable | ELLIPSOID_ZERO | GEOID | MIXED / OTHER |
|---|---|---|---|
| Lane 1 per-site height | all ≈ 0.0 m (|h| ≤ 2) | ≈ the undulation: −100, +60, +65, −40, +5, +30 | anything else |
| `spreadM` | ≈ 0 | ≥ 40 (expect ≈ 165) | varies |
| `rmsResidualVsEllipsoidM` | ≈ 0 | ≈ 60 | — |
| `rmsResidualVsGeoidM` | ≈ 60 | ≈ 0 (within table error) | — |
| regression slope / r² | slope 0, r² 1 (flat-perfect) | slope ≈ 1, r² ≥ 0.85 | off-band |
| `signAgreement` | n/a (all zero) | 1.0 | < 0.8 |
| Lane 2 offset (terrain − anchor) | ≈ 0 ⇒ `COPLANAR` | ≈ −95 ⇒ `PATCH_ABOVE_WATERLINE` | any |
| Lane 2 PNG | patch blends with the baked sea (co-planar mixing / z-fighting at the seam) | patch reads as a **raised water plateau** ~95 m above the baked sea, with a hard rim | — |
| Lane 3 `IND-LOW` | 0 → 0 ⇒ `NO_DISPLACEMENT` | −100 → −300 ⇒ `DISPLACES_AS_MODELED` | `DISPLACES_UNMODELED` |
| Lane 3 `PAC-MID` (control) | 0 → 0 | ≈ +5 → +15 (small but non-zero) | — |
| Lane 3 raw control | invariant | invariant | drift ⇒ instrument fault |
| exit code | **0** | **0** | **1** |

---

## 5. The decision tree the numbers feed

```
                     ┌────────────────────────────┐
                     │ lane 1: six ocean heights  │
                     └─────────────┬──────────────┘
                                   │
        LODs (≥8) disagree > 2 m ──┼──► MIXED / LEVEL_DEPENDENT ........ exit 1
                                   │      no single offset can be right;
                                   │      the vdatum adapter must be LOD-aware
                                   │
              max|h| ≤ 2 m  ───────┼──► ELLIPSOID_ZERO ................. exit 0
                                   │      tide offset rides RAW ELLIPSOIDAL
                                   │      heights; today's anchor is correct;
                                   │      Design A = tide term alone on _a0Up
                                   │
     spread ≥ 40 m ∧ r² ≥ .85      │
     ∧ signAgreement ≥ .8          │
         ├─ slope∈[.7,1.3] ∧ ──────┼──► GEOID .......................... exit 0
         │  |intercept| ≤ 15       │      per T2 the offset uniform carries
         │                         │      GEOID + TIDE together; the shipped
         │                         │      FFT ocean has a LATENT ~100 m defect
         │                         │
         └─ otherwise ─────────────┼──► MIXED / GEOID_SHAPED_SLOPE_MISMATCH
                                   │      REFINE THE REFERENCE TABLE first,
                                   │      then re-read .............. exit 1
                                   │
     spread ≤ 2 m ∧ mean|h| > 2 ───┼──► MIXED / CONSTANT_OFFSET ........ exit 1
                                   │      a uniform datum shift — one scalar,
                                   │      but not the geoid
                                   │
     r² ≥ .7 ∧ slope∈[.2,.7) ──────┼──► MIXED / PARTIAL_GEOID .......... exit 1
                                   │      blended datum
                                   │
     otherwise ────────────────────┴──► MIXED / UNCLASSIFIED ........... exit 1
```

Lane 2 and lane 3 do not change the datum branch; they qualify it:

- **Lane 2** says whether the *shipped* FFT ocean already has a visible defect at
  a high-undulation coast, and by how many metres — i.e. whether a fix is owed
  independent of tides.
- **Lane 3** says whether `verticalExaggeration` amplifies the lid's height. If
  it does, Design B inherits the full lake/ocean gating bill *and* any tide term
  must **compose with** the exaggeration map rather than be added after it. If it
  does not (the ellipsoid-0 fixed point), that bill is smaller than the tides
  report assumed.

**Exit codes.** `0` = a clean, actionable answer (ELLIPSOID_ZERO or GEOID).
`1` = an answer was obtained but it is the MIXED/OTHER branch (or the survey was
too thin) — **escalate to the T2 multi-vdatum adapter; this is a real result,
not a broken probe.** `2` = structural: ion unreachable, no terrain availability,
backend fallback, a lane threw, or the 480 s watchdog fired. The probe **never
fabricates a height**; an unreachable ion produces exit 2 with the message
*"terrain provider has no tile availability — Cesium World Terrain did not load"*
or *"every survey site returned an undefined height"*, plus the list of failed
`*.cesium.com` requests.

---

## 6. Manifest schema (`Tools/visual-regression/output/ocean-datum.json`)

`schemaVersion: 1`. Every metre value is `number | null` — `null` means *not
measured*, never *zero*.

```jsonc
{
  "probe": "probe-ocean-datum",
  "schemaVersion": 1,
  "generatedAt": "<ISO-8601>",
  "base": "http://localhost:8080",
  "watchdogMs": 480000,
  "clockIso": "2026-07-03T06:00:00Z",          // pinned clock for every render

  "environment": {
    "browserChannel": "msedge", "headless": true,
    "viewport": { "width": 1280, "height": 720 },
    "rendererRequested": "webgpu",
    "rendererActual": "webgpu"                  // != requested ⇒ structural exit 2
  },

  "terrainProvider": {
    "rendererType": "webgpu",
    "constructorName": "CesiumTerrainProvider",
    "hasAvailability": true,                    // false ⇒ structural exit 2
    "hasWaterMask": true,
    "hasVertexNormals": true,
    "creditHtml": "<string|null>",
    "resourceUrlRedacted": "<url, query + JWT stripped|null>",
    "tilingSchemeEllipsoidRadii": { "x": 0, "y": 0, "z": 0 },
    "ellipsoidWgs84Radii":  { "x": 0, "y": 0, "z": 0 },
    "ellipsoidDefaultRadii": { "x": 0, "y": 0, "z": 0 },
    "ellipsoidsMatch": true,                    // false ⇒ a THIRD vdatum axis
    "ionAssetId": 1,
    "ionAssetIdSource": "<code trace>",
    "licenceNote": "ion Community plan — STREAM-ONLY; nothing cached or bundled"
  },

  "thresholds": { /* verbatim THRESHOLDS from lib/ocean-datum-model.mjs */ },
  "referenceTable": [ /* verbatim DATUM_SITES incl. undulation, tolerance,
                         confidence, source, and the per-site rationale */ ],

  "lane1_datumSurvey": {
    "ok": true, "reason": null,
    "sites": [{
      "id": "IND-LOW", "lonDeg": 78.0, "latDeg": 4.0,
      "maxAvailableLevel": 9,                   // availability.computeMaximumLevelAtPosition
      "heightM": 0.0,                           // sampleTerrainMostDetailed
      "heightByLevelM": { "4": 0.0, "8": 0.0, "11": null },
      "egm2008": { "undulationM": -100, "toleranceM": 15,
                   "confidence": "HIGH", "source": "…" },
      "residualVsEllipsoidM": 0.0,              // heightM - 0
      "residualVsGeoidM": 100.0                 // heightM - undulationM
    } /* ×6 */],
    "stats": {
      "n": 6, "nWithHeight": 6,
      "meanHeightM": 0.0, "meanAbsHeightM": 0.0, "maxAbsHeightM": 0.0,
      "spreadM": 0.0,
      "rmsResidualVsEllipsoidM": 0.0, "rmsResidualVsGeoidM": 63.2,
      "regression": { "slope": 0.0, "intercept": 0.0, "r2": 1.0, "n": 6 },
      "signAgreement": 0.0, "signTestSites": 5,
      "levelDependence": {
        "maxSpreadM": 0.0, "worstSiteId": null, "dependent": false,
        "minLevelConsidered": 8, "levelsUsed": [8, 11],
        "coarseLevelSpreadM": 0.0               // informational, never gates
      },
      "perSite": [ /* id, undulationM, heightM, residualVsEllipsoidM, residualVsGeoidM */ ]
    },
    "classification": "ELLIPSOID_ZERO",
    "subLabel": null,
    "reasons": ["…"],
    "consoleErrors": [], "failedIonRequests": []
  },

  "lane2_fftPatchVsWaterline": {
    "ok": true, "reason": null,
    "site": { "id": "LKA-COAST", "lonDeg": 79.75, "latDeg": 6.0,
              "cameraAltM": 120.0, "headingDeg": 90.0, "pitchDeg": -6.0,
              "approxUndulationM": -95 },
    "primitive": {
      "created": true, "show": true,
      "a0":     { "lonDeg": 0, "latDeg": 0, "heightM": 0.0 },
      "anchor": { "lonDeg": 0, "latDeg": 0, "heightM": 0.0 },
      "patchLengthM": 250, "patchExtentM": 3000,
      "uvOffset": [0, 0], "invRadius": 1.57e-7, "curvatureRadiusM": 6378137
    },
    "terrainAtAnchor": { "terrainRawHeightM": 0.0, "terrainRenderedHeightM": 0.0 },
    "offsets": { "rawMinusAnchorM": 0.0, "renderedMinusAnchorM": 0.0 },
    "verdict": "COPLANAR",   // | PATCH_ABOVE_WATERLINE | PATCH_BELOW_WATERLINE | INDETERMINATE
    "visual": {
      "meanAbsLumDelta": 0.0,       // off2 → on
      "baselineLumDelta": 0.0,      // off1 → off2, same frame span (control)
      "frameSpan": 120, "width": 1280, "height": 720,
      "patchVisible": true, "patchVisibilityFloor": 0.5,
      "pngs": { "oceanOff": "<path>", "oceanOn": "<path>" }
    },
    "consoleErrors": [], "failedIonRequests": []
  },

  "lane3_verticalExaggeration": {
    "ok": true, "reason": null,
    "cameraAltM": 15000.0, "exaggeration": 3.0,
    "sites": [{
      "id": "IND-LOW", "lonDeg": 78.0, "latDeg": 4.0,
      "exaggeration": 3.0, "relativeHeightM": 0.0,
      "renderedH1M": 0.0, "renderedH3M": 0.0,   // globe.getHeight (rendered mesh)
      "rawH1M": 0.0,      "rawH3M": 0.0,        // sampleTerrainMostDetailed (control)
      "verdict": "NO_DISPLACEMENT",             // | DISPLACES_AS_MODELED
                                                // | DISPLACES_UNMODELED | INDETERMINATE
      "predictedH3M": 0.0,                      // (h1 - rel)*scale + rel
      "renderedDeltaM": 0.0, "modelResidualM": 0.0, "modelToleranceM": 1.0,
      "rawInvariant": true                      // false ⇒ instrument fault
    } /* ×2 */],
    "consoleErrors": [], "failedIonRequests": []
  },

  "decision": {
    "datumHypothesis": "ELLIPSOID_ZERO",
    "subLabel": null,
    "implication": "<what Design A / T2 must do>",
    "patchImplication": "<lane 2 in one sentence>",
    "exaggerationImplication": "<lane 3 in one sentence>",
    "structuralFailures": [],
    "exitCode": 0,
    "GATE": "ANSWERED — CWT ocean-lid datum = ELLIPSOID_ZERO"
  }
}
```

---

## 7. Probe-rule compliance

| Fleet rule | How it is met |
|---|---|
| Pinned clock | `DAY_ISO = 2026-07-03T06:00:00Z` re-pinned **before every** `scene.render(T())` in lanes 2 and 3; lane 1 renders nothing. |
| Same-task capture | `grab()` renders and calls `drawImage` + `getImageData` + `toDataURL` with **no `await` in between** (WebGPU clears the drawing buffer once the compositor presents). |
| Canvas-element PNGs | PNGs come from a 2-D copy of `scene.canvas` only — no `page.screenshot`, no app chrome. |
| Helpers inside `page.evaluate` | `withTimeout`, `redact`, `num`, `radii`, `grab`, `advance`, `meanAbsLum`, `rawHeight`, `settle`, `cartoOfCartesian` are all defined **inside** the evaluated function; only plain-object arguments cross the boundary. |
| Watchdog | 480 s hard timer, `unref`'d, `process.exit(2)` on fire. Longer than the 300 s fleet default because three lanes stream CWT tiles from ion at eight distinct locations — stated explicitly at the constant. |
| Bounded loops | Every loop is `for (i < N)` over a constant from `FRAMES` / `SURVEY_LEVELS` / the site list; every in-page `await` is wrapped in `withTimeout(…, IN_PAGE_TIMEOUT_MS)`. No `while (true)`. Asserted by the spec. |
| Exit codes | 0 / 1 / 2 as §5. Backend fallback (`rendererType !== "webgpu"`), missing availability, all-null heights and any lane exception are all exit 2. |
| No default render loop | `viewer.useDefaultRenderLoop = false` in every lane. |
| Scene restored | Lane 2 sets `globe.water.ocean.enabled = false` on exit; lane 3 restores `verticalExaggeration = 1.0` between sites and at the end. |
| Secrets | Any ion resource URL is stripped of its query string and of JWT-shaped substrings before it reaches the manifest. |
| Licence | Network use is **stream-only** (ion Community plan). The probe caches nothing, writes no tile bytes, and bundles nothing. Recorded in `terrainProvider.licenceNote`. |

---

## 8. What the orchestrator's run disambiguates

1. **The UNCONFIRMED register entry** shared by both epics — *"Cesium-World-
   Terrain ocean-lid datum"* — becomes a number, and T2's expanded scope gets its
   empirical input: whether CWT's contribution to the vdatum stack is zero or
   ~±100 m.
2. **Whether the shipped C6 FFT ocean has a latent datum defect** at
   high-undulation coasts, independent of tides — lane 2's offset in metres plus
   two PNGs to look at.
3. **Whether `verticalExaggeration` moves the ocean lid**, which is the size of
   Design B's lake/ocean gating bill and decides whether a tide term must compose
   with the exaggeration map or can be added after it.
4. **Whether the datum varies with terrain LOD**, which would make even a correct
   single geoid term wrong at some zoom levels.
5. **Whether `Ellipsoid.WGS84` and `Ellipsoid.default` agree** with the tiling
   scheme's ellipsoid — a third vertical axis the adapter would otherwise
   discover late.
6. **Whether CWT treats enclosed sea (Hudson Bay) like open ocean** — the one
   site in the survey that is not open ocean by geography but is water by mask.

**What it does not answer** (out of scope, stated so nobody over-reads the
manifest): the datum of *other* terrain providers (Cesium World Bathymetry, user
providers) — the T2 adapter must still be designed for the general case; the
datum of *imagery*; anything about tide magnitude, timing or the T6 phase-lock
acceptance criterion.
