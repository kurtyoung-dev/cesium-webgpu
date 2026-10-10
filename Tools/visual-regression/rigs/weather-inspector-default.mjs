// Weather rig "weather-inspector-default" (probe-kit harvest, weather family).
//
// @purpose The Weather Inspector demo as it boots, as the inspector probe captures it.
// @status ACTIVE

export default Object.freeze({
  id: "weather-inspector-default",
  tags: ["weather"],
  page: null,
  renderers: ["webgpu"],
  description:
    "Weather Inspector gallery demo as it boots, before any control is touched. No page is declared: the demo boots standalone only through the gallery stub its probe installs, which the capture seam does not do.",
  camera: null,
  clock: null,
  dials: {
    demo: "WebGPU Weather Inspector",
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleMs",
    ms: 9000,
  },
});
