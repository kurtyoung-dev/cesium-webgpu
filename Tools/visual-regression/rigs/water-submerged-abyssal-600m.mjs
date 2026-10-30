// Submerged Monterey Canyon abyssal rig (-600 m below WGS84 ellipsoid) for > -445 m Dead Sea unclamp validation.
//
// @purpose Rig record for deep-ocean abyssal submergence (-600 m): Monterey Canyon (-122.5, 36.7, -600 m, heading 0, pitch -0.15) on the ellipsoid terrain with Natural Earth II imagery at 16:00Z on the June solstice, wave epoch pinned, globalWaterMask and enableEnhancedOcean on, WebGPU, 1280x720, 120 settled frames.
// @status ACTIVE

export default Object.freeze({
  id: "water-submerged-abyssal-600m",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Submerged Monterey Canyon abyssal ocean (-122.5, 36.7, -600 m, heading 0, pitch -0.15) below the legacy -445 m Dead Sea clamp on the ellipsoid terrain at 16:00Z on the June solstice, globalWaterMask and enableEnhancedOcean on, WebGPU.",
  // The Antigravity session that declared this rig cited a plan
  // (WATER_REMEDIATION_AND_WHOLE_EARTH_PLAN_2026-10-29) that is not in the tree.
  declaredBy: "Antigravity session 2026-10-29; no probe consumes this rig yet",
  camera: {
    lon: -122.5,
    lat: 36.7,
    height: -600,
    heading: 0,
    pitch: -0.15,
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
