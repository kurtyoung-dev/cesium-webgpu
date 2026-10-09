// Rig record for probe-clustered-dispatcher.mjs: the synthetic light list and projection it dispatches a standalone dispatcher with.
//
// @purpose Rig record for probe-clustered-dispatcher.mjs: the synthetic inputs (one directional and one point light, an identity view and a 640 x 360, 60-degree perspective projection) it hands a standalone clustered-lighting dispatcher on the viewer page's device.
// @status ACTIVE
//
// THIS RIG IS AN INPUT RECORD, NOT A FRAME. The probe draws nothing: it
// builds its own dispatcher on the page's GPU device and dispatches the
// compute passes with these inputs, then reads the GPU buffers back. The page
// and viewport are the host it ran in. `readiness` is the registry's minimum,
// not a measured settle: the probe waits only for the viewer and its device.
// `fovYRadians` is the exact double of `Math.PI / 3`. Every value is the
// probe's own pre-harvest constant; the probe now reads them from here.

export default Object.freeze({
  id: "clustered-dispatcher-synthetic",
  tags: ["clustered"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Synthetic inputs for a standalone clustered-lighting dispatcher on the viewer page's device: one directional light and one point light 50 m ahead of an identity view, through a 640 by 360 perspective projection of 60 degrees with near 1 m and far 1000 m. Nothing is drawn.",
  camera: null,
  clock: null,
  dials: {
    projection: {
      viewportWidth: 640,
      viewportHeight: 360,
      fovYRadians: 1.0471975511965976,
      near: 1,
      far: 1000,
    },
    lights: [
      {
        lightType: 0,
        posOrDirWC: { x: 0, y: -1, z: -1 },
        color: { r: 1, g: 1, b: 1 },
        intensity: 1,
        range: 0,
      },
      {
        lightType: 1,
        posOrDirWC: { x: 0, y: 0, z: -50 },
        color: { r: 1, g: 0.5, b: 0.2 },
        intensity: 5,
        range: 80,
      },
    ],
  },
  viewport: { width: 800, height: 600 },
  readiness: { kind: "settleFrames", frames: 1 },
});
