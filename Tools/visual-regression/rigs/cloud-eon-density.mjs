// Rig record for the landing cell E-ON-density: the E-G scene with one family of
// opt-in WebGPU cloud caches switched on, so the cache's resources are
// allocated on a page the bind-group-layout census and the error gate read.
//
// @purpose Rig record for the landing cell E-ON-density: the underside noon scene of cloud-underside-noon-cov055 (coverage 0.55, density 0.8, black sky, solar noon) value for value, plus the experimental dials for the cached density and primary density reuse switched on, every size and tuning dial left at its default.
// @status ACTIVE
//
// EVERY VALUE IS cloud-underside-noon-cov055's: camera, clock, dials,
// viewport and readiness are copied, so the capture differs from E-G only by
// what the experimental block turns on.
//
// WHAT IT TURNS ON. cloudDensityCache (the camera-centred cache of the
// filtered density that light rays read) and cloudPrimaryDensityCache (the
// primary march reads that cache beyond cloudPrimaryDensityMinDistance; the
// renderer treats it as turning the density cache on too).
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-ON-density`. The block goes
// through `lib/landing-cell-stage.mjs`, which reads each dial back from the
// `CloudVolumetrics#experimental` namespace and refuses the page when one is
// not applied.

export default Object.freeze({
  id: "cloud-eon-density",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Density cache and primary density reuse on; the underside noon scene of cloud-underside-noon-cov055 (800 m above (-95, 39) under the deck, heading east and pitched 16 degrees up, solar noon on the June solstice, weather map off, coverage 0.55, density 0.8, sky box, sky atmosphere and sun hidden over a black background, 90 frames at the fixed clock).",
  declaredBy: "cloud-underside-noon-cov055",
  camera: {
    lon: -95,
    lat: 39,
    height: 800,
    heading: 1.5707963267948966,
    pitch: 0.2792526803190927,
    roll: 0,
  },
  clock: "2026-06-21T18:20:00Z",
  dials: {
    cloudCoverage: 0.55,
    cloudDensity: 0.8,
    cloudWeatherMap: false,
    skyBoxShow: false,
    skyAtmosphereShow: false,
    sunShow: false,
    backgroundColor: "rgb(0,0,0)",
    useDefaultRenderLoop: false,
  },
  experimental: {
    cloudDensityCache: true,
    cloudPrimaryDensityCache: true,
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 90,
  },
});
