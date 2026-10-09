// Rig record for probe-clustered-lights-resize.mjs: one point light and two projections that differ only in cluster bounds.
//
// @purpose Rig record for probe-clustered-lights-resize.mjs: one off-centre point light, an identity view and two projections (A and B) that change only the viewport aspect, field of view and near/far, dispatched through one standalone clustered-lighting dispatcher on the viewer page's device.
// @status ACTIVE
//
// THIS RIG IS AN INPUT RECORD, NOT A SCENE. The probe dispatches a dispatcher
// it builds itself; its one capture is a record frame of the viewer page as
// loaded, which shows the default view and none of these inputs. `readiness`
// is the registry's minimum, not a measured settle: the probe waits only for
// the viewer and its device. `fovYRadians` are the exact doubles of
// `Math.PI / 3` (A) and `Math.PI / 2` (B). Every value is the probe's own
// pre-harvest constant; the probe now reads them from here.

export default Object.freeze({
  id: "clustered-bounds-resize-synthetic",
  tags: ["clustered"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Synthetic inputs for a standalone clustered-lighting dispatcher: one off-centre point light ahead of an identity view, dispatched through projection A (640 by 360, 60 degrees, far 1000 m) and then projection B (1280 by 360, 90 degrees, far 150 m) with the view and light unchanged.",
  camera: null,
  clock: null,
  dials: {
    light: {
      lightType: 1,
      posOrDirWC: { x: 18, y: 8, z: -40 },
      color: { r: 1, g: 0.6, b: 0.3 },
      intensity: 5,
      range: 55,
    },
    projectionA: {
      viewportWidth: 640,
      viewportHeight: 360,
      fovYRadians: 1.0471975511965976,
      near: 1,
      far: 1000,
    },
    projectionB: {
      viewportWidth: 1280,
      viewportHeight: 360,
      fovYRadians: 1.5707963267948966,
      near: 1,
      far: 150,
    },
  },
  viewport: { width: 800, height: 600 },
  readiness: { kind: "settleFrames", frames: 1 },
});
