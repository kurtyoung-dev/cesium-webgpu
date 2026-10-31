// homeless-spec-allowlist.mjs — the pinned census of specs under Tools/ with no runner home.
// @purpose Pinned shrink-only census of Tools specs that have no package.json runner home, each with the one-line reason it is not homed (red at HEAD, fails to import on an unbuilt tree, or too slow); spec-runner-homes.spec.mjs fails on any other homeless spec and on a row whose spec is gone or homed.
// @status ACTIVE
//
// DATA, not policy. Census taken at a46ed8feeb (Batch 1607) by running every
// homeless Tools spec on an unbuilt worker clone: the green ones were homed in
// the same change (RUNNERS file appended by the seat at landing), and the rest
// are listed here. A red nobody can see was the recurring defect of 2026-10;
// this file makes each one visible by name. Shrink-only: homing a spec, or
// deleting it, must delete its row in the same change.

/** Spec path (repo-relative) -> one-line reason it has no runner home. */
export const HOMELESS_SPEC_ALLOWLIST = Object.freeze({
  "Tools/visual-regression/gsplat-frame-variance.spec.mjs":
    "needs ThirdParty wasm_splats_bg.wasm (gulp prepare); skip-when-absent owed",
  "Tools/visual-regression/c11-168-direct-model-ablation-policy.spec.mjs":
    "load-sensitive: green alone, but its hard-deadline test (a real Node helper must exit before its live grandchild) failed inside the test-visual-regression-node run on a loaded host; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/verify-clone-drained.spec.mjs":
    "red at HEAD (unbuilt tree): regression index-trust-flags-pre-fix turns A-P0-1 index trust flags fa; regression submodule-ignore-all-pre-fix turns A-P0-2 submodule ignore=; regression inherited-git-routing-pre-fix turns A-P0-3 inherited Git re; regression two-sided-divergence-pre-fix turns A-P1-1 two-sided diverge; +7 more; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/verify-tracked-references.spec.mjs":
    "red at HEAD (unbuilt tree): E3 the working tree agrees with an independently derived expectation; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/c11-146-route-evidence.spec.mjs":
    "red at HEAD (unbuilt tree): default provenance freezes the live route helpers and Viewer boot grap; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/c11-205-owner-attribution-policy.spec.mjs":
    "red at HEAD (unbuilt tree): runner source keeps the owner lane bounded, fail-closed, and noncertif; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/c12-11-star-catalog-gate.spec.mjs":
    "red at HEAD (unbuilt tree): 11 PNG validation binds signature, CRCs, RGBA layout, dimensions, and ; 17 UUID capture/report publication is write-once and latest is byte-id; 20 protected fixed-name PNG bytes remain byte-exact after publication ; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/celestial-g1-gate.spec.mjs":
    "red at HEAD (unbuilt tree): every capture is preceded by a discarded warm-up capture; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/eclipse-sandcastle.spec.mjs":
    "red at HEAD (unbuilt tree): historical presets retain exact UTC and observer coordinates; civil UTC values stay distinct from separately labelled time-scale ref; solar observers are path-verified while lunar events use visibility; the lunar list includes independently interesting real conjunctions; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/eclipse-scene-dimming.spec.mjs":
    "red at HEAD (unbuilt tree): WebGPU model direct lighting carries the factor too (site 5); row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/environment-refresh-drain.spec.mjs":
    "red at HEAD (unbuilt tree): the tileset environment tick stays outside every consumer gate; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/environment-refresh-priority.spec.mjs":
    "red at HEAD (unbuilt tree): Scene and backend source seams preserve exact collection ownership; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/globe-night-imagery-magnification-fade.spec.mjs":
    "red at HEAD (unbuilt tree): H6: INERTNESS — a retirement that can never fire is REJECTED; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/globe-ocean-wave-clock.spec.mjs":
    "red at HEAD: C4, E8; row NEW-GLOBE-OCEAN-WAVE-CLOCK-C4-E8",
  "Tools/visual-regression/globe-use-log-depth.spec.mjs":
    "red at HEAD (unbuilt tree): WRITERS — the globe has exactly two _logDepthEnabled writers and they ; MUTATION — restoring the raw master-switch read makes the WRITERS chec; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/gsplat-harness.spec.mjs":
    "red at HEAD (unbuilt tree): HEAD: the buffer commit sits ABOVE the pipeline gate; G6f mutant rejected: a depth clear is inserted between OPAQUE and GAUS; G4 mutant rejected: the cache records residency before the write succe; C15-G5: the SH commit cannot serve stale coefficients; +1 more; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/model-native-pipeline-stage-tax.spec.mjs":
    "fails to import on an unbuilt clone (packages/engine/Source/Shaders/Model/EdgeDetectionStageFS.js); home it once a built-tree run says green; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/model-primitive-topology-sandcastle.spec.mjs":
    "red at HEAD (unbuilt tree): the policy models Sandcastle's live WebGPU Viewer transform; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/moon-globe-depth-routing.spec.mjs":
    "fails to import on an unbuilt clone (packages/engine/Source/Scene/LightTypes.js); home it once a built-tree run says green; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/moon-normal-map-asset.spec.mjs":
    "red at HEAD (unbuilt tree): WGSL declares binding 3 and the normalStrength uniform at the tail; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/moon-normal-strength-policy.spec.mjs":
    "fails to import on an unbuilt clone (packages/engine/Source/Scene/LightTypes.js); home it once a built-tree run says green; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/moon-onscreen-oracle.spec.mjs":
    "fails to import on an unbuilt clone (node_modules/@cesium/engine/index.js); home it once a built-tree run says green; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/moon-webgl-mip-policy.spec.mjs":
    "fails to import on an unbuilt clone (packages/engine/Source/Scene/LightTypes.js); home it once a built-tree run says green; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/nasa-svs-5073-umbra-fixture.spec.mjs":
    "red at HEAD (unbuilt tree): fixture package is small, exact, and contains no source-archive spill; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/pointcloud-voxel-public-correctness.spec.mjs":
    "red at HEAD (unbuilt tree): WebGPU EDL composites at pass-local hooks and remains fail-open; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/prohibited-reader-allowlist.spec.mjs":
    "red at HEAD (unbuilt tree): CONTROL: sanctioned live-canvas toDataURL sources stay clean; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/q131-edge-pipeline-matches-pass.spec.mjs":
    "red at HEAD (unbuilt tree): C2: the scene-FB fallback branch binds the single-target variant; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/spec-cesium-viewer-dev-ui.spec.mjs":
    "red at HEAD (unbuilt tree): no tool depends on the gated chrome existing; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/sun-orbital-limb-extinction.spec.mjs":
    "red at HEAD (unbuilt tree): atmospheric alpha publishes before the backend branch and packs at off; atmospheric alpha pack fallback is identity for both absence forms; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/texture-mip-queue-safety.spec.mjs":
    "fails to import on an unbuilt clone (Build failed with 3 errors); home it once a built-tree run says green; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/voxel-inside-camera-policy.spec.mjs":
    "fails to import on an unbuilt clone (Build failed with 85 errors); home it once a built-tree run says green; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/webgpu-dynamic-environment-recovery.spec.mjs":
    "red at HEAD (unbuilt tree): dynamic environment caches are owned by one device generation; cache destruction releases capture depth and clears published handles; recovered scene capture wakes from a frame/content-stamped producer ed; hidden and opt-out transitions erase retained globe state without a re; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/webgpu-pick-center-identity.spec.mjs":
    "red at HEAD (unbuilt tree): voxel pass owns an impossible no-fragment clear and cold is invalid; per-identity slots never cross-serve and serve their own bytes within ; view and voxel-content motion fail closed while an unchanged view warm; resize, resource recovery, and atlas reuse reject delayed completion; +3 more; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/webgpu-snap-edge-payload.spec.mjs":
    "red at HEAD (unbuilt tree): D2: the payload phase visits both edge passes, last; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/webgpu-snap-framebuffer-lifecycle.spec.mjs":
    "fails to import on an unbuilt clone (packages/engine/Source/Shaders/WebGPU/PostProcess/FeatureIdResolve.js); home it once a built-tree run says green; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/webgpu-snap-payload.spec.mjs":
    "red at HEAD (unbuilt tree): G6: the occluder phase stores depth for the payload phase to load; row DX-HOMELESS-SPECS-RED-AT-HEAD",
  "Tools/visual-regression/webgpu-sun-bloom-mirror.spec.mjs":
    "red at HEAD (unbuilt tree): the glow is torn down and resized on every path the halo is; row DX-HOMELESS-SPECS-RED-AT-HEAD",
});
