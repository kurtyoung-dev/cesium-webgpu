// Rig record for the demo bookmark "Kauai North Shore Reef" (the flight regime shares this camera).
//
// @purpose Rig record for the Kauai North Shore Reef bookmark (-159.505, 22.252, 2200 m, heading 185 deg, pitch -28 deg) on the ellipsoid terrain with Natural Earth II imagery at 2026-06-21T22:00:00Z, wave epoch pinned, globalWaterMask and enableEnhancedOcean on, both renderers (the enhanced styling is WebGPU), 1280x720, 120 settled frames.
// @status ACTIVE
//
// CAMERA AND CLOCK. Value for value `LOCATIONS.kauai` in
// `packages/sandcastle/gallery/webgpu-global-water-weather/main.js` (the same
// pose and instant as `LOCATIONS.flight`).
//
// WHAT THE DIALS MAKE THE SCENE SHOW. Kauai's north-shore coast and shelf water
// under the enhanced-ocean styling (shader consumer: `GlobeTerrain.wgsl`; on
// WebGL the leg is the classic water-mask render). The ellipsoid terrain has no
// reef relief. It is the same lon/lat/heading/pitch as the pair
// `water-bathymetry-offline{,-off}` (2200 m here, 3500 m there, clock 22:00Z
// here, 16:00Z there). Natural Earth II imagery is local, so nothing streams ion.

export default Object.freeze({
  id: "water-bookmark-kauai-reef",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Kauai North Shore Reef bookmark (-159.505, 22.252, 2200 m, heading 185 deg, pitch -28 deg) on the ellipsoid terrain with Natural Earth II imagery at 2026-06-21T22:00:00Z, globalWaterMask and enableEnhancedOcean on: the enhanced coastal water on WebGPU, the classic water mask on WebGL.",
  declaredBy:
    "packages/sandcastle/gallery/webgpu-global-water-weather/main.js LOCATIONS.kauai",
  camera: {
    lon: -159.505,
    lat: 22.252,
    height: 2200,
    heading: 3.2288591161895095,
    pitch: -0.4886921905584123,
    roll: 0,
  },
  clock: "2026-06-21T22:00:00Z",
  dials: {
    pinClock: true,
    waterSimulationEpoch: "2026-06-21T22:00:00Z",
    terrain: "ellipsoid",
    imagery: "naturalEarth",
    globalWaterMask: true,
    lakeWaterMask: false,
    riverWaterMask: false,
    enableEnhancedOcean: true,
  },
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 120,
  },
});
