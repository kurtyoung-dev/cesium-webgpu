// Rig record for the cloud-family probe-kit harvest (round 1): the scene this probe declared, re-declared as data.
//
// @purpose Rig record for the Batch 409 depth-occlusion scene: a nadir view from 20,000 km over a daylit point with an 80-400 km test shell, so far-side clouds sit behind the globe disc.
// @status ACTIVE

export default Object.freeze({
  id: "cloud-depth-occlusion-thick-shell",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Nadir view from 20,000 km over a daylit point (-30, 20) at 15:00 UTC on the June solstice, with a deliberately unrealistic 80-400 km cloud shell at coverage 0.9 and density 0.5: the near cap sits in front of the globe disc, the far cap behind it, and a ring shows beyond the limb.",
  declaredBy: "probe-cloud-depth-occlusion",
  camera: {
    lon: -30,
    lat: 20,
    height: 20000000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: "2026-06-21T15:00:00Z",
  dials: {
    cloudCoverage: 0.9,
    cloudDensity: 0.5,
    cloudLayerBottom: 80000,
    cloudLayerTop: 400000,
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
