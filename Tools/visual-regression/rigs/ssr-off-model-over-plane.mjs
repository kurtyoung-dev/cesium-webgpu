// Rig record for the ssr family's control: `ssr-model-over-plane` with
// screen-space reflections off.
//
// @purpose Rig record for the SSR-off control - the same Wood Tower, offline page, bare ellipsoid, no imagery, camera, clock and viewport as ssr-model-over-plane, with scene.enableSSR false, WebGPU only.
// @status ACTIVE
//
// WHAT IT IS FOR. Two things. Paired with `ssr-model-over-plane` in the same
// slot, it is the frame the SSR pass is measured against: wherever the pass
// should reflect nothing the two must agree, and wherever it reflects the
// tower they must not. Paired with ITSELF across a BEFORE and an AFTER build,
// it is the "SSR off stays byte-identical" check: with `enableSSR` false the
// pass never runs and its pipeline is never created, so a change confined to
// the SSR shader must leave this frame byte for byte. The offline page and the
// pinned no-imagery ellipsoid are what make byte identity the expectation: an
// earlier online form of this pair differed by 7.53 levels across two builds,
// in the ground detail only (the sky rows were unchanged).
//
// Every field but `id`, the description and `dials.enableSSR` is the SSR-on
// rig's, so the two differ in exactly one dial.

export default Object.freeze({
  id: "ssr-off-model-over-plane",
  tags: ["ssr"],
  page: "Apps/CesiumViewer/index.html?offline=true",
  renderers: ["webgpu"],
  description:
    "Control for ssr-model-over-plane: the same Wood Tower glTF on the bare WGS84 ellipsoid (offline page, no imagery) at 100 W, 40 N, the same camera, clock and 1280x720 viewport, with scene.enableSSR off.",
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
    enableSSR: false,
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
