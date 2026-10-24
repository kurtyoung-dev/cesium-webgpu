// Rig record for the R-14 sky-only cell: a sky with no clouds, whose sun moves
// by clock steps and nothing else.
//
// @purpose Rig record for the ruled R-14 sky-only cell (R-2026-10-22-14): the ground camera of the sahara-clear-sky fixture looking 20 degrees up at (12, 24), volumetric clouds explicitly off, sky box, sky atmosphere and sun shown, and the clock stepped twice by 30 minutes so the only change between steps is the sun's direction.
// @status ACTIVE
//
// WHY NOT `sahara-clear-sky`. The plan named it as the candidate, to be used
// if it has no clouds. It has clouds: its dials set `cloudCoverage: 0.05`,
// `cloudDensity: 0.3` and a 2,500-4,200 m deck (the near-clear negative-space
// control of the cloud tour), and the cloud stage turns the volumetric
// collection on. So this rig is declared instead, at the same camera and
// instant, with `cloudsEnabled: false` and no `cloud*` dial at all.
//
// THE SUN CHANGE IS A DIAL, SO IT IS IN THE REPLAY KEY. `clockSteps` are the
// instants `lib/clock-steps.mjs` moves the clock to after the first settle,
// rendering `settleFramesPerStep` frames at each; between steps nothing but the
// clock (and so the sun) moves. The cell's question (E6-2) is how many
// irradiance bakes a sun-only change costs; the frames are the byte-identity
// leg (base vs tip, clouds off).
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells R-14`.

export default Object.freeze({
  id: "sky-only-sun-change",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Sky-only R-14 cell: 600 m above (12, 24) in the central Sahara, heading north, pitched 20 degrees up, volumetric clouds off, sky box, sky atmosphere and sun shown; 11:12Z on the June solstice, then the clock stepped to 11:42Z and 12:12Z so only the sun moves.",
  declaredBy: "sahara-clear-sky (camera and instant; clouds removed)",
  camera: {
    lon: 12,
    lat: 24,
    height: 600,
    heading: 0,
    pitch: 0.3490658503988659,
    roll: 0,
  },
  clock: "2026-06-21T11:12:00Z",
  dials: {
    cloudsEnabled: false,
    skyBoxShow: true,
    skyAtmosphereShow: true,
    sunShow: true,
    clockSteps: ["2026-06-21T11:42:00Z", "2026-06-21T12:12:00Z"],
    settleFramesPerStep: 30,
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 60,
  },
});
