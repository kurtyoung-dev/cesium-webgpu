// Rig record for the landing cell E-BGL-shadow: cloud-underside-noon-cov055 with cloud shadow casting on.
//
// @purpose Rig record for the landing cell E-BGL-shadow: cloud-underside-noon-cov055 (the baked-tier underside scene: coverage 0.55, density 0.8, black sky, solar noon) value for value, plus cloudCastShadows on, so the procedural cloud renderer builds its sun-view shadow resources (the "CloudShadow BGL" bind group layout, "CloudShadow UB", the shadow map, its sampler and its placeholder) and the layout census has a second cloud layout to count.
// @status ACTIVE
//
// THE TWIN IS cloud-underside-noon-cov055. DIFFERS FROM THE TWIN IN: the
// identity text and `cloudCastShadows` (true). The camera, clock, viewport,
// readiness and every other dial are the twin's.
//
// WHAT CASTING NEEDS. Only the dial. `ensureShadowResources` in
// `Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts` runs inside the
// `config.cloudCastShadows === true` branch of the cloud pass and reads no
// scene or globe shadow switch, so the rig sets no other dial. The opt-in
// three-cascade atlas (`cloudShadowCascades`) is not set: it adds a second
// allocation family ("CloudShadow Cascade Atlas", "CloudShadow Cascade UB")
// and a cell that wants it is a separate rig.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-BGL-shadow`, with the
// cloud layout census.

export default Object.freeze({
  id: "cloud-shadow-noon-cov055",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Cloud shadow casting on; the underside noon scene of cloud-underside-noon-cov055 (800 m above (-95, 39) under the deck, heading east and pitched 16 degrees up, solar noon on the June solstice, coverage 0.55, density 0.8, weather map off, sky box, sky atmosphere and sun hidden over a black background, 90 frames at the fixed clock).",
  declaredBy: "cloud-underside-noon-cov055 (cloudCastShadows on)",
  camera: {
    lon: -95,
    lat: 39,
    height: 800,
    heading: 1.5707963267948966,
    pitch: 0.2792526803190927,
    roll: 0,
  },
  clock: "2026-06-21T18:20:00Z",
  dials: {
    cloudCoverage: 0.55,
    cloudDensity: 0.8,
    cloudWeatherMap: false,
    cloudCastShadows: true,
    skyBoxShow: false,
    skyAtmosphereShow: false,
    sunShow: false,
    backgroundColor: "rgb(0,0,0)",
    useDefaultRenderLoop: false,
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 90,
  },
});
