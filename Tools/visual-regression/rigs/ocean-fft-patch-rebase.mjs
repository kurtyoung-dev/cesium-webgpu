// Open-Pacific near-surface FFT ocean patch rig (35 m ASL) for 6x6 km border feather and 12 km anchor rebase continuity.
//
// @purpose Rig record for open-ocean FFT patch continuity: central Pacific (-140.0, 20.0, 35 m, heading 0.785398, pitch -0.22) on the ellipsoid terrain with Natural Earth II imagery at 16:00Z on the June solstice, wave epoch pinned, globalWaterMask and enableEnhancedOcean on, WebGPU, 1280x720, 120 settled frames.
// @status ACTIVE

export default Object.freeze({
  id: "ocean-fft-patch-rebase",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Open Pacific near-surface FFT ocean pose (-140.0, 20.0, 35 m, heading 0.785398, pitch -0.22) on the ellipsoid terrain at 16:00Z on the June solstice, wave epoch pinned, testing 6x6 km patch border feathering, downwind wave phase velocity and 0-blink 12 km anchor rebase.",
  // The Antigravity session that declared this rig cited a plan
  // (WATER_REMEDIATION_AND_WHOLE_EARTH_PLAN_2026-10-29) that is not in the tree.
  declaredBy: "Antigravity session 2026-10-29; no probe consumes this rig yet",
  camera: {
    lon: -140.0,
    lat: 20.0,
    height: 35,
    heading: 0.785398,
    pitch: -0.22,
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
