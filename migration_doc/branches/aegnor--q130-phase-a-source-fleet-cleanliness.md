# Aegnor — Q130 Phase A WGSL source-fleet cleanliness

- Status: **FROZEN / PRIOR INDEPENDENT PHASE-A REVIEW GO / DURABLE RECORD REVIEW PENDING / NOT LANDED**
- Queue items: Q-130-b Phase A and residual Q-130-c2
- Scope: source, generated-source parity, and Node/static proof only
- Record writer: Aegnor; this does not attribute the implementation bytes to Aegnor
- Provenance: Aragorn/Elrond original Q130; Hamfast Q-130-b analyzer; prior Phase-A review by
  Voronwë with Beleg and Maeglin
- Durable-record reviewer: canonical task
  /root/aegnor_q130_landing_lead/finrod_q130_independent_review, called Finrod (Q130) below
- Original implementation/review freeze base: 1f9f245ce4334ef9cb90adf00fbf626516ca1b71
- Current main HEAD at materialization: 73f85cde466254b09d8628b7128af664b30a9db6
- Landing and every Git write: root only; push authority: none
- Build, browser, Edge, server, publication, and evidence authority: none

## Exact path boundary

This packet materializes completed and independently reviewed Q130 Phase A work. It does not reopen
the implementation. The frozen implementation tuple is exactly:

- Tools/visual-regression/lib/wgsl-derivative-uniformity.mjs
- Tools/visual-regression/q130-wgsl-derivative-uniformity.spec.mjs
- package.json
- packages/engine/Source/Shaders/WebGPU/chunks/functions/csm_effects.wgsl
- packages/engine/Source/Shaders/WebGPU/chunks/functions/csm_effects.js
- packages/engine/Source/Shaders/WebGPU/chunks/functions/csm_clipByPolygons.wgsl
- packages/engine/Source/Shaders/WebGPU/chunks/functions/csm_clipByPolygons.js
- packages/engine/Source/Shaders/WebGPU/Voxels/VoxelRayMarch.wgsl
- packages/engine/Source/Shaders/WebGPU/Voxels/VoxelRayMarch.js

The three JavaScript shader wrappers are ignored generated mirrors and are review artifacts, not
silently stageable landing paths. Aegnor owns only this handoff and the approved top addendum in
migration_doc/FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md. The reviewer alone owns
migration_doc/branches/reviews/finrod--q130-phase-a-source-fleet-cleanliness-review.md after freeze.

Every other path is excluded, including the Q-130-c2 boundary, scripts/createWgslStandaloneShaders.js,
other queues and rulings, Q141, Q152, Rust, skybox, EDL, ocean, migration, tool, and asset work.
Concurrent shared-tree changes are foreign and preserved. No worker performed a Git write, build,
browser, Edge, server, publication, install, network, cleanup, or external-state action.

## Phase-A result and bounded claim

Phase A extracts and hardens the WGSL derivative-uniformity analyzer, gives its spec a real npm
runner home, converts five physical sites from implicit-derivative sampling to explicit-level
sampling, and synchronizes the generated wrappers. The sites are two polygon SDF samples, the hard
and PCF shadow comparisons, and the voxel-density sample.

The prior independent review concluded that all five explicit-level operations are semantically
valid for their single-mip textures. The fleet scan covered 324 WGSL files, including 171 files with
fragment entry points, and reported zero findings after repair. No site was allowlisted, de-scored,
or hidden.

This is **source-fleet cleanliness for dormant or latent assets**, not a runtime repair. Existing
shadow-contract text identifies csm_effects as unreached, csm_clipByPolygons and VoxelRayMarch have
no production consumer, and the live voxel renderer already samples explicitly. No build,
compiler-driver, served-source, runtime, pixel, browser, GPU, device-loss, performance, or
certification claim belongs to this phase.

## Complete retained run ledger

| Check | Retained outcome |
| --- | --- |
| Focused Q130 spec before shipped files matched the preregistered baseline | exit 1; 35/37 passed; only B1 fleet baseline and H2 shipped-explicit-level baseline failed |
| Physical-site mutants H3-H7 in that expected-red image | all five passed; every one-at-a-time implicit-sample mutant was detected |
| Final focused Q130 spec | exit 0; 37/37 passed |
| npm run test-build-infra | exit 0; 102/102 passed, including the Q130 runner home |
| Tools/visual-regression/webgpu-shadow-receive-contract.spec.mjs | exit 0; 20/20 passed |
| Syntax, exact-path ESLint, exact-path Prettier, C16, and census | green as recorded by the Phase-A lane |
| Build, browser, Edge, server, capture, publication, immutable evidence | not run; outside authority and claim |

The expected red is retained without reclassification. B1 established that the fleet was not yet
clean; H2 established that shipped bytes did not yet match the preregistered baseline; H3-H7 showed
the intended five repairs were load-bearing before those files changed. This materialization was
given results and final tuple identities, not the original raw command transcripts. It records that
provenance limitation and does not promote the results to a new certification.

## Frozen nine-path tuple

The implementation tuple froze at base 1f9f245ce4334ef9cb90adf00fbf626516ca1b71 and was rehashed
without drift at current HEAD 73f85cde466254b09d8628b7128af664b30a9db6:

| Path | Bytes | SHA-256 |
| --- | ---: | --- |
| Tools/visual-regression/lib/wgsl-derivative-uniformity.mjs | 20,923 | AB0F59DE13092DBB003FC54A710479BD5AB2B8E00B764929F340E66FEA66BD56 |
| Tools/visual-regression/q130-wgsl-derivative-uniformity.spec.mjs | 27,114 | FEE0926EED0E2E6430EBAFA8D95EB43B78E86FA6622AC04420F1BC8389740F5C |
| package.json | 10,694 | 2A6F6460C7E9F96A03ED1BE4B6D3920033956AC9A3F378398A1ADD7AD30D9D0D |
| packages/engine/Source/Shaders/WebGPU/chunks/functions/csm_effects.wgsl | 4,947 | 519C4E5A99FD44427B200392C9862B1F322F45184E3EA0AC1A2A7E45A6CD9E25 |
| packages/engine/Source/Shaders/WebGPU/chunks/functions/csm_effects.js | 5,351 | E58206B6CBF2975E826189386AE7EAE550C4B07E2684DCE7A48E792791263AEA |
| packages/engine/Source/Shaders/WebGPU/chunks/functions/csm_clipByPolygons.wgsl | 2,978 | 7325667BD292F04EC494C0E0CFE80D52F0AD98B84B0AA17419422C7047ECC18C |
| packages/engine/Source/Shaders/WebGPU/chunks/functions/csm_clipByPolygons.js | 3,291 | 8A2FE21F6D08EE0F18A912165026526217BA9239A7DBBA5270E40F7B4D69F5A1 |
| packages/engine/Source/Shaders/WebGPU/Voxels/VoxelRayMarch.wgsl | 1,800 | 6AC941C3F66F43A5EFC1A673366463D2AB618CFFAA6245D981CCDF5BFC4D8A33 |
| packages/engine/Source/Shaders/WebGPU/Voxels/VoxelRayMarch.js | 2,050 | 6A2C3047B5A254A2B9409979A992DB3008E206EED4AB0F05D43855663D4ADA2C |

Voronwë, Beleg, and Maeglin's prior review returned **GO for this exact Phase-A scope only**. They
reproduced expected red 35/37 and current 37/37, confirmed the 324/171 census and no allowlist or
de-scoring, judged the five explicit-level sites correct, and established the dormant/latent
boundary. Finrod (Q130) audits this durable record and exact bytes; it does not impersonate or
replace that earlier review team.

## Q-130-c2 remains OPEN / HIGH

Phase A does not close, downgrade, or rewrite historical Q-130-c. The residual receives the
add-only ID **Q-130-c2** and remains **OPEN / HIGH / Opus-judgment**:

1. WebGPUGlobeMaterial.ts still prepends diagnostic(off, derivative_uniformity) at module scope.
   Its documented rationale remains, but its breadth can conceal a future genuine violation.
2. WGSLBuiltins.ts remains the authoritative inline built-in library, while implicit helper
   reachability through that assembled boundary is unresolved by this fleet pass.

The locked out-of-scope boundary is WebGPUGlobeMaterial.ts, GlobeTerrain.wgsl and its ignored
GlobeTerrain.js mirror, WGSLBuiltins.ts, WebGPUGlobeSurfaceRenderer.ts, and
webgpu-shadow-receive-contract.spec.mjs. Phase A does not modify or disposition any of them.
Q-130-c2 needs a separately preregistered Opus-judgment pass. It must not silence the analyzer or
de-score a red.

## Carried-forward findings

- scripts/createWgslStandaloneShaders.js still embeds the old implicit voxel textureSample literal.
  Running that stale one-shot generator can overwrite VoxelRayMarch's reviewed repair.
- B1 formats every finding as after a conditional return and prints finding.afterReturnOnLine.
  Break, continue, and non-uniform-if findings may lack that field, so a future red can say
  undefined and misdescribe its control-flow shape. The analyzer is a textual guard, not a
  compiler-equivalence or runtime-reachability proof.

Neither finding changes the exact Phase-A GO. Both remain visible so later work cannot infer that
source-generation durability or every diagnostic path was discharged.

## Documentation validation and review boundary

Acceptance requires: unchanged nine-path hashes; author diff limited to this handoff and the queue
top addendum; node Tools/verify-no-doc-shred.mjs exit 0; literal Q-130-c2 OPEN / HIGH with no
closure, landing, certification, or runtime claim; both carry-forwards present; and an independent
terminal rehash and GO/NO-GO over the frozen author records, implementation tuple, and locked
six-path boundary.

No substantive Prettier claim is made for migration_doc: Q-12 records the current ignore topology
as vacuous while its repair remains on an unmerged branch. No build, browser, Edge, evidence,
catalog, or engine C16 result is inferred from this docs-only materialization.

After the author records freeze, Aegnor performs no further edit until the review report exists and
the reviewer has no live child. Any drift invalidates the subject. Root alone may stage and locally
commit the exact reviewed assembly; this grants no push authority.

## Negative-action and naming declaration

Aegnor and the oracle performed no implementation edit, Git write, build, browser, Edge, server,
install, network, evidence publication, cleanup, deletion, branch change, or external-state action.
The oracle is quiescent.

The bare names Erestor and Finrod were found in the historical-used registry only after dispatch.
No replacements were spawned because exactly two tier-3 workers were required. This record uses
the canonical task and Finrod (Q130) qualifier, not another historical Finrod identity.
