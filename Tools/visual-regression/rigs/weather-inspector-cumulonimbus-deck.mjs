// Rig record for the cloud-family probe-kit harvest (round 1): the scene these probes declared, re-declared as data.
//
// @purpose Rig record for the dense cumulonimbus deck the Weather Inspector demo cohort measures its toggles against, in the demo's own camera and clock.
// @status ACTIVE

export default Object.freeze({
  id: "weather-inspector-cumulonimbus-deck",
  tags: ["cloud"],
  page: "Apps/Sandcastle/gallery/WebGPU%20Weather%20Inspector.html",
  renderers: ["webgpu"],
  description:
    "The WebGPU Weather Inspector gallery demo, booted standalone, with its default cloud collection set to cumulonimbus at coverage 0.85 and density 0.5 and its clock frozen, in the demo's own camera; 9 seconds of settle before the first capture of the deck.",
  declaredBy: "probe-cloud-special, probe-cloud-features",
  camera: null,
  clock: null,
  dials: {
    collectionCloudType: 10,
    cloudCoverage: 0.85,
    cloudDensity: 0.5,
    shouldAnimate: false,
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleMs",
    ms: 9000,
  },
});
