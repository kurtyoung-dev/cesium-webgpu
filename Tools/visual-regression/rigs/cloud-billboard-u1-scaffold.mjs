// Rig record for the cloud-family probe-kit harvest (round 1): the scene this probe declared, re-declared as data.
//
// @purpose Rig record for the Batch 617 cloud-unification API scaffold scene: a billboard cloud deck over a black background on both backends.
// @status ACTIVE

export default Object.freeze({
  id: "cloud-billboard-u1-scaffold",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Billboard cumulus deck in a CloudCollection seen from 16,000 m over (-98, 40) in the viewer's starting orientation, globe, sky box, sky atmosphere, sun and moon hidden over black, 12 settle frames, captured on both backends so the default-off volumetric API can be shown to leave the billboard render unchanged.",
  declaredBy: "probe-cloud-u1-scaffold",
  camera: {
    lon: -98,
    lat: 40,
    height: 16000,
  },
  clock: null,
  dials: {
    globeShow: false,
    skyBoxShow: false,
    skyAtmosphereShow: false,
    sunShow: false,
    moonShow: false,
    backgroundColor: "rgb(0,0,0)",
  },
  viewport: {
    width: 800,
    height: 500,
  },
  readiness: {
    kind: "settleFrames",
    frames: 12,
  },
});
