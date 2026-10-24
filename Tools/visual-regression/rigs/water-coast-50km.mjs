// Rig record for the water landing's leg 2, cell coast-50km, flags ON.
//
// @purpose Rig record for the water landing's leg 2 (EDGE_LEG_WATER.md), cell coast-50km, flags ON: San Francisco's coast from 50 km (-122.45, 37.75, 50000 m, heading 0, pitch -1.2) on the ellipsoid terrain with the local Natural Earth II imagery at 16:00Z on the June solstice with the wave clock's epoch pinned to the same instant (waterSimulationEpoch), globalWaterMask on and every other water dial at its default (enhanced ocean off), both renderers, 1280x720, tiles settled then 120 frames.
// @status ACTIVE
//
// WHERE IT COMES FROM. The water lane's job sheet (`EDGE_LEG_WATER.md`,
// leg 2, the per-rig table) names this rig: the camera, clock, water dials,
// terrain, viewport and readiness here are that row's, value for value. What
// it shows: the coast feather and the classic wave law along the bay and the open Pacific.
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
// READINESS. The sheet's "settleTiles, then 120 frames": the probe renders
// at the pinned clock until `globe.tilesLoaded` holds, then `readiness.frames`.
//
// WHY `water-coast-50km-enhanced-ocean` ALSO EXISTS. That rig is this camera,
// clock, terrain and viewport with the enhanced ocean and the HIGH water tier
// on and a tier switch and a resize ladder as steps: the E-T teardown and
// device-loss scene, which needs the water's GPU owners alive. This rig is
// leg 2's flags-ON parity scene, which needs the enhanced ocean OFF (a
// WebGPU-only shading law has no WebGL twin to agree with). One record cannot
// be both; the camera is the sheet's in both, value for value.
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
  id: "water-coast-50km",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "San Francisco's coast from 50 km (-122.45, 37.75, 50000 m, heading 0, pitch -1.2) on the ellipsoid terrain with Natural Earth II imagery at 16:00Z on the June solstice, globalWaterMask on, enhanced ocean off.",
  declaredBy: "EDGE_LEG_WATER.md leg 2 water-coast-50km",
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
    frames: 120,
  },
});
