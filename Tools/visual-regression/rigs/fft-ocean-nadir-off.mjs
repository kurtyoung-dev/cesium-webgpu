// FFT ocean probe scene (FFT ocean OFF, globe shown).
//
// @purpose Rig record for the opt-in WebGPU FFT ocean probe (probe-fft-ocean.mjs): open Atlantic nadir view (-40, 35, 600 m, heading 0, pitch -90 deg) on the offline page with ellipsoid terrain and Natural Earth II imagery at 2026-07-03T13:00Z with the wave epoch pinned to it, FFT ocean OFF, globe shown, WebGPU, 1280x720, 200 settled frames.
// @status ACTIVE
//
// One of four rigs the FFT ocean probe stages through lib/landing-cell-stage.mjs:
// fft-ocean-nadir-off / -on (globe shown) and fft-ocean-nadir-isolated-off / -on
// (globeShow false, so a capture shows only what the FFT ocean draws). The
// probe's enabled-then-disabled session stages fft-ocean-nadir-on, then
// fft-ocean-nadir-off on the same page. The camera and clock are the scene the
// probe used before it moved onto the runtime (view=-40,35,600,0,-90,0 at
// 13:00Z); the page is now the offline CesiumViewer with local imagery, so
// nothing is streamed.

export default Object.freeze({
  id: "fft-ocean-nadir-off",
  tags: ["water"],
  page: "Apps/CesiumViewer/index.html?offline=true",
  renderers: ["webgpu"],
  description:
    "Opt-in FFT ocean probe scene: open Atlantic nadir view (-40, 35, 600 m, pitch -90 deg) on the offline page, ellipsoid terrain, Natural Earth II imagery, clock and wave epoch pinned to 2026-07-03T13:00Z, FFT ocean OFF, globe shown.",
  declaredBy: "probe-fft-ocean.mjs (lane A salvage of the water-w5 rework)",
  camera: {
    lon: -40,
    lat: 35,
    height: 600,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: "2026-07-03T13:00:00Z",
  dials: {
    pinClock: true,
    waterSimulationEpoch: "2026-07-03T13:00:00Z",
    terrain: "ellipsoid",
    imagery: "naturalEarth",
    waterOceanEnabled: false,
  },
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 200,
  },
});
