# Weather Data Ingest Roadmap — real weather → the cloud renderer (C2-16 seam)

**Status:** P0+P1 SHIPPED (Batch 410 `f047c29f32`; audit fixes Batch 411 `1f83a48c7c`).
**P2 (time model) SHIPPED — Batch 416. P3-CORE SHIPPED — Batch 424:** the FIRST
weather→WGSL G/B/A channel reads (clouds respond to density-bias **A**, cloud-base **B**,
genus **G** — not just coverage **R**; neutral G=0.5/B=0/A=0.5 is byte-identical, gated by
`weatherChannelStrength`, default off-equivalent) + a **MOCK-EDR fixture harness**
(`Tools/visual-regression/fixtures/edr-cube-tcc.json` + a dev-server `/mock-edr` route)
that drives `EdrWeatherSource` end-to-end OFFLINE — which **retroactively completes the
Phase-1 pipeline verification** the live network had blocked (fetch→CoverageJSON
parse→packer→weatherTex→deck, no fallback). Verified: `probe-weather-channels.mjs`
(east dense-overcast vs west thin-stratiform at the SAME R coverage — PNGs read) +
`probe-weather-edr-mock.mjs` (fixture clear-NW→overcast-SE ramp reaches the deck).
**P3-SOURCES SHIPPED (Batch 425): `MetarWeatherSource` + `WcsCoveragesWeatherSource`.**
METAR parses station cloud groups (FEW/SCT/BKN/OVC + ceiling + CB/TCU genus) and
IDW-rasterizes them into a FULL-RGBA field (R cover, G genus, B base, A density) — the
one source that exercises the whole G/B/A path from a real format. WCS uses MSC GeoMet's
OGC API-Coverages → CoverageJSON (R coverage; binary GeoTIFF/NetCDF decode deferred). A
shared `CoverageJsonParser.ts` was extracted (EdrWeatherSource now delegates to it; its
regression probe stayed GREEN). Verified offline via `/mock-metar` + `/mock-wcs` fixtures:
`probe-weather-metar.mjs` (OVC overcast deck vs SKC clear, G/B/A channels shift the deck —
PNG read), `probe-weather-wcs.mjs` (east overcast → west clear). **Phase 3 is COMPLETE
offline; the only network-gated residual is the live endpoint confirm (collection ids +
CORS) per source.** P4 (binary GRIB2/NetCDF behind WASM) remains the deferred high-fidelity
tier. Follow-up (Principle 9): `profileExtinction`
(slot 103) still scaffolding — G biases shape/density but not yet per-position optical
extinction. **Live EDR (the real feed) is wired (`EdrWeatherSource`) but the LIVE call +
CORS + the guessed collection id `automated_gfs` still need confirming in a networked
browser** — the dev sandbox has no outbound network to external hosts (CLI `curl` →
`http=000`, browser `fetch` → timeout); the mock harness now covers everything except that
last live hop.
Phases P3–P4 remain. (Original research+design below, 2026-06-26.)

**P2 — TIME MODEL (SHIPPED Batch 416).** `WeatherProvider` gained `WeatherTimeMode`
(`live`/`historical`/`projected`) + `setTimeMode`/`setTime`/`setForecastOffsetHours`/
`setQuantizeHours`/`tick(now)`. It resolves a quantized time SLICE each frame, holds an
LRU cache of packed slices (scrubbing reuses fetched data), and bumps `version` ONLY when
the active slice's bytes change (not every tick). `WeatherFieldRequest.time` (`Date |
"latest"`) carries the instant to the source. `SyntheticWeatherSource("drift")` is a
deterministic time-varying field (a longitude band that phases with `request.time`,
24 h period) so the whole model is verified offline by
`Tools/visual-regression/probe-weather-time.mjs` (9/9 GREEN — no network, no WebGPU). The
legacy single-request (`timeMode === null` → `"latest"`) path is byte-identical. Real
historical/projected EDR validation inherits the live-network blocker.
**Goal (user):** ingest **historical, live, or projected** weather from **open** sources and
**swap between them** at runtime, to drive the WebGPU procedural clouds with *real*
conditions — in addition to the METAR/WMO preset vocabulary already shipped (Batch 405).

This is the keystone the cloud system was scaffolded for: the renderer already has a
**weather-map texture** (the "C2-16 seam"). Today it's filled procedurally; this roadmap
replaces that fill with decoded real-world data.

Derived from a multi-agent research + design + adversarial-review workflow. The honest
caveats from the review are folded in below — read them before committing to "no server".

---

## The C2-16 seam (verified against source)

- `WebGPUProceduralCloudRenderer.ts`: `WEATHER_TEX_W/H = 256/128`, `rgba8unorm`,
  equirectangular geographic, row 0 = north pole. `buildProceduralWeatherMap` (~L140-158)
  currently writes **R = coverage·255, G = 128, B = 0, A = 128**.
- `ProceduralClouds.wgsl`: the shader samples **only `wsample.r`** — in BOTH `cloudDensity`
  and the skip-oracle `cloudBaseDensity` (`effectiveCoverage = wsample.r * weatherStrength`).
  **G/B/A are forward scaffolding the shader does not yet read.**
- `weatherTexBounds` (uniform floats 68-71) = `(-π, -π/2, 2π, π)`; `weatherMapEnabled` = float 64;
  `worldToWeatherUV` maps lon/lat → uv.

**Consequence:** the **MVP only needs the R channel correct**. No WGSL change is required to
make real cloud-cover drive the clouds — just overwrite R in the existing texture. (This is
also why Batch 405's presets keep `cloudWeatherMap` off: the procedural R field reads ~clear
at the demo location, collapsing coverage. Real data fixes that.)

### Field → channel mapping (unit conversions centralized in one packer)

| Channel | Meaning | Source → value |
|---|---|---|
| **R** | coverage 0-1 | TCDC% /100; `tcc` clamp; METAR oktas /8 (SKC0/FEW1.5/SCT3.5/BKN6/OVC8) |
| **G** | genus (enum/255) | GFS/ECMWF LCDC-vs-HCDC dominance; METAR `ww`/CL/CM/CH; HRRR categorical precip |
| **B** | cloud base (norm) | ceiling ft·0.3048 → m, then `/12000` (12 km covers cirrus) |
| **A** | density bias 0-1 | ERA5 clwc/ciwc or MRMS/HRRR precip intensity; default 0.5 (neutral) |

---

## Recommendation — best open source

**Default: OGC API – EDR `cube` query → CoverageJSON, NOAA/NWS-MDL, GFS, parameter `TCDC`.**
- Endpoint (free, **no auth**, US-Gov **public domain**): `https://data-api.mdl.nws.noaa.gov/EDR-API`
  (collections: GFS, NAM, NDFD, METAR/TAF).
- Why: only combo that is a ratified OGC standard **and** free/no-auth **and** returns compact
  **JSON that parses natively in the browser — zero GRIB2/NetCDF binary decode** — **and**
  serves both gridded forecast (`cube`/`area`) and point obs (`position`/`radius`) from one
  interface. CoverageJSON (OGC Community Standard) resamples straight into the 256×128 texture.
- ⚠️ **Caveat (review):** this is a **dev-lab/prototype** endpoint — treat as "may disappear
  without notice," and **CORS is unverified**. The source layer must support an optional
  same-origin proxy + `AbortSignal` from day one; if browser preflight fails, a proxy is
  required and the "zero server" claim collapses. Also: many EDR `cube` servers ignore a
  client grid-size and return **native** resolution (GFS 0.25° global ≈ 1M cells, multi-MB
  CovJSON) — request a coarse bbox / verify subsampling, and resample **off** the render path.

**Runner-up: OGC API – Coverages / WCS 2.0.1 against ECCC MSC GeoMet** (`https://api.weather.gc.ca`)
— free, anonymous, **production-grade** (no dev-lab caveat), GDPS/RDPS/HRDPS. Cost: GeoTIFF/NetCDF
subset needs a worker decode (`geotiff.js`). Use when EDR conformance is missing or you need the
full grid at exact resolution.

### Standards ranking (for this in-browser cloud use)

1. **OGC API – EDR → CoverageJSON** — winner: lightweight "just my subset," native JSON, one URL
   pattern for grid + point, free no-auth endpoints, maps 1:1 onto the texture bake.
2. **WCS 2.0.1 / OGC API – Coverages** — most production-deployed; full-grid/exact-resolution, but
   binary raster needs a worker decode. Use where EDR is absent (ECCC, DWD).
3. **Direct GRIB2/NetCDF (NOAA NODD S3: HRRR/GFS/NBM/NDFD, ECMWF)** — richest data (HRRR 3 km
   ceiling/base/top/VIS + categorical precip; NBM blended sky/ceiling/vis) but worst browser fit:
   needs WASM/worker GRIB2 decode, an S3 **proxy** (NODD has no permissive CORS), Lambert-Conformal
   reprojection. Highest fidelity, highest cost — gate behind WASM, late phase.
4. **OGC SensorThings API (STA) + METAR/ASOS** — wrong tier as a *primary* gridded source (discrete
   station obs, not grids), but a great **complement**: IDW-rasterize METAR oktas/ceiling to fill the
   grid, drive G (genus from `ww`/CL/CM/CH) and B (ceiling). METAR via `aviationweather.gov` is keyless.

---

## Phased plan

- **Phase 0 — Scene-layer Weather abstraction (no rendering change).** New backend-agnostic
  `packages/engine/Source/Scene/Weather/`: `WeatherSource` interface (`getCapabilities` +
  `fetchField`/`field$` RxJS), `WeatherField`/`Request`/`Capabilities`/`Channel` types, a
  `CloudType`-aligned genus enum for the future G channel, and a `WeatherTexPacker` whose byte
  layout **exactly matches** `buildProceduralWeatherMap`. Centralize **all** unit conversions
  here. No `Renderer/WebGPU` import (Principle 2). Unit-test the CRS resample. (~2-3 days, pure TS.)
- **Phase 1 — MVP: EDR → weatherTex end-to-end (R only).** `EdrWeatherSource` (one EDR `cube`,
  GFS/TCDC, `latest`, CoverageJSON, pure-JS parse) + a `WeatherProvider` orchestrator
  (active source + packer + cache, `getPackedTexture(bounds,w,h,time)`). Wire the renderer's
  `ensureWeatherView` to call it instead of `buildProceduralWeatherMap`; keep the 1×1 white
  fallback and only flip `weatherMapEnabled=1` once real data is packed (avoid overcast-
  everywhere). Pass the provider's **actual returned bounds** into `weatherTexBounds`. **Zero
  WGSL changes.** Playwright probe: procedural vs EDR-backed clouds. (~3-4 days; includes
  optional-proxy + `AbortSignal`.)
- **Phase 2 — Time model: live + historical + projected.** `WeatherProvider` resolves
  `Date|'latest'` → LIVE (newest analysis, ~10 min refresh, re-bake only when validTime
  changes via the existing `cache.weatherFilled` dirty flag), HISTORICAL (EDR `datetime=<iso>`,
  gated by `Capabilities.validRange`), PROJECTED (future Date → forecast valid-time). CPU temporal
  lerp between bracketing forecast hours; LRU cache keyed on `(sourceId,bounds,w,h,quantizedTime,
  channels)`; throttle bake/upload to cache-miss-or-live-refresh, never per frame. (~3-4 days, no
  shader work.)
- **Phase 3 — Multi-provider + station obs + full RGBA.** `WcsCoveragesWeatherSource` (MSC GeoMet,
  worker-decoded GeoTIFF/NetCDF) and `MetarWeatherSource` (IDW-rasterize oktas/ceiling). Populate
  G/B/A in the packer **and** add the matching WGSL reads (first shader change). Per-source field-
  name maps only (units already centralized). (~5-7 days; backends parallelize.)
- **Phase 4 — Direct GRIB2/NetCDF (high-fidelity NODD) behind WASM.** `Grib2FileWeatherSource`
  decoding NODD-S3 / user GRIB2 in a Worker/WASM (feature-detect, async, JS fallback, destroy/
  free/version/SIMD per the WASM strategy). Unlocks HRRR/NBM. **Requires a same-origin proxy**
  (S3 NODD has no browser CORS) + Lambert-Conformal→equirect reprojection isolated in the packer.
  Consider CONUS bounds / larger `WEATHER_TEX_W/H` to avoid smearing 3 km detail. (~1-2 weeks.)

### C13-08 supersedes the Phase-1 "pass the returned bounds into `weatherTexBounds`" plan

Phase 1 above proposed feeding the provider's actual returned bounds into the `weatherTexBounds`
uniform. **`C13-08` deliberately did NOT do that, and the plan is superseded.** The weather sampler
repeats in U (`addressModeU: "repeat"`, the C13-07 seam contract), so a regional `weatherTexBounds`
would TILE the region across the whole planet instead of restricting it — trading one wrong answer
for another. The shipped contract keeps `weatherTexBounds` GLOBAL and honours the field's rectangle
in the PACKER, which writes the field only into the texels its bounds cover and fills the rest from a
declared `WeatherNoDataFill` (the procedural map by default). The source-grid coordinate reference
(node-centred by default, cell-centred when declared) and the no-data semantics live in one module,
`Scene/Weather/WeatherFieldGrid.ts`; the CPU twin is
`Tools/visual-regression/weather-field-bounds.spec.mjs`.

A regional `weatherTexBounds` only becomes the right answer once the map is per-tile rather than one
global equirectangular texture — that is `C13-14`, not this roadmap phase.

## Runtime source-swap architecture

`WeatherProvider` holds the active `WeatherSource` and a registry of available backends
(EDR / WCS-Coverages / STA-METAR / GRIB2-file). Swapping = set the active source + invalidate the
cache; the bake/upload path is identical (all sources emit a normalized `WeatherField` → the one
`WeatherTexPacker`). Expose the choice on the Scene/Globe config facade (and a dropdown in the
Weather Inspector demo) so the user picks the open source at runtime.

## Honest caveats (from adversarial review — do not skip)

- **"In-browser, no server" is only true for Phases 1-2.** Phase 3 (WCS) needs a worker decode;
  Phase 4 (GRIB2/S3) is **not** browser-feasible without a proxy + WASM.
- **NWS-MDL EDR is a prototype** — weak SLA, may vanish. Keep the runner-up (MSC GeoMet) and the
  proxy path ready. Don't build a product on it without a fallback.
- **CORS on the MVP endpoint is unverified** — the single point of failure for "no server." Test a
  browser preflight first.
- **Licensing is not uniform:** NOAA = public domain ✅. MSC GeoMet = OGL-Canada, anonymous ✅.
  ECMWF open-data = CC-BY-4.0 (**attribution mandatory** — carry it in `WeatherField.attribution`);
  full IFS/MARS = paid. **ERA5 is CDS-key-gated + ToS + queued retrieval — not anonymous, not
  browser-fetchable** (defer as an optional server-side deep-history backend).
- **EDR `cube` may return native (large) grids** ignoring requested width/height — resample off the
  render path; verify subsampling or request a coarse bbox.

## Reference pre-registration (2026-08-09)

Seeded from
[`REFERENCE_VISUALS_CATALOG_2026-08-09.md`](REFERENCE_VISUALS_CATALOG_2026-08-09.md),
whose §4 recommends pre-registering references in the plan doc **before** any
implementation batch derives from them, so licence verification is a plan-time
gate rather than a landing-time scramble. This table covers **code/technique
references**; the *data-source* licensing for this roadmap stays in the
"Honest caveats" section above (NOAA PD, MSC GeoMet OGL-Canada, ECMWF
CC-BY-4.0 with mandatory attribution, ERA5 key-gated) and is unchanged.

**Legend:** ✔ = licence file read verbatim this pass; △ = repo-declared only,
**MUST be upgraded to ✔ at intake before any file-level reuse**; STUDY-ONLY =
techniques only, never copy code; UNKNOWN = no reuse until cleared.

| Name | Ecosystem | Licence (as recorded) | Author | What it guides |
|---|---|---|---|---|
| byrd-polar/fluid-earth | WebGL / Svelte | MIT △ | Byrd Polar and Climate Research Center, OSU | **The whole roadmap's backend phases (3-4)** — the only fully-open nullschool-class stack that *includes* the GRIB2/NetCDF → fp16-tile pipeline, mapping straight onto the C2-16 seam and the runtime source-swap architecture. |
| Weacast | Node platform | MIT △ | Kalisio | **Backend phases** — GFS/ARPEGE GRIB2 downloaders, tiling, and a probe API; the closest match to the proxy path this roadmap needs for Phase 4. |
| earth (nullschool) | D3 / Canvas | MIT △ | Cameron Beccario | **Ingest format reference** — the canonical particle wind map; grib2json conventions and projection-aware velocity handling. |
| mapbox/webgl-wind | WebGL | ISC △ | Vladimir Agafonkin / Mapbox | **GPU consumption of the ingested field** — all-GPU particle state in textures (RGBA ping-pong) with trail fading; the cleanest WGSL porting target for the flow-field lanes that consume this pipeline's output. |
| leaflet-velocity | Canvas | **UNKNOWN** — CSIRO variant licence, SPDX NOASSERTION; **no reuse until cleared** | Dan Wild / CSIRO | **Format reference only** — grib2json interpolation conventions. No code moves under UNKNOWN, and it is listed here precisely so a future batch does not assume the usual MIT. |
| WeatherLayers GL | deck.gl | **FILE-COPYLEFT** MPL-2.0, dual-commercial △ — **technique study only, no wholesale copy** | Petr Sloup | Particle/raster/contour/barb layer suite and client-side GeoTIFF decode. MPL carries file-level obligations, so any derived file would inherit them — study the approach, write our own. |
| Advanced Real-Time Volume Graphics (SIGGRAPH 2026 course) | course + samples | Apache-2.0 ✔ (samples; license-identical to the fork) | Zellmann, Sahistan, Wald | Technique authority for the eventual GRIB2/EDR volume renderer (DDA traversal, space skipping, LoD); code is CUDA/OptiX — math reference, not port source |

**Gap the catalog recorded:** most of the rows above are △ repo-declared only.
Each needs its LICENSE file read verbatim (the L-xx determination step, recorded
in [`LICENSE_DETERMINATIONS_2026-08-10.md`](LICENSE_DETERMINATIONS_2026-08-10.md))
**before any code moves** — that read is a prerequisite of the phase that
derives from it, not a landing-time formality.

## Pointers

- Code seam: `packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`
  (`buildProceduralWeatherMap`, `ensureWeatherView`, `WEATHER_TEX_W/H`, `weatherTexBounds` pack),
  `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl` (`worldToWeatherUV`,
  the `wsample.r` reads in `cloudDensity` + `cloudBaseDensity`).
- Related: [WEATHER_RECREATION_ROADMAP.md](WEATHER_RECREATION_ROADMAP.md) (the cloud-side roadmap;
  this doc is the data-ingest half), Batch 405 (METAR/WMO presets), the C2-16 weather-map seam.
- Full research (EDR/CoverageJSON/WCS/STA/sources/decoders, with endpoints + citations): the
  `weather-data-ingest-research` workflow output (run `wf_f9d87c2e`).
