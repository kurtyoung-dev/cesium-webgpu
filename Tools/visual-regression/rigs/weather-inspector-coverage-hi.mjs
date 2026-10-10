// Weather rig "weather-inspector-coverage-hi" (probe-kit harvest, weather family).
//
// @purpose The Weather Inspector demo with coverage driven high, as the inspector probe captures it.
// @status ACTIVE

export default Object.freeze({
  id: "weather-inspector-coverage-hi",
  tags: ["weather"],
  page: null,
  renderers: ["webgpu"],
  description:
    "Weather Inspector gallery demo with its Coverage slider driven from 0.45 to 0.95. No page is declared: the demo boots standalone only through the gallery stub its probe installs, which the capture seam does not do.",
  camera: null,
  clock: null,
  dials: {
    demo: "WebGPU Weather Inspector",
    coverageSlider: 0.95,
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleMs",
    ms: 3500,
  },
});
