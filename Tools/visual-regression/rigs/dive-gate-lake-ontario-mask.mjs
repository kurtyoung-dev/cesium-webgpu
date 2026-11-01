// Rig record for the landing program's cell E-DG-ontario: the camera controller's water dive gate at mid Lake Ontario, about 35 km from either shore.
//
// @purpose Rig record for the landing cell E-DG-ontario (the dive-gate step on mid Lake Ontario, about 35 km from either shore): the default CesiumViewer with the camera at (-77.8, 43.6) 150 m up, pitched down, the dive-gate step data, the lake water mask on, with the global mask, 1280x720, both renderers.
// @status ACTIVE
//
// WHY THIS PLACE. An inland lake whose water mask is a lake mask and whose surface sits 75 m above sea level (about 41 m on the WGS84 ellipsoid, the geoid there being near -34 m), inside the 110 m band. The pre-registered gate of the dive page is "allow" and the control page (collision on) is "refuse"; the surface height the receipt reads (`globeHeight`) is what the Edge leg checks against the figure above.
//
// THE STEP DATA is the `diveGateStep` dial (placement, wheel notches, settle frames); `diveCollisionDisabled` and `diveGateExpected` are laid over it by the cell's two pages (`dive`, `control`), and the values here are the `dive` page's. The cell runs online: the streamed Cesium World Terrain and its water mask are the point.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-DG-ontario`, both renderers.

export default Object.freeze({
  id: "dive-gate-lake-ontario-mask",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "CesiumViewer with the camera at (-77.8, 43.6), 150 m up, pitched down, over mid Lake Ontario, about 35 km from either shore; the dive-gate step data, the lake water mask on, with the global mask; 1280x720, both renderers.",
  declaredBy:
    "the probe-kit dive-gate cells (row DX-KIT-DIVE-GATE-CELLS); probe-landing-cells cell E-DG-ontario renders it",
  camera: {
    lon: -77.8,
    lat: 43.6,
    height: 150,
    heading: 0,
    pitch: -0.6,
    roll: 0,
  },
  clock: null,
  dials: {
    globalWaterMask: true,
    lakeWaterMask: true,
    diveGateStep: {
      lon: -77.8,
      lat: 43.6,
      height: 150,
      heading: 0,
      pitch: -0.6,
      wheelNotches: 12,
      settleFramesBeforeFirst: 600,
      settleFramesPerNotch: 30,
      // Registered before the leg: the lake surface, about 41 m on the ellipsoid (75 m above sea level, geoid about -35 m), within 20 m.
      globeHeightWindow: { min: 21, max: 61 },
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
