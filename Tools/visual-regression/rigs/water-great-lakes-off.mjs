// Rig record for the water landing's leg 2, cell great-lakes, flags OFF.
//
// @purpose Rig record for the water landing's leg 2 (EDGE_LEG_WATER.md), cell great-lakes and cell 2f, flags OFF: the Great Lakes from 900 km straight down (-84.5, 44.5, 900000 m, heading 0, pitch -1.5707963) on the ellipsoid terrain with the local Natural Earth II imagery at 16:00Z on the June solstice with the wave clock's epoch pinned to the same instant (waterSimulationEpoch), every water dial at its default (globalWaterMask, lakeWaterMask, riverWaterMask and enableEnhancedOcean false), both renderers, 1280x720, tiles settled then 120 frames; the twin water-great-lakes and water-great-lakes-lakeonly are measured against.
// @status ACTIVE
//
// THE OFF TWIN OF `water-great-lakes`. The same camera, clock, terrain, imagery,
// viewport and readiness; every water dial at its default. Leg 2 reads the
// mask's effect as the pixels that move between this capture and the ON one
// on the same renderer, so the two records differ only in the water dials.
//
// IT IS ALSO THE OFF TWIN OF `water-great-lakes-lakeonly` (cell 2f). That
// rig is this camera with `lakeWaterMask` alone; its "identical except the
// water dials absent" twin is this record, value for value, so a second copy
// under another id would only be a duplicate to keep in step.
//
// THE WAVE EPOCH (`waterSimulationEpoch`, W-A3, cell 2g). The sheet's common
// line pins the water's wave clock to the clock's own instant: the stage sets
// `scene.globe.water.ocean.simulationEpoch` from it before the first timed
// frame, so the wave phase is the pinned clock minus this instant on every run
// instead of minus the moment the page first rendered. The ON rig and its OFF
// twin carry the same value, so the pair still differs in the water flags
// alone. Where the stage has no handler for it (KT round 5 adds one) the probe
// records it `applied: false`, and cell 2g is then NOT RUN with that reason.
//
// WHO RENDERS IT. `probe-water-cells.mjs --cells great-lakes,great-lakes-lakeonly`.

export default Object.freeze({
  id: "water-great-lakes-off",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "The Great Lakes from 900 km straight down (-84.5, 44.5, 900000 m, heading 0, pitch -1.5707963) on the ellipsoid terrain with Natural Earth II imagery at 16:00Z on the June solstice, every water dial at its default: the OFF twin of water-great-lakes and of water-great-lakes-lakeonly.",
  declaredBy: "EDGE_LEG_WATER.md leg 2 water-great-lakes, its flags-OFF twin",
  camera: {
    lon: -84.5,
    lat: 44.5,
    height: 900000,
    heading: 0,
    pitch: -1.5707963,
    roll: 0,
  },
  clock: "2026-06-21T16:00:00Z",
  dials: {
    pinClock: true,
    waterSimulationEpoch: "2026-06-21T16:00:00Z",
    terrain: "ellipsoid",
    imagery: "naturalEarth",
    globalWaterMask: false,
    lakeWaterMask: false,
    riverWaterMask: false,
    enableEnhancedOcean: false,
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
