// Rig record for the ssr family: a glTF tower standing on the flat WGS84
// ellipsoid, seen from low and to one side, with screen-space reflections on.
//
// @purpose Rig record for the WebGPU screen-space reflections pass - the Wood Tower model on the bare WGS84 ellipsoid with no imagery (offline page) at 100 W, 40 N, a low oblique camera 220 m south and 80 m west of it, SSR on, WebGPU only, 1280x720.
// @status ACTIVE
//
// WHAT IT IS FOR. The SSR pass draws one full-screen triangle and reflects the
// scene off any surface whose reconstructed normal faces the camera. The
// camera is placed so the frame shows both things a defect in that pass moves:
// the half of the target above the screen diagonal (u > v), which a triangle
// that covers only NDC x + y <= 0 never writes, and the tower's mirror image in
// the ground, which lies at u 0.74-0.89, v 0.47-0.83 for this camera and
// model (pinhole projection of the model's 26.5 m x 48 m bounding box and its
// reflection in the plane z = 0, 60 degree horizontal field of view). The
// mirror image sits in the u > v half for v below about 0.74.
//
// THE PLANE IS THE ELLIPSOID, AND NOTHING IS STREAMED. The page is CesiumViewer
// with `offline=true` (`Apps/CesiumViewer/CesiumViewerStartupOptions.js`): no
// world terrain, no base layer, no picker. `dials.terrain: "ellipsoid"` and
// `dials.imagery: "none"` are what the driver pins and reads back before the
// camera is placed. The ellipsoid is flat to well under a millimetre over the
// 250 m this frame spans, so the ground is the reflector and its depth-derived
// normal is the local up, and with no imagery the ground is the globe's base
// colour, so two builds that do not differ in what this frame draws render
// it byte for byte. An earlier form of this rig chose the ellipsoid through the
// base-layer picker on the online page; the page's world terrain, requested at
// startup, could still arrive after that choice and replace it, and its Edge
// capture recorded the camera at 661-670 m with the tower out of frame.
//
// THE CAMERA IS PLACED AFTER THE TERRAIN HOLDS, through the determinism kit's
// `placeCameraAfterTerrain`, and a cell whose camera does not read back within
// 1 m of `camera.height` (in the page and in the `view=` the page records) is
// refused rather than measured.
//
// THE MODEL IS ONE AN EXISTING RIG ALREADY LOADS. `Wood_Tower.glb` is the model
// of the "WebGPU Point Light Shadows" gallery demo (rig
// `sandcastle-webgpu-point-light-shadows`); it is 26.5 m wide and 48.1 m tall,
// base at its origin. It is placed with its base on the ellipsoid.
//
// THE DIALS. `enableSSR` is the scene property the WebGPU environmental stage
// reads (`Scene.enableSSR`, backing `_enableSSR`); the `ssr*` knobs keep their
// engine defaults. The sibling rig `ssr-off-model-over-plane` is this rig with
// `enableSSR: false`, the control a BEFORE/AFTER pair of the pass compares to.
//
// THE CLOCK IS PINNED to the June solstice at 18:00 UTC, which puts the sun
// high over North America, so the tower and the ground are lit.

export default Object.freeze({
  id: "ssr-model-over-plane",
  tags: ["ssr"],
  page: "Apps/CesiumViewer/index.html?offline=true",
  renderers: ["webgpu"],
  description:
    "Wood Tower glTF on the bare WGS84 ellipsoid (offline page: no terrain stream, no imagery) at 100 W, 40 N, seen from 20 m up, 220 m south and 80 m west, pitch -6 deg, with scene.enableSSR on; 1280x720, clock pinned to the June solstice at 18:00 UTC. The tower and its mirror image sit in the frame's top-right half (u > v).",
  camera: {
    lon: -100.00093683,
    lat: 39.99801864,
    height: 20,
    heading: 0,
    pitch: -0.10471975511965977,
    roll: 0,
  },
  clock: "2026-06-21T18:00:00Z",
  asset: "Apps/SampleData/models/WoodTower/Wood_Tower.glb",
  dials: {
    terrain: "ellipsoid",
    imagery: "none",
    enableSSR: true,
    model: {
      lon: -100,
      lat: 40,
      height: 0,
      heading: 0,
    },
  },
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 300,
  },
});
