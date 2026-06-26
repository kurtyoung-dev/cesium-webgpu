# Weather Data Ingest Roadmap — real weather → the cloud renderer (C2-16 seam)

**Status:** PLANNING (research + design complete, 2026-06-26). No code yet.
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

## Pointers

- Code seam: `packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`
  (`buildProceduralWeatherMap`, `ensureWeatherView`, `WEATHER_TEX_W/H`, `weatherTexBounds` pack),
  `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl` (`worldToWeatherUV`,
  the `wsample.r` reads in `cloudDensity` + `cloudBaseDensity`).
- Related: [WEATHER_RECREATION_ROADMAP.md](WEATHER_RECREATION_ROADMAP.md) (the cloud-side roadmap;
  this doc is the data-ingest half), Batch 405 (METAR/WMO presets), the C2-16 weather-map seam.
- Full research (EDR/CoverageJSON/WCS/STA/sources/decoders, with endpoints + citations): the
  `weather-data-ingest-research` workflow output (run `wf_f9d87c2e`).
