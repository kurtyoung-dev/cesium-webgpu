// Rig record for the cloud-family probe-kit harvest (round 1): the scene this probe declared, re-declared as data.
//
// @purpose Rig record for the Batch 437 cloud-shadow off-path parity scene, terrain leg: a lit terrain view with clouds off and cloud shadows off.
// @status ACTIVE

export default Object.freeze({
  id: "cloud-shadows-parity-terrain",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Lit terrain from 6,000 m over (-109.5, 38.5), heading 30 degrees and pitched 18 degrees down, at 17:00 UTC on the June solstice; globe lighting on, sky atmosphere shown, volumetric clouds off and cloud cast shadows off; rendered until the globe reports its tiles loaded for 60 consecutive frames, then 60 more.",
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
    skyAtmosphereShow: true,
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
