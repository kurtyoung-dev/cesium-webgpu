// Weather rig "weather-preset-ovc-st" (probe-kit harvest, weather family).
//
// @purpose The Weather Inspector demo with its OVCst preset applied, as the preset sweep captures it.
// @status ACTIVE

export default Object.freeze({
  id: "weather-preset-ovc-st",
  tags: ["weather"],
  page: null,
  renderers: ["webgpu"],
  description:
    "Weather Inspector gallery demo, OVC stratus (8 oktas) preset applied through its own button and settled six seconds; the demo's own near-ground upward camera. No page is declared: the demo boots standalone only through the gallery stub its probe installs, which the capture seam does not do.",
  camera: null,
  clock: null,
  dials: {
    demo: "WebGPU Weather Inspector",
    preset: "OVCst",
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleMs",
    ms: 6000,
  },
});
