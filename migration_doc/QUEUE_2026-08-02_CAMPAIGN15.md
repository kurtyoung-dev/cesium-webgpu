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

> **SUPERSEDED by R1 (2026-08-06) — annotated 2026-08-07 by the
> docs-reconciliation pass.** The parenthetical above ("Campaigns 11, 12, and 13
> must all complete before Campaign 14 launches") states the **superseded strict
> reading** of O5. Ruling R1 ([`DEFERRED_WORK.md`](DEFERRED_WORK.md),
> §"2026-08-06 - MAINTAINER RULINGS") binds O5's "done" to a **pragmatic bar:
> C12 complete + C13 Gate B green** — Campaign 14 does NOT wait for C11-137
> certification, C13 Gates A/C/D, or the unstarted bodies of either campaign.
> **`C13-GATE-B` CLOSED green at Batch 866 (`58af0d1819`), so the remaining C14
> gate is C12 completion ONLY.** The Campaign-15 numbering the paragraph above
> establishes is UNAFFECTED, and R4's hold on `C15-01+` (start only after C12
> closes) is likewise unaffected.

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

## 6. GSPLAT track — Gaussian splats on WebGPU (maintainer-queued 2026-08-06, ruling R6)

**Maintainer directive (2026-08-06 evening):** queue onto Campaign 15 the work needed
to get Gaussian splats working on the WebGPU backend. Maintainer report: **they do
not work at all today.** This track shares the C15 queue DOCUMENT but is a separate
lane from the aurora theme; the R4 hold on `C15-01..08` (aurora build rows wait for
C12 closure) is UNCHANGED by this addition.

**Known state at queueing time (from `FEATURE_INVENTORY.md` §B + DEFERRED_WORK — the
scoping row must re-verify all of it at HEAD):**

- `WebGPUGaussianSplatRenderer` EXISTS and is probe-verified as a rendering path
  (back-to-front sort consumed via a sorted-index storage buffer, log-depth producer,
  Batch 288) — but **only under `probe-splat-sort.mjs`'s SYNTHETIC `_splatData`**.
- **The root cause on record is `NEW-WEBGPU-SPLAT-DATA-PRODUCER` (C10-04
  STOP-AND-BLOCK, 2026-07-18):** `GaussianSplatPrimitive.update` returns to the WebGPU
  feature renderer BEFORE the WebGL data-commit path runs, and nothing in-tree assigns
  `primitive._splatData` / `_renderResources.splatBuffer` — the renderer is
  SCAFFOLDED-not-SHIPPED for production data. This matches the maintainer's
  'do not work at all'.
- Known adjacent open items that a fix will hit: `NEW-SPLAT-MULTIFRUSTUM-DEPTH-COMPOSE`
  (single-pack command occluded by opaque geometry in multi-frustum scenes),
  `NEW-GS-CLASSIFICATION-DEPTH` (translucent tiles classify against globe-depth, not
  splat-depth), the GPU radix-sort backlog item (BACKLOG-§11), and the upstream
  v1.144-era splat worker pipeline (`gaussianSplatSorter` / `TextureGenerator`
  workers, SPZ loader) whose outputs the WebGPU path must consume without forking
  their formats.

### Ledger

| ID | Task | Size | Status | Depends on |
| --- | --- | --- | --- | --- |
| `C15-G0` | Scoping + root-cause verification: reproduce the production no-render, verify the `NEW-WEBGPU-SPLAT-DATA-PRODUCER` mechanism at HEAD, map the full WebGL splat data path (loader -> workers -> primitive -> renderer) and specify the WebGPU producer design + task breakdown `C15-G1..Gn` with exit gates | M | **COMPLETE — 2026-08-06** (report §6a-§6d below; docs/analysis only, no engine change) | — |
| `C15-G1` | Probe harness + **WebGL reference leg** on the two in-tree splat tilesets. No engine change. | S | **IMPLEMENTATION DONE — 2026-08-07 (worker)**; pending orchestrator landing + Edge run. `probe-gsplat-parity.mjs` + `lib/gsplat-parity-model.mjs` + `gsplat-harness.spec.mjs` (50 checks green). Predictions + the §6a addendum below | `C15-G0` |
| `C15-G2` | Scene-logic extraction: move the FR dispatch below the data commit; split the backend-neutral snapshot pack from the WebGL `Texture` upload | M | **IMPLEMENTATION DONE — 2026-08-07 (worker)**; pending orchestrator landing + Edge run. `GaussianSplatPrimitive.update` split into shared `_updateSplatData` + a DRAW-only branch; read-only `show` accessor proxying `tileset.show`; probe/model/spec updated to a staged absence contract. Decisions + falsifiable predictions in the §6c `C15-G2` block below | `C15-G1` |
| `C15-G3` | Splat record format + WebGPU buffer commit — consume the WASM texture-generator output verbatim; first real WebGPU splat pixels | L | PENDING | `C15-G2` |
| `C15-G4` | Consume the WASM radix sort (`primitive._indexes`) instead of the in-renderer synchronous JS comparator sort | M | PENDING | `C15-G3` |
| `C15-G5` | Spherical harmonics (degree 1-3) in WGSL — the view-dependent colour term the WGSL has **zero** implementation of | L | PENDING | `C15-G3` |
| `C15-G6` | `NEW-SPLAT-MULTIFRUSTUM-DEPTH-COMPOSE` — re-verify against production data (the B647 fix is currently **vacuous** under every probe) | M | PENDING | `C15-G3` |
| `C15-G7` | `NEW-GS-CLASSIFICATION-DEPTH` — re-verify the depth-write variant against production data | S | PENDING | `C15-G3` |
| `C15-G8` | Terminal parity gate + tracker reconciliation | M | PENDING | `C15-G4`, `C15-G5`, `C15-G6`, `C15-G7` |

**`C15-G0` exit gate:** a written scoping report in this section that (a) names the
exact break with file:line evidence at HEAD, (b) confirms or refutes each known-state
bullet above, (c) produces the `C15-G1..Gn` rows sized S/M/L with deps and per-row
falsifiable exit gates (a real .spz/3D-Tiles splat asset rendering on WebGPU with a
WebGL-parity pixel gate is the track's terminal gate), and (d) states what the track
does NOT cover. Priority relative to aurora rows: the maintainer queued gsplats as
wanted-working; the aurora hold (R4) does not apply to this track, so `C15-G*` rows
may execute while `C15-01+` stay held.

---

## 6a. `C15-G0` scoping report — the exact break at HEAD

Verified at `908125d22a` (worktree `wt-gsplat`), 2026-08-06. All line numbers are
HEAD line numbers, re-read this session — not copied from the 2026-07-18 filing.

### The break, in one chain

1. `GaussianSplatPrimitive.update(frameState)` opens at
   `packages/engine/Source/Scene/GaussianSplatPrimitive.js:1186`. Its **first**
   statement resolves the feature renderer
   (`:1189-1192`, `FeatureRendererKey.GAUSSIAN_SPLAT`), and `:1194-1198` is
   `if (fr) { fr.update(this, frameState); this._featureRenderer = fr; return; }`.
   Every line of the WebGL data path — snapshot aggregation (`:1280-1498`),
   `generateSplatTexture` (`:1503`), `radixSortIndexes` (`:1543`),
   `commitSnapshot` (`:407`), `buildGSplatDrawCommand` (`:1967`) — sits **after**
   that return and never executes on WebGPU.
2. The WebGPU renderer's only data read is
   `packages/engine/Source/Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts:1299-1300`:
   `const splatData = primitive._splatData || primitive._renderResources?.splatBuffer;`
   plus `:1301` `const revision = primitive._splatCount ?? 0;`.
3. **All three fields are unassigned everywhere in `packages/`.** Repo-wide greps
   this session: `_splatData` appears only at
   `cesium-js-types.d.ts:1383`, `WebGPUGaussianSplatRenderer.ts:144` (a comment),
   `:713` (a comment) and `:1300` (the read). `_renderResources` appears at
   `cesium-js-types.d.ts:1384` and `:1300` only (the one other hit,
   `Model/ModelPrimitiveGeometry.js:817`, is an unrelated runtime-primitive
   field). `_splatCount` appears at `cesium-js-types.d.ts:1385` and `:1301` only.
   `GaussianSplatPrimitive.js` never mentions any of the three (it has
   `_splatDataGeneration`, a different field).
4. Consequence: `splatData === undefined` → the buffer-build branch at `:1302`
   never fires → `cache.splatBuffer` stays `null`, `cache.splatCount` stays `0`
   → the function returns at `:1359-1361` (`if (cache.splatCount === 0) return;`)
   **before** the sort, the uniform pack, the command build and the
   `commandList.push` at `:1637`. No command is ever produced. This is
   "do not work at all", exactly as the maintainer reported.
5. The only writers of `_splatCount`/`_splatData` in the whole repo are three
   probes that hand-roll a fake primitive object:
   `Tools/visual-regression/probe-splat-sort.mjs:216-233`,
   `probe-splat-globe-occlusion.mjs:119-134`, `probe-oit-transparency.mjs:720`.

**Verdict: the recorded mechanism `NEW-WEBGPU-SPLAT-DATA-PRODUCER` is CONFIRMED
verbatim at HEAD.** The v1.144-era splat churn (SPZ loader, snapshot state
machine, texture hard-cap, SSE budget inflation, SH inverse rotation) landed
entirely on the WebGL side of the `return` and did not move, heal, or worsen the
break. The headline is not a refutation.

### But two things the record does NOT say, and they change the track

**(A) The WebGL path no longer produces anything shaped like `_splatData`.**
The 2026-07-18 filing describes the fix as "pack the loaded snapshot into the
16-float/64-byte interleaved record". That framing is now misleading. At HEAD the
WebGL renderer is **texture-based**: `GaussianSplatTextureGenerator.generateFromAttributes`
(`GaussianSplatPrimitive.js:1936`) hands positions/scales/rotations/colors to the
`gaussianSplatTextureGenerator` worker, which calls the WASM
`generate_splat_texture` (`packages/engine/Source/Workers/gaussianSplatTextureGenerator.js:17-36`).
The WASM returns a `Uint32Array` in which **each splat is exactly 8 uint32
(32 bytes)** — two side-by-side RGBA32UI texels, decoded by
`packages/engine/Source/Shaders/PrimitiveGaussianSplatVS.glsl:152-173`:

| u32 | contents |
| --- | --- |
| 0-2 | `uintBitsToFloat` → model-space position xyz (f32) |
| 3 | unused |
| 4-6 | 3 × `unpackHalf2x16` → the 6 unique symmetric 3D-covariance terms `(Sxx,Sxy,Sxz,Syy,Syz,Szz)` |
| 7 | RGBA8 packed colour |

The WGSL `SplatRecord` (`WebGPUGaussianSplatRenderer.ts:147-153`) is a **different,
larger** layout: 16 × f32 = 64 bytes, `positionHigh(3) + positionLow(3) + covA(3)
+ covB(3) + rgba(4)`. The covariance **semantics** match (`WGSL:278-282` builds
the same symmetric matrix as `GLSL:173`), but no in-tree producer emits the f32
form, and `@cesium/wasm-splats` exports only two entry points —
`generate_splat_texture` and `radix_sort_gaussians_indexes`
(`node_modules/@cesium/wasm-splats/wasm_splats.d.ts`) — neither of which produces
it. So "assign `_splatData`" is not a wiring job: it is either a full CPU repack
(half→f32 expansion + RTE split over every splat, every snapshot, 2× the memory)
or a WGSL format change. The orchestrator's own constraint ("consume the SAME
worker outputs, not fork their formats") selects the latter. See `C15-G3`.

**(B) Both in-tree test assets are spherical-harmonics degree 3, and the WGSL has
no SH implementation whatsoever.** `grep -ci 'sphericalharmonic\|SH_C1\|evaluateSH'
WebGPUGaussianSplatRenderer.ts` = **0**. The WebGL VS evaluates degree-1/2/3 SH
per splat against the model-space view direction
(`PrimitiveGaussianSplatVS.glsl:10-101`, applied at `:189-194`) from a second
`RG32UI` texture. Both `Specs/Data/.../sh_unit_cube/0/0.glb` and
`.../tower/0/0.glb` declare `KHR_gaussian_splatting:SH_DEGREE_3_COEF_*`
attributes, so `GltfSpzLoader.getSpzInfoFromGltf` (`:70-80`) infers `shDegree = 3`
for both. **A WebGL-parity pixel gate on either in-tree asset is therefore
unreachable until SH lands in WGSL** — this is the single largest under-estimate
in the queued track and it gets its own row (`C15-G5`).

---

## 6b. Known-state bullets — confirmed or refuted

| # | Bullet as queued | Standing at HEAD |
| --- | --- | --- |
| 1 | `WebGPUGaussianSplatRenderer` exists and is probe-verified (sorted-index storage buffer, log-depth producer, Batch 288) but only under synthetic `_splatData` | **CONFIRMED.** Sorted-index consumption `WGSL:206-210, 255-258`; log-depth `//>>ifdef LOG_DEPTH` blocks `:212-226, 295-297, 308+` with the near/factor lanes packed at UBO floats 35/39 (`:1450-1451`) — still matches the Batch 288 description exactly. Synthetic-only confirmed (three probes, §6a.5). |
| 2 | Root cause on record is `NEW-WEBGPU-SPLAT-DATA-PRODUCER`: `update` returns to the FR before the WebGL commit; nothing assigns `_splatData`/`_renderResources.splatBuffer` | **CONFIRMED, every clause**, with the two qualifications in §6a(A)/(B) that make the fix bigger than the filing implies. |
| 3 | `NEW-SPLAT-MULTIFRUSTUM-DEPTH-COMPOSE` is an adjacent open item | **OPEN, and the trackers CONTRADICT each other.** `QUEUE_2026-07-06_CAMPAIGN7.md:16` says "✅ LANDED B647"; `DEFERRED_WORK.md:3231` still describes it as open; `FEATURE_INVENTORY.md:616` calls it a "WIP boundary". Code at HEAD: B647 landed `C7-SPLAT-DEPTH-COMPOSE` (`WebGPUGaussianSplatRenderer.ts:1527-1543, 1555-1556, 1586-1589`) which sets `boundingVolume: tileset.boundingSphere` + `modelMatrix: rootTransform` on the command. **That fix is VACUOUS under every existing probe**: `commandBoundingVolume = parityFields._tileset?.boundingSphere` (`:1542`) and the probes' fake primitives have no `_tileset` (`probe-splat-sort.mjs:216-233`, `probe-splat-globe-occlusion.mjs:119-134`), so `boundingVolume` is `undefined` on every frame any probe has ever rendered — and `_backToFrontSplatsComparator` (via `WebGPUSceneRenderer.ts:503-518`) reads `boundingVolume.center`, so the sorter short-circuits too. The fix has never been executed. `C15-G6`. |
| 4 | `NEW-GS-CLASSIFICATION-DEPTH` (translucent tiles classify against globe-depth, not splat-depth) | **OPEN.** The depth-write pipeline variant + `classificationDepthPipeline` plumbing exist (`:59-66, 1559-1568, 1591-1602`) but sit on the same unreachable path — no production splat command has ever carried it. `C15-G7`. |
| 5 | The GPU radix-sort backlog item (BACKLOG §11) | **OPEN and explicitly OUT OF SCOPE for this track.** `WEBGPU_MIGRATION_BACKLOG.md:799` ("Gaussian Splat sort — radix sort on GPU, 2-3 days"). The live defect is the opposite direction: the renderer runs a **synchronous main-thread `Array.prototype.sort` with a JS comparator** (`WebGPUGaussianSplatRenderer.ts:1036-1039`) over a freshly-allocated `Float64Array(count)` (`:1025`), while the WebGL path already has an async WASM radix sort in a worker producing `primitive._indexes`. `C15-G4` consumes the shipped worker; the GPU sort stays deferred. |
| 6 | `C10-04-SPLAT-ASYNC-SORT` (not in the queued bullets, but the sibling STOP-AND-BLOCK) | **BLOCKED-then-DISCHARGED-BY-`C15-G4`.** `WEBGPU_DEBUGGING_LOG.md:971-984`. Its premise ("the sync sort never runs in production") is confirmed; `C15-G4` is the smallest unblock and supersedes it. |
| 7 | The upstream v1.144-era worker pipeline whose outputs WebGPU must consume without forking | **CONFIRMED present and healthy**: `GaussianSplatSorter.js` + `Workers/gaussianSplatSorter.js` (WASM `radix_sort_gaussians_indexes`), `GaussianSplatTextureGenerator.js` + `Workers/gaussianSplatTextureGenerator.js` (WASM `generate_splat_texture`), `GltfSpzLoader.js`, `GaussianSplat3DTileContent.js`. The WASM binary is installed (`node_modules/@cesium/wasm-splats/wasm_splats_bg.wasm`) and copied to `packages/engine/Source/ThirdParty/` + `Build/CesiumUnminified/ThirdParty/` by `gulpfile.js:384-385`. |
| 8 | `NEW-LOG-DEPTH-REMAINING-PRODUCERS-POINTCLOUD-SPLAT` (splat half, Batch 288) | **CONFIRMED still matching its description** — see row 1. No drift. |

### Test-asset situation — an asset-acquisition row is NOT needed

The 2026-07-18 filing lists "no offline `.spz`/glTF-splat asset in-tree" as a
prerequisite. **That is now false.** Two license-clean CesiumGS-shipped tilesets
live in `Specs/Data/Cesium3DTiles/GaussianSplats/`:

| Asset | Splats | SH | Georeferenced | Size | Role |
| --- | ---: | --- | --- | ---: | --- |
| `sh_unit_cube/tileset.json` | 27 | degree 3 | no | 2.7 KB | deterministic first-pixel + SH gate |
| `tower/tileset.json` | 286,868 | degree 3 | yes | 7.5 MB | real-scale terminal parity + perf gate |

Both already drive Jasmine specs (`GaussianSplatPrimitiveSpec.js:24`,
`GaussianSplat3DTileContentSpec.js:19`), and `GaussianSplatPrimitiveSpec` makes a
**real render assertion** on the WebGL backend (non-zero RGB at the canvas centre,
then black after `tileset.show = false`) — so the WebGL reference leg is
credible at HEAD. The dev server statics the repo root (`server.js:535`), so a
Playwright probe reaches them at
`http://localhost:8080/Specs/Data/Cesium3DTiles/GaussianSplats/<name>/tileset.json`
with no network and no Ion token. The remote-Ion Sandcastle demos
(`3d-tiles-gaussian-splatting` asset 3667783, `3d-tiles-gaussian-splats-with-lod`
asset 4547222) are **not** the gate asset.

---

## 6c. `C15-G1..G8` — task breakdown

Common contract for every row: worktree-isolated; workers never commit; WebGL
output must stay byte-identical unless the row says otherwise
(`capture-and-diff` + both `GaussianSplat*Spec` suites green is the standing
off-gate); any new WGSL variant goes through `ShaderDefine`/`ShaderDefineHi` +
`WebGPUShaderPreprocessor` + `WebGPUShaderModuleCache`
(`ShaderSourceId.GAUSSIAN_SPLAT = 36` already exists; the lo-word is full at
bit 30, so new splat axes claim `ShaderDefineHi` bits — 0 and 1 are taken).

### `C15-G1` — probe harness + WebGL reference leg (S) — deps: `C15-G0`

New `Tools/visual-regression/probe-splat-real-asset.mjs`: Edge, loads
`sh_unit_cube` and `tower` from the local dev server, per-backend legs, pinned
clock, same-task capture, canvas-element PNGs, camera framed on
`tileset.boundingSphere`. **No engine change in this row.** This row exists to
de-risk the whole track: if the WebGL leg is red at HEAD, every downstream
parity gate is void and the maintainer must know before `C15-G2` starts.

*Exit gate (falsifiable):* the **WebGL** leg renders both tilesets with
`>= 2%` of canvas pixels non-background at the framed camera, and
`tileset.gaussianSplatPrimitive._numSplats` reads `27` / `286868` respectively;
the **WebGPU** leg on the same run records `_numSplats === 0`, zero
`Pass.GAUSSIAN_SPLATS` commands, and a blank canvas — the documented baseline
the rest of the track is measured against. Both PNGs read by the author.

#### `C15-G1` — IMPLEMENTATION DONE (worker, 2026-08-07) — pending orchestrator landing + Edge run

Shipped, harness-only, **no engine file touched**:

| File | Role |
| --- | --- |
| `Tools/visual-regression/probe-gsplat-parity.mjs` | the browser probe (named for the parity gate it becomes, not for the asset it loads — supersedes the `probe-splat-real-asset.mjs` working title above) |
| `Tools/visual-regression/lib/gsplat-parity-model.mjs` | the pure verdict arithmetic, browser-free and therefore executable by `node --test` |
| `Tools/visual-regression/gsplat-harness.spec.mjs` | 50 checks: 22 rules × the real implementation, 12 mutants each required to be rejected, a meta-test proving the rejection loop can report survival, and CRLF-safe source anchors on the `C15-G0` engine facts |

**The dual-mode contract, which is the row's whole point.** Default mode
certifies today's absence and prints the greppable
`WEBGPU-SPLATS-ABSENT (expected until C15-G3)` while the run stays exit 0 —
but only when the absence is ATTRIBUTABLE to a named, observed blocker; an
unattributed blank canvas exits 3, because "nothing rendered" is also what a
broken probe looks like. `--expect-webgpu` (turned on by `C15-G3`) makes the
same absence exit 1 and hands presence to a cross-backend pixel diff scored
against the `C15-G8` thresholds already recorded here (tower 3%, cube 1%).
The parity leg REFUSES to emit a number when the WebGPU leg showed nothing:
two blank canvases diff to 0.000%, the tightest score the gate can print.
Presence arriving while the probe is still in default mode is also STRUCTURAL,
not a pass — a green run on a stale contract is how a gate stops meaning
anything.

**Design decisions.** Camera derived from `tileset.boundingSphere` only —
`lookAt(center, HeadingPitchRange(0, -30°, max(2.0 × radius, 10 m)))` then
`lookAtTransform(IDENTITY)` to bake the world pose; no hardcoded ECEF anywhere
(the spec forbids `Cartesian3.fromDegrees` in the probe). Globe HIDDEN, not
merely un-imaged: the metric needs a background it can prove blank, and
`sh_unit_cube` is not georeferenced — its bounding volume sits ~87 m from the
geocentre. Splats over a globe are `C15-G6`'s subject. The scored quantity is
pixels the tileset ADDED versus the same settled scene with `tileset.show =
false`, never "non-black pixels", so a widget or a clear-colour change cannot
be mistaken for splats. Readiness is two separate wall-clock budgets — tileset
content (backend-neutral) and splat data commit — and the WebGPU leg's data
budget is DERIVED from what WebGL actually needed (`max(30 s, 4 × webgl
dataReadyMs)`), so the absence claim reads "four times the reference's wall
clock and still nothing" rather than an arbitrary wait.

**Nine structural preconditions**, each independently falsifiable and each
pinned by the spec: `server-reachable`, `tileset-fetch`, `pass-enum-exported`,
`backend-identity`, `tileset-content-readiness`, `camera-framing`,
`capture-liveness`, `background-blank`, `capture-determinism`,
`negative-control-returns`. Two deserve naming:

- **`capture-liveness`** paints the scene a known non-background colour and
  requires the readback to see it. Without it, the fork's historical dead-
  readback trap (`capture-and-diff.mjs`, Batch 227 — solid black post-present
  under `preserveDrawingBuffer: false`) is indistinguishable from "the renderer
  drew nothing", and the probe would file `reference:addedPixels` as a WebGL
  defect that does not exist.
- **`pass-enum-exported`** exists because `frustum.indices[undefined] | 0` is
  `0`: an unexported `Pass` would MANUFACTURE the absence this probe observes.

**Falsifiable predictions at HEAD** (`58af0d1819`, Edge, 1024×768 = 786,432 px,
`sh_unit_cube`, offline viewer, pinned clock `2026-06-01T18:00:00Z`):

*WebGL leg — predicted PASS.* `rendererType=webgl`;
`contentReady=true`; `_numSplats === 27`; `_indexes.length === 27`;
`isStable === true`; binned `Pass.GAUSSIAN_SPLATS` (= **12** at HEAD, not 11)
`>= 1`; added `>= 15,729 px (2.000%)` with `edgeFraction` in `[0.002, 0.95]`
and luminance σ `>= 4`; capture liveness `>= 90%`; hidden-tileset frame
`< 0.100%` foreground; return-to-reference `< 0.100%`; determinism
`< 0.050%`; zero console/device errors. On `tower`, the same shape with
`_numSplats === 286868`.

*WebGPU leg — predicted the ABSENT marker.* `rendererType=webgpu`;
`contentReady=true` (content loading is backend-neutral, so this is NOT where
it breaks); `_numSplats === 0`; `isStable === false`; `_indexes` undefined;
`featureRendererKind === "ready"`; **`cache.splatCount` prints `null`, not
`0`** — see the addendum below; `splatPassCommands === 0`; added
`changed === 0`; `absenceBlockers = [primitive-show-undefined,
no-splat-data-fields, primitive-numsplats-zero]`. Printed line:
`WEBGPU-SPLATS-ABSENT (expected until C15-G3)`. Overall predicted exit **0**.

*Named ways this run can come back other than predicted, and what each means:*

- Added pixels land between ~0.5% and 2.0% → a FRAMING calibration finding
  (`RANGE_SCALE`), not a product defect. The probe prints the measured fraction
  either way; retune and re-run.
- The WebGL leg never reaches `_numSplats > 0` → exit **3** with
  `reference:splat-data-commit`. That is this row's de-risking outcome: the
  WASM splat workers (`gaussianSplatTextureGenerator`, `gaussianSplatSorter`)
  do not resolve under Playwright, every downstream parity gate in `C15-G2..G8`
  is void, and the maintainer must know before `C15-G2` starts.
- `capture-liveness` red → the canvas readback is dead and NOTHING in the run
  is a product verdict.

**Commands for the Edge run** (dev server up: `node server.js` from the repo
root — it statics the repo root, so no Ion token and no network):

```bash
node --test Tools/visual-regression/gsplat-harness.spec.mjs
node Tools/visual-regression/probe-gsplat-parity.mjs
node Tools/visual-regression/probe-gsplat-parity.mjs --asset=tower
PROBE_GSPLAT_WATCHDOG_MS=1200000 node Tools/visual-regression/probe-gsplat-parity.mjs --asset=both
```

Evidence lands in `Tools/visual-regression/output/gsplat-parity/` — per-lane
`-on` / `-off` / `-off-after` / `-capture-liveness` PNGs plus `manifest.json`.

#### §6a addendum — a SECOND, EARLIER blocker the `C15-G0` chain does not name

Found while building this harness, verified at `58af0d1819`, and it changes
`C15-G2`/`C15-G3` scope:

`WebGPUGaussianSplatRenderer.updateWebGPUGaussianSplats` opens with
`if (!primitive.show) { return; }` (`WebGPUGaussianSplatRenderer.ts:1059-1061`)
— **before** it allocates `primitive._webgpuCache` (`:1063`) and roughly 240
lines before the `_splatData` read at `:1299-1300` that §6a records as the
break. **`GaussianSplatPrimitive` defines no `show` member at all**: the class
has `debugShowBoundingVolume` and reads `tileset.show` inside its own WebGL
path, but no `show` accessor and no `this.show =` anywhere. So for a PRODUCTION
primitive `!undefined` is `true` and the renderer exits at its first statement.

Why the record missed it: all three synthetic probes hand-roll `show: true` on
their fake primitive object (`probe-splat-sort.mjs:220`,
`probe-splat-globe-occlusion.mjs:120`, `probe-oit-transparency.mjs:717`), which
is exactly why they reach the data path and production never does.

Consequences, none of which invalidate §6a's verdict — the recorded
`_splatData` break is real, it is just not the FIRST one:

1. §6a step 4's consequence chain ("`splatData === undefined` → ... → returns
   at `:1359-1361`") is never executed either; the function returns ~300 lines
   earlier.
2. `primitive._webgpuCache` is therefore `undefined`, not an allocated cache
   with `splatCount === 0`. Any probe or row that expects to read
   `cache.splatCount === 0` as evidence of the break will read `null` instead.
3. **`C15-G3` cannot be closed by assigning `_splatData` alone** — that would
   still render nothing. The row needs either a `show` member on
   `GaussianSplatPrimitive` (proxying `tileset.show`, which is what the WebGL
   path already gates on at `GaussianSplatPrimitive.js:1207`) or a renderer-side
   change to that guard. Cheapest correct fix is the primitive-side accessor,
   because the WebGL path's own visibility semantics are already `tileset.show`
   and a `show` member keeps the two backends reading one source of truth.
   `C15-G2` is the natural home for it, since it is already moving the
   backend-neutral half of `update` around.

### `C15-G2` — scene-logic extraction (M) — deps: `C15-G1`

Apply the scene-logic-extractor rule to `GaussianSplatPrimitive.update`: the
snapshot build, aggregation, worker dispatch, sort dispatch and commit are
**shared** logic and must run before the backend branch. Two concrete moves:

- Relocate the FR resolve/dispatch from `:1189-1201` to after the data commit,
  so the WebGPU FR is handed a primitive whose `_snapshot` / `_numSplats` /
  `_indexes` are populated.
- Split `processGeneratedSplatTextureData` (`:476-636`): the trim/pad/row-mask
  computation is backend-neutral and stays shared; only
  `createGaussianSplatTexture` / `createSphericalHarmonicsTexture`
  (`:749-794`, which construct the **WebGL** `Texture` class) move behind the
  backend branch. Same for `buildGSplatDrawCommand`'s `VertexArray` /
  `ShaderProgram` / `DrawCommand` construction (`:1967-2168`).

*Exit gate:* on the WebGPU backend with `tower` loaded, a probe reads
`primitive._numSplats === 286868`, `primitive._indexes.length === 286868`,
`primitive._rootTransform` defined, and **zero** WebGL `Texture`/`VertexArray`/
`ShaderProgram` objects created for the splat primitive (assert via a counted
spy or `scene.context` resource stats). WebGL leg from `C15-G1` unchanged within
the probe's noise floor; both `GaussianSplat*Spec` suites green.

#### `C15-G2` — IMPLEMENTATION DONE (worker, 2026-08-07) — pending orchestrator landing + Edge run

Four files, one of them the engine:

| File | Change |
| --- | --- |
| `packages/engine/Source/Scene/GaussianSplatPrimitive.js` | `update()` split; `computeSplatTextureLayout` extracted; `show` accessor; two draw-half gates; `_packedSplatTextureData` retained on the native branch |
| `Tools/visual-regression/lib/gsplat-parity-model.mjs` | `STAGE` (required/retired blockers); `classifyWebgpuPresence` scoped to renderer-owned state |
| `Tools/visual-regression/probe-gsplat-parity.mjs` | stage printed next to what was measured; blocker comments re-anchored; `numSplats` added to the WebGPU line |
| `Tools/visual-regression/gsplat-harness.spec.mjs` | 63 checks (was 50): 4 new rules, 2 new model mutants, the two HEAD anchors INVERTED into C15-G2 predicates, 5 source-mutant rejections, probe-assumption + sort-reachability anchors |

**(a) The `show` decision — a read-only accessor proxying `tileset.show`.**
`get show() { return this._tileset?.show ?? false; }`. Rejected alternatives
and why: a settable own-property (`this.show = true`, the `Cesium3DTileset` /
`Model` convention) would be a SECOND source of truth — the WebGL draw path
gates on `tileset.show` at `_updateSplatData`, so the two backends would then
honour different signals and a caller could hide one and not the other;
deleting the renderer's guard would drop visibility entirely. `PointCloud.js`
was checked and defines no `show` at all, so there is no sibling convention
pulling the other way for a tileset-OWNED primitive. `?? false` rather than
`=== true` so `!primitive.show` and `!tileset.show` agree for every value, not
just booleans. The three synthetic probes are unaffected — they hand-roll
`show: true` on plain object literals, which a prototype accessor cannot reach;
`gsplat-harness.spec.mjs` now pins that they still declare it.

**(b) The neutral/GL boundary, as found.** It is not where the row's plan
guessed. The data pipeline is a single state machine with ~25 early returns,
so "run the neutral part, then branch" could not be done by moving statements;
the body was renamed to `_updateSplatData(frameState)` and `update()` became
resolve → `_updateSplatData` → `if (fr) fr.update(...)`. Every early return
then returns from the shared half and the dispatch is still reached. The three
genuinely GL-coupled points inside that body:

1. `buildGSplatDrawCommand` (WebGL `VertexArray` + `ShaderProgram` +
   `DrawCommand`) — two call sites, both now gated on `_featureRenderer` being
   absent (the `SORTED` branch, and `resolvePendingSnapshotSort`'s async tail).
2. `processGeneratedSplatTextureData`'s `Texture` uploads — the boundary sits
   exactly at `createGaussianSplatTexture`. Everything above it (budget, hard
   cap, attribute truncation, row mask/shift, trim/pad) was extracted to
   `computeSplatTextureLayout` and stays SHARED, deliberately: it is what sets
   `numSplats`, and forking it would make the two backends disagree on the
   count the `C15-G8` parity gate compares.
3. The `_drawCommand` `commandList.push` — left ungated because it is
   structurally unreachable (only `buildGSplatDrawCommand` assigns it), with a
   comment saying so.

`releaseRetiredTextures` is left unconditional: it iterates `_retiredTextures`,
which only `commitSnapshot` fills and only from GL textures, so it is a no-op
on the native path.

**What the WebGPU FR now receives:** a primitive with `_numSplats`, `_indexes`,
`_positions`/`_rotations`/`_scales`/`_colors`, `_shData`, `_rootTransform`,
`_splatRowMask`/`_splatRowShift` populated, plus `_packedSplatTextureData` —
the WASM generator's output verbatim, retained ONLY on the native branch (the
WebGL path already holds those bytes in a `Texture`). It is deliberately NOT
assigned to `_splatData`: that field is the FR's 16-float `SplatRecord` read
and this buffer is the WASM-native 8×u32 layout, so assigning it would draw
garbage rather than splats. **`C15-G2` therefore still draws nothing, for
exactly one remaining reason** — `_splatData` is unassigned, so `cache.splatCount`
stays 0 and the FR returns before its command build. That is `C15-G3`.

**`maybeSortSplats` is structurally unreachable, not newly guarded.** The
synchronous main-thread `Array.prototype.sort` sits at
`WebGPUGaussianSplatRenderer.ts:1383`, AFTER the `cache.splatCount === 0`
return at `:1359`. Since `_splatData` is still unassigned the count stays 0, so
the WebGPU side cannot pay a 286k-element JS sort for data it cannot draw. A
new spec anchor pins that ordering; adding a redundant runtime guard would have
been speculative. `C15-G4` replaces the sort outright.

**(d) The probe contract is now STAGED.** The old rule — "was at least one
known blocker observed?" — would have kept printing the same green marker after
`C15-G2` removed two of the four, for a strictly smaller reason, with nothing in
the log saying so. `STAGE` names both sets and enforces both directions: a
`retired` blocker observed again is `webgpu:blocker-regression` (structural), a
`required` blocker missing is `webgpu:blocker-contract-stale` (structural).
`C15-G3` moves both remaining names into `retired`, which empties `required`
and forces `--expect-webgpu`.

`classifyWebgpuPresence` also had to be re-scoped, and this is the trap this
row would otherwise have walked into: its `dataCommitted` signal read
`numSplats > 0 || cacheSplatCount > 0`. That was correct while the data
pipeline sat below the FR dispatch. It is now SHARED, so `numSplats` reads
286,868 on a WebGPU leg that drew nothing — one positive signal out of three,
i.e. `ambiguous`, i.e. **exit 3 on a healthy engine**. It now reads
`cacheSplatCount` only, the sole remaining renderer-owned signal. A spec mutant
carries the pre-G2 classifier and must be rejected.

*Falsifiable predictions for the Edge run* (`sh_unit_cube` unless noted; the
WebGL leg is predicted UNCHANGED from `C15-G1`'s recorded predictions):

- WebGPU leg: `_numSplats === 27` (`286868` on `tower`) — **was 0**;
  `_indexes.length === 27` — **was undefined**; `isStable === true` — **was
  false**; `dataReady === true` well inside the derived budget — **was false
  after 4× the WebGL wall clock**; `cache.splatCount` prints **`0`, not `null`**
  (the FR now gets past its visibility guard and allocates the cache);
  `splatPassCommands === 0`; `added.changed === 0`;
  `absenceBlockers = [no-splat-data-fields, cache-splat-count-zero]`;
  printed line still `WEBGPU-SPLATS-ABSENT (expected until C15-G3)`; overall
  exit **0**.
- Anything else is diagnosable from the printed stage line: `blockers` still
  containing `primitive-show-undefined` means the accessor did not land;
  containing `primitive-numsplats-zero` means the shared pipeline did not run
  for WebGPU (check that `_updateSplatData` is reached before the dispatch);
  `cache.splatCount` printing `null` means the FR still exits at its first
  statement.
- One-time cost that did not exist before: the WebGPU leg now reaches
  `tryResolveSplatPipelines`, so the splat shader module + pipeline compile
  once on a production splat scene. Expected, not a defect.
- WebGL exit gate for the row: `capture-and-diff` unchanged and both
  `GaussianSplat*Spec` suites green. The WebGL path is argued byte-identical by
  construction (`fr` is `undefined`, so every new gate takes its historical
  branch and `computeSplatTextureLayout` is a pure extraction preserving
  statement order); that argument is what the Edge run + Jasmine suites test.

**Known divergence recorded, not fixed (see DEFERRED_WORK, 2026-08-07):** the
shared budget reads `context.limits.maximumTextureSize`, which is
`MAX_TEXTURE_SIZE` on WebGL (16384 typical) and `maxTextureDimension2D` on
WebGPU (8192 typical). Neither gate asset comes near either cap, but above
~8.4M splats the two backends would truncate to different `numSplats` and the
`C15-G8` gate would be comparing different clouds. `C15-G3` should decide
whether the native branch takes a buffer-shaped budget instead.

### `C15-G3` — splat record format + WebGPU buffer commit (L) — deps: `C15-G2`

The format decision, then the commit. **Recommended: Option B — consume the WASM
`generate_splat_texture` output verbatim.** Change the WGSL group-0 binding 1
from `array<SplatRecord>` (16 f32) to the WASM-native packed layout (8 u32 per
splat) and unpack in the VS with `bitcast<f32>` + `unpack2x16float`, mirroring
`PrimitiveGaussianSplatVS.glsl:153-173` term-for-term. Rationale: it is the
"consume the same worker outputs, don't fork their formats" answer; it halves
GPU memory (32 B vs 64 B per splat — 9.2 MB vs 18.4 MB for `tower`); it makes
the covariance **bit-identical** to WebGL, which is what makes a tight parity
threshold in `C15-G8` achievable at all; and the worker's raw buffer is already
a tight `count * 8` sequence with no row padding
(`GaussianSplatPrimitive.js:489-491` — "the WASM buffer layout is
width-independent"), so `subarray(0, count * 8)` goes straight to
`device.queue.writeBuffer` with **zero** CPU repack.

Option A (repack to the existing 64-byte f32 record) stays recorded as the
fallback if the WGSL unpack proves lossy; it costs a full CPU pass per snapshot
and 2× memory.

**Named decision the row must surface, not silently take:** the WASM layout
stores position as a single f32 vec3, so `positionHigh`/`positionLow` cannot be
recovered from it — the f32 is the data's own precision ceiling. RTE must be
preserved on the **camera** side, which is where it buys precision here: the
renderer already transforms the camera into the primitive's model frame and
encodes it high/low (`WebGPUGaussianSplatRenderer.ts:1401-1404`), and positions
are meter-scale in the `_rootTransform` ENU frame by construction
(`GaussianSplatPrimitive.js:1300-1302, 2139-2146`). The row must set
`positionHigh = <f32 position>`, `positionLow = 0`, keep the
`(pH - camH) + (pL - camL)` cancellation structure intact, and land a rationale
comment at the site. Do not silently drop the RTE lanes.

**Prerequisite added by `C15-G1` (see the §6a addendum) — DISCHARGED by
`C15-G2` (2026-08-07).** The renderer's first statement
`if (!primitive.show) return;` used to fire for every production primitive
because `GaussianSplatPrimitive` had no `show` member. `C15-G2` landed a
read-only `show` accessor proxying `tileset.show`. This row no longer has to
solve it — but it inherits the obligation to prove the flip with
`probe-gsplat-parity.mjs --expect-webgpu`, and to move
`no-splat-data-fields` + `cache-splat-count-zero` from `STAGE.required` into
`STAGE.retired` in `lib/gsplat-parity-model.mjs` (which empties `required` and
makes default mode structurally refuse to certify).

**Also inherited from `C15-G2`:** the WASM generator's packed output is already
retained on the primitive as `_packedSplatTextureData` (native branch only) —
this row's Option B consumes it directly, with no re-plumbing of the producer.

Also in scope: `maybeSortSplats` (`:968-1049`) and `attachSplatVelocityCommand`
(`:1654+`) both read the 16-float stride and must be moved to the new layout (or,
for the sort, superseded by `C15-G4`); the three synthetic probes must be
migrated to the new layout in the same row or they go red.

*Exit gate:* WebGPU renders `sh_unit_cube` — probe asserts
`cache.splatCount === 27`, exactly one `Pass.GAUSSIAN_SPLATS` command in the
command list, `>= 2%` non-background canvas pixels at the framed camera, zero
device/validation errors. **Negative control:** with `tileset.show = false` the
canvas returns to background. `probe-splat-sort.mjs` and
`probe-splat-globe-occlusion.mjs` still pass on the migrated layout. A
`node --test` CPU spec proves the JS-side pack and the WGSL-side unpack agree on
a known `(scale, rotation)` triple against the GLSL reference decode.

### `C15-G4` — consume the WASM radix sort (M) — deps: `C15-G3`

Replace the synchronous main-thread comparator sort
(`WebGPUGaussianSplatRenderer.ts:1013-1041`) with `primitive._indexes`, the
permutation the shipped `GaussianSplatSorter.radixSortIndexes` WASM worker
already produces for the WebGL path (`GaussianSplatPrimitive.js:1543, 1601,
1635`; resolved into `_indexes` at `:728` / `:677`). This is the
`C10-04-SPLAT-ASYNC-SORT` unblock. Keep `cache.sortRequestPending` and the
view-angle throttle as the demand signal; the WebGPU leg uploads the worker's
result to `sortedIndexBuffer` rather than computing its own.

*Exit gate:* on `tower` (286,868 splats) at a settled camera, a probe records
**zero** calls into the in-renderer comparator sort (instrument or delete the
path) and `sortedIndexBuffer` contents equal to `primitive._indexes` element-for-
element on the sample frame; longest main-thread task during a 60-frame orbit is
**below** the pre-row measurement taken in the same run (interleaved A/B, not
across builds). Back-to-front correctness preserved: `probe-splat-sort.mjs`
still asserts the non-identity permutation.

### `C15-G5` — spherical harmonics degree 1-3 in WGSL (L) — deps: `C15-G3`

Port `evaluateSH` / `loadSHCoeff` / `halfToVec3`
(`PrimitiveGaussianSplatVS.glsl:10-101`) to WGSL with the same `SH_C1/SH_C2/SH_C3`
constants and the same `inverse(computedTransform × axisCorrection ×
worldTransform)` model-space view direction (`GaussianSplatPrimitive.js:1310-1326`
computes `_shInverseRotation`; the WGSL UBO must carry it). The packed SH payload
is the same `RG32UI` half-float pair layout the WebGL texture uses
(`GaussianSplatPrimitive.js:584-628`) and reaches the primitive as
`snapshot.shData` — consume it as a storage buffer, do not re-derive it. Gate the
whole block behind a new `ShaderDefineHi` bit (`HAS_SPHERICAL_HARMONICS`, next
free hi-word index) so `shDegree === 0` content compiles the historical
`//>>else` path byte-identical.

*Exit gate:* on `sh_unit_cube` at **three** camera azimuths 120° apart, WebGPU-vs-
WebGL mismatch is below the `C15-G8` threshold at each. **Vacuity control
(mandatory):** the SH-off leg (define bit cleared) must differ from the SH-on leg
by more than that threshold at at least two of the three azimuths — otherwise the
gate is not measuring SH and the row does not certify. Degree-0 content path
proven byte-identical by a shader-source hash comparison against the pre-row
module.

### `C15-G6` — multifrustum compose, re-verified against production data (M) — deps: `C15-G3`

`NEW-SPLAT-MULTIFRUSTUM-DEPTH-COMPOSE` has never been observed with a real
tileset, and the B647 `C7-SPLAT-DEPTH-COMPOSE` fix that was supposed to close it
has **never executed** (§6b row 3 — no probe primitive has a `_tileset`, so
`boundingVolume` is always `undefined` at `:1542`). This row re-opens the
question with data that can actually reach the code.

*Exit gate:* with `tower` at a far nadir camera over a settled globe (`>= 2`
active frustums, asserted from `frustumCommands`), the splat cloud composes over
the globe — non-background splat-coloured pixels present, and WebGL-vs-WebGPU
occlusion topology agrees (same pixels occluded on both). **Negative control:**
suppressing `command.boundingVolume` reproduces the historical mis-binning
(`indices[GAUSSIAN_SPLATS]` populated in every frustum band). If the compose is
still broken with `boundingVolume` set, the row's deliverable is the per-frustum
UBO re-pack described in `DEFERRED_WORK.md:3231`, re-gated the same way. Update
all three contradicting trackers to one status.

### `C15-G7` — classification depth, re-verified against production data (S) — deps: `C15-G3`

`NEW-GS-CLASSIFICATION-DEPTH`: confirm the `classificationDepthPipeline`
swap (`:1559-1568, 1591-1602`) fires when `Cesium3DTile.update` sets
`depthForTranslucentClassification` on a real splat-pass command.

*Exit gate:* a classification polygon draped over `tower` lands on the splat
surface, not on the terrain behind it, on both backends; probe asserts the
depth-write pipeline was actually selected on the frame measured (counter, not
inference). **Negative control:** forcing `classificationDepthPipeline = null`
puts the polygon back on the terrain.

### `C15-G8` — terminal parity gate + tracker reconciliation (M) — deps: `C15-G4`, `C15-G5`, `C15-G6`, `C15-G7`

*Exit gate (the track's terminal gate):*
`Specs/Data/Cesium3DTiles/GaussianSplats/tower/tileset.json` — 286,868 real
SPZ-compressed, SH-degree-3 splats, served locally — renders on the WebGPU
backend with a WebGL-vs-WebGPU canvas mismatch **below 3%** at the framed camera
and at two orbit positions, zero device/validation errors, PNGs read by the
author. `sh_unit_cube` holds below **1%** (27 splats, no terrain, no streaming —
the tight leg). Both legs captured in the same run with a pinned clock.
**Vacuity control:** an intentionally corrupted covariance term must push the
`tower` mismatch above 3%, proving the gate can fail.

Reconciliation shipped in the same row: `DEFERRED_WORK.md` (close
`NEW-WEBGPU-SPLAT-DATA-PRODUCER`, resolve the `NEW-SPLAT-MULTIFRUSTUM-DEPTH-COMPOSE`
contradiction at `:3231`, close/redirect `C10-04-SPLAT-ASYNC-SORT`),
`FEATURE_INVENTORY.md:616` (splat line moves from "SCAFFOLDED-not-SHIPPED for
production" to SHIPPED, or to §C with the exact residual),
`WEBGPU_DEBUGGING_LOG.md` (batch entry), `DEBUGGING_GUIDE.md` (the new probe
joins the inventory), and the `QUEUE_2026-07-06_CAMPAIGN7.md:16` "LANDED B647"
row annotated with the vacuity finding.

---

## 6d. Non-goals — what this track does NOT cover

- **GPU/compute radix sort for splats** (`WEBGPU_MIGRATION_BACKLOG.md:799`).
  `C15-G4` consumes the existing WASM worker; a GPU sort stays deferred.
- **Remote / Ion / iTwin splat assets.** The gate is the in-tree tilesets only.
  The Sandcastle demos keep their Ion asset IDs and are not gated.
- **Per-splat feature IDs, metadata picking, or per-splat styling.** Pick stays
  primitive-granularity on both backends (`WebGPUGaussianSplatRenderer.ts:191-195`).
- **Splat LOD, streaming, or budget policy beyond WebGL parity.** The SSE
  inflation + texture hard cap (`GaussianSplatPrimitive.js:497-533, 1088-1101`)
  are consumed as-is, not redesigned.
- **The deprecated `KHR_spz_gaussian_splats_compression` extension** — upstream
  already emits a deprecation warning (`GaussianSplat3DTileContent.js:142-152`).
- **2D / Columbus View splat rendering.** 3D only.
- **TAA velocity / motion vectors for splats beyond keeping the C10-09 leg
  alive** through the `C15-G3` layout change. Animated splat clouds are out.
- **Any change to WebGL splat visual output.** WebGL is the reference; every row
  carries a byte-identical-off gate.
- **The aurora rows `C15-01..08`**, which remain HELD under ruling R4 and are
  unaffected by this track in either direction.

