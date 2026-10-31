// Rig record for the demo bookmark "Bahamas Photic Dive" with the camera really under the surface and the opt-in FFT ocean on.
//
// @purpose Rig record for the Bahamas photic-dive pose (-77.5, 24.5, -18 m, heading 20 deg, pitch -20 deg) on the ellipsoid terrain with Natural Earth II imagery at 2026-06-21T16:30:00Z, wave epoch pinned, globalWaterMask, enableEnhancedOcean and waterOceanEnabled (the opt-in FFT ocean) on, WebGPU only (the FFT ocean and the Tier-2 underwater optics have no WebGL consumer), 1280x720, 120 settled frames.
// @status ACTIVE
//
// CAMERA AND CLOCK. The position, heading, pitch and clock are
// `LOCATIONS.shallowUnderwater` in
// `packages/sandcastle/gallery/webgpu-global-water-weather/main.js`, with one
// deliberate difference: the demo puts the camera 18 m ABOVE the surface and
// simulates the dive with `globe.water.diveDepthMeters = 18` (`diveDepth: 18`),
// and no rig dial sets `diveDepthMeters`. This rig instead puts the camera 18 m
// BELOW the ellipsoid (height -18), which is under the 500 m underwater-optics
// threshold, so the real underwater path runs.
//
// WHAT THE DIALS MAKE THE SCENE SHOW. `waterOceanEnabled` sets
// `scene.globe.water.ocean.enabled` (`GlobeWaterOcean`), the opt-in WebGPU FFT
// ocean surface, so the scene views the FFT surface from below (the refraction
// leg), with the Tier-2 underwater optics of the enhanced ocean (the eye is
// inside the 500 m `UNDERWATER_OPTICS_ENTER_M` of
// `WebGPUGlobeSurfaceOceanTiers.ts`). Both are WebGPU-only: the FFT primitive
// renders nothing on WebGL and `GlobeFS.glsl` has no underwater path, so the
// rig lists only the WebGPU renderer. The demo itself turns the FFT ocean OFF;
// this rig turns it on.
//
// NEAR `water-submerged-shelf-25m`. That rig is also a real submerged camera
// (-25 m off Kauai, heading 0, pitch -0.08, near-horizontal, FFT ocean off, 16:00Z)
// aimed at the shallow-volume optics and Snell's window. This one differs in
// place (Bahamas), depth (-18 m), look (pitch -20 deg down toward the seabed),
// clock (16:30Z) and the FFT ocean being on.
// Natural Earth II imagery is local, so nothing streams ion.

export default Object.freeze({
  id: "water-bookmark-bahamas-photic-dive",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Bahamas photic-dive pose (-77.5, 24.5, camera 18 m below the ellipsoid, heading 20 deg, pitch -20 deg) on the ellipsoid terrain with Natural Earth II imagery at 2026-06-21T16:30:00Z, globalWaterMask, enableEnhancedOcean and the opt-in FFT ocean (waterOceanEnabled) on: the FFT surface and the Tier-2 underwater optics seen from below, WebGPU only.",
  declaredBy:
    "packages/sandcastle/gallery/webgpu-global-water-weather/main.js LOCATIONS.shallowUnderwater (camera moved from +18 m with simulated depth to -18 m)",
  camera: {
    lon: -77.5,
    lat: 24.5,
    height: -18,
    heading: 0.3490658503988659,
    pitch: -0.3490658503988659,
    roll: 0,
  },
  clock: "2026-06-21T16:30:00Z",
  dials: {
    pinClock: true,
    waterSimulationEpoch: "2026-06-21T16:30:00Z",
    terrain: "ellipsoid",
    imagery: "naturalEarth",
    globalWaterMask: true,
    lakeWaterMask: false,
    riverWaterMask: false,
    enableEnhancedOcean: true,
    waterOceanEnabled: true,
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
