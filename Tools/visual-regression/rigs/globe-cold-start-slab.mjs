// Rig record for probe-globe-cold-start-readiness.mjs's "globe-cold-start-slab" scene (globe family, probe-kit harvest).
//
// @purpose Rig record for probe-globe-cold-start-readiness.mjs's "globe-cold-start-slab" scene (globe family, probe-kit harvest).
// @status ACTIVE

export default Object.freeze({
  id: "globe-cold-start-slab",
  tags: ["globe"],
  page: "Tools/visual-regression/globe-cold-start-harness.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Cold-start readiness view: Yosemite slab at low pitch from 6 km, terrain with vertex normals; the probe compares a settle gated on the readiness predicate with the legacy settle here.",
  camera: {
    lon: -119.55,
    lat: 37.62,
    height: 6000,
    heading: 0,
    pitch: -0.20943951023931953,
    roll: 0,
  },
  clock: "2026-08-28T18:00:00Z",
  viewport: {
    width: 1024,
    height: 640,
  },
  readiness: {
    kind: "settleFrames",
    frames: 30,
  },
});
