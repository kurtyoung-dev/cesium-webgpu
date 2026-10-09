// Rig record for probe-clustered-zero-work-route.mjs's positive-control scene (its Phase B).
//
// @purpose Rig record for probe-clustered-zero-work-route.mjs's Phase B: clustered lighting enabled with one point light near Everest, viewed from 600 m on the offline viewer page, where the counted clustered GPU work must appear.
// @status ACTIVE
//
// Phase A of the probe is the moving camera route `GLOBE_CAMERA_TRACK`
// (`lib/globe-camera-track.mjs`), which a single rig camera cannot hold; this
// rig records the scene Phase A ends on and Phase B measures. The page carries
// the offline flag the probe always loaded it with. Pitch is stored in radians
// as `-20 * (Math.PI / 180)`; no heading is given, as the probe gave none.
// Every value is the probe's own pre-harvest constant; the probe now reads
// them from here.

export default Object.freeze({
  id: "clustered-zero-work-control",
  tags: ["clustered"],
  page: "Apps/CesiumViewer/index.html?offline=true",
  renderers: ["webgpu"],
  description:
    "The zero-work route's positive control on the offline viewer page: clustered lighting enabled with one yellow point light 200 m up near Everest, viewed from 600 m pitched 20 degrees down, after the moving multi-altitude route has been flown with the feature at its default.",
  camera: {
    lon: 86.925,
    lat: 27.985,
    height: 600,
    pitch: -0.3490658503988659,
  },
  clock: null,
  dials: {
    pointLight: {
      lon: 86.925,
      lat: 27.99,
      height: 200,
      colorName: "YELLOW",
      intensity: 5,
      range: 500,
    },
    framesPerWaypoint: 4,
    controlFrames: 20,
  },
  viewport: { width: 1000, height: 1000 },
  readiness: { kind: "settleFrames", frames: 20 },
});
