# Space-weather product fixtures

Byte-frozen captures of seven live NOAA Space Weather Prediction Center (SWPC)
products, used as test data by the space-weather ingest specs. Each file is the
response body exactly as served — minified, single-line, no trailing newline —
so the SHA-256 below is reproducible from the capture and any byte change is a
test failure rather than a silent drift.

`.gitattributes` declares this directory `-text` so no end-of-line conversion can
touch the captures in either direction.

## Provenance

Captured once each with Node's global `fetch`, no proxy, no transformation.

| File                                   | Source URL                                                                     | Fetched (UTC)            | HTTP | Bytes   | SHA-256                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------ | ------------------------ | ---- | ------- | ------------------------------------------------------------------ |
| `ovation_aurora_latest.json`           | `https://services.swpc.noaa.gov/json/ovation_aurora_latest.json`               | 2026-09-19T12:50:31.603Z | 200  | 918,963 | `ff4cc555398be141260f302beb1b530264a9a6d53c45e5d6d4d8de71c1bed8dc` |
| `noaa-planetary-k-index.json`          | `https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json`          | 2026-09-19T12:50:32.020Z | 200  | 4,634   | `1fae89dc42179cccc9702ea12ce5eaf14033184de7de81490a7b97b0fe40f2e4` |
| `noaa-planetary-k-index-forecast.json` | `https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json` | 2026-09-19T12:50:32.046Z | 200  | 6,907   | `42ada213b55d3e982718f8fdb69aed12786c4acd484ed780db72c5450d6ab132` |

All three were served with `Access-Control-Allow-Origin: *` and
`Cache-Control: max-age=60`.

The solar-wind and X-ray set was captured the same way, one request each, a week
later:

| File                      | Source URL                                                          | Fetched (UTC)            | HTTP | Bytes     | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------- | ------------------------ | ---- | --------- | ------------------------------------------------------------------ |
| `rtsw_mag_1m.json`        | `https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json`         | 2026-09-26T16:22:59.193Z | 200  | 1,627,383 | `f45f55f69d0f130e35f54894aa2a845578d4de689dcbcaed2832893d629f7beb` |
| `rtsw_wind_1m.json`       | `https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json`        | 2026-09-26T16:23:00.531Z | 200  | 2,850,656 | `7b45990f72b8b8c5b3cce41ac7e1f1e0710d56231a2cdffe79b2c948e781fe8d` |
| `xrays-1-day.json`        | `https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json` | 2026-09-26T16:23:03.049Z | 200  | 648,392   | `9329c48506fb3b2eb3d6289f431b0cb851c19001e35ad9875e2f29acd92c35be` |
| `instrument-sources.json` | `https://services.swpc.noaa.gov/json/goes/instrument-sources.json`  | 2026-09-26T16:23:03.406Z | 200  | 2,358     | `75a953bd0cbd03385fdadd643c8c78b82f42f5c90f1c1c709a2500a020014ba1` |

All four were served with `Access-Control-Allow-Origin: *` and
`Cache-Control: max-age=60`.

## What each capture contains

- **`ovation_aurora_latest.json`** — five top-level keys (`Observation Time`,
  `Forecast Time`, `Data Format`, `coordinates`, `type`). `coordinates` is
  65,160 integer `[longitude, latitude, aurora]` triples on a longitude-major
  360 × 181 one-degree grid. Observation `2026-09-19T12:40:00Z`, forecast
  `2026-09-19T13:42:00Z` — a measured lead of **62 minutes**. Sample range 0–16,
  15,887 non-zero cells. The 360 duplicate entries of the **south pole disagree**
  in this capture (six distinct values, 0–5), which is what the pole-policy
  tests are built against — and why a normalized grid counts 15,897 non-zero
  samples under the default `mean` policy rather than 15,887: that policy gives
  the ten zero-valued south-pole duplicates the pole's mean.
- **`noaa-planetary-k-index.json`** — 60 ascending three-hour rows
  `{time_tag, Kp, a_running, station_count}`, value field spelled **`Kp`**,
  `time_tag` carrying no zone designator.
- **`noaa-planetary-k-index-forecast.json`** — 81 ascending three-hour rows
  `{time_tag, kp, observed, noaa_scale}`, value field spelled **`kp`**,
  `observed` one of `observed` / `estimated` / `predicted`, `noaa_scale` null
  throughout this capture.
- **`rtsw_mag_1m.json`** — 3,860 rows, **newest first**, one per spacecraft per
  minute (`SOLAR1` active on 1,435 rows; `IMAP` and `ACE` inactive), zoneless
  `time_tag`. Every active row carries the fill `-9999` in `max_data_flag` and
  `0` in `overall_quality`. No gap in the active minutes, newest active minute
  `2026-09-26T16:14:00`.
- **`rtsw_wind_1m.json`** — 3,852 rows, newest first, `SOLAR1` active on 1,431,
  with three 120 s gaps in the active minutes; newest active minute
  `2026-09-26T16:13:00`. No fill value on any row.
- **`xrays-1-day.json`** — 2,876 rows, **oldest first**, the two passbands
  interleaved (1,438 each), `satellite` 18 throughout, contamination field
  spelled `electron_contaminaton`. Two runs of zero flux on both bands —
  `2026-09-25T17:13`–`17:32` (20 min) and `2026-09-26T08:26`–`09:31` (66 min) —
  are the calibration/eclipse dropouts. Long-band maximum C1.6 at
  `2026-09-26T13:27Z`; newest long-band minute `16:17Z` at B4.9.
- **`instrument-sources.json`** — an array of **six** dated mappings, newest
  first (the 2026-08-06 measurement found one). The X-ray primary was 19 from
  `2026-09-22T14:11:14Z` and 18 from `15:39:59Z` on; the two newest entries are
  identical duplicates at one instant.

## Attribution and terms

The products are works of the United States Government, published by the NOAA
Space Weather Prediction Center, and are in the public domain under the National
Weather Service disclaimer. Three conditions of that disclaimer are operative and
are the reason the engine's packets carry an attribution string rather than
nothing: the data may not be claimed as our own, may not be used in a way
implying NOAA/NWS endorsement, and **modified content may not be presented as
official government material**. A regridded auroral field is modified content,
and so is an activity scalar estimated from the solar wind.

The auroral-precipitation product is generated by the **OVATION Prime** model,
developed at the Johns Hopkins University Applied Physics Laboratory by Patrick
Newell and co-workers. The public-domain status of the SWPC _output_ is not a
licence over the _model_.

Sources:

- <https://www.weather.gov/disclaimer/>
- <https://www.spaceweather.gov/products/aurora-30-minute-forecast>
- <https://www.spaceweather.gov/phenomena/aurora>

## The `Aurora` value unit is not pinned

The payload declares only `"Data Format": "[Longitude, Latitude, Aurora]"`, and
neither the payload nor the product page states the unit or the ceiling of the
`Aurora` value. Both captures available to date are quiet-period samples topping
out at 16. The ingest therefore carries the integers through unchanged at `"raw"`
scale and declares only the maximum each snapshot contained; nothing normalizes
against an assumed 0–100 ceiling. Pinning the unit needs a storm-period sample or
an attributable official statement.
