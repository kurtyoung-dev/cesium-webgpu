# Elros — Q-141 pick emission during color-pipeline readiness

- Status: **FROZEN / INDEPENDENT REVIEWER GO / READY FOR ROOT LOCAL LANDING / NOT LANDED**
- Queue item: Q-141, metadata picking under streaming / decouple pick emission from color-pipeline readiness
- Phase: A, source and Node/static proof only
- Tier-2 lead and handoff writer: Elros
- Test writer: Idril
- Engine writer: Nori
- Independent reviewer: Glorfindel
- Shared-main base and current HEAD at freeze: `1f9f245ce4334ef9cb90adf00fbf626516ca1b71`
- Branch/clone: shared main workspace `F:/Dev/GH/cesium-webgpu`; no worker branch or clone was created
- Landing and every Git write: root only
- Push authority: none
- Edge gate: **CLOSED**

## Dispatch and exact path boundary

Root released Q-141 Phase A for concurrent non-browser implementation after DM-07 landed. The
dispatch required test-first behavior proof and a single pending-pick carrier while preserving the
resolved-color path, existing suppression policies, synchronous must-render pick-pipeline hatches,
and snap, hover, precise, and metadata variants.

Exclusive writer leases were:

- Nori:
  - `packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts`
  - comment-only semantic updates in
    `packages/engine/Source/Renderer/WebGPU/WebGPUModelPipelineCache.ts`
- Idril:
  - `Tools/visual-regression/webgpu-pick-emission-counters.spec.mjs`
- Elros:
  - `migration_doc/DEBUGGING_GUIDE.md`
  - this handoff after the four-path source tuple froze

Explicit exclusions were `package.json`, `WebGPUPickFramebuffer.ts`, scene/dispatcher helpers,
`WebGPUModelPipelineCache.ts` executable behavior, every Phase-B probe path, builds, browsers,
servers, evidence publication, network/install actions, and Git writes. A concurrent `package.json`
delta belongs to the authorized Q-130 runner lease. It was preserved and is not part of Q-141.
Other pre-existing shared-tree changes, including skybox, EDL, ocean, gulp, migration, tool, and
asset work, were also preserved and excluded.

## Re-derived defect and implemented behavior

`updateWebGPUModel` used to record a ready-gate skip and immediately continue whenever the async
color pipeline was unavailable. The ordinary pick family and the later native metadata command were
both constructed below that gate, so exact pick demand during streaming emitted no command even
though the pick-pipeline cache deliberately provides synchronous must-render pipelines.

The repair keeps the color skip observable but separates it from exact pick demand:

1. A missing color pipeline still increments `readyGateSkipsThisFrame`.
2. With no exact eligible pick demand, execution retains the existing early exit and performs no
   pick allocation or emission.
3. With eligible pick demand, the renderer completes the existing shared camera/light preparation,
   obtains the synchronous non-null pick pipeline, and creates one top-level
   `pendingPickCommand: ModelDrawCommand` with `pickOnly: true`.
4. Snap, hover, precise pass 1, BLEND-only precise pass 2, and metadata commands attach to that
   carrier. The carrier has no derived ordinary-pick duplicate.
5. A metadata frame admits the carrier only when the metadata derivative exists, so the dispatcher
   cannot fall back to an ordinary ID pick for an unsupported metadata property.
6. The carrier is appended exactly once, `pickCommandsEmittedThisFrame` is incremented, and the
   branch continues before OIT, capture, shadow, velocity, silhouette, or other color-only work.
7. The resolved-color path is unchanged: it still emits one color carrier with its derived pick
   family.

The production change in `WebGPUModelPipelineCache.ts` is comments only. It clarifies that a
ready-gate skip counts a withheld color command and may coexist with an independently emitted pick
command. The synchronous `device.createRenderPipeline` must-render hatch and every cache behavior
remain unchanged.

WebGL has no equivalent nullable asynchronous color-pipeline readiness gate. This repair corrects a
WebGPU-specific lifecycle coupling and does not require a WebGL source twin.

## Test-first chronology and retained reds

Every observed red or incomplete terminal capture remains part of the handoff.

### Required focused expected red

Before the production edit, Idril ran exactly:

```text
node --test --test-name-pattern="^F1 a pending colour pipeline" Tools/visual-regression/webgpu-pick-emission-counters.spec.mjs
```

Result: exit 1; TAP one test, zero passed, one failed; subtest 4,628.647 ms; total
5,531.136 ms. The assertion at the then-current spec line 1272 reported `0 !== 1`: the real bundled
renderer emitted zero top-level carriers while the preregistered behavior required exactly one.
The spec at that red was 68,355 bytes with SHA-256
`0C9FBCE14D3224B1697068312A48965947DC0331DF5DDB85D5A9C86D09EC4DA5`.

After Nori's production repair, the same focused command exited 0: one test passed, zero failed; F1
2,970 ms; total 3,797 ms. Its assertions retained `readyGateSkipsThisFrame === 1` while requiring one
emitted carrier and one synchronous pick-pipeline request.

### Full-spec fixture and mutant reds

The first full-spec attempt was retained at exit 1, 20 total, 15 passed, five failed. Those failures
did not justify weakening the behavioral assertions:

- F3a reached the real metadata WGSL generator but its synthetic `classProperty` omitted the current
  runtime contract, including `componentType`, producing
  `Invalid MetadataComponentType: undefined`.
- F3b reached the real classifier cache path but the bare fixture omitted
  `_classificationPipelines`.
- F3c incorrectly asked the default OPAQUE fixture for precise pass 2, which exists only for BLEND;
  after using a genuine BLEND fixture, the fixture also needed the minimum local
  `getDepthWritePipeline` behavior.
- F6 and F7 were downstream-coupled to the unresolved pending-carrier and metadata fixtures before
  they could establish their dedicated append and attachment mutations.

Idril repaired fixture fidelity only: the metadata property now supplies `type: "SCALAR"`,
`valueType: "FLOAT32"`, `componentType: "FLOAT32"`, `normalized: false`, `isArray: false`, and
`hasValueTransform: false`; the classifier fixture supplies the minimum real cache shape; and the
precise fixture is genuinely BLEND with a local depth-write pipeline stub. Assertions and production
behavior were not relaxed.

An affected-pattern slice showed F3a, F3b, F3c, and F6 passing, but the runner returned at the
30-second capture boundary before the TAP footer or F7 output. That invocation is **terminal output
unavailable**, not PASS. A separate F7-only continuation then exited 0, one of one passed, total
6,804.840 ms.

A subsequent full invocation naturally quiesced after its first ten displayed subtests passed, but
again retained no TAP footer or exit at the capture boundary. It is also **terminal output
unavailable**, not PASS.

The next bankable full result was exit 1, 19 of 20 passed. Its sole F5 failure showed that the
counter-inertness mutant had anchored the first emission call, now the new pending branch, while F5
exercised the resolved branch. Idril narrowed the LF-normalized mutation anchor to the resolved
`attachPickToColorCommand(webgpuCmd, pickCmd)` block and its immediately following emission call.
The pending branch and F6 remained untouched. The exact focused F5 command was:

```text
node --test --test-name-pattern="^F5 mutant" Tools/visual-regression/webgpu-pick-emission-counters.spec.mjs
```

Result: exit 0; one of one passed; total 6,790.095 ms.

One more full invocation naturally quiesced after ten displayed passing subtests but again lost the
terminal TAP footer at the 30-second capture boundary. It is retained as **terminal output
unavailable**, not PASS. The later bankable full invocation used:

```text
node --test Tools/visual-regression/webgpu-pick-emission-counters.spec.mjs
```

Result: exit 0; 20 of 20 passed; total 133,121.260594 ms. This result preceded exact-path formatting;
the formatted tuple was then covered by the terminal aggregate below.

### Static/style reds and repairs

The first engine TypeScript check used:

```text
.\node_modules\.bin\tsc.cmd --noEmit --project packages\engine\tsconfig.json
```

It exited 1 with four TS2559 errors because the new carrier inferred `WebGPUDrawCommand` while the
existing attachment helpers require `DrawCommandWithDerivedSlot`. Nori added only the same explicit
`ModelDrawCommand` annotation already used by the resolved carrier. The identical command then
exited 0, including again after formatting.

The first exact-path ESLint pass exited 1 because removal of the old F0 source-shape assertion left
`MODEL_RENDERER_SOURCE` unused. Idril removed that one unused constant; the renderer path constant,
source reader, behavioral tests, and mutants remained live. Exact-path ESLint then exited 0,
including again after formatting.

The first exact-path Prettier check exited 1 on the renderer, pipeline-cache comments, and spec; the
guide already passed. Nori and Idril ran only the authorized exact-path formatter writes:

```text
.\node_modules\.bin\prettier.cmd --write packages\engine\Source\Renderer\WebGPU\WebGPUModelRenderer.ts packages\engine\Source\Renderer\WebGPU\WebGPUModelPipelineCache.ts
.\node_modules\.bin\prettier.cmd --write Tools\visual-regression\webgpu-pick-emission-counters.spec.mjs
```

Both exited 0. The terminal exact-path Prettier check exited 0.

The exact C16 command was:

```text
node Tools/c16/comment-marker-guard.mjs packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts packages/engine/Source/Renderer/WebGPU/WebGPUModelPipelineCache.ts Tools/visual-regression/webgpu-pick-emission-counters.spec.mjs migration_doc/DEBUGGING_GUIDE.md
```

Result: exit 0; zero errors. It reported 43 grandfathered all-caps warnings in the pipeline-cache
source. They predate this change and are not Q-141 additions. The terminal four-path whitespace diff
check also exited 0.

## Final validation

The final formatted four-path source tuple received:

| Check | Exit / result |
| --- | --- |
| Focused pending-color F1 | 0; 1/1 |
| Full Q-141 spec before formatting | 0; 20/20; 133,121.260594 ms |
| `npm run test-readiness` before formatting | 0; 49/49; 110,949.976743 ms |
| Engine TypeScript no-emit after formatting | 0 |
| Exact-path ESLint after formatting | 0 |
| Exact-path Prettier check after formatting | 0 |
| Exact-path C16 comment guard | 0; zero errors; 43 grandfathered warnings |
| Exact four-path whitespace diff check | 0 |
| Terminal `npm run test-readiness` after formatting | 0; 49/49; 83,089.518221 ms |

The existing `test-readiness` runner entry for the Q-141 spec was unchanged. `package.json` was not
normalized or included.

## Frozen four-path tuple

The source tuple froze against base/HEAD `1f9f245ce4334ef9cb90adf00fbf626516ca1b71`:

| Path | Numstat | Bytes | LF bytes | CRLF sequences | SHA-256 |
| --- | ---: | ---: | ---: | ---: | --- |
| `packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts` | `+190/-4` | 390,502 | 9,284 | 9,284 | `A920129721D042FF0566B92AB32B86039261121EC291077F1E82215C70729EE7` |
| `packages/engine/Source/Renderer/WebGPU/WebGPUModelPipelineCache.ts` | `+8/-6` | 205,730 | 4,751 | 4,751 | `BB39B91EDE833FFE3EC81012C88024E949C5F4CC050B890F36C12D3D39DF0D98` |
| `Tools/visual-regression/webgpu-pick-emission-counters.spec.mjs` | `+358/-50` | 70,164 | 1,770 | 1,770 | `64606AF2180C753170CD288495F08D9AC590AB85FDF09C63BAC9C1868AB7D777` |
| `migration_doc/DEBUGGING_GUIDE.md` | `+3/-3` | 460,218 | 2,343 | 2,340 | `6EE1904F31D059B9652988A6A110BF7B33038933BBE353E0478FE5C8482950B5` |

Glorfindel terminally rehashed all four paths at the same base/HEAD and matched every byte count and
SHA-256. His independent source/spec review returned **GO** with no blocking semantic finding. The
literal review is banked separately at
`migration_doc/branches/reviews/glorfindel--q141-pick-during-pipeline-readiness-review.md`.

## Independent-review findings and limitations

Glorfindel confirmed field-for-field parity for pipeline/cache identity, bind groups, dynamic
offsets, vertex/index fields, counts, instance count, pass, owner, bounding volume, model matrix,
cull state, render state, pick-only flags, and non-color shadow flags. He also confirmed precise
stencil references, BLEND-only pass 2, metadata property/class hashing and dispatcher attachment,
suppression policy, non-null pipelines, one direct pending carrier, the post-emission `continue`, the
unchanged resolved path, the untouched synchronous hatch, and the lack of a WebGL lifecycle twin.

His nonblocking findings are retained:

1. The pending branch duplicates roughly 180 lines of the resolved pick-family construction. It is
   correct at this tuple, but future snap/hover/precise/metadata changes could drift.
2. Pending ordinary and metadata behaviors have direct real-function coverage. Pending snap, hover,
   and precise variants were verified by source parity, while F3c directly covers those attachments
   on the resolved path. Direct pending-mode behavioral coverage remains follow-up work.
3. `DEBUGGING_GUIDE.md` uses classification as one example near the aggregate ready-skip/pick-emission
   discriminator. Classifier pipelines are synchronous, and aggregate counters cannot attribute both
   observations to one primitive. This is a low-severity wording imprecision, not a behavior or
   counter defect. It was not changed after review because any byte change would invalidate this
   frozen tuple.

The reviewer did not rerun code tests under his read-only dispatch. His GO binds his complete static
semantic review and terminal rehash; the execution results above remain the separately banked Phase-A
gate record.

## Required DX-07/DX-10 decomposition follow-up

Do not silently leave the duplication as the long-term architecture. A later, separately leased row
should extract a typed `buildModelPickCommandFamily` helper that accepts the shared draw descriptor,
primitive and pipeline caches, material identity, exact pick-mode demand, and metadata inputs, and
returns the ordinary command plus optional snap, hover, precise-pass-1, precise-pass-2, and metadata
commands.

Carrier policy must be explicit:

- `DERIVED_FROM_COLOR`: attach ordinary and all variants to the color carrier.
- `DIRECT_PICK_CARRIER`: push ordinary directly and attach only the non-ordinary variants to it.

Metadata eligibility must be returned explicitly so an unsupported metadata property cannot admit a
direct ordinary carrier. Acceptance must cover pending/resolved multiplied by OPAQUE/MASK/BLEND and
ordinary/snap/hover/precise/metadata, plus no-demand, `allowPicking === false`, classifier, and
edge-only controls. It must compare normalized draw descriptors field-for-field, preserve pipeline
and cache-key census, kill ordinary-attachment, direct-append, BLEND-pass-2, and metadata-attachment
mutants, and run the relevant model/pick specs and the named Edge tranche. Extracting during Q-141
would have altered the already-working resolved path at the same time as the bounded lifecycle repair,
so deferral is the safer reviewed boundary.

The debugging-guide sentence should also be tightened in that documentation follow-up to:

> Because these are aggregate counters, a frame with ready-gate skips and no pick emission can mean
> exact pick demand was absent or that all skipped primitives were intentionally excluded, for
> example by `allowPicking === false` or edge-only surface suppression; only an eligible skipped
> primitive under exact pick demand indicates an upstream emission failure.

## Phase-B and landing boundary

This packet establishes Phase-A source behavior only. No fresh Cesium build, served-artifact identity,
Edge job, WebGPU/WebGL interleave, AEC hit search, `pickMetadata` browser observation, device-loss
surface, screenshot, probe artifact, or immutable evidence receipt exists for this tuple. The Edge
gate remains **CLOSED**. Tranche C remains separately serialized after the required rows land and a
fresh built/served subject is proven; missing a nonzero pending window remains STRUCTURAL rather than
a steady-state pass.

Root must rehash the complete six-path assembly before local landing, stage only the authorized Q-141
paths and migration records, and perform every commit operation. Any change to a frozen source path
requires affected validation, a new tuple, and fresh independent review. This handoff creates no push,
remote, certification, build, browser, server, evidence, cleanup, branch-change, or external-state
authority.

## Negative-action and quiescence declaration

No Q-141 worker performed a commit, stash, checkout, restore, reset, clean, push, dependency install,
full build, browser, Edge, server, network, evidence publication, process termination, deletion, or
external-state action. Nori and Idril were quiescent before source review. Glorfindel reported no
background execution; his review used read-only local inspection only. The four frozen paths remained
unchanged throughout independent review.

Elros authored only this handoff after the reviewed tuple froze. This documentation materialization
does not reopen or modify the four reviewed source/spec/guide paths.
