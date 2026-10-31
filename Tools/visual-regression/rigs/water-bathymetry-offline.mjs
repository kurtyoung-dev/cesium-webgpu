// Rig record for the offline Kauai shelf pair, cell 3a: enhanced ocean ON (the OFF twin is `water-bathymetry-offline-off`).
//
// @purpose Rig record for offline cell 3a, enhanced ocean ON: Kauai North Shore (-159.505, 22.252, 3500 m, heading 185 deg, pitch -28 deg) on the ellipsoid terrain with local Natural Earth II imagery at 16:00Z on the June solstice, wave epoch pinned, globalWaterMask and enableEnhancedOcean on, both renderers (the enhanced styling is WebGPU), 1280x720, 120 settled frames.
// @status ACTIVE
//
// WHAT THE PAIR MEASURES. The pair `water-bathymetry-offline` /
// `water-bathymetry-offline-off` differs in ONE dial: `enableEnhancedOcean`
// (true here, false in the twin); `globalWaterMask` stays true in both. So it
// measures the enhanced ocean ON versus OFF over the Kauai shelf with local
// imagery. "Bathymetry" in the id names the scene's subject (a coastal shelf),
// NOT an isolated dial: no bathymetry dial exists, and the ellipsoid terrain has
// no shelf relief. The ids are kept because the water cells name them.
//
// CAMERA. The Kauai bookmark's pose (`LOCATIONS.kauai` in
// `packages/sandcastle/gallery/webgpu-global-water-weather/main.js`: -159.505,
// 22.252, heading 185, pitch -28) from 3500 m instead of the demo's 2200 m, at
// 16:00Z instead of 22:00Z (see `water-bookmark-kauai-reef` for the demo values).
//
// WHAT SHOWS. The enhanced ocean's shader consumer is `GlobeTerrain.wgsl`;
// `GlobeFS.glsl` only mentions it in comments, so the ON/OFF difference is
// expected on WebGPU, and on WebGL the pair is expected to match. Natural Earth
// II imagery is local, so nothing streams ion.

export default Object.freeze({
  id: "water-bathymetry-offline",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Kauai North Shore shelf (-159.505, 22.252, 3500 m, heading 185 deg, pitch -28 deg) on the ellipsoid terrain with local Natural Earth II imagery at 2026-06-21T16:00:00Z, globalWaterMask and enableEnhancedOcean ON; the twin water-bathymetry-offline-off flips only enableEnhancedOcean. No bathymetry dial is involved.",
  declaredBy:
    "water landing proposed optional cell 3a (enhanced ocean ON); no probe scene table names it yet",
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
