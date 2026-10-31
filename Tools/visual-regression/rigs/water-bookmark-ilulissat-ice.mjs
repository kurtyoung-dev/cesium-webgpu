// Rig record for the demo bookmark "Ilulissat Icefjord": polar sea water at 69 N under the enhanced ocean.
//
// @purpose Rig record for the Ilulissat Icefjord bookmark (-51.08, 69.21, 1450 m, heading 295 deg, pitch -18 deg) on the ellipsoid terrain with Natural Earth II imagery at 2026-06-21T15:30:00Z, wave epoch pinned, globalWaterMask and enableEnhancedOcean on, both renderers (the polar sea-ice and glacial-plume styling is WebGPU), 1280x720, 120 settled frames.
// @status ACTIVE
//
// CAMERA AND CLOCK. Value for value `LOCATIONS.arcticIlulissat` in
// `packages/sandcastle/gallery/webgpu-global-water-weather/main.js`.
//
// WHAT THE DIALS MAKE THE SCENE SHOW. Latitude 69.21 is above the polar gate
// (|sin lat| > 0.805, about 53.6 degrees) of the sea-ice and glacial-plume path
// (`computePolarSeaIceAndGlacialPlume`, called inside the `ENHANCED_OCEAN` arm
// of `GlobeTerrain.wgsl`), so the WebGPU
// leg shows that styling over the fjord's water-mask pixels. `GlobeFS.glsl` has
// no such path: the WebGL leg is the classic water-mask render. The ellipsoid
// terrain has no fjord or glacier relief and the Natural Earth II imagery is
// local, so nothing streams ion. There is no OFF twin yet.

export default Object.freeze({
  id: "water-bookmark-ilulissat-ice",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Ilulissat Icefjord bookmark (-51.08, 69.21, 1450 m, heading 295 deg, pitch -18 deg) on the ellipsoid terrain with Natural Earth II imagery at 2026-06-21T15:30:00Z, globalWaterMask and enableEnhancedOcean on: the polar sea-ice and glacial-plume styling on WebGPU, the classic water mask on WebGL.",
  declaredBy:
    "packages/sandcastle/gallery/webgpu-global-water-weather/main.js LOCATIONS.arcticIlulissat",
  camera: {
    lon: -51.08,
    lat: 69.21,
    height: 1450,
    heading: 5.148721293383272,
    pitch: -0.3141592653589793,
    roll: 0,
  },
  clock: "2026-06-21T15:30:00Z",
  dials: {
    pinClock: true,
    waterSimulationEpoch: "2026-06-21T15:30:00Z",
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
