// Rig record for the landing program's cell E-DG-deathvalley: the camera controller's water dive gate at Badwater Basin, the lowest point of North America.
//
// @purpose Rig record for the landing cell E-DG-deathvalley (the dive-gate step on Badwater Basin, the lowest point of North America): the default CesiumViewer with the camera at (-116.7678, 36.2297) 100 m up, pitched down, the dive-gate step data, no water mask dial (the basin is not water), 1280x720, both renderers.
// @status ACTIVE
//
// WHY THIS PLACE. Dry land 86 m below sea level, about -118 m on the WGS84 ellipsoid (the geoid there being near -32 m), outside the 110 m band, so the dive is refused even with the collision disabled: the band is on ellipsoid heights, not sea level. The pre-registered gate of the dive page is "refuse" and the control page (collision on) is "refuse"; the surface height the receipt reads (`globeHeight`) is what the Edge leg checks against the figure above.
//
// THE STEP DATA is the `diveGateStep` dial (placement, wheel notches, settle frames); `diveCollisionDisabled` and `diveGateExpected` are laid over it by the cell's two pages (`dive`, `control`), and the values here are the `dive` page's. The cell runs online: the streamed Cesium World Terrain and its water mask are the point.
//
// THE CLOCK is pinned to the daylight instant 2026-06-21T18:00:00Z: a rig that leaves it `null` freezes the wall clock at load, and the terrain and ocean frames then render at night whenever the run starts.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-DG-deathvalley`, both renderers.

export default Object.freeze({
  id: "dive-gate-death-valley",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "CesiumViewer with the camera at (-116.7678, 36.2297), 100 m up, pitched down, over Badwater Basin, the lowest point of North America; the dive-gate step data, no water mask dial (the basin is not water); the clock pinned to the daylight instant 2026-06-21T18:00:00Z; 1280x720, both renderers.",
  declaredBy:
    "the probe-kit dive-gate cells (row DX-KIT-DIVE-GATE-CELLS); probe-landing-cells cell E-DG-deathvalley renders it",
  camera: {
    lon: -116.7678,
    lat: 36.2297,
    height: 100,
    heading: 0,
    pitch: -0.6,
    roll: 0,
  },
  clock: "2026-06-21T18:00:00Z",
  dials: {
    diveGateStep: {
      lon: -116.7678,
      lat: 36.2297,
      height: 100,
      heading: 0,
      pitch: -0.6,
      wheelNotches: 12,
      settleFramesBeforeFirst: 600,
      settleFramesPerNotch: 30,
      // Registered before the leg: Badwater, about -118 m on the ellipsoid, the window wholly below the gate's -110 m band edge.
      globeHeightWindow: { min: -135, max: -111 },
    },
    diveCollisionDisabled: true,
    diveGateExpected: "refuse",
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
