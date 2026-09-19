// Rig record for the sandcastle-smoke.mjs gallery demo "WebGPU Point Light Shadows.html".
//
// @purpose Rig record for the sandcastle-smoke.mjs gallery demo "WebGPU Point Light Shadows.html".
// @status ACTIVE

export default Object.freeze({
  id: "sandcastle-webgpu-point-light-shadows",
  tags: ["sandcastle"],
  page: "Apps/Sandcastle/gallery/WebGPU Point Light Shadows.html",
  renderers: ["webgpu"],
  description:
    'sandcastle-smoke.mjs DEMOS entry "WebGPU Point Light Shadows.html" — entity geometry + glTF model + point-light shadows.',
  camera: null,
  clock: null,
  dials: {
    minNonBlackPct: 0.5,
  },
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleMs",
    ms: 8000,
  },
});
