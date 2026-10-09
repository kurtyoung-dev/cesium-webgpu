// Rig record for the C11-193B/C dynamic-IBL scene (probe-c11-193b-shared-submit.mjs, probe-c11-193c-demand-priority.mjs).
//
// @purpose Rig record for the C11-193B/C dynamic-IBL scene: two TestKhrSpecular models each owning a dynamic environment map manager, on the offline WebGPU viewer at 1000x720.
// @status ACTIVE
//
// `page: null` because the models, their managers and the manual render loop
// are built in-page by the probes; `basePage` names the rig they boot from.
// The 4-frame settle is the probes' `idleWarmFramesRequired`.

export default Object.freeze({
  id: "c11-dynamic-ibl-khr-specular",
  tags: ["c11"],
  page: null,
  basePage: "c11-viewer-offline-webgpu",
  renderers: ["webgpu"],
  description:
    "C11-193 dynamic-IBL scene: two independent model-owned dynamic environment map managers on the KHR specular test asset, driven by a pinned manual render loop on WebGPU.",
  asset: "Apps/SampleData/models/TestKHRExtensions/TestKhrSpecular.gltf",
  camera: null,
  clock: null,
  viewport: {
    width: 1000,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 4,
  },
});
