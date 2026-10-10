// Rig record for the cloud-family probe-kit harvest (round 1): the scene this probe declared, re-declared as data.
//
// @purpose Rig record for the Batch 437 cloud-shadow off-path parity scene, aerial leg: a lit terrain view with clouds off and cloud shadows off.
// @status ACTIVE

export default Object.freeze({
  id: "cloud-shadows-parity-aerial",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "The lit terrain view from 6,000 m over (-109.5, 38.5) at 17:00 UTC on the June solstice with aerial perspective switched on and volumetric clouds and cloud cast shadows off; rendered until the tiles have loaded for 60 consecutive frames, then 60 more.",
  declaredBy: "probe-cloud-shadows-parity",
  camera: {
    lon: -109.5,
    lat: 38.5,
    height: 6000,
    heading: 0.5235987755982988,
    pitch: -0.3141592653589793,
    roll: 0,
  },
  clock: "2026-06-21T17:00:00Z",
  dials: {
    enableVolumetric: false,
    cloudCastShadows: false,
    globeShow: true,
    globeEnableLighting: true,
    aerialPerspectiveEnabled: true,
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 60,
    afterTilesLoadedFrames: 60,
    tilesLoadedFrameCap: 1200,
  },
});
