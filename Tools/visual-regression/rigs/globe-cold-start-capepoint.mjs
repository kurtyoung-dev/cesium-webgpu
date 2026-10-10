// Rig record for probe-globe-cold-start-readiness.mjs's "globe-cold-start-capepoint" scene (globe family, probe-kit harvest).
//
// @purpose Rig record for probe-globe-cold-start-readiness.mjs's "globe-cold-start-capepoint" scene (globe family, probe-kit harvest).
// @status ACTIVE

export default Object.freeze({
  id: "globe-cold-start-capepoint",
  tags: ["globe"],
  page: "Tools/visual-regression/globe-cold-start-harness.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Cold-start readiness view: Cape Point from 2 km at 56.2 degrees of depression; the probe compares a settle gated on the readiness predicate with the legacy settle here.",
  camera: {
    lon: 18.4967,
    lat: -34.3568,
    height: 2000,
    heading: 0,
    pitch: -0.9808750396208132,
    roll: 0,
  },
  clock: "2026-09-24T10:38:00Z",
  viewport: {
    width: 640,
    height: 360,
  },
  readiness: {
    kind: "settleFrames",
    frames: 30,
  },
});
