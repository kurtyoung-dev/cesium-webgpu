// Campaign 15 aurora seed rig "aurora-orbit-limb" (PROBE_KIT_PLAN_2026-09-17.md §5), for C15-04 to iterate against once the renderer lands.
//
// @purpose Campaign 15 aurora seed rig "aurora-orbit-limb" (PROBE_KIT_PLAN_2026-09-17.md §5), for C15-04 to iterate against once the renderer lands.
// @status ACTIVE

export default Object.freeze({
  id: "aurora-orbit-limb",
  tags: ["aurora"],
  page: null,
  renderers: ["webgl", "webgpu"],
  description:
    "Camera above the limb looking across the terminator at ~2,000 km, the band where a sky-dome implementation fails and the layered volume does not. Tests: the 80-600 km shell geometry, RTE stability at globe scale, the three line layers seen edge-on.",
  camera: {
    lon: -100,
    lat: 65,
    height: 2000000,
    heading: 1.5707963267948966,
    pitch: -0.1,
    roll: 0,
  },
  clock: "2026-12-21T10:00:00Z",
  dials: {},
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 90,
  },
  expectedMismatch: [
    {
      gate: "crossBackend",
      expect: "UNMEASURED",
      trackedBy: "C15-04",
      rationale:
        "Campaign 15 aurora seed rig (PROBE_KIT_PLAN_2026-09-17.md §5) predating the C15-04 renderer; never compared in this metric, so UNMEASURED is the honest first value.",
    },
  ],
});
