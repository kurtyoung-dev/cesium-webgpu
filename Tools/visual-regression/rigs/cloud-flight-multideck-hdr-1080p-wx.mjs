// Rig record for the landing cell E-T-wx: the flight rig of E-F and E-T-flight with the weather map on and the four weather dials on, so a teardown and device-loss page allocates the weather owners it then has to release.
//
// @purpose Rig record for the landing cell E-T-wx: cloud-flight-multideck-hdr-1080p (1920x1080, 2,500 m over (-100, 40) pitched 12 degrees down at 21:40Z on the June solstice, multi-deck volumetric cumulus at coverage 0.6, highDynamicRange on, 4x MSAA, globe lighting and multiple scattering on, Natural Earth imagery on the ellipsoid) value for value, plus cloudWeatherMap, cloudWeatherWorkers, cloudWeatherInterpolation and cloudVerticalWeather on, experimental.cloudIndependentWeatherLayers on, and one clock step to 21:50:15Z with 240 frames settled after it.
// @status ACTIVE
//
// THE TWIN IS cloud-flight-multideck-hdr-1080p. DIFFERS FROM THE TWIN IN:
// cloudWeatherMap (true; the twin has it off, and the four dials act only on the
// weather the collection owns), the four weather dials, and the step dials
// clockSteps and settleFramesPerStep.
//
// THE CLOCK STEP gives the page a snapshot pair, as cloud-wx-interpolation
// does: the page settles at 21:40:00Z (the weather quantum 21:40 is fetched),
// and the step to 21:50:15Z crosses into the quantum 21:50, so the new snapshot
// is published with the 21:40 one as its predecessor and the fade (15 s of the
// 30 s default) is half done and held by the frozen clock. The transition then
// allocates "Cloud previous weather snapshot" and, with it, a second
// "Cloud geographic material flow" buffer (the main march owns the first under
// the same label). `lib/device-loss-steps.mjs` runs the step before the
// teardown or the forced loss, on both pages.
//
// INERT DIAL, SAID PLAINLY. cloudVerticalWeather applies to a single deck: the
// renderer ignores it when the march is multi-deck (`config.cloudVerticalWeather
// === true && !multiDeckOn`), and this scene has cloudMultiDeck on. The vertical
// plane is still produced here, but by the populations dial
// (`verticalEnabled = ... || populationsEnabled`), which allocates the layered
// "WeatherMap" texture; the cloudVerticalWeather dial itself adds nothing on
// this rig (cloud-wx-vertical, a single-deck scene, is where it is exercised).
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-T-wx`, with `--owner-labels
// "Cloud previous weather snapshot,Cloud geographic material flow,WeatherMap"`
// naming the owners that must be released after the teardown.

export default Object.freeze({
  id: "cloud-flight-multideck-hdr-1080p-wx",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Flight cell E-F with the weather map and the four weather dials on: 2,500 m over (-100, 40), heading north, pitched 12 degrees down, 21:40Z on the June solstice; multi-deck volumetric cumulus (coverage 0.6, density 0.35, 1,500-4,000 m, physical aerial, sky-LUT ambient, high tier), highDynamicRange on, 4x MSAA, globe lighting and sky multiple scattering on, Natural Earth imagery on the ellipsoid, 1920x1080; weather map, weather workers, weather interpolation, vertical weather and independent weather layers on; the clock stepped to 21:50:15Z.",
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
    cloudWeatherMap: true,
    cloudAerialMode: "physical",
    cloudAmbientSource: "sky-lut",
    cloudMultiDeck: true,
    highDynamicRange: true,
    msaaSamples: 4,
    globeEnableLighting: true,
    skyAtmosphereMultipleScattering: true,
    imagery: "naturalEarth",
    terrain: "ellipsoid",
    cloudWeatherWorkers: true,
    cloudWeatherInterpolation: true,
    cloudVerticalWeather: true,
    clockSteps: ["2026-06-21T21:50:15Z"],
    settleFramesPerStep: 240,
  },
  experimental: {
    cloudIndependentWeatherLayers: true,
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
