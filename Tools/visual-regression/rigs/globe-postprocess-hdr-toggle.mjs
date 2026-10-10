// Rig record for probe-postprocess-hdr-toggle.mjs's one scene: the default globe on WebGPU taken through the HDR toggle steps of lib/postprocess-hdr-toggle-steps.mjs.
//
// @purpose Rig record for probe-postprocess-hdr-toggle.mjs's one scene: the default globe on WebGPU taken through the HDR toggle steps of lib/postprocess-hdr-toggle-steps.mjs.
// @status ACTIVE

export default Object.freeze({
  id: "globe-postprocess-hdr-toggle",
  tags: ["globe"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "The CesiumViewer default globe from its home view, with colour grading on at saturation 0 so a live grading stage reads as a grey frame and a dropped one as a coloured frame, captured once at the pinned start (highDynamicRange and useHDRCanvasOutput both off) and once after each toggle step.",
  camera: null,
  clock: "2026-06-21T12:00:00Z",
  dials: {
    hdrDisplayPolicy: "off",
    highDynamicRange: false,
    useHDRCanvasOutput: false,
    colorGradingEnabled: true,
    colorGradingConfig: Object.freeze({ saturation: 0 }),
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
