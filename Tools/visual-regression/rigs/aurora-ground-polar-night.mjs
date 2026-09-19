// Campaign 15 aurora seed rig "aurora-ground-polar-night" (PROBE_KIT_PLAN_2026-09-17.md §5), for C15-04 to iterate against once the renderer lands.
//
// @purpose Campaign 15 aurora seed rig "aurora-ground-polar-night" (PROBE_KIT_PLAN_2026-09-17.md §5), for C15-04 to iterate against once the renderer lands.
// @status ACTIVE

export default Object.freeze({
  id: "aurora-ground-polar-night",
  tags: ["aurora"],
  page: null,
  renderers: ["webgl", "webgpu"],
  description:
    "Ground station inside the northern oval at local magnetic midnight, pinned to a winter-solstice instant so local night is unambiguous; camera near-horizontal to put the curtain against the sky rather than overhead; globe visible for occlusion; synthetic 'moderate' preset. Tests: curtain morphology, the 427.8 nm lower edge, terrain/globe occlusion.",
  camera: {
    lon: -147.7164,
    lat: 64.8378,
    height: 10,
    heading: 0,
    pitch: 0.3,
    roll: 0,
  },
  clock: "2026-12-21T10:00:00Z",
  dials: {
    preset: "moderate",
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
