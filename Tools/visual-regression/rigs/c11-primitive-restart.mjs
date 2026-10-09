// Rig record for the C11-90 primitive-restart scene (probe-c11-90-primitive-restart-split.mjs).
//
// @purpose Rig record for the C11-90 primitive-restart scene: the harness page, its two topology states, the two restart models and the capture conditions the probe uses.
// @status ACTIVE
//
// `page: null` because each topology is loaded inside the harness page
// (`__c1190Harness.loadTopology(key)`), which `capture()` has no step for; the
// probe drives it. `harness` and `states` are documentary and match the
// probe's own `TOPOLOGY_EXPECTATIONS` keys (c11-rigs.spec.mjs pins that).

export default Object.freeze({
  id: "c11-primitive-restart",
  tags: ["c11"],
  page: null,
  harness: "Tools/visual-regression/c11-90-primitive-restart-harness.html",
  renderers: ["webgl", "webgpu"],
  description:
    "C11-90 primitive-restart scene: nine restart-separated white shapes on black from a restart-indexed model, once as triangle strips (nine tall bars in a row) and once as triangle fans (nine near-round discs in a three-by-three grid), on both backends.",
  states: Object.freeze(["triangle-strips", "triangle-fans"]),
  asset: Object.freeze([
    "Apps/SampleData/models/PrimitiveRestart/primitive-restart-triangle-strip.glb",
    "Apps/SampleData/models/PrimitiveRestart/primitive-restart-triangle-fan.glb",
  ]),
  camera: null,
  clock: null,
  viewport: {
    width: 1000,
    height: 760,
  },
  readiness: {
    kind: "settleMs",
    ms: 3000,
  },
});
