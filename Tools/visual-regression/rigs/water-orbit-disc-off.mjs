// Rig record for the water landing's leg 2, cell orbit-disc, flags OFF.
//
// @purpose Rig record for the water landing's leg 2 (EDGE_LEG_WATER.md), cell orbit-disc, flags OFF: the full disc from 20,000 km over the Atlantic (-40, 15, 20000000 m, heading 0, pitch -1.5707963) on the ellipsoid terrain with the local Natural Earth II imagery at 16:00Z on the June solstice with the wave clock's epoch pinned to the same instant (waterSimulationEpoch), every water dial at its default (globalWaterMask, lakeWaterMask, riverWaterMask and enableEnhancedOcean false), both renderers, 1280x720, tiles settled then 240 frames; the twin water-orbit-disc is measured against.
// @status ACTIVE
//
// THE OFF TWIN OF `water-orbit-disc`. The same camera, clock, terrain, imagery,
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
// WHO RENDERS IT. `probe-water-cells.mjs --cells orbit-disc`.

export default Object.freeze({
  id: "water-orbit-disc-off",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "The full disc from 20,000 km over the Atlantic (-40, 15, 20000000 m, heading 0, pitch -1.5707963) on the ellipsoid terrain with Natural Earth II imagery at 16:00Z on the June solstice, every water dial at its default: the OFF twin of water-orbit-disc.",
  declaredBy: "EDGE_LEG_WATER.md leg 2 water-orbit-disc, its flags-OFF twin",
  camera: {
    lon: -40,
    lat: 15,
    height: 20000000,
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
    frames: 240,
  },
});
