# Campaign 15 — Aurora + Space Weather

Prepared: 2026-08-02. Live-feed claims spot-checked against the real endpoints
2026-08-06 under maintainer ruling **R4** — see §2a.

Status: **PLANNED / RESEARCH-VERIFIED / IMPLEMENTATION NOT STARTED.** `C15-00`
is complete; `C15-01` through `C15-08` are pending and **HELD** by ruling R4
until Campaign 12 closes. This queue is **not a maintainer launch ruling**.

> **Evidence provenance.** Everything in §2 was authored 2026-08-02 from
> documentation and was explicitly flagged as unverifiable from the tree. On
> 2026-08-06 every endpoint was fetched and every schema read byte-for-byte
> (§2a). §2 now records **measured** contracts. Where the 2026-08-02 authoring
> was wrong, the row says so and §2a quotes the real response. Do not
> re-paraphrase §2 back into assumptions — the distinction between measured and
> assumed is the whole point of that section.

Campaign-number correction: Dynamic Ocean & Wind already owns the ratified
**Campaign 14** identity and its O5 hold (Campaigns 11, 12, and 13 must all
complete before Campaign 14 launches). This queue therefore assigns Aurora +
Space Weather to **Campaign 15**. It does not rename, launch, or relax Campaign
14. The Phase-F seed remains `EPIC-AURORA-SPACE-WEATHER` in
[`DEFERRED_WORK.md`](DEFERRED_WORK.md), with design context in
[`ATMOSPHERIC_EFFECTS_ROADMAP.md`](ATMOSPHERIC_EFFECTS_ROADMAP.md) Phase F.

---

## 1. Theme and immutable contracts

Build northern **and** southern aurora that remain physically legible from the
ground, across the limb, and from orbit; permit deterministic manual storms;
then add optional live space-weather inputs without making rendering depend on
the network.

The following contracts are load-bearing:

- The effect is an analytic, ellipsoid-relative **layered emission volume over
  an overall 80–600 km shell**, not a sky-dome texture or a screen-space decal.
  Its line components have separate altitude profiles: the 427.8 nm nitrogen
  contribution owns the lower edge, 557.7 nm oxygen owns the dominant green
  middle layer (source-supported approximately 100–250 km), and 630.0 nm
  oxygen owns the diffuse red upper layer (approximately 200–500 km, with the
  analytic shell bounded at 600 km). The shell bound is not a claim that a
  typical display fills every altitude.
- Geometry and sampling are camera-relative/RTE and ellipsoid-aware. The same
  backend-neutral density/emission definition feeds WebGL and WebGPU; neither
  backend gets a reduced visual feature set.
- WMM2025's **centered dipole**, not the magnetic dip pole, is the coordinate
  baseline: 9.21° from Earth's rotation axis; north geomagnetic pole
  **80.79°N geocentric (80.85°N geodetic), 72.76°W** at epoch 2025.0. The
  synthetic oval is non-circular, noon/midnight asymmetric, and changes with
  activity. A geographic-latitude ring is not an acceptable fallback.
- Darkness is evaluated at the **auroral shell sample or its ellipsoid
  footprint** using local solar elevation. A camera-local star-fade scalar is
  wrong when the camera is in orbit or the volume spans the terminator. Shared
  sky-brightness/night thresholds may inform the transfer curve, but not the
  location at which it is evaluated.
- Manual/synthetic state ships before network ingest. Renderer input is a
  normalized, provenance-carrying state packet so manual, recorded, and live
  sources are interchangeable and deterministic under the scene clock.
- Live OVATION owns spatial extent and intensity. Because OVATION already uses
  L1 solar-wind/IMF inputs and can fall back to Kp, live OVATION output must
  **not** be multiplied again by Kp or Bz. Kp/Bz drive synthetic/fallback state
  or diagnostics, not a second forcing term on an active OVATION grid.
- GOES X-ray flare state is a separate **solar-flare** channel. It does not
  instantly expand or brighten the geomagnetic auroral oval; any later
  flare-to-CME-to-storm forecast coupling needs its own time-of-flight model.
- Default OFF means zero aurora passes, allocations, background jobs,
  animation requests, network requests, GPU uploads, and bind-group churn.
  Enabling the effect must not remove any existing atmosphere, bloom, cloud,
  terrain, RTE, or renderer functionality.

---

## 2. Verified research and official sources

| Subject | Verified contract | Official source |
|---|---|---|
| WMM2025 | **VERIFIED 2026-08-06** against NCEI's *Wandering of the Geomagnetic Poles* page (the WMM product page itself was not re-fetched in this pass), verbatim: "80.85°N geodetic latitude", "80.79°N geocentric", "72.76°W", and "The axis of the dipole is currently inclined at 9.21° to Earth's rotation axis." Valid 2025–2030. Do not confuse this with the distinct magnetic dip pole (the empirically-surveyed location where the field is vertical to the ellipsoid). | [NCEI World Magnetic Model](https://www.ncei.noaa.gov/products/world-magnetic-model); [NCEI Wandering of the Geomagnetic Poles](https://www.ncei.noaa.gov/products/wandering-geomagnetic-poles) |
| Aurora extent and colour | **VERIFIED 2026-08-06**, verbatim from SWPC: "The aurora typically forms 80 to 500 km above Earth's surface." (The SWPC page carries no per-line altitude breakdown; the 427.8/557.7/630.0 nm split below rests on the NASA references, not on SWPC.) NOAA describes aurora as typically 80–500 km; NASA places green oxygen near 100–200/250 km and red oxygen above 200 km. Campaign 15 uses a bounded 80–600 km analytic volume with separate line profiles so the upper red tail is not clipped into one homogeneous slab. | [NOAA SWPC Aurora](https://www.spaceweather.gov/phenomena/aurora); [NASA Auroras](https://science.nasa.gov/sun/auroras/); [NASA red/green altitude reference](https://www.nasa.gov/image-article/red-green-aurora-australis/) |
| OVATION | **MEASURED 2026-08-06.** Top level is an object with **five** keys — `Observation Time`, `Forecast Time`, `Data Format`, `coordinates`, **`type`** (`"MultiPoint"`; the 2026-08-02 authoring missed `type`). `coordinates` is exactly **65,160** `[longitude, latitude, aurora]` integer triples on a 360×181 one-degree grid, longitude **0–359**, latitude **−90…+90**. Ordering is **longitude-major**: index = `lon * 181 + (lat + 90)`. Values are integers; the measured range in the quiet sample was **0–16**, with 17,805 of 65,160 cells non-zero. **The unit is OWED, not measured** — the payload declares only `"Data Format": "[Longitude, Latitude, Aurora]"`, and the product page says an "estimate of aurora viewing probability can be derived" without stating the encoding. Do not assume a 0–100 percentage until a storm-period sample or an official statement pins the ceiling. The snapshot is mutable and the forecast lead is **variable, not a fixed 30–90 min** — the measured sample had a 94-minute lead. The model is JHU/APL's OVATION Prime; when L1 inputs are unavailable it falls back to Kp with no forecast lead. | [SWPC Aurora 30-Minute Forecast](https://www.spaceweather.gov/products/aurora-30-minute-forecast); [latest OVATION JSON](https://services.swpc.noaa.gov/json/ovation_aurora_latest.json) |
| Planetary Kp | **MEASURED 2026-08-06 — authoring CONFIRMED exactly.** Array of 56 objects `{time_tag, Kp, a_running, station_count}`; `time_tag` string, the other three numeric. 56 rows = 7 days × 8 three-hour bins, ascending. **Case trap:** the *observed* product spells the field `Kp`, the separate *forecast* product (`noaa-planetary-k-index-forecast.json`) spells it `kp` and adds `observed`/`noaa_scale`. Consumers select the newest valid timestamp and treat staleness explicitly. | [planetary K-index JSON](https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json); [NWS Service Change Notice 26-21](https://www.weather.gov/media/notification/pdf_2026/scn26-21_Data_Format_Changes_Impacting_SWPC_Products.pdf) |
| Real-time solar wind | **MEASURED 2026-08-06. Removal CONFIRMED** — every `/products/solar-wind/*.json` path returns HTTP 404, and SCN 26-21 dates it "on or about April 30, 2026" (the notice also removes `solar-wind/ephemerides.json`, whose replacement is `rtsw_ephemerides_1h.json`, **not** `_1m`, which 404s). Replacements are arrays of objects at **1-minute cadence for the active source**, but three corrections to the authoring: **(a) rows are in DESCENDING time order** (newest first; 0 ascending deltas across 3,696/3,727 rows) — a naive "reject time regressions" rule discards the whole feed; **(b)** every timestamp appears **once per satellite**, so consumers must filter `active === true` before reading cadence; **(c)** the active source's `max_data_flag` is the **fill value `-9999`** on 100% of active magnetometer rows, so a "flag must be 0" gate rejects everything — gate on `overall_quality` instead. Plasma names are `proton_density`, `proton_speed`, `proton_temperature`; magnetic input carries `bt`, `bx/by/bz_gse`, `bx/by/bz_gsm`, `theta_gsm`, `phi_gsm`. No 3-day/7-day product exists, so those horizons must be accumulated locally from the one-day stream. | [RTSW magnetometer JSON](https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json); [RTSW wind JSON](https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json); [RTSW ephemerides JSON](https://services.swpc.noaa.gov/json/rtsw/rtsw_ephemerides_1h.json); [NWS Service Change Notice 26-21](https://www.weather.gov/media/notification/pdf_2026/scn26-21_Data_Format_Changes_Impacting_SWPC_Products.pdf) |
| Solar-wind source satellites | **MEASURED 2026-08-06 — the constellation is not the DSCOVR/ACE pair the epic's framing assumed.** The 24-hour window contains exactly three sources: **`SOLAR1` (the sole `active: true` source), `IMAP`, and `ACE`** (both present but inactive/standby). **`DSCOVR` does not appear at all.** Never hard-code a satellite name; read `source` and `active` per row. | [RTSW wind JSON](https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json); [NWS Service Change Notice 26-21](https://www.weather.gov/media/notification/pdf_2026/scn26-21_Data_Format_Changes_Impacting_SWPC_Products.pdf) |
| GOES X-rays | **MEASURED 2026-08-06.** Array of objects `{time_tag, satellite, flux, observed_flux, electron_correction, electron_contaminaton, energy}`. The two passbands `"0.1-0.8nm"` and `"0.05-0.4nm"` are **interleaved in one array** (1,438 rows each in the 1-day file), so a consumer must split on `energy`. Three corrections: **(a)** the order is **ASCENDING** — the opposite of the RTSW feeds, so one shared "newest row" helper cannot serve both; **(b)** there is **no `flux_quality_flag`** field; **(c)** the contamination field is misspelled **`electron_contaminaton`** in the payload — spelling it correctly yields `undefined`. `satellite` is numeric (18 measured) and matches `instrument-sources.json` → `xrays.primary`; never hard-code it. Dropouts occur during calibration and satellite eclipse seasons. | [SWPC GOES X-ray Flux](https://www.spaceweather.gov/products/goes-x-ray-flux); [primary 1-day X-ray JSON](https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json); [instrument-source mapping](https://services.swpc.noaa.gov/json/goes/instrument-sources.json) |
| Transport (all SWPC feeds) | **MEASURED 2026-08-06.** All feeds serve `Access-Control-Allow-Origin: *` and `Cache-Control: max-age=60`, so browser `fetch` works without a proxy and polling faster than 60 s is wasted. gzip is supported and decisive: `rtsw_wind_1m.json` is 2,755,551 B identity but **92,874 B gzipped (29.7×)**; `ovation_aurora_latest.json` is 919,304 B identity but **143,391 B gzipped (6.4×)**. Budget ingest on the compressed figures. Note `www.swpc.noaa.gov` now 301-redirects to `www.spaceweather.gov`. | [OVATION JSON](https://services.swpc.noaa.gov/json/ovation_aurora_latest.json); [RTSW wind JSON](https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json) |
| Data-use boundary | **VERIFIED 2026-08-06**, verbatim: "The information on National Weather Service (NWS) Web pages are in the public domain, unless specifically noted otherwise, and may be used without charge for any lawful purpose so long as you do not: 1) claim it is your own …, 2) use it in a manner that implies an endorsement or affiliation with NOAA/NWS, or 3) modify its content and then present it as official government material." Those three conditions are operative, not boilerplate: a re-projected OVATION grid **is** modified content, so it must not be presented as official government material. The general rule is still not a substitute for product-level provenance — OVATION Prime is an **empirical model "developed at the Johns Hopkins University, Applied Physics Laboratory by Patrick Newell and co-workers"** (SWPC's own product page), so the public-domain status of the SWPC *output* is not a licence claim over the *model*. No downloaded snapshot enters the bundle until its exact source, transformation, attribution, and terms are recorded in `LICENSE.md`. | [NWS disclaimer](https://www.weather.gov/disclaimer/); [SWPC Aurora 30-Minute Forecast](https://www.spaceweather.gov/products/aurora-30-minute-forecast) |
| Kyoto Dst | **VERIFIED 2026-08-06 — the exclusion stands and the authoring understated one obligation.** WDC Kyoto states verbatim: "The data and services at the WDC Kyoto are available for scientific use without restrictions, but for the real-time (quicklook) data, please contact our staff … before using those in publications and presentations." and, decisively, **"The WDC Kyoto does not allow commercial applications of the geomagnetic indices."** Additionally, and **not recorded in the 2026-08-02 authoring**: "when using the AE index, Dst index, and ASY/SYM indices, please include data DOIs in the Reference section." SWPC does mirror the index at `products/kyoto-dst.json` (live; reformatted to `{time_tag, dst}` objects by SCN 26-21) — that mirror is a live temptation and it **does not erase the source restrictions**. Campaign 15 therefore keeps **no built-in Kyoto provider and no bundled Dst snapshot**; a caller may supply a numeric Dst override and owns its provenance/rights. | [WDC Kyoto Data Usage Rules](https://wdc.kugi.kyoto-u.ac.jp/wdc/Sec3.html) |

Feed contracts are versioned inputs, not implementation trivia. Adapters must
validate schema and finite ranges; key caches by source + observation/forecast
time; **normalize row order first, then** reject time regressions (the RTSW
feeds ship newest-first, so an un-normalized regression check rejects them
wholesale — see §2a); expose source, age, forecast lead, active/quality
state, and fallback reason; abort requests on provider change/destroy; apply
bounded retry/backoff; and keep parse/conversion/upload outside the render hot
path. A malformed or stale feed falls back to last-valid-within-policy or the
manual/synthetic driver, never to an unlabelled storm.

---

## 2a. Verification record — 2026-08-06 (maintainer ruling R4)

`C15-00`'s own exit gate asked for attributable live-feed claims, and the
2026-08-02 authoring could not satisfy it from the tree. Ruling R4 ordered the
spot-check. Every URL below was **fetched**; every schema below was read from
the **response bytes**, not from documentation. Sample records are quoted
literally. Nothing here is inferred.

**Per-endpoint verdicts.**

| Endpoint | HTTP | Bytes | Verdict |
|---|---|---|---|
| `products/noaa-planetary-k-index.json` | 200 | 4,326 | **VERIFIED** — schema matches the authoring exactly |
| `json/ovation_aurora_latest.json` | 200 | 919,266 | **CORRECTED** — 65,160 triples confirmed; `type` key and grid ordering were unrecorded |
| `json/rtsw/rtsw_mag_1m.json` | 200 | 1,559,871 | **CORRECTED** — descending order, per-satellite rows, `-9999` fill |
| `json/rtsw/rtsw_wind_1m.json` | 200 | 2,756,281 | **CORRECTED** — as above; `proton_*` names confirmed |
| `json/goes/primary/xrays-1-day.json` | 200 | 656,181 | **CORRECTED** — ascending order, interleaved bands, field misspelling |
| `json/goes/instrument-sources.json` | 200 | 393 | **VERIFIED** — mapping is live and agrees with the payload's `satellite` |
| `products/solar-wind/*.json` (6 probed) | **404** | 196 | **VERIFIED REMOVED** — the 2026-04-30 claim is confirmed, not refuted |
| `json/rtsw/rtsw_ephemerides_1m.json` | **404** | 196 | **REFUTED NAME** — the replacement is `_1h`, which returns 200 (735,580 B) |
| SCN 26-21 PDF | 200 | 54,549 | **VERIFIED** — real document, read in full; see quotations below |

**Quoted responses.** Kp, first element verbatim:

```json
{ "time_tag": "2026-07-31T00:00:00", "Kp": 1.33, "a_running": 5, "station_count": 8 }
```

OVATION, all non-coordinate keys plus the first and last triple verbatim:

```json
{ "Observation Time": "2026-08-07T01:21:00Z", "Forecast Time": "2026-08-07T02:55:00Z",
  "Data Format": "[Longitude, Latitude, Aurora]", "type": "MultiPoint" }
coordinates.length === 65160
coordinates[0]     === [0, -90, 2]
coordinates[1]     === [0, -89, 0]
coordinates[180]   === [0,  90, 0]
coordinates[181]   === [1, -90, 0]
coordinates[65159] === [359, 90, 0]
```

The `[180] → [181]` step is the proof of longitude-major ordering: latitude
runs −90…+90 within a fixed longitude, then longitude increments. 360 unique
longitudes × 181 unique latitudes = 65,160 = the array length exactly, so the
grid is complete with no missing or duplicated cells.

RTSW magnetometer, newest row verbatim (note `active: false` on the *first*
row — the newest row is not necessarily the operational one):

```json
{ "time_tag": "2026-08-07T01:24:02", "active": false, "source": "IMAP",
  "range": null, "scale": null, "sensitivity": null, "manual_mode": false,
  "sample_size": 60, "bt": 2.72, "bx_gse": -2.17, "by_gse": 1.54, "bz_gse": -0.54,
  "theta_gse": -11.46, "phi_gse": 144.69, "bx_gsm": -2.17, "by_gsm": 1.43,
  "bz_gsm": -0.78, "theta_gsm": -16.76, "phi_gsm": 146.68,
  "max_telemetry_flag": 0, "max_data_flag": 0, "overall_quality": 0 }
```

RTSW wind, newest row verbatim (all `alpha_*` null for this source):

```json
{ "time_tag": "2026-08-07T01:24:00", "active": true, "source": "SOLAR1",
  "proton_speed": 276.9, "proton_temperature": 24034, "proton_density": 3.09,
  "proton_vx_gse": -276.1, "proton_vy_gse": -3, "proton_vz_gse": -20.6,
  "proton_vx_gsm": -276.1, "proton_vy_gsm": -6.4, "proton_vz_gsm": -19.8,
  "proton_sample_size": 1, "alpha_speed": null, "alpha_density": null,
  "max_convergence_flag": 0, "max_data_flag": 0, "max_error_count_flag": 0,
  "max_processing_flag": 0, "max_range_flag": 0, "max_sample_count_flag": 0,
  "max_telemetry_flag": 0, "overall_quality": 0 }
```

RTSW tallies over the full 24-hour window (this is the evidence for the three
corrections in §2):

| Feed | rows | source × active | time deltas | active-row gaps |
|---|---|---|---|---|
| mag | 3,696 | `SOLAR1/true` 1,437, `ACE/false` 1,273, `IMAP/false` 986 | **desc 2,422 / asc 0** / equal 1,273 | 60 s × 1,436 |
| wind | 3,727 | `SOLAR1/true` 1,424, `ACE/false` 1,327, `IMAP/false` 976 | **desc 2,410 / asc 0** / equal 1,316 | 60 s × 1,411, 120 s × 11, 180 s × 1 |

`overall_quality` was `0` on 100% of rows in both feeds. `max_data_flag` was
`-9999` on 2,710 of 3,696 magnetometer rows — **including every `SOLAR1` active
row** — and `0` on all wind rows. The wind gaps (11 × 120 s, 1 × 180 s) are real
data gaps and are the fixture C15-06's gap handling should be built against.

GOES X-rays, first and last rows verbatim (ascending; both bands present):

```json
{ "time_tag": "2026-08-06T01:28:00Z", "satellite": 18, "flux": 9.999999717180685e-10,
  "observed_flux": 3.73501718442526e-9, "electron_correction": 5.170252670438913e-9,
  "electron_contaminaton": true, "energy": "0.05-0.4nm" }
{ "time_tag": "2026-08-07T01:25:00Z", "satellite": 18, "flux": 2.578931912466942e-7,
  "observed_flux": 2.7673144131767913e-7, "electron_correction": 1.8838271387267014e-8,
  "electron_contaminaton": false, "energy": "0.1-0.8nm" }
```

2,876 rows = 1,438 per band; `satellite` was `18` on every row; time deltas were
ascending 1,437 / descending 0.

`instrument-sources.json` in full (393 bytes — it is an **array of one object**,
not an object):

```json
[{ "time_tag": "2026-07-29T18:29:11Z", "date": "2026-07-29T18:29:11.000+00:00",
   "electrons": {"secondary": 18, "primary": 19}, "protons": {"secondary": 19, "primary": 18},
   "alphas": {"secondary": 18, "primary": 19}, "magnetometers": {"secondary": 18, "primary": 19},
   "xrays": {"secondary": 19, "primary": 18}, "suvi": {"secondary": 18, "primary": 19},
   "euvs": {"secondary": 18, "primary": 19} }]
```

`xrays.primary === 18` matches the `satellite: 18` in the primary X-ray payload,
and the secondary X-ray feed returned `satellite: 19` — so the mapping is live
and self-consistent. The per-instrument primary/secondary split is **not
uniform** (X-rays and protons are primary-18; everything else is primary-19), so
one global "primary GOES number" is wrong by construction.

**SCN 26-21, quoted.** The PDF is real (`%PDF-1.6`, 54,549 B, 3 pages, from
"Clinton Wallace, Director, Space Weather Prediction Center", dated "115 PM EST
Mon Mar 2 2026"). It carries **two** dates, and the authoring recorded only one:

- Format restructure — "Effective on or about **March 31, 2026**" — covering
  `kyoto-dst.json`, `10cm-flux-30-day.json`, `noaa-planetary-k-index.json`, and
  `noaa-planetary-k-index-forecast.json`, moving "from a format where the first
  entry contains the keys and the subsequent entries contain the corresponding
  values, to a standard JSON object format". This is the change that produced
  the Kp object schema in §2, and it is dated March, not April.
- RTSW removal — "Effective on or about **April 30, 2026**". This is the
  2026-04-30 date the authoring recorded, and the 404s confirm it executed.

The notice also documents the field mapping verbatim: "`density` users will need
to use `proton_density`, `speed` will map to `proton_speed`, and `temperature`
maps to `proton_temperature`"; and for the magnetometer, "`lon_gsm` users will
need to use `phi_gsm`, `lat_gsm` will map to `theta_bsm`". **`theta_bsm` is a
typo in the notice** — the field measured in the live payload is `theta_gsm`.
Trust the payload, not the notice, on that name.

Finally, the notice's own words on history retention: "To support the updated
cadence, 3-day and 7-day users must retrieve and retain the 1-day file." The
authoring's rendering of this was correct.

**Traps a future implementer must not rediscover the hard way.**

1. **Time ordering is inconsistent across the campaign's own feeds.** RTSW is
   descending, GOES and Kp are ascending. `arr[0]` is the newest row in RTSW and
   the *oldest* in GOES. There is no shared "latest row" helper unless it sorts.
2. **`time_tag` timezone marking is inconsistent.** RTSW and Kp emit
   `"2026-08-07T01:24:00"` with **no `Z` and no offset**; OVATION and GOES emit
   `"…Z"`. Per ECMAScript, a date-time string without an offset is parsed as
   **local time**, so `Date.parse` on an RTSW tag is wrong by the host's UTC
   offset. Append `Z` explicitly before parsing RTSW and Kp tags.
3. **Quality gating.** Gate on `overall_quality`, not on `max_*_flag`; `-9999`
   is a "not reported" fill, not a failure, and it is present on every active
   magnetometer row.
4. **Field-name spelling.** `electron_contaminaton` (GOES, missing an `i`) and
   the `Kp`/`kp` case split between the observed and forecast Kp products.

**Not verified here / owed.** Ground-truth for the per-line altitude profiles
(427.8 / 557.7 / 630.0 nm) still rests on the NASA references cited in §2, which
were not re-fetched in this pass; the SWPC aurora page carries no spectral
breakdown. The flux unit for GOES X-rays (conventionally W/m²) is **not stated
in the payload** and the product page did not state it plainly either — treat it
as owed before any flare-class threshold is hard-coded. Likewise the **OVATION
`Aurora` value unit**: only the 0–16 quiet-sample range was measured, so the
0–100-percent reading remains an assumption and needs a storm-period sample or
an official statement before `C15-05` normalizes against a fixed ceiling.

---

## 3. Queue ledger

| ID | Work | Priority | Status | Depends on |
|---|---|---:|---|---|
| `C15-00` | Correct campaign identity; verify science, live schemas, lifecycle, and data-use constraints; freeze this queue | P0 | **COMPLETE — 2026-08-02 (documentation/research only); live-feed claims MEASURED 2026-08-06 under ruling R4, §2 corrected, exit gate now genuinely met (see §2a)** | — |
| `C15-01` | Backend-neutral aurora/space-weather state packet and deterministic manual driver | P0 | PENDING — **HELD (R4) until C12 closes** | `C15-00` |
| `C15-02` | WMM2025 geomagnetic coordinates and synthetic activity-dependent oval | P0 | PENDING — **HELD (R4)** | `C15-01` |
| `C15-03` | Shared layered density/emission kernel, local-night gate, and RTE shell contract | P0 | PENDING — **HELD (R4)** | `C15-02` |
| `C15-04` | WebGL + WebGPU shell renderers, visibility demand, and feature-preserving performance tiers | P0 | PENDING — **HELD (R4)** | `C15-03` |
| `C15-05` | OVATION + planetary-Kp asynchronous ingest and source-authority policy | P1 | PENDING — **HELD (R4)**; schemas now measured, §2a grid ordering is the spec | `C15-01`, `C15-02` |
| `C15-06` | New RTSW + GOES asynchronous ingest with separate geomagnetic and flare state | P1 | PENDING — **HELD (R4)**; brief corrected for descending RTSW order + `-9999` fill | `C15-01`, `C15-05` authority contract |
| `C15-07` | `effects.aurora` facade, demo, diagnostics, accessibility, attribution/licensing closure | P1 | PENDING — **HELD (R4)** | `C15-04`, `C15-05`, `C15-06` |
| `C15-08` | Cross-backend visual, RTE, lifecycle, off-contract, and moving-performance certification | R0 | PENDING — **HELD (R4)** | `C15-01..07` |

---

## 4. Task briefs and exit gates

### C15-00 — Research and queue lock — COMPLETE

- Resolve the campaign-number collision without editing Campaign 14's identity
  or O5 status.
- Replace the old “not researched” language in the live Phase-F/deferred docs
  with this verified contract and link every live tracker to this queue.
- Record exact official URLs and lifecycle breaks. In particular, ban the
  deprecated pre-2026 solar-wind endpoints and disqualify Kyoto Dst from a
  built-in/bundled path.

Exit: this queue and its cross-links exist; claims in §2 are attributable to
official sources; implementation remains explicitly unstarted.

**Exit-gate closure, 2026-08-06 (ruling R4).** The "attributable to official
sources" clause was satisfied only by citation at authoring, not by measurement,
and the audit was right to flag it. It is now satisfied by measurement: all six
named endpoints returned 200 and were parsed, the six probed legacy paths
returned 404, and SCN 26-21 was read in full. §2a is the record. **One authored
name was refuted** (`rtsw_ephemerides_1m.json` does not exist; the replacement is
`_1h`), **three schemas were materially incomplete** (OVATION `type` key and grid
ordering; RTSW descending order, per-satellite rows and `-9999` fill; GOES
ascending order, interleaved bands and the `electron_contaminaton` misspelling),
and **one date was missing** (the March 31 format restructure alongside the
recorded April 30 removal). Nothing in the section was found to be fabricated,
and the two claims the audit doubted most — the 2026-04-30 legacy removal and
the 65,160-point OVATION grid — both held exactly.

### C15-01 — Neutral state + manual driver

Define a versioned packet with at least source/provenance, observed/forecast
times, age/freshness, activity scalar, optional oval field, optional solar-wind
diagnostics, and a separate solar-flare state. Define deterministic manual
quiet/moderate/severe presets and a continuous override. The renderers consume
only this packet, never network payloads.

Exit: pure-Node mutation tests reject malformed versions, nonfinite/range-invalid
values, stale regressions, and accidental coupling of flare state into the
geomagnetic scalar; no network is needed to produce every visual state.

### C15-02 — Geomagnetic frame + synthetic oval

Implement the WMM2025 centered-dipole transform from the stated 2025.0 pole,
including both hemispheres. Generate a non-circular oval with local magnetic
time/noon-midnight asymmetry and activity-dependent equatorward expansion;
curtain direction follows the same dipole field. WMM's five-year epoch must be
explicit and replaceable rather than hidden in shader constants.

Exit: CPU reference vectors and mutation tests distinguish geomagnetic from
geographic latitude, geocentric from geodetic pole values, north from south,
and quiet from storm geometry. There is no full-IGRF requirement for v1.

### C15-03 — Shared layered emission kernel

Specify one backend-neutral kernel for analytic ellipsoid-shell intersection,
RTE coordinates, oval density, separate 427.8/557.7/630.0 nm altitude profiles,
curtain/ray morphology, emissive integration, and local solar-elevation gating
at each sample or footprint. Keep intensity energy-bounded under step-count and
quality changes.

Exit: GLSL/WGSL twins are source/contract locked; ground, terminator, limb, and
orbital CPU fixtures agree; a mutation replacing the local night evaluation
with camera-local fade fails; the 80–600 km bounds and line ordering are pinned.

### C15-04 — Both renderers + performance architecture

Integrate depth-tested, additive/unlit shell draws into both backends. Cull on
frustum/shell intersection and night/oval demand before allocating or encoding;
reuse immutable noise/lookup resources where valid, keep backend GPU objects
backend-owned, and build pipelines/resources asynchronously. Quality tiers may
change bounded sample density and reconstruction, never remove hemispheres,
line layers, RTE, local night, or depth behavior.

Exit: default-OFF is byte-identical and has zero passes/allocations/jobs/
animation/uploads; enabled scenes show the same structures from ground and
orbit on both backends; no private submission or per-frame resource creation;
moving-camera Node/Edge altitude-route evidence reports CPU/GPU/frame cost.

### C15-05 — OVATION + Kp ingest

Parse the current object-form Kp feed and the latest OVATION snapshot off the
render hot path. Normalize OVATION's 0–359° grid with seam/pole tests and carry
observation/forecast timestamps.

**Measured constraints (§2a) — build against these, not against assumptions.**
The OVATION grid is longitude-major, `index = lon * 181 + (lat + 90)`, 360×181 =
65,160 complete cells, values integer. The antimeridian seam is between `lon 359`
and `lon 0` (not at ±180), and each pole appears **360 times** — once per
longitude — so a pole test must check that all 360 duplicates agree or define
which one wins. Forecast lead is variable (94 min measured), so never assume 30
min from the product's name; read `Forecast Time` − `Observation Time`. Kp's
field is capital `Kp` in the observed product and lowercase `kp` in the forecast
product. Authority is explicit:

- valid live OVATION owns oval position/intensity;
- Kp may drive manual/synthetic/fallback oval state when OVATION is absent or
  stale, and may remain visible as a diagnostic;
- Kp or Bz never multiplies an active OVATION field.

Exit: frozen-fixture, schema-mutation, staleness, abort/reissue, antimeridian,
pole, and OVATION-vs-Kp non-double-count tests pass; request/parse/upload does
not occur during command execution.

### C15-06 — RTSW + GOES ingest

Consume only the replacement `rtsw_mag_1m.json` and `rtsw_wind_1m.json` feeds.
Select valid active-source rows, preserve source and quality diagnostics, map
the renamed proton fields and `bz_gsm`, and maintain any requested history
locally because old 3-/7-day products are gone. Consume GOES primary X-rays
with instrument-source discovery and separate flare classification/state.

**Measured corrections (§2a) — the authoring's premises were wrong here.**

- **RTSW rows arrive newest-first (descending).** The original "reject time
  regressions" instruction, applied literally, discards the entire feed. The
  correct rule is: sort or reverse on ingest, then reject regressions *within the
  normalized series*. GOES is **ascending**, so the two adapters cannot share an
  unsorted "latest row" accessor.
- **Every timestamp appears once per satellite** (`SOLAR1`, `IMAP`, `ACE`), so
  `active === true` filtering precedes any cadence or gap reasoning. Only after
  filtering is the cadence a clean 60 s.
- **`max_data_flag: -9999` is a fill value, not a fault**, and it is present on
  100% of active magnetometer rows. Gate on `overall_quality`.
- **`DSCOVR` is absent from the constellation**; do not name satellites in code.
- **RTSW `time_tag` carries no `Z`** — append it before `Date.parse`, or every
  timestamp is off by the host's UTC offset.
- **`electron_contaminaton`** is the GOES payload's spelling.
- The SCN's `theta_bsm` is a typo; the live field is `theta_gsm`.

Exit: source handoff, inactive/bad-quality rows, gaps, **descending-order
normalization**, out-of-order time within the normalized series,
calibration/eclipse dropout, retry/backoff, provider replacement, and destroy
are mutation-tested. A fixture must cover the measured wind gaps (11 × 120 s,
1 × 180 s in the sampled day) and a `-9999` fill row that must **not** be
rejected. Solar-wind diagnostics do not double-force OVATION and a GOES flare
alone does not mutate the auroral oval.

### C15-07 — Facade, demo, diagnostics, and rights

Add `atmosphericConditions.effects.aurora`/`effects.auto` integration following
the shipped A–E hierarchy, with explicit manual/live selection and diagnostics
for source, freshness, forecast lead, quality, and fallback. Add a new-format
Sandcastle gallery demo with northern/southern, ground/orbit, quiet/severe,
synthetic/live, and stale/off controls. Include reduced-motion/accessibility
controls for rapid curtain animation.

No asset or snapshot is bundled until `LICENSE.md` names its files, exact
source, transformation, attribution, and product-specific terms. Kyoto Dst is
not offered as a provider; a raw user-owned numeric override is the only Dst
seam.

Exit: facade round-trip and auto/manual precedence tests pass; the demo works
offline; off state is zero-demand; required attributions are present without
claiming NOAA/JHU licensing that the official product pages do not grant.

### C15-08 — Certification

Certify with pinned clocks and deterministic manual fixtures first, followed by
recorded feed fixtures and an optional live-feed lane. Use isolated component
differences, point/structure/connected-component metrics, and limb geometry;
never use a band mean for a faint sparse additive signal. Include northern and
southern ground views, terminator span, orbit/limb, activity expansion, all
three line layers, terrain/globe occlusion, camera motion, device/context loss,
provider replacement, request abort, stale data, and both renderers.

Exit: WebGL/WebGPU structure and intensity parity are within re-derived bounds;
RTE remains stable across globe-scale motion; no offscreen/night-ineligible
work is encoded; default OFF remains byte-identical/zero-cost; moving-route
performance is reported without deleting or default-disabling features.

---

## 5. Execution order and campaign boundaries

The implementation order is `C15-01 → C15-02 → C15-03 → C15-04`, then the
data lanes `C15-05 → C15-06`, followed by `C15-07 → C15-08`. The synthetic
renderer is therefore useful and certifiable before any network provider.

Campaign 15 is independent of atmospheric T/Td/RH ingest, but it may not
duplicate Campaign 12's shared sky-brightness work or Campaign 13's generic
weather-tile ownership. It also grants no authority to start Campaign 14:
Dynamic Ocean & Wind remains separately planned and blocked by O5.
