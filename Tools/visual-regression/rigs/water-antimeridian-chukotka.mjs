// Chukotka +/-180 antimeridian coastal SDF seam rig (179.85 E, 65.5 N, 12 km) for cross-dateline coastline water-mask continuity.
//
// @purpose Rig record for +/-180 antimeridian coastline SDF continuity: Chukotka Bering Strait coast (179.85, 65.5, 12000 m, heading 0, pitch -1.1) on the ellipsoid terrain with Natural Earth II imagery at 16:00Z on the June solstice, wave epoch pinned, globalWaterMask on, both renderers, 1280x720, 120 settled frames.
// @status ACTIVE
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-C-chukotka`, both
// renderers, the WebGPU capture diffed against the same run's WebGL capture.

export default Object.freeze({
  id: "water-antimeridian-chukotka",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Chukotka coastline straddling the +/-180 antimeridian (179.85, 65.5, 12000 m, heading 0, pitch -1.1) on the ellipsoid terrain with Natural Earth II imagery at 16:00Z on the June solstice, globalWaterMask on, testing dateline SDF wrap and polar sea-ice latitude transition.",
  // The Antigravity session that declared this rig cited a plan
  // (WATER_REMEDIATION_AND_WHOLE_EARTH_PLAN_2026-10-29) that is not in the tree.
  declaredBy:
    "Antigravity session 2026-10-29; probe-landing-cells cell E-C-chukotka renders it on both renderers",
  camera: {
    lon: 179.85,
    lat: 65.5,
    height: 12000,
    heading: 0,
    pitch: -1.1,
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
