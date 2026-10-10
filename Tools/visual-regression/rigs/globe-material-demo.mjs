// Rig record for probe-globe-material.mjs's "globe-material-demo" scene (globe family, probe-kit harvest).
//
// @purpose Rig record for probe-globe-material.mjs's "globe-material-demo" scene (globe family, probe-kit harvest).
// @status ACTIVE

export default Object.freeze({
  id: "globe-material-demo",
  tags: ["globe"],
  page: "Apps/Sandcastle/gallery/Globe Materials.html",
  renderers: ["webgpu"],
  description:
    "The legacy Globe Materials gallery demo under a forced-renderer viewer shim, with the elevation material selected; the scene of the retired globe material runner.",
  camera: null,
  clock: null,
  dials: {
    material: "elevation",
  },
  viewport: {
    width: 800,
    height: 600,
  },
  readiness: {
    kind: "settleMs",
    ms: 12000,
  },
});
