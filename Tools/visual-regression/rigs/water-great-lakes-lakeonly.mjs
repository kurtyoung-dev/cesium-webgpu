// Rig record for the water landing's leg 2, cell 2f: the Great Lakes with the
// lake mask alone.
//
// @purpose Rig record for the water landing's leg 2 (EDGE_LEG_WATER.md), cell 2f: the Great Lakes from 900 km straight down (-84.5, 44.5, 900000 m, heading 0, pitch -1.5707963) on the ellipsoid terrain with the local Natural Earth II imagery at 16:00Z on the June solstice with the wave clock's epoch pinned to the same instant (waterSimulationEpoch), lakeWaterMask on and every other water dial at its default (globalWaterMask off, enhanced ocean off), both renderers, 1280x720, tiles settled then 120 frames; lakes alone over a terrain with no water mask must draw nothing.
// @status ACTIVE
//
// WHERE IT COMES FROM. The round-3 job sheet (`EDGE_LEG_WATER.md`, leg 2):
// "`water-great-lakes-lakeonly`, is `water-great-lakes` with the dials
// `lakeWaterMask: true` and `terrain: "ellipsoid"` only (no
// `globalWaterMask`). It is the visual half of review pass 2's B1." Cell 2f
// reads the mask effect between this rig and its OFF twin and requires it to
// stay within the OFF rig's own repeat noise: the lake mask takes effect only
// over a terrain that supplies a water mask, and the ellipsoid supplies none.
// A lake drawn here is B1 coming back.
//
// ITS OFF TWIN IS `water-great-lakes-off`. "Identical except the water dials
// absent" makes this rig's twin the same record as `water-great-lakes`'s twin,
// value for value, so the cell reuses it rather than keeping a duplicate.
//
// THE OTHER DIALS are `water-great-lakes`'s: the water dials the sheet does
// not name are listed at their defaults so the stage reads each one back, and
// `imagery: "naturalEarth"` because the probe opens the offline viewer. At
// `a999954e2b` the lake mask exists and applies too, so the BEFORE arm draws
// the same nothing.
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
// WHO RENDERS IT. `probe-water-cells.mjs --cells great-lakes-lakeonly`.

export default Object.freeze({
  id: "water-great-lakes-lakeonly",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "The Great Lakes from 900 km straight down (-84.5, 44.5, 900000 m, heading 0, pitch -1.5707963) on the ellipsoid terrain with Natural Earth II imagery at 16:00Z on the June solstice, lakeWaterMask alone on (globalWaterMask off, enhanced ocean off): lakes over a maskless terrain, which must draw nothing.",
  declaredBy: "EDGE_LEG_WATER.md leg 2 water-great-lakes-lakeonly (round 3)",
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
    lakeWaterMask: true,
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
