// Rig record for the demo bookmark "Mariana Trench - Challenger Deep": enhanced deep ocean seen from 5.2 km.
//
// @purpose Rig record for the Mariana Challenger Deep bookmark (142.2, 11.35, 5200 m, heading 35 deg, pitch -30 deg) on the ellipsoid terrain with Natural Earth II imagery at 2026-06-21T03:30:00Z, wave epoch pinned, globalWaterMask and enableEnhancedOcean on, both renderers (the enhanced deep-water styling is WebGPU), 1280x720, 120 settled frames.
// @status ACTIVE
//
// CAMERA AND CLOCK. Value for value `LOCATIONS.marianaChallenger` in
// `packages/sandcastle/gallery/webgpu-global-water-weather/main.js`.
//
// WHAT THE DIALS MAKE THE SCENE SHOW. Open deep ocean under the enhanced-ocean
// styling (`enableEnhancedOcean` has its shader consumer in `GlobeTerrain.wgsl`;
// `GlobeFS.glsl` only mentions it in comments, so on WebGL the leg is the
// classic water-mask render). The terrain is the ellipsoid, so there is NO
// trench relief and no bathymetry dial exists: this rig does NOT isolate
// bathymetry, it is the enhanced-ocean look over deep water, with no OFF twin.
// The Natural Earth II imagery is local, so nothing streams ion.

export default Object.freeze({
  id: "water-bookmark-mariana-trench",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Mariana Challenger Deep bookmark (142.2, 11.35, 5200 m, heading 35 deg, pitch -30 deg) on the ellipsoid terrain (no trench relief) with Natural Earth II imagery at 2026-06-21T03:30:00Z, globalWaterMask and enableEnhancedOcean on: the enhanced deep-water look on WebGPU, the classic water mask on WebGL; not a bathymetry isolation.",
  declaredBy:
    "packages/sandcastle/gallery/webgpu-global-water-weather/main.js LOCATIONS.marianaChallenger",
  camera: {
    lon: 142.2,
    lat: 11.35,
    height: 5200,
    heading: 0.6108652381980153,
    pitch: -0.5235987755982988,
    roll: 0,
  },
  clock: "2026-06-21T03:30:00Z",
  dials: {
    pinClock: true,
    waterSimulationEpoch: "2026-06-21T03:30:00Z",
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
