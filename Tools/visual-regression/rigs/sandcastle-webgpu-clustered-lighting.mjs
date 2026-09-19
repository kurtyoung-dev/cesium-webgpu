// Rig record for the sandcastle-smoke.mjs gallery demo "WebGPU Clustered Lighting.html".
//
// @purpose Rig record for the sandcastle-smoke.mjs gallery demo "WebGPU Clustered Lighting.html".
// @status ACTIVE

export default Object.freeze({
  id: "sandcastle-webgpu-clustered-lighting",
  tags: ["sandcastle"],
  page: "Apps/Sandcastle/gallery/WebGPU Clustered Lighting.html",
  renderers: ["webgpu"],
  description:
    'sandcastle-smoke.mjs DEMOS entry "WebGPU Clustered Lighting.html" — glTF models + clustered lighting (globe off).',
  camera: null,
  clock: null,
  dials: {
    minNonBlackPct: 0.4,
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
