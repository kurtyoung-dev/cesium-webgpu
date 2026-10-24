// Rig record for the water landing's leg 2, cell orbit-disc, flags ON.
//
// @purpose Rig record for the water landing's leg 2 (EDGE_LEG_WATER.md), cell orbit-disc, flags ON: the full disc from 20,000 km over the Atlantic (-40, 15, 20000000 m, heading 0, pitch -1.5707963) on the ellipsoid terrain with the local Natural Earth II imagery at 16:00Z on the June solstice with the wave clock's epoch pinned to the same instant (waterSimulationEpoch), globalWaterMask on and every other water dial at its default (enhanced ocean off), both renderers, 1280x720, tiles settled then 240 frames.
// @status ACTIVE
//
// WHERE IT COMES FROM. The water lane's job sheet (`EDGE_LEG_WATER.md`,
// leg 2, the per-rig table) names this rig: the camera, clock, water dials,
// terrain, viewport and readiness here are that row's, value for value. What
// it shows: the ocean of the day-side disc, the Gulf of Guinea at 0 N 0 E included.
//
// TWO ADDITIONS TO THE SHEET'S ROW, both at the same value on the OFF twin.
// (1) The water dials the row does not name are listed at their defaults, so
// the stage reads every one back and the receipt shows the enhanced ocean was
// off: leg 2 claims the masks agree across backends under the classic ocean
// law, which the WebGPU-only enhanced ocean would void. (2) `imagery:
// "naturalEarth"`: the probe opens the offline viewer (no ion base layer, so
// no streamed tiles in a BEFORE-vs-AFTER pixel diff), whose globe is otherwise
// one flat base colour on which land and water cannot be told apart by eye.
//
// ON A TREE WITHOUT THE WATER BATCH (`a999954e2b`) `globalWaterMask` and
// `riverWaterMask` read back `applied: false` (the globe has no such property
// there). `lakeWaterMask` and `enableEnhancedOcean` exist there and apply, but
// lakes take effect only over a terrain that supplies a water mask, which the
// ellipsoid does not, so BEFORE's ON capture is its OFF capture: the parity
// floor of the plain globe at this camera.
//
// READINESS. The sheet's "settleTiles, then 240 frames": the probe renders
// at the pinned clock until `globe.tilesLoaded` holds, then `readiness.frames`.
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
  id: "water-orbit-disc",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "The full disc from 20,000 km over the Atlantic (-40, 15, 20000000 m, heading 0, pitch -1.5707963) on the ellipsoid terrain with Natural Earth II imagery at 16:00Z on the June solstice, globalWaterMask on, enhanced ocean off.",
  declaredBy: "EDGE_LEG_WATER.md leg 2 water-orbit-disc",
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
    globalWaterMask: true,
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
