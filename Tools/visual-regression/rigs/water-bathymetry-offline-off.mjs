// Rig record for the offline Kauai shelf pair, cell 3a: enhanced ocean OFF (the ON twin is `water-bathymetry-offline`).
//
// @purpose Rig record for offline cell 3a, enhanced ocean OFF: Kauai North Shore (-159.505, 22.252, 3500 m, heading 185 deg, pitch -28 deg) on the ellipsoid terrain with local Natural Earth II imagery at 16:00Z on the June solstice, wave epoch pinned, globalWaterMask on and enableEnhancedOcean off, both renderers, 1280x720, 120 settled frames.
// @status ACTIVE
//
// WHAT THE PAIR MEASURES. This rig is `water-bathymetry-offline` with ONE dial
// flipped: `enableEnhancedOcean` is false here and true there; `globalWaterMask`
// stays true in both, so the classic water mask is drawn on this side. The
// pair measures the enhanced ocean ON versus OFF over the Kauai shelf with
// local imagery. "Bathymetry" in the id names the scene's subject (a coastal
// shelf), NOT an isolated dial: no bathymetry dial exists, and the ellipsoid
// terrain has no shelf relief. The ids are kept because the water cells name
// them. Camera, clock and every other dial equal the ON twin, value for value.
//
// WHAT SHOWS. Without `enableEnhancedOcean` the WebGPU globe draws tier 0 (the
// classic WebGL-parity water, `WebGPUGlobeSurfaceOceanTiers.ts`), which is also
// what WebGL draws, so the WebGL leg of the pair is expected to match its ON
// twin. Natural Earth II imagery is local, so nothing streams ion.

export default Object.freeze({
  id: "water-bathymetry-offline-off",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Kauai North Shore shelf (-159.505, 22.252, 3500 m, heading 185 deg, pitch -28 deg) on the ellipsoid terrain with local Natural Earth II imagery at 2026-06-21T16:00:00Z, globalWaterMask ON and enableEnhancedOcean OFF: the twin of water-bathymetry-offline with only enableEnhancedOcean flipped. No bathymetry dial is involved.",
  declaredBy:
    "water landing proposed optional cell 3a (enhanced ocean OFF); no probe scene table names it yet",
  camera: {
    lon: -159.505,
    lat: 22.252,
    height: 3500,
    heading: 3.2288591161895095,
    pitch: -0.4886921905584123,
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
