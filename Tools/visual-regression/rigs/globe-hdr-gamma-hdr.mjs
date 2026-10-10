// Rig record for probe-globe-hdr-gamma.mjs's "globe-hdr-gamma-hdr" scene (globe family, probe-kit harvest).
//
// @purpose Rig record for probe-globe-hdr-gamma.mjs's "globe-hdr-gamma-hdr" scene (globe family, probe-kit harvest).
// @status ACTIVE

export default Object.freeze({
  id: "globe-hdr-gamma-hdr",
  tags: ["globe"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "A two-tone known-gray tile (sRGB 100 west, 180 east) draped over an ellipsoid globe seen straight down at 0 E, 0 N from 3,500 km, lighting, fog and atmosphere off, on the HDR canvas-output path, where the globe must decode sRGB to linear once.",
  camera: {
    lon: 0,
    lat: 0,
    height: 3500000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: "2026-06-21T12:00:00Z",
  dials: {
    highDynamicRange: true,
    useHDRCanvasOutput: true,
    grayWest: 100,
    grayEast: 180,
    terrain: "ellipsoid",
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 30,
  },
});
