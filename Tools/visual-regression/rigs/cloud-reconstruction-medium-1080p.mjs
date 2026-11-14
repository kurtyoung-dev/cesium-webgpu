/**
 * @purpose Opt-in E-RECON-medium rig: 1080p medium 48/4 ordinary HALF temporal reconstruction consumption with directional/deep-shadow lighting, baked noise, fixed weather seed, zero wind, and primary integral reuse disabled.
 * @status ACTIVE
 */
export default Object.freeze({
  id: "cloud-reconstruction-medium-1080p",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Solar-noon underside cloud view at 1920x1080 DPR1, MEDIUM 48/4 with baked noise, jitter, HALF and temporal history; reconstruction emission/consumption opt-in, directional/deep-shadow lighting on, primary integral reuse off. CPU readiness mirrors are required before capture.",
  camera: {
    lon: -95,
    lat: 39,
    height: 800,
    heading: 1.5707963267948966,
    pitch: 0.2792526803190927,
    roll: 0,
  },
  clock: "2026-06-21T18:20:00Z",
  reconstruction: true,
  dials: {
    cloudCoverage: 0.55,
    cloudDensity: 0.8,
    cloudQuality: 64,
    cloudVolumetricQuality: "medium",
    cloudWeatherMap: false,
    cloudWeatherSeed: 1,
    cloudWindSpeed: 0,
    skyBoxShow: false,
    skyAtmosphereShow: false,
    sunShow: false,
    backgroundColor: "rgb(0,0,0)",
    useDefaultRenderLoop: false,
  },
  experimental: {
    cloudReusePrimaryIntegral: false,
    cloudPrimaryDensityCache: false,
    cloudDeepShadowCache: true,
    cloudDirectionalLighting: true,
  },
  viewport: { width: 1920, height: 1080 },
  readiness: { kind: "settleFrames", frames: 90 },
});
