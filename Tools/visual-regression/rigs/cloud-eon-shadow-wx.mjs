// Rig record for the landing cell E-ON-shadow-wx: cloud-eon-shadow with the weather map on.
//
// @purpose Rig record for the landing cell E-ON-shadow-wx: cloud-eon-shadow (the underside noon scene of cloud-underside-noon-cov055: coverage 0.55, density 0.8, black sky, solar noon, with the deep shadow cache and directional lighting on) value for value, plus cloudWeatherMap on and 240 settle frames, so the cache builds against a scene whose density comes from the weather map.
// @status ACTIVE
//
// THE TWIN IS cloud-eon-shadow. DIFFERS FROM THE TWIN IN: cloudWeatherMap
// (true) and readiness.frames (240 against 90: the procedural weather is
// generated and packed asynchronously). The experimental block, camera, clock
// and viewport are the twin's. The shadow cache dials read no weather bounds,
// so the "Cloud weather volume bounds" owner is NOT expected on this rig.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-ON-shadow-wx`, with the
// cloud layout census.

export default Object.freeze({
  id: "cloud-eon-shadow-wx",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Deep shadow cache and directional lighting on, weather map on; the underside noon scene of cloud-underside-noon-cov055 (800 m above (-95, 39) under the deck, heading east and pitched 16 degrees up, solar noon on the June solstice, coverage 0.55, density 0.8, sky box, sky atmosphere and sun hidden over a black background, 240 frames at the fixed clock).",
  declaredBy: "cloud-eon-shadow",
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
  },
  experimental: {
    cloudDeepShadowCache: true,
    cloudDirectionalLighting: true,
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
