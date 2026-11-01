// Rig record for the landing program's cell E-DG-upsampled: the camera controller's water dive gate at Point Nemo, the ocean pole of inaccessibility, 2,700 km from the nearest land.
//
// @purpose Rig record for the landing cell E-DG-upsampled (the dive-gate step on Point Nemo, the ocean pole of inaccessibility, 2,700 km from the nearest land): the default CesiumViewer with the camera at (-123.3933, -48.8767) 150 m up, pitched down, the dive-gate step data, the global ocean mask on, 1280x720, both renderers.
// @status ACTIVE
//
// WHY THIS PLACE. Far from any coast Cesium World Terrain has only coarse ocean tiles, so the tiles under a camera 150 m up are upsampled from an ancestor; the surface there is the geoid, inside the 110 m band, and the gate has to read that upsampled height. The pre-registered gate of the dive page is "allow" and the control page (collision on) is "refuse"; the surface height the receipt reads (`globeHeight`) is what the Edge leg checks against the figure above.
//
// THE STEP DATA is the `diveGateStep` dial (placement, wheel notches, settle frames); `diveCollisionDisabled` and `diveGateExpected` are laid over it by the cell's two pages (`dive`, `control`), and the values here are the `dive` page's. The cell runs online: the streamed Cesium World Terrain and its water mask are the point.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-DG-upsampled`, both renderers.

export default Object.freeze({
  id: "dive-gate-upsampled-ocean",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "CesiumViewer with the camera at (-123.3933, -48.8767), 150 m up, pitched down, over Point Nemo, the ocean pole of inaccessibility, 2,700 km from the nearest land; the dive-gate step data, the global ocean mask on; 1280x720, both renderers.",
  declaredBy:
    "the probe-kit dive-gate cells (row DX-KIT-DIVE-GATE-CELLS); probe-landing-cells cell E-DG-upsampled renders it",
  camera: {
    lon: -123.3933,
    lat: -48.8767,
    height: 150,
    heading: 0,
    pitch: -0.6,
    roll: 0,
  },
  clock: null,
  dials: {
    globalWaterMask: true,
    diveGateStep: {
      lon: -123.3933,
      lat: -48.8767,
      height: 150,
      heading: 0,
      pitch: -0.6,
      wheelNotches: 12,
      settleFramesBeforeFirst: 600,
      settleFramesPerNotch: 30,
      // Registered before the leg: the open ocean at the geoid, which this far south lies within about 30 m of the ellipsoid.
      globeHeightWindow: { min: -45, max: 30 },
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
