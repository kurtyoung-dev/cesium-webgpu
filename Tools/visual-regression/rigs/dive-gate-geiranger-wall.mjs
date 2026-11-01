// Rig record for the landing program's cell E-DG-geiranger: the camera controller's water dive gate at the Geirangerfjord water 400 m north-west of Geiranger village, between the fjord's walls.
//
// @purpose Rig record for the landing cell E-DG-geiranger (the dive-gate step on the Geirangerfjord water 400 m north-west of Geiranger village, between the fjord's walls): the default CesiumViewer with the camera at (7.199, 62.104) 150 m up, pitched down, the dive-gate step data, the global ocean mask and the lake mask on (Cesium World Terrain's water-mask extension carries the fjord), 1280x720, both renderers.
// @status ACTIVE
//
// WHY THIS PLACE. The fjord is salt water inside a steep-walled valley: the sea surface is the geoid (about 43 m on the WGS84 ellipsoid), inside the 110 m band, while the walls beside it are far outside it, so the gate must read the water under the camera and not the terrain around it. The pre-registered gate of the dive page is "allow" and the control page (collision on) is "refuse"; the surface height the receipt reads (`globeHeight`) is what the Edge leg checks against the figure above.
//
// THE STEP DATA is the `diveGateStep` dial (placement, wheel notches, settle frames); `diveCollisionDisabled` and `diveGateExpected` are laid over it by the cell's two pages (`dive`, `control`), and the values here are the `dive` page's. The cell runs online: the streamed Cesium World Terrain and its water mask are the point.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-DG-geiranger`, both renderers.

export default Object.freeze({
  id: "dive-gate-geiranger-wall",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "CesiumViewer with the camera at (7.199, 62.104), 150 m up, pitched down, over the Geirangerfjord water 400 m north-west of Geiranger village, between the fjord's walls; the dive-gate step data, the global ocean mask and the lake mask on (Cesium World Terrain's water-mask extension carries the fjord); 1280x720, both renderers.",
  declaredBy:
    "the probe-kit dive-gate cells (row DX-KIT-DIVE-GATE-CELLS); probe-landing-cells cell E-DG-geiranger renders it",
  camera: {
    lon: 7.199,
    lat: 62.104,
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
      lon: 7.199,
      lat: 62.104,
      height: 150,
      heading: 0,
      pitch: -0.6,
      wheelNotches: 12,
      settleFramesBeforeFirst: 600,
      settleFramesPerNotch: 30,
      // Registered before the leg: the fjord surface, about 43 m on the ellipsoid (the geoid there), within 20 m.
      globeHeightWindow: { min: 23, max: 63 },
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
