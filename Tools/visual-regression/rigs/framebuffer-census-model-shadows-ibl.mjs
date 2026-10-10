// Rig record for the framebuffer census's model cell: a glTF model with
// shadows on and the model's own image-based lighting, on the CesiumViewer
// page.
//
// @purpose Rig record for the framebuffer census model cell: CesiumMilkTruck on the WGS84 ellipsoid in Oregon at 20:00 UTC on the June solstice, shadows on, its default image-based lighting and environment map, looked at from 18 m, 1280x720, WebGPU only, captured 240 frames after the model is ready.
// @status ACTIVE
//
// WHO RENDERS IT. `probe-stub-texture-uploads.mjs --scene framebuffer-census`,
// through `lib/framebuffer-census-steps.mjs`, which adds the model, turns the
// shadows on and points the camera from these dials.
//
// WHY A RIG OF ITS OWN. The census needs one model scene whose framebuffers
// come from shadow maps and the model's image-based lighting. No model rig
// existed at the base this was written on. FOLD NOTE: when the model family's
// rigs land (`model-ibl-khr-specular`, `model-env-capture-milktruck`), this
// cell moves onto `model-env-capture-milktruck` by id and this file is
// retired.
//
// THE CAMERA. `camera` is null because the steps aim the camera at the model
// once it is placed (`lookAt`).
//
// THE GROUND IS THE ELLIPSOID, SO THE FRAME DOES NOT WAIT ON TERRAIN. The first
// version clamped the truck to the page's streamed world terrain and aimed the
// camera at height 0: four of five Edge runs captured a black frame (the camera
// 18 m from a point under the terrain) and the fifth terrain with no truck. The
// truck now stands at height 0 on the WGS84 ellipsoid terrain the base-layer
// picker offers (the wgs84 family's dial), unclamped, so the camera's target
// is where the truck is in every run; the steps count the settle frames from
// the frame the model is ready, and refuse the cell if it never is.

export default Object.freeze({
  id: "framebuffer-census-model-shadows-ibl",
  tags: ["framebuffer-census"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "CesiumMilkTruck at height 0 on the WGS84 ellipsoid terrain at (-123.0744619, 44.0503706), shadows on, default image-based lighting, looked at from 18 m at heading 45 and pitch -25 degrees, 2026-06-21T20:00:00Z, 1280x720, 240 settle frames from the frame the model is ready.",
  camera: null,
  clock: "2026-06-21T20:00:00Z",
  dials: {
    baseLayerPickerTerrain: "wgs84",
    model: {
      url: "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb",
      lon: -123.0744619,
      lat: 44.0503706,
      height: 0,
    },
    shadows: true,
    lookAt: { headingDeg: 45, pitchDeg: -25, range: 18 },
  },
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 240,
  },
});
