# Campaign 15 — Aurora + Space Weather

Prepared: 2026-08-02. Live-feed claims spot-checked against the real endpoints
2026-08-06 under maintainer ruling **R4** — see §2a.

Status: **THIS DOCUMENT CARRIES TWO INDEPENDENT LANES WITH DIFFERENT STATES.
Read the lane you are working, never the document as a whole.** *(Rescoped
2026-08-09, handover audit FIX 23 — the block previously read a single unscoped
"PLANNED / RESEARCH-VERIFIED / IMPLEMENTATION NOT STARTED", which is true of the
aurora lane and **false** of the gsplat lane, where five rows had landed.)*

- **Aurora lane (`C15-01`..`C15-08`, §4): PLANNED / RESEARCH-VERIFIED /
  IMPLEMENTATION NOT STARTED.** `C15-00` is complete (research + queue lock; the
  R4 endpoint spot-check executed 2026-08-06, §2a). `C15-01` through `C15-08`
  are pending and **HELD** by ruling **R4** until Campaign 12 closes. **This
  queue is not a maintainer launch ruling for these rows.**
- **GSPLAT lane (`C15-G0`..`C15-G8`, §6): ACTIVE — maintainer-queued 2026-08-06
  under ruling R6, and explicitly NOT under the R4 hold.** `C15-G0` scoping
  COMPLETE (Batch 863); **`C15-G1`..`C15-G5` LANDED, Batches 868–895**
  (harness/WebGL reference → scene-logic extraction → first real WebGPU splat
  pixels → WASM radix sort → spherical harmonics); **`C15-G6` PARTIAL** —
  mechanism fixed at Batch 888/889, the row's written exit gate has not executed
  and the multi-frustum leg is owed; **`C15-G7` and `C15-G8` PENDING** (G8's
  prerequisite instrument landed at CO-12 and first ran at Batch 916).
  Remaining-row dispatch order: see the §6 dispatch paragraph.

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

## 2b. Reference pre-registration (2026-08-09)

Seeded from
[`REFERENCE_VISUALS_CATALOG_2026-08-09.md`](REFERENCE_VISUALS_CATALOG_2026-08-09.md),
whose §4 recommends pre-registering references in the campaign doc **before**
any implementation batch derives from them, so licence verification is a
plan-time gate rather than a landing-time scramble. Nothing in §2/§2a or the §3
ledger changes; this section adds the reference half both lanes were missing.

**Legend:** ✔ = licence file read verbatim this pass; △ = repo-declared only,
**MUST be upgraded to ✔ at intake before any file-level reuse**; STUDY-ONLY =
techniques only, never copy code.

### Aurora lane (`C15-01..08`)

| Name | Ecosystem | Licence (as recorded) | Author | What it guides |
|---|---|---|---|---|
| olawlor/AuroraRendererUnity | Unity + WebGL | **Unlicense** (public domain) △ | Lawlor & Genetti (UAF) | `C15-02` synthetic oval and `C15-03` layered emission kernel — the GPU aurora volume-rendering paper implemented by its own authors, with a live WebGL demo. **Dormancy note: the project is dormant (2016-2019 era)**, so it is a licensed anchor for the physics and the vertical emission profile (557.7 nm green / red tops) and the curtain footprints, not a maintained dependency. |

**The honest gap, recorded so it is not rediscovered later:** the catalog's §3
states that **both licensed aurora references are dormant and no modern WebGPU
aurora implementation exists anywhere**. `C15-03`/`C15-04` are therefore
**first-of-kind** — there is no contemporary reference renderer to diff against,
which raises the burden on `C15-08`'s own certification rather than lowering it.
Plan the acceptance evidence accordingly: the gate cannot lean on "matches the
reference implementation" because there is no reference implementation.

### GSPLAT lane (§6, `C15-G1..G8`)

**The catalog found ZERO vetted gsplat references.** Its §3 records the gap
verbatim: the gsplat ecosystem (antimatter15/splat, mkkellogg/GaussianSplats3D,
PlayCanvas supersplat, and the research implementations) "needs its own
dedicated license-verification pass before `C15-G3`/`C15-G5` derive from
anything external."

**That vetting pass was `C18-S0`**
([`QUEUE_2026-08-09_CAMPAIGN18.md`](QUEUE_2026-08-09_CAMPAIGN18.md) §4) — a
documentation/licence row with no engine change, deliberately **not** gated by
`C15-G8` so it could run early. **It RAN on 2026-08-09**; the full record —
20 vetted projects, the Inria provenance-chain verdict per candidate, honest
gaps, and a recommendation per row — is
[`GSPLAT_REFERENCE_VETTING_2026-08-09.md`](GSPLAT_REFERENCE_VETTING_2026-08-09.md).
It did **not** hand the G-track a borrowable reference, and that is the finding:
**every G-track row remains implement-from-technique only** under the house norm
— no external file is copied, each derivation site carries a `Reference:` block,
and each source gets a numbered L-xx determination in
[`LICENSE_DETERMINATIONS_2026-08-10.md`](LICENSE_DETERMINATIONS_2026-08-10.md).

**The gsplat ecosystem's licence shape, in one line:** the reference
implementation (`graphdeco-inria/gaussian-splatting`), its CUDA rasterizer
(`diff-gaussian-rasterization`), and the two research follow-ups most relevant to
this fork (`mip-splatting`, `StopThePop`) all carry the **Inria/MPII
"Gaussian-Splatting License"** — "research and/or evaluation purposes only",
no right to sublicense, restriction propagating to derivatives. That is
irreconcilable with an Apache-2.0 engine. The browser/engine implementations
(antimatter15, mkkellogg, gsplat.js, PlayCanvas, Spark) are permissive but are
paper-derived re-implementations with nothing the G-track needs.

**What `C15-G3`/`C15-G5` actually touched, retrospectively cleared.** Both rows
have landed, and their external surface was two projects that were **already
licence-determined before this pass ran**: `@cesium/wasm-splats` (Apache-2.0,
`L-22b`) for the radix sort and SH texture generation, and `@spz-loader/core`
(Apache-2.0, `L-22a`) for SPZ decoding. Neither derived from an unvetted project.
The asset side is likewise clean — §6b's two CesiumGS-shipped gate tilesets,
not externally trained scenes.

| Name | Ecosystem | Licence (as recorded) | Author | What it guides |
|---|---|---|---|---|
| KHR_gaussian_splatting (glTF extension) | Khronos spec | **CC-BY-4.0** ✔ `Copyright 2026 The Khronos Group Inc.`; status **Release Candidate** | Khronos; contributors incl. Sean Lilley (Cesium), Niantic Spatial, Esri, Nvidia | `C15-G3` record format — the **format** authority. A documentation licence, not a code licence: implementing a specification from its normative prose raises no code-licence question. |
| `@cesium/wasm-splats` (CesiumGS/cesium-wasm-utils) | Rust → WASM | **Apache-2.0** △ (host-declared, `LICENSE.md`) — already determined as `L-22b` | Cesium GS | `C15-G4` sort order and `C15-G5` SH texture generation. Already a shipped `packages/engine` dependency; the notice obligation is discharged. |
| `@spz-loader/core` (drumath2237/spz-loader) | WASM (Emscripten wrap of nianticlabs/spz) | **Apache-2.0** △ (host-declared, `LICENSE.txt`) — already determined as `L-22a`; wrapped project `nianticlabs/spz` is **MIT** ✔ `Copyright (c) 2024 Niantic Labs` | Ryosuke Nomura; Niantic Labs | SPZ decoding. Already a shipped dependency. |
| graphdeco-inria/gaussian-splatting + diff-gaussian-rasterization — **STRUCK, research-only** | research | **Gaussian-Splatting License** (Inria + MPII) ✔ | Kerbl, Kopanas, Leimkühler, Drettakis | **Never copy, never transliterate, never port.** Listed so the boundary is on the record; the published paper is the only permitted route to any technique it contains. |

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
| `C15-06P` | Attributed, located solar-prominence state provider for eclipse composition; never infer image-plane location from GOES flux | P1 overlay | PENDING — **HELD (R4)**; exact data owner for the Eclipse Explorer follow-up | `C15-01`, `C15-06`; `CLT-C3P` owns prominence geometry/rendering and the satisfied `CLT-C4` seam supplies landed HDR/bloom/exposure composition |
| `C15-07` | `effects.aurora` facade, demo, diagnostics, accessibility, attribution/licensing closure | P1 | PENDING — **HELD (R4)** | `C15-04`, `C15-05`, `C15-06` |
| `C15-07H` | Immutable historical eclipse/space-weather replay provider and provenance manifest | P1 overlay | PENDING — **HELD (R4)**; exact owner for the Fairbanks co-event replay | `C15-01`, `C15-05`, `C15-06`, `C15-07` |
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

### C15-06P — Located solar-prominence provider overlay

Define a deterministic manual/historical prominence state whose source can
carry an attributed observation time plus explicit solar-disc or limb
coordinates. This is a state/data owner only: `CLT-C3` owns the corona shape;
`CLT-C3P` owns prominence geometry/rendering and consumes the eclipse contact
geometry for occultation; and the satisfied `CLT-C4` seam supplies the landed
HDR/bloom/exposure composition chain. GOES X-ray flux may identify flare timing
or aggregate energy but has no image-plane longitude and must never invent a
prominence location or visible radiance. An unlocated flare remains
diagnostic-only and pixel-identical unless
`NEW-VISIBLE-LIGHT-SOLAR-FLARE-PHOTOMETRIC-TRANSFER` supplies a separately
attributed, calibrated spectral transfer and located input.

Exit: quiet, located-prominence, unlocated-flare, and combined fixtures remain
independent; provenance and coordinate frames are exact; disc occultation can
reveal/hide a located feature without moving it; deleting the prominence packet
does not alter flare/aurora state; and a mutant deriving limb position from
GOES flux is rejected.

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

### C15-07H — Historical eclipse/space-weather replay overlay

Add immutable, attributed historical providers that feed the same normalized
`C15-01` packet as manual and live sources, without a network dependency. The
first pinned co-event is the 2025-03-14 Fairbanks-area total lunar eclipse plus
the independently photographed auroral activity. This is coincidence, not
causation: an eclipse flag cannot synthesize aurora, and a solar flare cannot
be treated as an immediate geomagnetic storm.

Exit: a source/transform/licence manifest binds every frozen byte; event,
observation, and forecast clocks remain distinct; offline replay is byte
stable; removing either the eclipse or space-weather packet removes only its
own phenomenon; quiet-time, wrong-location, both-hemisphere, freshness,
attribution, and default-OFF controls pass. `C15-08` must include this overlay
once implemented.

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
data lanes `C15-05 → C15-06`, followed by `C15-07 → C15-08`. The optional
but now explicitly owned eclipse riders enter as `C15-06P` after the neutral
and flare state exists, and `C15-07H` after provider/facade provenance exists;
both are folded into `C15-08` when present. These rider IDs assign execution
ownership without launching or relaxing R4's hold on the ratified core rows.
The synthetic renderer is therefore useful and certifiable before any network
provider.

Campaign 15 is independent of atmospheric T/Td/RH ingest, but it may not
duplicate Campaign 12's shared sky-brightness work or Campaign 13's generic
weather-tile ownership. It also grants no authority to start Campaign 14:
Dynamic Ocean & Wind remains separately planned and blocked by ~~O5~~ **R1**.

> ⚠ **O5 IS SUPERSEDED — re-bound 2026-08-06 by maintainer ruling `R1`
> (`DEFERRED_WORK.md` RULING-2026-08-06); annotated here 2026-08-09, handover
> audit FIX 27.** The strict O5 form ("C14 waits for Campaigns 11 **and** 12
> **and** 13 to all be done") no longer holds. **R1 sets a pragmatic bar: C12
> complete + C13 Gate B green.** C13 **Gate B CLOSED at Batch 866**, so the only
> remaining C14 precondition is **C12 completion** — which, per `R-2026-08-10-1`,
> is the MAXIMAL C12 gate. `C13-41` / C12-29 S3 is REOPENED per
> `R-2026-08-14-1`, with its machine state vacated from `closed` to `reopened`
> by `R-2026-08-17-7`, and therefore still holds that maximal C12 gate. S4
> remains COMPLETE / EDGE VERIFIED 2026-08-12; S5 and the remaining C12 exit
> tail still hold that gate. C11-137 certification stays
> HELD and C11/C13 remain honestly open (R2); neither blocks C14 any more. This
> sentence's *intent* — Campaign 15 grants no authority to start Campaign 14 —
> is unchanged.

## 6. GSPLAT track — Gaussian splats on WebGPU (maintainer-queued 2026-08-06, ruling R6)

**DISPATCH ORDER for the remaining rows** *(added 2026-08-09, handover audit FIX 25 — the order was recoverable only from a dispatch plan a successor had no reason to open).* The remaining-row order lives in [`CLOSEOUT_PLAN_2026-08-07.md`](CLOSEOUT_PLAN_2026-08-07.md) **Lane D**, and that plan is a **dispatch grouping only — these rows remain the sole status authority**. The order is: **(1) machine-first `C15-G7`** (classification-depth re-verify — unblocked now); **(2) the tower frame-variance investigation** (`C15-G9`, BRANCH B confirmed; it blocks the tower leg of `C15-G8`, and **do NOT widen the mutant-pinned 0.050% bar** to get past it); **(3) the `C15-G6` multi-frustum leg** (needs a tower+globe multi-frustum scene — worker prep DISCHARGED Batch 1157; machine run owed); **(4) `C15-G8` terminal gate LAST**, which also formally closes `NEW-WEBGPU-SPLAT-DATA-PRODUCER` and `C10-04-SPLAT-ASYNC-SORT` and triggers the splat-demo re-audit (demo wave 2 hold). **`CO-12` decoded:** the close-out plan's label for the *parity-probe extension* worker batch — the three-azimuth/orbit lanes, the SH-off vacuity control and the corrupted-covariance control that `C15-G8`'s own gate text requires before it can gate honestly; it also carried `NEW-SPLAT-PENDING-WORK-DRAWCOMMAND-PROXY`, `NEW-SPLAT-OIT-FALLBACK-UNUSABLE` and `NEW-WEBGPU-COLLECTION-PASS-LITERAL-DRIFT`. CO-12's instrument landed 2026-08-07 and first ran at Batch 916 (see immediately below).

### EXTENDED-LANES FIRST RUN — run at tip `25adfbd27d` (the **Batch 915** tip), **recorded at Batch 916** (`052b5f7865`) — G5's vacuity caveat DISCHARGED on the cube; tower's new controls are blocked by the KNOWN variance class

*(Header disambiguated 2026-08-09, handover audit FIX 27: the original read "2026-08-07, tip `25adfbd27d`, Batch 916", which invited reading `25adfbd27d` as Batch 916's own commit. It is not — `25adfbd27d` is Batch 915 and the run's recording commit is `052b5f7865` = Batch 916. Order by batch number.)*

First run of the CO-12 lanes (three azimuths, SH-off vacuity, corrupted covariance), exit 3 with the split read honestly:

- **sh_unit_cube — every new control GREEN.** SH-OFF restored the cross-backend mismatch to **2.534/2.519/2.520%** at the three azimuths (predicted ~2.574% recorded pre-G5; gate >= 1% at >= 2 of 3) with 17.2-17.4% vs the SH-on frame — **the C15-G5 SH term is proven NON-VACUOUS and its substituted-evidence caveat is DISCHARGED.** COV-CTRL: single corrupted triple 1.980% (floor 0.5%, derived per-splat footprint 0.709%), bulk 33.358% (floor 1%), both reversible. Azimuth parity **0.000% at all three azimuths** vs the 1% threshold — recorded, armed at G8.
- **tower — azimuth parity 0.017/0.020/0.018% vs the 3% threshold (excellent), but ALL THREE control legs went STRUCTURAL on the SAME mechanism**: restorations measured 0.062%/0.056% and capture-determinism 0.055% (431 px WebGPU / 389 px WebGL on the neg-ctrl leg) against the mutant-pinned 0.050% bar — this is `C15-GSPLAT-TOWER-FRAME-VARIANCE`, now measured on BOTH backends (the entry previously recorded WebGPU as the more deterministic side). No probe defect; the bar does not widen; the tower variance investigation remains the gate on G8's tower leg and now ALSO gates the control restorations.
- G8 arming status: cube side fully armed (azimuths + both vacuity controls live and proven falsifiable); tower side armed for parity but its determinism preconditions stay structural until the variance class is understood BY MECHANISM.

### G5 ACCEPTANCE — COLOR RESIDUAL ELIMINATED (2026-08-07, Batch 895)

On tip `2a950208cb` (rebuild): **sh_unit_cube mismatch 2.574% → 0.000%** (prediction was 0.35%; the two-sided red-flag band at <0.05% is answered by tower reading a NONZERO 0.017% — the instrument distinguishes the legs, so the cube zero is genuine byte-level convergence), SH live and self-reporting (`enabled=true degree=3 shWords=810` cube / `8,606,040` tower, both exactly as computed), WebGPU added% converged to WebGL's 19.141%, exit 0. **tower mismatch 0.017%** against its 3% threshold; its exit 3 is solely the filed `C15-GSPLAT-TOWER-FRAME-VARIANCE` WebGL reference class, untouched by G5. Bookkeeping owed to `C15-G8`: the probe's parity stage still prints the G3-era "recorded, not gated" text — the formal per-asset threshold re-arm (1%/3% as GATES) is the terminal row's flip, and the measured numbers already sit two orders inside them.

### STAGE CLOSURE — G3 COMPLETE, four-instrument acceptance GREEN (2026-08-07, Batch 889)

The G3 stage (first WebGPU splat pixels: decode + commit + footprint + depth composition) closed on tip `09c67d0100` with all four splat instruments green on one build: **occlusion** exit 0 — `greenPaintedOverGlobe` 2724 → **0**, `numFrustums` 2 → **1** (the derived bounding volumes stopped widening the scene span; the live frustum is now a tight [6000, 11862] m), `redPainted` 33,689 in the pre-registered band with the flagged rise as the back-to-front sorter went live, P3 positive control 3,026; **parity `--expect-webgpu`** exit 0 — 27/27 committed, 19.037% added (predicted ~18.995%), `WEBGPU-SPLATS-PRESENT`, cross-backend mismatch ~2.574% recorded as the C15-G5 SH baseline; **sort** exit 0; **oit** exit 0. Chain of custody: G0 scoping (863) → G1 harness (868) → G2 dispatch restructure (878, confirmed 880) → G3 decode/commit (881) → G3b readiness+footprint (882) → G3c/d instrument repairs (883/884) → G6e encode exoneration (885) → G6f pass refutation + P3 (886) → G6g baked-triples conviction (887) → G6h B647-completion fix (888). Every engine change was arithmetic-proven or measurement-driven; six orchestrator/worker hypotheses were refuted by instruments along the way. **Remaining rows to the terminal gate:** `C15-G4` (WASM radix sort — required for `tower` at 286,868 splats; the JS sorter now actually runs, making G4 more urgent, not less), `C15-G5` (spherical harmonics degree 1–3 in WGSL — closes the recorded 2.574% color residual and re-arms the 1% parity gate), `C15-G7` (classification depth re-verify), `C15-G8` (terminal parity gate + tracker reconciliation, with count-equality asserted before pixels per the Batch-878 finding).


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
| `C15-G1` | Probe harness + **WebGL reference leg** on the two in-tree splat tilesets. No engine change. | S | **LANDED — Batch 868 (`918de9bc1d`).** *(Stamped 2026-08-07, close-out docs reconciliation: this cell read "IMPLEMENTATION DONE — 2026-08-07 (worker); pending orchestrator landing + Edge run", written before the commit that landed it; `918de9bc1d` carries all three files below on `main`.)* **The Edge half is discharged by use, not by a dedicated re-run:** this harness is the instrument every later G-row certifies through, and it has run on Edge continuously since — `C15-G2` (Batches 878/880), `C15-G3` (881/882), `C15-G4` (890, both assets), `C15-G5` (894/895). One honest note for future readers: the WebGPU-ABSENT half of this row's own baseline gate (`_numSplats === 0`, zero `Pass.GAUSSIAN_SPLATS` commands, blank canvas) is **no longer reachable at HEAD** — `C15-G3` made WebGPU splats render — so that baseline cannot be re-captured and does not need to be. `probe-gsplat-parity.mjs` + `lib/gsplat-parity-model.mjs` + `gsplat-harness.spec.mjs` (50 checks green). Predictions + the §6a addendum below | `C15-G0` |
| `C15-G2` | Scene-logic extraction: move the FR dispatch below the data commit; split the backend-neutral snapshot pack from the WebGL `Texture` upload | M | **CONFIRMED-COMPLETE — 2026-08-07 (Batch 880 fix, Edge-verified).** Batch 878 landed the extraction and came back exit 3 on its own STAGE contract (`_numSplats` stuck at 0 — the TEXTURE_READY guard read `pending.gaussianSplatTexture`, a WebGL object the native branch deliberately never creates); `hasSnapshotRenderPayload` fixed it and the re-run measured `numSplats=27`, blockers exactly `[no-splat-data-fields, cache-splat-count-zero]`, **exit 0** — an exact match to the re-registered predictions. Mechanism + corrected boundary in the §6c `C15-G2` block below | `C15-G1` |
| `C15-G3` | Splat record format + WebGPU buffer commit — consume the WASM texture-generator output verbatim; first real WebGPU splat pixels | L | **COMPLETE — Batch 882 (`C15-G3b`) Edge-verified, every pre-registered number hit.** WebGPU splats RENDER: `cache.splatCount=27`, added **18.995%** vs WebGL **19.141%** (inside the predicted 17.8-21.0% band, within 0.8% of parity), parity mismatch **31.946% -> 2.574%** (below the predicted 8-15%), blockers `[]`, `WEBGPU-SPLATS-PRESENT`, exit 0. `probe-splat-sort` + `probe-oit-transparency` green. `probe-splat-globe-occlusion` check 3 red (`greenPx=1436`) -> **`C15-G3c`: attributed to the MISSING GLOBE, not the splat** (the sharper falloff makes leak pixels exactly 4x LESS countable, so it cannot manufacture a leak; 1436 px is precisely the fully-unoccluded footprint at the probe's geometry; the PNG shows the globe confined to a right-hand strip). Instrument fixed (globe-only reference frame, per-pixel green split, structural exit 3); no engine change. 117 harness checks green. Blocks nothing: `C15-G4`/`G5` are unblocked | `C15-G2` |
| `C15-G4` | Consume the WASM radix sort (`primitive._indexes`) instead of the in-renderer synchronous JS comparator sort | M | **LANDED — Batch 890 (`4f6bc93d93`); the Edge run on BOTH assets executed in that same batch.** *(Stamped 2026-08-07, close-out docs reconciliation: this cell opened "IMPLEMENTATION DONE — 2026-08-07 (worker); pending orchestrator landing + Edge run on BOTH assets" while its own body, further down this same cell, already recorded the landing hash and both runs.)* **⚠ The SUBSTITUTED-EVIDENCE caveats stand and are NOT erased by this stamp.** The row's written exit gate asks for "longest main-thread task during a 60-frame orbit **below** the pre-row measurement taken in the same run (**interleaved A/B, not across builds**)". That interleaved timing lane was **not** run. What was measured instead is the pre-registered substitute, recorded verbatim in the predictions table below: **"no main-thread stall" is asserted by `comparatorSorts === 0` — a COUNT, not a timing** — corroborated only by the two wall-clock readings staying inside the 4x `dataReady` budget and by `rendererCommitMs` not growing with splat count. The `tower` 233 ms vs 451 ms data-commit figure is likewise a single-ordering reading, not an interleaved one. Read the gate as *the comparator is provably unreachable*, not as *the main-thread stall was timed away*. **The row's headline was already shipped by its own dependencies, and the record has to say so:** `C15-G2` moved the whole backend-neutral pipeline — including the `GaussianSplatSorter.radixSortIndexes` schedule — ABOVE the FR dispatch, and `C15-G3` consumed its `_indexes` product, so the asynchronous worker sort has owned the WebGPU order since Batch 878 and the synchronous comparator has been unreachable on packed content since Batch 881. What `C15-G4` actually adds: (1) **provenance** — `_indexes` carried no answer to "which camera, against which data?", so `GaussianSplatPrimitive` now stamps `_indexesSortSequence` (the already-monotonic `_sortRequestId`) + `_indexesDataGeneration` at both assignment sites, `commitSnapshot` directly (it IS the atomic data swap; refusing there would desynchronize `_indexes` from `_positions`) and `resolveSteadySort` through a new `publishSortedIndexes`; (2) **a sequence guard at the buffer-upload boundary** in `uploadProvidedSortOrder` — the upload IS the swap (`writeBuffer` snapshots at call time, so a frame draws the whole old permutation or the whole new one), and a resolution for an older sequence or older generation is refused while still returning `true`, so the refusal keeps the resident order instead of falling through to a synchronous sort; (3) **the exit gate's observable** — `cache.comparatorSorts` (gate: 0), `providedSortUploads` (liveness: > 0, else 0/0 is a vacuous green) and `supersededSortUploads`, sampled and printed by `probe-gsplat-parity.mjs`. `maybeSortSplats` is **RETIRED, not deleted** (Principle 7): its `layoutPacked` early-out is the retirement, and it is the ONLY sorter for the three synthetic legacy-layout probes — `probe-splat-sort.mjs` (the Batch-288 sort-consume evidence), `probe-splat-globe-occlusion.mjs`, `probe-oit-transparency.mjs`. Harness 156 → 179: the guard is EXTRACTED FROM SOURCE AND EXECUTED over ordered resolutions, with 8 mutants, each also required to pass on the real source. Discharges `C10-04-SPLAT-ASYNC-SORT` (DEFERRED_WORK 2026-08-07). Predictions in the `C15-G4` block below. **LANDED Batch 890 (`4f6bc93d93`); both Edge runs in. `sh_unit_cube` GATE PASS exit 0 (18.996%, unchanged as predicted). `tower`: every G4 observable EXACTLY on prediction — 286,868/286,868 both legs, `comparatorSorts=0`, `providedUploads=1`, `superseded=0`, added ratio 1.002 (4.085% vs 4.076%, the predicted [0.90, 1.10] band centred), edge 0.141/0.140, lumSd 87.5/88.2, data commit 233 ms WebGPU vs 451 ms WebGL (0.52x, well inside the predicted 1.5x), 0 errors. The absolute added% (4.08%) landed just under the weakly-stated 5-45% band — the ratio was the falsifiable claim and it hit.** `tower` exited **3** on `reference:capture-determinism` (WebGL 0.052% vs a 0.050% bar, 410 px; WebGPU 0.042%) — the instrument refusing to certify parity against a reference that cannot reproduce itself. Owned by **`C15-G4b`** below: the proposed steady-sort mechanism is REFUTED at a frozen camera, and the fix is structural (same-task capture pair + a `sort-quiesced` precondition), with the bar untouched | `C15-G3` |
| `C15-G5` | Spherical harmonics (degree 1-3) in WGSL — the view-dependent colour term the WGSL has **zero** implementation of | L | **LANDED — Batch 894 (`2a950208cb`); ACCEPTED Batch 895 (`09f1c9bf19`) — `sh_unit_cube` mismatch 2.574% → 0.000%, `tower` → 0.017%, SH live and self-reporting at degree 3 on both assets, WebGPU added% converged to WebGL's 19.141%, exit 0.** *(Stamped 2026-08-07, close-out docs reconciliation: this cell read "IMPLEMENTATION DONE — 2026-08-07 (worker); pending orchestrator landing + Edge run".)* **⚠ The row's WRITTEN exit-gate conditions are NOT all discharged and are kept verbatim.** The Batch-895 acceptance measured **one framed camera per asset**, so (a) the required sweep of **three camera azimuths 120° apart** on `sh_unit_cube` has not executed, and (b) the **mandatory vacuity control** — the SH-off leg (`activeShEnabled = false`) differing from the SH-on leg by more than the threshold at **at least two of the three azimuths** — has not executed either; without it the run does not prove the gate is measuring SH, which is exactly the clause the row wrote to protect itself. (c) The `tower` reading rides an exit 3 on `reference:capture-determinism`, the filed `C15-GSPLAT-TOWER-FRAME-VARIANCE` WebGL reference class, which `C15-G5` does not touch and must not be read as clearing. Bands 1-3 evaluated in `SPLAT_WGSL` behind `ShaderDefineHi.SPLAT_SPHERICAL_HARMONICS` (hi bit 3), term-for-term with `PrimitiveGaussianSplatVS.glsl:10-101`. **`_shData` is consumed VERBATIM** as a group-0 binding-4 storage buffer — the WebGL `RG32UI` SH texture is a pure row-regrouping of that same flat array, so the GLSL texel address reduces algebraically to the WGSL's `splat*dims*2 + i*2` and the coefficients are bit-identical (proved by execution, not by comment). The binding is declared OUTSIDE every `//>>ifdef`, so both variants share one BGL / bind group / pipeline layout (`C15-G3` topology discipline). **DC-term determination: the base RGBA8 ALREADY carries the DC band** (`GltfSpzLoader.js:23-24`; writer offsets `base=[0,9,24]`; degree 3 = 15 bands / 45 floats, not 16 / 48; the GLSL `+=` onto the unpacked colour) — so the WGSL adds bands 1-3 only, and the double-count that would brighten every splat ~2x is a dedicated mutant. View direction matched by FOLDING rather than round-tripping: `mat3(M) * posRTE == splatWC - cameraWC` exactly for any invertible `M`, so the CPU packs one `_shInverseRotation * mat3(modelMatrix)` matrix (UBO 320 -> 384; `shViewRotation` at byte 320, `shDegree` at 368) and the shader never materializes a world-space position. **`NEW-SPLAT-SH-DEGREE-BACKEND-DEPENDENT` discharged by option (a)** — `applySphericalHarmonicsBudget` extracted backend-neutral and hoisted above the `_featureRenderer` branch so both legs degrade together; divergence condition computed and recorded (fires at 17,891,328 splats at degree 3 / maxTex 16384, vs `tower`'s 286,868). Naga validates **all 8** `LOG_DEPTH x SPLAT_PACKED_WASM x SPLAT_SPHERICAL_HARMONICS` combinations, enumerated as a power set and cross-checked against the flags the shader actually gates on. Harness **194 -> 217**: both evaluators EXTRACTED from source (constants, band table, index map, degree guards, per-term sign/polynomial/coefficient), compiled as JS and required to agree to **1e-6** over 46 directions x 3 degrees with two anti-vacuity guards, plus the REAL `packSphericalHarmonicsData` executed and read back through the WGSL's own extracted addressing — 14 mutants. Repaired on the way: `WebGPUShaderDefinesSpec.js` was **already red at HEAD** (`ShaderDefineHi` count pinned at 2 since `C15-G3` added bit 2 without bumping it). Predictions in the `C15-G5` block below. **UPDATE 2026-08-07 (CO-12): conditions (a) and (b) now have an INSTRUMENT** — the three-azimuth sweep and the mandatory SH-off vacuity control are built into `probe-gsplat-parity.mjs` and gated in `lib/gsplat-parity-model.mjs`. The caveats above STAND until the Edge run executes; see the `C15-G5` ADDENDUM below for the lanes, the DERIVED numbers and the exact command. Caveat (c) is untouched and still owned by `C15-GSPLAT-TOWER-FRAME-VARIANCE`. **★ THAT EDGE RUN EXECUTED — Batch 916 (`052b5f7865`), tip `25adfbd27d` (the B915 tip; recorded at B916).** *(Stamped 2026-08-09, handover audit FIX 24 — this cell still said the caveats "STAND until the Edge run executes" while the doc's own EXTENDED-LANES FIRST RUN section above records the run. Under the row-wins rule the stale cell was defeating the newer record.)* **On `sh_unit_cube` every new control is GREEN and the substituted-evidence/vacuity caveat is DISCHARGED:** SH-OFF restored the cross-backend mismatch to **2.534 / 2.519 / 2.520%** at the three azimuths (pre-G5 reference ~2.574%, gate ≥1% at ≥2 of 3), i.e. the SH term is proven **NON-VACUOUS**; COV-CTRL fires at 1.980% single-triple and 33.358% bulk against their floors. **On `tower` the caveats are NOT discharged and must not be read as such:** azimuth parity is excellent (0.017/0.020/0.018% vs the 3% threshold) but all three control legs went STRUCTURAL on the SAME mechanism — restorations 0.062%/0.056% and capture-determinism 0.055% against the mutant-pinned 0.050% bar — which is `C15-GSPLAT-TOWER-FRAME-VARIANCE`, **now measured on BOTH backends** (the entry previously recorded WebGPU as the more deterministic side). Owner for that mechanism: `C15-G9`. | `C15-G3` |
| `C15-G6` | `NEW-SPLAT-MULTIFRUSTUM-DEPTH-COMPOSE` — re-verify against production data (the B647 fix is currently **vacuous** under every probe) | M | **PARTIAL — MECHANISM FIXED at Batch 888 (`09c67d0100`, `C15-G6h` — "THE SPLAT LEAK FALLS": the command had no bounding volume, so the frustum splitter gave it every slice; B647 completed with a derived-bounds fallback), with the G3 STAGE CLOSURE following at Batch 889 (`b882728ec3`); the row's WRITTEN EXIT GATE HAS NOT EXECUTED, and the multi-frustum leg remains OWED.** *(Attribution corrected 2026-08-09, handover audit FIX 27 — the cell credited the fix to "Batch 889 … tip `09c67d0100`", conflating the fix commit with the stage-closure commit; `09c67d0100` is Batch **888** and `b882728ec3` is Batch **889**.)* *(Cell opening rewritten 2026-08-07, close-out docs reconciliation. It previously opened "**PENDING**" and closed "**✅ FIXED Batch 889**" — a self-contradiction that let the row be read as either finished or unstarted depending on where you stopped reading. Honest reading: the depth-compose defect is genuinely fixed and mechanism-traced through a nine-step refutation chain, but nothing in that chain is the gate this row wrote for itself. The written gate is: `tower` at a far nadir camera over a settled globe with **`>= 2` active frustums asserted from `frustumCommands`**, splat-over-globe composition present, **cross-backend WebGL-vs-WebGPU occlusion-topology agreement**, plus the **negative control** in which suppressing `command.boundingVolume` reproduces the historical mis-binning. None of those four have run — every observation to date is on the two synthetic probe scenes, not `tower`. **And the fix is what makes this non-trivial rather than a formality:** deriving the bounding volume is precisely what stopped the command from claiming the camera worst-case span, which collapsed the probe scene from **2 frustums to 1** — recorded in the Batch-889 stage-closure paragraph above as `numFrustums` 2 → 1. So the multi-frustum condition the row exists to certify is no longer reachable in the scene where the defect was found, and the gate now needs `tower` or an equivalent framing that genuinely splits. Do not close this row on the mechanism trace.)* Original cell opening follows: **PENDING — and it now has OBSERVED evidence (`C15-G3d`, 2026-08-07).** A splat 3 km BELOW the surface renders through a fully-covering globe while a splat 2 km ABOVE it composes correctly: every splat fragment beats the globe's depth, near and far alike. That is an ENCODE-SPACE mismatch (uniformly smaller splat depth), refuting both a flipped compare (which would hide the NEAR splat) and reversed-Z (no such migration exists at HEAD — 51 `less-equal` across the WebGPU fleet). `probe-splat-globe-occlusion` now prints the log-depth inputs BOTH producers encode from, so one run names the mismatch. **UPDATE Batch 885 (`C15-G6e`): the encode hypothesis is REFUTED by its own pinned constants** (near=0.1, far=1e8, factor=1/log2(far-near+1); reconstructed above 0.472277 < globe 0.487892 < below 0.505179 — correctly interleaved), and the three inline log-depth helper copies are now formula-identity-locked by an extracting spec. **UPDATE Batch 886 (`C15-G6f`): the successor 'depth CLEAR between OPAQUE and GAUSSIAN_SPLATS' hypothesis is REFUTED AT SOURCE** — `_resumeScenePass` re-opens with `depthLoadOp:load`, `_clearDepthStencil` is the only clearing re-open and both of its call sites are upstream of `_executeOpaquePass`, the only pass boundary between the two producers is the DP-H45 repack (which resumes with load, onto a depth-less copy target), and the draw-time pipeline/variant selection is unconditional. Also eliminated: the encode-PHASE question (both producers pack from `currentFrustum` at primitive-update time). **AND the discriminator itself had no positive control** — `bluePaintedOverGlobe = 0` was equally 'occluded' and 'never drew'; new STRUCTURAL precondition **P3** (point alone, depth test disabled, must paint > 500 px) makes the next run decidable in one shot. 140-check harness, 3 new mutants. Filed on the way: `NEW-WEBGPU-COLLECTION-PASS-LITERAL-DRIFT`. **UPDATE Batch 887 (`C15-G6g`): P3 GREEN (3026 px painted / 0 occluded) — the control is sound and the asymmetry is real.** Exhaustive field-by-field diff of the splat vs the point command+pipeline: declared depth state IDENTICAL, cache forwards it verbatim, multisample/format bakes agree, `WebGPUSceneRendererPassRedirect.ts` has no splat branch — candidates 1-3 all refuted at source. **Prime suspect filed as `NEW-SPLAT-LOG-DEPTH-ENCODE-SOURCE-SPLIT`**: the splat is the ONLY log-depth producer reading the live `currentFrustum`; PointPrimitive/Billboard/Label/Polyline/EllipsoidPrimitive/DepthPlane all prefer the stashed full-camera-frustum encode, and the point renderer's comment names the splat's exact symptom as its reason. NOT flipped — the globe is on the live side too, so the pairs may coincide; `recordLogDepthEncoder` now publishes each producer's BAKED pair and the probe reconstructs predicted-vs-measured visibility. One run convicts the encode or closes it with numbers. Harness 140 -> 148, and it forbids the splat's source moving in either direction without that run. **UPDATE Batch 888 — the decider answered branch 2: ALL THREE BAKED TRIPLES EQUAL** (`[0.1, 1e10, 0.030102999566280455]`), reconstructed `redSplat@6km=0.37782 < globe@8km=0.39031 < greenSplat@11km=0.40414` — the arithmetic predicts green HIDDEN against a measured LEAK, so **the encode is exonerated with numbers and the PASS is convicted**, and `NEW-SPLAT-LOG-DEPTH-ENCODE-SOURCE-SPLIT` is downgraded to a latent hazard. **✅ FIXED Batch 889 (`C15-G6h`).** Cause: the splat command had NO `boundingVolume`, so `View.createPotentiallyVisibleSet` gave it the camera worst-case span (`View.js:382-392`) — `[0.1, 1e10]` under log depth, a 1e11 ratio that splits into TWO slices — and it binned into BOTH, while the globe's tiles bin into the near one only; depth is cleared between slices and colour is not, so the far-slice execution composited against a depth buffer with no globe in it. **B647's fields now EXECUTE for real:** `_tileset.boundingSphere` first (WebGL parity, and already live for the real-tileset parity probe), else a sphere DERIVED from the resident splat centres and transformed to world space by the command's own model matrix — so the synthetic and custom producers that are this path's only exercisers stop inheriting the worst-case span. Derived once per attribute commit (the block that already walks the same bytes), one `BoundingSphere.transform` per frame. `NEW-SPLAT-MULTIFRUSTUM-DEPTH-COMPOSE` resolves with this mechanism trace and its recorded per-frustum-UBO-repack fix is marked wrong. Harness 148 -> 156: the derivation is EXTRACTED FROM SOURCE AND EXECUTED over both record layouts, with 4 mutants. `NEW-WEBGPU-COLLECTION-PASS-LITERAL-DRIFT` stays separate and open. **FIRST RUN 2026-08-25** (machine lane, runId `5339a852-de95-4f52-b862-8f888a7bb075`, exit 3 STRUCTURAL): instrument healthy, but both backends reached 3 active frusta and the clean arm partitioned identically into a splat-only near band and two globe-only far bands, so no band held both and there was nothing to compose. Root cause was framing, not defect: the tower asset's content stands 2851.95 m above the ellipsoid, so the pinned nadir camera sat 4037.20 m up and the globe's bounding volumes never reached band 0. **RE-FRAMED IN THIS BATCH:** the probe translates the tileset -1755.006 m along its local up, seating the camera at 2282.195 m, one derived margin `eps/(2(1+eps))` below the first band boundary, so the globe straddles the split. **SECOND RUN 2026-08-25, runId `0e7dac52-2e22-46b3-81f5-a5ec5bffea68`, 18:00:18Z-18:00:43Z, exit 3 STRUCTURAL - THE RE-FRAMING WORKED.** Both backends reached **2 active frusta**, and **for the first time in this row's life a clean band held BOTH the globe and the splat**: band 0 (1146.7747773327344 - 2293.549554665469 m) = **28 globe / 1 splat**, band 1 (2293.549554665469 - 2704.425457777391 m) = 28 globe / 0 splat, identical on both backends across both sessions. The retarget hit its derived altitude to **1.65e-9 m** (`towerAltitudeMeters` 1096.9488447569263 against `targetTowerAltitudeMeters` 1096.9488447552733) inside a `towerAltitudeToleranceMeters` budget of +/-1.1354205716162529 m; all four new framing gates passed, `framingAgreement.agree` is true with zero disagreements, and the negative control still reproduces the historical mis-binning at **37 bands** (splat in all 37, globe in 1). **THE RUN WAS DEMOTED SYMMETRICALLY BY `corner-background-mismatch`** (`webgl:labels:corner-background-mismatch` and `webgpu:labels:corner-background-mismatch`, `topology.eligible` false): seating the camera lower filled the frame with globe - **921,402 of 921,600 px on WebGL, 921,403 on WebGPU** - so the corner sample at (0,0) read the globe colour `[38,38,44]` against a hard-coded background expectation of `[16,16,20]` at tolerance 12, a `backgroundMaximumChannelDelta` of 24. **THE 0.25% LABEL-DISAGREEMENT BAR WAS THEREFORE STILL NOT EXERCISED** - the demotion is raised at the label-partition layer, ahead of the disagreement scoring, exactly as the first run's demotion was raised at the band-standing layer. **THE CORNER FIX AND THE FOOTPRINT RE-REGISTRATION ARE AUTHORED AND LAND IN A FOLLOWING BATCH**, so this demotion is understood, not open; the splat footprint at this nadir framing is **194 px** and the footprint model carried in THIS batch is superseded by that re-registration - do not read this batch's footprint figures as current, and do not infer from them that the disagreement bar is reachable at this framing. Teeth: `gsplat-campaign15-instruments` 86 -> **114**; `lib/gsplat-multifrustum-framing.mjs` is UNMODIFIED; fleet 62/62 with no allowlist row; purpose-header 18/18; both EOL legs green. The page twin is self-contained - verified by ESLint `no-undef` under `globals: {}` over every serialized callback (six free variables, all genuine browser globals) and by execution in a bare `vm` page context - and the evaluator re-derives the placement scalars from `range` and `radius` rather than trusting what the page publishes. **Row stays PARTIAL. No verdict claimed.** | `C15-G3` |
| `C15-G7` | `NEW-GS-CLASSIFICATION-DEPTH` — re-verify the depth-write variant against production data | S | **RUN 2026-09-02 01:59 EDT (Éowyn, first execution ever): STRUCTURAL / exit 3 — 10 STRUCTURAL rows, 6 FAILURES, harness clean, served md5 == disk on both bundles, main at Batch 1361.** Two WebGPU reds, kept separate and not de-scored: (a) the classification colour never reaches WebGPU shading and the shadow volume is unclipped — a red vertical wall ([255,3,3] sixty pixels above the ground) where WebGL draws the exact magenta drape ([255,5,217]); (b) the classification-depth variant exists, is distinct from base and restores its descriptor, yet `depthClassificationFlag` is false and `selectedExecutions 0 / fallbackExecutions 1` in all three states — never selected. One probe defect: `towerMaskPixels == 1` on both backends (framing at 3× the tower-plus-footprint sphere radius), so the splat-overlap positive legs are unreachable and `webgl:positive:*` is not a WebGL red. Evidence `Tools/visual-regression/output/c15-g7-2026-09-02/`. Follow-on rows `C15-G7a` and `C15-G7b` below. | `C15-G3` |
| `C15-G7a` | WebGPU gsplat classification: the depth-write variant is never selected and the per-instance colour does not reach classification shading; the shadow volume is unclipped (the C15-G7 reds (a)+(b)) | M | QUEUED (Opus engine lead; full bar: behaviour spec through the engine-stub-bundler pattern, inertness mutant, WebGL byte-identical, the C15-G7 probe re-run as the Edge leg; re-derive the variant-selection premise in `WebGPUGaussianSplatRenderer.ts` / the pick-and-classification selectors before building) | `C15-G7` |
| `C15-G7b` | `probe-gsplat-classification-depth.mjs` framing: frame the tower so `towerMaskPixels` is in the hundreds on both backends (distance from the tower's own extent, not the footprint sphere), keep every existing assertion, add a refusal when the mask is under a pre-registered floor | XS | QUEUED (Sonnet; probe-only; re-run by the Edge executor after `C15-G7a` so one run carries both) | `C15-G7` |
| `C15-G9` | **Tower frame-variance MECHANISM** — `C15-GSPLAT-TOWER-FRAME-VARIANCE` (`DEFERRED_WORK.md:1553`). Find out WHY two nominally identical captures of the `tower` asset disagree, on BOTH backends, at ~0.055% of the canvas. *(Row MINTED 2026-08-09, handover audit FIX 26 — the item gating the gsplat track's TERMINAL gate had no owning row and no next step; it existed only as a `DEFERRED_WORK` class and a bullet in a dispatch plan.)* **Scope:** mechanism only — this row does **not** move a threshold. **The 0.050% bar is mutant-pinned and MUST NOT be widened**; a widening is a failure of this row, not a pass. **Measured starting state (Batch 916, `052b5f7865`):** capture-determinism 0.055% (431 px WebGPU / 389 px WebGL on the neg-ctrl leg), and the SH-off/covariance **restoration** checks blocked at 0.062% / 0.056% — i.e. the class now measures on both backends, so the earlier "WebGPU is the more deterministic side" note is withdrawn and the mechanism is **shared or environmental**, not backend-specific. **PRE-REGISTERED FIRST DISCRIMINATORS (run in this order; each is designed to be answerable in one Edge session):** **(D1) is it capture, or is it render?** Capture the same frozen frame N times with no state change of any kind between reads — if the 431/389 px disagree across reads of one rendered frame, the defect is in the capture path and every downstream number is instrument noise. **(D2) is it order-dependent?** Same two states captured A→B and B→A in one page; a variance that follows execute-order rather than state is the same time-asymmetry confound already named in `C13-10`'s survival lane. **(D3) is it the asset or the framing?** Re-run D1 on `sh_unit_cube` (27 splats, every control GREEN) at tower's framing and on `tower` (286,868 splats) at the cube's framing — this separates "many splats" from "this camera". **(D4) is it the sort?** `tower` consumes the WASM radix sort (`C15-G4`); pin the sorted index buffer across two captures and diff it — an unstable tie-break among equal-depth splats would produce exactly a small, spatially scattered, both-backend pixel delta. **(D5) is it sub-pixel accumulation?** Diff the differing pixels' spatial distribution: edge-concentrated implicates footprint/blend order, scattered-interior implicates D4. **Acceptance:** the mechanism NAMED with an instrument that reproduces it on demand and a control that does not fire — then either the bar certifies unchanged, or a real engine defect is filed with its own row. **Blocks:** the tower leg of `C15-G8`. | M | **PENDING — dispatch position 2 in the §6 order (machine lane). DORMANCY + ESCALATION STAMP (2026-08-21):** the structural line this row owns has stood since Batch 916 — ~191 batches — which crossed the `R-2026-08-10-7` 30-batch escalation bar long ago; the escalation packet is filed as item 5 of `RULING_REQUESTS_2026-08-21.md` (recommended disposition: authorize the D1–D5 run as the answer, no design ruling needed yet). **The lane WOKE 2026-08-21:** the G7+G6 instrument pair and this row's D1–D5 discriminator harness (`probe-gsplat-frame-variance.mjs` + model + spec, bar mutant-pinned at 0.050%, pre-registered predictions and controls frozen as data before measurement) were authored the same day and are in independent review; the machine-lane Edge run is queued immediately after they land. No measurement has executed; nothing here discharges the structural line. **RULED `R-2026-08-21-17` (2026-08-21 evening): escalation acknowledged; the disposition is to RUN the D1–D5 harness (landed Batch 1122) — run 1 executing in the machine lane the same evening; the 0.050% bar stays mutant-pinned.** **FIRST TWO RUNS (2026-08-21 evening, `--serve-built`, attestable bundle) — runs `dfbb1070` and `4812501f`:** **D1 PASS on BOTH backends, both runs — CAPTURE PATH EXONERATED** (five canonical reads of one frozen frame: 0 changed pixels on tower and on the cube control; the decider the row pre-registered is answered: the variance is not the instrument). **The subject variance did NOT reproduce at the bar:** every tower cell in D3 and D5 measured 0.008–0.034% against the unchanged 0.050% bar that Batch 916 exceeded at 0.055% (D5 reports `subject-not-reproduced`) — the structural line's premise is now either environmental or stale after the landings since B916, which is itself a finding for the mechanism question. D2's numbers are also conclusive (same-state controls 0.009–0.020%, opposite-order comparisons 0.013–0.034%, all sub-bar: no order dependence) but the lane scored STRUCTURAL `initial-states-not-equivalent` because its reset-witness equivalence compared the sort-request `sequence` counter (6 vs 7 across fresh pages) as if it were scene state — every state hash, the Julian date, camera and generations matched; a fix round (state-only equivalence subset) is in flight. Run 1 stopped at D3 on a harness defect (`safeCaptureName` rejected the camelCase cell names; validator widened in Batch 1128); run 2 reached D3–D5 and surfaced three more harness defects for the same fix round: D3 scores the cube cells `framing-invalid` while every per-cell framing witness reads valid/registered-match/unclipped (evaluator and witness disagree); D4 reports `request-0:request-not-bound` with empty measurements (the sort-request provenance binding was never established); D5 on WebGPU goes structural on an EMPTY control region (the cube control had zero changed pixels, which should satisfy the control rather than void it) *[disposition WITHDRAWN at Batch 1132 — see the run-2 diagnosis stamp: the control had zero COVERAGE, not zero change]*. No mechanism is claimed; the harness must clear its own defects and then reproduce the subject before any mechanism statement. Evidence retained under `Tools/visual-regression/output/gsplat-frame-variance/<runId>/`. **FIX ROUND 1 LANDED (2026-08-21 evening, Batch 1129, Sol build + Opus station-3 review):** the D2 reset-witness equivalence now compares a frozen nine-field scene-state subset (clock, camera, sorted-index hash and length, positions hash and length, model-view hash, both generations) and excludes the three scheduling fields (`sequence`, `sortThrottleSatisfied`, `inFlight`); the full twelve-field signatures stay in the artifact as evidence and that write is now mutant-pinned. Replaying run 2's recorded signatures through the fixed model turns both D2 lanes PASS / ORDERING_EXONERATED with nothing else changed — the four fresh pages had `sequence` 6/7/7/10 (WebGL) and 11/8/8/18 (WebGPU) yet byte-identical `indexesSha256`, a convergence datum worth keeping. The review added behavioural coverage for every one of the nine fields (a two-site narrowing of the subset had survived the worker's spec at 95/95) and the evidence-write mutant; spec 97/97 on both line-ending conventions. D1 and the D3/D4/D5 evaluators are byte-unchanged — those three harness defects (cube cells `framing-invalid` despite valid witnesses; `request-not-bound` with empty D4 measurements; the WebGPU D5 control's empty regions) go to fix round 2, whose root-cause diagnosis is in flight. Still no mechanism claim and no re-run yet. **RUN-2 DIAGNOSIS (2026-08-21 evening, Batch 1132; Opus read-only pass over the artifact and the engine, three premises corrected):** (1) **D3** — the cube cells are scored `framing-invalid` because an unregistered coverage-containment conjunct (`persistedFootprintExtents[].contained`, which requires the coverage bbox to stay off every canvas border) is ANDed into `framingValid`; the cube's Gaussian kernels extend ~8-10% beyond its bounding sphere while the registered framing reserves 9.7%, so its coverage touches row 0 (bbox 134,0 → 889,748) and the pre-registered D3 control is unreachable as written. The fix separates framing validity (the three registered witnesses) from a recorded coverage-containment caveat; `FRAMING_MARGIN_PIXELS` must NOT be raised — shrinking the subject is a back-door widening of the mutant-pinned 0.050% bar. (2) **D4** — `request-not-bound` is an ordering defect: `GaussianSplatPrimitive.update` returns at the settled-scene short-circuit (`!hasPendingWork && Matrix4.equals(camera.viewMatrix, this._prevViewMatrix)`) BEFORE `shouldStartSteadySort`, so the probe's throttle-memo reset never reaches the scheduler; the fix resets the settle memo (`_prevViewMatrix`, cloned in place — the constant is frozen) inside the per-request loop. No engine change. (3) **D5** — the earlier disposition above is WRONG and is withdrawn: the WebGPU control did not have zero changed pixels, it had zero COVERAGE — `webgpu-d5-cube-on-0/1.png` and `webgpu-d5-cube-off.png` are byte-identical (md5 9ea93d2e…, 235 non-black pixels = background), while the same asset rendered 85,946 px in the same run's D3 and 85,666 px on WebGL, and rendered in run 1's D1 (md5 bd30b7f0…). This is an INTERMITTENT WEBGPU NON-RENDER of the control asset (filed as `NEW-WEBGPU-GSPLAT-CONTROL-ASSET-INTERMITTENT-NONRENDER`); the honest semantics are a trichotomy — coverage>0 with zero change SATISFIES (WebGL's behaviour, unchanged), coverage==0 is VOID under one named reason `subject-not-rendered`, a sliver keeps `empty-interior-region` — never "empty region satisfies". **Consequence for run 2's D1 record above:** the WebGPU cube-control half of that PASS is WITHDRAWN as vacuous (five reads of a blank canvas trivially agree — D1 had no coverage precondition); the capture-path exoneration stands on the four non-blank tower legs across both runs. D1 gains the same coverage witness. Fix round 2 (all three plus the D1 witness and a WebGPU pipeline-readiness witness for the probe) is dispatched; the re-run follows its landing. **FIX ROUND 2 LANDED (Batch 1135, 2026-08-21 evening; Sol build, Opus station-3 review with two teeth gaps closed at landing):** D3 `framingValid` = the three registered witnesses only, coverage containment + `borderCoveragePixels` recorded as a non-gating caveat (replay of run 2: both cube cells now score; `D3:subject-not-reproduced` 0.013% / 0.021%); D4 settle memo `_prevViewMatrix` zeroed in place inside the per-request loop (embedded canonical block + cross-source memo test + hoisting mutant); D5/D1 coverage trichotomy with one `subject-not-rendered` reason (replay: WebGPU D1 and D5 = `control:subject-not-rendered`, WebGL D1 PASS / D5 `subject-not-reproduced` 0.011% byte-identical to run 2); WebGPU readiness witness on the resolved splat + pick pipelines (`webgpu-splat-pipeline-not-ready`) — NOTE it is point-in-time: a format-generation change re-nulls the pipelines mid-run, so a green readiness does not mean the pipeline was resolved for every frame; the coverage preconditions are the catch. Spec 121/121. The re-run is owed after the bundle refresh (engine files changed since the served bundle was built). **RUN 3 EXECUTED — 2026-08-24, 15:34-15:39 ET, run `c241a577`, on a FRESH bundle:** all four harness defects of runs 1 and 2 are absent, the WebGPU cube control **rendered** (the intermittent non-render did not recur), **D1 and D2 PASS on BOTH backends**, and **D3, D4 and D5 all report `subject-not-reproduced` at 0.012-0.025%** against the unchanged, mutant-pinned 0.050% bar. **RULED `R-2026-08-24-5` (2026-08-24): this row is CLOSED as NOT REPRODUCED.** ([MAINTAINER_RULINGS_2026-08-24.md](MAINTAINER_RULINGS_2026-08-24.md).) Read it exactly as it is written and no further: across runs `dfbb1070`, `4812501f` and `c241a577` the subject variance did not reproduce at the bar. **The 0.050% pin is NOT widened** — the row's own clause that a widening is a failure of the row, not a pass, is honoured. **No mechanism is claimed:** NOT REPRODUCED is not "explained", and the honest reading is that Batch 916's 0.055% was either environmental or has been incidentally repaired by the landings since — which the harness cannot distinguish on a bundle that no longer exhibits it. **The D1-D5 harness stays ARMED**, so if the line returns the discriminators are the answer already built and this row reopens on evidence rather than on memory. **Unblocks the tower leg of `C15-G8`**; nothing here discharges any other `C15-G8` clause. | `C15-G5` ✅ |
| `C15-G8` | Terminal parity gate + tracker reconciliation | M | **PENDING — but its PREREQUISITE INSTRUMENT landed 2026-08-07 (CO-12).** The three lanes this row's gate text asks for and the probe could not run (orbit positions, and the corrupted-covariance vacuity control) now exist and are executable; arming the per-asset thresholds as GATES is still this row's flip (`STAGE.parity.scored` + `STAGE.controls.azimuth.scored`, which arm together). One arithmetic correction to this row's own written control is recorded in the `C15-G8` ADDENDUM below: "a corrupted covariance term pushes the tower mismatch above 3%" is unreachable as written — tower's clean footprint is 4.08% of the canvas, and ONE splat of 286,868 moves a DERIVED 1.4e-7 of it — so the control is measured in two arms with the gated one stated per asset. **★ ARMING STATUS MEASURED — Batch 916 (`052b5f7865`), tip `25adfbd27d` (the B915 tip; recorded at B916), the CO-12 lanes' first run, exit 3 read honestly.** *(Stamped 2026-08-09, handover audit FIX 24 — this cell described the instrument as merely "executable" after it had run.)* **Cube side: FULLY ARMED** — three azimuths plus both vacuity controls live and proven falsifiable. **Tower side: armed for PARITY only** — its determinism preconditions stay STRUCTURAL until `C15-GSPLAT-TOWER-FRAME-VARIANCE` is understood **by mechanism**, which is `C15-G9`'s job. **Consequence for scheduling: `C15-G9` blocks this row's tower leg**, so G8 cannot flip its per-asset thresholds to GATES on both assets until G9 lands. | `C15-G4`, `C15-G5`, `C15-G6`, `C15-G7`, `C15-G9` (tower leg) |

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

#### `C15-G2` follow-up — the Batch-878 run came back exit 3, and why (worker, 2026-08-07)

**The instrument worked; the boundary analysis above was incomplete.** The
Batch-878 Edge run measured: WebGL leg PASS unchanged (27 splats, 19.141%
added); WebGPU leg `cache.splatCount === 0` **not `null`** — so the `show`
accessor took and the renderer executed past its first statement, exactly as
predicted — but `numSplats=0`, `indexes=n/a`, `data=false@never/30000 ms`.
Blockers measured `[no-splat-data-fields, primitive-numsplats-zero,
cache-splat-count-zero]`; `STAGE` had `primitive-numsplats-zero` in `retired`,
so its return raised `webgpu:blocker-contract-stale` → structural exit 3. That
is the staged contract doing the job it was built for: the old
"at-least-one-blocker" rule would have printed the green ABSENT marker on this
exact run and the defect would have shipped invisibly into `C15-G3`.

**Mechanism, `GaussianSplatPrimitive.js:1629-1634` at `e3fe74aa09` (pre-fix):**

```js
if (
  pending.state === SnapshotState.TEXTURE_READY &&
  !defined(pending.gaussianSplatTexture)   // ← WebGL object, shared half
) {
  return;
}
```

`SnapshotState.TEXTURE_READY` records that the WASM generator RESOLVED; this
guard is the state machine's second check that the payload actually
materialized, and it is a genuine WebGL invariant (a snapshot can reach
TEXTURE_READY and lose its texture). But `C15-G2`'s native branch sets
`TEXTURE_READY` with `gaussianSplatTexture` left `undefined` **by design** —
that is the whole point of not creating a `Texture`. So on WebGPU the guard
fired on **every frame forever**: `radixSortIndexes` was never scheduled,
`resolvePendingSnapshotSort` never ran, `commitSnapshot` never ran, and
`_numSplats` stayed 0 for the full 30 s budget while WebGL was untouched.

**The class of defect, which is the transferable part:** `C15-G2`'s boundary
analysis correctly found every place that *constructs* a WebGL object and gated
those. It missed that the shared state machine also *reads* a WebGL object as a
READINESS PREDICATE. Constructing and testing are different verbs, and only the
first was audited. Any future scene-logic extraction on this fork should sweep
for both — the grep is `\.(texture|vertexArray|shaderProgram|drawCommand)\b`
inside conditions, not just at assignment sites.

**Fix (chosen over re-scoping — this is squarely `C15-G2`'s boundary, not
`C15-G3`-shaped work):** a new shared predicate
`hasSnapshotRenderPayload(primitive, snapshot)` that asks the backend-correct
question — `packedSplatTextureData` when a feature renderer owns the draw,
`gaussianSplatTexture` otherwise. The guard calls it. WebGL is byte-identical
(`_featureRenderer` undefined → the expression reduces to the original
`defined(snapshot.gaussianSplatTexture)`), and the WebGL invariant is NOT
weakened: a WebGL snapshot whose texture failed still stalls, which is what
"just delete the guard" would have broken.

**Audit of the rest of the shared half, done after the fix.** Every other
`gaussianSplatTexture` / `sphericalHarmonicsTexture` read was re-checked and
none is a gate: `destroySnapshotTextures` and `retireTexture` are
`defined()`-guarded no-ops; `commitSnapshot`'s assignments carry `undefined`
harmlessly; `buildGSplatDrawCommand` is already gated. `_hasGaussianSplatTexture`
has **two assignments and zero reads repo-wide** — write-only, so not a gate
(left in place per Principle 7). `shouldStartSteadySort` is backend-neutral and
throttled by frame interval + camera position/angle deltas, so the WebGPU leg
does not acquire a per-frame WASM sort. `GaussianSplatSorter.radixSortIndexes`
takes no context.

**Spec (5 new checks, 68 total).** The predicate is EXTRACTED from the engine
file by balanced-brace scan and **executed** against a four-cell truth table —
not grepped — so the test exercises the real bytes: (WebGL, texture) → ready;
(WebGL, no texture) → NOT ready; (native, packed payload) → ready; (native, no
packed payload) → NOT ready. Three source mutants must be rejected: the
Batch-878 unconditional texture read, `return true` ("delete the guard"), and
inverted branches. Plus a call-site anchor that the guard routes through the
predicate. **Negative control:** with the shipped Batch-878 engine file copied
back in, exactly those 5 go red and the four original `C15-G2` structure
anchors stay green — a precise separation, since the extraction itself was
sound.

*One anchor was found weak while doing this and repaired:* the pre-existing
"WebGL Texture upload is behind the backend branch" anchor matched the bare
string `if (defined(primitive._featureRenderer)) {`, which the new predicate
now also contains **earlier in the file** — so `indexOf` silently started
pointing at the wrong site. Both the anchor and its mutant are now anchored on
the branch BODY. The mutant battery is what surfaced this.

*Re-registered predictions for the next Edge run* — WebGL leg unchanged:
WebGPU `_numSplats === 27` (`286868` on `tower`), `_indexes.length` matching,
`isStable === true`, `dataReady === true`, `cache.splatCount === 0`,
`splatPassCommands === 0`, `added.changed === 0`,
`absenceBlockers = [no-splat-data-fields, cache-splat-count-zero]`, marker
`WEBGPU-SPLATS-ABSENT (expected until C15-G3)`, **exit 0**. If `numSplats` is
still 0, the stall moved to a different early return and the next suspects in
order are `hasRootTransform` (top-of-frame snapshot vs. rebuild-time
assignment) and the `radixSortIndexes` task-processor readiness path, both of
which are backend-neutral in source and would therefore indicate something
upstream of this file.

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

#### `C15-G3` — IMPLEMENTATION DONE (worker, 2026-08-07) — pending orchestrator landing + Edge run

**One clause of the exit gate above needed re-reading, not weakening.** It asks
for "a `node --test` CPU spec [that] proves the JS-side pack and the WGSL-side
unpack agree". Option B has **no JS-side pack** — that is the point of it; the
WASM writer packs, and the only in-tree description of what it wrote is the GLSL
decode. So the equivalent-strength spec pins the two SHADER decodes against each
other, both PARSED from source rather than transcribed: the GLSL word/half
mapping is derived from `PrimitiveGaussianSplatVS.glsl` (its `u1/u2/u3`
assignments and its 9-argument `Vrk` mat3), the WGSL mapping from the extracted
`SPLAT_WGSL` (`loadSplat`'s `unpack2x16float` reads and `vertexMain`'s `Sigma`
mat3x3), and all nine covariance elements plus position and colour must resolve
to the SAME `(word, half)`. On top of that the "known `(scale, rotation)`
triple" runs for real: Σ = R·diag(s)·(R·diag(s))ᵀ from a 37° rotation about
(1,2,3) with scale (0.35, 0.08, 1.25), half-encoded into an 8-u32 record and
decoded back through the WGSL's own parsed mapping, asserted to 1e-3 (f16
precision) and asserted symmetric. Seven WGSL mutants must be rejected, each
verified to die on the intended assertion.

Five files, two of them engine:

| File | Change |
| --- | --- |
| `packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts` | `ShaderDefineHi.SPLAT_PACKED_WASM = hiDefineBit(2)` — the record-layout axis (add-only; 0/1 unchanged) |
| `packages/engine/Source/Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts` | `SPLAT_WGSL` reads `array<u32>` + a `//>>ifdef`-gated `loadSplat`; packed-source resolution + buffer commit + lifecycle; `_indexes` consumed; `_rootTransform` model matrix; stride-derived velocity sizing; preprocessed `_shaderCode` |
| `Tools/visual-regression/lib/gsplat-parity-model.mjs` | `STAGE` → `C15-G3` (all four blockers retired, `required` empty); stage is now a PARAMETER; `STAGE.parity` (recorded-not-gated); `PRESENT_MARKER` |
| `Tools/visual-regression/probe-gsplat-parity.mjs` | `no-splat-data-fields` predicate extended to the packed payload; layout/stride/sorted-index diagnostics; stage + parity-deferral notes printed |
| `Tools/visual-regression/gsplat-harness.spec.mjs` | 95 checks (was 68): the decode-agreement battery, the round-trip, the flat-run algebra, Naga on 4 variants, 9 renderer anchors, 7 WGSL mutants, 3 new model mutants, the G2 stage machinery preserved against a frozen fixture |

**(a) The format decision, taken as the row recommended: Option B, verbatim.** The
WGSL group-0 binding 1 is now `array<u32>` in BOTH variants — not two different
struct types — and the `SPLAT_PACKED_WASM` define selects only the arithmetic
inside `loadSplat`. That keeps the BGL, the bind group, the pipeline layout and
the buffer usage flags literally identical across the two layouts; the only
thing a layout flip changes is which shader module (and therefore which
pipeline) the cache hands back. The packed branch mirrors
`PrimitiveGaussianSplatVS.glsl:152-173` term for term:

| u32 | packed decode | legacy (`//>>else`) |
| --- | --- | --- |
| 0-2 | `bitcast<f32>` → model-space position → `positionHigh` | `positionHigh` |
| 3 | unused (the GLSL reads the texel as vec4 and takes `.xyz`) | `positionLow.x` |
| 4-6 | 3 × `unpack2x16float` → `(Sxx,Sxy)`, `(Sxz,Syy)`, `(Syz,Szz)` | ... |
| 7 | RGBA8, shifts 0/8/16/24, ÷255 | ... |

Stride 8 u32 (32 B) vs the legacy 16 f32 (64 B): 9.2 MB rather than 18.4 MB of
GPU storage for `tower`, **zero** CPU repack (`data.subarray(0, count * 8)` goes
straight to `queue.writeBuffer`), and a covariance that is bit-identical to what
WebGL samples — which is what makes a tight `C15-G8` threshold reachable once SH
lands. Option A (repack to the 64-byte record) was not implemented and stays
recorded as the fallback; a spec anchor forbids a `new Float32Array(count * 16)`
appearing here so it cannot arrive by the back door.

**The flat-run premise, proven rather than asserted.** `computeSplatTextureLayout`
pads the WASM buffer out to the full `width * height * 4` texture footprint, so
"slice the first `count * 8`" is only correct if the records are a flat run. They
are: with `width = maxTex`, `rowMask = maxTex/2 - 1` and `rowShift = log2(maxTex/2)`,
the GLSL address `y*width + x = (i >> rowShift)*maxTex + ((i & rowMask) << 1)`
reduces to exactly `2*i` for every `i` and every power-of-two `maxTex`. The spec
reads all four formulas out of the engine and the GLSL and checks the identity
numerically, so a change to either end goes red here rather than in a probe.

**(b) RTE — the named decision, taken explicitly.** The WASM record stores
position as a single f32 vec3, so `positionHigh`/`positionLow` cannot be
recovered from it; the f32 is the data's own precision ceiling. The packed
branch sets `positionHigh = <the f32 vec3>`, `positionLow = vec3(0)`, and BOTH
variants keep the identical
`(positionHigh - encodedCameraHigh) + (positionLow - encodedCameraLow)` →
`mvpRelativeToEye * vec4(posRTE, 1)` shape. The lane is zeroed, not deleted,
with a rationale comment at the site. RTE still buys what it exists for on the
CAMERA side, which is untouched: the CPU transforms the camera into the
primitive's model frame (`inverse(rootTransform) * cameraWC`) and splits it
high/low, and `transformTile` bakes every tile into `inverse(_rootTransform)`,
so splat positions are metre-scale in that ENU frame and the large magnitude is
cancelled BEFORE the f32 subtract rather than after it. **The synthetic path was
checked first and does NOT violate RTE** — it carries a real high/low split —
so there was nothing to propagate or to record as a pre-existing violation.

**(c) A defect found en route, and it would have made the first pixels land at
the geocentre.** `updateWebGPUGaussianSplats` built its modelView from
`primitive.modelMatrix ?? Matrix4.IDENTITY`. **`GaussianSplatPrimitive` has no
`modelMatrix` member at all** — its WebGL DrawCommand is built with
`modelMatrix: primitive._rootTransform` (`GaussianSplatPrimitive.js:2307-2321`),
the ENU frame at the tileset bounding-sphere centre, precisely so
`view * modelMatrix` stays numerically small. The read was harmless for the
three synthetic probes (they hand-roll `modelMatrix` and no `_rootTransform`)
and wrong for every production primitive, which is exactly the shape of bug the
scaffolded-only path accumulates. Fixed with a `splatModelMatrix()` helper
preferring `_rootTransform`, used by both the uniform pack and the depth-sort
key. Logged in `WEBGPU_DEBUGGING_LOG.md`.

**A second, smaller one:** `cmd._shaderCode = SPLAT_WGSL` handed the RAW
template — `//>>ifdef` directives and all — to
`WebGPUSceneRendererTranslucentPass`, which compiles it when a command has no
`_oitPipeline`. WGSL reads those directives as comments, so the consumer would
compile a source with BOTH branches of every block present (two `fragmentMain`
definitions). Pre-existing and normally unreachable (the renderer sets
`_oitPipeline`), but the layout axis made it load-bearing: an un-preprocessed
source would also carry the wrong stride. Now `preprocess(SPLAT_WGSL, 0,
layoutDefinesHi)`.

**(d) The commit, and what its dirty signal is.** The source resolution
(`resolveSplatSource`) prefers the legacy `_splatData` / `_renderResources.splatBuffer`
when present (the probes) and otherwise takes `_packedSplatTextureData`. The
commit fires on `(count, layout, producer identity)`, not on the count alone: a
snapshot rebuild that lands on the same splat count produces a fresh payload
object and nothing else changes, and a count-only check would leave the previous
cloud resident forever. The identity token is the PAYLOAD OBJECT, never the
`subarray` view — a fresh view is allocated per call, so view identity would
report "changed" every frame and re-upload 9 MB per frame on `tower`.

Uploads go through `device.queue.writeBuffer` (the fork's frame-owned,
queue-ordered CPU→GPU path); no encoder and no `queue.submit` were added — the
only submit in the file remains the pre-existing velocity prev-seed self-copy.

Lifecycle: re-upload on snapshot commit (via the identity token); **withdrawal**
— when the packed producer goes away (tileset unload, `_dirty` teardown,
`GaussianSplatPrimitive.destroy`, all of which clear `_packedSplatTextureData`
and `_numSplats`) the cache retires `splatCount`/commands rather than
rasterizing stale bytes; destroy is unchanged and already routed
(`GaussianSplatPrimitive.destroy` → `this._featureRenderer.destroy(this)` →
`destroyWebGPUGaussianSplatResources`, which destroys all four buffers).

**Pipeline invalidation has its own layout field, deliberately.**
`cache.resourcesLayoutPacked` (what the PIPELINES compile for) is tracked apart
from `cache.layoutPacked` (what the BUFFER holds). They are legitimately out of
step for the frames between a flip and the pipeline resolving, because
`tryResolveSplatPipelines` returns early while a cold variant compiles (~2.7 s
measured on this fork) and the buffer commit sits BELOW that return — comparing
the flip against the buffer's layout would re-invalidate and re-REQUEST the
pipelines on every frame of that window.

**(e) The sort. `_indexes` is consumed; the comparator is not deleted.** The row
is explicitly not `C15-G4`, so the in-renderer synchronous
`Array.prototype.sort` stays for the legacy synthetic path (which has no
`_indexes` and whose non-identity-permutation assertion is the Batch-288
evidence). What changed is that the WebGPU draw no longer DROPS the permutation
the shared pipeline already computed: `uploadProvidedSortOrder` writes
`primitive._indexes` into `sortedIndexBuffer` when its length matches the splat
count, and `maybeSortSplats` returns immediately for the packed layout. So the
production path never pays a 286k-element main-thread sort. `C15-G4` still owns
the demand signal, the throttle, deleting the comparator outright, and the
interleaved-A/B main-thread-task measurement.

**(f) The probe contract flips, and default mode stops being a certification
mode.** `STAGE.id` is `C15-G3`, all four blockers are `retired`, and `required`
is EMPTY. An empty required set is itself a contract: there is no absence this
stage can certify, so a default run is structural
(`webgpu:stage-requires-expect-webgpu`) whatever it measures — reported that way
rather than as `absence-unattributed` (which blames the probe) or
`blocker-regression` (which blames a row that did not regress). The probe stays
dual-mode and still collects every blocker. `no-splat-data-fields` now also
tests `_packedSplatTextureData`, because the legacy trio stays unassigned BY
DESIGN under Option B and testing only those three would report the blocker
forever on a healthy engine.

The stage is now a PARAMETER of `evaluateWebgpuLeg`/`evaluateParity`. Without
that, every rule exercising the both-directions blocker contract would go
vacuous the moment `required` emptied — loops over an empty array assert nothing
and still report green. The mechanism is tested against a frozen `C15-G2`
fixture; the shipped stage is pinned separately.

**(g) The parity-mode decision — parity is RECORDED, not GATED, at `C15-G3`.**
Both gate tilesets are SH degree 3 and the WGSL has no spherical-harmonics term
until `C15-G5` (`C15-G0` §6a(B)), so every splat carries a view-dependent colour
the WebGPU leg cannot reproduce. A cross-backend diff at this stage scores the
MISSING SH, not the record decode this row ships, and cannot come in under 1% /
3% however correct the decode is. So the diff is still computed, still printed,
still written to disk (its magnitude is the SH signal `C15-G5` has to remove)
and deliberately not folded into the verdict.

**What gates `C15-G3` instead is the reference leg's own structure battery
applied to the WEBGPU leg** — added-pixel fraction ≥ 2.000%, edge fraction in
[0.002, 0.95], luminance σ ≥ 4, the 10× negative-control margin, zero
console/device errors — **plus splat-count equality**. Those are exactly the
criteria `splatRenderCriteria` already computed for the reference; the flip mode
now runs them on the WebGPU leg and prints `WEBGPU-SPLATS-PRESENT (C15-G3)` when
they all hold. **The `C15-G8` thresholds are UNCHANGED** (`tower` 3%,
`sh_unit_cube` 1%): `C15-G5` flips `STAGE.parity.scored` and the same numbers
become the gate again. A spec rule drives the identical input through a
parity-scored stage fixture and requires it to FAIL, so "deferred" can never be
confused with "deleted", and a missing diff stays STRUCTURAL even while the gate
is deferred — deferring the gate must not defer the measurement.

*Falsifiable predictions for the Edge run* — `node Tools/visual-regression/probe-gsplat-parity.mjs --expect-webgpu`,
`sh_unit_cube`, Edge, 1024×768 = 786,432 px, pinned clock `2026-06-01T18:00:00Z`.
The WebGL leg is predicted UNCHANGED from `C15-G1`/`C15-G2` (27 splats,
~19.1% added):

- WebGPU leg: `_numSplats === 27`; `_indexes.length === 27`;
  **`cache.splatCount === 27`** — was 0; **`layout=packed-wasm(32B)`,
  `recordBytes=32`, `sortedIdx=27`**; `packedWords >= 216` (27 × 8; the printed
  value is the padded texture footprint, so expect it to be far larger —
  `maximumTextureSize * ceil(27/(maxTex/2)) * 4`, i.e. 32,768 at
  `maxTextureDimension2D = 8192`);
  **`splatPassCommands >= 1`** and **`commandListSplatCommands === 1`** (the row's
  exit gate asks for exactly one `Pass.GAUSSIAN_SPLATS` command; the binned
  count is per-frustum and the harness scene is single-frustum, so the two
  should agree) — both were 0; **`added.changed >= 15,729 px (2.000%)`**
  with `edgeFraction` in [0.002, 0.95] and luminance σ ≥ 4;
  `negativeControlChanged` still < 0.100% of canvas; determinism < 0.050%;
  zero console/device errors; printed line
  `WEBGPU-SPLATS-PRESENT (C15-G3)`; overall exit **0**.
- Parity: a number IS printed and is predicted to be LARGE — the SH-shaped
  difference, expected well above the 1% `sh_unit_cube` threshold and plausibly
  comparable to the added fraction itself, since SH degree 3 perturbs colour on
  essentially every splat pixel. It is reported as
  `RECORDED, NOT GATED at C15-G3` and contributes nothing to the exit code.
  **Its magnitude is the pre-registered baseline `C15-G5` must beat.**
- On `tower`: the same shape with `_numSplats === 286868`,
  `cache.splatCount === 286868`, `recordBytes=32` (≈9.18 MB of storage buffer).

*Named ways this can come back other than predicted, and what each means:*

- `cache.splatCount === 0` with `numSplats === 27` → the commit did not fire.
  Check `resolveSplatSource`: either `_packedSplatTextureData` is undefined on
  the primitive (the `C15-G2` retention regressed) or the console carries the
  permanent `packed payload is short` error, which would mean the shared layout
  pass produced fewer than `count * 8` words.
- `splatPassCommands === 0` with a non-zero `cache.splatCount` → the command was
  built but not binned. `boundingVolume` now comes from `_tileset.boundingSphere`
  for real content (it was always `undefined` under every synthetic probe — §6b
  row 3), so this is the FIRST run in which the B647 binning fields are
  executed at all. That is `C15-G6`'s subject arriving early; the single-frustum
  globe-hidden harness scene is the target here.
- Added pixels present but structure RED (`edgeFraction` at the ceiling,
  σ below 4) → a decode-shaped defect the offset pins did not catch: confetti at
  ~1 px per splat is what a wrong stride looks like on screen. Read the PNG
  against the WebGL leg before touching thresholds.
- A device/validation error mentioning binding size → `maxStorageBufferBindingSize`
  on `tower` (9.18 MB, well under the 128 MB default, so this would indicate an
  adaptive-limit cap rather than the data).
- Default mode (no `--expect-webgpu`) exits 3 with
  `webgpu:stage-requires-expect-webgpu`. That is CORRECT, not a regression.

*Gates run in the worktree:* `npx tsc --noEmit` in `packages/engine` — 0 errors
(0 non-TS2307); `prettier --write` clean on all five files; `eslint` clean on
the three `Tools/` files, one file per invocation (engine `.ts` under
`packages/engine/Source` is not covered by any `eslint.config.js` block — it
reports "File ignored because no matching configuration was supplied", which is
the repo's standing state, not a new gap); `node --test
Tools/visual-regression/gsplat-harness.spec.mjs` — **95/95** (68/68 baseline
preserved and extended); `pipeline-key-aliasing.spec.mjs` 59/59 and
`mat-logdepth-encode-stash.spec.mjs` 12/12 still green (the two other specs that
read the `ShaderDefine` registry). Naga validates all four
`(LOG_DEPTH × SPLAT_PACKED_WASM)` variants.

*Negative control (file copy, per the standing convention — no `git stash`):*
with the pre-`C15-G3` renderer copied back over the file, **16 of 95 go red** —
the 9 new renderer anchors plus all 7 WGSL mutants (which correctly report "this
mutation no longer applies") — while **every `C15-G2` anchor stays green**. The
file was restored and md5-verified identical. Separately, each WGSL mutant was
run with its rejection message printed, confirming all 7 die on the intended
assertion (e.g. "covariance element [1][2] disagrees: WGSL reads cov2.y → word 6
half 1, GLSL reads u3.x → word 6 half 0") rather than on an unrelated parse
error.

**Not in this row, recorded so it is not mistaken for done:** the WGSL still has
no SH term (`C15-G5`); the comparator sort still exists for the legacy layout
(`C15-G4`); the multifrustum compose and the classification-depth swap are now
REACHABLE for the first time but unverified (`C15-G6`, `C15-G7`); and the
`maximumTextureSize` divergence recorded at `C15-G2` is unchanged — the native
branch still takes the texture-shaped budget, which above ~8.4M splats would
truncate the two backends to different counts. `C15-G3` deliberately did not
re-open it: changing the budget shape would fork `numSplats` between the
backends, which is the one thing the `C15-G8` gate cannot tolerate.


#### `C15-G3b` — the Batch-881 Edge run: SPLATS DRAW, and two defects it exposed (worker, 2026-08-07)

**The headline, first: the WebGPU Gaussian-splat path renders. First real splat
pixels in the project's history.** `sh_unit_cube`, `--expect-webgpu`:
`splatCmds=1/1`, `added=480,480 px (61.096%)` against a 2.000% floor,
`edge=0.0146`, `lumSd=37.7`, `errs=0`, `numSplats=27`, `indexes=27`,
`data=true@73ms`, `packedWords=32768`. The pixels prediction was right; the run
still exited **1**, on `webgpu:partial-splat-state`, because
`cache.splatCount` read `0`. Both halves of that are now understood and fixed.

##### Prediction record — honest scoring of the `C15-G3` pre-registration

| Predicted | Measured | Verdict |
| --- | --- | --- |
| `splatPassCommands >= 1`, `commandListSplatCommands === 1` | `1/1` | ✅ |
| `added >= 15,729 px (2.000%)` with structure | `480,480 px (61.096%)`, edge 0.0146, σ 37.7 | ✅ (floor), see below on magnitude |
| `_numSplats === 27`, `_indexes.length === 27` | 27 / 27 | ✅ |
| `packedWords >= 216`, padded footprint far larger | `32768` = 8192 × 1 × 4 | ✅ exactly as derived |
| zero console/device errors | 0 | ✅ |
| **`cache.splatCount === 27`** | **`0`** | ❌ **WRONG** |
| overall exit 0 | exit 1 | ❌ (consequence of the above) |
| parity RECORDED not gated, large | `31.946%`, recorded, exit unaffected | ✅ |

The `cache.splatCount` prediction was not a near-miss, it was wrong about *when*
the number becomes true, and the probe was wrong about *when* to read it.

##### Defect 1 — `cache.splatCount` read 0 on a frame that painted 61% of the canvas

Not a contradiction, and not a second cache object. The manifest settles it: the
run recorded `cacheSplatCount=0`, `cacheLayoutPacked=false`,
`cacheSplatRecordBytes=64`, `cacheSortedIndexCount=0` — **every renderer-owned
field at its constructor default**. `layoutPacked=false` and `recordBytes=64`
are what `updateWebGPUGaussianSplats` writes when it ALLOCATES the cache. So the
cache existed and the commit block had never executed. Nothing reset it; it had
simply not run yet.

**Mechanism.** `tryResolveSplatPipelines` returns early while a cold pipeline
variant compiles (~2.7 s measured on this fork), and `C15-G3` put the buffer
commit BELOW that gate. The probe's data-readiness loop waits on `_numSplats`,
which is the SHARED pipeline's signal and went true at **73 ms** — hundreds of
milliseconds before any splat pipeline could exist. The probe then sampled a
RENDERER-owned field at that instant. By the scored frame, three 2 s settles
later, the pipeline had resolved, the commit had run, and 27 splats drew.

**The transferable shape:** *a readiness loop that waits on signal A and then
samples signal B has measured nothing about B.* `C15-G2` was caught by a
readiness predicate reading the wrong backend's object; this is the same family
one level up — the probe read the right object at the wrong time. Both fixed:

1. **Engine.** The commit block is hoisted ABOVE the pipeline gate. Uploading
   attribute bytes needs the device, not a pipeline. `cache.splatCount` now
   means "the data is resident", not "the data is resident AND a pipeline
   happened to finish compiling", and the upload starts one compile earlier.
   The command build still waits on the pipeline, and the `splatCount === 0`
   guard stays BELOW the gate so pipelines keep warming concurrently with an
   empty cache (moving it up would delay first pixels by a full compile).
   Pinned by an ordering anchor with both inequalities.
2. **Instrument.** The renderer commit gets its OWN wall-clock budget (WebGPU
   leg only — the WebGL leg has no `_webgpuCache` and would burn the whole
   budget), reported as `rendererCommit=<bool>@<ms>`; and every renderer-owned
   stat is **re-sampled immediately after the scored ON capture, in the same
   task as the command counts**, because that is the frame the verdict
   describes. The spec pins the sampler's existence, that it runs at least
   twice, that the last call follows the capture and the command counts, and
   that no `await`/`settleMs` sits between them.

##### Defect 2 — the 3.2x coverage difference, attributed and fixed

**It is not SH, and not the record decode.** Ruled out by arithmetic, not by
assertion: SH is a COLOUR term that upstream applies *after* `calcCovVectors`
has already produced the quad — `v_splatColor.rgb += evaluateSH(...)` — so no SH
input reaches the footprint in either shader. And a covariance decode at the
wrong scale would not land within 10% of a convention-only prediction, which is
what happened.

**The real cause: two footprint conventions the Batch-288 WGSL never matched.**

| | WebGL (`PrimitiveGaussianSplatVS/FS.glsl`) | WGSL before `C15-G3b` |
| --- | --- | --- |
| focal | `czm_projection[i][i] * czm_viewport.zw` (FULL viewport) | `proj[i] * (viewportDim * 0.5)` (HALF) |
| quad | oriented rect, half-extents `min(sqrt(2*lambda_i), 1024)` | axis-aligned square, half-side `ceil(3*sqrt(eigenMax))` |
| expansion | `/ viewport * w` | `/ viewport * 2.0 * w` |
| falloff | `exp(-4 * dot(corner, corner))` — effective sigma/2 | `exp(-0.5 * r^2 / sigma^2)` — the true gaussian |
| support | the quad, i.e. sqrt(2) sigma | the 3-sigma quad (the 1/255 cutoff is at 3.33 sigma) |

Net linear extent, carried through both focal conventions:
`ndcOff_old = 3*P*g*w` versus `ndcOff_glsl = sqrt(2)*P*g*w` — **ratio 3/sqrt(2)
= 2.121** in linear extent, **4.5x in raw quad area**. On the supported region
(isotropic case: a 3-sigma disc versus a sqrt(2)-sigma square) the area ratio is
`pi*(3 sigma)^2 / (2*sqrt(2) sigma)^2` = **3.53**.

Three independent measurements agree with that, from three different directions:

* **Area.** 61.096% / 19.141% = **3.19x** — just BELOW 3.53, which is what
  overlap saturation predicts: 27 footprints union sublinearly and the larger
  ones overlap more.
* **Boundary.** `edgeFraction` 0.0347 (WebGL) / 0.0146 (WebGPU) = **2.38x**.
  Edge fraction scales as 1/radius, so this is the LINEAR ratio measured
  independently — against a prediction of 2.12, high by exactly the amount the
  merged blobs in the PNGs explain (merging destroys boundary).
* **The PNGs, read.** Identical six-armed radial structure and identical splat
  CENTRES on both legs — so position, RTE and `_rootTransform` are right — with
  visibly larger, softer WebGPU haloes that merge adjacent splats into smears.
  The colour difference is separate and is the SH signature: WebGL warm
  (mean 48/27/28), WebGPU grey-shifted (42/33/33), most obvious on the left arms
  where WebGL is tan/orange and WebGPU near-white.

Also worth naming: the half-viewport focal was not merely a scale factor. The
`+0.3` dilation and the `1024` clamp are ABSOLUTE constants ported from the
GLSL; against a 4x-small covariance the dilation was effectively 4x stronger,
inflating small splats specifically.

**The fix ports WebGL's footprint verbatim** — full-viewport focal (CPU pack),
`projectSplatCovariance` (J, `R*Sigma*R^T`, `J^T..J`, `+0.3` on both diagonals),
`splatQuadAxes` (eigen-decomposition, `max(mid-radius, 0.1)` floor, both
`min(sqrt(2*lambda), 1024)` extents), the oriented-quad expansion with no factor
of 2, WebGL's `1.2*w` off-screen rejection and 2-pixel sub-pixel rejection, and
`exp(A*4.0)` in the FS with the `0.99` cap removed (WebGL has none). The colour
and velocity vertex shaders now go through the SAME two helpers instead of two
copies of one footprint, which is how their coverage would otherwise
desynchronize. The pick FS mirrors the colour footprint and keeps its own
1/255 visibility floor.

**One deliberate deviation, recorded rather than smuggled.** The GLSL computes
`normalize(vec2(offDiagonal, lambda1 - diagonal1))`, whose argument is EXACTLY
`(0, 0)` for an axis-aligned splat — `offDiagonal` is zero and `lambda1`
collapses onto `diagonal1` — so `normalize` returns NaN and the quad
degenerates. Real splat clouds never land exactly there; a synthetic isotropic
covariance at the screen centre does, and that is precisely what
`probe-splat-sort.mjs` feeds this shader. The port guards the normalize and
falls back to the x axis, which is correct for a circular footprint. The spec
**executes** both implementations over a battery of projected covariances and
requires them to agree exactly wherever the GLSL is well-defined, and requires
the port to stay finite (with the right extents) on the two cases where it is
not — so the deviation is bounded by test, not by claim.

##### Files

| File | Change |
| --- | --- |
| `WebGPUGaussianSplatRenderer.ts` | commit hoisted above the pipeline gate; full-viewport focal; `projectSplatCovariance` + `splatQuadAxes` helpers; WebGL-parity quad, rejections and falloff in the colour/pick/velocity paths |
| `probe-gsplat-parity.mjs` | renderer-commit wall-clock budget (WebGPU leg); `sampleRendererStats()` re-sampled at the scored frame; `rendererCommit` printed |
| `gsplat-harness.spec.mjs` | 108 checks (was 95): commit-ordering anchor, scored-frame sampling anchor, the executed GLSL-vs-WGSL quad-axis battery incl. the two degenerate cases, the executed 3.5x attribution arithmetic (with the SH-cannot-touch-coverage proof), the footprint anchor set, and 7 footprint mutants |

##### Pre-registered predictions for the re-run (`--expect-webgpu`, `sh_unit_cube`)

WebGL leg predicted UNCHANGED (27 splats, 150,529 px = 19.141%, edge 0.0347,
σ 37.4).

* **`cache.splatCount === 27` exactly** — with `layout=packed-wasm(32B)`,
  `recordBytes=32`, `sortedIdx=27`, and `rendererCommit=true` inside the derived
  budget (expected to resolve in the low seconds — it is bounded by the cold
  pipeline compile, not by the data).
* `splatPassCommands=1/1`, `numSplats=27`, `indexes=27`, `errs=0`.
* **`added` converges on the WebGL leg: 140,000–165,000 px, i.e. 17.8%–21.0%** —
  down from 480,480 px (61.096%). Point estimate ~19%, because the footprint is
  now identical by construction and the ADDED metric counts any pixel differing
  from the background, so both legs cover the same pixels.
* **`edgeFraction` rises to 0.025–0.045** (from 0.0146), converging on WebGL's
  0.0347 — the independent confirmation that the extent, not just the area,
  moved.
* **Parity: still RECORDED, NOT GATED, and predicted to DROP below 25% — and
  strictly below the 31.946% Batch 881 recorded.** Point estimate 8–15%: with
  the supports coincident, only the SH colour delta remains, and much of it
  falls under the diff's 48/765 absolute-delta threshold. It stays far above the
  1% `C15-G8` gate, which is why `STAGE.parity.scored` stays false until
  `C15-G5`.
* Overall **exit 0**.

*Named ways this comes back other than predicted:*

* Parity does NOT drop below 31.946% → the footprint attribution is wrong and
  the residual needs re-attribution before `C15-G5` starts. This is the
  falsifiable core of the round.
* `added` lands far BELOW 17.8% (say under 12%) → the port over-shrank; suspect
  the focal/expansion pair (they must move together — the spec pins both, but a
  build serving a stale module would show exactly this).
* `added` stays near 61% → the shader module was not recompiled; check that the
  `packed=` pipeline names and the `sh:` module fold in the pipeline cache
  actually changed.
* **`probe-splat-sort.mjs`, `probe-splat-globe-occlusion.mjs` and
  `probe-oit-transparency.mjs` are the risk surface for this change and MUST be
  re-run.** Their splats shrink 2.12x linearly and sharpen. The primary
  assertions should be unaffected or strengthened — `probe-splat-sort` asserts
  the sorted-index buffer contents (a readback, footprint-independent) and the
  CENTRE pixel colour (the region a tighter, sharper splat dominates MORE) — and
  the isotropic covariance they use is exactly the case the guarded normalize
  was written for, which the spec battery executes. But that is reasoning, not
  pixels; the run is the test.

*Gates:* `tsc --noEmit` in `packages/engine` 0 non-TS2307; prettier clean;
eslint clean on both `Tools/` files; `node --test gsplat-harness.spec.mjs`
**108/108** (95 preserved and extended); Naga validates all four
`(LOG_DEPTH × SPLAT_PACKED_WASM)` variants. **Negative control (file copy):**
with the pre-`C15-G3b` renderer copied back, exactly **9 of 108** go red — the
commit-ordering anchor, the footprint anchor, and all 7 footprint mutants —
while every `C15-G3` decode anchor stays green. File restored, md5-verified.


#### `C15-G3c` — `probe-splat-globe-occlusion` check 3: the leak is the MISSING GLOBE, and the probe could not see that (worker, 2026-08-07)

Batch 882 hit every pre-registered number — `cache.splatCount` 27, added
**18.995%** against WebGL's 19.141%, parity **31.946% → 2.574%**, blockers `[]`,
exit 0. `probe-splat-sort` and `probe-oit-transparency` came back GREEN (the
axis-aligned NaN guard held, as the executed battery predicted).
`probe-splat-globe-occlusion` check 3 went RED: `greenPx=1436` against a `<50`
bar. **It is not a splat defect, and it is not `C15-G3b`.**

##### (a) Was check 3 passing before, and on what margin?

Yes, and on the largest margin available. `DEFERRED_WORK.md` records the B647
acceptance verbatim: the GREEN splat "stays HIDDEN (**0 px**) behind the globe,
proving the fix is not 'always on top'". Zero, not "under 50".

And the coordinator's framing question answers itself once the numbers are in:
**a BIGGER below-surface splat leaks MORE countable pixels, not fewer.** The
probe counts a pixel green when `g > 150`, which after the premultiplied blend
means the splat's alpha there must exceed `(150/255 - dstG)/(1 - dstG)`. Invert
each falloff for the radius of the disc that clears that bar:

| | falloff | countable radius | countable area |
| --- | --- | --- | --- |
| pre-`C15-G3b` (Batch 288 conic) | `a * exp(-0.5 (r/sigma)^2)` | `1.10-1.38 sigma` | 4x |
| post-`C15-G3b` (WebGL parity) | `a * exp(-2 (r/sigma)^2)` | `0.55-0.69 sigma` | 1x |

The ratio is **exactly 2 in radius and exactly 4 in area, independently of the
globe colour behind the splat** — both profiles are gaussians differing only by
a constant in the exponent, so whatever threshold the blend produces, the
countable radius halves. The spec executes this over the whole plausible `dstG`
band and asserts the ratio to 1e-9.

##### (b) The three candidate mechanisms, scored

1. **"The sharper falloff pushed sub-threshold leak pixels over the bar."**
   **REFUTED, with a factor.** It moves them the other way: post-`C15-G3b`
   every leak pixel is *less* opaque and the support is a strict subset
   (half-extent `sqrt(2) sigma` versus `3 sigma`). For any fixed depth-test
   outcome the new count is a QUARTER of the old one. The 1,436 px measured
   today would have counted **~5,743 px** under the old footprint — i.e. if
   this leak had existed at B647 it would have failed the `<50` bar by more
   than a hundredfold, and B647 recorded 0.
2. **"The new quad axes move where fragments land relative to the globe's
   depth."** **REFUTED at the source, and pinned.** The expansion writes
   `fp.x`/`fp.y` only; `z` and `w` are copied from the splat centre's clip
   position and never touched, so every fragment of the quad carries the
   CENTRE's depth exactly as before, and the log-depth varying is
   `csm_vertexLogDepth(clipPos, ...)` — the centre, not the corner. A spec
   anchor now forbids the expansion writing `fp.z`/`fp.w`, on both the colour
   and the velocity vertex shaders.
3. **The `NEW-SPLAT-MULTIFRUSTUM-DEPTH-COMPOSE` / `C15-G6` gap.** **Not this
   either.** A compose or binning gap manifests where the globe EXISTS and the
   splat is ordered against it wrongly. Here the globe does not exist over the
   leak pixels at all.

##### The actual cause: there is no globe over the splat, and the probe had no way to notice

Read the PNGs. `output/splat-occlusion-default.png` from the Batch-882 run shows
the globe confined to a **vertical strip on the right ~24% of the canvas**;
everything else is black, with the red splat and a **fully-formed green core**
floating over it, plus the Cesium viewer chrome (toolbar, the open navigation-
help panel, timeline, credits) — which this probe never hid.

The green core is a **filled disc, not an annulus**, and it measures what a
completely unoccluded splat should measure. From the probe's own geometry — a
600 m isotropic splat 3 km below the surface, nadir camera at 8 km, 1024x700,
default 60-degree fov — the projected sigma is **33.1 px**, and the fully
visible countable disc is **1,154-1,436 px** across the plausible globe-green
band. The run measured **1,436**. Not the tail of a partial occlusion: the depth
test rejected **nothing**, because there was nothing in front to reject it.

**Why the probe scored that as a splat defect.** Two blind spots, both of which
made the failure mode invisible by construction:

* `globePixels` was **derived**, as `nonBlack - red - green`. The red splat's
  own sub-threshold halo (bright enough for `isNonBlack`, too dim for `isRed`)
  and every viewer-chrome pixel therefore counted as "globe". Check 1
  (`globePixels > 20000`) **could not fail for "the globe did not render"** —
  and it duly passed on this run.
* Check 3 read the undifferentiated green count. `green < 50` is equally
  satisfied when the splat never drew; `green >= 50` is *guaranteed* whenever
  the globe is absent at the splat's pixels. The check had no way to tell a
  depth-compare leak from an empty background.

Corroboration that this is scene state rather than splat state: the stale
July-10 artifact `output/splat-occlusion-deferral-armed.png` (from an older
probe revision) shows the same scene with **no globe at all** and the green core
plainly visible — so this probe's globe has been unreliable for a while, and
the checks were structurally unable to report it.

##### (c) What landed — instrument, not engine

No engine change. The footprint is NOT reverted: it is correct, `C15-G8`
depends on it, and reverting would trade a real parity fix for a probe artifact.

`probe-splat-globe-occlusion.mjs` now measures the globe on its **own frame**,
with both splats hidden and the viewer chrome hidden, and splits the verdict
**per pixel by what is behind it**:

* `greenOverGlobe` — green pixels that DO have globe behind them. **Product
  check 3**, threshold unchanged at `< 50`.
* `greenOverVoid` — green pixels with nothing behind them. **Precondition P1**,
  STRUCTURAL: occlusion is not evaluable there, and filing it as a splat defect
  bills the wrong subsystem.
* Check 2 keeps its original meaning (the splat is RENDERED, not dropped — the
  C7-SPLAT-DEPTH-COMPOSE guard it was written for) and the "composed OVER the
  globe" half becomes **precondition P2** (`redOverGlobe > 2000`), because a
  splat drawn over empty space is not a splat defect either.
* Check 1 now reads the splats-hidden, chrome-hidden globe count directly, so
  it CAN fail for a missing globe.
* The viewer loads with `&offline=true` so a missing ion token cannot change
  what is on the canvas, and structural runs **exit 3** — never 0 (which would
  certify an unevaluated subject) and never 1 (which would file it as a splat
  defect).

The missing globe itself is filed separately as
`NEW-WEBGPU-OCCLUSION-PROBE-GLOBE-ABSENT` in `DEFERRED_WORK.md`. It is a globe
/ scene-setup question, not splat work, and it now has an instrument that
reports it in its own words.

##### Pre-registered prediction for the re-run

`node Tools/visual-regression/probe-splat-globe-occlusion.mjs`, same scene:

* **P1 STRUCTURAL** with `greenOverVoid` ≈ **1,400-1,450** (essentially all of
  the green), and **check 3 GREEN** with `greenOverGlobe` ≈ **0** — the splat
  is correctly occluded everywhere the globe actually is.
* **P2 STRUCTURAL** with `redOverGlobe` ≈ 0 (the red splat sits over the black
  region), **check 2 GREEN** (`red` still > 2000 — it renders).
* Check 1: `globePixels` now measured honestly. On the Batch-882 scene the
  right-hand strip is ~170,000 px, so **check 1 passes**; if the globe is
  absent entirely (the July shape) it reads **< 20,000 and check 1 FAILS**,
  which is the signal that was missing all along. Either outcome is
  informative; both are honest.
* Checks 4, 5, 6 unchanged and green.
* **Overall exit 3 (INCOMPLETE — structural), not 1.** The splat subsystem is
  exonerated by the run itself rather than by this document.

*Named ways this comes back other than predicted:* `greenOverGlobe >= 50` —
then there IS a genuine depth-compare leak where the globe exists, `C15-G6`/
`C15-G7` inherit it with per-pixel evidence, and the arithmetic above says it
was ~4x worse before `C15-G3b`. `greenOverVoid === 0` and check 3 green — the
globe came back on its own (a load-timing flake), and P1 is then the standing
guard that stops the flake being scored as a splat verdict ever again.

*Gates:* `node --test gsplat-harness.spec.mjs` **117/117** (108 preserved);
prettier + eslint clean on both touched files; no engine file modified, so tsc
and Naga are unchanged from Batch 882. **Negative control (file copy):** with
the pre-`C15-G3c` probe restored, exactly **6 of 117** go red — the contract
anchor and its 5 mutants — while the three arithmetic/engine tests stay green,
which is the right separation: they do not depend on the probe's contract. File
restored, md5-verified.


#### `C15-G3d` — there is no inversion: two ABSOLUTE colour predicates misreported a scene they were never calibrated for (worker, 2026-08-07)

Batch 883's re-run fired the SECOND falsifier: the globe came back
(`greenOverVoid=0 of 1460`, P1 green — the globe-absent flake is
nondeterministic and P1 now stands guard as designed). The reported signature
was **inversion**: `redOverGlobe=33 of 33` for the ABOVE-surface splat (6,200 in
Batch 882) against `greenOverGlobe=1460` for the BELOW-surface one. **The
inversion is not real.** One defect survives, and it is not the one the
signature suggested.

##### Read the PNG first

`output/splat-occlusion-default.png` from the Batch-883 run shows the globe
covering the whole frame (olive, pale-green grid) with **both splats plainly
composited over it**: a soft red/orange halo, and a saturated green core at its
centre. The RED splat is *not* hidden. It is right there, doing exactly what
check 2 asks of it.

##### Why `redOverGlobe` collapsed to 33 — arithmetic, executed in the spec

`isRed` is `r > 150 && g < 90 && b < 90`, an ABSOLUTE predicate calibrated
against the Batch-882 scene where the globe was absent and splats sat on black.
Over the olive globe the band is still wide (alpha ≥ 0.412 qualifies, wider than
the 0.588 needed over black) — so the background alone does **not** explain the
collapse. What closes it is the **GREEN splat drawn on top of the red one**:

| fragment | r/g/b | isRed? | isGreen? |
| --- | --- | --- | --- |
| red splat, alpha 0.74, over black | 191/9/9 | yes | no |
| red splat, alpha 0.74, over olive | 209/33/26 | yes | no |
| ...then veiled by green at alpha 0.304 | **149/98/22** | **no** (r ≤ 150) | **no** (g ≥ 90) |

The veiled annulus falls in the **gap between the two absolute predicates** —
counted by neither — which is why BOTH numbers read low and the pair looked
inverted. Only a razor-thin band clears `r > 150`: 33 px. Executed in
`gsplat-harness.spec.mjs` against the real blend, both directions.

Symmetrically, the globe's own **pale-green GridImageryProvider lines satisfy
`isGreen` with no splat present at all**, so an unknown share of the 1,460 was
never splat.

##### The three candidates, scored

1. **Log-depth / reversed-Z compare mismatch — REFUTED.** No reversed-Z exists
   at HEAD: the WebGPU renderer census is 51 `depthCompare: "less-equal"`, 2
   `greater`, 1 `less`, 4 `always`, 1 `equal`, 1 `not-equal`, and every splat
   pipeline is `less-equal` with the fleet's 1.0 depth clear. A migration would
   have flipped the fleet, not one renderer. **And the signature is wrong for
   it:** a flipped compare hides the NEAR splat. The near splat is not hidden.
2. **The `C15-G3b` footprint port — REFUTED.** The expansion writes `fp.x`/
   `fp.y` only (pinned since `C15-G3c`), and the `SPLAT_PACKED_WASM` define
   reaches only the shader MODULE and the descriptor NAME — `depthStencil` is
   byte-identical across both variants, now asserted by slicing the colour
   descriptor and checking the marker never appears inside it.
3. **Nondeterministic scene state — CONFIRMED as a separate, already-filed
   thing** (`NEW-WEBGPU-OCCLUSION-PROBE-GLOBE-ABSENT`): Batch 882 had no globe
   over the splats, Batch 883 had a full one. That is why the two runs' numbers
   are not comparable, and it is why P1 exists.
4. **The 33-px red — answered:** the same predicate artifact, not occlusion.

##### The one real defect

**The below-surface splat is not occluded by the globe.** Its saturated core is
unmistakable in the PNG, over a fully-covering globe, 3 km underground.

And the *near* splat composing correctly while the *far* one leaks means **every
splat fragment beats the globe's depth, near and far alike**. That is the
signature of an **encode-space mismatch** — the splat's depth is uniformly
smaller than the globe's — and specifically NOT of a flipped compare, which
would have hidden the near one. Both producers read the same two
`UniformState` fields (`currentFrustum`, `oneOverLog2FarDepthFromNearPlusOne`,
verified identical in source), so the mismatch is in WHEN or WHETHER each
applies them: a splat writing log depth against a globe writing hyperbolic (or
vice versa) puts every splat fragment on the near side of everything, exactly as
observed.

**Not fixed in this round, deliberately.** Which of those it is cannot be
determined offline, and the honest next step is one instrumented run rather than
a speculative shader edit. This is `NEW-SPLAT-MULTIFRUSTUM-DEPTH-COMPOSE` /
`C15-G6` territory — the per-frustum UBO re-pack that `DEFERRED_WORK.md`
already names as the deliverable — and `C15-G6` now inherits per-pixel evidence
plus a probe that reports the discriminating inputs.

##### What landed (instrument only; no engine change)

* **Delta classification.** A pixel is splat-painted iff it DIFFERS from the
  globe-only frame by ≥ 12/255 in some channel, classified by which channel
  moved most. Background-independent: the globe's green grid can no longer be
  counted as leaked splat, and a veiled red annulus can no longer vanish.
  Checks 2 and 3 and precondition P1 now read `redPainted`,
  `greenPaintedOverGlobe` and `greenPaintedOverVoid`; the absolute figures are
  still printed alongside so the transition is legible in the log.
* **Log-depth diagnostics**, printed on a `(diag)` line:
  `logDepthWriteEnabled`, `useLogDepth`, `currentFrustum` near/far,
  `oneOverLog2FarDepthFromNearPlusOne`, the stashed `_logDepthEncodeNearFar` /
  `_logDepthEncodeFactor`, and `numFrustums` — the inputs BOTH encoders derive
  from, so the next run names the mismatch instead of narrowing it.

##### Pre-registered prediction for the re-run

`node Tools/visual-regression/probe-splat-globe-occlusion.mjs` — and, for
candidate 3, **run it 3× and compare these fields across runs**:
`globePixels`, `greenPaintedOverVoid`, `numFrustums`, and the whole `(diag)`
line. Per-run variation in `globePixels`/`greenPaintedOverVoid` is the
globe-absent flake; variation in the `(diag)` values is a frustum-state
dependency; stability in both with `greenPaintedOverGlobe` high is a
deterministic encode defect.

* **Check 2 GREEN**: `redPainted` ≈ **4,000-6,000** (was reported as 33 under
  the absolute predicate) — the red splat was always composing.
* **Check 3 RED, honestly**: `greenPaintedOverGlobe` ≈ **1,200-1,460**, still
  above the `< 50` bar. This is the real defect and it should NOT go green until
  the encode is fixed. Some of the previous 1,460 was grid line, so a modest
  drop is expected and is not a fix.
* **P1 GREEN** (`greenPaintedOverVoid = 0`) if the globe covers, STRUCTURAL
  otherwise — either is informative.
* **P2 GREEN** (`redPainted > 2000 && globePixels > 20000`).
* **Exit 1** — a real product FAIL, correctly attributed for the first time.
  (It exits 1 today too, but for the wrong reason on the wrong check.)

**After the encode fix lands (`C15-G6`), the acceptance is:**
`greenPaintedOverGlobe < 50`, `redPainted` unchanged at ~4,000-6,000,
P1/P2 green, **exit 0**.

*Gates:* `node --test gsplat-harness.spec.mjs` **124/124** (117 preserved);
prettier + eslint clean on both touched files; no engine file modified, so tsc
and Naga are unchanged from Batch 883. **Negative control (file copy):** with
the pre-`C15-G3d` probe restored, **9 of 124** go red — the two contract
anchors, the diagnostics anchor and all 6 probe mutants — while every engine
and arithmetic test stays green. File restored, md5-verified.


#### `C15-G6e` — the encode hypothesis was MINE and it is REFUTED by its own follow-up data (worker, 2026-08-07)

Batch 885 resolved the decision tree to its cleanest branch: three **bit-identical**
runs, `greenPaintedOverVoid=0` (globe present every time), `redPainted=30961`
stable, and a `(diag)` line identical to the last digit —
`writeEnabled=true useLogDepth=true currentFrustum=[0.1, 1e8]
factor=0.037628749439612946`, `stashedNearFar=[0.1, 1e8]`. Deterministic, not
the flake, not frustum state.

**And those values kill the hypothesis I filed at `C15-G3d`.**

##### 1. The reconstruction, executed

`factor` is exactly `1/log2(far - near + 1)` — reproduced to the last digit
(`0.037628749439612946`), which identifies the quantity and proves both
producers derived it the same way. The shared formula is
`log2((w - near) + 1) * factor`. At the probe's geometry:

| fragment | eye distance | encoded depth |
| --- | ---: | ---: |
| splat ABOVE surface | 6,000 m | **0.472277** |
| globe surface | 8,000 m | **0.487892** |
| splat BELOW surface | 11,000 m | **0.505179** |

`above < globe < below`. Under the `less-equal` compare every splat pipeline
declares, that arithmetic says the above-surface splat passes and the
below-surface splat **fails** — the correct behaviour. **There is no encode
mismatch to fix.**

The two "contradictory rationales" in the splat renderer's comment block turn
out not to be a fork at all at these values: the stashed full-frustum pair and
the live `currentFrustum` are **the same numbers** here (`[0.1, 1e8]`), so the
choice between them cannot produce the symptom either.

##### 2. Why an encode mismatch was never possible here

The splat and the globe each carry an *inline copy* of the log-depth helpers
(neither uses the `#import` chunk system). "Keep them in sync" was a comment;
it is now a test. `gsplat-harness.spec.mjs` extracts
`csm_vertexLogDepth`, `csm_writeLogDepth` and `csm_updatePositionDepth` from
the splat WGSL, from `Globe/GlobeTerrain.wgsl` and from the canonical
`chunks/functions/*.wgsl`, strips comments, and requires all three to be
**character-identical** — plus an explicit guard that neither side grows
WebGL's `* 0.5` NDC factor (correct for GL's `[-1,1]`, wrong for WebGPU's
`[0,1]`, and the classic way this family breaks). Two mutants must be rejected.
The CPU side is pinned too: both read `currentFrustum?.x` and
`oneOverLog2FarDepthFromNearPlusOne` and both carry the same
`Math.log2(ldFar - ldNear + 1.0)` fallback.

So: **identical formula, identical inputs, correctly-ordered outputs.** No
engine change was made, because there is nothing here to change.

##### 3. What is left, and the control that separates it

Every splat fragment still beats the globe. With the encode excluded, the live
hypotheses are all about the splat **pass**: the depth attachment it tests
against does not contain the globe's depth (cleared, resolved, or a different
attachment), or the declared `depthCompare`/`depthWriteEnabled` is not what
executes.

That is a different subsystem, and guessing at it is exactly what this track
has repeatedly punished. So the probe gained the discriminator instead: a
**`PointPrimitiveCollection` point at the SAME 3 km below-surface position** —
a different shipped renderer that is also a renderer-wide log-depth producer
(Batch 250) — classified `bluePaintedOverGlobe` and checked as **check 7**:

* **blue OCCLUDED + green LEAKING** → the defect is specific to the splat pass.
* **blue ALSO LEAKING** → the globe's depth is not in the buffer these passes
  test against at all, and the subject is the scene framebuffer, not the splat
  renderer.

One run, and the next round starts in the right subsystem.

##### 4. Closing out the `redPainted` prediction honestly

Predicted 4,000-6,000; measured **30,961**. **The prediction was computed with
the wrong metric, and that is my error, not a surprise in the data.** The
4,000-6,000 band came from the ABSOLUTE `isRed` bar (`r > 150` ⟹ alpha ≥ 0.412
⟹ r ≤ 0.646σ ⟹ ~4,800 px) — but `C15-G3d` had just replaced that check with the
DELTA bar (≥ 12/255 in the dominant channel), and I predicted the new check
using the old check's arithmetic.

Redone with the delta bar: `dr = (1 - dst_r)·alpha ≥ 12/255` ⟹ alpha ≥ 0.067 ⟹
`r ≤ 1.15σ`. At σ ≈ 60.6 px that is **~15,300 px** — the right order, and
**2.03× short** of the measurement. Two candidates for the residual, neither
verified and neither affecting any verdict: the pixel counts run on
`canvas.width/height` (the drawing buffer), so a `devicePixelRatio` above 1
scales every count by DPR² — 2.03× corresponds to DPR ≈ 1.42; or my σ estimate
(60° fov, 1024×700, aspect-derived focal) is off. **The honest form for this
round is therefore a RATIO, not an absolute**: the fix touches depth only, so
`redPainted` must stay within ±10% of 30,961.

##### Pre-registered predictions for the re-run

`node Tools/visual-regression/probe-splat-globe-occlusion.mjs`:

* **Check 7 (new control) is the load-bearing number.** No prediction is
  offered for it — that is the point of a discriminator; predicting it would
  be predicting the answer. Both outcomes are named above and both are
  actionable.
* `redPainted` **27,900-34,100** (30,961 ±10%) — depth-only changes cannot
  move the footprint.
* `greenPaintedOverGlobe` ≈ **2,752 unchanged**, still RED against the `< 50`
  bar. **This round does NOT make check 3 green**, and any drop would need
  explaining rather than celebrating.
* `greenPaintedOverVoid = 0`, P1/P2 green; `numFrustums` and the whole
  `(diag)` line **byte-identical to Batch 885**.
* **Exit 1** — a real product FAIL, still correctly attributed, now with the
  subsystem named by check 7.

**When the real fix lands, the acceptance for the full four-instrument suite
is:** `probe-gsplat-parity --expect-webgpu` exit 0 (`splatCount 27`, added
≈18.995%, parity ≈2.574%, `WEBGPU-SPLATS-PRESENT`); `probe-splat-sort` PASS;
`probe-oit-transparency` PASS; `probe-splat-globe-occlusion`
`greenPaintedOverGlobe < 50`, `bluePaintedOverGlobe < 50`, `redPainted`
unchanged, P1/P2 green, **exit 0**.

*Gates:* `node --test gsplat-harness.spec.mjs` **131/131** (124 preserved);
prettier + eslint clean. **No engine file was modified** — the round's finding
is that there is nothing to modify here — so tsc and Naga are unchanged from
Batch 884, and the four `(LOG_DEPTH × SPLAT_PACKED_WASM)` variants are the same
bytes Naga validated there. **Negative control (file copy):** with the
pre-`C15-G6e` probe restored, the control anchor and its dependants go red
while the arithmetic and formula-identity tests stay green — they do not depend
on the probe.


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

#### `C15-G4` implementation record + pre-registered predictions (2026-08-07, worker)

**Dataflow at HEAD, re-read rather than inherited.** The row was written against
the Batch-288 picture ("the renderer runs a synchronous main-thread sort"). That
picture is two rows out of date, and saying so is part of the deliverable:

1. `GaussianSplatPrimitive.update` (`:1305`) calls `_updateSplatData(frameState)`
   and only THEN `fr.update(this, frameState)`. Every sort schedule —
   the pending-snapshot sort (`:1691`) and both steady-state sorts (`:1749`,
   `:1783`) — lives inside `_updateSplatData`, i.e. above the backend branch, so
   the WASM worker sort has run on the WebGPU path since `C15-G2` (Batch 878).
2. `resolveSteadySort` (`:806`) publishes to `_indexes`;
   `resolvePendingSnapshotSort` (`:739`) publishes via `commitSnapshot` (`:437`),
   which swaps `_indexes` and `_packedSplatTextureData` in the same statement
   run — so the WebGPU cache can never hold packed bytes without a matching
   permutation, and the identity seed written at buffer reallocation is
   overwritten in the same frame.
3. `uploadProvidedSortOrder` (renderer) writes that permutation to
   `sortedIndexBuffer`; `maybeSortSplats` returns immediately for
   `cache.layoutPacked`, which every production commit sets.

So the "consume the WASM sort" half was already done. The parts that were NOT:
the permutation carried no provenance, the consumer's only staleness test was
array identity, and "the comparator never runs" had no observable — it was an
inference from source shape. Those three are what this row built (ledger row
above for the mechanism).

**The command-level `_backToFrontSplatsComparator` is OUT OF SCOPE and correct
as-is.** Batch 888's bounding-volume fix did make it run for the first time, but
it sorts **draw commands** by camera distance
(`WebGPUSceneRenderer.ts:379/498-517`), mirroring the shared
`Scene/CommandSorter.js#backToFrontSplats` that `SceneRenderer.js:212` runs on
WebGL. It is the cross-command ordering, not the per-splat ordering, its cost is
O(commands) with one splat command per primitive, and forking it would break
WebGL/WebGPU parity in the command sorter. Left alone.

**Pre-registered predictions.** Both legs in one run, pinned clock. New
observables print on the `sort:` line.

*`sh_unit_cube` (27 splats) — expected UNCHANGED from the `C15-G3` acceptance.*
27 elements sort trivially and the packed early-out was already in place at
Batch 882, so this leg is a REGRESSION check, not a measurement of the row:
`numSplats` 27/27, `cache.splatCount` 27, `splatPassCommands` 1/1,
added **18.995%** WebGPU vs **19.141%** WebGL (band 17.8–21.0%), parity mismatch
**~2.574%** (the `C15-G5` SH baseline — unchanged, since SH is untouched here),
blockers `[]`, `WEBGPU-SPLATS-PRESENT`, exit 0. New counters:
`comparatorSorts=0`, `providedSortUploads >= 1`, `supersededSortUploads=0`.
Any movement in added% or mismatch on this leg is a REGRESSION, not a result.

*`tower` (286,868 splats) — the row's real gate, never yet run on WebGPU.*

| observable | prediction | derivation |
| --- | --- | --- |
| `numSplats` / `cache.splatCount` | exactly **286,868**, both legs | single-tile tileset (`root.content = 0/0.glb`, no children, `geometricError 0.0`) so there is no LOD subsetting, and the texture hard cap is `maxTex*(maxTex/2)` ≈ 33.5 M at `maxTex=8192` — three orders of magnitude clear, so `splatBudgetSSEScale` stays 1.0 |
| `splatPassCommands` | **1 / 1** | one `GaussianSplatPrimitive` per tileset → one splat command, as measured on `sh_unit_cube` |
| `cacheSplatRecordBytes` / `packedWords` | **32** / **>= 2,294,944** (`286,868 * 8`) | packed WASM record, `C15-G3` Option B |
| **`comparatorSorts`** | **0** — the row's gate | `layoutPacked === true` on every production commit, so the comparator returns before allocating its `Float64Array(286868)` |
| **`providedSortUploads`** | **>= 1** — the anti-vacuity partner | 0/0 would mean nothing sorted at all, which passes the gate for the wrong reason |
| `supersededSortUploads` | **0** at a settled camera | one sort in flight at a time (`_sorterPromise` is single-slot); a non-zero value is informative, not a failure |
| added% agreement | **`added_webgpu / added_webgl` in [0.90, 1.10]**, and the absolute gap `<= 2` percentage points | this is the FALSIFIABLE tower prediction. `sh_unit_cube` measured 0.992 (18.995/19.141) after the `C15-G3b` footprint port, and the footprint math is shared |
| added% absolute | **5–45%**, weakly constrained | no prior tower run exists; the tower's bounding box is a tall thin 8.4 × 8.1 × 36.6 m half-extent volume, so the framed silhouette is a narrow vertical band, not a disc. Stated as a band precisely so a wildly-outside value is diagnosable — the RELATIVE agreement above is the real gate |
| `dataReady` wall clock | **true on both legs**; `dataReadyMs_webgpu / dataReadyMs_webgl <= 1.5`, WebGL itself **1.5–8 s** | 7.5 MB SPZ glb through two WASM workers dominates; the shared pipeline is now byte-identical up to the FR dispatch, and WebGPU's only extra work is retaining the 9.2 MB packed payload plus one `writeBuffer`. The G1-era budget is `min(120 s, max(30 s, 4 x webgl.dataReadyMs))`, so 1.5x is comfortably inside it |
| **no main-thread stall** | asserted by **`comparatorSorts === 0`** (a count, not a timing), corroborated by the two timings above staying inside the 4x budget and by `rendererCommitMs` not growing with splat count | a per-frame 286k-element `Array.prototype.sort` would show as the budget expiring or `rendererCommitMs` blowing out; the count is the direct evidence and the timings are the cross-check |

**Off-gate:** WebGL output must be byte-identical. The producer change is
additive (two new stamp fields plus a refusal that `isActiveSort` already makes
unreachable on the steady path), and `buildGSplatDrawCommand` reads only
`_indexes` — unchanged. `capture-and-diff` + both `GaussianSplat*Spec` suites
are the standing check.

#### `C15-G4b` — the determinism control's own refusal, fixed (2026-08-07, worker)

**What happened.** The Batch-890 `tower` run put every `C15-G4` observable
exactly on prediction — 286,868/286,868 both legs, `comparatorSorts=0`,
`providedUploads=1`, `superseded=0`, added ratio **1.002** (4.085% vs 4.076%),
data commit 233 ms WebGPU vs 451 ms WebGL (0.52x) — and then exited **3** on
`reference:capture-determinism`: the **WebGL** leg measured 0.052% (410 px)
against a 0.050% bar, with WebGPU at 0.042% (329 px). `sh_unit_cube` read
0.000%. The instrument correctly refused to certify parity against a reference
that cannot reproduce itself to its own spec.

**The proposed mechanism is REFUTED, and the record says so rather than
adopting it.** The hypothesis was that a steady sort resolves between the two
captures. It cannot, at this camera:

- The probe sets the camera **once** (`lookAt` + `lookAtTransform(IDENTITY)`,
  `probe-gsplat-parity.mjs:479-485`) and never touches it again;
  `useDefaultRenderLoop` is off, so no controller inertia runs either. So
  `positionDelta = 0` and `angleDelta = 0` in `shouldStartSteadySort`
  (`GaussianSplatPrimitive.js:179-215`), which needs **≥ 1.0 m** or **≥ 0.5°**.
  It returns `false`. The one steady sort that DOES fire is the bootstrap
  (`!_hasLastSteadySortCameraPosition`), and it fires immediately after
  `commitSnapshot` — six settle-seconds before `onA`.
- Second, independent argument: the leg that varied MORE does LESS splat work.
  On WebGL `_drawCommand` is defined, so `_updateSplatData`'s
  `!hasPendingWork && Matrix4.equals(viewMatrix, _prevViewMatrix)` early-return
  fires every settled frame; on WebGPU `_drawCommand` is never defined, so
  `hasPendingWork` is always true and the function runs to the throttle. WebGL
  measured 410 px, WebGPU 329.

**What the true cause is: not pinned, and not guessed at.** The scene setup
already excludes every synchronous source — clock pinned and `shouldAnimate`
false, TAA off (`Scene.taaEnabled` defaults `false`, the probe never sets it),
HDR and auto-exposure off (`highDynamicRange = false`,
`_autoExposureEnabled = false`), globe/sky/sun/moon hidden, background black,
`requestRenderMode` false. What was left is asynchronous work landing on
event-loop yields — and the old pair had `await settleMs(2000)` between its two
captures, i.e. thousands of yields.

**So the fix is structural over the whole class, not aimed at one member:**

1. **The pair is taken back-to-back in ONE task.** No `await` between
   `onA = captureNow()` and `onB = captureNow()`, so no promise continuation,
   worker message or timer can interleave — that is the JS execution model, not
   a timing hope. `analyzeAdded`, the command counts and `sampleRendererStats()`
   all moved BELOW both captures and stay in the same task, which also
   strengthens the `C15-G3b` same-task-sampling rule rather than weakening it.
2. **A new STRUCTURAL precondition `sort-quiesced`**, checked immediately before
   `capture-determinism` because it is a precondition of it.
   `waitForSortQuiescence` renders until the sort provenance holds steady for a
   full settle window with nothing in flight. The signature is **backend-neutral
   on purpose** — it reads `_indexesSortSequence` / `_indexesDataGeneration`
   (the `C15-G4` stamp) plus `_sortRequestId` and `_indexes.length`, because the
   leg that failed is the one with no `_webgpuCache`; the WebGPU counters ride
   along when present. `sortInFlight` covers `_sorterPromise`,
   `_pendingSortPromise` and `_pendingSnapshot`.
3. **The 0.050% bar is untouched.** It is what caught this, and a mutant now
   forbids widening it.

The temporal-stability check the old 2 s window provided is not lost — it moved
into the quiescence wait, which requires stability across a full settle window
before either capture is taken.

**Is a resolved sort visible to users?** Arithmetically yes: re-ordering
overlapping premultiplied splats changes the composite, so the frame after a
sort resolves differs from the frame before it. That is the **designed**
behaviour of an asynchronous sorter and WebGL has had it since upstream shipped
`gaussianSplatSorter` — same worker, same 3-frame/1 m/0.5° throttle, on both
backends since `C15-G2`. The re-sort is the order *catching up* to a camera that
has genuinely moved, not a corruption. **Filed as expected behaviour, not a
defect**, and no numbers here support escalating it: the only measurement in
hand (410 px on a ~32,000 px footprint, at byte-exact comparison, i.e. mostly
±1 LSB) is at a camera that never moved at all.

*Pre-registered — and CONDITIONAL, because the mechanism is not pinned.* The
same-task pair is the discriminator and both branches are decidable in one run:

| branch | reading | what it means |
| --- | --- | --- |
| **A (expected)** | `determinism` ≤ 0.050% on BOTH legs, `sortQuiesced=true` both, `tower` exit **0** | the cause was an async resolution landing in the old 2 s window. Class closed. |
| **B** | `determinism` still ≈ 400 px with `sortQuiesced=true` | the variance is INTRA-FRAME — two consecutive `scene.render()` calls on a byte-identical scene differ. That is a new and more interesting finding than the one we set out to fix, it is NOT a splat-sort problem, and the instrument now says so with a named precondition instead of a bare threshold. File it with the numbers; do not widen the bar. |

Unchanged in either branch, and all re-asserted by the run: `numSplats`
286,868/286,868, `comparatorSorts=0`, `providedUploads ≥ 1`, `superseded=0`,
added ratio in **[0.90, 1.10]** (Batch 890 measured 1.002), `sh_unit_cube` at
18.996% with determinism 0.000%.

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

#### `C15-G5` implementation record + pre-registered predictions (2026-08-07, worker)

**IMPLEMENTATION DONE — pending orchestrator landing + Edge run.** Files:
`WebGPUShaderDefines.ts` (new hi bit), `WebGPUGaussianSplatRenderer.ts` (WGSL +
CPU), `GaussianSplatPrimitive.js` (the shared budget), `gsplat-harness.spec.mjs`
(194 → 217), `WebGPUShaderDefinesSpec.js` (a red-at-HEAD pin repaired, below).

**The SH dataflow at HEAD, end to end.** `GaussianSplat3DTileContent.update`
infers the degree from the `SH_DEGREE_n_COEF_m` attribute COUNT
(`degreeAndCoefFromAttributes`: 3 / 8 / 15 attributes → `l` = 1 / 2 / 3,
`n` = 9 / 24 / 45 floats) and `packSphericalHarmonicsData` interleaves them into
a `Uint32Array` at **`dims * 2` u32 per splat**, coefficient `i` at word
`splat * dims * 2 + i * 2` (low word = f16 pair (r, g); high word = f16 b in its
LOW half). `GaussianSplatPrimitive` aggregates the per-tile arrays into
`snapshot.shData`, `commitSnapshot` publishes it to `primitive._shData` +
`_sphericalHarmonicsDegree` **for both backends**, and WebGL then regroups it —
row `r` holding splats `[r·splatsPerRow, …)` at `floatsPerRow = splatsPerRow ·
dims · 2` words — into an `RG32UI` texture that `PrimitiveGaussianSplatVS.glsl`
fetches at `((splatID % splatsPerRow)·dims + index, splatID / splatsPerRow)`.
That texel address **algebraically reduces to the same flat word**, which is why
the WGSL consumes `_shData` VERBATIM (the `C15-G3` Option-B precedent) instead of
inventing a packing; the identity is executed over
maxTex × dims × splat × index sweeps in the spec. Degree selection stays a
RUNTIME uniform in both languages (`u_sphericalHarmonicsDegree` ↔ `u.shDegree`),
with a define gating only whether the block exists.

**DC-term determination — the base RGBA8 ALREADY CONTAINS the DC band, so the
WGSL adds bands 1–3 ONLY.** Four independent in-tree confirmations, three of
them now pinned: `GltfSpzLoader.js:23-24` states it outright ("Degree 0 has no
extra SH data (base color is stored separately in the 'colors' attribute)"); the
writer's per-degree float offsets are `base = [0, 9, 24]`, i.e. band 1 starts at
0 with nothing reserved ahead of it; degree 3 is 15 attributes / 45 floats, not
16 / 48; and the GLSL composes `v_splatColor.rgb += evaluateSH(...)` — an ADD
onto the unpacked RGBA8, never a replacement. The WGSL therefore writes
`vec4(s.color.rgb + evaluateSplatSH(...), s.color.a)` and carries no `SH_C0`,
no `0.28209…` and no `sh0` anywhere. **A double-count would brighten every splat
by ~2×** and is the row's dedicated mutant.

**Layout/consumption decision.** `_shData` bound as a `read` storage buffer at
**group 0, binding 4**, declared UNCONDITIONALLY (outside every `//>>ifdef`), so
the BGL, the bind group and the pipeline layout are literally the same objects
for both states of the new define — the `C15-G3` topology discipline. Non-SH
content binds a 16-byte placeholder. The UBO grows **320 → 384 bytes**:
`shViewRotation: mat3x3<f32>` at byte 320 and `shDegree: f32` at byte 368 (the
spec computes those offsets with a WGSL layout calculator that first has to
reproduce all four pre-existing write offsets — 160 / 176 / 192 / 256 — before
its verdict on the new tail counts).

**View direction — matched by folding, not by round-tripping.** WebGL evaluates
against `normalize(u_inverseModelRotation · (splatWC − cameraWC))`. The WGSL has
no world-space splat position, only the RTE residual `posRTE`; for a model
matrix `M = [A | t]` with the camera encoded in model space,
`A · posRTE = A·p − A·M⁻¹c = (A·p + t) − c = splatWC − cameraWC` **exactly, for
any invertible A** (the translation cancels in the difference). So the CPU packs
one matrix, `_shInverseRotation · mat3(modelMatrix)`, and the shader does
`normalize(u.shViewRotation * posRTE)`. The identity is executed in the spec
against both a rigid ENU frame at planetary scale and a deliberately non-rigid
(scale + shear) matrix.

**Degree fallback (`NEW-SPLAT-SH-DEGREE-BACKEND-DEPENDENT`) — option (a),
degrade together.** New backend-neutral `applySphericalHarmonicsBudget` runs
ABOVE the `_featureRenderer` branch; the WebGL half consumes the row addressing
it returns and no longer owns the rule. Divergence condition, computed and
recorded: the fallback fires at `numSplats > maxTex · floor(maxTex / bands)` —
**17,891,328 splats at degree 3 / maxTex 16384**, 4,472,832 at maxTex 8192 —
versus `tower`'s 286,868, so it is unreachable for both gate assets and the
choice costs nothing measurable. Full rationale in `DEFERRED_WORK.md`.

**Naga variant matrix — 8/8 validate.** The spec no longer lists combinations;
it enumerates the power set of `SHADER_AXES` and cross-checks that against every
`//>>ifdef` flag the shader text actually gates on, so a fourth axis cannot
leave half the matrix unvalidated:
`{}`, `{LOG_DEPTH}`, `{SPLAT_PACKED_WASM}`, `{SPLAT_SPHERICAL_HARMONICS}`,
`{LOG_DEPTH, SPLAT_PACKED_WASM}`, `{LOG_DEPTH, SPLAT_SPHERICAL_HARMONICS}`,
`{SPLAT_PACKED_WASM, SPLAT_SPHERICAL_HARMONICS}`, and all three.

**Harness 194 → 217.** The headline check EXTRACTS both evaluators from their own
source text — constants, the band-count table, the `shN → coefficient index`
map, the degree guards, and every accumulate term split into (sign, scalar
polynomial, coefficient) — compiles the scalar factors as JS, and requires
agreement to **1e-6** over 46 directions × 3 degrees, with two anti-vacuity
guards (each degree must be non-zero somewhere; each degree must differ from the
one below). The producer half is not transcribed either: the REAL
`packSphericalHarmonicsData` + `float32ToFloat16` are extracted from
`GaussianSplat3DTileContent.js`, executed over a synthetic tile, and read back
through the WGSL's own extracted address arithmetic and channel assembly, so
writer and reader are pinned at the offset level at both ends. **14 mutants**,
each applied to an in-memory copy and each also required to leave the real
source passing: SH_C1 sign flip; degree-2 basis pair swap (yz↔xz); degree-3
constant index swap; degree-3 polynomial 4·zz→3·zz; degree-2 coefficient index
off-by-one; stride widened to 3 words; b channel read from the wrong half;
band table made DC-inclusive (16/9/4); degree guard shifted; view direction left
unrotated; **DC band double-counted at the composition**; SH leaked into alpha;
and two source mutants — the rotation fold applied in the wrong operand order,
and the budget moved back below the backend branch.

**Found on the way, repaired here:** `WebGPUShaderDefinesSpec.js` asserted
`Object.keys(ShaderDefineHi).length === 2` and was therefore **already red at
HEAD** — `C15-G3` added `SPLAT_PACKED_WASM` (hi bit 2) at Batch 881 without
bumping it. Explicit pins for bits 2 and 3 added and the count corrected to 4.

**Pre-registered Edge predictions** (`sh_unit_cube`, `--expect-webgpu`, same
1024×768 pinned-clock configuration as Batch 890):

| Observable | Batch-890 reading | Predicted | Failure band |
| --- | ---: | ---: | --- |
| cross-backend mismatch | **2.574%** | **0.35%**, and the row certifies at **< 1.000%** (the re-armed cube gate) | > 1.000% = the SH port is wrong or incomplete; **< 0.05%** is equally a red flag (a diff that small against an f16-quantized 27-splat cloud suggests the two legs are no longer independent) |
| added% (WebGPU) | 18.996% | **18.996% ± 0.10** | any move > 0.5% means SH changed GEOMETRY, which it cannot — it writes only `output.color.rgb`. That is the `C15-G3b` lesson: colour and footprint are separate failures and must not be allowed to explain each other |
| added% (WebGL) | 19.141% | unchanged, 19.141% | any move at all = the WebGL leg was disturbed; the budget extraction is intended to be behaviour-preserving |
| `cache.splatCount` | 27 | 27 | ≠ 27 = a data-path regression, not an SH result |
| `comparatorSorts` / `providedUploads` | 0 / 1 | 0 / 1 | unchanged — `C15-G4`'s gate must not move |
| console/device errors | 0 | 0 | the short-SH-payload sentinel firing means the degree and the buffer disagree |

On **`tower`**: the ADDED RATIO (WebGPU/WebGL) stays in the pre-registered
**[0.90, 1.10]** band centred at the measured 1.002, and `_numSplats` stays
286,868/286,868 on both legs. **The tower claim is the RATIO, not a certified
parity number** — `C15-GSPLAT-TOWER-FRAME-VARIANCE` (Batch 892) has tower parity
certification blocked on a WebGL-side intra-frame reference variance
(`reference:capture-determinism`, 0.052% against a 0.050% bar), and `C15-G5`
does not touch that class and must not be read as clearing it.

**Vacuity control for the Edge run (mandatory, per the row's exit gate):** the
define is a shader axis, so the OFF leg is reachable by forcing
`activeShEnabled = false`; SH-on vs SH-off on `sh_unit_cube` must differ by more
than the gate threshold, or the run is not measuring SH. The 2.574% baseline is
itself the strongest available prior that it will: that residual is the SH term.

#### `C15-G5` ADDENDUM — the instrument for the two owed conditions now EXISTS (CO-12, 2026-08-07)

This row's cell records two written conditions the Batch-895 acceptance did not
discharge: **(a)** the sweep of three camera azimuths 120° apart, and **(b)** the
mandatory SH-off vacuity control. Neither was a judgement call — the probe could
not do either. `CO-12` built both lanes into `probe-gsplat-parity.mjs`; the
caveats stand until the run happens, and the run is now one command.

- **Three azimuths.** `AZIMUTH_HEADINGS = [0, 120, 240]`, heading 0 kept FIRST so
  the primary scored frame — and every number this track has recorded against it
  — is unchanged. Each orbit position takes its OWN hidden-tileset reference
  frame, its OWN sort quiescence (a 120° move is exactly what
  `shouldStartSteadySort` reacts to, so skipping this would reintroduce the
  `C15-G4b` defect at azimuths 1 and 2 while azimuth 0 stayed clean) and its OWN
  same-task determinism pair, and produces its own cross-backend diff PNG.
  Two anti-vacuity guards run BEFORE any mismatch is read: adjacent view
  directions must be **97.18076° apart — DERIVED**, not chosen
  (`acos(cos²p·cos d + sin²p)` at `p = −30°`, `d = 120°`, and the spec re-derives
  it from the probe's own pitch rather than copying the constant), and each orbit
  step must change at least **0.25 × the measured added fraction** on the
  reference leg. Three captures at one camera would otherwise diff to nothing and
  read as the strongest possible result.
- **SH-off vacuity control.** Driven through the engine's OWN seam:
  `primitive._sphericalHarmonicsDegree = 0` makes `resolveSplatShSource` report
  `enabled: false`, `activeShEnabled` follows, `shFlipped` invalidates the
  pipeline resources and the renderer recompiles the `//>>else` variant — a WGSL
  module with no SH term at all, i.e. the pre-`C15-G5` renderer. That is stronger
  than clearing a uniform, which would leave the SH code path compiled. The probe
  waits on `resourcesShEnabled === false && cache.pipeline` (waiting on the flag
  alone would capture during the cold variant compile, when nothing draws),
  captures at all three azimuths, then puts the degree back and **gates the
  restoration**: an irreversible control would invalidate every reading taken
  before it. Gate: the cross-backend mismatch must clear the 1% cube threshold at
  **≥ 2 of 3** azimuths, the row's own wording — a view-dependent term is allowed
  to vanish at one camera.
- **Pre-registered (DERIVED where derivable).** SH-off cross-backend mismatch
  ≈ **2.574%** at heading 0 (the recorded pre-G5 figure — the control walks the
  renderer back to exactly that state); **> 1.000%** at ≥ 2 azimuths is the gate;
  **0.000% with SH off is the FAILING arm** and is what proves the 0.000% this
  row certified on was never measuring SH. On `tower` the SH-off numbers are
  RECORDED, not gated: the pre-G5 tower residual has never been measured, so a
  floor for it would be invented at flip time rather than derived.
- The azimuth MISMATCH stays recorded-not-gated (`STAGE.controls.azimuth.scored
  = false`, armed by `C15-G8` together with `STAGE.parity.scored`), because it is
  the same cross-backend ceiling the single-camera leg makes. The two CONTROLS
  are gated now, at every stage: a floor that fails means the instrument is
  vacuous regardless of which row is running.

Harness 220 → 267 (47 new checks): 20 executable rules over the three lane
evaluators, 9 mutants, the DERIVED-value pins, and 5 probe-source anchors.

### `C15-G6` — multifrustum compose, re-verified against production data (M) — deps: `C15-G3`

`NEW-SPLAT-MULTIFRUSTUM-DEPTH-COMPOSE` has never been observed with a real
tileset, and the B647 `C7-SPLAT-DEPTH-COMPOSE` fix that was supposed to close it
has **never executed** (§6b row 3 — no probe primitive has a `_tileset`, so
`boundingVolume` is always `undefined` at `:1542`). This row re-opens the
question with data that can actually reach the code.

**PROBE AUTHORED, UNRUN — Batch 1157 (2026-08-24; Sol build under an Opus lane lead, station-3 review plus three delta reviews).** `Tools/visual-regression/probe-gsplat-multifrustum.mjs` consumes the landed `lib/gsplat-multifrustum-framing.mjs` unmodified, forces the depth partition that genuinely splits, reads active frusta and per-band `GAUSSIAN_SPLATS` occupancy as counters off `frustumCommands` (never inferred from pixels), scores splat presence and WebGL-vs-WebGPU occlusion topology only through the library's lazy occlusion reader, and acquires the bounding-volume suppression control after the clean capture without ever rendering it. The reference colours the labeller depends on are read back off the live scene on both backends and asserted, with a decoded corner sample, as STRUCTURAL preconditions. Companion spec `gsplat-campaign15-instruments.spec.mjs` extends to 86 browser-free tests with twenty mutation teeth including an inertness form per family. **Tier routing is pre-registered, not chosen after a number:** `R-2026-08-24-14` — one backend composing splat pixels while the other composes none, both having proven their splat and globe draw commands, is FAIL (exit 1) as `<backend>:labels:zero-splat-asymmetric`; the symmetric zero/zero case is STRUCTURAL (exit 3); `R-2026-08-24-16` — that backend's own `zero-globe` / `single-label-frame` anti-vacuity reasons are consequences of the same failure and are published as diagnostics rather than demoting the verdict, while unrelated structurals (frame-dimension mismatch, invalid partition, corner precondition mismatch, unproven settled frame on either backend, capture/framing failures) still outrank — a label-layer structural leaves the asymmetric reason in `topology.failures`, a framing-layer one short-circuits the lazy reader before any pixel is read. **Two pre-registration caveats:** (1) under the corrected camera geometry (the landed range formula puts the tower's RADIUS, not its diameter, at one twentieth of viewport height) the projected disc is 0.4418% of a 1280×720 canvas, so the pre-registered 0.25% disagreement bar sits 10.19× a one-pixel perimeter but only 1.767× below the footprint signal — a first-run value in that region IS the finding and the bar does not move; the brief's model is kept as a published erratum; (2) two frusta are nearly free under the forced ratio — the selective-binning checks (`bounded-splat:not-selectively-binned`, `clean:no-shared-globe-splat-band`, `negative:splat-not-in-every-band`, `negative:no-splat-only-band`) are the real teeth. The probe has never run: `output/gsplat-multifrustum/` does not exist, no verdict is claimed, the row stays PARTIAL, and only the machine-lane run can close it. Nothing here closes `NEW-SPLAT-MULTIFRUSTUM-DEPTH-COMPOSE`.

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

#### `C15-G8` ADDENDUM — what the probe can NOW do, and one arithmetic correction to this row's own gate text (CO-12, 2026-08-07)

`CO-12` built the lanes this row's exit gate needs. Nothing here relaxes the
gate; two things sharpen it.

**Now available in `probe-gsplat-parity.mjs --expect-webgpu`:**

1. **"the framed camera and at two orbit positions"** — the three-azimuth lane
   (0 / 120 / 240°) scores a cross-backend mismatch per azimuth against the
   existing per-asset thresholds (1% cube / 3% tower, unchanged), writes a diff
   PNG per azimuth, and refuses structurally if the cameras did not separate by
   the DERIVED 97.18076° or if the picture did not follow the camera. Arming it
   is one flag: `STAGE.controls.azimuth.scored`, which this row flips together
   with `STAGE.parity.scored` — the two are the same ceiling and must arm
   together.
2. **The vacuity control** — corrupted covariance, applied to a COPY of the
   packed payload (words 4-6 of each 8-u32 record) by shifting the half-float
   EXPONENT by +2, an exact ×4 on every normal half with Inf/NaN clamped away.
   The corruption is published as a new payload object — the engine's own
   producer-identity dirty signal — waited on through
   `cache.splatSourceToken`, and then withdrawn, with the withdrawal itself
   gated: an irreversible corruption would invalidate every earlier reading.

**The arithmetic correction.** This row's written control says "an intentionally
corrupted covariance term must push the `tower` mismatch above 3%". As written
that is **unreachable**: the mismatch cannot exceed the union of the clean and
corrupted footprints, and tower's clean footprint is **4.08% of the canvas**, so
no corruption of a small subset can clear 3%. Worse in the other direction, ONE
corrupted splat in 286,868 moves a DERIVED **1.4e-7** of the canvas — a fraction
of a single pixel, below the instrument's resolution, so gating it would be
gating noise. The lane therefore measures **two arms** and states which is gated
where:

- **single-triple arm** (splat 0 only) — gated on `sh_unit_cube` ONLY, where the
  derived per-splat footprint is `19.141% / 27 = 0.709%`, comfortably over the
  10 × determinism-bar floor (0.5%). Recorded, not gated, on tower, with the
  arithmetic above printed next to the number.
- **bulk arm** (every 2nd splat) — gated on BOTH assets against the asset's own
  parity threshold. This is the arm that answers "the gate can fail": half the
  cloud at 4× area must breach the very threshold the row gates parity with.

Pre-registered: cube single ≥ **0.5%** (predicted ~1.2%), cube bulk ≥ **1%**
(predicted ~9%), tower bulk ≥ **3%** (predicted ~5%; **if it comes in under 3%
that is the finding** — this row's corruption fraction then has to be stated in
the gate text rather than left to the reader, and the probe prints the measured
value either way). Restoration must return to within the untouched 0.050%
determinism bar on both assets.

**Still owed by this row, unchanged:** the `tower` frame-variance investigation
(`C15-GSPLAT-TOWER-FRAME-VARIANCE`, BRANCH B) blocks the tower leg, and
`C15-G6`'s multi-frustum leg needs a tower+globe scene that genuinely splits.
Neither is touched here.

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

