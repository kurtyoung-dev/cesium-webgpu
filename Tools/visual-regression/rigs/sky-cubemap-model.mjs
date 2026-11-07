// Rig record for the landing cell E-SKY-cube: a glTF model whose dynamic environment map the page fills.
//
// @purpose Rig record for the landing cell E-SKY-cube: CesiumMilkTruck at height 0 on the WGS84 ellipsoid in Oregon at 20:00 UTC on the June solstice, added by the skyCubeModel step so its own DynamicEnvironmentMapManager (enabled by default, no image-based lighting supplied) builds the WebGPU dynamic environment cube, the camera 12 m up and 19 m south of it looking north and down, sky box and sky atmosphere shown, 1280x720, WebGPU only, clouds off.
// @status ACTIVE
//
// WHAT CREATES THE CUBE. Only a Model or a Cesium3DTileset creates a
// `DynamicEnvironmentMapManager` (`Scene/Model/Model.js`,
// `Scene/Cesium3DTileset.js`). A glTF model with no spherical harmonics and no
// specular environment maps of its own gets `shouldUpdate` set on its manager
// each frame (`Model.js`), so the WebGPU manager
// (`Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts`) allocates its cube
// (`manager._webgpuCache.cubemapTexture`) and fills it with the "DynEnvMap Sky
// Fill" compute pass. The step adds the model after staging: the stage's own
// dials never create a model, and the model dial is a step dial.
//
// THE GROUND IS THE ELLIPSOID. The truck stands at height 0 on the ellipsoid
// terrain, unclamped, so the frame does not wait on terrain tiles (the
// framebuffer census's model rig does the same).
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-SKY-cube`, through
// `lib/sky-cubemap-steps.mjs`.

export default Object.freeze({
  id: "sky-cubemap-model",
  tags: ["skybox"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "CesiumMilkTruck at height 0 on the WGS84 ellipsoid at (-123.0744619, 44.0503706), added by the skyCubeModel step so its dynamic environment map is built, looked at from 12 m up and 19 m south at heading 0 and pitch -20 degrees, sky box and sky atmosphere shown, clouds off, 2026-06-21T20:00:00Z, 1280x720, 240 settle frames.",
  declaredBy:
    "framebuffer-census-model-shadows-ibl (the model and its position)",
  camera: {
    lon: -123.0744619,
    lat: 44.0502,
    height: 12,
    heading: 0,
    pitch: -0.3490658503988659,
    roll: 0,
  },
  clock: "2026-06-21T20:00:00Z",
  dials: {
    cloudsEnabled: false,
    skyBoxShow: true,
    skyAtmosphereShow: true,
    terrain: "ellipsoid",
    skyCubeModel: {
      url: "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb",
      lon: -123.0744619,
      lat: 44.0503706,
      height: 0,
    },
  },
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 240,
  },
});
