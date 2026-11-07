// Rig record for the landing cell E-WX-populations: the E-G underside scene with the weather map on, looking high enough that every lit pixel is cloud, and the independent cloud populations dial on.
//
// @purpose Rig record for the landing cell E-WX-populations: the underside noon scene of cloud-underside-noon-cov055 (800 m above (-95, 39), heading east, solar noon on the June solstice, coverage 0.55, density 0.8, black background, sky box, sky atmosphere and sun hidden, 1024x768) with the weather map on, the camera pitched 30 degrees up so the frame's lowest row is above the horizon, and experimental.cloudIndependentWeatherLayers on, so the weather the collection owns publishes low, middle and high populations that the march renders as separate decks; the cell stages it twice, populations off (single-layer) and on (populations), and compares the two frames.
// @status ACTIVE
//
// THE TWIN IS cloud-underside-noon-cov055 (E-G). The dial acts on the weather
// the collection OWNS (cloudWeatherMap on, no weatherProvider), so the weather
// map is switched on here; the twin has it off. DIFFERS FROM THE TWIN IN:
// cloudWeatherMap (true), camera.pitch (30 degrees), readiness.frames (240, the
// weather has to be generated and packed before the capture), and the
// experimental block.
//
// WHY THE PITCH. The cell's measured rule counts every non-black pixel as cloud,
// so the frame must hold no ground. The viewport is 1024x768 (aspect 4/3) and the
// camera frustum's fov (60 degrees) is horizontal for an aspect above 1, so the
// vertical field of view is fovy = 2 * atan(tan(30 deg) / (1024 / 768)) =
// 46.83 degrees and the lowest frame row looks 23.41 degrees below the view
// axis. At pitch 30 degrees that row looks 6.59 degrees ABOVE the local
// horizontal; the true horizon at 800 m lies acos(R / (R + 800)) = 0.91 degrees
// BELOW it, so the lowest row clears the horizon by 7.49 degrees and the globe
// cannot reach the frame. The twin's own pitch of 16 degrees puts the lowest row
// 7.41 degrees below the horizontal, on the ground. The sky box, the sky
// atmosphere and the sun are hidden and the background is black, so what is lit
// is the deck.
//
// THE MEASURED RULE (the cell's pass rule, `lib/metrics/deck-coverage.mjs`):
// a pixel is covered when its Rec. 601 luma exceeds 8 (0..255). The cell is
// UNMEASURED when the single-layer page covers under 1 % of the frame; it FAILS
// when the populations page covers under 25 % of the single-layer page's
// covered pixels, or when its mean luma over its covered pixels is under 25 % of
// the single-layer page's; otherwise it PASSES.
//
// WEBGPU ONLY, as the twin: the dial is a WebGPU dial.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-WX-populations`: two pages
// per run, `single-layer` (experimental.cloudIndependentWeatherLayers false) and
// `populations` (true), the variants laid over this rig's experimental block.

export default Object.freeze({
  id: "cloud-wx-populations",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Independent cloud populations: 800 m above (-95, 39) under the deck, heading east and pitched 30 degrees up (the lowest frame row 6.6 degrees above the local horizontal), solar noon on the June solstice; sky box, sky atmosphere and sun hidden over a black background; weather map on, coverage 0.55, density 0.8; experimental.cloudIndependentWeatherLayers on; 1024x768, 240 frames at the fixed clock.",
  declaredBy: "cloud-underside-noon-cov055",
  camera: {
    lon: -95,
    lat: 39,
    height: 800,
    heading: 1.5707963267948966,
    pitch: 0.5235987755982988,
    roll: 0,
  },
  clock: "2026-06-21T18:20:00Z",
  dials: {
    cloudCoverage: 0.55,
    cloudDensity: 0.8,
    cloudWeatherMap: true,
    skyBoxShow: false,
    skyAtmosphereShow: false,
    sunShow: false,
    backgroundColor: "rgb(0,0,0)",
    useDefaultRenderLoop: false,
  },
  experimental: {
    cloudIndependentWeatherLayers: true,
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 240,
  },
});
