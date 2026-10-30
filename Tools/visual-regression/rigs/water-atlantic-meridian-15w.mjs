// Eastern Atlantic Canary Islands [-20, -10) meridian band rig (-15.0 E, 28.0 N, 280 km) for bathymetry & geoid continuity.
//
// @purpose Rig record for the [-20, -10) deg W Atlantic meridian band: Canary Islands basin (-15.0, 28.0, 280000 m, heading 0, pitch -1.2) on the ellipsoid terrain with Natural Earth II imagery at 16:00Z on the June solstice, wave epoch pinned, globalWaterMask and enableEnhancedOcean on, WebGPU, 1280x720, 120 settled frames.
// @status ACTIVE

export default Object.freeze({
  id: "water-atlantic-meridian-15w",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Canary Islands basin across the [-20, -10) deg W Atlantic meridian band (-15.0, 28.0, 280000 m, heading 0, pitch -1.2) on the ellipsoid terrain with Natural Earth II imagery at 16:00Z on the June solstice, globalWaterMask and enableEnhancedOcean on, WebGPU.",
  // The Antigravity session that declared this rig cited a plan
  // (WATER_REMEDIATION_AND_WHOLE_EARTH_PLAN_2026-10-29) that is not in the tree.
  declaredBy: "Antigravity session 2026-10-29; no probe consumes this rig yet",
  camera: {
    lon: -15.0,
    lat: 28.0,
    height: 280000,
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
