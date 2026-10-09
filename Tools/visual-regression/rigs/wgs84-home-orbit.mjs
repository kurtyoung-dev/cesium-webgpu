// Rig record for the wgs84 family's home view: the CesiumViewer page's own
// default camera over the WGS84 ellipsoid terrain.
//
// @purpose Rig record for the WGS84-ellipsoid default home view on the CesiumViewer page - both renderers, 1280x720, a 1,200-frame dwell, the clock pinned so North America is daylit.
// @status ACTIVE
//
// WHO RENDERS IT. `probe-wgs84.mjs --scene home`. It is the view of that
// probe's orbit scene and of the archived `probe-wgs84-quick.mjs` and the six
// archived debug-flag probes (alphadbg, atmo, layer1-alpha, postcomposite,
// sample0, varyings): none of them moved the camera, so every banked wgs84
// orbit frame shows the page's opening view.
//
// THE CAMERA IS THE PAGE'S OWN. `camera: null` means the probe leaves it where
// the CesiumViewer page put it, exactly as the archived probes did. It is not
// the wave-end rig `wgs84-orbit`, which looks straight down on 100 W, 40 N from
// 20,000 km on the split-screen page.
//
// THE TERRAIN IS A DIAL, SO IT IS IN THE REPLAY KEY. `baseLayerPickerTerrain`
// is matched case-insensitively as a substring of the base-layer picker's
// terrain view-model names: the same "wgs84" lookup every probe in the family
// and `scenes/wgs84-setup.js` perform.
//
// THE CLOCK IS PINNED, NOT INHERITED. The archived probes rendered at wall-clock
// time, so their banked frames carry three different dates and three skies.
// The migrated probe pins `clock` through `lib/determinism-kit.mjs`. 18:00 UTC
// on the June solstice puts the sub-solar point near 90 W, so the North
// American views are daylit whether or not the page lights the globe.
//
// THE DWELL IS THE ARCHIVED PROBES'. 1,200 frames is what every orbit capture
// in the family rendered before its screenshot; the migrated probe uses it as
// the floor of a tiles-loaded-stable settle rather than as a fixed count.

export default Object.freeze({
  id: "wgs84-home-orbit",
  tags: ["wgs84"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "WGS84 ellipsoid terrain picked from the base-layer picker, seen from the CesiumViewer page's own home view over North America, 1280x720, clock pinned to the June solstice at 18:00 UTC.",
  camera: null,
  clock: "2026-06-21T18:00:00Z",
  dials: {
    baseLayerPickerTerrain: "wgs84",
  },
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 1200,
  },
});
