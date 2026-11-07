// Rig record for the landing cell E-ON-occupancy-wx: cloud-eon-occupancy with the weather map on, so the weather volume bounds owner is allocated.
//
// @purpose Rig record for the landing cell E-ON-occupancy-wx: cloud-eon-occupancy (the underside noon scene of cloud-underside-noon-cov055: coverage 0.55, density 0.8, black sky, solar noon, with the spatial occupancy grid and the weather volume bounds on) value for value, plus cloudWeatherMap on and 240 settle frames, so the bounds have a bound weather map to build their octree from.
// @status ACTIVE
//
// THE TWIN IS cloud-eon-occupancy. The weather volume bounds need the occupancy
// grid AND a bound weather map; the twin's weather map is off, so the renderer
// never builds them and the "Cloud weather volume bounds" owner is never
// allocated there (the W4 job's finding P2-1). DIFFERS FROM THE TWIN IN:
// cloudWeatherMap (true) and readiness.frames (240 against 90: the procedural
// weather is generated and packed asynchronously and the bounds are built from
// it after that). The experimental block, camera, clock and viewport are the
// twin's.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-ON-occupancy-wx`, with the
// cloud layout census.

export default Object.freeze({
  id: "cloud-eon-occupancy-wx",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Spatial occupancy and weather volume bounds on, weather map on; the underside noon scene of cloud-underside-noon-cov055 (800 m above (-95, 39) under the deck, heading east and pitched 16 degrees up, solar noon on the June solstice, coverage 0.55, density 0.8, sky box, sky atmosphere and sun hidden over a black background, 240 frames at the fixed clock).",
  declaredBy: "cloud-eon-occupancy",
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
    cloudSpatialOccupancy: true,
    cloudWeatherVolumeBounds: true,
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
