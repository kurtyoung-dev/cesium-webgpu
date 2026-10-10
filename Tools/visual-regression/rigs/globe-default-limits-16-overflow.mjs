// Rig record for probe-globe-default-limits.mjs's "globe-default-limits-16-overflow" scene (globe family, probe-kit harvest).
//
// @purpose Rig record for probe-globe-default-limits.mjs's "globe-default-limits-16-overflow" scene (globe family, probe-kit harvest).
// @status ACTIVE

export default Object.freeze({
  id: "globe-default-limits-16-overflow",
  tags: ["globe"],
  page: "index.html",
  renderers: ["webgpu"],
  description:
    "The 16-texture globe with four grid layers added over NaturalEarthII, one more layer than the reduced four-slot imagery layout holds, so a second blending stage must composite the grid's green wash.",
  camera: {
    lon: 0,
    lat: 20,
    height: 18000000,
  },
  clock: null,
  dials: {
    maxSampledTexturesPerShaderStage: 16,
    baseLayer: "NaturalEarthII",
    gridOverlayLayers: 4,
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 20,
  },
});
