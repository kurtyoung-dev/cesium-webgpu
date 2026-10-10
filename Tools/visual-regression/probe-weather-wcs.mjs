#!/usr/bin/env node
/**
 * Weather Phase 3 — mock-WCS (OGC API-Coverages / MSC GeoMet) offline probe
 * (Batch 425). WebGPU-only. PINNED for determinism under
 * `C13-WEATHER-PROBE-FLEET-NETWORK-GLOBE`.
 * @purpose Gate-B leg: OGC API-Coverages ingest via the shared CoverageJSON parser against the /mock-wcs fixture — same pattern gates as the EDR mock.
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * A DECLARATION (probe-kit harvest). This leg's page code, pins, sweep, gates
 * and thresholds were a copy of `probe-weather-edr-mock.mjs` with a different
 * source class, collection, URL check and file names. It now runs that file's
 * lane through `sweepDescriptor("wcs")`; the WCS row of its
 * `COVERAGE_SWEEP_SOURCES` table holds everything that was this file's own.
 * The prose below still describes the leg exactly.
 *
 * Proves the OGC Coverages ingest chain — fetch -> CoverageJSON parse (the SHARED
 * parser, same one EDR uses) -> packer -> weatherTex -> clouds — works end-to-end
 * WITHOUT live network, by pointing a WcsCoveragesWeatherSource at the dev
 * server's `/mock-wcs` route, which serves a committed CoverageJSON fixture
 * (Tools/visual-regression/fixtures/wcs-coverage.json: a 12x6 TCDC grid ramping
 * clear(west) -> overcast(east)).
 *
 * WHAT IS SCORED — every threshold below is UNCHANGED from the pre-pinning
 * probe. None was widened, lowered, or dropped.
 *   1 URL       `WcsCoveragesWeatherSource.buildUrl()` targets the mock endpoint
 *   2 FETCHED   the provider fetched + parsed the fixture (`hasData`,
 *               `version > 0`, no `lastError` — i.e. NO fallback-to-procedural)
 *   3 PATTERN   the fixture's spatial pattern reaches the deck:
 *               `east - west >= 0.03`
 *   4 CLEAN     0 new device / console errors
 *   plus BACKEND `scene.context.rendererType === "webgpu"`. A silent WebGL
 *               fallback HARD-FAILS: volumetric clouds are WebGPU-only, so
 *               scoring a WebGL frame as a WebGPU pass is a false green.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS PROBE WAS PINNED
 * ─────────────────────────────────────────────────────────────────────────────
 * It was one of the six Gate-B legs recorded GREEN while `probe-weather-
 * channels.mjs` flipped GREEN/RED/RED/RED/RED on one build. The audit
 * (`C13-WEATHER-PROBE-FLEET-NETWORK-GLOBE`) classified it SUSCEPTIBLE: its
 * capture path was byte-for-byte the same instrument as `probe-weather-edr-mock`
 * — the same `max(r,g,b) > 120` count over the central 60% of a 250 km nadir
 * frame, the same nine longitudes, the same `east - west >= 0.03` gate — and it
 * loaded `?renderer=webgpu` with NO `offline` flag, so
 * `CesiumViewerStartupOptions.js:27-42` supplied Cesium World Terrain and the
 * Ion world-imagery base layer. Lit imagery clears 120, so the metric was partly
 * counting imagery.
 *
 * The contamination is ORDERED, which is what makes it a false-GREEN path rather
 * than mere noise: `west` (lon -160) is the FIRST longitude visited, ~7 s after
 * setup; `east` (lon 160) is the LAST, nine camera jumps later, against a far
 * warmer tile cache. Streamed imagery therefore biases `east - west` UPWARD —
 * the exact direction gate 3 scores. On top of that the wind sat at its 15.0 m/s
 * default while every render was `s.render()` with no argument (which `Scene.js`
 * fills with `JulianDate.now()`), `cloudQuality` sat at its 64 default (the TIER
 * path: temporal accumulation + jitter + half-res, all frame-index inputs), and
 * the provider wait was a flat 7 s sleep on `hasData` — which says the CPU pack
 * exists, not that the bytes reached the GPU and the uniform enabled the map.
 *
 * The pins are P1-P8 as documented in `lib/weather-probe-pinning.mjs`; that
 * module is the shared enforceable home, and `probe-weather-channels.mjs` is the
 * reference implementation. Every pin is READ BACK — from the scene for the
 * scene pins, from packed cloud-uniform slots 35/44/64/74/107 for the
 * shader-visible ones — and a pin that did not take reports STRUCTURAL.
 *
 * DETERMINISM CONTROL. The sweep is captured TWICE back to back under one
 * configuration (`sweepA` then `sweepB`). The two must agree per longitude
 * within `CONTROL.perSample` and on the sweep mean within `CONTROL.mean`, and
 * the cloud `time` uniform must read the SAME value at each longitude in both.
 * Both tolerances sit strictly inside gate 3's scored 0.03 margin. If the
 * control fails the probe reports STRUCTURAL (exit 3) and certifies NOTHING.
 *
 * WHAT THE PINNING CHANGES ABOUT THE NUMBERS. Removing imagery, stopping the
 * wind, escaping the tier path and fixing the clock all move the ABSOLUTE
 * fractions. Any `fr:` values recorded for this probe before this pass are NOT a
 * baseline and must not be compared against. Gate 3 is relative (east vs west
 * within one sweep), so the comparison survives; the absolute level does not.
 *
 * Usage (serve the built tree on a governed port first, e.g.
 * `node server.js --port 8094 --serve-built`):
 *   node Tools/visual-regression/probe-weather-wcs.mjs [--port 8094] [--runs 10]
 * Out:
 *   Tools/visual-regression/output/weather-wcs/*.png, plus the runtime's
 *   weather-wcs-report.json / -runtime.json / -summary.md
 * Exit (the runtime's table):
 *   0 every gate decided and passed | 1 a real product FAIL |
 *   2 harness error or deadline | 3 STRUCTURAL, raised as a refusal — a pin
 *     did not take, the fixture never reached the GPU, or the probe could not
 *     reproduce its own capture (acceptance INCOMPLETE, not green, and not red)
 */
import { isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";
import { sweepDescriptor } from "./probe-weather-edr-mock.mjs";

/** This leg: the shared coverage-sweep lane, pointed at the WCS source. */
export const descriptor = sweepDescriptor("wcs");

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
