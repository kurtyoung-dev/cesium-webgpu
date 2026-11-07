// Rig record for the landing cell E-CLOUD-2d: the default cloud collection in 2D.
//
// @purpose Rig record for the landing cell E-CLOUD-2d: the whole-map 2D view of default-2d-pinned (SCENE2D by the landing stage's sceneMode dial, lon 0, lat 0, height 40,500,000 m, pinned instant 2026-06-21T18:00:00Z, 1280x720) with the volumetric cloud collection on and every cloud dial at its default, so the cloud renderer resolves its quality tier for an orthographic frame at the default quality.
// @status ACTIVE
//
// THE TIER IT READS. The cloud renderer resolves its tier in
// `Renderer/WebGPU/WebGPUCloudTierPresets.ts` (`resolveTier`): with
// `cloudVolumetricQuality` unset ("auto") and `cloudQuality` at its default
// 64, the camera height from `camera.positionCartographic.height` picks the
// tier: tier 1 (volumetric low) at or above the disable altitude (100,000 m),
// tier 2 between 50,000 m and that, tier 3 at or below the enable altitude. In
// 2D the camera's height is the orthographic frustum's reach, and this rig's
// 40,500,000 m is far above the disable altitude, so the tier is 1:
// half-resolution and temporal accumulation asked for, jitter on. The renderer
// clears the temporal bit for an orthographic frustum
// (`temporalReprojectionSupported`), so half-resolution is realized and
// temporal history is not: the case where the jitter bit is the question. The
// cell reads the quality flags back (`--readers cloud-stats`); the rig does
// not assert them.
//
// NO CLOUD DIAL. Only `cloudsEnabled` is set, so the collection is on with the
// engine's own coverage, density, layer heights and quality. The twin for the
// camera and the frame is default-2d-pinned.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-CLOUD-2d`.

export default Object.freeze({
  id: "cloud-2d-default",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "default-2d-pinned with the volumetric cloud collection on at its defaults: SCENE2D by the landing stage, camera at lon 0, lat 0, height 40,500,000 m so the whole map is in the frame, the pinned instant 2026-06-21T18:00:00Z, 1280x720, no cloud dial set, WebGPU only.",
  declaredBy: "default-2d-pinned (clouds on, default cloud quality)",
  camera: {
    lon: 0,
    lat: 0,
    height: 40500000,
    heading: 0,
    pitch: -Math.PI / 2,
    roll: 0,
  },
  clock: "2026-06-21T18:00:00Z",
  dials: { sceneMode: "SCENE2D", cloudsEnabled: true },
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 240,
  },
});
