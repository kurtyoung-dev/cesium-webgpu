// temp-root-allowlist.mjs — the pinned census of tracked tools and specs that still
// build a path directly under the system temp root.
// @purpose Shrink-only allow-list for temp-root-census.spec.mjs: each tracked file under Tools/, scripts/, Specs/ or packages/*/Specs that still builds a path directly under os.tmpdir() (not through Tools/lib/lane-tmp.mjs), with its exact site count and a one-line reason.
// @status ACTIVE
//
// DATA, not policy. Moving a file's sandboxes to Tools/lib/lane-tmp.mjs lowers
// or deletes its row in the same change; the census spec fails on a file that
// is not here, on a row whose file is gone or builds nothing under the temp
// root any more, and on a row whose count is not the file's. Rows are sorted
// by path. A row "held" by a patch in flight waits for that patch to land.

/** Repo-relative path -> { sites, reason }. */
export const TEMP_ROOT_ALLOWLIST = Object.freeze({
  "Specs/karma.conf.cjs": {
    sites: 3,
    reason:
      "Edge launcher profiles (--user-data-dir=<temp>/karma-edge-*) and the stale-profile sweep beside them; scripts/karmaTestRun.js reads the same profiles back at the temp root, so they move together; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/build-infra/empty-module-stub.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/c16/spec-anchor-sweep.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/c16/string-literal-marker-scan.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/codex-preflight.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/collection-sentinels-check.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/dev-server-artifact.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/generate-tooling-catalog-launcher.cjs": {
    sites: 1,
    reason:
      "the materialized runtime (tooling-catalog-launcher-*) is removed in a finally; this launcher is a CommonJS, built-ins-only trust boundary that binds its own bytes to the candidate index, so it cannot load the ESM lane helper without a reviewed trust-boundary change; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/generate-tooling-catalog.mjs": {
    sites: 1,
    reason:
      "the private candidate index (tooling-catalog-index-*) is removed in a finally; the trusted launcher admits only Tools/lib/purpose-header.mjs into this module's graph (MODULE_GRAPH, pinned by generate-tooling-catalog.spec.mjs) and runs the index blob, so the lane helper joins it only through a reviewed trust-boundary change; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/generate-tooling-catalog.spec.mjs": {
    sites: 1,
    reason:
      "A1e names <temp>/catalog-missing-objects-* as a GIT_OBJECT_DIRECTORY that must not exist; nothing is created there",
  },
  "Tools/inject-purpose-headers.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/landing/rebase-shared-mutants.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made by hand inside the lane namespace (<temp>/cesium-lane/landing/mutants-*), not through Tools/lib/lane-tmp.mjs; to be taken from the lane helper with the landing tools' own change; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/lib/lane-tmp.spec.mjs": {
    sites: 2,
    reason:
      "C1 and C3 build <temp>/child and <temp>/not-a-lane-dir only to test the helper's containment guards; nothing is created there",
  },
  "Tools/lib/png-decode.spec.mjs": {
    sites: 3,
    reason:
      "3 mkdtemp sandboxes made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/pre-push-guard.spec.mjs": {
    sites: 2,
    reason:
      "1 mkdtemp sandbox made directly in the temp root (row DX-TEMP-ROOT-SANDBOXES); <temp>/landing-prefix is built only to test path containment and is never created",
  },
  "Tools/provision-worker-clone-codex-trust.spec.mjs": {
    sites: 3,
    reason:
      "1 mkdtemp sandbox made directly in the temp root (row DX-TEMP-ROOT-SANDBOXES); <temp>/irrelevant-config.toml is a config path the refusals under test never write",
  },
  "Tools/provision-worker-clone-junctions.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/report-batch-number-reuse.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/spec-runner-census.spec.mjs": {
    sites: 3,
    reason:
      "2 mkdtemp sandboxes made directly in the temp root (row DX-TEMP-ROOT-SANDBOXES); <temp>/spec-runner-census-synthetic-root is a census cwd that is never created",
  },
  "Tools/temp-hygiene.spec.mjs": {
    sites: 1,
    reason:
      "C0 builds <temp>/karma-1 only to show the protect set does not swallow an ordinary sweep target; nothing is created there",
  },
  "Tools/upstream-shape-guard.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/verify-doc-citations.spec.mjs": {
    sites: 3,
    reason:
      "3 mkdtemp sandboxes made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/verify-landing-compliance.mjs": {
    sites: 2,
    reason:
      "2 mkdtemp sandboxes made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/verify-landing-compliance.spec.mjs": {
    sites: 6,
    reason:
      "6 mkdtemp sandboxes made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/verify-readme-index.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/verify-tracked-references.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/verify-worker-handoff.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/build-source-identity.spec.mjs": {
    sites: 10,
    reason:
      "10 mkdtemp sandboxes made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/c11-13-voxel-inside-camera-probe.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/c11-146-route-evidence.spec.mjs": {
    sites: 5,
    reason:
      "4 mkdtemp sandboxes made directly in the temp root (row DX-TEMP-ROOT-SANDBOXES); <temp>/c11-146-alias/... is a manifest path alias the refusal under test never creates",
  },
  "Tools/visual-regression/c11-170-perf-regression-gate.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/c11-205-owner-attribution-policy.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/c11-209-effects-placeholder-provenance.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/c11-90-primitive-restart-harness.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/c12-29-s4-orbital-sunrise-gate.spec.mjs": {
    sites: 12,
    reason:
      "12 mkdtemp sandboxes made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/c12-29-s5-custom-ellipsoid-gate.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/c12-29-s5-dense-cost-gate.spec.mjs": {
    sites: 7,
    reason:
      "7 mkdtemp sandboxes made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/c12-29-s5-dense-cost-structural-refusal.spec.mjs": {
    sites: 6,
    reason:
      "6 mkdtemp sandboxes made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/c12-29-s5-multiview-gate.spec.mjs": {
    sites: 21,
    reason:
      "21 mkdtemp sandboxes made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/c12-29-s5-multiview-source-preflight.spec.mjs": {
    sites: 3,
    reason:
      "3 mkdtemp sandboxes made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/c12-29-s5-replacement-device-gate.spec.mjs": {
    sites: 16,
    reason:
      "16 mkdtemp sandboxes made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/c12-29-s5-replacement-device-preflight-refusal.spec.mjs":
    {
      sites: 9,
      reason:
        "9 mkdtemp sandboxes made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
    },
  "Tools/visual-regression/c12-29-s5-terrain-selection-gate.spec.mjs": {
    sites: 3,
    reason:
      "3 mkdtemp sandboxes made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/c12-31-aureole-gate.spec.mjs": {
    sites: 12,
    reason:
      "12 mkdtemp sandboxes made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/c13-42-godray-fixture.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/capture-and-diff.served-binding.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/capture-device-loss-refusal.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/celestial-g3-gate.spec.mjs": {
    sites: 2,
    reason:
      "2 mkdtemp sandboxes made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/cloud-demo-probe-routing.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/cloud-march-budget.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/cloud-orbital-ladder-contract.spec.mjs": {
    sites: 2,
    reason:
      "held: the b3 patch in flight touches this file, so it is migrated after that lands; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/cloud-realization-override.spec.mjs": {
    sites: 3,
    reason:
      "held: the b3 patch in flight touches this file, so it is migrated after that lands; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/cloud-tier-single-source.spec.mjs": {
    sites: 2,
    reason:
      "held: the b3 patch in flight touches this file, so it is migrated after that lands; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/eclipse-cloud-response-gate.spec.mjs": {
    sites: 3,
    reason:
      "3 mkdtemp sandboxes made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/elevation-contour-modulo-parity.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/elevation-material-height-derivation.spec.mjs": {
    sites: 2,
    reason:
      "1 mkdtemp sandbox made directly in the temp root and a loose transpiled module (elev-producer-*.mjs) written directly in the temp root, unlinked in a finally; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/fixtures/probe-water-cells-support.mjs": {
    sites: 1,
    reason:
      "held: the water-k patch in flight touches this file, so it is migrated after that lands; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/globe-night-darkness-fallback.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/globe-night-imagery-option.spec.mjs": {
    sites: 1,
    reason:
      "loose mutant modules (GlobeNightImagery.mutant-*.mjs) written directly in the temp root, removed in a finally; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/gpucull-blackframe-isolation-arm-expectations.spec.mjs":
    {
      sites: 1,
      reason:
        "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
    },
  "Tools/visual-regression/imagery-layer-callback-values.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/material-texture-late-adoption.spec.mjs": {
    sites: 2,
    reason:
      "1 mkdtemp sandbox made directly in the temp root and loose generated modules (<tag>-*.mjs) written directly in the temp root, unlinked in a finally; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/moon-globe-depth-routing.spec.mjs": {
    sites: 13,
    reason:
      "13 mkdtemp sandboxes made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/mutate-or-fail.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/nasa-svs-5073-umbra-fixture.spec.mjs": {
    sites: 1,
    reason:
      "reads an optional upstream source folder at <temp>/2024eclipse_shapefiles_inspect (or SVS_5073_SOURCE_DIR) and skips without it; it creates nothing there",
  },
  "Tools/visual-regression/pipeline-key-aliasing.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/probe-descriptor-cells-contract.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/probe-edge-authored-silhouette.mjs": {
    sites: 1,
    reason:
      "a probe that bundles the emitter to a loose probe-edge-authored-emitter-<pid>.mjs directly in the temp root and removes it after the run; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/probe-edge-degenerate.mjs": {
    sites: 1,
    reason:
      "a probe that bundles the emitter to a loose probe-edge-degenerate-emitter-<pid>.mjs directly in the temp root and removes it after the run; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/probe-edge-linestrings.mjs": {
    sites: 1,
    reason:
      "a probe that bundles the emitter to a loose probe-edge-linestrings-<pid>.mjs directly in the temp root and removes it after the run; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/probe-runtime.spec.mjs": {
    sites: 1,
    reason:
      "held: the water-kit patch in flight touches this file, so it is migrated after that lands; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/scene-debug-pragma-coverage.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/served-build-preflight.spec.mjs": {
    sites: 8,
    reason:
      "8 mkdtemp sandboxes made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/sky-shell-star-occlusion.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/skybox-diffuse-seam.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/star-point-census-live.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/visual-evidence-library.spec.mjs": {
    sites: 2,
    reason:
      "2 mkdtemp sandboxes made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/visual-regression/water-mask-assets.spec.mjs": {
    sites: 1,
    reason:
      "held: the water-ab patch in flight touches this file, so it is migrated after that lands (that patch moves this sandbox to Tools/lib/lane-tmp.mjs: delete this row when it lands); row DX-TEMP-ROOT-SANDBOXES",
  },
  "Tools/wave-end-contact-sheet-index.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "packages/engine/Specs/Renderer/ShaderGeneratorUpstreamContractSpec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "scripts/__tests__/bundleWorkersPragmas.spec.mjs": {
    sites: 1,
    reason:
      "1 mkdtemp sandbox made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "scripts/__tests__/karmaTestRun.spec.mjs": {
    sites: 6,
    reason:
      "karma-edge-* profile fixtures built directly in the temp root, because scripts/karmaTestRun.js looks for its profiles there; they move with Specs/karma.conf.cjs; row DX-TEMP-ROOT-SANDBOXES",
  },
  "scripts/__tests__/prepareCesiumOutputDirectory.spec.mjs": {
    sites: 2,
    reason:
      "2 mkdtemp sandboxes made directly in the temp root, not through Tools/lib/lane-tmp.mjs; row DX-TEMP-ROOT-SANDBOXES",
  },
});
