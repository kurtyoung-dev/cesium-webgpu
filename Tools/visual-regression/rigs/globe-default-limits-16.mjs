// Rig record for probe-globe-default-limits.mjs's "globe-default-limits-16" scene (globe family, probe-kit harvest).
//
// @purpose Rig record for probe-globe-default-limits.mjs's "globe-default-limits-16" scene (globe family, probe-kit harvest).
// @status ACTIVE

export default Object.freeze({
  id: "globe-default-limits-16",
  tags: ["globe"],
  page: "index.html",
  renderers: ["webgpu"],
  description:
    "Globe on a device pinned to 16 sampled textures per stage (the WebGPU default limit): a bare page with its own widget, offline NaturalEarthII imagery, one layer, full disc at 0 E, 20 N from 18,000 km.",
  camera: {
    lon: 0,
    lat: 20,
    height: 18000000,
  },
  clock: null,
  dials: {
    maxSampledTexturesPerShaderStage: 16,
    baseLayer: "NaturalEarthII",
    gridOverlayLayers: 0,
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
