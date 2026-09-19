// Rig record for the sandcastle-smoke.mjs gallery demo "WebGPU Orbital Catalog.html".
//
// @purpose Rig record for the sandcastle-smoke.mjs gallery demo "WebGPU Orbital Catalog.html".
// @status ACTIVE

export default Object.freeze({
  id: "sandcastle-webgpu-orbital-catalog",
  tags: ["sandcastle"],
  page: "Apps/Sandcastle/gallery/WebGPU Orbital Catalog.html",
  renderers: ["webgpu"],
  description:
    'sandcastle-smoke.mjs DEMOS entry "WebGPU Orbital Catalog.html" — globe + depth plane + compute-instance system.',
  camera: null,
  clock: null,
  dials: {
    minNonBlackPct: 0.08,
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
