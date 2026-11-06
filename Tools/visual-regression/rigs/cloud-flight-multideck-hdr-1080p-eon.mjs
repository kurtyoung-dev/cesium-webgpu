// Rig record for the landing cell E-T-on: the flight rig of E-F and E-T-flight
// with every W4 cache family's experimental dials switched on, so a teardown
// and device-loss page allocates the cache owners it then has to release.
//
// @purpose Rig record for the landing cell E-T-on: cloud-flight-multideck-hdr-1080p (1920x1080, 2,500 m over (-100, 40) pitched 12 degrees down at 21:40Z on the June solstice, multi-deck volumetric cumulus at coverage 0.6, highDynamicRange on, 4x MSAA, globe lighting and multiple scattering on, Natural Earth imagery on the ellipsoid) value for value, plus the experimental dials of the occupancy, density, deep shadow and lighting families switched on, every size and tuning dial left at its default.
// @status ACTIVE
//
// EVERY VALUE IS cloud-flight-multideck-hdr-1080p's: camera, clock, dials,
// viewport and readiness are copied, so the page differs from E-T-flight only
// by what the experimental block turns on. The block is the union of the four
// cloud-eon-* rigs: cloudSpatialOccupancy and cloudWeatherVolumeBounds,
// cloudDensityCache and cloudPrimaryDensityCache, cloudDeepShadowCache and
// cloudDirectionalLighting, cloudContributionLighting. This scene's
// cloudWeatherMap is false, so the weather volume bounds owner is not built
// here (the bounds need a bound weather map).
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-T-on`: the teardown page
// and the device-loss page, each staged through `lib/landing-cell-stage.mjs`,
// which reads every experimental dial back and refuses a page where one is not
// applied.

export default Object.freeze({
  id: "cloud-flight-multideck-hdr-1080p-eon",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Flight cell E-F with the W4 cache dials on: 2,500 m over (-100, 40), heading north, pitched 12 degrees down, 21:40Z on the June solstice; multi-deck volumetric cumulus (coverage 0.6, density 0.35, 1,500-4,000 m, physical aerial, sky-LUT ambient, high tier), highDynamicRange on, 4x MSAA, globe lighting and sky multiple scattering on, Natural Earth imagery on the ellipsoid, 1920x1080; spatial occupancy, weather volume bounds, density cache, primary density reuse, deep shadow cache, directional lighting and contribution lighting on.",
  declaredBy: "cloud-flight-multideck-hdr-1080p",
  camera: {
    lon: -100,
    lat: 40,
    height: 2500,
    heading: 0,
    pitch: -0.20943951023931953,
    roll: 0,
  },
  clock: "2026-06-21T21:40:00Z",
  dials: {
    cloudType: 0,
    cloudCoverage: 0.6,
    cloudDensity: 0.35,
    cloudLayerBottom: 1500,
    cloudLayerTop: 4000,
    cloudWindSpeed: 0,
    cloudVolumetricQuality: "high",
    cloudWeatherMap: false,
    cloudAerialMode: "physical",
    cloudAmbientSource: "sky-lut",
    cloudMultiDeck: true,
    highDynamicRange: true,
    msaaSamples: 4,
    globeEnableLighting: true,
    skyAtmosphereMultipleScattering: true,
    imagery: "naturalEarth",
    terrain: "ellipsoid",
  },
  experimental: {
    cloudSpatialOccupancy: true,
    cloudWeatherVolumeBounds: true,
    cloudDensityCache: true,
    cloudPrimaryDensityCache: true,
    cloudDeepShadowCache: true,
    cloudDirectionalLighting: true,
    cloudContributionLighting: true,
  },
  viewport: {
    width: 1920,
    height: 1080,
  },
  readiness: {
    kind: "settleFrames",
    frames: 180,
  },
});
