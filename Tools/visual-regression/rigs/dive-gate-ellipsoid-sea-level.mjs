// Rig record for the landing program's cell E-DG-ellipsoid: the camera controller's water dive gate at the open Pacific at (-140, 10).
//
// @purpose Rig record for the landing cell E-DG-ellipsoid (the dive-gate step on the open Pacific at (-140, 10)): the default CesiumViewer with the camera at (-140, 10) 150 m up, pitched down, the dive-gate step data, no masks, 1280x720, both renderers.
// @status ACTIVE
//
// WHY THIS PLACE. On the ellipsoid terrain provider the surface height under the camera is exactly 0, so the gate reads the collision flag alone; nothing is streamed, which is why this cell may run offline. The pre-registered gate of the dive page is "allow" and the control page (collision on) is "refuse"; the surface height the receipt reads (`globeHeight`) is what the Edge leg checks against the figure above.
//
// THE STEP DATA is the `diveGateStep` dial (placement, wheel notches, settle frames); `diveCollisionDisabled` and `diveGateExpected` are laid over it by the cell's two pages (`dive`, `control`), and the values here are the `dive` page's. The cell may run offline: the ellipsoid terrain needs no stream.
//
// THE CLOCK is pinned to the daylight instant 2026-06-21T18:00:00Z: a rig that leaves it `null` freezes the wall clock at load, and the terrain and ocean frames then render at night whenever the run starts.
//
// GATE-ONLY FRAMES. The open ocean under naturalEarth imagery is one flat field at every height this dive visits (7.9 m at the dive end, 1.0 m at the control end): the dive and control frames, and both renderers, come out byte-identical, so a frame compare of this cell says nothing about the camera. No stage dial or imagery the kit declares draws a height-dependent reference on both renderers (the fragment debug modes are WebGPU-only), so the rig declares `frames: "gate-only"`: the gate verdict is the whole acceptance and the receipt marks the cell `not-comparable: gate-only cell`.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-DG-ellipsoid`, both renderers.

export default Object.freeze({
  id: "dive-gate-ellipsoid-sea-level",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "CesiumViewer with the camera at (-140, 10), 150 m up, pitched down, over the open Pacific at (-140, 10); the dive-gate step data, no masks; the clock pinned to the daylight instant 2026-06-21T18:00:00Z; 1280x720, both renderers.",
  declaredBy:
    "the probe-kit dive-gate cells (row DX-KIT-DIVE-GATE-CELLS); probe-landing-cells cell E-DG-ellipsoid renders it",
  camera: {
    lon: -140,
    lat: 10,
    height: 150,
    heading: 0,
    pitch: -0.6,
    roll: 0,
  },
  clock: "2026-06-21T18:00:00Z",
  frames: "gate-only",
  dials: {
    terrain: "ellipsoid",
    imagery: "naturalEarth",
    diveGateStep: {
      lon: -140,
      lat: 10,
      height: 150,
      heading: 0,
      pitch: -0.6,
      wheelNotches: 12,
      settleFramesBeforeFirst: 120,
      settleFramesPerNotch: 30,
      // Registered before the leg: the ellipsoid terrain provider, exactly 0 m.
      globeHeightWindow: { min: -1, max: 1 },
    },
    diveCollisionDisabled: true,
    diveGateExpected: "allow",
  },
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 120,
  },
});
