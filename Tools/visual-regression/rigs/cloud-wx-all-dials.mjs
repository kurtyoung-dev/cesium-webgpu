// Rig record for the landing cell E-LL-wx: the E-G scene with every W4 experimental family and the four weather dials on, weather map on, for the default-limits layout census.
//
// @purpose Rig record for the landing cell E-LL-wx: the underside noon scene of cloud-underside-noon-cov055 (800 m above (-95, 39), heading east and pitched 16 degrees up, solar noon on the June solstice, coverage 0.55, density 0.8, black background, sky box, sky atmosphere and sun hidden, 1024x768) with the weather map on, cloudWeatherWorkers, cloudWeatherInterpolation and cloudVerticalWeather on, and the experimental dials of every W4 family (occupancy, weather volume bounds, density cache, primary density reuse, deep shadow cache, directional lighting, contribution lighting) plus cloudIndependentWeatherLayers on, so the march and shadow layouts grow to their largest on a default-limits device.
// @status ACTIVE
//
// THE TWIN IS cloud-underside-noon-cov055 (E-G, whose E-LL cell this extends).
// DIFFERS FROM THE TWIN IN: cloudWeatherMap (true), the three volumetric weather
// dials, the experimental block (the union of the four cloud-eon-* blocks and
// cloudIndependentWeatherLayers) and readiness.frames (240 against 90, the
// weather is generated asynchronously).
//
// INERT DIALS, SAID PLAINLY.
// - cloudVerticalWeather applies to a single deck, and the renderer counts the
//   march as multi-deck when cloudIndependentWeatherLayers is on
//   (`multiDeckOn`), so the dial adds nothing on this rig; the vertical plane is
//   produced by the populations dial (`|| populationsEnabled`).
// - cloudWeatherInterpolation requests the transition (the march layout and the
//   define grow), but the page never has a snapshot pair: the cell is a plain
//   capture with no clock step, and the "Cloud previous weather snapshot"
//   texture is allocated only while a transition is active. The layout census
//   therefore reads the transition's bindings requested, not a fade.
// - cloudWeatherWorkers starts the worker the first time the owned weather is
//   generated; the layout census does not see it.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-LL-wx`: the layout census of
// the two cloud layouts on a device requested without requiredLimits.

export default Object.freeze({
  id: "cloud-wx-all-dials",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Every W4 experimental family and the four weather dials on, weather map on; the underside noon scene of cloud-underside-noon-cov055 (800 m above (-95, 39) under the deck, heading east and pitched 16 degrees up, solar noon on the June solstice, coverage 0.55, density 0.8, sky box, sky atmosphere and sun hidden over a black background, 240 frames at the fixed clock).",
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
    cloudWeatherMap: true,
    skyBoxShow: false,
    skyAtmosphereShow: false,
    sunShow: false,
    backgroundColor: "rgb(0,0,0)",
    useDefaultRenderLoop: false,
    cloudWeatherWorkers: true,
    cloudWeatherInterpolation: true,
    cloudVerticalWeather: true,
  },
  experimental: {
    cloudSpatialOccupancy: true,
    cloudWeatherVolumeBounds: true,
    cloudDensityCache: true,
    cloudPrimaryDensityCache: true,
    cloudDeepShadowCache: true,
    cloudDirectionalLighting: true,
    cloudContributionLighting: true,
    cloudIndependentWeatherLayers: true,
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 240,
  },
});
