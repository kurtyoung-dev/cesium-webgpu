# Glorfindel independent review — Q-141 pick during color-pipeline readiness

- Reviewer: Glorfindel
- Review role: fresh tier-3 independent, read-only source/spec reviewer
- Subject: Q-141 Phase A only
- Verdict: **GO FOR PHASE A ONLY**
- Browser/evidence disposition: **Phase B / Edge CLOSED**
- Base and current HEAD named by the frozen handoff:
  `1f9f245ce4334ef9cb90adf00fbf626516ca1b71`
- Owning handoff:
  [`elros--q141-pick-during-pipeline-readiness.md`](../elros--q141-pick-during-pipeline-readiness.md)

This is a source/spec review of a frozen local tuple. It is not a landing approval, browser
certification, served-build attestation, or evidence-publication receipt. The reviewer did not
author or repair the candidate.

## Frozen subject

The initial and terminal independent hashes matched the tuple in Elros's handoff exactly:

| Path | Bytes | Physical lines | SHA-256 |
| --- | ---: | ---: | --- |
| `packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts` | 390,502 | 9,284 | `A920129721D042FF0566B92AB32B86039261121EC291077F1E82215C70729EE7` |
| `packages/engine/Source/Renderer/WebGPU/WebGPUModelPipelineCache.ts` | 205,730 | 4,751 | `BB39B91EDE833FFE3EC81012C88024E949C5F4CC050B890F36C12D3D39DF0D98` |
| `Tools/visual-regression/webgpu-pick-emission-counters.spec.mjs` | 70,164 | 1,770 | `64606AF2180C753170CD288495F08D9AC590AB85FDF09C63BAC9C1868AB7D777` |
| `migration_doc/DEBUGGING_GUIDE.md` | 460,218 | 2,343 | `6EE1904F31D059B9652988A6A110BF7B33038933BBE353E0478FE5C8482950B5` |

No hash drift or collision was observed. The four paths remained frozen during the review.

## Audited fraction

- Path coverage: **4/4 frozen paths (100%)**.
- Current-content coverage: **4/4 complete current files, 18,148 physical lines** were bound to
  the review; every changed region and every source counterpart needed to establish its behavior
  was inspected.
- Diff coverage against the named base: **4/4 complete diffs (100%)**, comprising `+559/-63`
  lines: renderer `+190/-4`, pipeline cache `+8/-6`, spec `+358/-50`, and guide `+3/-3`.
- Requested semantic matrix: **12/12 requested source predicates inspected** — ordinary pick,
  snap, hover, precise pass 1, precise pass 2, metadata, no demand, `allowPicking === false`,
  classifier, edge-only surface suppression, resolved-path preservation, and synchronous-hatch
  preservation.
- Spec inventory: **20/20 test definitions read** and **4/4 named inertness mutants F4-F7
  inspected**.
- Pending pick-family behavioral coverage in this spec: **2/5 direct** (ordinary and metadata) and
  **3/5 source-parity only** (snap, hover, and precise). Resolved snap and precise pass 2 are
  directly asserted by F3c.
- Suppression coverage in this spec: **3/4 direct real-update cases** (no demand,
  `allowPicking === false`, classifier) and **1/4 source-only** (edge-only).

The review also read the actual pick dispatcher and precise-pass-2 consumer, the existing WebGL
model command path, and the color/pick pipeline-cache lifecycle around the changed branch. Those
dependencies were read-only context and were not added to the frozen candidate tuple.

## Re-derived behavior and field parity

The defect is present at the named base: `updateWebGPUModel` used to record a ready-gate skip and
immediately continue when the asynchronously created color pipeline was null. Pick construction
was below that gate even though the pick-family cache deliberately uses synchronous
`createRenderPipeline` must-render builders.

The new branch preserves the color skip and admits one direct pick carrier only when exact eligible
pick demand exists. Field-by-field comparison with the existing resolved-color pick construction
found the following parity:

| Concern | Pending-color branch | Existing resolved-color branch | Result |
| --- | --- | --- | --- |
| Ordinary pipeline | `getPickPipeline(alphaMode, doubleSided, materialDefines)` | Same | Match |
| Bind groups | camera, merged material, merged instance, effects | Same and same order | Match |
| Dynamic offsets | node camera offsets, then three undefined entries | Resolved color args carrying the same values | Match |
| Geometry | same vertex buffers, index buffer/count/format, vertex count | Same | Match |
| Draw identity | same instance count, primary pass, owner, bounding volume, model matrix and cull flag | Same | Match |
| Render state | backend-neutral/source model render state | Same pick render state | Match |
| Flags | `pickOnly: true` and non-color shadow flags | Same | Match |
| Indirect draw | no indirect field | no indirect field | Match |
| Snap | same cache method, material identity and shared args | Same | Match |
| Hover | same scene gate, cache method, material identity and shared args | Same | Match |
| Precise pass 1 | same cache method, shared args and stencil reference 1 | Same | Match |
| Precise pass 2 | requested and instantiated only for BLEND; stencil reference 1 | Same | Match |
| Metadata | same generator, property name, WGSL/class-hash publication, cache method, shared args and attachment helper | Same | Match |

The intentional carrier difference is correct. When color is resolved, the color command owns one
derived ordinary pick command and the other pick variants. When color is pending, the ordinary pick
command is itself the one top-level native `pickOnly` carrier, with no derived ordinary duplicate;
snap, hover, precise and metadata variants attach to that carrier. The real dispatcher therefore
falls through to the carrier for ordinary picks and selects the attached derivative for specialized
pick modes.

The metadata-only suppression is necessary rather than a semantic divergence. A resolved color
command with no metadata derivative is rejected by pick-pass variant selection. A direct pending
`pickOnly` carrier would otherwise qualify as a dedicated ordinary pick, so the pending branch must
withhold it when metadata was requested but no metadata derivative could be attached.

No command constructed by the new branch binds the null color pipeline. Ordinary, snap, hover,
precise-pass-1 and metadata cache methods return synchronous non-null pipelines. Precise pass 2 is
instantiated only when its BLEND-only pipeline exists. After appending the direct carrier and
recording the emission counter, the branch continues before OIT, velocity, capture, shadows,
silhouette, classification-depth or other color-only construction.

The resolved-color construction has no changed hunk. `WebGPUModelPipelineCache.ts` changes only
counter documentation: its synchronous must-render builders, cache maps, keys and
`device.createRenderPipeline` behavior are untouched.

## Suppression and counter semantics

The pending branch is unreachable for absent exact pick demand, an absent pick color,
`allowPicking === false`, classifiers, and edge-only surface suppression. The first three
conditions have direct real-`updateWebGPUModel` coverage in F3b except that pick-color absence is
subsumed by demand/allocation setup; edge-only is source-reviewed only. Classifier pipelines are
synchronous and therefore do not normally contribute a color ready-gate skip.

`readyGateSkipsThisFrame` now correctly counts a withheld color command, not a necessarily missing
pick command. `pickCommandsEmittedThisFrame` counts one ordinary pick carrier whether it is owned as
a resolved color derivative or pushed directly during color-pipeline readiness. The same frame can
therefore report nonzero values for both counters. Their frame-level aggregate nature does not
prove both events belong to the same primitive.

## Test and mutant assessment

The spec bundles and calls the real, complete `updateWebGPUModel`; it does not copy the renderer's
loop. F3a also invokes the real `selectCommandVariant` and proves that a pending metadata carrier
selects its metadata derivative instead of falling back to the ordinary carrier.

- F4 makes the real ready-gate counter call unreachable. The same real-update assertion that is
  green nominally must fail.
- F5 narrows its mutation to the resolved color branch's attachment-plus-counter block, leaving the
  new pending call untouched. Color and synchronous pick-pipeline construction remain live while
  the emission-count assertion fails.
- F6 makes only the new pending carrier append unreachable. The synchronous pipeline is still
  created, but the nominal requirement changes from one carrier to zero and fails.
- F7 makes the real metadata attachment helper inert. Metadata command construction remains, but
  real dispatcher selection cannot return it, so the nominal metadata-dispatch assertion fails.

These are behavioral inertness mutants and none alters or removes the synchronous must-render
hatch. Their literal source anchors are intentionally fail-loud but brittle under harmless
refactoring. F5's multiline indentation anchor and F6/F7's exact statement anchors can make a
future source-only refactor red even when behavior is retained.

Direct-versus-indirect coverage is explicit:

- Pending ordinary: direct in F1/F3 and F6.
- Pending metadata and dispatcher selection: direct in F3a and F7.
- Resolved snap and precise pass 1/pass 2: direct attachment assertions in F3c.
- Pending snap: source parity only; F3c is indirect confidence through the resolved twin.
- Pending precise, including BLEND-only pass 2: source parity only; F3c directly covers only the
  resolved twin.
- Pending hover: source parity only; this spec contains no pending or resolved hover assertion.

The missing direct pending snap/hover/precise cases are a follow-up coverage gap, not a source
correctness blocker for this bounded repair.

## WebGL/backend implication

The WebGL model path constructs its picking stage and pushes its model command without an equivalent
nullable asynchronous color-pipeline readiness gate. Q-141 removes a WebGPU-specific lifecycle
coupling; it does not introduce a renderer-agnostic feature or shader capability. No WebGL source
change is required, and leaving WebGL untouched is the parity-preserving outcome.

## Severity-ranked findings

### Medium, nonblocking — duplicated pick-family construction

The roughly 180-line pending branch is semantically correct at this tuple, but it duplicates the
resolved ordinary/snap/hover/precise/metadata family and can drift as those modes evolve. Extracting
during Q-141 would have changed the working resolved path while repairing the pending path, widening
the regression boundary. Deferral is safer for this repair, but it must remain a concrete
DX-07/DX-10 follow-up rather than silent debt.

Extract a typed `buildModelPickCommandFamily` helper accepting the shared draw descriptor,
primitive and pipeline caches, material identity, current pick-mode demand, and metadata inputs.
It should return ordinary, snap, hover, precise-pass-1, precise-pass-2 and metadata commands. Carrier
policy must be explicit:

- `DERIVED_FROM_COLOR`: attach ordinary and specialized variants to the color carrier.
- `DIRECT_PICK_CARRIER`: push ordinary directly and attach only specialized variants to it.

Return metadata eligibility explicitly so unsupported metadata cannot admit an ordinary direct
carrier. Acceptance should cover pending/resolved multiplied by OPAQUE/MASK/BLEND and
ordinary/snap/hover/precise/metadata; the four suppression controls; field-normalized descriptor
comparison; unchanged pipeline/cache-key census; ordinary-attachment, direct-append,
BLEND-pass-2, and metadata-attachment mutants; the model/pick suites; and the named Edge tranche.

### Low, nonblocking — direct pending-mode coverage gap and source-shape coupling

Pending snap, hover and precise were established by field-for-field source parity rather than direct
behavioral execution. The mutation anchors are also coupled to literal source shape. Both should be
resolved with the helper extraction and behavior matrix above.

### Low, safely deferrable — guide wording overstates attribution

`DEBUGGING_GUIDE.md:2250` says:

> A ready-gate skip with no pick emission still identifies an upstream emission failure or an
> intentional exclusion such as disabled picking or classification.

Classification is an inaccurate example because classifier pipelines are synchronous, and the
aggregate counters cannot attribute both observations to one primitive. The precise replacement is:

> Because these are aggregate counters, a frame with ready-gate skips and no pick emission can mean
> exact pick demand was absent or that all skipped primitives were intentionally excluded, for
> example by `allowPicking === false` or edge-only surface suppression; only an eligible skipped
> primitive under exact pick demand indicates an upstream emission failure.

This wording does not change code behavior, counter values, the source/spec proof, or the Phase-A
verdict. It is safely deferrable; changing it after freeze would require a new tuple and review.

## Reported validation and review limitation

Elros's handoff reports the focused expected-red zero-versus-one carrier result, focused green,
full Q-141 spec `20/20` before formatting, terminal test-readiness `49/49`, and green TypeScript,
ESLint, Prettier, C16 and whitespace-diff gates. The current spec contains exactly 20 test
definitions, and its nominal/mutant design is consistent with the reported behavior.

**None of those executable gates was rerun by Glorfindel.** The review dispatch prohibited tests,
builds, browsers, servers and evidence actions. Those results remain Elros's separately banked
Phase-A execution record, not independently reproduced reviewer evidence. Glorfindel independently
performed the complete static semantic review, exact tuple hashing and read-only whitespace diff
check only.

## Phase-B boundary and verdict

**GO FOR Q-141 PHASE A ONLY.** No blocking source/spec semantic defect was found in the exact tuple.

Phase B remains **CLOSED**. This review establishes no fresh build, served-source identity,
WebGPU/WebGL browser interleave, streaming pending-window witness, hit-search recovery,
`pickMetadata` observation, device-loss behavior, screenshot, probe artifact, immutable receipt or
full Q-141 certification. A Phase-B run with no nonzero pending window is STRUCTURAL, not a
steady-state PASS.

## No-action and quiescence declaration

Glorfindel performed no candidate edit, repair, Git action, test, build, browser, server, network or
install action, evidence publication, process termination, cleanup, deletion, branch change, or
external-state action during independent review. No background child, server, test runner or other
review-owned process remains live. The review consisted of read-only local inspection and hashing.

This file is the separately authorized durable materialization of the completed review. Creating it
does not reopen or modify the four frozen Q-141 paths, does not alter Elros's handoff, and does not
grant landing, push, Phase-B or external-action authority.
