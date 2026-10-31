// SSR water probe scene, cell B (SSR on, deferredLighting off).
//
// @purpose Rig record for the SSR water probe (probe-ssr-water.mjs) cell B: a dark lit "lake" polygon at 240 m with a bright extruded "wall" (240-400 m) north of it near Pittsburgh (-79.9959, 40.4406), camera 400 m up, 0.005 deg south, heading 0, pitch -15 deg, offline page with ellipsoid terrain and Natural Earth II imagery, globe lighting on, SSR on, deferredLighting off, ssrReflectionStrength 1, clock pinned to 2026-05-19T18:00Z, WebGPU, 1280x720, at least 400 settled frames.
// @status ACTIVE
//
// One of four rigs (ssr-water-lake-wall-{ssr-off,ssr-on}-{deferred-off,deferred-on})
// that differ only in enableSSR and deferredLighting, the probe's 2x2 matrix. The
// polygons are data (top-level `polygons`, built by lib/polygon-primitive-scene.mjs
// with the TEXTURED vertex format so the lit material writes the G-buffer normal
// SSR reads); the scene dials are staged by lib/landing-cell-stage.mjs. The scene
// is the one the probe built before it moved onto the runtime, except that the
// page is now the offline CesiumViewer on the ellipsoid with local imagery, so
// the polygons stand on a flat globe instead of streamed world terrain.

export default Object.freeze({
  id: "ssr-water-lake-wall-ssr-on-deferred-off",
  tags: ["ssr"],
  page: "Apps/CesiumViewer/index.html?offline=true",
  renderers: ["webgpu"],
  description:
    "SSR water probe cell B: lit lake polygon (240 m) and bright extruded wall (240-400 m) near Pittsburgh, low oblique camera (400 m, pitch -15 deg) on the offline ellipsoid page with Natural Earth II imagery, globe lighting on, SSR on, deferredLighting off, ssrReflectionStrength 1, clock pinned to 2026-05-19T18:00Z.",
  declaredBy: "probe-ssr-water.mjs (lane A salvage of the water-w5 rework)",
  camera: {
    lon: -79.9959,
    lat: 40.4356,
    height: 400,
    heading: 0,
    pitch: -0.2617993877991494,
    roll: 0,
  },
  clock: "2026-05-19T18:00:00Z",
  dials: {
    pinClock: true,
    terrain: "ellipsoid",
    imagery: "naturalEarth",
    globeEnableLighting: true,
    enableSSR: true,
    deferredLighting: false,
    ssrReflectionStrength: 1,
  },
  polygons: [
    {
      id: "lake",
      degrees: [
        -79.9989, 40.4391, -79.9929, 40.4391, -79.9929, 40.4421, -79.9989,
        40.4421,
      ],
      height: 240,
      color: [0.05, 0.1, 0.2, 1],
    },
    {
      id: "wall",
      degrees: [
        -79.9969, 40.4426, -79.9949, 40.4426, -79.9949, 40.4431, -79.9969,
        40.4431,
      ],
      height: 240,
      extrudedHeight: 400,
      color: [1, 0.7, 0.1, 1],
    },
  ],
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 400,
  },
});
