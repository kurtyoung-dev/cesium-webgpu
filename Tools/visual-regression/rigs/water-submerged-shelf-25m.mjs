// Submerged Kauai coastal shelf rig (-25 m below WGS84 ellipsoid) for underwater Beer-Lambert & Snell's window validation.
//
// @purpose Rig record for shallow coastal shelf submergence (-25 m): off the Kauai west (Na Pali) coast (-159.75, 22.12, -25 m, heading 0, pitch -0.08) on the ellipsoid terrain with Natural Earth II imagery at 16:00Z on the June solstice, wave epoch pinned, globalWaterMask and enableEnhancedOcean on, both renderers, 1280x720, 120 settled frames.
// @status ACTIVE

export default Object.freeze({
  id: "water-submerged-shelf-25m",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Submerged Kauai coastal shelf (-159.75, 22.12, -25 m, heading 0, pitch -0.08) on the ellipsoid terrain with Natural Earth II imagery at 16:00Z on the June solstice, globalWaterMask and enableEnhancedOcean on, testing shallow underwater volume optics, seafloor caustics and Snell's window.",
  // The Antigravity session that declared this rig cited a plan
  // (WATER_REMEDIATION_AND_WHOLE_EARTH_PLAN_2026-10-29) that is not in the tree.
  declaredBy: "Antigravity session 2026-10-29; no probe consumes this rig yet",
  camera: {
    lon: -159.75,
    lat: 22.12,
    height: -25,
    heading: 0,
    pitch: -0.08,
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
    enableEnhancedOcean: true,
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
