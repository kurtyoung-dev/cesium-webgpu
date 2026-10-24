// Rig record for the water landing's leg 2, cell coast-50km, flags OFF.
//
// @purpose Rig record for the water landing's leg 2 (EDGE_LEG_WATER.md), cell coast-50km, flags OFF: San Francisco's coast from 50 km (-122.45, 37.75, 50000 m, heading 0, pitch -1.2) on the ellipsoid terrain with the local Natural Earth II imagery at 16:00Z on the June solstice with the wave clock's epoch pinned to the same instant (waterSimulationEpoch), every water dial at its default (globalWaterMask, lakeWaterMask, riverWaterMask and enableEnhancedOcean false), both renderers, 1280x720, tiles settled then 120 frames; the twin water-coast-50km is measured against.
// @status ACTIVE
//
// THE OFF TWIN OF `water-coast-50km`. The same camera, clock, terrain, imagery,
// viewport and readiness; every water dial at its default. Leg 2 reads the
// mask's effect as the pixels that move between this capture and the ON one
// on the same renderer, so the two records differ only in the water dials.
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
// WHO RENDERS IT. `probe-water-cells.mjs --cells coast-50km`.

export default Object.freeze({
  id: "water-coast-50km-off",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "San Francisco's coast from 50 km (-122.45, 37.75, 50000 m, heading 0, pitch -1.2) on the ellipsoid terrain with Natural Earth II imagery at 16:00Z on the June solstice, every water dial at its default: the OFF twin of water-coast-50km.",
  declaredBy: "EDGE_LEG_WATER.md leg 2 water-coast-50km, its flags-OFF twin",
  camera: {
    lon: -122.45,
    lat: 37.75,
    height: 50000,
    heading: 0,
    pitch: -1.2,
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
