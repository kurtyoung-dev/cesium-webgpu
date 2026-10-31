// Rig record for the globe-material landing cell: the tile water mask as the picture.
//
// @purpose Rig record for the globe-material landing cell E-M-water: the water-coast-50km scene (San Francisco's coast from 50 km on the ellipsoid terrain with Natural Earth II imagery at 16:00Z on the June solstice, globalWaterMask on, enhanced ocean off) with globe.showWaterEffect off and globe.material set to the built-in WaterMask material, so the globe material's materialInput.waterMask is the picture, both renderers, 1280x720, 120 settled frames.
// @status ACTIVE
//
// WHERE IT COMES FROM. The Sandcastle demo
// `globe-materials-water-mask-elevation-map` sets `globe.material` to a
// material reading `materialInput.waterMask` and switches
// `globe.showWaterEffect` off. This rig is that recipe as data, on the camera,
// clock, viewport and water dials of `water-coast-50km` so the two differ in
// the material and the water-effect flag alone.
//
// WHY THE WATERMASK MATERIAL. The built-in `WaterMask` material paints water
// white and land transparent, so with the water effect off the mask itself is
// the picture: a WebGPU globe that fed the material 0.0 instead of the tile's
// mask shows no white sea, and a tree that feeds it the mask shows the coast.
//
// WHY THE ELLIPSOID AND GLOBALWATERMASK. They give an offline page a real tile
// water mask with no ion token: the ellipsoid terrain supplies none of its
// own, and `globalWaterMask` is the dial that supplies the global one.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-M-water`, off the default
// cell list.

export default Object.freeze({
  id: "globe-material-water-mask",
  tags: ["globe", "water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "San Francisco's coast from 50 km (-122.45, 37.75, 50000 m, heading 0, pitch -1.2) on the ellipsoid terrain with Natural Earth II imagery at 16:00Z on the June solstice, globalWaterMask on, enhanced ocean off, water effect off and the WaterMask globe material on.",
  declaredBy: "salvage lane D (DX-KIT-MATERIAL-DIAL)",
  camera: {
    lon: -122.45,
    lat: 37.75,
    height: 50000,
    heading: 0,
    pitch: -1.2,
    roll: 0,
  },
  clock: "2026-06-21T16:00:00Z",
  dials: {
    pinClock: true,
    waterSimulationEpoch: "2026-06-21T16:00:00Z",
    terrain: "ellipsoid",
    imagery: "naturalEarth",
    globalWaterMask: true,
    lakeWaterMask: false,
    riverWaterMask: false,
    enableEnhancedOcean: false,
    globeShowWaterEffect: false,
    globeMaterial: "WaterMask",
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
