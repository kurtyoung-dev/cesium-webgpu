// Campaign 15 aurora seed rig "aurora-midlatitude-storm-kp8" (PROBE_KIT_PLAN_2026-09-17.md §5), for C15-04 to iterate against once the renderer lands.
//
// @purpose Campaign 15 aurora seed rig "aurora-midlatitude-storm-kp8" (PROBE_KIT_PLAN_2026-09-17.md §5), for C15-04 to iterate against once the renderer lands.
// @status ACTIVE

export default Object.freeze({
  id: "aurora-midlatitude-storm-kp8",
  tags: ["aurora"],
  page: null,
  renderers: ["webgl", "webgpu"],
  description:
    "The manual 'severe' preset driving the oval's activity-dependent equatorward expansion, viewed from a mid-latitude ground station that sees nothing at quiet. Tests: expansion, the 630.0 nm red upper profile, and both hemispheres (northern leg; see aurora-midlatitude-storm-kp8-south for the southern twin).",
  camera: {
    lon: -93.2,
    lat: 45,
    height: 10,
    heading: 0,
    pitch: 0.3,
    roll: 0,
  },
  clock: "2026-01-10T08:00:00Z",
  dials: {
    preset: "severe",
  },
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
