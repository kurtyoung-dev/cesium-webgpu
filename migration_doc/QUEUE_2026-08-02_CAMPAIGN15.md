# Campaign 15 — Aurora + Space Weather

Prepared: 2026-08-02

Status: **PLANNED / RESEARCH-VERIFIED / IMPLEMENTATION NOT STARTED.** `C15-00`
is complete; `C15-01` through `C15-08` are pending. This queue is **not a
maintainer launch ruling**.

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
| WMM2025 | Valid 2025–2030; the WMM2025 centered-dipole north geomagnetic pole is 80.79°N geocentric / 80.85°N geodetic, 72.76°W, giving a 9.21° dipole-axis inclination. Do not confuse this with the distinct magnetic dip pole. | [NCEI World Magnetic Model](https://www.ncei.noaa.gov/products/world-magnetic-model); [NCEI Wandering of the Geomagnetic Poles](https://www.ncei.noaa.gov/products/wandering-geomagnetic-poles) |
| Aurora extent and colour | NOAA describes aurora as typically 80–500 km; NASA places green oxygen near 100–200/250 km and red oxygen above 200 km. Campaign 15 uses a bounded 80–600 km analytic volume with separate line profiles so the upper red tail is not clipped into one homogeneous slab. | [NOAA SWPC Aurora](https://www.spaceweather.gov/phenomena/aurora); [NASA Auroras](https://science.nasa.gov/sun/auroras/); [NASA red/green altitude reference](https://www.nasa.gov/image-article/red-green-aurora-australis/) |
| OVATION | The operational product forecasts location/intensity 30–90 minutes ahead from L1 solar-wind and IMF measurements; when those inputs are unavailable it may use Kp, with no forecast lead. The latest JSON is a mutable snapshot with `Observation Time`, `Forecast Time`, `Data Format`, and 65,160 `[longitude, latitude, value]` coordinates on a 360×181 one-degree grid (longitude 0–359). | [SWPC Aurora 30-Minute Forecast](https://www.spaceweather.gov/products/aurora-30-minute-forecast); [latest OVATION JSON](https://services.swpc.noaa.gov/json/ovation_aurora_latest.json) |
| Planetary Kp | Since the 2026 schema change the feed is an array of standard objects `{time_tag, Kp, a_running, station_count}` with numeric values, not the former header-row/string encoding. Kp observations are three-hour values in a rolling product; consumers select the newest valid timestamp and treat staleness explicitly. | [planetary K-index JSON](https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json); [NWS Service Change Notice 26-21](https://www.weather.gov/media/notification/pdf_2026/scn26-21_Data_Format_Changes_Impacting_SWPC_Products.pdf) |
| Real-time solar wind | The old `/products/solar-wind/{mag,plasma}-*.json` family was scheduled for removal on 2026-04-30. The replacements are the one-minute RTSW magnetometer and wind feeds below. Rows expose source-satellite identity, active-source state, and quality metadata; values are numeric. Plasma names are `proton_density`, `proton_speed`, and `proton_temperature`; magnetic input retains GSM components including `bz_gsm`. The replacements do not provide old 3-day/7-day products, so a consumer needing those horizons must retrieve and retain the one-day stream itself. | [RTSW magnetometer JSON](https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json); [RTSW wind JSON](https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json); [NWS Service Change Notice 26-21](https://www.weather.gov/media/notification/pdf_2026/scn26-21_Data_Format_Changes_Impacting_SWPC_Products.pdf) |
| GOES X-rays | Primary/secondary X-ray products contain one-minute averages in the 0.1–0.8 nm and 0.05–0.4 nm passbands. The primary satellite can change; use the service's instrument-source mapping rather than hard-coding a GOES number. Dropouts can occur during calibration and satellite eclipse seasons. | [SWPC GOES X-ray Flux](https://www.spaceweather.gov/products/goes-x-ray-flux); [primary 1-day X-ray JSON](https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json); [instrument-source mapping](https://services.swpc.noaa.gov/json/goes/instrument-sources.json) |
| Data-use boundary | NWS pages are public domain unless specifically noted, but that general rule is not a substitute for product-level provenance, especially where an operational product incorporates a model developed outside NOAA. No downloaded snapshot enters the bundle until its exact source, transformation, attribution, and terms are recorded in `LICENSE.md`. | [NWS disclaimer](https://www.weather.gov/disclaimer/) |
| Kyoto Dst | WDC Kyoto permits unrestricted scientific use but explicitly disallows commercial applications of its geomagnetic indices and requires contact for real-time quicklook use in publications/presentations. A SWPC mirror does not erase those source restrictions. Campaign 15 therefore has **no built-in Kyoto provider and no bundled Dst snapshot**; a caller may supply a numeric Dst override and owns its provenance/rights. | [WDC Kyoto Data Usage Rules](https://wdc.kugi.kyoto-u.ac.jp/wdc/Sec3.html) |

Feed contracts are versioned inputs, not implementation trivia. Adapters must
validate schema and finite ranges; key caches by source + observation/forecast
time; reject time regressions; expose source, age, forecast lead, active/quality
state, and fallback reason; abort requests on provider change/destroy; apply
bounded retry/backoff; and keep parse/conversion/upload outside the render hot
path. A malformed or stale feed falls back to last-valid-within-policy or the
manual/synthetic driver, never to an unlabelled storm.

---

## 3. Queue ledger

| ID | Work | Priority | Status | Depends on |
|---|---|---:|---|---|
| `C15-00` | Correct campaign identity; verify science, live schemas, lifecycle, and data-use constraints; freeze this queue | P0 | **COMPLETE — 2026-08-02 (documentation/research only)** | — |
| `C15-01` | Backend-neutral aurora/space-weather state packet and deterministic manual driver | P0 | PENDING | `C15-00` |
| `C15-02` | WMM2025 geomagnetic coordinates and synthetic activity-dependent oval | P0 | PENDING | `C15-01` |
| `C15-03` | Shared layered density/emission kernel, local-night gate, and RTE shell contract | P0 | PENDING | `C15-02` |
| `C15-04` | WebGL + WebGPU shell renderers, visibility demand, and feature-preserving performance tiers | P0 | PENDING | `C15-03` |
| `C15-05` | OVATION + planetary-Kp asynchronous ingest and source-authority policy | P1 | PENDING | `C15-01`, `C15-02` |
| `C15-06` | New RTSW + GOES asynchronous ingest with separate geomagnetic and flare state | P1 | PENDING | `C15-01`, `C15-05` authority contract |
| `C15-07` | `effects.aurora` facade, demo, diagnostics, accessibility, attribution/licensing closure | P1 | PENDING | `C15-04`, `C15-05`, `C15-06` |
| `C15-08` | Cross-backend visual, RTE, lifecycle, off-contract, and moving-performance certification | R0 | PENDING | `C15-01..07` |

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
observation/forecast timestamps. Authority is explicit:

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

Exit: source handoff, inactive/bad-quality rows, gaps, out-of-order time,
calibration/eclipse dropout, retry/backoff, provider replacement, and destroy
are mutation-tested. Solar-wind diagnostics do not double-force OVATION and a
GOES flare alone does not mutate the auroral oval.

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
