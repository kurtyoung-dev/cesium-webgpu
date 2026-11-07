/**
 * The landing program's cell table and the pure planning over it: which rig a
 * cell renders, on which renderers and pages, with which per-page dial
 * variants, and whether it waits for pending pipelines by default.
 * @purpose Cell table piece for probe-landing-cells.mjs: the LANDING_CELLS table (rig, kind, identity, per-cell pipeline-wait default, per-page dial variants, displacement readback and its evolved-clock second read, cross-renderer diff and its pre-registered band, forced performance leg and the GPU pass its PF-2 window must list), the (cell, renderer, page) plan, the rig a variant page stages, and the per-cell pending-pipeline wait resolved from --wait-pipelines / --no-wait-pipelines and read back from a report, the --runs default of a run that includes an identity cell (landingArgsFinalize), and the page of a plan that runs the onmessage sentinel's positive control (positiveControlPageIndex, refusing the switch with no identity cell), all pure.
 * @status ACTIVE
 *
 * WHY A PIECE. The table and its planning moved out of
 * `probe-landing-cells.mjs` (lane LINDISSE) when the probe passed 1000 lines
 * with the ocean-kernel, Chukotka and 2D / Columbus cells; the probe re-exports
 * every name it exported before, so its importers are unchanged.
 *
 * PER-PAGE VARIANTS. A cell with `variants` runs one page per variant on each
 * renderer, the page named after the variant, and stages the cell's rig with
 * the variant's dials laid over the rig's own (`rigForPage`). E-FFT-ifft is
 * the first: the same ocean rig once per inverse-FFT kernel, so the two
 * kernels' displacement fields can be compared within one run.
 * E-2D-stages and E-CV-stages vary the `globeFragmentDebug` dial instead: one
 * page per WebGPU globe fragment term of the 2D / Columbus-view frame, the
 * WebGL page of the same name being the plain frame.
 *
 * THE PIPELINE WAIT IS PER CELL. A WebGPU capture taken while pipelines still
 * compile shows the compile (the salvage-night receipt: an E-D frame with only
 * the atmosphere ring, an E-M-water frame all black). The identity cells,
 * E-M-water, E-C-chukotka and E-FFT-ifft therefore wait by default
 * (`waitPipelines: true`); `--wait-pipelines` forces the wait on every cell and
 * `--no-wait-pipelines` is the recorded waiver that turns it off on every cell.
 * A report records the wait each cell ran with (`pipelineWaitByCell`), and two
 * runs are compared or merged only where every shared cell waited alike. A
 * report written before the per-cell record reads its run-wide
 * `waitForPendingPipelines` for every cell (`waitedForCell`).
 *
 * @module Tools/visual-regression/lib/landing-cell-table
 */

import { OCEAN_EVOLVED_ADVANCE_SECONDS } from "./ocean-displacement-readback.mjs";
import { ProbeRefusal } from "./probe-refusal.mjs";

/**
 * The label of the FFT ocean's compute pass, the descriptor constant in
 * `packages/engine/Source/Renderer/WebGPU/WebGPUOceanRenderer.ts`
 * (`OCEAN_COMPUTE_PASS_DESCRIPTOR`); the PF-2 profiler keys passes by label.
 * A spec pins the two strings equal.
 */
export const OCEAN_COMPUTE_PASS_LABEL = "Ocean FFT single-pass compute chain";

/** The terms E-2D-stages and E-CV-stages draw, one page each, control first. */
const GLOBE_STAGE_VARIANTS = Object.freeze({
  control: Object.freeze({ globeFragmentDebug: "bypass-none" }),
  "no-drape": Object.freeze({ globeFragmentDebug: "bypass-drape" }),
  fade: Object.freeze({ globeFragmentDebug: "fade-amount" }),
  atmo: Object.freeze({ globeFragmentDebug: "atmo-color" }),
  composite: Object.freeze({ globeFragmentDebug: "post-composite-color" }),
  "view-dir": Object.freeze({ globeFragmentDebug: "view-dir" }),
});

/**
 * The two pages of a dive-gate cell: `dive` disables the water collision and
 * registers the gate the cell expects there, `control` leaves the collision
 * on, where the engine never opens the gate
 * (`GlobeWater.canDiveAtSurfaceHeight` needs `disableWaterCollision`), so
 * the control is "refuse" on every cell. The dials ride over the rig's own
 * (`rigForPage`); `lib/globe-dive-gate-steps.mjs` reads them.
 *
 * @param {"allow"|"refuse"} diveGate The gate the `dive` page registers.
 * @returns {Readonly<Record<string, object>>}
 */
function diveGateVariants(diveGate) {
  return Object.freeze({
    dive: Object.freeze({
      diveCollisionDisabled: true,
      diveGateExpected: diveGate,
    }),
    control: Object.freeze({
      diveCollisionDisabled: false,
      diveGateExpected: "refuse",
    }),
  });
}

/**
 * The pre-registered WebGPU-against-WebGL band of the pinned 2D and Columbus
 * view identity cells, set after the SCENE3D gate on the ground-atmosphere
 * drape (Batch 1636). Measured on tree B of the P2D-ACCEPT Edge leg
 * (`EDGE_RECEIPT_EOWYN_P2D_ACCEPT.md` sections 1 and 4), deterministic over
 * three invocations (the same sha256 each time): the pinned 2D rig
 * `default-2d-pinned` differs in 2 px at tolerance 0, max channel 1, bbox
 * (675,191)-(703,253); the pinned Columbus rig `default-columbus-pinned` in
 * 2 px at tolerance 0, max channel 32, all on column x = 1274, the right map
 * edge (y 42-677). Both residuals were already present in the pre-fix
 * `bypass-drape` frames, so they belong to the map edge and the base colour,
 * not to the drape.
 *
 * The band is the measured 2 px doubled (`maxChangedPx` 4), and a channel
 * delta of at most 1 everywhere except the edge column, which is excluded
 * from the channel limit only (its pixels still count toward `maxChangedPx`).
 * Scope: one pinned camera per mode, offline imagery, no water mask. A wider
 * scope (another camera, online imagery, a mask) needs its own measurement.
 */
export const POST_FIX_2D_CV_BAND = Object.freeze({
  tolerance: 0,
  maxChangedPx: 4,
  maxChannelOutsideExcluded: 1,
  excludedColumns: Object.freeze([1274]),
  scope: "one pinned camera per mode, offline imagery, no water mask",
});

/**
 * The labels of the two cloud bind group layouts the layout census reads, as
 * `makeBindGroupLayout` names them in
 * `packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`
 * (the march layout and the cloud shadow layout).
 */
export const CLOUD_LAYOUT_LABELS = Object.freeze([
  "ProceduralClouds BGL",
  "CloudShadow BGL",
]);

/**
 * The owner a weather transition allocates while it fades: the previous
 * snapshot's texture, labelled in
 * `packages/engine/Source/Renderer/WebGPU/WebGPUCloudWeatherTransition.ts`
 * (`CloudWeatherTransitionResources.prepareWeather`). A cell naming it in
 * `transitionOwner` passes only when its WebGPU page's census saw it created.
 */
export const WEATHER_TRANSITION_OWNER_LABELS = Object.freeze([
  "Cloud previous weather snapshot",
]);

/**
 * The cloud shadow owners a capture of E-BGL-shadow must show in the GPU device
 * census, as `WebGPUProceduralCloudRenderer.ts` labels them. Only labels of
 * objects the census records may sit here: it wraps createTexture,
 * createBuffer and the pipeline creators, never createSampler (a GPUSampler
 * has no destroy(), so there is no release to count), so "CloudShadow
 * Sampler" is not observable and is not listed. A spec checks every label
 * against the engine source.
 */
export const CLOUD_SHADOW_OWNER_LABELS = Object.freeze([
  "CloudShadow UB",
  "CloudShadow Map (sun-view optical depth)",
  "CloudShadow Placeholder (1x1 zero r16float)",
]);

/**
 * The cell table: cell name -> rig id and what the cell does on it.
 *
 * Fields beyond `rig` and `kind`: `identity` (a pixel-identity cell; the probe
 * wires the `window.onmessage` sentinel into it), `waitPipelines` (waits for
 * pending pipelines unless waived), `variants` (page name -> dials laid over
 * the rig), `readback` (`"ocean-displacement"`: the FFT ocean's displacement
 * field is read back after the capture), `crossRenderer` (the WebGPU capture
 * is diffed against the same run's WebGL capture), `crossRendererBand` (the
 * pre-registered band that diff is judged against, see
 * {@link POST_FIX_2D_CV_BAND}; a cross-renderer cell without one is measured
 * only), `online` (the page opens without `offline=true`, so
 * the streamed terrain and its water mask load; the dive-gate cells), `perf` (the PF-1 / PF-2
 * window runs without `--perf`), `perfPass` (the GPU pass label the PF-2
 * window must list, judged by `lib/landing-verdicts.mjs`) and
 * `evolvedReadbackSeconds` (the displacement field is read a second time with
 * the clock that many seconds past the rig's, both kernels at the same evolved
 * wave time; lane TAR-ALDARION), `layoutCensus` (a non-empty list of bind
 * group layout labels: the page counts what those layouts bind per shader stage
 * and at which group index, `lib/bind-group-layout-census.mjs`) and
 * `deviceLimits` (`"webgpu-default"`: the page's device is requested without
 * `requiredLimits`, `lib/device-limits-dial.mjs`). A cell without the last two
 * installs no script for them and its page record has no such field.
 *
 * Two fields belong to the weather-dial cells (E-WX-*). `transitionOwner` (a
 * list of GPU owner labels, {@link WEATHER_TRANSITION_OWNER_LABELS}): the cell
 * passes only when its WebGPU page's census saw each created, the proof that
 * the page held a snapshot pair. `populationsCoverage` (`{off, on}`, two
 * variant page names): the `on` page's frame is judged against the `off` page's
 * by the measured rule of `lib/metrics/deck-coverage.mjs` (a pixel is covered
 * when its Rec. 601 luma exceeds 8; UNMEASURED when the `off` page covers under
 * 1 % of the frame; FAIL when the `on` page covers under 25 % of the `off`
 * page's covered pixels or its mean luma over them is under 25 % of the `off`
 * page's; otherwise PASS). A variant may overlay the rig's `experimental` block
 * as well as its dials (`rigForPage`).
 *
 * `engagement` (a non-empty list of flag names of `lib/cloud-engagement-read.mjs`)
 * belongs to the same cells: the page reads those flags of the engine's own
 * state at capture into its record's `engagement`, and the weather-dial
 * verdicts require each flag as that module says (`populationsRequested`:
 * true on the `populationsCoverage.on` page and false on its `off` page;
 * `verticalRequested` and `workersEnabled`: true on the WebGPU pages). A cell
 * without the field reads nothing and its page record has no such field.
 */
export const LANDING_CELLS = Object.freeze({
  "E-D": Object.freeze({
    rig: "default-3d-pinned",
    kind: "capture",
    identity: true,
    waitPipelines: true,
  }),
  "E-D-HDR": Object.freeze({
    rig: "default-3d-hdr",
    kind: "capture",
    identity: true,
    waitPipelines: true,
  }),
  "E-O": Object.freeze({
    rig: "orbital-fulldisc-6608km-msaa4-single-deck",
    kind: "capture",
  }),
  // E-O with the sample count at one: the single-sample twin of the 4x cell.
  "E-O-msaa1": Object.freeze({
    rig: "orbital-fulldisc-6608km-msaa1-single-deck",
    kind: "capture",
  }),
  "E-F": Object.freeze({
    rig: "cloud-flight-multideck-hdr-1080p",
    kind: "capture",
  }),
  "E-G": Object.freeze({ rig: "cloud-underside-noon-cov055", kind: "capture" }),
  "E-G-night": Object.freeze({
    rig: "cloud-underside-night-cov055",
    kind: "capture",
  }),
  // Not in DEFAULT_CELLS: the E-G capture with the live bind-group-layout
  // census of the two cloud layouts (what the page created, per shader stage
  // and group index, against the WebGPU default per-stage limits).
  "E-BGL": Object.freeze({
    rig: "cloud-underside-noon-cov055",
    kind: "capture",
    layoutCensus: CLOUD_LAYOUT_LABELS,
  }),
  // Not in DEFAULT_CELLS: the E-G capture on a default-limits device (the page's
  // requiredLimits stripped), with the same layout census, so the receipt shows
  // the cloud layouts against the device the page actually got.
  "E-LL": Object.freeze({
    rig: "cloud-underside-noon-cov055",
    kind: "capture",
    layoutCensus: CLOUD_LAYOUT_LABELS,
    deviceLimits: "webgpu-default",
  }),
  // Not in DEFAULT_CELLS: the E-G capture with one W4 cache family's
  // experimental dials on (occupancy + weather volume bounds, density cache +
  // primary density reuse, deep shadow cache + directional lighting,
  // contribution lighting), each with the live layout census of the two cloud
  // layouts so the grown layouts' counts are read on the page. PASS RULE: the
  // page renders, the WebGPU error gate records 0 validation errors, every
  // `experimental.<dial>` the rig declares reads back applied, and the capture
  // PNG is described.
  "E-ON-occupancy": Object.freeze({
    rig: "cloud-eon-occupancy",
    kind: "capture",
    layoutCensus: CLOUD_LAYOUT_LABELS,
  }),
  "E-ON-density": Object.freeze({
    rig: "cloud-eon-density",
    kind: "capture",
    layoutCensus: CLOUD_LAYOUT_LABELS,
  }),
  "E-ON-shadow": Object.freeze({
    rig: "cloud-eon-shadow",
    kind: "capture",
    layoutCensus: CLOUD_LAYOUT_LABELS,
  }),
  "E-ON-lighting": Object.freeze({
    rig: "cloud-eon-lighting",
    kind: "capture",
    layoutCensus: CLOUD_LAYOUT_LABELS,
  }),
  "E-H": Object.freeze({ rig: "globe-horizon-viewer", kind: "capture" }),
  "R-14": Object.freeze({ rig: "sky-only-sun-change", kind: "clock-steps" }),
  "E-T-water": Object.freeze({
    rig: "water-coast-50km-enhanced-ocean",
    kind: "device-loss",
  }),
  "E-T-flight": Object.freeze({
    rig: "cloud-flight-multideck-hdr-1080p",
    kind: "device-loss",
  }),
  // The orbital full disc torn down and device-lost, the two pages E-T-flight
  // runs, on the E-O rig.
  "E-T-orbital": Object.freeze({
    rig: "orbital-fulldisc-6608km-msaa4-single-deck",
    kind: "device-loss",
  }),
  // Not in DEFAULT_CELLS: the two E-T-flight pages on the flight rig with every
  // W4 cache family's experimental dials on, so the cache owners are allocated
  // when the viewer is destroyed and the device is lost. PASS RULE: as the
  // E-ON cells (renders, 0 validation errors, every experimental dial reads
  // back applied, PNG described), plus the owner labels the run names in
  // `--owner-labels` are released after the teardown.
  "E-T-on": Object.freeze({
    rig: "cloud-flight-multideck-hdr-1080p-eon",
    kind: "device-loss",
  }),
  // Not in DEFAULT_CELLS: the teardown of the E-T-flight rig twice, plainly and
  // with a second holder keeping the pooled GPU device alive across the viewer's destruction
  // (lib/device-loss-steps.mjs, mode teardown-keep-device), so an owner
  // released only with its device is told from one released at the teardown.
  // PASS RULE: the page record's `deviceLoss.keepDevice` classifies every
  // owner row named in `--owner-labels` (released at teardown, only with the
  // device, never), or reads NOT AVAILABLE naming why the holder is not on
  // the viewer's device.
  "E-T-flight-keep": Object.freeze({
    rig: "cloud-flight-multideck-hdr-1080p",
    kind: "device-loss",
    devicePages: Object.freeze(["teardown", "teardown-keep-device"]),
  }),
  // The same keep-device teardown on the flight rig with every W4 cache
  // family's experimental dials on.
  "E-T-on-keep": Object.freeze({
    rig: "cloud-flight-multideck-hdr-1080p-eon",
    kind: "device-loss",
    devicePages: Object.freeze(["teardown", "teardown-keep-device"]),
  }),
  "E-T-resize": Object.freeze({
    rig: "globe-msaa4-resize-ladder",
    kind: "device-loss",
  }),
  "E-T-skybox": Object.freeze({
    rig: "skybox-source-swap",
    kind: "device-loss",
  }),
  // Not in DEFAULT_CELLS: a material-reading-the-tile-water-mask capture the
  // water landing asks for by name (`--cells E-M-water`).
  "E-M-water": Object.freeze({
    rig: "globe-material-water-mask",
    kind: "capture",
    waitPipelines: true,
  }),
  // Not in DEFAULT_CELLS (lane LINDISSE): the default viewer in 2D and in
  // Columbus view at the pinned instant, identity cells like E-D.
  "E-ID-2d": Object.freeze({
    rig: "default-2d-pinned",
    kind: "capture",
    identity: true,
    waitPipelines: true,
    crossRenderer: true,
    crossRendererBand: POST_FIX_2D_CV_BAND,
  }),
  "E-ID-cv": Object.freeze({
    rig: "default-columbus-pinned",
    kind: "capture",
    identity: true,
    waitPipelines: true,
    crossRenderer: true,
    crossRendererBand: POST_FIX_2D_CV_BAND,
  }),
  // The Chukotka antimeridian coast on both renderers, the WebGPU capture
  // diffed against the same run's WebGL capture. No band is registered yet:
  // the first capture registers it.
  "E-C-chukotka": Object.freeze({
    rig: "water-antimeridian-chukotka",
    kind: "capture",
    waitPipelines: true,
    crossRenderer: true,
  }),
  // Not in DEFAULT_CELLS: each WebGPU globe fragment term of the 2D / Columbus
  // view frame (one page per term), each against the plain WebGL frame.
  "E-2D-stages": Object.freeze({
    rig: "default-2d-pinned",
    kind: "capture",
    waitPipelines: true,
    crossRenderer: true,
    variants: GLOBE_STAGE_VARIANTS,
  }),
  "E-CV-stages": Object.freeze({
    rig: "default-columbus-pinned",
    kind: "capture",
    waitPipelines: true,
    crossRenderer: true,
    variants: GLOBE_STAGE_VARIANTS,
  }),
  // Not in DEFAULT_CELLS: the W3 cloud job's E-W identity cells, brought into
  // the kit from the out-of-tree instrument that ran them. The managed deck on
  // with the weather map, at the ground and at 30 km, SDR and HDR; each page
  // also reads the managed collection's weather state with the deck on and
  // after it is switched off (`lib/weather-state-steps.mjs`). Not `identity`
  // cells: the W3 job ran them with an explicit `--runs`, took no onmessage
  // sentinel, and waited for no pipelines.
  "E-W-ground": Object.freeze({ rig: "w3-ew-ground", kind: "weather-state" }),
  "E-W-ground-hdr": Object.freeze({
    rig: "w3-ew-ground-hdr",
    kind: "weather-state",
  }),
  "E-W-30km": Object.freeze({ rig: "w3-ew-30km", kind: "weather-state" }),
  "E-W-30km-hdr": Object.freeze({
    rig: "w3-ew-30km-hdr",
    kind: "weather-state",
  }),
  // Not in DEFAULT_CELLS: the camera controller's water dive gate, wheel-zoomed
  // through the real controller (`kind: "dive-gate"`), once with the water
  // collision disabled (`dive`) and once with it on (`control`). The four
  // terrain cells are `online`: the dive gate reads the height of streamed
  // Cesium World Terrain and its water mask, which an offline page does not
  // carry; E-DG-ellipsoid reads the ellipsoid and stays offline.
  "E-DG-geiranger": Object.freeze({
    rig: "dive-gate-geiranger-wall",
    kind: "dive-gate",
    online: true,
    variants: diveGateVariants("allow"),
  }),
  "E-DG-ontario": Object.freeze({
    rig: "dive-gate-lake-ontario-mask",
    kind: "dive-gate",
    online: true,
    variants: diveGateVariants("allow"),
  }),
  "E-DG-deathvalley": Object.freeze({
    rig: "dive-gate-death-valley",
    kind: "dive-gate",
    online: true,
    variants: diveGateVariants("refuse"),
  }),
  "E-DG-ellipsoid": Object.freeze({
    rig: "dive-gate-ellipsoid-sea-level",
    kind: "dive-gate",
    variants: diveGateVariants("allow"),
  }),
  "E-DG-upsampled": Object.freeze({
    rig: "dive-gate-upsampled-ocean",
    kind: "dive-gate",
    online: true,
    variants: diveGateVariants("allow"),
  }),
  // The opt-in FFT ocean once per inverse-FFT kernel (Batch 1622), the
  // displacement field read back after each capture and compared between the
  // kernels, with the frame-time and per-pass window on each.
  "E-FFT-ifft": Object.freeze({
    rig: "ocean-fft-patch-rebase",
    kind: "capture",
    waitPipelines: true,
    readback: "ocean-displacement",
    // The t = 0 identity checks the transform of the initial spectrum only (the
    // kit receipt, finding 3); the evolved read checks a time-evolved sea.
    evolvedReadbackSeconds: OCEAN_EVOLVED_ADVANCE_SECONDS,
    perf: true,
    // The label WebGPUOceanRenderer.ts opens the iFFT chain with: PF-2 lists
    // the chain under it once the pass carries timestamp writes (kit-PF
    // receipt, finding 1).
    perfPass: OCEAN_COMPUTE_PASS_LABEL,
    variants: Object.freeze({
      stockham: Object.freeze({ waterOceanIfftKernel: "stockham" }),
      pingpong: Object.freeze({ waterOceanIfftKernel: "pingpong" }),
    }),
  }),
  // Not in DEFAULT_CELLS: the four WebGPU-only weather dials of
  // CloudVolumetrics, one cell each, every one on the weather the collection
  // owns (cloudWeatherMap on, no weatherProvider). PASS RULE of the three
  // capture cells: the page renders, the WebGPU error gate records 0
  // validation errors, the dial reads back applied from the instance
  // (`stage.cloud.truth.config`, or `stage.dials["experimental.<dial>"]`), and
  // the PNG is described; the WebGL page of a two-renderer cell is the control
  // (no weather state, so no worker and the twin's frame).
  "E-WX-workers": Object.freeze({
    rig: "cloud-wx-workers",
    kind: "capture",
    waitPipelines: true,
    engagement: Object.freeze(["workersEnabled"]),
  }),
  // As the cells above, kind clock-steps: the rig steps the clock across a
  // 10-minute weather quantum so the page holds a snapshot pair, and the cell
  // passes only when the WebGPU page's census saw the transition's owner
  // created (`transitionOwner`).
  "E-WX-interpolation": Object.freeze({
    rig: "cloud-wx-interpolation",
    kind: "clock-steps",
    waitPipelines: true,
    transitionOwner: WEATHER_TRANSITION_OWNER_LABELS,
  }),
  "E-WX-vertical": Object.freeze({
    rig: "cloud-wx-vertical",
    kind: "capture",
    waitPipelines: true,
    engagement: Object.freeze(["verticalRequested"]),
  }),
  // Two pages on one view, populations off (`single-layer`) and on
  // (`populations`); the cell passes by the measured rule of
  // `lib/metrics/deck-coverage.mjs` (see the field notes above), not by
  // comparison with a base report.
  "E-WX-populations": Object.freeze({
    rig: "cloud-wx-populations",
    kind: "capture",
    waitPipelines: true,
    populationsCoverage: Object.freeze({
      off: "single-layer",
      on: "populations",
    }),
    engagement: Object.freeze(["populationsRequested"]),
    variants: Object.freeze({
      "single-layer": Object.freeze({
        experimental: Object.freeze({ cloudIndependentWeatherLayers: false }),
      }),
      populations: Object.freeze({
        experimental: Object.freeze({ cloudIndependentWeatherLayers: true }),
      }),
    }),
  }),
  // Not in DEFAULT_CELLS: the E-ON cells with the weather map on, so the
  // weather volume bounds owner ("Cloud weather volume bounds", never allocated
  // with the map off) is built on the occupancy page. PASS RULE: as the E-ON
  // cells.
  "E-ON-occupancy-wx": Object.freeze({
    rig: "cloud-eon-occupancy-wx",
    kind: "capture",
    layoutCensus: CLOUD_LAYOUT_LABELS,
  }),
  "E-ON-density-wx": Object.freeze({
    rig: "cloud-eon-density-wx",
    kind: "capture",
    layoutCensus: CLOUD_LAYOUT_LABELS,
  }),
  "E-ON-shadow-wx": Object.freeze({
    rig: "cloud-eon-shadow-wx",
    kind: "capture",
    layoutCensus: CLOUD_LAYOUT_LABELS,
  }),
  "E-ON-lighting-wx": Object.freeze({
    rig: "cloud-eon-lighting-wx",
    kind: "capture",
    layoutCensus: CLOUD_LAYOUT_LABELS,
  }),
  // Not in DEFAULT_CELLS: the two E-T-flight pages on the flight rig with the
  // weather map and the four weather dials on and a clock step before the
  // terminal action (`lib/device-loss-steps.mjs`), so the weather owners are
  // allocated when the viewer is destroyed and the device is lost. PASS RULE:
  // as E-T-on, with the owner labels the run names in `--owner-labels`
  // released after the teardown.
  "E-T-wx": Object.freeze({
    rig: "cloud-flight-multideck-hdr-1080p-wx",
    kind: "device-loss",
  }),
  // Not in DEFAULT_CELLS: E-LL on the rig with every W4 experimental family
  // and the four weather dials on (weather map on): the layout census of the
  // two cloud layouts on a default-limits device.
  "E-LL-wx": Object.freeze({
    rig: "cloud-wx-all-dials",
    kind: "capture",
    layoutCensus: CLOUD_LAYOUT_LABELS,
    deviceLimits: "webgpu-default",
  }),
  // Not in DEFAULT_CELLS: the E-G capture with cloud shadow casting on, so the
  // cloud shadow bind group layout ("CloudShadow BGL") is created and the
  // layout census counts it beside the march layout. PASS RULE: the page
  // renders, the WebGPU error gate records 0 validation errors, the census
  // holds a "CloudShadow BGL" row with its per-stage counts, and every label of
  // `ownerLabels` is seen in the GPU device census (verdict `owners-seen`).
  "E-BGL-shadow": Object.freeze({
    rig: "cloud-shadow-noon-cov055",
    kind: "capture",
    layoutCensus: CLOUD_LAYOUT_LABELS,
    ownerLabels: CLOUD_SHADOW_OWNER_LABELS,
  }),
  // Not in DEFAULT_CELLS: the default cloud collection in 2D (an orthographic
  // frame at the default quality). PASS RULE: the scene mode reads back SCENE2D,
  // the page renders, 0 validation errors, and with `--readers cloud-stats` the
  // cloud quality flags are read and the frame is described.
  "E-CLOUD-2d": Object.freeze({ rig: "cloud-2d-default", kind: "capture" }),
  // Not in DEFAULT_CELLS: the default cloud collection while the scene mode is
  // MORPHING (`lib/morph-steps.mjs`). PASS RULE: the morph-hold record reads
  // MORPHING right after the morph starts and after the frames, the page
  // renders, 0 validation errors, and with `--readers cloud-stats` the quality
  // flags are read.
  "E-CLOUD-morph": Object.freeze({
    rig: "cloud-morph-default",
    kind: "morph-hold",
  }),
  // Not in DEFAULT_CELLS: a glTF model added so the WebGPU dynamic environment
  // cube is built, and its six mip-0 faces read back
  // (`lib/sky-cubemap-steps.mjs`). PASS RULE: the cube exists and settles, six
  // faces read with non-zero content; two arms compare by per-face sha256
  // (`compareSkyCubeRecords`).
  "E-SKY-cube": Object.freeze({ rig: "sky-cubemap-model", kind: "sky-cube" }),
});

/** The default `--cells`: the standard set's capture cells. */
export const DEFAULT_CELLS = Object.freeze([
  "E-D",
  "E-D-HDR",
  "E-O",
  "E-F",
  "E-G",
  "E-G-night",
]);

/** The pages an E-T cell runs, in order. */
export const DEVICE_LOSS_PAGES = Object.freeze(["teardown", "forced-loss"]);

/** How the run's pending-pipeline wait was decided. */
export const PIPELINE_WAIT_MODES = Object.freeze({
  CELL_DEFAULT: "cell-default",
  FORCED: "forced",
  WAIVED: "waived",
});

/**
 * The comma list of a string option, trimmed, empties dropped.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function splitList(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * How many same-build repeats a run takes when `--runs` was not given and an
 * identity cell is requested: the WebGL default frame is not deterministic
 * from run to run on one build (E-D: 340-384 px changed, max channel up to 9;
 * row NEW-WEBGL-E-D-DEFAULT-FRAME-NONDETERMINISTIC), so a single WebGL run has
 * no repeat floor to read its pixel band against and reads `unmeasured`.
 */
export const IDENTITY_DEFAULT_RUNS = 2;

/**
 * The descriptor's `args.finalize` hook: a run whose `--cells` include an
 * identity cell takes {@link IDENTITY_DEFAULT_RUNS} runs unless `--runs` was
 * given on the command line, whose value always wins. The default `--cells`
 * include E-D, so a run with no flags takes two runs too. Pure.
 *
 * @param {{cells?: string, runs?: number}} parsed The options after parsing.
 * @param {{explicit: Set<string>}} context The option keys the command line set.
 * @returns {object} The options, with `runs` resolved.
 */
export function landingArgsFinalize(parsed, { explicit }) {
  if (explicit.has("runs")) {
    return parsed;
  }
  const names = splitList(parsed.cells ?? DEFAULT_CELLS.join(","));
  const identity = names.some((name) => LANDING_CELLS[name]?.identity === true);
  return identity ? { ...parsed, runs: IDENTITY_DEFAULT_RUNS } : parsed;
}

/**
 * The pages a cell runs on each renderer, in order.
 *
 * @param {object} cell A {@link LANDING_CELLS} entry.
 * @returns {string[]}
 */
export function pagesOfCell(cell) {
  if (cell.kind === "device-loss") {
    return [...(cell.devicePages ?? DEVICE_LOSS_PAGES)];
  }
  if (cell.variants) {
    return Object.keys(cell.variants);
  }
  return ["scene"];
}

/**
 * The (cell, renderer, page) triples a run takes, cell-major, WebGL before
 * WebGPU, and for an E-T cell its two pages in {@link DEVICE_LOSS_PAGES}
 * order, for a variant cell its variants in table order.
 *
 * @param {{cells?: string, renderers?: string[]}} options
 * @param {Map<string, object>|Record<string, object>} rigsById
 * @returns {Array<{cell: string, rigId: string, kind: string,
 *   renderer: string, page: string}>}
 * @throws {ProbeRefusal} `cell-unknown` or `cell-rig-absent`.
 */
export function planLandingCells(options, rigsById) {
  const lookup = (id) =>
    rigsById instanceof Map ? rigsById.get(id) : rigsById?.[id];
  const names = splitList(options?.cells ?? DEFAULT_CELLS.join(","));
  const plan = [];
  for (const cell of names) {
    if (!Object.hasOwn(LANDING_CELLS, cell)) {
      throw new ProbeRefusal(
        "cell-unknown",
        `--cells ${cell} is not one of ${Object.keys(LANDING_CELLS).join(", ")}`,
        { cell },
      );
    }
    const { rig: rigId, kind } = LANDING_CELLS[cell];
    const rig = lookup(rigId);
    if (!rig) {
      throw new ProbeRefusal(
        "cell-rig-absent",
        `${cell}: rig ${rigId} is not in the registry`,
        { cell, rigId },
      );
    }
    for (const renderer of ["webgl", "webgpu"]) {
      if (!rig.renderers.includes(renderer)) {
        continue;
      }
      if (
        Array.isArray(options?.renderers) &&
        !options.renderers.includes(renderer)
      ) {
        continue;
      }
      for (const page of pagesOfCell(LANDING_CELLS[cell])) {
        plan.push({ cell, rigId, kind, renderer, page });
      }
    }
  }
  return plan;
}

/**
 * The rig a planned page stages: the cell's rig, with the page's variant
 * dials laid over its own when the cell has variants. Pure; the rig record is
 * not modified.
 *
 * @param {object} rig The cell's rig.
 * @param {{cell: string, page: string}} entry A planned page.
 * @returns {object}
 */
export function rigForPage(rig, entry) {
  const variants = LANDING_CELLS[entry.cell]?.variants;
  if (!variants || !Object.hasOwn(variants, entry.page)) {
    return rig;
  }
  // A variant's `experimental` key overlays the rig's experimental block; every
  // other key is a dial.
  const { experimental, ...dials } = variants[entry.page];
  const staged = { ...rig, dials: { ...rig.dials, ...dials } };
  if (experimental !== undefined) {
    staged.experimental = { ...rig.experimental, ...experimental };
  }
  return staged;
}

/**
 * The pending-pipeline wait of every requested cell. Pure.
 *
 * @param {{cells?: string, waitPipelines?: boolean,
 *   noWaitPipelines?: boolean}} options
 * @returns {{mode: string, byCell: Record<string, boolean>}}
 * @throws {ProbeRefusal} `pipeline-wait-conflict` when both flags are given.
 */
export function pipelineWaitPlan(options) {
  const forced = options?.waitPipelines === true;
  const waived = options?.noWaitPipelines === true;
  if (forced && waived) {
    throw new ProbeRefusal(
      "pipeline-wait-conflict",
      "--wait-pipelines and --no-wait-pipelines contradict each other; give one",
      {},
    );
  }
  let mode = PIPELINE_WAIT_MODES.CELL_DEFAULT;
  if (forced) {
    mode = PIPELINE_WAIT_MODES.FORCED;
  } else if (waived) {
    mode = PIPELINE_WAIT_MODES.WAIVED;
  }
  const byCell = {};
  for (const cell of splitList(options?.cells ?? DEFAULT_CELLS.join(","))) {
    if (!Object.hasOwn(LANDING_CELLS, cell)) {
      continue;
    }
    byCell[cell] =
      mode === PIPELINE_WAIT_MODES.FORCED ||
      (mode === PIPELINE_WAIT_MODES.CELL_DEFAULT &&
        LANDING_CELLS[cell].waitPipelines === true);
  }
  return { mode, byCell };
}

/**
 * Whether `cell` waited for pending pipelines in `report`: its per-cell
 * record, else (a report written before it) the run-wide flag. Pure.
 *
 * @param {object|null|undefined} report A landing-cells report.
 * @param {string} cell
 * @returns {boolean}
 */
export function waitedForCell(report, cell) {
  const byCell = report?.pipelineWaitByCell;
  if (byCell && Object.hasOwn(byCell, cell)) {
    return byCell[cell] === true;
  }
  return report?.waitForPendingPipelines === true;
}

/**
 * The cells a report covers: those its pages, its arms and its per-cell wait
 * record name. Pure.
 *
 * @param {object|null|undefined} report
 * @returns {Set<string>}
 */
export function cellsOfReport(report) {
  const cells = new Set(Object.keys(report?.pipelineWaitByCell ?? {}));
  for (const page of report?.pages ?? []) {
    if (typeof page?.cell === "string") {
      cells.add(page.cell);
    }
  }
  for (const arm of Object.values(report?.arms ?? {})) {
    if (typeof arm?.cell === "string") {
      cells.add(arm.cell);
    }
  }
  return cells;
}

/**
 * The cells two reports both cover on which one waited for pending pipelines
 * and the other did not. Pure.
 *
 * @param {object} a
 * @param {object} b
 * @returns {string[]}
 */
export function pipelineWaitMismatches(a, b) {
  const inB = cellsOfReport(b);
  return [...cellsOfReport(a)]
    .filter((cell) => inB.has(cell))
    .filter((cell) => waitedForCell(a, cell) !== waitedForCell(b, cell));
}

/**
 * The page of a plan that runs the sentinel's positive control: the first
 * identity page, or -1 without the switch. Refuses the switch when no
 * requested cell is an identity cell, before the first page. Pure.
 *
 * @param {object[]} plan {@link planLandingCells}' answer.
 * @param {{sentinelPositiveControl?: boolean}} options
 * @returns {number}
 * @throws {ProbeRefusal} `sentinel-control-no-identity-cell`.
 */
export function positiveControlPageIndex(plan, options) {
  if (options?.sentinelPositiveControl !== true) {
    return -1;
  }
  const index = plan.findIndex(
    (entry) => LANDING_CELLS[entry.cell]?.identity === true,
  );
  if (index < 0) {
    throw new ProbeRefusal(
      "sentinel-control-no-identity-cell",
      "--sentinel-positive-control needs an identity cell in --cells (E-D, E-D-HDR, E-ID-2d, E-ID-cv): only their pages carry the sentinel",
      { cells: splitList(options.cells) },
    );
  }
  return index;
}
