// Rig record for the demo bookmark "Nile River, Cairo" with the major-rivers water mask on.
//
// @purpose Rig record for the Cairo Nile bookmark (31.23, 30.05, 1350 m, heading 5 deg, pitch -24 deg) on the ellipsoid terrain with Natural Earth II imagery at 2026-06-21T10:30:00Z, wave epoch pinned, globalWaterMask, riverWaterMask and enableEnhancedOcean on, both renderers (the river shows on WebGPU only), 1280x720, 120 settled frames.
// @status ACTIVE
//
// CAMERA AND CLOCK. Value for value `LOCATIONS.nileRiver` in
// `packages/sandcastle/gallery/webgpu-global-water-weather/main.js` (the camera
// at `destination`/`orientation`, the clock at `time`).
//
// WHAT THE DIALS MAKE THE SCENE SHOW. `riverWaterMask` loads the major-rivers
// mask into the globe (`Globe.riverWaterMask`); its only shader consumer is the
// WebGPU globe (`GlobeTerrain.wgsl`). `GlobeFS.glsl` has no reader of the river
// mask, so on WebGL this rig draws the classic water-mask globe with NO river:
// the WebGL leg is a baseline for "river mask has no effect there", not a
// river picture. The Natural Earth II imagery is local, so nothing streams ion.
// There is no OFF twin yet (a twin would flip only `riverWaterMask`).

export default Object.freeze({
  id: "water-bookmark-cairo-nile",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Cairo Nile bookmark (31.23, 30.05, 1350 m, heading 5 deg, pitch -24 deg) on the ellipsoid terrain with Natural Earth II imagery at 2026-06-21T10:30:00Z, globalWaterMask, riverWaterMask and enableEnhancedOcean on; the Nile river mask draws on WebGPU only (WebGL has no river-mask reader and shows the plain water-mask globe).",
  declaredBy:
    "packages/sandcastle/gallery/webgpu-global-water-weather/main.js LOCATIONS.nileRiver",
  camera: {
    lon: 31.23,
    lat: 30.05,
    height: 1350,
    heading: 0.08726646259971647,
    pitch: -0.41887902047863906,
    roll: 0,
  },
  clock: "2026-06-21T10:30:00Z",
  dials: {
    pinClock: true,
    waterSimulationEpoch: "2026-06-21T10:30:00Z",
    terrain: "ellipsoid",
    imagery: "naturalEarth",
    globalWaterMask: true,
    lakeWaterMask: false,
    riverWaterMask: true,
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
