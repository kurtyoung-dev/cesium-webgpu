# Campaign 13 Cloud Coordinate Contract — WGS84 and RTE

Status: **ACTIVE CONTRACT — C13-03 COMPLETE; GATE B REMAINS OPEN**

Campaign owner: [QUEUE_2026-07-23_CAMPAIGN13.md](QUEUE_2026-07-23_CAMPAIGN13.md)

This contract defines the coordinate rules that every planetary volumetric-cloud
producer and consumer must share. It is intentionally narrower than the complete
cloud architecture: the visible march lands first, then temporal history,
shadows/masks/captures, and weather lookup adopt the same frame. A primary-march
fix does not make the remaining consumers correct by implication.

The governing constraint remains feature preservation. WebGPU volumetric clouds,
WebGPU/WebGL billboard clouds, all public cloud configuration, and every existing
cloud consumer remain available while their coordinate implementation changes.

---

## 1. Authoritative planet and deck surfaces

Cloud geometry uses the WGS84 oblate ellipsoid:

- semi-major axes `a = 6,378,137.0 m` in ECEF X/Y;
- semi-minor axis `b = 6,356,752.3142451793 m` in ECEF Z.

A deck boundary at geodetic height `h` is represented by the expanded ellipsoid
with radii `(a + h, a + h, b + h)`. For the cloud domain this is both cheap and
accurate: compared with an exact WGS84 constant-geodetic-height locus, the radial
error is about `0.0022 m` at `h = 1,500 m`, `0.0057 m` at `h = 4,000 m`, and
`0.019 m` at `h = 13,000 m`. That approximation error is orders of magnitude
below current shader precision and cloud-detail scales.

The former single `6,378,137 m` sphere is not a permitted planetary fallback.
At the poles it places the modeled surface about `21.4 km` above the real WGS84
surface—larger than ordinary cloud decks—and can select the far side of the
shell or let terrain depth erase the complete interval.

---

## 2. Camera-relative frame

The canonical cloud render frame has:

- the current camera at local origin `(0, 0, 0)`;
- the WGS84 ellipsoid center represented relative to that origin;
- the camera ECEF position encoded on the CPU as high/low `f32` parts;
- ray distances, deck intersections, and sample offsets represented in metres
  relative to the camera.

The high-precision path subtracts the large encoded high term before applying the
low refinement. It must not reconstruct a full-ECEF `f32` position and then
subtract the camera; precision has already been lost at that point.

Planetary precision is an internal correctness default, not an appearance tier.
`cloudHighPrecision` therefore selects:

- default/`true`: the production high/low camera-relative path;
- explicit `false`: a retained diagnostic/compatibility A/B fallback.

Spatial sample count, lighting quality, temporal rate, and shadow fidelity must
not change this coordinate choice.

---

## 3. Required math by consumer

### 3.1 Primary visible march (`C13-04`)

Both the production and explicit legacy A/B paths intersect the WGS84 expanded
ellipsoids, never the old sphere. The production path performs the ellipsoid
intersection from the encoded camera-relative center. Camera altitude, per-step
deck fraction, deck ordering, and aerial-perspective midpoint altitude use the
same WGS84 surface definition.

Density/noise coordinates must remain planet anchored under camera motion. The
first geometry landing may preserve the existing appearance domain while it
removes the 21.4 km shell error, but it must record any raw-ECEF `f32` density
use as unfinished C13 work rather than calling primary RTE end-to-end complete.

### 3.2 Temporal history (`C13-05`, `C13-09..12`)

Temporal reprojection may not form a raw full-ECEF anchor from a `vec3<f32>`
camera. History carries an explicit origin/generation and cloud depth or motion
evidence. It resets exactly once when that origin or any reconstruction-defining
state becomes discontinuous:

- camera teleport or scene-mode/projection change;
- resize or current/history topology change;
- deck bounds, density/noise domain, weather source/revision, wind epoch, or
  quality topology change;
- discontinuous clock jump or device/context generation change.

Ordinary continuous camera and wind motion must reproject rather than reset.

### 3.3 Shadows, mask, captures, and atmosphere (`C13-06`)

Beer shadow maps, cascades, the god-ray/transmittance mask, dynamic environment
capture, IBL contribution, and atmosphere/fog consumers share the same expanded
WGS84 deck surfaces and frame origin. A second independent full-ECEF/spherical
march is a contract violation even if the visible composite is correct.

### 3.4 Weather and wind (`C13-07`, `C13-08`, `C13-14..20`)

Weather lookup derives longitude/latitude or page coordinates from the stable
planetary sample position, applies actual source bounds/no-data rules, and is
continuous at page gutters, the antimeridian, and poles. Wind is resolved in a
local east/north/up tangent frame; a fixed ECEF X/Z offset is not geographic
wind.

---

## 4. Precision and lifecycle invariants

1. CPU cartographic/ECEF inputs remain `f64` until encoded or packed.
2. Camera subtraction occurs before one-part `f32` reconstruction.
3. One frame uses one origin generation across visible, temporal, shadow, mask,
   capture, and atmosphere consumers.
4. A changed origin/configuration invalidates dependent cached bind groups and
   history, not unrelated immutable noise resources.
5. No cloud resource is converted through or allocated for WebGL merely to feed
   WebGPU. Billboard/shared CPU data remain backend neutral; backend GPU objects
   remain context-owned.
6. WebGL treats volumetric configuration as an inert, non-throwing store and
   continues rendering billboard `CloudCollection` content.
7. Empty geometry command lists do not suppress demanded sky/environment/cloud
   passes. Idle scheduling is an optimization only after all demanded consumers
   report no work.

---

## 5. Required evidence

The canonical Node/Edge oracle is
`Tools/visual-regression/probe-cloud-planetary.mjs`. Consecutive checkpoints
within each route are joined by deterministic camera-motion frames. Every
settled checkpoint then renders clouds OFF and ON at the same authored
`JulianDate` and camera and measures the raw-canvas delta. This isolates cloud
contribution from blue sky, bright terrain, UI chrome, and request-render
idling. The renderer experiences:

- an eastbound antimeridian crossing;
- north- and south-pole approaches plus longitude changes near each pole;
- ground, inside-deck, above-deck, regional, and orbit altitudes;
- an explicit initial route placement; those route-boundary jumps later become
  temporal-history reset fixtures.

The probe accepts `CLOUD_RTE_MODE=default|on|off`. `default` certifies production
behavior; `on` and `off` are explicit A/B diagnostics. A configuration round
trip, lazy feature-renderer handle, or nonzero FPS is insufficient: the truth
manifest requires actual procedural-renderer cache initialization, an executed
cloud pass, a clean WebGPU error/device-loss gate, and visible on/off delta.

Current pre-fix RED evidence on 2026-07-23:

- route: `north-pole`;
- requested geodetic altitude: `20,000 m`;
- five of six checkpoints: `0` changed pixels;
- the lone nonzero checkpoint: invalid dark far-side bands, not a valid cloud
  interval;
- `cloudHighPrecision=true`: does not correct the spherical surface;
- weather map disabled and wind zero: weather wrapping is not causal.

Post-fix primary-shell evidence on the same date:

- the default production route is green at all `21/21` checkpoints across the
  antimeridian, both poles, and `800 m` through `18,000,000 m`;
- the focused north-pole default, explicit high/low `on`, and one-part `off`
  runs are each green at `6/6` checkpoints with clean browser/GPU gates;
- the separate fixed-view precision A/B differs at only `154/786,432` pixels
  (`0.020%`) while both routes preserve visible clouds;
- mode and selected route set are encoded in artifact filenames, so subset and
  A/B runs do not overwrite one another.

This evidence closes the contract/oracle task and the primary visible-shell
slice only. It does not certify raw-ECEF density stability, temporal history,
standalone shadows/captures, regional weather seams, or Gate B.

The source/math specs additionally cover ellipsoid intersections and altitude at
the equator, antimeridian, both poles, inside/below/above deck, and large camera
translations. Browser evidence remains mandatory because a source-text match
cannot prove pass scheduling, resource readiness, depth interaction, or visible
output.

---

## 6. Completion boundary

`C13-03` is complete when this contract and the dynamic RED/green oracle are
landed. `C13-04` closes only the primary visible-march geometry/RTE slice.
`C13-05`, `C13-06`, and `C13-07/08` remain independently open until their
consumers pass the same planetary routes. Gate B closes only when all of them are
green; no partial consumer set may be described as “cloud RTE complete.”
