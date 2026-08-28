# Campaign 11 — Parity-Closure, Correctness-Reds, and Scale Architecture

Prepared: 2026-07-18

## 0. RESUME HERE — 2026-08-12 owner-attribution recovery landed

This block is the current authority for `C11-168`, `C11-169`, and `C11-205`
where older aggregate rows below disagree. It does not close any row or earn a
performance claim.

### 2026-08-27 C11-13 frozen-build provenance repair — PREREGISTERED

`R-2026-08-24-2` requires every frozen-build certification probe to consume the
gulp artifact under `Build/CesiumUnminified` and fail closed unless the served
entry is byte-identical to that on-disk artifact. C11-13 does not yet satisfy
that ruling: its browser import map still resolves `cesium` through
`/Source/Cesium.js`, then loads the package development bundles. Its existing
response hashes prove those development paths were served unchanged; they do
not prove that either browser session consumed the gulp entry.

**Bounded repair lease:**

- `Tools/visual-regression/c11-13-voxel-inside-camera-harness.html`
- `Tools/visual-regression/lib/c11-13-voxel-inside-camera-probe.mjs`
- `Tools/visual-regression/c11-13-voxel-inside-camera-probe.spec.mjs`
- this queue stamp

**Acceptance locked before implementation:** the harness imports exactly
`/Build/CesiumUnminified/index.js`; the probe fingerprints that exact local
entry at start and end; each of the `webgl` and `webgpu` sessions contributes
exactly one successful served-entry identity; the shared
`validateServedEntryIdentities` helper proves byte length and SHA-256 equality
against the start identity; source-to-build freshness and the existing C11-13
sentinels are evaluated against the browser-consumed gulp entry; and mutations
for a missing session, duplicate session, wrong status, wrong length, wrong
hash, wrong pathname, stale build, and inert/source-routed import map each turn
the focused suite red. Existing waypoint, pixel, command, watchdog, error-lane,
cleanup, and first-red contracts must remain green and unchanged in meaning.

**Honest remainder:** this is an instrument/provenance repair only. It does not
run a build or browser, recertify the 2026-08-21 artifact, close either preserved
ten-probe battery red, or change a product criterion. After offline validation
and independent review, one clean gulp/`--serve-built` browser run remains owed.

**2026-08-27 source-only result — VALIDATED, NOT CERTIFIED:** the bounded repair
now routes the harness solely through the gulp entry, binds each backend's exact
script response to the run-start disk fingerprint with the canonical helper,
rejects alternate development entries, hashes the exact final sentinel text it
evaluates, and folds missing, drifting, or malformed subject identity to
`STRUCTURAL`/3 without dropping any retained product red. The focused policy and
mutant suite is **16/16 PASS**; separate ESLint invocations for the implementation
and spec, Prettier check for all four leased paths, and `git diff --check` are
green. The broader `voxel-inside-camera-policy.spec.mjs` remains **5/6** because
its current-main strict-TypeScript composition emits existing engine-source
errors outside this lease; no file read by that failing subtest is modified by
this repair. No build, browser, GPU, network, evidence publication, or Git write
was run. The clean gulp/`--serve-built` browser certification run remains owed.

**2026-08-27 independent source review — GO:** an independent read-only worker
rehash-matched the frozen harness, implementation, spec, and queue tuple against
`aa9409432dae07ce65341304a6b2b2b226d62309` / tree
`e22636ddbeb16147a3cd555b9df0aaa3b11465cc`, reproduced the 16/16 focused PASS
plus syntax, per-file ESLint, Prettier, and diff checks, and reported zero
unresolved findings. This GO covers source-only handoff; it is not browser
certification and does not discharge the clean gulp/`--serve-built` run.

### 2026-08-27 C11-202 instance-feature selection invalidation — PREREGISTERED

The adjacent P1 remainder in the canonical C11-202 row is confirmed for native
WebGPU instancing: `ensureInstancingResources` returns a cached per-node buffer
before it re-resolves `model.instanceFeatureIdLabel`. A label/source transition
therefore leaves the old feature IDs in the `translationHigh.w` pad shared by
every primitive of the node, even though the frontend has reset draw commands.

**Bounded source lease:**

- `packages/engine/Source/Renderer/WebGPU/WebGPUModelInstancing.js`
- `packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts`
- `packages/engine/Specs/Renderer/WebGPU/WebGPUModelInstancingSpec.mjs`
- this serialized queue stamp

The giant renderer keeps only the `NodeCache` type and context wiring; feature
selection, provenance, candidate publication, retirement, and teardown stay in
the focused instancing module. `WebGPUContext` remains read-only: its existing
exact-encoder submission callback is the lifetime primitive this slice consumes.

**Acceptance locked before implementation:** resolve the selected source before
the current-buffer fast path. Semantic provenance covers the instance container
and count; transform backing identity/revision; selected source identity, kind,
and revision; its matched structural property-table identity/count/revision;
explicit attribute and typed-array identity/length/revision; or normalized
implicit offset/repeat. The raw label string is not itself a cache key: aliases
that resolve to the same semantic source reuse the exact buffer. A supported
source is live when its `propertyTableId` resolves to a non-empty structural
property table by the extension's numeric array index (with an ID-match fallback
for non-indexed compatibility data); it is deliberately not compared with global
`model.featureTableId`, which may describe another node's styling selection.
**Pre-freeze premise correction:** the first design review proposed requiring a
modern property-table `id` and `class`. The implementation audit rejected that
predicate before validation: legacy i3dm constructs its valid table 0 without
either field while its instance source points to numeric table 0. The indexed
law above preserves that shipped shape, and the focused suite locks it.

Initial explicit and implicit sources must pack exact IDs at float offsets
`19 + 24n`, including `offset + floor(n / repeat)`. Explicit A→B,
explicit↔implicit, valid→none, none→valid, backing-array replacement, table
replacement, and transform-source replacement each publish one coherent new
buffer per node. Stable provenance performs no allocation/upload/retirement and
reuses the exact current buffer. Candidate creation and upload complete before
publication; either failure destroys only the unpublished candidate, preserves
the exact incumbent/provenance/retired set, and remains retryable.

After successful publication, the incumbent enters an unscheduled retired set.
Ownership transfers only if the existing context accepts a callback for the
exact captured command encoder. Both submitted and abandoned callbacks wait on
the captured device queue's `onSubmittedWorkDone()` before destruction, because
an earlier Scene2D/readback segment may already have submitted an old capture
record. Enlistment refusal or throw keeps the old buffer for a later stable-frame
retry without reallocating the current generation; queue-settlement rejection
follows the existing device-loss policy and drops the stale owner without a
native destroy call. Teardown first detaches and deduplicates the current plus
unscheduled retired buffers, attempts every destroy despite individual throws,
is idempotent, and never also destroys scheduler-owned generations.

The focused suite must make the old existence-only fast path, incomplete
provenance keys, wrong implicit arithmetic, stale valid→none bytes, premature
publication, inline retirement, dropped/reallocated enlistment failures, missing
GPU-completion fence, unpinned recovery device, and teardown double-destroy turn
red. Existing identity-keyed merged-group coverage must continue to prove both
current and previous instance bindings rebuild together; renderer inspection
must retain the shadow-cast buffer refresh and the empty capture upsert before
instance resolution, so an old capture record can be already encoded but cannot
remain future-reachable.

**Honest remainder / terminal for this wave:** source-only validation and an
independent frozen-tuple review; no build, browser, GPU, evidence, network, or
Git write is authorized by this stamp. A later real WebGPU run must exercise the
existing instanced-box explicit/implicit labels and prove pixels, errors, exact
allocation/upload counts, capture replay, and cleanup. Primitive
`featureIdLabel` replacement lifetime, simultaneous multi-explicit attributes,
async feature-pick readback ownership, and broader primitive-cache retirement
remain open. This slice cannot close C11-202 or earn a performance claim.

**2026-08-27 source-only result — VALIDATED, NOT BROWSER-CERTIFIED:** the
instancing module now re-resolves semantic provenance before its cache hit,
reuses one retained result record on stable frames, builds and uploads a complete
candidate before atomic publication, and retires replaced buffers through the
exact captured encoder followed by the captured queue's GPU-completion fence.
Rejected/throwing enlistment remains node-owned and retryable without rebuilding
the current generation; accepted ownership is excluded from model teardown, and
detached teardown deduplicates and drains every node-owned generation
best-effort. Renderer changes are limited to cache/context types and the one
context argument.

The first implementation audit caught and repaired the preregistered modern-table
assumption before validation: numeric property-table array indexing now preserves
legacy i3dm table 0 even when that table has no `id` or `class`; no global
`model.featureTableId` equality was introduced. The focused real-module pure
Node suite is **10/10 PASS**, covering explicit/implicit/none transitions, label
aliases, every retained provenance family, legacy table shape, transactional
create/write failures, exact-encoder and GPU-fence ordering, enlistment retry,
pinned queue ownership, device-loss rejection, and exact-once teardown. Source
syntax, separate implementation/spec ESLint, Prettier over all four leased paths,
strict source-comment policy, and `git diff --check` are green. Both
`npx tsc --noEmit` and
`npx tsc --project packages/engine/tsconfig.json --noEmit` exit 0.

No build, browser, GPU, network, evidence publication, or Git write was run.
Existing browser/Karma merged-bind-group coverage was inspected but not executed;
the real explicit/implicit instanced-box pixel/capture/cleanup run remains owed.
Primitive feature-label lifetime and every other honest remainder above remain
open, and C11-202 stays PARTIAL.

**2026-08-27 independent review round 1 — NO-GO (P0 0 / P1 1 /
P2 0):** the reviewer terminally matched the four-file frozen tuple and
reproduced every declared source gate, but a new nested-call control exposed a
stale-publication race. A re-entrant `device.createBuffer` wrapper changed the
live label from explicit source A to B and invoked the same ensure path; the
nested call correctly published B, after which the outer call overwrote it with
its already-built A candidate and retired the newer B buffer. The observed live
label was `b` while the published IDs were `[1, 2]` instead of `[9, 8]`. This is
a product P1 despite the otherwise-green 10/10 suite, so the first tuple earns
no approval.

**Repair predicate locked before revalidation:** every miss captures the
node-local publication epoch and incumbent tuple before any device call. A
candidate may publish only if that epoch and tuple are unchanged **and** a
fresh semantic-provenance resolution still matches the candidate. A superseded
outer candidate is never published or added to retirement: it is destroyed as
unpublished work, then the ensure path reuses or rebuilds the newest live
generation. The focused suite must reproduce the exact A→nested-B sequence,
retain B as the current buffer/result, destroy only stale outer A, enqueue no
retirement for B, and keep the existing allocation/upload failure laws green.

**2026-08-27 repair result — REVALIDATED, NEW FREEZE REQUIRED:** the node cache
now carries a publication epoch. Each miss retains the observed epoch, buffer,
and provenance record; after allocation/upload it re-resolves the full live
semantic provenance and performs the locked tuple/epoch comparison before any
publication field changes. A superseded candidate is destroyed unpublished and
the ensure path converges on the latest live state. The exact nested A→B case
now returns the nested B result and `[9, 8]` IDs, destroys only outer A, retains
B at zero destroy calls, and creates no retirement callback. The focused suite
is **11/11 PASS** after formatting. Source/spec syntax, separate source/spec
ESLint, four-path Prettier, strict source-comment policy, and `git diff --check`
are green; both root and engine-project TypeScript commands exit 0. The first
NO-GO remains part of the run record and no approval is inferred from repair.
No build, browser, GPU, network, evidence publication, or Git write was run.

**2026-08-27 independent review round 2 — NO-GO (P0 0 / P1 1 /
P2 0):** the reviewer matched the repaired four-file tuple and confirmed the
outer-A/nested-B publication race fixed, then an epoch-reset control exposed a
distinct teardown resurrection. The teardown path detached the current tuple
and reset its publication epoch before invoking native buffer destruction. A
destroy wrapper that re-entered the ensure path therefore published a fresh
buffer into the detached node cache after teardown had already captured its
destruction set. The production model disposer then discarded that node cache,
making the resurrected native owner unreachable. All 11 focused tests and every
declared source gate were otherwise green; the tuple earns no approval.

**Second repair predicate locked before revalidation:** final node teardown
publishes a terminal lifecycle tombstone and advances, never resets, the
node-local publication epoch before invoking any foreign destroy method. An
ensure call that observes the tombstone returns null without allocating. An
already-active candidate that encounters teardown is destroyed unpublished and
must not recurse into a new generation. Focused controls must cover an incumbent
native destroy re-entering ensure, teardown during candidate allocation/upload,
and repeated teardown remaining allocation-free, idempotent, and exact-once.
Recovery, if later required, must create a new node-cache lifecycle rather than
clearing this terminal owner state.

**2026-08-27 second repair result — REVALIDATED, NEW FREEZE REQUIRED:** the
per-node owner now publishes instancingResourcesDestroyed before collecting or
destroying any native owner and advances the monotonic publication epoch
instead of resetting it. Every ensure boundary observes the terminal state.
An already-active candidate that loses the lifecycle comparison is destroyed
unpublished and returns null without recursion. Stable-hit and newly-published
paths also return null if foreign retirement enlistment terminally tears down
the owner.

The focused real-module suite is **14/14 PASS**. It retains the repaired
outer-A/nested-B control and adds separate controls for native buffer
destruction re-entering ensure, teardown during candidate allocation, teardown
during candidate upload with an incumbent, and repeated teardown. Those controls
prove no post-teardown allocation, no resurrection, monotonic epochs, no
retirement enlistment, and exact-once destruction of every incumbent and
unpublished candidate. Source/spec syntax, separate source/spec ESLint,
four-path Prettier, strict source-comment policy, and diff hygiene are green.
Both root and engine-project TypeScript commands exit 0. The two independent
NO-GO records remain immutable history and no approval is inferred from this
repair. No build, browser, GPU, network, evidence publication, or Git write was
run.

**2026-08-27 independent review round 3 — NO-GO (P0 0 / P1 2 /
P2 0):** the reviewer matched the second-repair tuple, confirmed both earlier
P1s fixed, and reproduced all 14 focused controls, but two new transaction
boundaries remained open. First, the post-upload provenance check re-read live
labels and backing objects through the original node and count snapshot. A
count-only 2-to-3 mutation therefore published two instances, and a whole
runtime-node replacement published the old source IDs, without a nested ensure
or epoch change. Second, retirement left the old buffer in the node-owned set
until after the foreign enqueue returned true. An enqueue wrapper that recorded
the callback, terminally tore down the node, then returned true let teardown
destroy the old buffer once and the later queue settlement destroy it again.
Every declared source gate was otherwise green; the tuple earns no approval.

**Third repair predicate locked before revalidation:** after allocation/upload,
publication re-resolves the current runtime node, instance container, and
first-attribute count rather than reusing any pre-device-call snapshot. A
count-only mutation and a whole-node replacement each supersede and destroy the
stale candidate, then converge on exact current IDs without requiring nested
publication. Retirement reserves/removes node ownership before invoking the
foreign enqueue. A true return commits the reservation to the callback; false
or throw restores it when the lifecycle remains live, while terminal teardown
drains the reservation exactly once. A callback invoked synchronously before
the enqueue return remains inert until that return commits ownership, and any
callback paired with false or throw stays inert. Re-entrant teardown may destroy
current and other node-owned buffers but never the reserved generation.

**2026-08-27 third repair result — REVALIDATED, NEW FREEZE REQUIRED:** the
post-upload transaction now resolves the current runtime node, instance
container, and first-attribute count after both foreign device calls. It
destroys a superseded candidate unpublished and recursively converges only while
the node-cache lifecycle remains live. The retirement scheduler snapshots its
pending set, removes each generation before enqueue, and uses a return-value
commit latch so a synchronous callback cannot acquire ownership before the
foreign call returns. Failed transfers restore a live owner or drain a terminal
reservation; successful transfers remain disjoint from teardown.

The focused real-module suite is **18/18 PASS**. New no-nested-ensure controls
change only count during candidate allocation and replace the whole runtime node
during candidate upload; both destroy the stale candidate and publish exact
current IDs on retry. The retirement controls make enqueue invoke its callback
before returning, trigger terminal teardown, and cover true, false, and throw.
They prove exact-once current/reserved destruction, one pinned queue fence only
after a true commit, inert callbacks after false/throw, stable retry when the
lifecycle stays live, and no double-destroy on repeated teardown. All earlier
provenance, legacy, failure, epoch, capture, and lifetime controls remain green.

Source/spec syntax, separate source/spec ESLint, four-path Prettier, strict
source-comment policy, and diff hygiene are green. Both root and engine-project
TypeScript commands exit 0. The three independent NO-GO records remain
immutable history and no approval is inferred from this repair. No build,
browser, GPU, network, evidence publication, or Git write was run.

**2026-08-27 parallel lifecycle review of round-4 tuple — NO-GO (P0 0 /
P1 1 / P2 0):** a second read-only reviewer hash-matched the tuple and
reproduced 18/18, then found that provenance population reused one node-owned
scratch record across synchronous re-entry. A transform revision getter swapped
backing A to B, invoked nested ensure so B published, restored A, and returned.
The nested call overwrote the outer scratch before the outer call captured its
epoch/current tuple; the outer stable-hit comparison therefore returned B while
the live backing was A. The next ordinary call repaired it, proving a one-frame
stale result rather than harmless eventual convergence. The tuple earns no
approval.

**Fourth repair predicate locked before revalidation:** provenance scratch is a
node-local reusable pool indexed by synchronous population depth. Ordinary
stable frames reuse depth zero without allocation; nested getters acquire a
different record and release it in a finally block, including throwing getters.
The exact A-to-nested-B-to-A control must return and publish A in the outer call,
retain distinct A/B bytes, and allocate no third buffer on the next stable call.
Final teardown clears the pool and depth state. A getter failure during the
post-upload live recheck must destroy only the unpublished candidate, preserve
the original error and incumbent tuple, leave depth balanced, and remain
retryable.

**2026-08-27 independent review round 4 — NO-GO (P0 0 / P1 2 /
P2 0):** the primary reviewer independently confirmed the shared-scratch
finding above and found a second stale-return boundary. With A retained after a
refused retirement and B current, the next stable B call crossed the foreign
enqueue boundary. That wrapper accepted A's callback but changed the live label
back to A before returning. The ensure path returned B without another semantic
resolution; the same exposure existed after a newly published replacement.
Exact output retained live label A with returned IDs from B and no third
allocation. The reviewer hash-stopped when the accepted scratch repair changed
the tuple, so no approval or mixed-tuple gate claim was issued.

**Fifth repair predicate locked before revalidation:** provenance population
keeps its depth slot reserved through a second read of every advertised revision
and a raw-anchor recheck of node, instances, count, packed/fallback transforms,
selected source/table, explicit backing, and implicit parameters. A late getter
that changes an earlier anchor makes the snapshot unstable; pre-candidate work
retries directly, while post-upload work destroys the unpublished candidate
before retry. The retirement scheduler reports whether it crossed a potentially
foreign boundary. Both stable-hit and newly-published paths then re-resolve a
stable semantic snapshot and compare buffer, provenance identity, and monotonic
epoch before returning. A wrapper that changes B back to A must converge on A
within that same outer call on both paths, and the following stable call must
allocate nothing.

**2026-08-27 fifth repair result — REVALIDATED, NEW FREEZE REQUIRED:** each
active provenance population now owns one reusable depth slot through its
complete fill, revision re-read, and raw-anchor validation. Nested ensures use a
different slot; ordinary calls reuse depth zero, and teardown clears the pool.
Unstable pre-candidate observations retry without native allocation. Unstable
post-upload observations destroy the unpublished candidate while preserving a
thrown getter error or converging on the new live tuple.

Retirement scheduling now reports every pending-retirement context/device
boundary. Before either a stable hit or a newly published generation returns,
the ensure path re-resolves a stable snapshot and compares exact buffer,
provenance record, and publication epoch. A foreign enqueue that changes B back
to A therefore causes the same outer call to publish/return A; callbacks already
accepted for older generations retain their disjoint submit-safe ownership.

The focused real-module suite is **22/22 PASS**. It adds exact byte-decoded
A-to-nested-B-to-A scratch isolation; post-upload getter throw cleanup; a late
revision getter changing packed-transform A to B; and foreign B-to-A mutation
across both stable-hit and new-publication retirement paths. Stable follow-up
calls reuse the scratch pool and current GPU buffer with no allocation/upload.
All earlier label/source/table/backing, legacy i3dm, transactional failure,
count/node replacement, terminal teardown, callback-commit, queue-fence,
capture, merged-binding, and shadow controls remain green.

Source/spec syntax, separate source/spec ESLint, four-path Prettier, strict
source-comment policy, and diff hygiene are green. Both root and engine-project
TypeScript commands exit 0. All prior NO-GO records remain immutable history
and no approval is inferred from this repair. No build, browser, GPU, network,
evidence publication, or Git write was run.

**2026-08-27 round-5 convergence review — NO-GO (P0 0 / P1 2 /
P2 0):** two read-only reviewers independently found that an unstable
provenance observation returned a recursive retry with no bound. An alternating
runtime-node getter exhausted the JavaScript stack after thousands of
allocation-free observations. A second control made each initial observation
stable but each post-upload observation inconsistent; before its test sentinel
stopped at 20 retries, the path had created, uploaded, and destroyed 20
unpublished candidates exactly once without ever publishing. Eventual cleanup
was correct, but unbounded CPU/stack/GPU churn is a product P1 and the tuple
earns no approval.

The primary reviewer then found a second P1 before hash-stop: revision checks
completed before a final raw-anchor getter. That getter mutated packed bytes and
their revision in place while returning the same node, identity, and length.
The path published revision 1 and uploaded translation 1 while live bytes were
translation 100 at revision 2. Adding one more revision read would merely move
the last foreign boundary; acceptance needs consecutive complete observations
whose final comparison performs no live reads.

**Sixth repair predicate locked before revalidation:** one node-local
convergence budget of four attempts covers initial snapshot instability,
post-upload supersession, post-retirement semantic change, and synchronous
nested ensure calls. It is shared across re-entry rather than reset by each
call or phase, implemented as an iterative retry loop, and cleared in a finally
block on success, null, or throw. Exhaustion returns null for that frame,
publishes no unstable candidate, preserves any incumbent ownership, and leaves
scratch depth balanced; the next frame starts a fresh budget. Exact controls
must bound an alternating-node source with zero GPU allocation, recover on the
next stable call, and prove persistent nested getter re-entry cannot create an
independent unbounded retry tree.

Each attempt acquires two separately retained depth-pool records and fills two
complete provenance observations, including runtime-node identity. Only a
plain-record equality walk follows the second observation; no live getter runs
after the acceptance decision's last captured input. Disagreement consumes the
shared convergence budget. The exact final-node-getter control mutates packed
translation and revision in place during the second observation; the stale
candidate must be destroyed, the retry must publish revision 2/translation 100,
and no stale revision-1 generation may become current. The duplicate raw
resolver is removed so feature/table/attribute selection has one implementation.
The stale module header is corrected to describe mutable semantic provenance.

**2026-08-27 sixth repair result — REVALIDATED, NEW FREEZE REQUIRED:** the
ensure path now owns one node-local scalar budget of four attempts across initial
observation, candidate publication, retirement revalidation, and synchronous
nested ensure calls. Retry is iterative; every exit clears the budget fields in
a `finally` block. A permanently alternating runtime-node getter therefore
returns null after exactly eight node reads with zero buffer creates or writes,
balanced depth, and a two-record warm scratch pool. The next stable call receives
a fresh budget and creates/uploads exactly one current generation. Nested getter
re-entry shares that same bound and also exits with every convergence/scratch
field balanced.

Each attempt now captures two separate complete provenance observations,
including runtime-node identity, then compares only those plain records. The
final-node-getter control mutates one retained packed array in place from
translation 1/revision 1 to translation 100/revision 2 during the second
observation. The revision-1 candidate is destroyed unpublished; retry publishes
only revision 2/translation 100, with two creates, two writes, and no destruction
of the current generation. The duplicate raw resolver has been removed and the
module lifetime header now describes transactional mutable-provenance handling.

The focused real-module suite is **25/25 PASS** after formatting. Source/spec
syntax, separate source/spec ESLint, four-path Prettier, strict source-comment
policy, and `git diff --check` are green. Both root and engine-project
TypeScript no-emit commands exit 0. Every preceding NO-GO remains immutable
history and no approval is inferred from this repair. No build, browser, GPU,
network, evidence publication, or Git write was run.

**2026-08-27 independent review round 6 — NO-GO (P0 0 / P1 3 /
P2 1):** three read-only reviewers terminally hash-matched the four-file tuple,
reproduced 25/25 and every declared source gate, and retained every earlier
repair, but found three open product boundaries.

First, accepted provenance was not the sole candidate input. Packed
materialization re-read `runtimeNode.transformsTypedArray`, and the fallback
path re-traversed live instance attributes. A getter returned A for both
accepted observations, transient B only for packing, then A for post-upload
validation. The path permanently published B translation 100 under A
provenance/live translation 1; the next stable call reused the wrong buffer.

Second, two finite getter-driven observations do not create a linearization
point by themselves. A late revision getter in observation two changed an
earlier-captured packed source A to B while both plain records still compared
equal. Stable-hit, initial-publication, and replacement-publication controls
each returned the prior generation for one call while live translation was 100;
the following call repaired it. A third live observation would only move the
last foreign boundary.

Third, convergence exhaustion was not draw-fail-closed. The ensure path
correctly returned null after four unstable attempts, eight node reads, and zero
GPU work, but the renderer retained `instanceBuffer=null` /
`instanceCount=1`, omitted the instancing flag, selected the singleton shadow
layout, and still emitted a one-instance command. A genuinely instanced node
could therefore render at the identity/default transform during its unstable
frame.

The bounded budget itself passed additional exhaustion, nested-reentry,
incumbent-preservation, callback/fence, and exact-once destruction mutants. The
P2 is honest measurement debt: after two-record warmup, 1,000 stable calls
allocated/uploaded nothing, but none/implicit/explicit modes still perform
4/8/12 revision reads, up to two label/attribute scans, and two 36-key equality
walks per call; CPU/heap cost is unmeasured and no performance claim is earned.

**Seventh repair predicate locked before revalidation:** candidate transform and
feature-ID bytes consume only the accepted captured provenance. Packed
materialization uses its captured packed array; fallback materialization uses
its captured translation/rotation/scale arrays. No runtime-node, instance, or
attribute traversal may occur between snapshot acceptance and the post-upload
CAS.

Every semantic fill routes through one retained tracked-read mechanism. Each
scratch record retains owner/key/value anchors without stable-frame allocation.
After each complete observation, a descriptor-only closure checks every tracked
data property, array entry, and known accessor backing field without invoking a
getter. Any late getter side effect that replaces an earlier node, instance,
transform, feature source/data, property table, attribute, count, label, or
revision-bearing data field makes that observation unstable and consumes the
shared four-attempt budget. Only two individually closed records may enter the
plain-record equality walk, and no live selector/getter runs after closure.

Renderer consumption is equally fail-closed: when a node advertises instancing
and source-only ensure returns null, that node emits zero color, pick, shadow,
capture-replay, silhouette, translucent, classifier, or velocity commands for
the frame; the already-published empty capture record remains authoritative.
Focused controls must cover late-final-getter mutation for none, implicit, and
explicit sources across stable, initial, and replacement paths; transient packed
and fallback reads after acceptance; exact bounded recovery; and source-proven
zero command emission instead of singleton fallback. All prior 25 controls and
the full source gate set remain required.

**2026-08-27 round-7 pre-freeze advisory — RED RETAINED (P0 0 / P1 2 /
P2 2):** the first expanded candidate was 31/31, but fresh read-only source and
test advisers found two further product boundaries before freeze. Backing-field
selection used untracked own-property presence, so a late getter could add
`_node`, `_instanceFeatureIdLabel`, `_sceneGraph`, `_components`,
`_propertyTables`, `_count`, or `_id` after the public path had been selected.
Feature-source kind still used raw `instanceof`, so a late getter could change
the selected object's prototype after classification. In either case both plain
records could retain the old semantic decision. The P2 findings were incomplete
matrix/inertness coverage and an unsupported exact zero-heap interpretation:
descriptor inspection may allocate even though the retained scratch containers
are reused. This was not a frozen tuple and earns no approval, but the defects
are product/test reds and are not discarded merely because they were found
before terminal review.

**2026-08-27 seventh repair result — REVALIDATED, FREEZE PENDING THE
QUIET-HOURS GIT CHECK:** alias choice now retains the exact own descriptor whose
presence or absence selected each public/backing path. Closure re-fetches that
own descriptor without falling through to a prototype. Feature-kind resolution
walks and retains a bounded 64-edge prototype chain instead of using raw
`instanceof`; both complete records are filled before either record's descriptor
and prototype anchors close, and only then enter plain equality. Candidate
transform and feature bytes still consume only captured provenance. Renderer
exhaustion still skips the exact failed instanced node before camera and
primitive traversal while leaving warmup, non-instanced, and sibling-node paths
reachable.

The focused real-module suite is **34/34 PASS** after formatting. Its full
none/implicit/explicit × initial/stable/replacement matrix observes exact getter
read counts **6/8/12**, create/write deltas **1/1/2**, and final publication
epochs **1/2/3**, with no immediate native destruction and exact final
transform/ID ownership. Separate controls make a late private-backing addition
and explicit-to-implicit prototype change retry to the new semantic source.
Persistent post-upload instability consumes the shared four-attempt budget with
exactly **16** revision reads, four creates, four writes, and four unpublished
candidate destroys while preserving the incumbent tuple/epoch; a stable next
frame recovers with **6** reads and one coherent create/write. Captured packed
and fallback inputs, data-to-accessor closure, prior lifecycle/retirement laws,
and all earlier controls remain green. Renderer source-contract mutants that
replace the node-local `continue`, inert the null guard, or remove either outer
instancing/warmup conjunct each turn the test red, and the first capture push is
non-vacuously pinned after the guard.

Fresh post-repair advisers report **P0 0 / P1 0**. Their remaining
non-measurement P2 was closed before freeze: beginning a shorter observation now
clears the previously active source, descriptor, getter/setter, value, and
prototype object slots before the retained arrays are reused, so superseded
objects are not pinned until node teardown. The post-upload exhaustion control
also asserts that the incumbent is the sole retired buffer and that the
recovered live buffer has zero native destroys.

Source/spec syntax, instancing-source/spec ESLint, four-path Prettier, strict
source-comment policy, and both root and engine-project TypeScript no-emit gates
exit 0. The renderer path is explicitly ignored by the available ESLint config
and is covered by TypeScript plus the source-contract test; that warning is not
misreported as renderer lint coverage. The current `git diff --check` remains
owed because the active weekday quiet-hours instruction prohibits every Git
invocation, including read-only checks. No build, browser, GPU, network,
evidence publication, deletion, or Git action was run. Descriptor/prototype
inspection cost remains unmeasured; no zero-heap, CPU, GPU, FPS, or browser claim
is earned. Freeze and independent exact-tuple review follow only after this
stamp is formatted, revalidated, and the permitted Git check is green.

**2026-08-27 independent source review round 7 — GO (P0 0 / P1 0 /
P2 1):** a fresh read-only reviewer matched the exact frozen four-path tuple,
reproduced the 34/34 focused suite plus syntax, source/spec ESLint, four-path
Prettier, strict comment policy, and both TypeScript no-emit gates, and carried
every prior finding forward. Candidate materialization, filled-then-closed
observations, alias/prototype closure, bounded convergence, retirement ownership,
renderer fail-closed ordering, the full mode/path matrix, exhaustion recovery,
and all biting renderer mutants are approved for this source-only slice. The
remaining P2 is measurement debt for the descriptor/prototype and two-observation
stable path; no CPU, heap, FPS, browser, or GPU claim is earned. The exact tuple
was terminally unchanged: instancing source
`75691cf75307c0dc9faaa3b75ec7e1a47c5b54c0f2c3d52452e5f12a4b60ebb1`,
renderer `7648f75aa90da620a0627f0c2feb5a40940022b87726a1fe7e8d1f69cb5951d2`,
spec `56303d31944296dacd135ef7999670bf807cf0f41ed1d4a13a065d1d643e87b0`,
and queue `2ff2b837bfc7c119f5e31d6c9c653408374f70a6761abdcfd4fe4cdfbf860c2b`.
The weekday quiet-hours Git/provenance check, clean validation manifest, and
real WebGPU certification remain owed; this GO is not landing authorization.

### 2026-08-27 C11-202 selected-feature resource generations Wave 1 —
PREREGISTERED

This serial wave begins only after the round-7 instancing source GO above. Two
read-only scouts confirmed three current P1 families. First, an existing
`_featureIdEntries` array bypasses selected source, table, BatchTexture
owner/layout/content, device, and resource-generation resolution. Second, cold
construction may publish a partial bundle when one required texture upload
returns null, while later buffer/view failure can leak provisional owners.
Third, stable batch styling refresh swallows `writeTexture` failure and clears
`_batchValuesDirty`, permanently suppressing retry. The existing 16/16 lazy-pick
suite remains green because its replacement controls primarily prove dense-pick
binding 31, not base styling binding 28 and the feature uniform together.

**Bounded Wave-1 source lease:**

- `packages/engine/Source/Renderer/WebGPU/WebGPUModelFeatureId.js`
- `packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts`
- `packages/engine/Source/Scene/BatchTexture.js`
- `packages/engine/Specs/Scene/BatchTextureSpec.js`
- `packages/engine/Specs/Renderer/WebGPU/WebGPUModelFeatureIdSpec.js`
- new
  `packages/engine/Specs/Renderer/WebGPU/WebGPUModelFeatureSelectionInvalidationSpec.mjs`
- `Tools/visual-regression/model-lazy-pick-demand.spec.mjs`
- `Tools/c16/comment-marker-grandfather.txt` (strict-comment ratchet rider only)
- `Tools/c16/comment-marker-guard.spec.mjs` (ratchet census assertions only)
- this serialized queue stamp

`WebGPUModelMetadataCache.js` and the now-approved instancing module remain
read-only. Whole-primitive layout/WGSL/pipeline regeneration is Wave 2, not a
reason to widen this lease silently.

**Locked Wave-1 predicate:** one coherent primitive generation owns its exact
entries-array identity, flags, feature texture and ownership bit, batch texture,
feature uniform, semantic provenance, device/resource generation, publication
epoch, and retirement disposition. Semantic provenance is the resolved source,
not raw label spelling, and includes instance-first domain/selector identity and
revision, exact selected source identity/kind/revision and relevant scalar
fields, texture reader/source/native realization, selected feature-table and
BatchTexture owner identities/revisions, feature count, dimensions/step,
authoritative value-array identity/content revision, pipeline defaults, and a
renderer-supplied compatibility token. The owned `BatchTexture` mutation path
must advance a monotonic content/layout revision before either backend can
consume its dirty bit.

Every cold miss or semantic replacement fills and closes two complete tracked
observations, compares only closed records, builds solely from accepted captured
inputs, and CAS-publishes only if the incumbent tuple and epoch remain exact
after all user/native boundaries. One shared four-attempt budget covers nested
re-entry and post-upload revalidation. A complete candidate publishes atomically;
required feature/batch texture, buffer, upload, or view failure publishes
nothing and destroys each provisional owned resource once. An exact stable tuple
returns the same entries identity with zero allocation, upload, publication,
retirement, or merged-bind-group rebuild. Alias-only label changes that resolve
to the same source are stable.

In-place style-content change writes the retained batch texture exactly once,
updates the generation's content revision, and clears dirty only after success.
Failure leaves the generation stale and retryable even if WebGL already consumed
the shared dirty bit; the affected primitive emits no command on that call.
Compatible A→B, A→none, none→A, same-count owner, dimensions/step, unavailable→
ready texture, borrowed↔owned, and device/resource-generation transitions either
publish the complete current generation or fail closed. A renderer-visible null
disposition skips that exact primitive before color, pick, shadow, capture,
silhouette, translucent, classifier, and velocity emission; undefined remains
the legitimate no-feature result. Any transition outside the supplied
compatibility token also returns the fail-closed disposition and records the
Wave-2 remainder rather than binding stale or fabricated resources.

Replaced private textures and uniform buffers become node-owned retired
generations. Ownership is reserved before exact-current-encoder enlistment;
accepted callbacks wait on the captured old queue's `onSubmittedWorkDone` before
exact-once native destruction. False/throwing enlistment is restored for stable
retry, synchronous callback-before-return cannot double-own, rejection drops
references without calling a lost device, and teardown tombstones/advances the
epoch before detaching and best-effort draining only current or node-owned
resources. Borrowed stub/default/model-wide dense-pick resources are never
destroyed by this owner.

The focused real-module suite must prove exact cold attribute/implicit/texture
counts; the semantic transition matrix; bindings 26/28/31, decoded uniform
fields, flags, entry identity, and ownership; successful/failed content refresh;
partial-construction rollback; getter/native re-entry A→B; bounded exhaustion and
recovery; teardown/enqueue/callback/fence/rejection laws; device/generation
pinning; sibling isolation; and stable zero-work. Mutants must restore the
existence-only hit, omit each provenance family or the compatibility token, key
raw labels, invert instance precedence, use untracked alias/prototype decisions,
publish early/partial/live bytes, clear dirty after failure, let outer A overwrite
nested B, mutate entries in place, destroy inline/use a frame-wide scheduler,
reserve after enqueue, use the new queue, skip/reject the fence incorrectly, or
continue command emission after null. The existing 16/16 lazy-pick suite and
round-7 34/34 instancing suite remain required regression gates.

**Wave-1 source run ledger — 2026-08-27, pre-freeze:** the first author
invocation of the new real-module suite passed 14/17. Two failures were harness
defects (a stub returned a fresh texture wrapper on every observation, and the
renderer contract looked for the wrong local identifier). The third was a valid
product red: teardown detached and cleared the retired-generation set before
iterating it, so the old A feature texture survived A→B replacement. The
teardown order was repaired without weakening the assertion. The author then
expanded the renderer mutants and reran 20/20 PASS. Root independently fixed two
mechanical lint findings, ran Prettier, and reproduced `node --check`, per-file
ESLint, and the same focused suite at 20/20 PASS (exit 0).

The pre-migration invocation of
`node --test Tools/visual-regression/model-lazy-pick-demand.spec.mjs` remains
banked at 10/16 PASS. Cases 4/10/11 still encode frame-wide
`scheduleTextureDestroy` ownership instead of exact captured-encoder enlistment;
cases 8/9 exposed replacement promotion before publication and are product-fixed
but not yet rerun in that harness; case 15 inspects the now-thin exported wrapper
instead of the generation/candidate implementation. This measured red remains
operative until the preregistered harness migration and rerun; it is not
reclassified as a product PASS.

The first post-migration lazy-pick invocation completed syntax, ESLint, and
formatting cleanly but measured 14/16 PASS. Case 10 proved both primitive base
generations stayed live through their exact callbacks and died only after their
captured-queue fences, then correctly transferred the old dense texture to its
separate scheduler; the test incorrectly required the first two PickIds to die
even though same-owner 2→3 growth deliberately reuses them in the current
registry. Case 16 had one non-biting harness mutant: its unqualified replacement
hit the earlier helper occurrence of
`_retiredFeatureIdGenerations.add(generation)` rather than the rejected-enlistment
restore inside `scheduleRetiredFeatureResourceGenerations`. These are two
harness reds, not hidden product passes; the 14/16 invocation remains banked.

After correcting only those two harness defects, the second migrated invocation
passed 16/16 (exit 0). It now proves that primitive-local batch textures and
uniform buffers remain live before callback and before fence, destroy only after
the captured old queue settles, keep the old dense texture pinned until every
primitive marker settles, then transfer that dense texture through its separate
scheduler. Same-owner count growth preserves the reused PickIds, stable repeats
add no enlistment, and all renderer/feature/frontend mutants bite. Node syntax,
per-file ESLint, and Prettier are green for the migrated spec.

**Integrated pre-review gate — 2026-08-27:** the current Wave-1 suite passes
20/20, the migrated lazy-pick regression passes 16/16, and the unchanged
round-7 instancing regression passes 34/34. Node syntax checks pass for every
leased JavaScript/MJS path; ESLint exits 0 for the matching JavaScript/MJS
paths; Prettier reports every leased source/spec/queue path formatted. ESLint
explicitly warns that `WebGPUModelRenderer.ts` is ignored because no matching
configuration is supplied, so this record does not claim ESLint coverage for
that TypeScript file. Both `npx tsc --noEmit` and
`npx tsc --project packages/engine/tsconfig.json --noEmit` exit 0 and Prettier
covers the renderer. No build, browser, GPU, network, evidence publication, or
Git action was run.

**2026-08-27 adversarial source review — NO-GO (P0 0 / P1 5 / P2 1):**
the pre-freeze reviewer found five required repairs. (1) Selected-source
`propertyTableId` is observed but table/BatchTexture resolution still follows
only `model.featureTableId`, permitting a primitive or instance source to bind a
different table. (2) The dense-pick cache hit omits device, resource generation,
and in-place owner identity, so recovery or owner-only transitions may reuse
stale texture/PickIds. (3) Dense-pick allocation/publication and primitive
promotion lack an incumbent/epoch CAS around native and owner callbacks, so
reentry may overwrite a nested newer publication or leak/alias generations. (4)
An outer in-place batch upload can overwrite a nested newer upload, then stamp
the old bytes with the new provenance. (5) Required batch-resource failure can
destroy an owned feature texture and fall into a catch that destroys it again if
the first destroy throws. The P2 is inherited WebGL `BatchTexture.update`
clearing dirty before a create/copy that may fail; it is outside the current
WebGPU source lease unless adjudication makes it necessary. Existing tests miss
these cases because table ids are uniform, pick is inactive in transition and
reentry cases, and no throwing-destroy or upload-reentry control exists. This
NO-GO reopens implementation; the green pre-review gates do not certify the
tuple.

**NO-GO repair predicates — locked before the adversarial red run:** the exact
selected source's defined non-negative integer `propertyTableId` selects that
indexed model feature table; only an undefined selected id may use the legacy
`model.featureTableId` fallback, and an invalid defined id fails closed. The
model-wide dense-pick generation keys the exact device, queue, resource
generation, BatchTexture, owner, feature count, and dimensions; every miss is a
captured candidate with an epoch/incumbent CAS, and rollback destroys only its
new texture/IDs. Primitive binding-31 promotion likewise CASes the exact base
generation, entries, buffer, epoch, and dense generation across view/write
boundaries. Reentry that publishes B makes an outer A stale and unable to
overwrite or alias B. Retained content upload tracks the bytes/revision actually
written; stale outer X after nested Y must trigger a final Y upload before a
green return. Partial candidate cleanup detaches provisional ownership before
calling a possibly throwing destroy, so every owner sees at most one destroy
call. The focused suite must add biting selected-table, owner/device/generation,
model-wide pick reentry, primitive-promotion reentry, retained-upload reentry,
and throwing-destroy controls; none may be weakened to existence-only checks.

**Adversarial red run — 2026-08-27, valid product FAIL:** syntax, per-file
ESLint, and Prettier completed, then the expanded real-module suite passed 20/26
and failed exactly six preregistered controls. Selected table 1 decoded feature
count 2 from legacy table 0 instead of 3. An in-place owner transition reused
the same dense texture/PickIds. Nested revision 2 uploaded bytes 197 before the
outer revision-1 write overwrote them with bytes 31 and returned green. A
throwing provisional feature-texture destroy was called twice. Model-wide pick
reentry left current PickIds targeting outer owner A instead of nested owner B.
Primitive promotion reentry split the published entries alias from the current
generation and restored source-A binding 26 over nested source B. These six reds
are the operative repair acceptance; the prior 20/20 is superseded for freeze.

**First repair run — 2026-08-27, 25/26 PASS:** the full dense owner/device/
resource-generation tuple, both reentry CAS controls, retained-upload final-byte
witness, and exact-once throwing rollback are green. The sole remaining valid
red is the selected-table invalid-index branch: defined id 7 currently publishes
an empty no-feature generation and returns `undefined` instead of returning
fail-closed `null` while preserving the selected-table incumbent. Syntax,
per-file ESLint, and Prettier are green; this run remains FAIL until that explicit
invalid-reference distinction is repaired.

**Second repair run — 2026-08-27, 26/26 PASS:** a defined invalid selected
table id now returns fail-closed `null` before publication, while undefined
retains the legacy model-table fallback. All six operative P1 controls are now
green: exact selected table/style/pick ownership; dense owner/device/resource
generation; actual uploaded-content revision; throwing cleanup at most once;
model-wide dense candidate CAS; and primitive binding-31 CAS with coherent
generation aliases. Node syntax, per-file ESLint, and Prettier pass. This is an
author repair result, not the required fresh independent frozen-tuple review.

**Wave-1 WebGL retry rider — preregistered before control implementation:** the
adversarial P2 is included in this wave because `BatchTexture.js` and its spec
are already leased and the dirty/content revision is shared provenance consumed
by both backends. For an existing batch texture whose first `copyFrom` throws,
the update throws without clearing `_batchValuesDirty`; the next update retries
exactly once, succeeds, and clears it. For a successful `copyFrom` that
reentrantly changes show/color, the completed update must not clear the newer
dirty revision or replaced value-array identity; one subsequent update uploads
the current values and clears dirty only when both captured witnesses remain
exact. Texture-creation failure follows the same retry law, while a texture that
was successfully created before a later copy failure remains counted once and is
reused by the retry. The focused Node suite adds the two existing-texture
controls before product repair. The present pre-upload-clear implementation is
expected to fail the throwing-copy retry control while preserving a mutation
made during `copyFrom`; a mutant that restores that early clear must keep the
first control red, and a separate mutant that clears unconditionally after a
successful copy must make the reentrant-revision control red. No browser or
backend-performance claim follows from this source-only rider.

**WebGL retry rider first run — 2026-08-27, valid product FAIL at 27/28:**
Node syntax, per-file ESLint, and two-path Prettier exit 0. The new throwing
`copyFrom` control observes exactly the preregistered defect: the call throws
after one copy attempt but `_batchValuesDirty` is false, so the required retry
is suppressed. The revision and array-identity reentry cases are green on the
current pre-clear implementation, establishing the behavior that a naïve
unconditional post-copy clear would regress. This 27/28 result remains banked;
the product repair must make the throw retryable without weakening either
reentry witness.

**WebGL retry rider first repair verification invocation — mixed / lint
ERROR:** the repaired focused suite passes 28/28, including `setShow`,
`setColor`, and value-array-identity reentry; source/spec syntax and three-path
Prettier exit 0. Two concurrent direct ESLint invocations emitted no diagnostics
but did not terminate after two bounded waits and were interrupted, each exiting
1. This invocation makes no ESLint PASS claim; the lint processes are banked as
tool ERROR and must be rerun serially under a hard watchdog before freeze.

**WebGL retry rider lint rerun and source result — 2026-08-27, 28/28
PASS:** the first attempted watchdog wrapper failed to parse its inline Node
program and exited 1 before launching ESLint; that wrapper invocation is banked
as tool ERROR, not a lint result. Direct serial ESLint then exited 0 separately
for `BatchTexture.js` and the focused spec. Together with the already-green
syntax and three-path Prettier checks, the 28/28 focused run proves that failed
WebGL copy remains dirty/retryable, stable retry clears exactly once, show/color
revision or array-identity drift remains dirty, and a third stable call performs
zero upload. This is still an author source result, not independent review or
browser/WebGL certification.

**Pre-freeze advisory round 2 — NO-GO (P0 0 / P1 1 / P2 2):** the
canonical dense generation captures the dimensions object but rereads mutable
`x`/`y` after `getFeature`/`createPickId`/native callbacks. Its final CAS checks
object identity and positivity, not the scalar extent that allocated the byte
array, so an in-place resize can publish mixed allocation, descriptor, upload,
and generation widths. This is an operative P1. The first P2 is that an already
cached generation does not key the exact `context.createPickId` function and may
reuse registry IDs across an in-place factory change. The second is bounded
multi-table churn: two stable primitives selecting different property tables
share one model-wide dense slot and can alternate replacements. That topology
belongs to the already-explicit simultaneous-multiple-set Wave-2 remainder and
is recorded rather than silently widening Wave 1.

**Round-2 repair predicates — locked before the scalar red run:** capture
validated positive integer dense width/height once, require capacity at least
the feature count, use only those scalars for allocation, texture creation,
upload layout/extent, and generation metadata, and require the live same-object
dimensions still have both exact scalars at final CAS. A same-object resize from
2x1 to 3x1 during the first `createPickId` must destroy the coherent 2x1 loser
once, converge on and publish only a coherent 3x1 generation, and never expose a
3x1 upload backed by 2x1 bytes. Invalid or undersized extents fail closed without
publication. The dense tuple also captures the exact `createPickId` function;
cache hit, ID reuse, and final CAS all require it. An in-place factory change
must rebuild texture and IDs against the new factory. Additional green controls
must exercise primitive reentry after uniform `writeBuffer`, not only
`createView`, and assert the losing dense texture as well as its new PickIds are
destroyed exactly once. Independent mutants must omit scalar CAS, capacity,
factory hit/reuse, post-write CAS, or losing-texture cleanup one at a time and
turn the relevant policy/control red.

**Round-2 adversarial red run — 2026-08-27, valid product FAIL at 28/31:**
the focused suite fails exactly the three new product controls. A same-object
2x1→3x1 callback mutation creates only one dense texture, proving the 2x1 byte
allocation was published under the later 3x1 extent. A 1x1 extent for two
features publishes instead of failing closed. Replacing `context.createPickId`
hits the incumbent instead of rebuilding IDs and texture. The new post-uniform-
write primitive CAS case and exact-once losing-dense-texture assertion are
green. Syntax and two-path Prettier exit 0. Per-file ESLint separately exits 1
on one harness-only `no-unused-vars` finding for the first callback parameter;
that mechanical red is retained and must be corrected without changing any
product assertion before repair validation.

**Round-2 repair run — 2026-08-27, 31/31 PASS:** the dense allocator now
captures validated positive integer width/height once, rejects insufficient
capacity, uses only captured scalars through allocation/descriptor/upload/
generation construction, and requires the same live scalars at CAS. The exact
`createPickId` factory participates in hit, reuse, generation provenance, and
teardown aliases. The focused suite proves a coherent destroyed 2x1 loser then
coherent live 3x1 replacement, fail-closed invalid extents, factory replacement
with fresh texture/IDs, both primitive promotion callback boundaries, and
exact-once losing texture/ID cleanup. Source/spec syntax, serial per-file ESLint,
and three-path Prettier exit 0. This remains an author source result; the legacy
source-policy suite, combined regressions, freeze, and fresh independent review
are still owed.

**Canonical dense source-policy migration — preregistered before rerun:** the
legacy 16-test suite still slices `ensurePerFeaturePickIds`, now only a
texture-return compatibility wrapper, and asserts removed flat cache fields.
Its current rerun is expected to be a harness/source-policy red rather than a
new product red. The migration must instead slice the canonical hit, live-CAS,
publication, provisional-cleanup, current-generation, primitive-CAS,
generation-allocation, wrapper, promotion, and candidate-preparation helpers.
It must require the full device/queue/context/resource-generation/BatchTexture/
owner/owner-method/factory/dimensions/scalar/count tuple; validated capacity;
captured-scalar allocation and upload; incumbent and publication-epoch CAS;
factory-safe ID reuse; detach-before-destroy rollback; primitive checks after
view and uniform-write boundaries; exact bound-generation publication; actual
uploaded-values/revision witnesses; and wrapper-only RETRY-to-null plus texture
projection. Existing dense-retirement, exact current-encoder enlistment,
captured old-queue fence, restoration, and registry-release assertions and
mutants remain unchanged. Independent inertness mutants remove owner, device,
resource generation, factory, width/height CAS, incumbent/epoch CAS, primitive
dense-token CAS, uploaded witness, or provisional detachment one at a time; each
must bite before the migrated suite can return green.

**Canonical dense source-policy pre-migration run — 2026-08-27, 14/16
FAIL:** all fourteen runtime/behavior tests remain green. The policy test fails
because direct primitive `_featureIdEntries` publication no longer exists, and
the mutant test fails while constructing that same removed anchor before it can
exercise later obsolete flat-field mutants. This is the expected harness/policy
red, not a product regression. Node syntax, per-file ESLint, and two-path
Prettier exit 0. The 14/16 run remains banked until the preregistered canonical
helper and inertness migration is green.

**Canonical dense source-policy first migrated run — 2026-08-27, 14/16
FAIL:** all fourteen runtime/behavior tests remain green. The new policy test's
sole red is harness ownership: it looked for the actual-upload witness in the
bounded retry wrapper `ensureFeatureIdResourcesGeneration`, while the native
refresh and accepted witness live in its canonical one-attempt helper
`ensureFeatureIdResourcesAttempt`. The mutant test still fails while constructing
the intentionally obsolete direct `_featureIdEntries` publication anchor. Node
syntax and serial ESLint exit 0; Prettier exits 1 on the unformatted migration.
No product red is inferred, and this 14/16 result remains part of the run record.

**Canonical dense source-policy first complete run — 2026-08-27, 16/16 PASS
with formatting red:** all fourteen runtime behaviors, the canonical source
policy, and its function-scoped independent mutant matrix pass. The matrix bites
the full generation tuple, capacity and captured upload, exact owner/factory ID
reuse, live incumbent/epoch CAS, three primitive publication boundaries,
detach-before-destroy cleanup, actual-upload witnesses, and thin wrapper while
retaining the prior byte-40, retirement, current-encoder, and queue-fence
controls. Node syntax and serial ESLint exit 0; Prettier exits 1. This invocation
therefore makes no all-gates-green or freeze claim until formatting and the full
suite are rerun.

**Canonical dense source-policy formatted rerun — 2026-08-27, 16/16 PASS:** all
fourteen runtime behaviors, the canonical source policy, and every independent
mutant pass after repository formatting. Node syntax, serial ESLint, and
Prettier all exit 0. The suite now follows the canonical generation helpers and
contains no direct primitive-publication or obsolete flat-cache policy anchor;
the historical retirement/current-encoder/captured-queue controls remain live.
This is an author result; the combined wave gate and a fresh exact-tuple review
remain required before freeze approval.

**Wave-1 integrated pre-freeze gate — 2026-08-27, SOURCE PASS:** the selected
resource suite passes 31/31, canonical lazy-pick passes 16/16, preserved
instancing passes 34/34, and the complete comment-ratchet suite passes 20/20
(101/101 total). Eight leased/dependency JavaScript and MJS paths pass Node
syntax and serial per-file ESLint. Prettier passes all ten checked source, spec,
Tools, renderer-TypeScript, and queue paths. The two-product-source strict
comment scan reports zero findings, errors, and warnings. Root and engine-project
TypeScript no-emit both exit 0; the renderer TypeScript path is covered there and
is not misreported as ESLint-covered. No build, browser, GPU, network, evidence
publication, or Git action was run. Exact tuple freeze and fresh independent
review remain required; real backend certification remains owed.

**Wave-1 exact source freeze — 2026-08-27:** the first read-only manifest command
computed the tuple but exited 1 because this PowerShell runtime lacks the invoked
single-argument .NET JSON-serializer overload; it emitted no usable manifest and
changed no file. The supported native serializer rerun exited 0 and froze the
following exact path/hash/byte/EOL tuple. `crlf/lf` are newline counts; every
listed path has zero bare CR. The clean-list's one LF is preserved dependency
state, not normalized by this wave.

| Path | SHA-256 | Bytes | crlf/lf |
| --- | --- | ---: | ---: |
| `packages/engine/Source/Renderer/WebGPU/WebGPUModelFeatureId.js` | `c0c219979726470f70dc5a12e7d3f060c2384a4eebb41e8a3800f721b99fda2a` | 96280 | 3210/0 |
| `packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts` | `cc8e0a8adeee6725bbea305cb8b5b83742dfabe5ab1da9ccedc2b30baced0d79` | 380497 | 9043/0 |
| `packages/engine/Source/Scene/BatchTexture.js` | `4a2ac91cd1c0bfed94234c464bdaddf925a0dac3fb299f45a4b2967463dc4ae7` | 20484 | 633/0 |
| `packages/engine/Specs/Scene/BatchTextureSpec.js` | `20d6cc5750af09df5146fd24c40d30f92a0ebb363c01f2a0ce66ef2848a08322` | 14041 | 422/0 |
| `packages/engine/Specs/Renderer/WebGPU/WebGPUModelFeatureIdSpec.js` | `1b9cd445d96c400c08fd751224bc3c924d4d83fe691145bb0a00c6c26a2ac24f` | 27013 | 736/0 |
| `packages/engine/Specs/Renderer/WebGPU/WebGPUModelFeatureSelectionInvalidationSpec.mjs` | `499979dc608617c5dac215d57889005b5eb3c716a10726fe0d185c0cc066c69f` | 60835 | 0/1873 |
| `Tools/visual-regression/model-lazy-pick-demand.spec.mjs` | `4e8b70fe47e969936164654ecf4e21deb07f5166e3e113d8fa80dfa0bcc088b3` | 67583 | 0/1973 |
| `Tools/c16/comment-marker-grandfather.txt` | `2ed5b4ccc5ef564aa19211aee211d445c953222824926dbcb3951f20959ffa16` | 2788 | 28/0 |
| `Tools/c16/comment-marker-guard.spec.mjs` | `b16d62d8db7b9e0086285c4a519da364b80be991f6670aea09d1eefeff53ec45` | 24984 | 733/0 |
| `Tools/c16/comment-marker-guard.mjs` | `c76d05212097a6a87d300151a7e67c1339dc20189d9c82330cecaec34b9d1f97` | 26990 | 791/0 |
| `Tools/c16/comment-marker-cleanlist.txt` | `ddef9e35a81da23d0c7d18153e2bef6c90ea1e08917c2dd97ae30ec4cafcf1c5` | 42522 | 663/1 |
| `Tools/c16/lib/marker-grammar.mjs` | `0fb3fbe8d3e2968c77e76a321309ac5e0e164f748754fcc6ef0093e8c008d0f6` | 7752 | 204/0 |
| `packages/engine/Source/Renderer/WebGPU/WebGPUModelInstancing.js` | `75691cf75307c0dc9faaa3b75ec7e1a47c5b54c0f2c3d52452e5f12a4b60ebb1` | 51349 | 1632/0 |
| `packages/engine/Specs/Renderer/WebGPU/WebGPUModelInstancingSpec.mjs` | `56303d31944296dacd135ef7999670bf807cf0f41ed1d4a13a065d1d643e87b0` | 56962 | 0/1698 |

This freeze is source-only. The queue hash is computed after this formatted
stamp and supplied separately to the fresh reviewer so the ledger cannot
self-reference a pre-stamp byte sequence.

**Independent Wave-1 source reviews — 2026-08-27, CONFLICTING VERDICTS;
terminal NO-GO (P0 0 / P1 3 / P2 0):** Galadriel terminally matched all fourteen
frozen rows plus post-stamp queue
`f6b02b18bd30096c064300bc7add92b8e594a561305f9d14efc9bb4482b18cbb`,
reproduced the 31/31, 16/16, 34/34, and 20/20 suites, all eight syntax and serial
ESLint paths, ten-path Prettier, zero-finding strict comment gate, and both
TypeScript projects, and returned a broad SOURCE-ONLY GO with no new finding.
That review is retained. A second fresh review independently matched the same
hashes and core suites; its first escaped ESLint wrapper was a tool ERROR and a
later aggregate emitted only five results, so it reran all eight paths as
separate serial calls and observed exit 0. Its dedicated read-only mutant audit
then returned NO-GO on three missing preregistered proof families:

1. **P1 — primitive provenance-family omission mutants are missing.** The base
   provenance registry is compared, but no mutant independently drops a
   selector/source, texture realization, selected table/BatchTexture, or
   pipeline/default family. In particular, the selected-table runtime control
   changes both `propertyTableId` and a revision, so a missing
   `selectedPropertyTableId` registry key can be masked.
2. **P1 — the WebGL retry rider is incomplete.** The frozen runtime controls use
   a preinstalled texture and do not cover `createTexture` failure or prove a
   newly created texture/statistics owner is retained and reused after a later
   `copyFrom` failure. The preregistered `WEBGL-DIRTY-EARLY-CLEAR` and
   `WEBGL-DIRTY-POSTCOPY-UNCONDITIONAL` source mutants are also absent.
3. **P1 — losing-resource destruction mutants are missing.** Runtime controls
   witness loser cleanup and policy pins detach-before-destroy ordering, but no
   mutant independently inerts `texture?.destroy()` or
   `createdPickIds[i].destroy()`.

These are evidence/test-contract findings, not confirmed product defects. The
NO-GO controls, the frozen approval is revoked, and no landing authority exists.
A new author pass must add the exact missing controls/mutants without weakening
any existing assertion, bank any resulting product red, rerun the complete gate,
and create a new tuple for fresh independent review.

**Three-P1 evidence repair — PREREGISTERED before spec edits:** product source
remains unchanged unless a new control exposes a real behavior red. The focused
real-module suite grows from 31 to 34 tests. A narrow esbuild test seam replaces
only `BatchTexture`'s imported `Texture` dependency while executing the real
`BatchTexture.js` module. One control forces the first constructor to throw and
requires dirty=true, no published texture/statistics charge, then exactly one
successful construction/copy/statistics charge on retry and zero third-call
work. A second lets construction/statistics succeed but throws the first
`copyFrom`; it requires the exact created texture and one statistics charge to
remain, retry via that same texture with no second construction/charge, dirty to
clear only on exact success, and a zero-work third call. A source-policy control
then constructs independent `WEBGL-DIRTY-EARLY-CLEAR` and
`WEBGL-DIRTY-POSTCOPY-UNCONDITIONAL` mutants; each must make the policy red while
the live source remains green.

The canonical 16-test lazy-pick suite retains all behavior and prior mutants. Its
policy now slices `FEATURE_RESOURCE_PROVENANCE_KEYS` and
`sameFeatureResourceProvenance`, requires the registry-driven exact-key loop,
and pins representative members independently across device/queue/generation,
compatibility/pipeline/defaults, runtime/primitive/selector/source,
texture-realization, feature-table/BatchTexture owner, dimensions/step/count,
and values/content-revision families. Function-scoped or exact registry mutants
remove each representative family or inert the registry loop one at a time; all
must bite. Two additional function-scoped mutants independently inert the
provisional losing texture destroy and created-PickId destroy; the existing
detach/order policy and runtime exact-once controls must reject both. Acceptance
is focused 34/34 plus canonical 16/16 with syntax, serial ESLint, and Prettier
green before the 34/34 instancing and 20/20 comment-ratchet regressions are
rejoined. Any product red is banked and repaired separately; no browser or
performance claim follows.

**Three-P1 evidence repair first validation — 2026-08-27, behavior PASS with
static red:** the first patch transport for the test-only virtual Texture module
failed before editing because its embedded template literal terminated the
transport string; the delimiter-safe retry landed the same design. The focused
suite then passed 34/34 and canonical lazy-pick passed 16/16, with both syntax
checks green. No new product red was exposed and product source remained
unchanged. Lazy-pick ESLint exited 0; focused ESLint exited 1 only on
`prefer-template` for the generated data URL, and two-path Prettier exited 1.
This invocation makes no all-static-gates-green claim.

**Three-P1 evidence repair formatted rerun — 2026-08-27, TOUCHED-SCOPE PASS:**
after the one-line template-literal style correction and repository formatting,
focused passes 34/34 and canonical lazy-pick passes 16/16. Both Node syntax,
both separate serial ESLint invocations, and two-path Prettier exit 0. The new
real-module WebGL controls prove constructor-failure retry and created-owner/
statistics reuse after copy failure; both dirty-policy mutants bite. The
canonical policy now rejects exact provenance-family omissions, an inert
registry comparator, and independent losing-texture/PickId destruction mutants.
No product source changed in this repair.

**USER-DIRECTED LANE PAUSE HANDOFF — 2026-08-27:** stop here; do not begin a
new wave, new freeze/review, Git action, commit, build, browser/GPU run, network
publication, or evidence publication until the maintainer resumes the goal. The
first frozen tuple remains rejected by the recorded three-P1 NO-GO. The current
validated author deltas are the two specs below plus this queue stamp:

- `WebGPUModelFeatureSelectionInvalidationSpec.mjs` — SHA-256
  `de56b76c8f8b3aa45e7ce3308ed8342ba8a88040474634106e4b2a044f016087`,
  69,562 bytes, LF 2,105, CRLF/bare-CR 0.
- `Tools/visual-regression/model-lazy-pick-demand.spec.mjs` — raw on-disk
  CRLF worktree form: SHA-256
  `db5f99967f4ad585f7260f455dfa15f48a91f4a3271cac9f7dc211b5b59248f9`, 73,303 bytes,
  CRLF 2,108, lone-LF 0, lone-CR 0; the 2026-08-27 pause session's
  LF-normalised form was SHA-256
  `09389f22114ff95717a68e1bd9ea3a4365502cb162ec524643ca0f36306bb233`, 71,195 bytes,
  LF 2,108, CRLF 0, lone-CR 0. Direct CRLF-to-LF normalization reproduces that
  LF tuple byte-for-byte, so the difference is EOL-only, not content; a fresh
  raw-byte freeze and independent review are owed before landing.

On resume, first verify these two hashes and reread the newest ruling/state. Then
run the complete joined source gate: focused 34/34, lazy-pick 16/16, instancing
34/34, and comment-ratchet 20/20 (104/104), followed by all leased/dependency
syntax, serial ESLint, Prettier including this queue, strict source comments, and
both TypeScript no-emit projects. Only a green joined gate may create a new exact
tuple for a fresh independent audit. Git provenance/diff/landing comes after
that review and only under then-current hours/authorization. Real WebGL/WebGPU
pixels, picked properties, recovery, async readback, multi-table topology, and
performance certification remain explicitly open; C11-202 remains PARTIAL.

**Strict source-comment guard pre-repair — 2026-08-27, FAIL:**
`node Tools/c16/comment-marker-guard.mjs --strict` over the two touched product
sources exited 1 on exactly one historical marker in
`WebGPUModelFeatureId.js:979`: `[all-caps-fix-label]
PARITY-METADATA-TABLE-INSTANCE-SOURCE`. This is touched-source comment debt, not
a product-test failure, and it remains part of the run record. Freeze requires a
seamless prose replacement plus a green strict rerun; the finding is not
de-scored or omitted because it predates this wave.

**Strict source-comment guard first rerun — 2026-08-27, still FAIL:** the prose
replacement leaves zero marker occurrences, but strict mode exits 1 because the
now-clean file/rule pair still has a stale row in
`Tools/c16/comment-marker-grandfather.txt`. Source syntax and serial ESLint exit
0. Prettier exits 1 on the new comment wrapping. This invocation makes neither a
strict-guard nor formatting PASS claim.

**Strict-comment ratchet rider — PREREGISTERED:** the bounded lease expands only
to `Tools/c16/comment-marker-grandfather.txt` and the census assertions in
`Tools/c16/comment-marker-guard.spec.mjs`. Remove exactly the stale
`WebGPUModelFeatureId.js` / `all-caps-fix-label` pair and update its derived
census from 23 to 22 rows, 18 to 17 all-caps pairs, and 126 to 125 current
findings. Scanner grammar, severity, clean-list scope, and every other exception
remain byte-for-byte unchanged. Acceptance is a formatted touched source, zero
strict findings/stale rows on the two product sources, and a green complete
comment-guard spec; any other ratchet delta or weakened assertion is a failure.

**Strict-comment ratchet first complete run — 2026-08-27, 19/20 FAIL:** the
two-source strict scan exits 0 with zero markers, zero stale rows, and 22 exact
grandfather pairs. Source/spec syntax and serial ESLint exit 0. The complete
guard spec reports its sole failure in the exact occurrence census: the live
`--verify-cleanlist` result is 122 current findings, not the preregistered 125
estimate; all 22 pairs remain live. This proves three other occurrences inside
still-valid pairs had already self-cleaned, rather than exposing another stale
pair. Spec Prettier also exits 1 after the assertion edit. The observed,
fail-closed acceptance is therefore corrected to assert exactly 122 live
findings, retain the 22/17 pair census, format the spec, and rerun all gates; the
19/20 result is not discarded.

**Strict-comment ratchet final run — 2026-08-27, PASS:** the exact two-source
strict scan exits 0 with zero markers, zero errors, zero warnings, and 22 live
grandfather pairs. The complete guard suite passes 20/20 and its exact census
asserts 122 current findings; source/spec syntax, serial ESLint, and two-path
Prettier all exit 0. Only the stale `WebGPUModelFeatureId.js` exception was
removed, and only the derived census assertions changed; scanner grammar,
severity, clean-list scope, and every other exception remain unchanged.

**Explicit remainders:** `_FEATURE_ID_1+` and simultaneous multiple explicit
sets; any vertex-layout, implicit-synthesis, metadata WGSL/class, pipeline, or
whole-command regeneration; overlapping async pick-readback ownership and
delayed PickId release; browser/WebGPU/WebGL parity pixels and picked properties;
capture/shadow/Scene2D/multiview evidence; device-loss/recovery certification;
and CPU/heap/GPU/performance measurement. Wave 1 cannot close C11-202.

- **`C11-205` measurement gates remain green; its shared campaign-runner and
  route-prime policy changes landed in Batch 1032 (`be0683c60d`).** The
  lifecycle, exact-work, API-attribution, and six-pair uninstrumented causal
  evidence remain valid. The resident-San-Francisco CPU/wall deficit remains
  valid, with GPU cause unknown because that causal run had no GPU timestamp
  samples. The diagnostic below neither reopens the row nor establishes a
  remediation.
- **`C11-168` comparability is no longer blocked.** The older aggregate cell near
  the bottom of this document predates the six valid resident pairs recorded in
  the canonical row. Root-cause attribution, remediation, landing, and a later
  uninstrumented confirmation remain open.
- **`C11-169` resident owner-attribution Tools packet landed in Batch 1032
  (`be0683c60d`); the row remains NOT COMPLETE.** Final diagnostic run
  `63c4806e-83cb-4ac3-bddd-8a28d1dcdca7` is `PASS`, exit `0`, with four passing
  600-frame legs in AB/BA order and 2/2 valid attribution-only pairs. Every leg
  has exact owner/trace/route alignment, route progress `0→1`, eight 75-frame
  segments, 55 exact per-frame owner hits, and no out-of-parent calls. Both
  WebGPU legs have exact profiler sequences `1..600`, more than the required
  540 named-pass-positive frames, all 11 phases populated, and zero accounting,
  attribution, bridge, overlap, or unattributed residual error.
- **Both harness reds remain immutable and distinct.** Run
  `6499611d-66b6-4072-ab1f-7ef47791045a` failed only because the measurement
  cursor repeated progress `0`, omitted endpoint `1`, and one WebGPU leg captured
  601 route rows. It is noncausal and earns no engine verdict. The mutable output
  was archived before reuse as
  `Tools/visual-regression/output/performance/c11-169-resident-sf-owner-attribution.run-6499611d-harness-red.json`,
  SHA-256
  `8BF47C39AF3FEAE842B32AD5B30F5E2E47D5F2F83662BF9FE8D067D02690B897`.
  The write-once first red remains the older r2x240 structural convergence run
  `e29e3478-90b8-4a64-b33b-24a0a91a2aa1`, SHA-256
  `185E606881B04EFDA75B10EC559BECAACBAEF4CECBB2EACF09E33CC7A38231D7`;
  the two records must not be conflated.
- **Final artifact and source identity are exact.** The owner cursor runs on
  `clock.onTick` before `Scene.render`, suppresses sibling route mutation during
  measurement, removes itself idempotently, and covers exact `i/599` endpoints
  and eight 75-frame segments. The runner's stale initial restoration assignment
  was removed; Node syntax, owner/workload policy **73/73**, Prettier, ESLint, and
  scoped diff hygiene pass. Corrected runner SHA-256 is
  `8045B6462EF498B290DC5965C0013715BCA34A0E0C1EEA269F22349ED137AE12`.
  Final artifact
  `Tools/visual-regression/output/performance/c11-169-resident-sf-owner-attribution.json`
  is 8,453,346 bytes, SHA-256
  `C755784AEF33AA85DF8C8F0DD72C0E025BFF38AC54F441CF1349DB5E95774C1C`,
  and binds frozen bundle SHA-256
  `7B42F00D0135C28CE5D9CC90486966EBA21B452B8974A6293381FE8761BFCBDA`.
  The lock is absent after final persistence.
- **Diagnostic interpretation only:** across the 1,200 WebGPU frames,
  `primitiveTraversal` mean/median/p95 is 4.715/4.3/9.4 ms. Nested owner means
  attribute 47.668% to 48 direct models, 43.246% to globe render, 4.954% to four
  tilesets, 3.243% to ordinary non-asset residual, 0.825% to primitive residual,
  and 0.064% to ground primitives. These synchronous instrumented shares select
  the next causal experiment; they are explicitly noncausal, noncertifying, and
  make no FPS, GPU, or uninstrumented performance claim. Console capture contains
  only 57 allowlisted sandboxed `about:blank` messages; do not report it as an
  empty console array.
- **Landing and next action:** the corrected five-file Tools packet landed in
  Batch 1032 (`be0683c60d`). Use the owner split to design the smallest
  uninstrumented `C11-168` discriminator. Do not rerun this unchanged green
  artifact or reinterpret it as a causal, GPU, or FPS result.

Status: **LAUNCHED / EXECUTING (2026-07-18).** Campaign 10 CLOSED at **Batch 711 (`9a52717cf2`)**; the
`C11-00B` launch-intake + fallout-sweep (§4) has RUN (this doc's 2026-07-18 reorder is its output) and
reconciled the tree. The standing maintainer directive for the C10→C11 seam is now exercised — the
loop is live and executing **W1** (which now opens with `C11-157` OIT translucent-primitive wiring; see
§5). The 2026-07-18 maintainer-ratified decisions are recorded RESOLVED in **§7.0**, the appended
schedulable rows in **§1.23** (`C11-157..165` + `C11-SEED-27`, collision-verified), and the new
`CELESTIAL_WATER_REFLECTION_RESEARCH.md` epic as **`C11-163`**. Historical launch-authority context is
preserved below.

Status update (2026-07-23): **PAUSED / OPEN REMAINDER RETAINED.** Campaign 11 did not reach its exit
gate and is not being called closed. The entire `clouds-weather` cluster (`C11-124..130` and
`C11-SEED-10..18`) transferred to the explicitly launched
[`Campaign 13`](QUEUE_2026-07-23_CAMPAIGN13.md). **Those C11 IDs are historical aliases only and are
not schedulable in Campaign 11.** `C11-126` was already complete; `C11-125` was partial; the other
rows keep their actual open/blocked/deferred state under their C13 owners. The mapping in §1.17 is
the lookup bridge; Campaign 13's live ledger is the sole scheduling/status authority. Every
non-cloud Campaign-11 row remains owned here and open at its recorded status.

Status update (2026-07-28): **TARGETED W1 PERFORMANCE LANE RESUMED; CAMPAIGN
CERTIFICATION STILL HELD.** The WebGL shader first-use investigation now has
canonical owners `C11-180` and `C11-181` (§1.27). This resumes only the
non-cloud W1 performance lane; it does not waive the 2026-07-23 ruling that
the remaining body executes before `C11-137` certification.

Status update (2026-07-31): **LOCAL/COMMITTED/STAGED AUDIT COMPLETE; TARGETED
W1 EXECUTION CONTINUES; CERTIFICATION STILL HELD.** Local `main` equals
`origin/main` at Batch 771 (`fe990ab335`) and the index is empty. The dirty
tree is a reviewed multi-lane workspace, not one landing unit. Canonical build,
root and engine-package TypeScript, focused lint/format, 138 eclipse contracts,
and 45 performance-harness contracts are green. Focused `EdgeHeadlessCI`
Karma launched Edge but executed zero tests, so browser-owned focused rows
remain open rather than being called green.

The one-pair moving globe-only control remains near parity: WebGL CPU average
4.816 ms / p95 9.300 ms versus WebGPU 5.123 ms / 9.315 ms, with WebGPU better
p99 and pacing. This rules against a general globe-quadtree/RTE collapse but is
not six-pair certification. Representative measurement now fingerprints the
renderer-neutral logical workload in an untimed deterministic route replay
after the render trace and all measured snapshots have closed; content scans
therefore no longer contaminate `Scene.render` CPU samples.

The earlier 600-frame resident pair is retained as directional history only:
it predated exact logical-workload fingerprints. A fresh current-source pair
had 600 frames and zero terrain requests/generations in both legs, and terrain
tile identity matched on every frame, but the pair correctly failed
comparability because 3D Tiles selection diverged in the San Francisco segment
(710 WebGL versus 571 WebGPU selected-tile observations, maxima 15 versus 12,
with no unidentified tiles or statistics/array count mismatch). Backend-emitted
direct-model commands were also found to be an invalid exact-identity metric
because C11-185 intentionally removes them; the harness now fingerprints the
configured/ready model instances instead. That artifact honestly surfaced an
unattributed 3D Tiles readiness/residency seam, not different traversal math;
`C11-205` owns its lifecycle and resident gate. The current local lane now
attributes the seam to harness wall-clock route-prime admission, proves exact
work/identity in all six instrumented pairs, and certifies all six separate
non-instrumented causal pairs. The resulting WebGPU CPU/wall deficit is valid,
but GPU timestamps were disabled, so its bottleneck remains open under C11-168.
*(That lane's shared runner and its attribution/causal evidence landed at Batch
1032 `be0683c60d`, 2026-08-12; the `C11-205` row below is the authority.)*

`C11-181` is **COMPLETE — IMPLEMENTED / VERIFIED / LANDED (Batch 773,
2026-08-01; administrative close recorded 2026-08-09)**. *(Close authority:
`DEFERRED_WORK.md`, landed Batch 1063 `21c9489185`, 2026-08-20.)* `C11-192` (Batch
775), `C11-199`/`C11-211` (Batch 774), `C11-200`
(Batch 776), and `C11-201` (Batches 776/777) are implemented and landed with
focused source/static coverage; the narrow
discarded-manager allocation slice of `C11-193` is also implemented and landed
(Batch 776) while its
shared scheduler/demand work remains open. Current moving runtime evidence is
green where applicable, while focused browser execution remains open.
`C11-184` (Batches 775/780) and `C11-187` (Batch 778) remain **IN PROGRESS**
even though their current slices have landed.
`C11-20` is **PARTIAL**: normal Point/Label collection teardown is fixed,
covered, and landed (Batch 778), while nested model/tileset/clipping and
replacement-device invalidation
remain open. `C11-90` is promoted to a P1 post-performance correctness tail:
glTF modes LINES, LINE_LOOP, LINE_STRIP, TRIANGLE_STRIP, and TRIANGLE_FAN still
collapse to triangle-list, and indexed strips require format-keyed pipeline and
shadow state plus restart-safe uint8 upcast. This is real parity debt, but it is
not the measured current performance cause.

Stopping-point update (2026-07-31; landing reconciled 2026-08-01): the requested
high-value lane is documented
in [`HANDOFF_2026-07-31_CODEX_C11_HIGH_VALUE.md`](HANDOFF_2026-07-31_CODEX_C11_HIGH_VALUE.md).
That whole working tree **landed as Batches 772-781 on 2026-08-01**
(`origin/main` = `3900608bb9`) after orchestrator review, with eight confirmed
defects fixed pre-landing; landing changes no row's completeness and closes no
open gate below.
`C11-208` is **COMPLETE** (implemented, verified, and landed Batch 777;
administrative close recorded 2026-08-09). *(Close authority:
`DEFERRED_WORK.md`, landed Batch 1063 `21c9489185`, 2026-08-20.)*
`C11-193/194/195/202/205`,
`C11-60`,
and `C11-76` remain **PARTIAL** even though their slices have landed
(`C11-193`/`C11-60`/`C11-76` Batch 776, `C11-194` Batch 774, `C11-195`
Batches 772/780, `C11-202` Batches 774/780, `C11-205` Batch 779).
Notable new slices are the environment shared refresh encoder/packed parameter
arena and observe-only demand ledger; exact-device pooled immutable model
layouts/defaults; RTE-correct capture arenas; bounded fog/cloud post-process
bind-group caches; and backend-neutral final model realization with native
async readiness. Post-landing Batches 784/791/800 also added ordinary ready-tile
identity/rejection and the main camera + model/view light dynamic-offset arenas.
The 2026-08-02 worktree has since closed bounded slices for exact model tuple
recovery, schema-v2 request/multiple-content chronology, and native-descriptor
legacy pick/edge-stage allocation. Those rows remain partial for their real
Edge/resident, higher-level recovery, moving allocation/timing, residual
frontend/native-edge RTE, and focused browser gates. Measured arena allocation/
GC cost, remaining private submitters, and the broader wave also remain open.
The final stopping-boundary edits required a fresh combined build/probe pass;
that pass ran at landing (tsc clean, `gulp build` green, Node contracts
195/195 at `3900608bb9`). The browser-owned gates listed above are unaffected
and remain open.

### 2026-08-14 HASH STAMP — un-cited C11 landings in `cff0b76a2f..034c7f74d0` (fix SOL-1)

_Added 2026-08-14 by the fix queue of
[SOL_WEEK_AUDIT_2026-08-14.md](SOL_WEEK_AUDIT_2026-08-14.md) (finding S10 / fix SOL-1).
Of the 98 commits in that range only **32** were cited anywhere in a tracked document —
the audit's Lane A counts 31 because it scoped to `migration_doc/**`, and the one it
misses (`034c7f74d0`) is cited only in `README.md`. The C11-owned landings below carried
**no hash citation in any tracked file at all**. Every hash was
verified with `git log --no-walk <hash>`. **This stamp cites; it closes no row and earns
no verdict** — the canonical rows and the §0 RESUME HERE block above remain the status
authority._

**Read every line below against two range-wide facts.** (1) **All 98 commit bodies in
the range are empty** (re-verified 98/98 at this stamp) and 0/98 carry a co-author
trailer, so the subject line is the only in-git claim carrier and
`SOL_WEEK_AUDIT_2026-08-14.md` is the evidence authority for the range. (2) **Batch
numbering stopped after Batch 1027** — the first ten rows below still carry batch numbers
and are in batch order; the remainder have none and are therefore in commit-time order,
which is the only ordering the range supports.

| Batch | Commit | Subject | Note |
| --- | --- | --- | --- |
| 1018 | `5d148bf07b` | C11-133 fail-closed Karma completion and Edge profile cleanup | |
| 1019 | `19bd4ac340` | C11-60 cache cloud-shadow bind groups | |
| 1021 | `aaf9cbe00f` | close render-pipeline variant semantic keying | Also edits `DEFERRED_WORK.md` + `DEBUGGING_GUIDE.md`; see the CLAUDE.md pipeline-key section. |
| 1022 | `0d87eabf8e` | stabilize IBL generation recovery | |
| 1023 | `3a930c6716` | make primitive restart demo transform-safe | `C11-90`. |
| 1024 | `d1cfadeb6c` | define 3D Tiles patch and invalidation extension | Design doc only (`3D_TILES_PATCH_EXTENSION_DESIGN_2026-08-11.md`), no code. |
| 1025 | `bb524f8a07` | bind C11-209 browser provenance | |
| 1026 | `37eaf017e6` | consolidate effects placeholder initialization | `C11-209`. |
| 1027 | `e19829c9e8` | add fail-closed C11-146 route assessor | **Last batch-numbered commit in the fork.** |
| — | `739a04cf19` | Fix WebGPU voxel readiness and pick lifecycle | Engine + `C18` queue edit; the engine half is stamped in `DEFERRED_WORK.md`. Audit S6(b)/S13 are open against this area. |
| — | `5d324d08fc` | Record offline isolation machine evidence | Doc-only, this file. `C11-134`. |
| — | `51b2c34eab` | Keep primitive restart demo offline | `C11-90`. |
| — | `360d26f0a5` | Record C11-134 online environment red | Doc-only, this file. |
| — | `8d148a80b6` | Add feature-priority campaign portfolio queue | Creates `CAMPAIGN_PORTFOLIO_QUEUE.md` (408 lines) — grouping only, not a status authority. |
| — | `4c34d3e9f6` | Refresh campaign attribution frontier | Doc-only, `CAMPAIGN_PORTFOLIO_QUEUE.md`. |
| — | `47a2fd475d` | Type metadata layouts across the WebGPU model seam | Also stamped in `DEFERRED_WORK.md`. |
| — | `4ecc17cb46` | Close C11-13 voxel inside-camera acceptance | Doc-only. **Audit S17: the closure band is IoU ≥ 0.6 against an observed 0.994, and the banked PNGs show a real cross-backend stipple artifact a mean metric with 150× headroom cannot flag.** Treat the row as closed-with-a-known-loose-band. |
| — | `4877bc62a7` | Add C11-168 direct-model ablation discriminator | Tools only. |
| — | `a2f8098e44` | Record C11-193 environment scheduler landing | Doc-only across four files. |
| — | `e14432d362` | Add immutable visual evidence library | Tools only, 5,351 lines. **Audit S19 / ruling ask (R-e): `lib/visual-evidence-library.mjs` is a 3,252-line parallel evidence stack that imports zero project modules and that nothing in the pipeline consumes.** Adopt-or-remove is a maintainer call; do not treat its presence as adoption. |

### 2026-08-09 Codex source/status audit — current work order and ledger corrections

This source-verified audit supersedes stale range labels and the older row text
where they disagree:

- `C11-100` is **PARTIAL**, not NOT STARTED. Static depth-3 traversal (585
  slots), dynamic level-2 residency/LRU, and their probe exist. The genuine
  remainder is levels beyond 3/general page-table traversal, level-3 paging/LRU,
  and the re-upload pixel-drift triage coordinated with `C18-A2/A6`.
- `C11-195`'s source architecture is substantially complete. The arena is
  context-owned, exact device/resource-generation invalidation exists, and the
  per-acquire string/short-array churn is closed. The row remains **PARTIAL for
  certification only**: moving allocation/GC plus multi-view, shadow, capture,
  and replacement-device browser evidence.
- `C11-60` and `C11-76` are **PARTIAL**, not NOT STARTED. Their landed/local
  narrow slices do not close the remaining stage churn/private submitters.
- `C11-181` and `C11-208` have no named technical or acceptance remainder and
  are administratively **COMPLETE** in this audit. Landing is not generally
  completion; these two close because their recorded gates are all green.
- `C11-178`, `C11-149`, and `C11-201` are administrative close candidates, not
  fresh implementation projects. They are not self-promoted here until their
  alias/evidence-freshness records are reconciled.
- After the current point-cloud/voxel/cloud source freeze, the ordered next
  work is: `C11-213` compatibility-mode safety; `C11-205` lifecycle/resident
  browser certification; `C11-140` probe/artifact landing; then instrumented
  `C11-214` diagnosis and the focused `C11-186` fresh-imagery red. **Standards
  correction 2026-08-09:** the current WebGPU limits table guarantees 8
  fragment-stage storage buffers for core and 4 for compatibility mode; the
  zero compatibility limit applies to the vertex stage, not the fragment
  stage. `C11-213` consumes one fragment read-only-storage binding, so the
  existing globe layout fits both conforming profiles. The per-stage accessors
  are temporarily optional in `@webgpu/types` during browser rollout; absence
  is not zero and must use the legacy `maxStorageBuffersPerShaderStage` value
  for diagnostics. `core-features-and-limits` is already requested when
  exposed. Therefore no higher-limit request, sampled-texture fallback,
  imagery-slot reduction, layout fork, or feature removal is a prerequisite
  for closing the row. Close on a true Edge compatibility-profile gate with
  the effective fragment limit recorded, zero validation/device errors, and
  draping/reduced-imagery lifecycle pixels green; a numeric value below 1 is
  legacy/non-conformance evidence for a separate shim.

### 2026-08-02 Codex continuation + Edge certification overlay — C11-212 remains partial

This overlay supersedes both older C11-212 rows that call the WebGPU snap tier
complete or imply a generic one-frame-stale contract. The 2026-08-02
continuation — reviewed while unstaged, **LANDED at Batch 819** — fixes the
previously audited **copy old texture → render new snap
payload** ordering: sync and async copies are now appended to the active pick
encoder and mapping begins only after that frame submits. Completed bytes are
published atomically with immutable camera/frustum/viewport and exact integer
drawing-buffer sample provenance. CSS/DPR/Y conversion, bounded query/frame
age, small-overlap cursor remapping, split-viewport payload load behavior,
exception-safe `pickEnd`, and current-snap-pass-only derived-command allocation
are also corrected. The renderer-neutral pick-frustum correction now handles
drawing-buffer viewport offsets, independent aperture width/height, asymmetric
off-centre perspective and orthographic planes, direct
`PerspectiveOffCenterFrustum`, and frozen unprojection. WebGPU readback
provenance includes the effective far plane, so a far-only projection change
cannot reuse stale bytes. The combined snap/projection Node lane is 69/69.

The WebGPU multi-frustum slice erases farther payload at pixels covered by the
nearer slice through one scissored zero draw in the existing payload pass; it
adds no pass/resource/bind group/submission, has explicit mutation and split-
continuation coverage, fails fast if its callback wiring is missing, and is
independently reviewed GO. WebGL now uses its renderer-appropriate snapless
occluder derived command to write a zero payload at the nearer winner without
an extra pass. A rebuilt real-Edge `probe-snap-multifrustum.mjs` run passes on
both backends with TAA enabled: far model visible, nearer object in a distinct
frustum slice suppresses it, far model returns after removal, and device,
console, and page error arrays are empty.

The target-cost audit rejected query-sized attachments at the current
architecture boundary because the snap mini-frame intentionally preserves the
normal full-viewport projection/culling/screen-space contract. The safe
optimization instead changes only WebGPU's payload from RGBA32F to exact
RG32Uint: key remains exact u32, eye depth remains f32, and the edge bit uses
the depth word's otherwise-clear sign bit. That saves 63.28 MiB at 4K and cuts
the total full-size RGBA8 + RG32Uint + D24S8 target set from 189.84 MiB to
126.56 MiB; the snap-only unused occluder color uses `storeOp: discard` while
ordinary picking is unchanged. The 25x25 staging row also falls from 512 to
256 bytes after alignment.

`C11-212` remains **PARTIAL**. The multi-frustum surface correctness gate is
green, but the remaining acceptance matrix still owes a forced SCENE2D slice-
camera-depth probe; moving camera/cursor runs across DPR, asymmetric projection,
split viewport, canvas-edge, and RTE/culling-boundary cases; even-sized aperture
and WebGL edge-clipped logical-padding corrections; and an architectural
decision on whether a shared transient attachment pool can safely reduce the
remaining 126.56 MiB full-size peak. Edge payloads remain
`UP144-SNAP-WEBGPU-EDGES`; classification checkpoints and broader/non-Model
producer coverage remain open under the existing riders. Do not mint a
duplicate task ID or close the row from the now-green surface gate.

#### 2026-08-02 rider — `UP144-SNAP-WEBGPU-EDGES` IMPLEMENTED (LANDED Batch 821), browser gate owed

The edge tier named above is now **implemented** and no longer an open sub-row:
`WebGPUEdgeVisibilityEmitter` grew a `fragmentSnapMain` that writes the RG32Uint
payload with the edge sign bit unconditionally set, plus an
`ensureEdgeEmitterSnapPipeline` variant whose descriptor name carries both the
payload-format and pick-fleet log axes; `WebGPUModelRenderer` plumbs the SAME
`ensurePickId` per-primitive pick color the surface snap draws use (no parallel
ID path) and attaches the variant on `derivedCommands.snapping.snapCommand`; and
`WebGPUSceneRendererPickPass` admits `CESIUM_3D_TILE_EDGES` /
`CESIUM_3D_TILE_EDGES_DIRECT` at the TAIL of the payload phase **without**
loosening the strict resolved-snap-variant (FORK-34) guard. The emitter WGSL now
resolves through the module cache under the add-only
`ShaderSourceId.EDGE_EMITTER = 42`. A separate shared-code defect was fixed in
the same slice: `Snapping.captureSnapView` converted integer drawing-buffer
sample INDICES without the half-pixel term, biasing every reconstructed ray and
`screenPosition` half a drawing-buffer pixel up-left on BOTH backends. **That
half of the slice is therefore NOT "WebGL byte-identical":** `Snapping.js` is
shared scene code, so WebGL's snap results moved by the same half drawing-buffer
pixel. It is the correct outcome under Principle 5 (a shared-path defect gets
fixed for both backends, not routed around for one), `SnappingSpec` moved with
it, and it is called out here so nobody reads the row as a WebGPU-only change.

Node evidence: `Tools/visual-regression/webgpu-snap-edge-payload.spec.mjs`
25/25 (live stub-device pipeline + UB drives, real payload encode/decode
round-trip, naga validation in both log states, `Snapping.js` functions lifted
and executed, six mutation tests); `pipeline-key-aliasing.spec.mjs` 49/49 after
declaring the emitter under `NO_CENTRAL_CACHE` (that spec has since grown to
59/59 under Batch 825's structural module-identity fold, Edge-verified in both
modes at Batch 828); package tsc 0 non-TS2307 errors; root `tsc --noEmit`
clean.

**`C11-212` still stays PARTIAL.** This rider closes only the edge-payload
producer gap, and it owes its OWN browser gate before the deferred row can be
promoted: an Edge/Playwright snap at a model silhouette returning `isEdge: true`
on BOTH backends with positions agreeing inside the probe's pixel tolerance.
Everything else in the paragraph above (SCENE2D slice depth, moving
camera/cursor matrix, aperture/logical-padding, transient pooling,
classification checkpoints, non-Model producers) is untouched by this rider.

Status (historical): **PREPARED / NOT LAUNCHED.** Auto-launches when Campaign 10 CLOSES, per the standing
maintainer directive (2026-07-17: "finish Campaign 9 and then move onto campaign 10" — the same
directive that armed C10 to launch on C9 close; C11 inherits the same standing-launch rule for the
C10→C11 seam). The `C11-00B` launch-intake sweep (§4) runs ONCE at that moment and reconciles the
tree before the first slice.

Launch authority: **standing directive**, exercised only after Campaign 10 reaches its close
(`C10-30` verdict recorded) and `C11-00B` has swept the live C10 ledger. No slice starts until the
launch note (§4 output) is presented to the maintainer with a `git branch -a` inventory and the tree
is clean (`npx tsc --noEmit` green).

Operating model: **ORCHESTRATOR** (the same model C10 launched under). The orchestrator (**Fable**,
the main loop) prepares each brief, dispatches a **model-matched worker** (**Opus** or **Sol**;
**Sol = external takeover** seat), reviews the returned diff adversarially, and **lands** it. Workers
implement on a **dirty tree and NEVER commit** (leave-dirty contract). The orchestrator is the only
actor that stages, commits, pushes, and flips ledger rows. Full charter + takeover manual + salvage
playbook + engine-script fallback: **`campaign11_planning/guides/G10-charter-mechanics.md`**
(authoritative for this queue's mechanics — this doc references it, does not duplicate it).

Source pointers:

- **Item universe (authoritative):** `campaign11_planning/CANDIDATE_REGISTER.md` — 188 merged items,
  22 clusters, 9 P0s. No existing IDs renamed; this queue assigns each a canonical `C11-xx` number
  (§1) and keeps every register name as an alias.
- **Cluster execution guides (per-item walkthroughs, anchors, model-tier, effort):**
  `campaign11_planning/guides/G1..G10`. A worker reads its task's guide section before implementing.
- **Cross-cutting planning findings:** `campaign11_planning/_PLANNING_STATUS.md`.
- **Structure mirrored:** `QUEUE_2026-07-16_CAMPAIGN10.md` (front matter + §1 rules + §2 rulings +
  §3 gates + §5 waves shape). Rules in §2 are inherited verbatim from Campaign-9/10 §1.
- **Defaults-parity feed:** `DEFAULT_PARITY_MATRIX_2026-07-18.md` (22 backend divergences → G8).
- **Anchors verified at HEAD `9204647535` (Batch 701)** (guides G1–G7 at `5b98ab9698`, G8/G9/G10 at
  `9204647535`); register sweep HEAD `aef553d592` (Batch 698); this queue assembled at HEAD
  `c643516c04` (Batch 703). **Line numbers are hints — re-grep every `file:symbol` before acting.**

---

## 1. CANONICAL ID TABLE (the campaign backbone — authored FIRST)

**Why this section is first (the C10 numbering-collision lesson, G10 §B8.6).** In C10 the register's
W8 rows were proposed as `C9-40…49`, collided with in-flight C9 rows, and had to be renumbered
`C10-01…10` ordinally. To prevent a repeat, **every schedulable register item is assigned its C11
number here, in one place, BEFORE any prose references it.** No `C11-xx` number is ever minted ad hoc
in wave/gate prose — prose points back to this table.

**Numbering scheme.**

- `C11-00` — engine-script fallback / launch infra (DEFERRED under orchestrator mode; absorbs the
  register's `C10-00-ENGINE-HANDOFF-AND-SCRIPT-GEN` item).
- `C11-00B` — launch-intake sweep (name inherited from the `C10-00B` pattern; §4).
- `C11-01 … C11-156` — the **156 P0–P2 schedulable** register items, numbered in register-cluster
  order, **no gaps, no reuse**.
- `C11-GT-01 … C11-GT-03` — the 3 **gated-tail** items (cluster 19 `gated-reversed-z`); openable only
  by the gate chain in §6.
- `C11-SEED-01 … C11-SEED-26` — the 26 **P3 / arch-seed / next-campaign** items; recorded so the
  measured checkpoint can point at them, none C11-schedulable without its own gate.
- `C11-IC-01 … C11-IC-03` — the 3 **C10-owned intake-conditional** register items whose C11 status is
  decided by the live C10 ledger at `C11-00B` (they are NOT given a schedulable number until intake
  resolves them).
- `C11-GATE-D-CHECKPOINT` — the C11 measured performance checkpoint (a **gate row**, not a register
  item; §3 / §5 W8). Named to avoid colliding with `C11-30`.

**Placement accounting:** 156 numbered + 3 gated + 26 seeds + 3 intake-conditional = **188 register
items placed, zero unplaced.** Uniqueness verified mechanically (§1.24).

**Owning-guide caveat (historical launch finding):** two clusters — `rte-taa` (7 items,
`C11-51..57`) and `clouds-weather` (16 items, `C11-124..130` + `C11-SEED-10..18`) — originally had
**no dedicated cluster guide** (the first 10 guides covered 165 of the 188 items). The live worker
instruction now applies only to `rte-taa`: commission its guide before opening a non-trivial slice.
The cloud rows transferred to C13 and must not be opened from this queue; C13's queue and cloud
planning artifacts supersede the original guide gap for execution.

Columns: **C11-id · canonical register name(s) [aliases] · clusterKey · pri · workClass · effort ·
guide · wave.**

### 1.0 Infra / intake / gate rows

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-00` | Engine-script fallback prep [absorbs `C10-00-ENGINE-HANDOFF-AND-SCRIPT-GEN`] | build-boot | R0 | infra | S | G10 | DEFERRED (orchestrator mode) |
| `C11-00B` | Launch-intake sweep [pattern of `C10-00B`] | — | R0 | gate | S | G10 | W0 |
| `C11-GATE-D-CHECKPOINT` | C11 default-path performance checkpoint [mirror of `C10-30`] | — | R0 | gate | M | G10/G9 | W8 |

### 1.1 `pick` (cluster 1, 11 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-01` | NEW-WEBGPU-PICKPOSITION-CONVERGENCE-REGRESSION | pick | P0 | correctness | unknown | G1 | W1 (diagnose) · **pickPosition-convergence half CLOSED — fix Batch 1069 (`153e4bf010`), hardware-certified Batch 1085 (`7194beb31f`), 4/4 Edge Karma; the companion offline black-globe-interior bimodal repro remains OPEN; ledger carve-out row is the authority** |
| `C11-02` | NEW-WEBGPU-BUFFER-PRIMITIVE-PICK-DISPATCH-PARITY | pick | P0 | correctness | M | G1 | W2 |
| `C11-03` | NEW-WEBGPU-ASYNC-PICK-PIPELINE-READINESS-CONTRACT | pick | P0 | correctness | M | G1 | W2 |
| `C11-04` | NEW-WEBGPU-COMPUTE-INSTANCE-PICK-INDEX-MIRROR | pick | P0 | correctness | S–M | G1 | W2 |
| `C11-05` | NEW-COLLECTION-PICK-2DCV-PIPELINE-KEY-PARITY | pick | P1 | correctness | M | G1 | W2 |
| `C11-06` | C9-02A-WEBGPU-PICK-DEPTH-PLANE-PIPELINE-PARITY | pick | P1 | correctness | M | G1 | W2 · **intake condition DISCHARGED — C10-12 landed Batch 710 (`4e1ea2a81d`); C10 closed Batch 711** |
| `C11-07` | FAR-107-PICKQUERY-CONTRACT | pick | P1 | infra | M | G1 | W2 |
| `C11-08` | NEW-PICK-WEBGPU-MULTIFRUSTUM-PACKED-DEPTH / FAR-408-C0 | pick | P1 | perf | L | G1 | W2 |
| `C11-09` | NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU (pick remainder) | pick | P1 | correctness | M | G1 | W2 |
| `C11-10` | BACKLOG-§4 Picking 6.1 main-scene depth blit | pick | P2 | parity | M | G1 | W2 |
| `C11-IC-01` | NEW-WEBGPU-PICK-FLEET-LOG-DEPTH ⚠C10 (C10-11 owns) | pick | P0 | correctness | XL | G1 | intake (§4) · **DONE in C10 (C10-11, Batch 709) — ledger row is the authority** |

### 1.2 `standing-reds` (cluster 2, 15 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-11` | NEW-HIGH-DENSITY-SPHERES-CROSS-BACKEND-DRIFT | standing-reds | P0 | correctness | unknown–M | G1 | W1 (diagnose) **RE-ATTRIBUTED 2026-08-07 (Batch 919, orchestrator machine lane): the scene-level cross-backend red was THE INSTRUMENT. high-density-5k-spheres-setup.js created its mulberry32 rng at MODULE scope and called addInstances(webglViewer) then addInstances(webgpuViewer) against the SAME stream — the WebGL viewer consumed draws 1..15000 and the WebGPU viewer 15001..30000, so the two backends NEVER rendered the same sphere set, by construction, since Batch 224. The header comment promised seed-identical positions; the code did not deliver them. One-line fix (re-seed per viewer): cross-backend diff collapsed 8.60% -> 1.48% PASS, and the residual is visually sphere-silhouette antialiasing rims on IDENTICAL geometry (PNG read). Remaining row scope: decide whether the 1.48% needs decomposition, and re-baseline this scene's history via C11-139 — every historical baseline from the disjoint-sample era is permanently invalid (91.78% vs both backends identically).** |
| `C11-12` | NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION | standing-reds | P0 | correctness | M | G1 | W2 |
| `C11-13` | NEW-VOXEL-INSIDE-CAMERA-BLACK | standing-reds | P0 | correctness | M | G1 (walkthrough G6) | **W1 — COMPLETE; IMPLEMENTED / LANDED Batch 1031 (`348063f48b`), PHYSICAL EDGE + KARMA + TEN-PROBE PRESERVATION ACCEPTED 2026-08-12; final acceptance repair `f54d58cdd4`.** **[T0 frozen-build run 2026-08-21 (T0_FROZEN_BUILD_PROGRAM_2026-08-21.md): physical probe PASS first-run green; focused Karma 10/10; battery 8/10 with both reds classified and owned (lane G clear fix / megatexture capture discriminator owed); offline gates 47/47 after Batch 1091. Row open on the two battery reds.]** |
| `C11-14` | NEW-WEBGL-ANISO-GLSL-BROKEN | standing-reds | P1 | correctness | S | G1 | W1 |
| `C11-15` | NEW-FEATURE-RENDERER-FAILED-STATE-RETRY | standing-reds | P1 | correctness | M | G1 | W1 |
| `C11-16` | NEW-WEBGPU-POINT-BLENDOPTION-SYNC | standing-reds | P1 | correctness | M | G1 | W1 (cheap rider) |
| `C11-17` | NEW-WEBGPU-CANVAS-BACKGROUND-COLOR-PARITY | standing-reds | P1 | parity | S | G1 | W1 (cheap rider) · **RATIFIED 2026-07-18: FIX (§7.0)** |
| `C11-18` | NEW-WEBGPU-OIT-DEFERRED-SPLAT-CANVAS-RESUME | standing-reds | P1 | correctness | S | G1 | W7 (blocked on C11-26 producer) |
| `C11-19` | BUG-GLOBE-PIPELINE-NAME-AXES | standing-reds | P1 | correctness | S | G1 | W1 |
| `C11-20` | C-R12-PER-OBJECT-CACHES | standing-reds | P1 | correctness | S | G1 | **W3 — PARTIAL; LANDED (Batch 778, 2026-08-01)** (Point/Label normal teardown fixed; nested/device-loss walk open) |
| `C11-21` | BACKLOG-§Material UBO field-name alignment audit | standing-reds | P1 | correctness | M | G1 | W3 |
| `C11-22` | NEW-WEBGPU-DEBUG-DEPTH-PLANE-GATE-PARITY | standing-reds | P2 | parity | S | G1 | W1 (cheap rider) |
| `C11-23` | NEW-WEBGPU-OIT-MSAA-RESOLVE-ORDERING | standing-reds | P2 | correctness | M | G1 | W7 (FAR-003 lane) |
| `C11-24` | NEW-WEBGPU-RENDERCOMMAND-STALE-PASS-SLOT | standing-reds | P2 | correctness | S | G1 | W1 |
| `C11-25` | OPEN-1-DIAGNOSE (sky-atmosphere compile) | standing-reds | P2 | correctness | unknown | G1 | W1 (verify-then-close) |

### 1.3 `splat` (cluster 3, 2 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-26` | NEW-WEBGPU-SPLAT-DATA-PRODUCER | splat | P1 | feature | L | G5 | W7 · **BLOCKED-ON-MAINTAINER** |
| `C11-IC-02` | C10-04-SPLAT-ASYNC-SORT ⚠C10 | splat | P2 | perf | M | G5 | intake (§4) · **C10 intake condition discharged (C10 closed Batch 711); still blocked on `C11-26` (maintainer)** |

### 1.4 `model-frontend` (cluster 4, 5 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-27` | C9-17-MODEL-SETTLED-FRONTEND-REVISIONS Slice D | model-frontend | P1 | perf | L | G4 | W6 (STOP-gated on checkpoint attribution) |
| `C11-28` | S9-2 — effects bind-group memoization | model-frontend | P1 | perf | S | G4 | W3 |
| `C11-29` | S9-3 — retained-command executor unification | model-frontend | P2 | perf | L | G4 | W6 (after C11-27) |
| `C11-30` | S9-4 — GPU-cull feed pooling | model-frontend | P2 | perf | S | G4 | W3 |
| `C11-31` | S11-1 remainder — WebGPUModelFeatureId batch-texture force-create | model-frontend | P2 | perf | S–M | G4 | W3 (after C10-02) |

### 1.5 `terrain-imagery` (cluster 5, 11 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-32` | C9-12-TERRAIN-STATIC-DYNAMIC-UPLOAD-SPLIT / FAR-303 | terrain-imagery | P1 | perf | XL | G2 | W6 (dedicated multi-batch family) |
| `C11-33` | C9-11-RETAINED-TERRAIN-DESCRIPTORS / FAR-309 (remainder) | terrain-imagery | P1 | perf | L–XL | G2 | W6 (C11-32 prereq) |
| `C11-34` | C9-15-TERRAIN-GPU-RESIDENCY-BUDGET / FAR-203 / FAR-208 | terrain-imagery | P1 | perf | L | G2 | W3 |
| `C11-35` | NEW-WEBGPU-OCEANNORMAL-PER-CALL-REUPLOAD | terrain-imagery | P1 | perf | S–M | G2 | W1 — **COMPLETE-BY-ALIAS of `C11-166`, Batch 717** (same register entry; §3.2 reconcile 2026-07-23) |
| `C11-36` | C-R1-GLOBE-RENDERSTATE | terrain-imagery | P1 | correctness | M | G2 | W3 |
| `C11-37` | S1-1 — WebGL-lane globe derived-command regen | terrain-imagery | P2 | perf | M | G2 | W3 (after C11-33) |
| `C11-38` | S6-3 — uniform-ring fan-out beyond terrain | terrain-imagery | P2 | perf | M | G2 | W6 (with C11-32 family) |
| `C11-39` | S5-4 — per-tile worker-computable scans | terrain-imagery | P2 | perf | S | G2 | W3 |
| `C11-40` | S3-3 — GlobeTerrain debug-sentinel stripping | terrain-imagery | P2 | perf | S | G2 | W3 |
| `C11-41` | Streamed-imagery never-shared prompt-retire verification lane (B686 F2a) | terrain-imagery | P2 | tooling | S–M | G2 | W1 |
| `C11-42` | DP-H19-SHADER-DECODE-RUNTIME | terrain-imagery | P2 | perf | M | G2 | W3 |

### 1.6 `attachment-topology` (cluster 6, 8 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-43` | C9-10-CONSUMER-DRIVEN-MRT / FAR-403-C0 | attachment-topology | P1 | perf | XL | G3 | W6 (P0 key-audit prereq) |
| `C11-44` | S4-2 / S4-3 / S4-4 — C9-35 MSAA containment remainder | attachment-topology | P1 | perf | M | G3 | W3 |
| `C11-45` | S7-2 — per-frustum fixed pass scaffold gating | attachment-topology | P1 | perf | M | G3 | W3 |
| `C11-46` | S2-5 — pass-reopen descriptor caching | attachment-topology | P2 | perf | S | G3 | W3 |
| `C11-47` | S7-5 — multi-frustum contract machinery | attachment-topology | P2 | perf | S | G3 | W3 |
| `C11-48` | Seed-10 cleanup wave — S6-6 / S6-4 / S4-6 / S4-7 | attachment-topology | P2 | perf (+2 bugs) | M | G3 | W3 |
| `C11-49` | Phase-8a / FEAT-GAP-01 — normal G-buffer + depth prepass | attachment-topology | P2 | infra | XL | G3 | W7 (maintainer-scoping gate) |
| `C11-50` | Phase-8a normal-G-buffer validation probe | attachment-topology | P2 | tooling | S | G3 | W3 (must precede C11-43 flip & C11-49) |

### 1.7 `rte-taa` (cluster 7, 7 items — NO dedicated cluster guide)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-51` | NEW-TAA-CUSTOM-FRUSTUM-JITTER-FALLBACK | rte-taa | P0 | correctness | S | — | W1 (crash-class) |
| `C11-52` | C9-24-RTE-PRODUCER-CONSUMER-INVENTORY / FAR-305 | rte-taa | P1 | correctness | M | — | W5 (R0 foundation) |
| `C11-53` | C9-25-PREVIOUS-FRAME-RTE / FAR-306 | rte-taa | P1 | correctness | L | — | W5 (dep C11-52) |
| `C11-54` | C9-26-GPU-VISIBILITY-RTE-CLOSURE | rte-taa | P1 | correctness | L | — | W5 |
| `C11-55` | NEW-TAA-MULTIFRUSTUM-DEPTH-REPROJECTION-CONTRACT / C9-29 | rte-taa | P1 | correctness | L | — | W5 |
| `C11-56` | TAA-DESIGN Slices 2b+3 | rte-taa | P2 | parity | L | — | W5 |
| `C11-57` | TAA-DESIGN Slice 4 | rte-taa | P2 | correctness | L | — | W5 (dep C11-56) |

### 1.8 `frame-delta` (cluster 8, 7 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-58` | S1-3 — globe-height plumbing rebuild | frame-delta | P1 | perf | M | G4 | W3 |
| `C11-59` | S1-5 / S7-6 — 2D/CV/ortho band economics | frame-delta | P2 | perf | M | G4 | W3 |
| `C11-60` | S2-2 / S2-3 / S2-4 — cache-hit-path allocation riders | frame-delta | P2 | perf | S | G4 | W3 · **PARTIAL — two slices landed Batches 1019/1022; ledger row is the authority** |
| `C11-61` | NEW-CLUSTERED-ENABLED-ZERO-LIGHT-FRAME-ZERO-WORK | frame-delta | P2 | perf | S | G4 | W3 · **LANDED-PARTIAL Batch 1124 — ledger row is the authority** |
| `C11-62` | C9-08 octree persistence / NEW-SCENEOCTREE-DIRTY-REVISION-REBUILD-AND-PVS-PROMOTION — **PARTIAL: clauses (a) and (c) LANDED Batch 1133; clause (b) NOT closed — ruled `R-2026-08-24-15`.** The first case-E run (2026-08-24) exercised the rebuild-skip counters and the off/on/restored byte identity, and found an engine defect. WebGL behaved as designed — a second frame over an unchanged scene skipped the rebuild (`rebuilds` 1, `rebuildSkips` 1, `commandsInserted` 0), off/on/restored byte-identical. WebGPU could not skip at all: the dirty revision was keyed on every command in `frameState.commandList` while the tree indexes only OPAQUE/TRANSLUCENT commands, and the WebGPU globe allocates a fresh command object per tile per frame (`GlobeSurfaceTileProviderRendering.js` ~1322-1389, pushed ~1466; WebGL pools at ~1758), so the revision bumped every frame. Batch 1149 scopes the revision to the commands the tree indexes and recomputes the bypass partition on every frame including skip frames — the ineligible half carries per-frame WebGPU pipeline/bind-group state and must never be republished from cache — and makes a scan authorize exactly one build; the below-threshold path keeps its O(1) shape. The probe's case-E stability precondition, which had the same full-list scope and so was unsatisfiable on WebGPU (`stableFrames` 0 vs WebGL 2), is rescoped to the indexed subsequence and now names the churning command; case B's `materialAllocatorCount>0` is made keyability-aware (WebGPU globe commands carry no `materialSortId` and expose `_pipeline`, so a frame of only globe commands legitimately keys nothing — STRUCTURAL, not FAIL) and now asserts that commands were observed at all. Station-3 full + delta reviews: O(1) below-threshold path proven over 5,000 frames, five mutants RA–RE all killed, engine-project tsc green in main. **Neither backend has yet produced the ledger's clause-(b) comparison against ordinary Scene PVS on the moving multi-altitude route; case E does not measure it, and `R-2026-08-24-15` keeps the ledger clause — the row stays OPEN until a timed octree-versus-PVS instrument over the canonical moving-altitude route is built and run** (plus the owed machine-lane re-run of case E on a refreshed bundle in both backends). The octree stays opt-in and is never auto-promoted. | frame-delta | P2 | perf | M | G4 | W3 |
| `C11-63` | C10-10 follow-up — revision-maintained shadow-caster sublist | frame-delta | P2 | perf | M | G4 | W6 (blocked on S1-6 tier `C11-SEED-23`) |
| `C11-SEED-01` | WebGL near-ground seg5 p99 GC-tail (no ID) | frame-delta | P3 | perf | unknown | G4 | seed |

### 1.9 `entity-scale` (cluster 9, 12 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-SEED-02` | Entity-at-scale arc (S10 umbrella) | entity-scale | P1 | perf | XL | G7 | seed (arc; members below) |
| `C11-64` | 10k-entity benchmark lane (§14 seed 3 prerequisite) | entity-scale | P1 | tooling | S | G7 | W7 (FIRST in the S10 arc) |
| `C11-65` | S10-1 — dynamic-entity fallback lane (supersedes S1-4) | entity-scale | P1 | perf | L | G7 | W7 (dep C11-64) |
| `C11-66` | S10-2 / S10-3 — clustering forfeits bulk lane + declutter rebuild | entity-scale | P1 | perf | L | G7 | W7 (dep C11-64) |
| `C11-67` | S10-4 — GeometryUpdaterSet lazy instantiation | entity-scale | P2 | perf | M | G7 | W7 |
| `C11-68` | S10-5 — collection define-scan gating | entity-scale | P2 | perf | S | G7 | W7 |
| `C11-69` | S10-6 — pick instance repack + visibility-flip structural rebuild | entity-scale | P2 | perf | M | G7 | W7 (after FAR-107 `C11-07`) |
| `C11-70` | S10-7 / S10-8 — geometry/path incremental batching | entity-scale | P2 | perf | L | G7 | W7 |
| `C11-71` | S10-9 — ModelVisualizer static lane | entity-scale | P2 | perf | S | G7 | W7 |
| `C11-72` | S2-1 — collection resolver-closure churn | entity-scale | P2 | perf | S | G7 | W3 (scope vs C9-27) |
| `C11-73` | FAR-307-POLYLINE-PERSISTENT-MATERIAL-TABLE | entity-scale | P2 | perf | L | G7 | W7 |
| `C11-74` | PARITY-POINT-SPRITE-SHAPE-RESIDUALS | entity-scale | P2 | parity | M | G7 | W7 |

### 1.10 `submit-residency` (cluster 10, 4 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-75` | FAR-200-S1-PHYSICAL-QUEUE-TIMELINE | submit-residency | P1 | infra | M | G2 | W3 (sanctioned pre-Gate-B shadow) |
| `C11-76` | FAR-200 private-submit-timeline consolidation [PR S6-7/S6-5] | submit-residency | P1 | infra/perf | M–L | G2 | W3 (moves BEFORE C11-75 authority) |
| `C11-77` | Geometry-residency dedupe [PR S11-3; arch-seed A7] | submit-residency | P1 | perf | L | G2/G10 | W6 (gated on typedArray-release policy) |
| `C11-78` | NEW-PICK-ID-OWNERSHIP-MODEL | submit-residency | P2 | perf | M | G2 | W2 (pick family) |

### 1.11 `celestial-env` (cluster 11, 2 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-79` | NEW-WEBGPU-CELESTIAL-RETAINED-RESOURCES | celestial-env | P1 | perf | S–M | G7 | W1 (cheap rider) ⚠ **TRANSFERRED to C12 (LD-1, 2026-07-23) — ID retained as alias; C12 is the status authority for this row.** *(Stamped 2026-08-09, handover audit FIX 21 — §3.2 already carried the alias marker while this §1 cell did not.)* |
| `C11-80` | NEW-WEBGPU-STARFIELD-SINGLE-SUBMISSION | celestial-env | P1 | correctness | M | G7 | W1 (instrument first; C11-80 before C11-79 retains star cmds) ⚠ **TRANSFERRED to C12 (LD-1, 2026-07-23) — ID retained as alias; C12 is the status authority for this row.** *(Stamped 2026-08-09, handover audit FIX 21 — §3.2 already carried the alias marker while this §1 cell did not.)* |

### 1.12 `tiles-model-parity` (cluster 12, 21 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-81` | TILE-ARCH-SHADER-STRATEGY | tiles-model-parity | P1 | parity | L | G5 | W4 (define-width dependent) |
| `C11-82` | C-R1-TILE-BATCH | tiles-model-parity | P1 | parity | M | G5 | W7 |
| `C11-83` | WIRE-MODEL-COLOR-ALPHA-SEMANTICS | tiles-model-parity | P1 | parity | M | G5 | W7 |
| `C11-84` | FEAT-3DT2-02 — property-texture/feature-ID WGSL sampling audit | tiles-model-parity | P2 | parity | M | G5 | W7 |
| `C11-85` | FEAT-3DT2-05 — Draco/KTX2/meshopt end-to-end audit | tiles-model-parity | P2 | parity/tooling | M | G5 | W7 |
| `C11-86` | FEAT-3DT2-01 — styling expression → WGSL compiler | tiles-model-parity | P2 | parity/perf | L | G5 | W7 |
| `C11-87` | Phase-8a Tile↔Hi-Z wiring | tiles-model-parity | P2 | perf | M | G5 | W7 |
| `C11-88` | KHR_materials_variants / IOR / clearcoat-IOR coupling | tiles-model-parity | P2 | parity | M | G5 | W7 (after C10-08) |
| `C11-89` | 5 default textures bound per model draw | tiles-model-parity | P2 | perf | S | G5 | W4 (after C10-08 axes) |
| `C11-90` | GLTF-POINTS-MODE-RESIDUALS / GLTF-PRIMITIVE-MODE-RESIDUALS | tiles-model-parity | P1 | correctness/parity | M | G5 | **IMPLEMENTED — BROWSER GATE OPEN.** Model-path topology realization landed as one enforceable home (`Renderer/WebGPU/WebGPUModelTopology.ts`): exhaustive 7-mode table, LINE_LOOP closure, TRIANGLE_FAN expansion, native line-list/line-strip/triangle-strip with exact `stripIndexFormat`, restart-capable-only uint8 `0xFF`→`0xFFFF` translation, non-indexed synthesis for every mode but TRIANGLES, and topology+format threaded through all 12 model pipeline builders, the capture records, and the shadow/CSM cast key + descriptor. Triangle-list keys byte-identical. Contract `Tools/visual-regression/model-primitive-topology.spec.mjs` 37/37; both tsc green. **Still open:** rendered-pixel verification on both backends for the five modes (probe checklist below), non-indexed TRIANGLES synthesis (residual 1), and the generic-`Primitive` duplicate (residual 6). **UPDATE 2026-08-07 (close-out docs reconciliation) — the LINE FAMILY IS DISCHARGED AT PIXELS (Batch 799, `5832161cfb`), which this cell never recorded.** On the shipped upstream `KHR_mesh_primitive_restart` assets, **line-strip uint16, the uint16-vs-uint32 ALIASING PAIR, and line-loop closure all render at 1.006-1.012 cross-backend lit-pixel parity with zero console errors**; `model-primitive-topology.spec.mjs` is 37/37 with its fixtures decoded from those same shipped assets and its restart-capable set read out of `getMeshPrimitives`' own switch so the table cannot drift. **Still open, unchanged and deliberately so:** (a) the **strips/fans visual** — the two triangle assets read ~3 lit px on BOTH backends across three pitches, attributed to a WebGL-reference framing/material artifact rather than a WebGPU divergence, so the owed evidence is the Sandcastle side-by-side demo, not a re-run; (b) **non-indexed TRIANGLES synthesis** (residual 1); (c) the **generic-`Primitive` duplicate** (residual 6). **[T0 run 2026-08-21: browser gate PASS after the Batch-1088 harness repair (first run ever to reach the line); topology, shape, and recovery green on both backends. See T0_FROZEN_BUILD_PROGRAM_2026-08-21.md.]** |
| `C11-91` | WIRE-MODEL-SILHOUETTE-TRANSLUCENT-DIVERGENCE | tiles-model-parity | P2 | parity | S–M | G5 | **RESOLVED-direction 2026-07-18 (replicate WebGL body-wash); re-scoped 2026-07-19 → `C11-157` Slice D.** Model OIT reachability (C11-157 Slice C) LANDED, but the silhouette body-wash is design-heavy (its own stencil/pass machinery, NOT a ride-along) — DEFERRED as Slice D with a recommended approach recorded in `DEFERRED_WORK.md` (`NEW-WEBGPU-OIT-TRANSLUCENT-PRIMITIVE-WIRING` → Slice D). The Slice-C `getOITColorConfig` machinery is ready for it. |
| `C11-92` | NEW-MODEL-WGSL-CUSTOM-SHADER (Q31 Slice C varyings) | tiles-model-parity | P2 | parity | L | G5 | W4 · **`C11-149` blocker DISCHARGED — landed Batch 739 (`bf7b20c6d3`)** |
| `C11-93` | NEW-MODEL-SCENE2D-IDL-DUPLICATE | tiles-model-parity | P2 | parity | M | G5 | W7 |
| `C11-94` | BACKLOG-§4.6 — indirect drawing for 3D Tiles | tiles-model-parity | P2 | perf | L | G5 | W7 (after C11-27/C11-29) |
| `C11-95` | R-7a — render-bundle expansion to 3D Tiles opaque models | tiles-model-parity | P2 | perf | M | G5 | W7 (behind C11-27/C11-29) |
| `C11-96` | TILE-PERF-02 — KTX2 transcode on a worker | tiles-model-parity | P2 | perf | M | G5 | W7 |
| `C11-97` | TILE-WASM-01 — WASM SIMD tile traversal | tiles-model-parity | P2 | perf | L | G5 | W7 |
| `C11-98` | FORK-41 — PointCloudSort + GPUSortKeys consumers | tiles-model-parity | P2 | perf | M | G5 | W7 |
| `C11-99` | FEAT-SURVEY-06 — decoupled-lookback prefix-sum consumers | tiles-model-parity | P2 | perf | M | G5 | W7 |
| `C11-SEED-03` | Phase-8b TileStoreGPU | tiles-model-parity | P3 | perf | XL | G5 | seed |
| `C11-SEED-04` | BACKLOG-§8 GPUExternalTexture | tiles-model-parity | P3 | perf | M | G5 | seed |

### 1.13 `classification-voxel` (cluster 13, 9 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-100` | PARITY-VOXEL-OCTREE-TRAVERSAL | classification-voxel | P1 | parity | XL | G6 | W7 (sliced; A2-slice-0 triage first) · **PARTIAL — ledger row is the authority** |
| `C11-101` | NEW-CLASSIFIER-2D-CV-MORPH | classification-voxel | P1 | parity | L | G6 | W7 (.vctr fixture prereq) |
| `C11-102` | NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION | classification-voxel | P1 | correctness | M (maybe S) | G6 | W7 (re-verify first) |
| `C11-103` | C-R9-VOXEL-CELL-PICK-TAIL | classification-voxel | P1 | parity | S | G6 | W7 (premise-stale: re-scope) |
| `C11-104` | C-R1-CLASSIFICATION | classification-voxel | P1 | parity | M | G6 | W7 |
| `C11-105` | NEW-GS-CLASSIFICATION-DEPTH | classification-voxel | P2 | parity | M | G6 | W7 (blocked on C11-26 producer) |
| `C11-106` | C-R8-VECTOR-3DTILE-CLAMPED-POLYLINES | classification-voxel | P2 | parity | M | G6 | W7 |
| `C11-107` | ADR-2026-04-28 (incl. C-R8-TRANSLUCENT-MULTI-FRUSTUM) | classification-voxel | P2 | infra | L | G6 | W7 (after C11-104) |
| `C11-108` | VOXEL-USER-CUSTOMSHADER-RESIDUALS | classification-voxel | P2 | parity | M | G6 | W7 |

### 1.14 `shadows-lighting` (cluster 14, 5 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-109` | SHADOW-LAYOUT-QUANTIZED | shadows-lighting | P1 | correctness | S | G8 | W1 (premise-reconcile; likely doc-close) |
| `C11-110` | CSM-DESIGN Slices 3-4 | shadows-lighting | P2 | parity | L | G8 | W7 |
| `C11-111` | C-R10-GLOBE-POINT-LIGHT | shadows-lighting | P2 | parity | M | G8 | W7 (premise-reconciled W1) |
| `C11-112` | C6-LTC-AREA-LIGHTS follow-ups | shadows-lighting | P2 | feature | M | G8 | W7 |
| `C11-SEED-05` | FEAT-GAP-06 — bent-normal AO (terrain) | shadows-lighting | P3 | feature | M | G8 | seed (behind FEAT-GAP-01) |

### 1.15 `atmosphere-sky` (cluster 15, 6 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-113` | C9-14B-ATMOSPHERE-LUT-CONSUMPTION | atmosphere-sky | P1 | perf | M | G8 | W7 (gated on checkpoint attribution; premise-reconciled W1) |
| `C11-114` | C6-HIGHER-ORDER-SCATTER-LUT (reframed diagnostic) | atmosphere-sky | P2 | correctness | S | G8 | W7 |
| `C11-115` | NS-SUN-BLEND-MODE-DIVERGENCE | atmosphere-sky | P2 | parity | M | G8 | W7 · **RESOLVED 2026-07-18: WebGPU ALPHA_BLEND (match WebGL) (§7.0)** ⚠ **TRANSFERRED to C12 (LD-1, 2026-07-23) — ID retained as alias; C12 is the status authority for this row.** *(Stamped 2026-08-09, handover audit FIX 21 — §3.2 already carried the alias marker while this §1 cell did not.)* |
| `C11-116` | NS-SURFACE-SKYATMOSPHERE-NIGHT-BRIGHT | atmosphere-sky | P2 | parity | unknown | G8 | W7 |
| `C11-SEED-06` | FUT-MULTI-BODY-ATMOSPHERE | atmosphere-sky | P3 | feature | M–L | G8 | seed |
| `C11-SEED-07` | NEW-SUN-MOON-FIDELITY | atmosphere-sky | P3 | feature | M | G8 | seed · **FOLDED into `C11-179` — ledger row is the authority** |

### 1.16 `postprocess-effects` (cluster 16, 9 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-117` | C9-23-EFFECT-EXECUTION-AUDIT / FAR-500-C0 | postprocess-effects | P1 | correctness | M | G6 | W7 (Wave-3 visibility gateway; open first in cluster) |
| `C11-118` | WIRE-PP-LIBRARY-BUILTINS-RESIDUALS | postprocess-effects | P2 | parity | M | G6 | W7 |
| `C11-119` | NEW-PLAIN-HDR-SCENE-GAMMA-EPIC residual | postprocess-effects | P2 | parity | M | G6 | W7 |
| `C11-120` | C6-SSGI-DIFFUSE follow-ups | postprocess-effects | P2 | feature | M | G6 | W7 |
| `C11-121` | NEW-PP-F16-DEVICE-VERIFY | postprocess-effects | P2 | tooling | S | G6 | W7 (physical adapter; ties to C11-135) |
| `C11-122` | WGF-1-EXPAND — hardware clip-distances beyond globe | postprocess-effects | P2 | perf | M | G6 | W7 |
| `C11-123` | WGF-1-INTERSECTION — intersection-mode clipping | postprocess-effects | P2 | parity | M | G6 | W7 |
| `C11-SEED-08` | WGF-4 (+WGF-4-EXPAND) — standard-layout UBOs + RTE packer assertions | postprocess-effects | P3 | perf | M | G6 | seed |
| `C11-SEED-09` | C6-FSR2-UPSCALE | postprocess-effects | P3 | perf | XL | G6 | seed · maintainer GO |

### 1.17 `clouds-weather` (cluster 17, 16 items — transferred to Campaign 13)

The dedicated legacy intake guide is
`campaign11_planning/guides/G12-clouds-weather.md`. Campaign 13 supersedes it for execution, while
this table preserves the original canonical aliases and history. **Execution override: every row in
this section is a historical alias, not C11 work. Never dispatch it from W7 or any C11 wave.** Use
the mapped C13 ID and Campaign 13's current status table instead.

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-124` | C7-CLOUD-LIGHTNING (reland = C9 W7-1) | clouds-weather | P2 | feature | M | — | **HISTORICAL ALIAS ONLY → `C13-25`** (original C11 wave: W7) |
| `C11-125` | C6-CLOUD-STBN-TAAU | clouds-weather | P2 | feature | M | — | **HISTORICAL ALIAS ONLY → `C13-09..12`** (PARTIAL at transfer; original C11 wave: W7) |
| `C11-126` | CLOUD-U4-REMOVE-GLOBE-FLAG | clouds-weather | P2 | infra | L | — | **HISTORICAL ALIAS ONLY → `C13-00`; COMPLETE before C13** (original C11 wave: W7; option A resolved §7.0) |
| `C11-127` | Q36-WEATHER-PHASE-4-GRIB2 | clouds-weather | P2 | feature | L | — | **HISTORICAL ALIAS ONLY → `C13-26`** (proxy/decoder/fixture blocked; original C11 wave: W7) |
| `C11-128` | Live EDR network confirm | clouds-weather | P2 | tooling | S | — | **HISTORICAL ALIAS ONLY → `C13-27`** (environment-blocked; original C11 wave: W7) |
| `C11-129` | WeatherSystem / scene.weather facade (Phase 3) | clouds-weather | P2 | feature | M | — | **HISTORICAL ALIAS ONLY → `C13-24`** (original C11 wave: W7) |
| `C11-130` | PRECIP-DATA ground snow-albedo shader consumer | clouds-weather | P2 | feature | S | — | **HISTORICAL ALIAS ONLY → `C13-28`** (original C11 wave: W7) |
| `C11-SEED-10` | C7-CLOUD-IMPOSTOR-LOD | clouds-weather | P3 | perf | L | — | seed (dep CLOUD-U4) |
| `C11-SEED-11` | CLOUD-LOD-R8-PRECIPITATION-COUPLING | clouds-weather | P3 | feature | L | — | seed |
| `C11-SEED-12` | CLOUD-LOD-R9-PLANET-SCALE-CLOUD-TILING | clouds-weather | P3 | feature | XL | — | seed |
| `C11-SEED-13` | CLOUD-EXOTIC-E3-SPECIAL remainder | clouds-weather | P3 | feature | L | — | seed |
| `C11-SEED-14` | Cloud perf — Tier-2 3D bake (view-local cascaded clipmap) | clouds-weather | P3 | perf | XL | — | seed |
| `C11-SEED-15` | Temporal interpolation + advection (Phase 5) | clouds-weather | P3 | feature | M | — | seed |
| `C11-SEED-16` | Historical-replay headline demo (Phase 4) | clouds-weather | P3 | feature | M | — | seed (gated on C11-127) |
| `C11-SEED-17` | profileExtinction (slot 103) per-position optical extinction | clouds-weather | P3 | feature | M | — | seed |
| `C11-SEED-18` | NEW-CLOUD-SHADOW-ENVMAP | clouds-weather | P3 | feature | S | — | seed |

### 1.18 `water` (cluster 18, 2 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-131` | C6-PLANAR-REFLECT-REFRACT | water | P2 | feature | L | G8 | W7 (after C10-08b/reversed-Z disposition) |
| `C11-SEED-19` | WATER-PHASES-1-9 (Gerstner/bathymetry/foam/rivers/underwater/WaterRegion) | water | P3 | feature | XL | G8 | seed |

### 1.19 `gated-reversed-z` (cluster 19, 3 items — gated tail, §6)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-GT-01` | C10-13-REVERSED-Z-EARLYZ-SPIKE ⚠C10 | gated-reversed-z | P1 | perf/tooling | S | G10 | **W1 spike EXECUTED — NO-GO, Batch 717 (`a0ca50bea7`)**; gate CLOSED (§6) |
| `C11-GT-02` | C10-GT-REVERSED-Z-SLICE-B ⚠C10 | gated-reversed-z | P2 | perf | XL | G10 | GT (do not schedule) · **gate CLOSED by the `C11-GT-01` NO-GO, Batch 717** |
| `C11-GT-03` | C10-03R-MSAA-DEFAULT-FLIP-RESERVE ⚠C10 | gated-reversed-z | P3 | perf | S | G10 | GT (reserve lever) · **the `C11-GT-01` spike returned NO-GO Batch 717; reserve unexercised** |

### 1.20 `test-infra` (cluster 20, 16 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-132` | NEW-WORKSPACE-SPEC-BUNDLE-FRESHNESS (item 4A / A.2) | test-infra | P1 | tooling | S | G9 | W1 (environment prereq) · **CODE LANDED Batch 903; engine round-trip OWED — ledger row is the authority** |
| `C11-133` | Karma headless-Edge launcher environmental flakiness (A.1) | test-infra | P1 | tooling | unknown | G9 | **W1 — COMPLETE; IMPLEMENTED / VERIFIED / LANDED Batch 1018 (2026-08-11)** (environment prerequisite discharged) |
| `C11-134` | NEW-FULL-SUITE-OFFLINE-DEPENDENCY-ISOLATION (A.3) | test-infra | P1 | tooling | M | G9 | W1 (environment prereq) · **CODE LANDED Batch 903; offline leg green, online lane OWED — ledger row is the authority** |
| `C11-135` | C9-04-PHYSICAL-ADAPTER-CONTRACT-MATRIX (A.4) | test-infra | P1 | tooling | L | G9 | W7 (after C11-133) |
| `C11-136` | NEW-SCENE-BROAD-SUITE-FAILURE-CLOSURE (item 64 / A.5) | test-infra | P1 | correctness | L | G9 | W7 (exit-gate owner) |
| `C11-137` | C8-SHARED-UPSTREAM-CONTRACT-GATE (item 72 / A.16) | test-infra | P1 | infra/tooling | L | G9 | **EXIT (dead last)** |
| `C11-138` | NEW-SHADER-GENERATOR-UPSTREAM-CONTRACT-PARITY (item 66 / A.6) | test-infra | P1 | correctness | S | G9 | W7 (exit-gate owner; cheapest) |
| `C11-139` | C9-03-CERTIFYING-VISUAL-BASELINE-PROMOTION | test-infra | P1 | tooling | M | G9 | W7 (after C11-11 spheres repaired) **UNBLOCKED 2026-08-07 (Batch 919): the spheres red it waited on is repaired (instrument re-attribution). Its scope now includes re-capturing the spheres scene's baselines, which the disjoint-sample era invalidated.** |
| `C11-140` | NEW-GPU-TIMESTAMP-UNIQUE-SAMPLE-ACCOUNTING (A.11) | test-infra | P1 | tooling | S | G9 | **W1 — LOCAL MACHINE-CERTIFIED; probe fix + artifact landing owed — NOT COMPLETE** **[Landed Batch 1074 `d36a835b82`, 2026-08-20; the fresh-bundle route rerun ran tonight in the machine lane — exit 0, clean gates]** (perf-claim prereq tooling) |
| `C11-141` | C9-02-VISIBILITY-EXECUTION-OWNERSHIP-MANIFEST | test-infra | P1 | correctness | L | G9 | W7 |
| `C11-142` | NEW-RESOURCE-URL-SEMANTIC-PARITY (item 67 / A.7) | test-infra | P2 | correctness | L | G9 | W7 (exit-gate owner) |
| `C11-143` | NEW-ENTITY-BULK-CLUSTER-TRANSITION-PARITY (item 69 / A.8) | test-infra | P2 | correctness | M | G9 | W7 (exit-gate owner) |
| `C11-144` | NEW-KMZ-ARCHIVE-URI-RESOLUTION-PARITY (item 70 / A.9) | test-infra | P2 | correctness | L | G9 | W7 (exit-gate owner; after C11-133) |
| `C11-145` | C9-01-REGRESSION-ATTRIBUTION remainder (Gate-A closure) | test-infra | P2 | tooling | S | G9 | W7 · maintainer amendment |
| `C11-146` | S8-7 — settle-window attribution rule + first-complete-frame metric (A.14) | test-infra | P2 | tooling | S | G9 | W1 (perf-claim prereq tooling) **[T0 route run 2026-08-21: THE METRIC FIRES - both legs detected/stable-3/trace-agree with real lags recorded (WebGL frame 23 ~252.6 ms, WebGPU frame 7 ~1409.1 ms; settle window 879.5 ms attributed). Run banked RED (first red) on two harness-tier gates - sandboxed about:blank console noise and non-clone-portable provenance path identity; instrument repairs filed; row not declared green. See T0_FROZEN_BUILD_PROGRAM_2026-08-21.md.]** |
| `C11-147` | probe-hdr-pp-math gate F baseline refresh (A.15) | test-infra | P2 | tooling | S | G9 | W7 (after globe/HDR pixels settle) |

### 1.21 `build-boot` (cluster 21, 13 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-148` | NEW-MATERIAL-PER-BACKEND-SHADER-SOURCE | build-boot | P1 | infra | M | G9 | W4 |
| `C11-149` | C10-08b — ShaderDefine define-width expansion ⚠C10 (follows C10-08) | build-boot | P1 | infra | M | G9 | **W1 (early — C10-08 landed at C10 close, unblocks `C11-158` enhanced-ocean toggle)** · **HARD PREREQ for any new define bit** · **UPDATE 2026-08-07 (close-out docs reconciliation): LANDED at Batch 739 (`bf7b20c6d3`) — the prerequisite is DISCHARGED. See the dedicated `C11-149` row in §3.2.** |
| `C11-150` | S8-5 / S3-7 — WGSL module granularity + globe imagery layout tranches | build-boot | P2 | perf | L | G9 | W4 (after C10-07) |
| `C11-151` | NEW-WGSL-STRING-COMMENT-STRIP | build-boot | P2 | perf | S | G9 | W4 · **LANDED Batch 1125 — ledger row is the authority** |
| `C11-152` | NEW-EMPTYMODULE-STUB-HARDENING | build-boot | P2 | infra | S | G9 | W4 (prereq for leaf-strip seed) · **LANDED Batch 1125 — ledger row is the authority** |
| `C11-153` | S8-4 — feature-renderer registration lazify ⚠C10-06 rider | build-boot | P2 | perf | S | G9 | W4 · **intake condition DISCHARGED — C10-06 landed Batch 702; C10 closed Batch 711** |
| `C11-154` | NEW-TS-CONVERT-JS-RENDERERS | build-boot | P2 | infra | XL | G9 | W4+ (one renderer/batch; WebGPUModelRenderer already .ts — strike) |
| `C11-155` | Q35-WEBGPUCONTEXT-DECOMP-REMAINDER | build-boot | P2 | infra | M | G9 | W4 |
| `C11-156` | BACKLOG-§Recent — WebGPUComputePipelineCache (re-scope: cache EXISTS → route consumers) | build-boot | P2 | perf | S | G9 | W1 (premise-reconcile) / W3 (route) |
| `C11-SEED-20` | NEW-WEBGPUONLY-RENDERER-LEAF-STRIP | build-boot | P3 | infra | S | G9 | seed (dep C11-152) |
| `C11-SEED-21` | NEW-C9-01-COUNTER-PRAGMA-STRIP | build-boot | P3 | tooling | S | G9 | seed |
| `C11-SEED-22` | C6-SUBGROUP-COMPUTE-FINISH | build-boot | P3 | perf | S | G9 | seed (needs sort consumers) |
| `C11-IC-03` | C10-00-ENGINE-HANDOFF-AND-SCRIPT-GEN ⚠C10 | build-boot | P3 | infra | S | G10 | intake → folds into `C11-00` · **C10 closed Batch 711** |

### 1.22 `arch-seeds` (cluster 22, 4 items — all next-campaign seeds)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-SEED-23` | S1-6 — frame-delta retained-commandList tier | arch-seeds | P1 | perf | XL | G10/G4 | seed (unblocks C11-63, S1-1) |
| `C11-SEED-24` | Worker-renderer productization [PR S5-3] | arch-seeds | P2 | infra | XL | G10 | seed (benchmark lane first) |
| `C11-SEED-25` | S5-2 — WASM acceleration layer consume-or-retire | arch-seeds | P2 | perf | M | G10 | seed (per-bridge disposition) |
| `C11-SEED-26` | NEW-VEGETATION-SYSTEM | arch-seeds | P3 | feature | XL | G10 | seed |

### 1.23 Campaign-11 launch-reorder appends (2026-07-18, `C11-00B` sweep — APPEND-ONLY, collision-verified)

Minted by the `C11-00B` fallout-intake + launch-reorder sweep (2026-07-18). **Append-only additions**
starting at `C11-157` (the numbered range `C11-01..156` was NOT renumbered or reused; `C11-SEED-27`
follows `C11-SEED-26`). Every ID below was checked against §1.0–§1.22 and the GT/SEED/IC suffix ranges —
**no collision** (§1.24 addendum). Items that ALREADY carry a register number are NOT re-minted here;
their ratified direction is recorded IN PLACE — background-color `C11-17`, silhouette body-wash `C11-91`,
sun-blend `C11-115` (see §7.0). Every alias below is preserved verbatim from its DEFERRED_WORK / matrix
row (`NEW-WEBGPU-OIT-TRANSLUCENT-PRIMITIVE-WIRING` + `NEW-WEBGPU-DETERMINISTIC-SYNC-PIPELINE-
CENTRALIZATION` are pre-filed DEFERRED_WORK entries dated 2026-07-18 that were awaiting a C11 number).

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-157` | NEW-WEBGPU-OIT-TRANSLUCENT-PRIMITIVE-WIRING [Batch-700 fallout; FULL primitive→collection→model; **absorbs the `C11-91` silhouette body-wash resolution**] | standing-reds (FAR-003 OIT lane) | P1 | feature/correctness | L–XL | G1/G3 | **W1 (TOP) — COMPLETE (Slices A+B+C); ledger row is the authority** |
| `C11-158` | NEW-WEBGPU-ENHANCED-OCEAN-DEFAULT-PARITY-TOGGLE [defaults-parity D1; `ENHANCED_OCEAN` define-gate; default classic water, enhancement opt-in] | water | P1 | parity/infra | M–L | G8 | **COMPLETE — Batch 746; the `C11-149` predecessor also landed (Batch 739); ledger row is the authority** |
| `C11-159` | NEW-WEBGPU-NIGHTLIGHTS-DEFAULT-OFF-PARITY [matrix row 17; default OFF, keep opt-in toggle] | atmosphere-sky | P2 | parity | S | G8 | W1 (cheap rider) **UNBLOCKED 2026-08-07 (Batch 913 / CLT-B2): the ratified default-OFF-keep-the-toggle was VACUOUS before this — enableNightLights=false aliased onto the default-ON sentinel, so there was no reachable off state to default to. The toggle now has one (zero emission, spec-pinned); the shipped default (ON, 2.5) is untouched, so flipping the default remains this row's own deliberate decision.** **[Landed Batch 1076 `01dfc84e73`, 2026-08-20: default flipped to `false`, toggle kept; the shipped source default is spec-pinned (mutation-verified) and matrix row 17 is stamped. Night-ocean sentinel unchanged 17/17.]** |
| `C11-160` | NEW-WEBGPU-SUNBLOOM-PP-WIRING [matrix row 3; wire `scene.sunBloom` → WebGPU PP Bloom/LensFlare] | postprocess-effects | P2 | parity | M | G6/G8 | W7 (after `C11-117`; mid-campaign intent) ⚠ **TRANSFERRED to C12 (LD-1, 2026-07-23) — ID retained as alias; C12 is the status authority for this row.** *(Stamped 2026-08-09, handover audit FIX 21 — §3.2 already carried the alias marker while this §1 cell did not.)* |
| `C11-161` | NEW-WEBGPU-AUTOEXPOSURE-DEMAND-GATE [matrix row 14; demand-gate the dispatch + ratify HDR altitude-gate] | postprocess-effects | P2 | perf/parity | S | G6/G8 | W7 (after `C11-117` consumer inventory) ⚠ **TRANSFERRED to C12 (LD-1, 2026-07-23) — ID retained as alias; C12 is the status authority for this row.** *(Stamped 2026-08-09, handover audit FIX 21 — §3.2 already carried the alias marker while this §1 cell did not.)* |
| `C11-162` | NEW-WEBGPU-USEPOSTPROCESSSELECTED-PORT [matrix row 19; port the selected-feature path] | postprocess-effects | P2 | correctness | M | G6 | W7 |
| `C11-163` | C11-CELESTIAL-WATER-REFLECTION [unified sun-by-day + moon/stars-by-night reflection on water + clouds; runtime UBO enable-float — **NO new define bit, NO `C11-149` dep**; cheap path does NOT touch depth (**NOT reversed-Z-coupled**); S0 day-sun-glint audit/unify front-of-line] | water (celestial-water lane) | P2 | feature | L–XL | G8 + `CELESTIAL_WATER_REFLECTION_RESEARCH.md` | **Tier-4 / gated** (opt-in default-OFF, byte-identical off) |
| `C11-164` | NEW-WEBGPU-PICK-COLD-SYNC-STALENESS [C10-11 fallout — **cold-page async-pick-readback RACE**; reopens the June-361 docs-only close, distinct live-race defect] | pick | P1 | correctness | M | G1 | W2 (pick fleet) |
| `C11-165` | NEW-WEBGPU-DETERMINISTIC-SYNC-PIPELINE-CENTRALIZATION [C10-07 follow-on; pre-filed DEFERRED_WORK 2026-07-18] | build-boot | P2 | infra | M | G9 | W4 (boot chain) |
| `C11-SEED-27` | C10-30 clean-environment r5 re-measure (Gate-D reference — C10-30 wall-clock was env-confounded at close; deterministic **−33% render-passes/frame** recorded, no banner) | — | R0 | tooling/measurement | S | G10/G9 | seed (Gate-D anchor input) |

**Append accounting:** +9 numbered (`C11-157..165`) + 1 seed (`C11-SEED-27`) = **10 new rows**, all
collision-free. Three ratified directions land on EXISTING rows (no new ID): `C11-17`, `C11-91`,
`C11-115`. The B699 shared-cause diagnosis + `NEW-WEBGPU-CUSTOMSHADER-TRANSLUCENCYMODE-ALPHA-UNDERAPPLIED`
intake (§4 pts 5/7) remain **G5-owned** and are numbered when that diagnosis slice is cut (G5 §G5.0) —
deliberately NOT minted here.

### 1.24 Uniqueness check (mechanical)

I verified the mapping mechanically while authoring: the numbered range is a **contiguous
`C11-01 … C11-156` with no gaps and no repeats** (per-cluster counts: pick 10, standing-reds 15,
splat 1, model-frontend 5, terrain-imagery 11, attachment-topology 8, rte-taa 7, frame-delta 6,
entity-scale 11, submit-residency 4, celestial-env 2, tiles-model-parity 19, classification-voxel 9,
shadows-lighting 4, atmosphere-sky 4, postprocess-effects 7, clouds-weather 7, water 1, test-infra 16,
build-boot 9 → **156**). Suffix ranges are contiguous and disjoint: `C11-GT-01..03` (3),
`C11-SEED-01..26` (26), `C11-IC-01..03` (3). Infra rows `C11-00`, `C11-00B`, `C11-GATE-D-CHECKPOINT`
are outside the register-item namespace. **Total register items placed = 156 + 3 + 26 + 3 = 188 =
the register's item count. No name appears under two IDs; no ID is reused.** Every existing
`NEW-*/C9-*/S*/FAR-*/C-R*/DP-*` name is preserved verbatim as an alias — nothing renamed
(register-preservation rule).

**2026-07-18 append addendum (`C11-00B` sweep).** §1.23 adds `C11-157..165` (9 numbered) and
`C11-SEED-27` (1 seed). The numbered range is now contiguous `C11-01..165`; the seed range contiguous
`C11-SEED-01..27`. I re-checked every appended ID mechanically against the FULL namespace (numbered
`C11-01..156`, `C11-GT-01..03`, `C11-SEED-01..26`, `C11-IC-01..03`, and the infra rows) via
`grep 'C11-15[7-9]|C11-16[0-9]|C11-SEED-2[7-9]'` → **zero pre-existing hits: no collision, no reuse, no
name under two IDs.** The three ratified parity directions that map to pre-existing rows (`C11-17`
background-color, `C11-91` silhouette body-wash, `C11-115` sun-blend) were recorded IN PLACE —
deliberately NOT re-minted — preserving append-only + register-preservation. The register-item baseline
is unchanged at **188**; the 10 appends are campaign-scheduled work items (ratified list + C10 fallout)
tracked separately from that baseline.

### 1.25 PERFORMANCE-FRONT appends (2026-07-19, maintainer-directed — APPEND-ONLY, collision-verified)

**Origin.** Maintainer report: *"WebGPU performance is still pretty poor and around 50% slower FPS
than WebGL."* The empirical investigation (Batch 717) root-caused it and the maintainer directed that
the resulting performance work be **inserted at the front of Campaign 11**. Append-only additions
starting at `C11-166` (`C11-01..165` NOT renumbered or reused).

**What the investigation established** (all measured, not inferred — see `DEFERRED_WORK.md`
`NEW-WEBGPU-OCEANNORMAL-PER-CALL-REUPLOAD` and the Batch-717 commit body):

- The deficit was **not** renderer architecture, **not** the mandatory PP blit, and **not** Scene
  coupling. It was a per-frame texture **re-upload storm** on the globe water path.
- `uploadImageSource` (`WebGPUGlobeSurfaceTextures.ts:758`) **only WRITES to the cache Map it is
  handed — it never READS it** (no `cache.get`/`cache.has` in the function). Its sole internal dedupe
  (`_sharedImageryRealizations`) is gated on `logicalOwner === "imagery"`, which **neither call site
  passes**. Callers must own the guard; the ocean-normal caller had none.
- Result: full `copyExternalImageToTexture` + 9-level mip regen + `createView` **per tile per frame**,
  and — because the group-2 bind-group cache keys on **view identity** — a `createBindGroup` every
  frame too. Self-perpetuating.
- **Measured:** WebGPU `scene.render()` **10.5 ms → 0.9 ms (11.7×)**; WebGPU/WebGL **17.5× → 1.5×**;
  as-shipped idle lane WebGPU **1.1 ms vs WebGL 1.2 ms (now FASTER)**. `copyExternalImageToTexture`
  went from **47% of all CPU self-time** to absent.
- **Why it hid for two campaigns:** the in-engine per-pass CPU profiler accounted for only
  **0.117 ms of the 10.5 ms frame** — 99% of frame cost fell outside every instrumented pass, so the
  existing tooling could not see it *by construction*. It was correctly FILED (Batch 685) and simply
  never triaged. **Logging was not the gap; triage and coverage were.**
- **Ruled out, definitively:** WebGL is NOT running in WebGPU-only mode (`getContext` instrumented
  before page scripts → zero WebGL calls; `context._gl` is the `WebGLCompatibilityStub`). Idle
  `requestRenderMode` asymmetry is NOT the cause (`pendingForegroundCount` drained to 0 on all frames).

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-166` | NEW-WEBGPU-OCEANNORMAL-PER-CALL-REUPLOAD [filed Batch 685; ocean normal map re-uploaded per tile per frame; source-identity memo `_oceanNormalMapSource`/`_oceanNormalMapView`] | water / terrain-imagery | P0 | perf | S | — | **W1 (TOP) — ✅ COMPLETE Batch 717** |
| `C11-167` | NEW-WEBGPU-UPLOADIMAGESOURCE-CACHE-CONTRACT-AUDIT [**the systematic follow-up — highest-value open perf item**: `uploadImageSource` never reads its cache, so EVERY caller needs its own guard. Audit all call sites for the same missing-guard defect, then fix the contract at the right altitude (honor the `cache` param, or make the missing guard a type/API error) rather than patching callers one at a time] | terrain-imagery | P0 | perf/correctness | M | — | **W1 — COMPLETE Batch 721** (`d1c3f4373d`) |
| `C11-168` | NEW-WEBGPU-PERF-REMEASURE-REAL-WORKLOAD [the 11.7× was measured on a STATIC default scene of 9 draw commands / 6 tiles. Re-measure on the canonical moving-altitude campaign + a dense/tileset scene to confirm the win holds under load and to surface the NEXT bottleneck. Until this lands, the headline number is honest but narrow] | test-infra | P0 | tooling/measurement | S–M | G10 | **W1 — PARTIAL / VALID CAUSAL DEFICIT, ROOT CAUSE OPEN.** C11-205 lifecycle, full r6 attribution, and separate non-instrumented causal gates are locally green with exact work/identity. Across six pairs, WebGPU CPU-p95 run median is **9.2025 ms** vs WebGL **4.65 ms**; wall-p99 median **23.302 ms** vs **20.3025 ms**; navigation-to-stable **52,099.36 ms** vs **48,116.65 ms**. GPU timestamps were disabled (`validGpuRunCount=0`), so do not label this GPU-bound. Attribute the CPU/wall deficit before optimizing, preserve all features, and land the harness/evidence. **[Harness/evidence landed Batch 1032 `be0683c60d`, 2026-08-12; root-cause remediation remains open.]** |
| `C11-169` | NEW-WEBGPU-FRAME-COST-ACCOUNTING-GAP [per-pass CPU profiler saw 0.117 ms of a 10.5 ms frame. Extend instrumentation to cover the whole frame, or at minimum report the UNACCOUNTED remainder, so future perf work is not blind to out-of-pass cost] | test-infra | P1 | tooling | M | G10 | **W1 — PARTIAL; RESIDENT OWNER-ATTRIBUTION TOOLS LANDED Batch 1032 (`be0683c60d`); ACCOUNTING-SOURCE LANDING / REMEDIATION OPEN — NOT COMPLETE / DIAGNOSTIC ONLY / NO FPS OR GPU CLAIM.** Exact normal-Scene accounting now publishes an immutable fixed 11-phase ledger mutually exclusive with the named pass timers and conserves both `total + overlap = named + unaccounted` and `total + attributionOverlap = named + phases + unattributed`; disabled mode remains free of accounting clock reads/record allocation, standalone pick is isolated, and multi-frustum/2D executions fold into one logical Scene sample. Focused evidence is Node **31/31**, package TypeScript, a **53 s** integrated build, profiler Edge **26/26** with **18,203 skipped**, and Viewport Edge **2/2** with **18,227 skipped**. The combined Karma substring-filter attempt executed 0 tests (harness red); the first Viewport run exposed a real 1/2 helper-compatibility defect that was fixed before the clean 2/2 run. Final coarse artifact `c11-169-whole-frame-phase-attribution.json` (`runId=e07afdd3-67b6-41ab-aa09-a62ece40da6e`, SHA-256 `A5A2B43CF606CFF11DF0EDC56C352556633113DEB77B43083CF659A613DA9839`) is exit 0 with all 14 serialized `.pass` booleans true and zero failures/errors. Its 180/180-frame, 8/8-segment route has median total/named/coarse CPU **4.8/0.3/4.5 ms**, mean `6.7506 = 0.3144 + 6.4361 ms`, every phase positive, and exact zero unattributed/overlap/residual. Four 24-pair 8 ms controls move only their exact target phase; suppression, four-frustum, split-2D, and isolated-pick negatives are green. The preserved coarse first red (`runId=5e013ea8-648c-49f3-8ac2-f3a5a3ee715d`, SHA `2219C3F1EE85BE33802A8084421E32C8DE7C84AB054D94353A5605815741D176`) was solely an invalid 90% named-pass occupancy requirement on paired static controls; route non-vacuity remains strict and each control arm must contain named work. The first-green nested artifact `c11-169-primitive-traversal-breakdown.json` (`runId=e60f18d2-fbc1-48ba-b499-4806481bf20f`, generated `2026-08-11T10:22:11.412Z`, SHA-256 `8C7F14B614C467C5686619731426062C7B435D3F4545BC6B9481D39D1373FDB0`) is PASS/exit 0; its first-red file is physically absent. Offline policy is **17/17**, combined Node is **48/48**, static gates are green, and independent review is P0=0/P1=0. Its **120/120**, **8/8** route has **118** profiled frames: total median/mean/p95 **9.0/13.5175/55.8 ms**, primitive **2.3/4.6358/8.4 ms**, and globe render **2.2/4.5692/8.2 ms**. Globe render is **98.56% of mean primitive time**; ground/ordinary/residual means are **0.0067/0.0008/0.0592 ms**, and environment drain is **0.0067 ms**. Four 12-pair 8 ms controls have exact **24/12** seam/spin hits, off-target medians ≤**0.3 ms** by phase and ≤**0.1 ms** by detail, and zero errors. Critical boundary: prime ended `globeTilesLoaded=false` with `pendingForegroundCount=3`, using only the default local Natural Earth II globe and no explicit assets. This is streaming-state, globe-only, synchronous `diagnostic-noncausal` evidence; it is not transferable to C11-168/C11-205 and earns no optimization, FPS, or causal claim. Historical globe-only cross-backend results were near parity. The exact resident San Francisco owner-attribution Tools packet landed in Batch 1032 (`be0683c60d`); final artifact `c11-169-resident-sf-owner-attribution.json` retains SHA-256 `C755784AEF33AA85DF8C8F0DD72C0E025BFF38AC54F441CF1349DB5E95774C1C`. It remains synchronous, instrumented, diagnostic/noncausal evidence—not a GPU, FPS, or uninstrumented performance claim. Accounting-source landing, evidence-led remediation, and a separate uninstrumented causal confirmation remain open. |
| `C11-170` | NEW-WEBGPU-PERF-REGRESSION-GUARD [wire the new probes into a runnable gate so a re-upload/churn storm cannot silently return. This defect class survived two campaigns undetected] | test-infra | P1 | tooling/gate | M | G10 | W1 |
| `C11-171` | NEW-WEBGPU-SPLIT-SCREEN-VIEWER-INIT [`Apps/WebGPUTest/split-screen-comparison.html` never exposed both `webglViewer`/`webgpuViewer` within 90 s, with NO console errors (probe-backend-isolation split lane). Blocks the maintainer's own A/B comparison workflow] | build-boot | P1 | correctness | S–M | G9 | W1 · **RESOLVED-STALE / PREMISE REFUTED — the probe never clicked `#btnLaunch`; repair Batch 1079 (`c3c4709626`); ledger row is the authority** |
| `C11-172` | OCEAN-WAVE-OCTAVE-LOD [filed Batch 716; altitude-gate the wave march 3→2→1 octaves reusing `waveIntensityFade`; also narrows the WGSL-vs-GLSL 3-vs-2 octave divergence] | water | P2 | perf | S | G8 | **COMPLETE — Batch 757; ledger row is the authority** |

**Append accounting:** +7 numbered (`C11-166..172`), zero seeds. Numbered range now contiguous
`C11-01..172`. Checked mechanically against the FULL namespace (`C11-01..165`, `C11-GT-01..03`,
`C11-SEED-01..27`, `C11-IC-01..03`, infra rows) → **zero pre-existing hits: no collision, no reuse.**
`C11-166` and `C11-172` are pre-filed `DEFERRED_WORK` entries receiving a campaign number (names
preserved verbatim per the register-preservation rule); `C11-167..171` are newly minted from the
Batch-717 investigation. The 188-item register baseline is unchanged.

**Pending findings ABSORBED (2026-07-19, 32-agent investigation — 7 lanes + adversarial verification).**
The broader sweep completed and **independently confirmed the Batch-717 root cause** by a separate
evidence path (code-proof of `ContextFactory.ts:228-259` alongside the runtime `getContext` proof).
**23 of its 24 heavy claims were KILLED by adversarial verification** — most lanes theorized against
pre-fix code or attributed shared costs to a backend gap. Its three cheap surviving tool items append
below as `C11-173..175`; its five missing-backlog items were filed to `DEFERRED_WORK.md` (2026-07-19
section). Numbered range now contiguous `C11-01..175`, collision-checked as before.

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-173` | NEW-FRAME-PACING-MEASURED-REFRESH-RATE [`summarizeFramePacing()` (`lib/performance-campaign-utils.mjs:120-154`) already computes `droppedFramesAtRefreshRate`, but `refreshHz` is a **default parameter of 60** and the call site (`run-performance-campaign.mjs:2545`) passes ONE argument — so every dropped-frame figure silently assumes 60 Hz. Measure the real display period with a no-op rAF spin and thread it in. **Do NOT build a new quantization probe** — this one works, it just assumes its input] | test-infra | P1 | tooling | XS (~10 LOC) | G10 | W1 (perf lane) · **COMPLETE Batch 741 — ledger row is the authority** |
| `C11-174` | NEW-WEBGPU-CACHE-STATS-EXPOSURE [`WebGPURenderPipelineCache.ts:168-200` and `WebGPUBindGroupCache.ts:81-95` **already track hits/misses/hitRate**, but the counters are absent from `WebGPUContext.getRendererStatistics()` (:5377-5497). Expose them (follow the `csmShadows` try/catch pattern at :5473-5479) + add `CesiumDebug.cacheStats()`. **A churning bind-group cache is EXACTLY the shape of the bug Batch 717 just fixed** — this makes that shape visible for free] | test-infra | P1 | tooling | S (~40 LOC) | G10 | W1 (perf lane) · **COMPLETE Batch 741 — ledger row is the authority** |
| `C11-175` | NEW-WEBGPU-ADAPTER-SELECTION-AUDIT [Chrome can silently select a **weaker adapter** for WebGPU than for WebGL (notably on battery), which would show up as a backend "deficit" that no code change can fix. Pass `powerPreference: 'high-performance'` at adapter request and **log `adapter.info` next to the WebGL `RENDERER` string** so every future perf comparison states which physical GPU each backend actually got. Directly relevant: the maintainer's own reports come from a machine whose adapter pairing has never been recorded] | build-boot | P1 | correctness/tooling | S | G9 | W1 (perf lane) ⚠ **TRANSFERRED to C12 (LD-1, 2026-07-23) — ID retained as alias; C12 is the status authority for this row.** *(Stamped 2026-08-09, handover audit FIX 21 — §3.2 already carried the alias marker while this §1 cell did not.)* |

**⚠ GUARD RAILS — explicitly do NOT do these** (each would waste effort or fabricate evidence; all
were considered and rejected with reasons by the sweep):

- **Do NOT promote `C11-SEED-23` (S1-6 shared frontend floor, ~4-5 ms avg / 8-10 ms p95) as a response
  to a backend gap.** It is backend-neutral — both backends pay it equally, so it raises absolute
  throughput on BOTH and **cannot narrow a ratio**. Legitimate work, wrong symptom.
- **Do NOT pull `C11-GT-03` (MSAA 4→1).** The reserve-lever gating is correct, and the
  bandwidth-attributed evidence it demands does not exist. `scene.msaaSamples` (`Scene.js:488`) is
  **backend-agnostic** — WebGL consumes it at `FramebufferOrchestrator.js:76,92` and both backends
  rasterize 4×. Flipping it on WebGPU alone would benchmark no-AA against 4×-AA and **fabricate**
  the evidence. If ever tested, set `msaaSamples = 1` on BOTH and compare the ratio. The 1,640 MB/frame
  figure is stale (predates the C10-03 resolve elision and C10's −33% passes).
- **Do NOT pull `C11-43`/`C11-32`/`C11-33` forward from W6.** `C11-43` skips its own P0 31-renderer
  pipeline-cache-key audit (documented black-frame failure: no free bit for topology in the collection
  Uint32 key) and jumps `C11-50`, the validation probe the queue marks "must precede." Their
  documented baselines (~33 allocations/frame; ~10 `writeBuffer` calls, ~113 KB/frame) are **two orders
  of magnitude below** what Batch 717 removed. Re-size them AFTER `C11-168`.
- **Do NOT re-derive the Gate-D anchor.** `C11-SEED-27` is a supplementary input, not the anchor; the
  anchor is `campaign9-c9-30-checkpoint-clean-r5-2026-07-17.json`. Re-baselining on the improved tree
  trips Gate D's own stop condition (§3 / :553,556) and would erase the C9/C10 gains it exists to show.
- **Do NOT lead with globe hot-path allocation churn** (232-float camera UB re-packed per tile per pass
  `WebGPUGlobeSurfaceCameraUB.ts:97,228,236`; unpooled tile command literals
  `GlobeSurfaceTileProviderRendering.js:1084`; string bind-group keys
  `WebGPUGlobeSurfaceRenderer.ts:1997-2000`). All real, all **tens of microseconds** against the 9.6 ms
  Batch 717 removed. Secondary until `C11-168` re-sizes them.
- **Do NOT build WebGL GPU timing yet** (`EXT_disjoint_timer_query_webgl2` is absent from the codebase
  and not exposed by default in Chromium). If ever built, emit under a **distinct key**: WebGPU's
  `frameMs` is a begin-to-end *span* while WebGL's would be a *sum* of non-nestable elapsed queries —
  aliasing both into `gpuMs` would systematically flatter WebGL.

**Still-open genuine WebGPU-specific cost (unmeasured):** the mandatory post-process blit. It scales
with **pixel count**, so it is near-invisible at the harness's 1280×720 and could matter at 1440p/4K.
`C11-168` must therefore capture the maintainer's ACTUAL session parameters — canvas size,
`devicePixelRatio`, resolution scale, which page — not just the harness defaults.

### 1.26 CELESTIAL-APPEARANCE appends (2026-07-19, maintainer-directed — queued to the END of C11, new wave W9)

**Origin.** Maintainer report (2026-07-19), with three reference images supplied, after confirming the
Batch-717 perf fix on real hardware:

> "The star map in the skybox for WebGPU is significantly more faded than WebGL. Additionally the
> bright star that we added need to look more like stars and less like white blobs. Maybe we also need
> to get a better skybox image map… I also added an image of what the Sun & bright stars should look
> like from orbit."

**Reference images (the acceptance target):**

1. **ISS cupola photograph** — a DENSE Milky Way with visible dark dust lanes, thousands of resolved
   point stars of varying brightness *and colour*, plus Earth's limb showing a green airglow band with
   a red-orange layer above it. This is the density/structure target for the star map.
2. **Polaris A / Ab / B** — a brilliant core with a WIDE, SMOOTH, GRADUATED halo extending many core
   radii, with tight fainter companions. **The falloff is continuous — it is not a hard-edged white
   disc.** This is the shape target for bright stars and the sun.
3. **Compact bright concentration** resolving against a sparse field of fainter stars.

**Placement:** queued to the **END** of the campaign as a new **wave W9**, immediately before the
`C11-137` exit gate, per the maintainer's "queue this to the end of Campaign 11". `C11-176` is a
genuine *parity defect* rather than an aesthetic preference, so it may be **promoted earlier if the
in-flight research returns a cheap, well-anchored root cause** (an sRGB/format mismatch or a
tonemap-ordering divergence would be a small fix, not a feature).

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-176` | NEW-WEBGPU-SKYBOX-STARMAP-FADE-PARITY [WebGPU star map significantly MORE FADED than WebGL — a parity DEFECT. Prime suspects: sRGB-vs-linear cubemap format mismatch, a missing intensity multiplier, skybox tonemapped on WebGPU but not WebGL (WebGPU's mandatory PP blit puts tonemap between scene and canvas), AutoExposure metering a bright limb and exposing the star field down, or mip-averaging stars into grey mush] | atmosphere-sky | P1 | parity/bug | S–M | G8 | **W9 — COMPLETE (promoted, landed Batch 722); ledger row is the authority** |
| `C11-177` | NEW-BRIGHT-STAR-APPEARANCE-MODEL ["white blobs" → real stars. Needs: logarithmic magnitude→luminance (5 mag = exactly 100× flux), a PSF of Gaussian core + wide power-law halo (the reference-2 shape) instead of a flat disc, B−V colour index → blackbody RGB so the field is not monochrome, and HDR energy driving bloom rather than a painted-on sprite glow] | atmosphere-sky | P2 | feature | M–L | G8 | W9 |
| `C11-178` | NEW-SKYBOX-STARMAP-ASSET-UPGRADE [denser Milky Way with dust lanes per reference 1. **LICENSE IS LOAD-BEARING** — MIT repo, so public-domain (NASA SVS Deep Star Maps) strongly preferred *(baseline corrected `R-2026-08-21-23`: the fork is Apache-2.0, not MIT — permissive sources remain eligible with NOTICE attribution; the preference for public-domain stands on its own merits)*; anything share-alike or non-commercial is DISQUALIFIED. Includes the architectural call: texture carries the diffuse Milky Way while bright stars come from a catalogue as point sprites, rather than conflating both in one cubemap — which is likely *why* bright stars read as blobs today. Must land on BOTH backends] | atmosphere-sky | P2 | asset/feature | M | G8 | W9 · **PARTIAL — licence gate cleared; ledger row is the authority** |
| `C11-179` | NEW-SUN-MOON-APPEARANCE-IMPROVEMENTS [Sun: correct ~0.53° angular diameter, limb darkening (cheap, high realism), HDR-driven glare — and note that in vacuum there is NO atmospheric halo, so the glow is instrument/eye response, not scattering. Moon: non-Lambertian reflectance (Hapke / Lommel-Seeliger — the full moon is far brighter and flatter than Lambertian predicts), opposition surge, earthshine on the dark limb, public-domain LROC/CGI-Moon-Kit albedo+normal maps. **Cross-ref to avoid double-scheduling:** `C11-160` sunBloom PP wiring, `C11-115` sun blend → ALPHA_BLEND, `C11-161` AutoExposure demand-gate are ALREADY queued] | atmosphere-sky / celestial-env | P2 | feature | L | G8 | W9 |

**Append accounting:** +4 numbered (`C11-176..179`). Numbered range now contiguous `C11-01..179`,
collision-checked against the full namespace → zero pre-existing hits.

**Research IN FLIGHT.** An 8-lane celestial-appearance research sweep (skybox-fade diagnosis, star-map
asset licensing, PSF/magnitude/colour model, sun glare, moon BRDF, current-implementation survey,
HDR/tonemap chain order, and measurable acceptance criteria) is running as of 2026-07-19 and **feeds
Campaign 12**. Its findings refine these four rows; the *feature* depth lands in C12 while the
*parity defect* (`C11-176`) stays here.

**⚠ Acceptance must be measured, not eyeballed.** "Looks better" is not a gate. A washed-out star
field can have the SAME mean luminance as a good one while having far lower variance — so a
mean-luminance diff would **miss this bug entirely**. Gate on star-point CONTRAST (local max vs local
background), COUNT of distinguishable point sources above threshold, luminance-histogram tail shape,
colour SATURATION distribution, and for bright stars the RADIAL FALLOFF PROFILE (a blob has a flat
core then a cliff; a real star has a smooth power-law tail).

### 1.27 WEBGL SHADER-LIFECYCLE appends (2026-07-28 — APPEND-ONLY, collision-verified)

The C12-29 S5 moving-route lane isolated a renderer-wide WebGL first-use
problem rather than an eclipse-only defect. These rows own the fix separately
from C12-29; no C12 completion claim depends on them.

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-180` | WEBGL-ASYNC-SHADER-COMPILE-LIFECYCLE [pending-program lifecycle; final-program scheduling; bounded fog companion prewarm] | build-boot | P0 | perf/correctness | M | G9/G10 | **W1 — PARTIAL; LANDED (Batch 773, 2026-08-01)** |
| `C11-181` | WEBGL-GLOBE-SHADER-VARIANT-EVICTION-REFERENCE [balanced replacement references; stale-wrapper poisoning] | terrain-imagery | P1 | correctness/resource-lifetime | S | G2 | **COMPLETE — IMPLEMENTED / VERIFIED / LANDED (Batch 773, 2026-08-01); every recorded acceptance is green, administrative close 2026-08-09.** *(Close authority: `DEFERRED_WORK.md`, landed Batch 1063 `21c9489185`, 2026-08-20.)* |
| `C11-182` | WEBGPU-MODEL-MATERIAL-DIRTY-UPLOAD [exact byte-dirty suppression for primary/silhouette/translucent material UBOs; no visibility policy change] | models | P0 | perf | S | G5/G10 | **W1 — IMPLEMENTED / ATTRIBUTION GREEN / TIMING CERTIFICATION OPEN** |
| `C11-183` | WEBGPU-WATER-MASK-SINGLE-REALIZATION [borrow the same-device native compatibility texture; retain cross-device fallback and WebGL orientation] | water / terrain-imagery | P0 | perf/resource-lifetime | S–M | G2/G10 | **W1 — IMPLEMENTED / DOUBLE-REALIZATION REMOVED / VISUAL CERTIFICATION OPEN** |
| `C11-184` | WEBGPU-MODEL-SHADOW-CANDIDATE-CORRECTNESS [correct `ShadowMode`; one native default light pass; unique caster collection; explicit node-aware/RTE-safe native cast resources; single/CSM/point receive; same-frame resource + fitted-matrix preparation; topology/cull-aware pipelines; persistent bind-group ownership; globe adapter parity; keep active casters through SceneOctree/CPU occlusion; prevent native commands entering WebGL derivation] | models / shadows | P0 | correctness/prerequisite | M–L | G5/G10 | **W1 — IN PROGRESS / LANDED (Batches 775/780, 2026-08-01) / FOCUSED + MOVING RUNTIME GATES OPEN** |
| `C11-185` | WEBGPU-MODEL-VISIBILITY-TRIGGERED-PREPARATION [prepare model camera/material/light resources only after VIEW/SHADOW/CAPTURE admission; retain 2D/VR/capture fallbacks until dynamic-offset arenas exist] | models / scene-core | P0 | perf/architecture | L | G5/G10 | **W1 — SLICES 1–3 IMPLEMENTED / LANDED (Batches 774/780, 2026-08-01) / ATTRIBUTION GREEN / TIMING CERTIFICATION OPEN** |
| `C11-186` | GLOBE-SURFACE-TILE-FRESH-IMAGERY-UPSAMPLE-REGRESSION [focused `GlobeSurfaceTile` spec reproducibly marks fresh-imagery tile as upsampled; discovered during C11-183 broad regression run, outside that slice's state logic] | terrain-imagery | P1 | correctness/test-red | S–M | G2 | **W1 TAIL — QUEUED / DIAGNOSE AFTER PERF PASS** |
| `C11-187` | HIZ-DEGENERATE-BOUNDING-CONSERVATIVE-FALLBACK [preserve original command identity/order when SOA packing skips unknown, degenerate, unrepresentable, or over-capacity bounds; narrow conservative pass-through only — does not activate or certify Hi-Z] | scene-core / Hi-Z | P1 | correctness | S | G10 | **W1 TAIL — IN PROGRESS / LANDED (Batch 778, 2026-08-01) / FOCUSED RERUN OPEN** |
| `C11-188` | WEBGPU-MODEL-TRANSLUCENT-TWIN-NODE-MATRIX [the styled translucent twin packs its material UB with root `modelMatrix` while the primary uses `nodeModelMatrix`; articulated/non-identity nodes therefore have node-correct vertex projection but root-wrong fragment world reconstruction/lighting] | models | P1 | correctness | S | G5 | **W1 TAIL — LANDED-PARTIAL Batch 1114; ledger row is the authority** |

**Append accounting:** +9 numbered (`C11-180..188`), zero seeds. Numbered
range is now contiguous `C11-01..188`. Repository-wide collision search found
zero earlier uses of this range before each append. The canonical deferred
names are preserved; no historical ID was renamed or reused.

**C11-184 implementation note (2026-07-28, IN PROGRESS).** Native WebGPU owns
one fitted directional/spot light map when CSM is off and deduplicates legacy
per-cascade/per-face command lists before native dispatch. Model and globe
commands carry exact `ShadowMode`, topology/cull state, stable resource owners,
and explicit RTE-safe variants; model receive now has distinct single-map,
CSM, and point-light routes. First-frame depth resources are realized before
binding, while a frame-owned preparation list refreshes the fitted receive
prefix after `ShadowMap.update()` and skips unchanged settled uploads. CSM
intent is frame-owned so cast and receive switch together on first warmup,
toggle-off, and non-3D frames. Classifiers and non-colour variants remain
disabled. A recreated GPU buffer forces its first write.

The styled translucent twin remains receive-only: today's cast shader is
geometry-only and cannot evaluate its feature alpha/style/clipping, while the
primary remains the single geometric caster even for `ALL_TRANSLUCENT`.
`C11-189` owns style-aware coverage. Combined skinning + instancing has no
correct native cast shader (`C11-190`), and morph/custom vertex deformation
needs its own matching cast route (`C11-191`); unsupported commands fail closed
instead of corrupting the map through stride inference. No focused-green claim
is carried forward from the earlier implementation. Closure requires the fresh
build/spec matrix plus moving pixel routes for default directional, CSM
warm/toggle, point, Earth-scale motion, globe receive, `ALL_TRANSLUCENT`, and
settled allocation/upload counters.

### 1.28 WEBGPU SHADOW-COVERAGE residual appends (2026-07-28 — APPEND-ONLY, collision-verified)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-189` | NEW-WEBGPU-STYLE-AWARE-SHADOW-COVERAGE [one dedicated caster evaluates feature style alpha, clipping, and visibility without duplicating the primary/twin geometry cast] | models / shadows | P1 | correctness | M | G5/G10 | **W1 TAIL — NOT STARTED / AFTER PERF PASS** |
| `C11-190` | NEW-WEBGPU-MODEL-SKINNED-INSTANCED-SHADOW [combined animated-crowd cast variant with skinning + instance transforms and RTE parity] | models / shadows | P1 | correctness | M | G5/G10 | **W1 TAIL — NOT STARTED / AFTER PERF PASS** |
| `C11-191` | NEW-WEBGPU-MODEL-SHADOW-DEFORMATION-COVERAGE [morph targets and custom vertex deformation must cast the same silhouette as the colour pipeline; cross-ref C11-92] | models / shadows | P1 | correctness | M–L | G5/G10 | **W1 TAIL — NOT STARTED / AFTER PERF PASS** |

**Append accounting:** +3 numbered (`C11-189..191`), zero seeds. Numbered
range is now contiguous `C11-01..191`; repository-wide collision search found
zero earlier uses before this append.

### 1.29 POST-ATTRIBUTION PERFORMANCE/ARCHITECTURE appends (2026-07-31 — APPEND-ONLY, collision-verified)

The moving globe control and exact terrain identities disprove a broad
globe-quadtree/RTE collapse. Representative attribution localizes substantial
avoidable model/resource/submission work, while the clean resident lane remains
held on an exact 3D Tiles selection-parity red. These rows preserve every feature:
immutable state is shared, proven-unused realization is delayed, conversions
move to bounded resource jobs, and the last complete resource remains usable
while a replacement is prepared.

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-192` | WEBGPU-TERRAIN-SHADOW-UB-DEMAND-REALIZATION [do not allocate/upload per-tile shadow-cast UBs while no shadow pass demands them; first ON frame must remain complete] | terrain-imagery / shadows | P1 | perf/resource-lifetime | S–M | G2/G10 | **W1 — IMPLEMENTED / LANDED (Batch 775, 2026-08-01) / STATIC+OFF-RUNTIME GREEN / ON-PIXEL GATE OPEN** |
| `C11-193` | WEBGPU-DYNAMIC-ENVIRONMENT-SHARED-KERNEL-JOB-SCHEDULER [one device-generation kernel pack; context-owned bounded refresh jobs; reuse targets; shared encoder/submission; retain per-probe regional/weather outputs] | models / atmosphere-sky / resource-prep | P0 | perf/architecture | L | G5/G8/G10 | **W1 — PARTIAL; C11-193A/B/C IMPLEMENTED / LANDED at `b20234a16b` + FOCUSED EDGE + C11-193B/C REAL EDGE/WEBGPU BROWSER GREEN; MOVING-PERFORMANCE ATTRIBUTION/BROADER-RECOVERY OWED — NOT COMPLETE / NO FPS CLAIM.** The landed scheduler/pool base remains 43/43. **A** retains a transactional manager-local IBL graph under the exact context/device/resource-generation/topology tuple without changing explicit-source or WebGL behavior; its original focused lane is 17/17. **B** borrows the exact active Scene encoder, holds unique manager-local arena/output transactions through exact submitted/abandoned callbacks, and retains the off-frame private fallback. Its exact-encoder seam is 16/16, final named Edge is 25/25, package TypeScript/build are green, and the first real browser invocation passed 19/19: two exact 44-pass manager sequences share one Scene encoder/submit, replacement adds one 44-pass Scene submit, private encoders/submits are 0/0, and errors are zero. **C** adds a retained, allocation-conscious context coordinator around primitive update: it collects exact manager ticks, drains DEMANDED/UNKNOWN before PROVEN_NONE, holds first-half split-2D NORMAL work for late promotion, pins exact context/generation, rejects destroyed/invalid jobs, and releases captured state on drain/reset/error. Budget 1 counts only deferrable work; MANDATORY/escalated grants bypass it, one deferral arms one `afterRender` resume, and fairness advances only after C11-193B's real submission. Node priority + drain/lifecycle suites pass **56/56**, focused Edge **31/31**, package TypeScript is green, and the fresh integrated build passes in **79.7 s**. Final C11-193C artifact `Tools/visual-regression/output/performance/c11-193c-dynamic-ibl-demand-priority.json` (`schemaVersion=1`, `runId=6c895a6d-d808-4397-8981-0cb2df6d3acc`, SHA-256 `7CB3D70DAD06DCCCED6E6DE0BC3A0A73699AAF294393C09513CEB970F4FB3BE3`) is **29/29**, exit 0: priority HIGH/NORMAL = **44/0** on one Scene submit with scheduler requests/granted/deferrable/deferred/resume/submissions/pending **2/1/1/1/1/1/1**; deferred NORMAL resumes next frame for **44** and stable repeat is zero; MANDATORY+UNKNOWN-HIGH = **44+44=88** on one Scene submit with **2/2/1/1/0/2/0** requests/granted/mandatory/deferrable/deferred/submissions/pending; real split 2D is **0** first-segment then **44** continuation-segment passes, stable repeat zero. Pending/scope/commit/arena/buffer and encoder identities remain exact through native submit, `lastSubmitFrameId` changes only after settlement, manager outputs stay isolated/stable, private encoders/submits are 0/0, and all errors are zero. Preserved first red (`runId=5cd791e0-9c4e-4c66-b2a2-061045134bac`, SHA-256 `B2C4DD55D50A4C65643BA694707B666BB62ACFBE0AFE9CD75EE2BF4308E93452`) was Tools-only: a `needsUpdate===true` assumption excluded valid sun-dirty pending work; final exact identity gates replace it without weakening product acceptance. **OPEN / P2:** moving-camera causal/FPS attribution; persistent HQ reuse; replacement-device/device-loss, multiview, reentrant lifetime, invalid shared-manager/cross-context and malformed custom-Scene certification; inherited raw-cubemap exceptional recovery; residual descriptor/lookups; diagnostic telemetry allocations. The browser is one Edge/device/context and submit-return is not GPU completion; its resume lane is not sustained contention (Node owns alternation/escalation). Do not rerun unchanged evidence or claim an FPS win. |
| `C11-194` | WEBGPU-MODEL-SHARED-DEVICE-RESOURCES [reference-count immutable model BGL/layout/sampler/placeholder/default-view resources by device generation; keep mutable state model-local] | models / resource-lifetime | P1 | perf/architecture | M | G5/G10 | **W1 — PARTIAL (Batch 774 base + independently reviewed 2026-08-02 recovery slice, LANDED Batch 819; IBL generation recovery LANDED Batch 1022):** model/shared/pipeline/compatibility resources now require the exact `(GPUDevice, resourceGeneration)` tuple; stale handles null-drop without an unbounded decoded-source replay journal; async pipeline/error-scope publication is lifecycle-epoch guarded; compressed uploads validate feature/block/mip ownership; candidate creation is transactional; and teardown detaches then drains primitives, nested feature/morph/metadata/edge/instancing owners, ordinary plus per-feature pick IDs/textures, compatibility registries, shared leases, and environment-pool handles even when an old native throws. IBL cache/published/cube ownership now detaches before best-effort sibling drain and focused Edge passes 3/3. Focused recovery + pool contracts remain 19/19 + 45/45 and package TypeScript is green. **OPEN:** higher-level texture re-upload after a dropped compatibility handle, nested clipping tuple recovery, real replacement-device browser evidence, multi-context arena partitioning (C11-195), non-block-aligned compressed-source support/extension exposure, and pick-demand realization (C11-196). Do not mark complete. |
| `C11-195` | WEBGPU-MODEL-VIEW-LIGHT-DYNAMIC-UNIFORM-ARENA [replace direct per-model camera/light queue writes with dynamic-offset slices; retain per-view/RTE/capture/shadow-camera isolation] | models / scene-core | P0 | perf/architecture | L | G5/G10 | **W1 — PARTIAL (LANDED Batches 772/780/791/800): CAPTURE/RTE + MAIN CAMERA DYNAMIC OFFSETS + ONE 864-BYTE LIGHT PACK PER MODEL/VIEW IMPLEMENTED AND FOCUSED-PROBE VERIFIED. OPEN:** moving-route allocation/GC measurement; remove per-acquire string/short-array churn; exact device-recovery and full multi-view/shadow/capture certification. **NEW 2026-08-02 AUDIT:** the mutable arena currently lives in the device-shared immutable pool even though uniform allocators are context-owned; alternating contexts on one pooled `GPUDevice` clear the whole bind-group cache on every allocator-identity swap. Make the arena context-owned or allocator-partitioned while continuing to share the immutable layout. |
| `C11-196` | WEBGPU-MODEL-LAZY-PICK-DERIVATION [retain pick IDs; build/prewarm pick pipeline+command outside ordinary colour rendering and preserve synchronous first-pick fallback] | models / picking | P1 | perf | M | G5/G10 | **W1 — LOCAL IMPLEMENTATION + FOCUSED EDGE + DIAGNOSTIC EDGE/PLAYWRIGHT GREEN; LANDING + MOVING-PERFORMANCE/BROADER-RECOVERY ACCEPTANCE OWED — NOT COMPLETE / NO FPS CLAIM.** **[Landed Batch 1072 `9cf9b0019d`, 2026-08-20, one unit with C11-202; moving-performance/broader-recovery acceptance still owed — row stays open.]** Ordinary color keeps the feature/style buffer, batch texture, fallback binding 31, and byte-40 disabled flag, but allocates no native generic/dense pick IDs, feature lookup texture, pick pipeline, or derived pick command. Exact `passes.pick === true`, non-classifier, `allowPicking !== false` demand synchronously promotes on first pick; entries-array publication is atomic and retryable, feature-count replacement retires old textures through submit-safe context scheduling, and same-frame capture publication upserts by model identity. Node contracts pass **13/13**, named Edge/Karma `WebGPUModelFeatureId` passes **19/19** with **17,823 skipped**, package TypeScript is green, and independent review found P0=0/P1=0. Final artifact `Tools/visual-regression/output/c11-196-model-lazy-pick-demand.json` (`generatedAt=2026-08-11T04:19:57.165Z`) records `pass=true`, `exitCode=0`, `failures=[]`, and zero page/WebGPU/render errors. Its 30-feature fixture proves cold native counts **0/0/0/0** (generic/dense/lookup texture/pick pipeline) while styling remains live; first pick realizes **1/30/1/1**, performs one byte-40 enable and one merged-bind-group rebuild, and returns feature 28 with readable hierarchy properties; repeat and four later color frames create no further pick IDs/textures/pipelines/bind groups and retain entries/UBO/texture identities. A fresh `allowPicking=false` lane returns no hit and retains native **0/0/0/0** with no derived command. **Historical C11-202 handoff evidence:** this artifact exposed **30 backend-neutral legacy tile-feature registry IDs before `submitDrawCommands` applied `allowPicking=false`**; the probe and both preserved reds retain those calls rather than rewriting history. The later local bounded C11-202 gate now suppresses that legacy realization for regular native models while preserving WebGL/classifier/post-process behavior. Picking, styling, classifiers, all pick variants, WebGL behavior, and first-pick synchrony remain preserved. |
| `C11-197` | WEBGPU-LAZY-SCENE-PASS-RESUME [defer pass reopen until a draw or required clear/resolve; preserve depth/stencil/TAA/classification/multifrustum ordering] | scene-core / attachment-topology | P1 | perf/architecture | M | G3/G10 | **W1 — QUEUED / REOPEN-REASON ATTRIBUTION FIRST** |
| `C11-198` | WEBGPU-MODEL-PERSISTENT-COMMAND-TEMPLATES [retain per-primitive templates or use a frame arena; never mutate state still consumed by another view/shadow/capture list] | models / scene-core | P1 | perf/architecture | M–L | G5/G10 | **W1 — QUEUED / CONSTRUCTOR+GC COUNTERS FIRST** |
| `C11-199` | WEBGPU-MODEL-PENDING-PIPELINE-EARLY-GUARD [do not rebuild/re-poll a descriptor already represented by the local pending promise] | models / build-boot | P2 | perf | XS | G5/G9 | **W1 — IMPLEMENTED / LANDED (Batch 774, 2026-08-01) / STATIC VERIFIED / FOCUSED BROWSER OPEN** |
| `C11-200` | WEBGPU-TONEMAP-EXPOSURE-DIRTY-WRITE [normalize/equality-gate the fixed exposure setter; auto-exposure retains genuinely changing writes] | postprocess | P2 | perf/allocation | XS | G6/G10 | **W1 — IMPLEMENTED / LANDED (Batch 776, 2026-08-01) / STATIC VERIFIED / FOCUSED BROWSER OPEN** |
| `C11-201` | WEBGPU-GLOBE-DEPTH-STABLE-VIEW-IDENTITY [cache the packed-depth output view until target/resize/device generation changes so effects keys do not churn] | terrain-imagery / postprocess | P2 | perf/resource-lifetime | S | G2/G6/G10 | **W1 — IMPLEMENTED / LANDED (Batches 776/777, 2026-08-01) / MOVING ATTRIBUTION GREEN / ALLOCATION-ONLY CREDIT** |
| `C11-202` | MODEL-BACKEND-NEUTRAL-PRIMITIVE-DESCRIPTORS [shared immutable descriptor once; WebGL realizes GLSL/VA/DrawCommand and WebGPU realizes only native equivalents; remove remaining legacy CPU-object tax without losing metadata/style/clipping/classification/silhouette/edge/pick/shadow/custom-shader behaviour] | model-frontend / models | P0 | perf/architecture | XL | G4/G5/G10 | **W1 — PARTIAL: LANDED Batches 774/780/819 + LOCAL BOUNDED LEGACY-BATCHTEXTURE DEMAND GATE + FOCUSED EDGE + DIAGNOSTIC BROWSER GREEN; LANDING/BROAD DESCRIPTORS/MOVING PERFORMANCE/RECOVERY OPEN — NOT COMPLETE / NO FPS CLAIM.** **[Bounded gate landed Batch 1072 `9cf9b0019d`, 2026-08-20; the named remainders stay open.]** The landed slices bypass final WebGL program/VA/DrawCommand realization on WebGPU while retaining shared geometry/material/feature/metadata/lighting/alpha/statistics stages and the Scene edge-MRT signal; legacy-only picking/edge pipeline stages remain skipped only for the native backend. **Historical C11-196 evidence is preserved:** its 30-feature `allowPicking=false` lane exposed **30** legacy `BatchTexture` registry IDs before native submission, despite native counts 0/0/0/0. The local bounded fix now resolves the MODEL feature renderer once before feature-table update and reuses that exact owner for build and submit. `legacyPickTextureDemand = passes.postProcess === true || (passes.pick === true && !nativeOwnsDensePick)` is threaded through `ModelFeatureTable`; the optional `BatchTexture.update` override defaults to the old `passes.pick || passes.postProcess` law when omitted. Thus regular non-classifier WebGPU models keep styling live but leave the legacy ID map/texture cold, while WebGL/no-MODEL-renderer, classifiers, post-process, and classic `Cesium3DTileBatchTable` callers retain their prior realization. C11-196 remains the sole native dense-ID owner; no legacy IDs or texture are borrowed/relabelled. Exact `BatchTexture` identity plus dimensions now invalidate a same-count native dense-pick cache so new owners cannot reuse wrong-target PickIds. Replacement is coherent: `_retiredFeaturePickGenerations` pairs each retired texture with its superseded PickIds, holds the generation while any primitive marker still binds it, retains the whole entry if live-context scheduling throws, destroys IDs only after scheduling succeeds, and teardown deduplicates current/retired owners for exact-once attempts. Final independent re-audit is P0=0/P1=0 for this bounded slice. Node behavior/source/mutant contracts pass **16/16**; Edge/Karma passes `BatchTexture` **25/25** (18,192 skipped), `ModelFeatureTable` **11/11** (18,206 skipped), and final `WebGPUModelFeatureId` **23/23** (17,845 skipped); package TypeScript and the final integrated `npm run build` (**83.2 s**) are green. Final diagnostic artifact `Tools/visual-regression/output/c11-202-batchtexture-pick-demand.json` (`generatedAt=2026-08-11T05:44:02.186Z`) records `pass=true`, `exitCode=0`, and zero failures/page/device errors. WebGPU cold counts are legacy/native **0/0**; enabled first pick creates **0 legacy IDs/textures** and exactly **1 generic + 30 native dense IDs + 1 native lookup texture/upload**, returns exact feature 28/properties, and repeat/later color create nothing new. Fresh `allowPicking=false` stays no-hit with legacy/native counts zero. WebGL control preserves cold zero then exactly **30 legacy IDs + 1 texture/upload** on first pick, exact feature 28, and stable repeat/later color. The post-artifact repair changes only replacement/failure lifetime, so the steady-state artifact remains valid and did not need a rerun. Preserved first red (`...first-red.json`, `generatedAt=2026-08-11T05:40:05.977Z`, exit 2) was entirely harness-owned: a stale one-line source-policy match plus WebGL `pickAsync` timeout; the final probe uses the corrected source match and synchronous WebGL pick without weakening gates. **ADJACENT OPEN P1:** mutable `featureIdLabel`/`instanceFeatureIdLabel` can retain native primitive feature entries/instancing buffers across descriptor reset and skip selected-source re-resolution; rebuilding them needs submit-safe retirement. **OPEN P2:** scheduling defers the old GPU texture, but paired PickIds are released immediately after scheduling succeeds, so an already-issued overlapping `pickAsync` readback may decode an old color after its registry target is gone; async owner replacement/destruction is not certified. A retired generation that becomes unbound outside a later promotion has no eager drain hook and remains boundedly retained until another feature-resource ensure/promotion or final teardown. **STILL OPEN:** mechanical landing; moving-route allocation/timing; the broad backend-neutral descriptor/remaining legacy-object audit; edge-emitter RTE; selected-feature post-process ownership; device/fallback/multi-context recovery. Do not mark complete. |
| `C11-203` | WEBGPU-SCENE-CAPTURE-ACTIVE-DEMAND-AND-PER-FACE-CULL [expand ENV-CAPTURE-PER-FACE-LOD: active-manager registry, retained generation list, conservative probe/face spatial admission, no main-camera traversal mutation] | capture-reflection / scene-core | P1 | perf/architecture | L | G5/G8/G10 | **W1 — QUEUED / OPT-IN** |
| `C11-204` | WEBGPU-GPU-VISIBILITY-STABLE-IDENTITY-RTE [unify GPU cull/Hi-Z producer, stable command+generation IDs, camera-relative spheres/planes, cull=false pass-through, pooled SOA; no post-PVS count-only readback] | scene-core / Hi-Z | P1 | correctness/perf/architecture | L | G10 | **W1 TAIL — QUEUED / KEEP DEFAULT-OFF** |
| `C11-205` | 3DTILES-VERSIONED-MODEL-STATE-PACKET-AND-REQUEST-CHURN-EVIDENCE [apply broad tileset properties only on version change; fingerprint per-frame visible/SSE/content-ready tile identities and issued/cancelled/reissued request bytes; resident comparison must prove identical ready sets before changing traversal or hysteresis] | tiles3d / models / measurement | P0 | correctness/perf/tooling | M | G4/G5/G10 | **W1 — MEASUREMENT GATES GREEN; SHARED CAMPAIGN HARNESS LANDED Batch 1032 (`be0683c60d`); PERFORMANCE REMEDIATION / ROW CLOSE OPEN — NOT COMPLETE (core slices LANDED Batches 779/784 + independently reviewed 2026-08-02 ledger/state/v2 slices, LANDED Batch 819):** ordinary ready count, dual order-invariant identity hashes, incomplete/mismatch rejection, and first-divergence attribution landed in 784 (53/53 contracts). The stable v1 ledger covers request/attempt serials, deferral, effective cancellation/reissue, settlement/readiness, URL chronology, and honest byte knownness; malformed/vacuous evidence fails closed. Schema v2 now also observes exact multiple-content slot/group membership (including failure/discard and more than ten slots), stale generation, model/content/tile-ready event ordering, direct-model content, late-settle reissue, cancellation no-ops, and post-destroy freeze without altering production traversal. Independent focused v2 is 57/57 and preserved legacy performance coverage is 56/56 (113/113 combined). The immutable model-state packet compares sixteen broad fields once per active pass/nonempty processing queue and applies them only on packet identity change (7/7); null/undefined light normalization, in-place light snapshots, listener mutation timing, and existing per-tile dynamic state are preserved. Its new module retains named exports plus the generated barrel's required default export; package and top-level builds are green. The July artifact matches at 15 requests/zero open with signature `27b1e7d0-dd48cecb`. **FIXTURE PREMISE RESOLVED (2026-08-06):** the "no real multiple-content fixture" gap was stale. The repository already ships a 3D Tiles 1.1 multiple-contents tileset whose root tile carries two content slots of two different formats (`Specs/Data/Cesium3DTiles/MultipleContents/MultipleContents/tileset_1.1.json` → `batched.b3dm` + `instanced.i3dm`), and `server.js` serves the repository root statically, so the dev server already publishes it. No synthetic tileset was fabricated. `probe-c11-205-lifecycle-v2.mjs` now drives that exact fixture from the shared `C11_205_MULTIPLE_CONTENT_FIXTURE` constant, adds the focused browser mutation lane for the versioned model-state packet (idle-churn, one-bump-per-mutation, propagation to every content slot, dynamic per-tile model matrix with no packet bump), and exits `0 PASS / 1 FAIL / 2 exception / 3 STRUCTURAL` on eleven per-leg gates plus a cross-leg ledger-signature gate. **RESIDENT PRECONDITION CLOSED IN CODE (2026-08-06):** the resident lane previously proved only that *terrain* needed no work, which is exactly how the 2026-07-31 pair reached a timing comparison while its SF 3D Tiles content was still streaming (710/15 WebGL vs 571/12 WebGPU). `isRepresentativeResidentRoutePassQuiescent` now additionally requires 3D Tiles residency, and `run-performance-campaign.mjs` samples it per frame in both the convergence passes and the measured window (`notLoadedFrames`, `pendingRequestFrames`, `processingFrames`, `attemptedRequestFrames`, cumulative `loadedTilesTotalDelta`, resident `contentByteLengthDelta` — all must be zero, fail-closed on missing evidence). A run that cannot reach residency now aborts at prime time with a `[structural]` cause instead of burning six repetitions to end at "the legs held different ready sets", and the campaign exit is classified so an unmet precondition reads INCOMPLETE (3) while a ready-set divergence between two clean legs stays FAIL (1). The comparability contract was NOT relaxed: identical ready sets, counts, identities and request ledgers remain required. **BROWSER UPDATE 2026-08-10 — LIFECYCLE + ATTRIBUTION + CAUSAL R6 GREEN; SHARED HARNESS LANDED Batch 1032, REMEDIATION OWED.** `probe-c11-205-lifecycle-v2.mjs` passes its real browser gate on WebGL and WebGPU with identical request-ledger signature `1bf0f7c3-b152437e`: two content slots/two models, one ready tile, two requests with zero open, stable count 12, state-packet and dynamic propagation green, and no errors. The first external ~20-minute campaign invocation was incomplete and produced no artifact. The final valid full-r6 API-attribution run wrote `Tools/visual-regression/output/performance/c11-205-attribution-2026-08-10-rerun.json` (12 runs; 167,908,005 bytes) and honestly exited 1: all 12 runs exposed measurement progress `[1/599 … 1, 1]` versus replay `[0 … 1]`, so 0/6 pairs were comparable. Cause is a harness activation-index defect, not an engine finding: both convergence and measurement initialized `cameraTrackFrameIndex=1` after pre-applying—but not rendering—progress zero. Both now start at 0; the strict comparator is retained. Offline `performance-workloads` coverage is 56/56 and Node syntax check is green. Focused discriminator `c11-205-phase-discriminator-webgl.json` (one renderer, one repetition, 60 frames) has `run.result=pass`, `fixedFrameProgress.identical=true`, `firstDivergenceIndex=null`, maximum absolute difference 0, and exact endpoints; the overall campaign exits 1 only because it deliberately contains no certification pair. **FOLLOW-UP SOURCE DIAGNOSIS:** the 15-vs-12 request split was route-prime wall-clock admission, not engine traversal. Cesium's moving-request cull and `foveatedTimeDelay=0.2` use `camera.timeSinceMoved`; `tilesLoaded` does not count requests suppressed before admission, and WebGL's longer dwell admitted three peripheral siblings. During the **untimed resident route prime only**, the harness now snapshots each tileset's originals, sets `foveatedTimeDelay=0` and `cullRequestsWhileMoving=false` inside `try`, and restores them in `finally` before convergence or measurement; the artifact records both policy and restoration. Measured features, traversal, SSE, selection, rendering, and strict comparators are unchanged. Contracts are **57/57** and Node syntax is green. Paired WebGL/WebGPU r1/60 API discriminator `c11-205-prime-admission-discriminator-pair.json` has both `run.result=pass`; both phase arrays are identical with maximum difference 0; policy restoration is true with originals `0.2/true`; its attribution-only pair is valid with `reasons=[]`; workload fingerprint and all eight segments match exactly; both ledgers contain 20 requests with signature `aa38af59-4b01a371`, exact chronology/bytes, and zero selected/ready mismatch frames. The reduced discriminator's overall process exit 1 was expected solely because r1/API is noncertifying, not because either run or its pair failed. **FULL CORRECTED R6 API ATTRIBUTION — PASS / EXIT 0.** `Tools/visual-regression/output/performance/c11-205-attribution-phase-prime-fixed-2026-08-10.json` (171,308,539 bytes; `generatedAt=2026-08-10T17:43:59.849Z`) contains 12/12 passing, non-structural runs with `failures=[]` and attribution-only quality. Pair summary is valid/status `attribution-only` with `reasons=[]`: **6/6 valid pairs**, three in each execution order, and no ready-set exclusions. Every pair has exact workload fingerprint, all eight segment signatures, and ready identity; WebGL and WebGPU each have a 20-request ledger/signature `aa38af59-4b01a371`, chronology match, mismatch count 0, and exact bytes (transfer 20,127; encoded 56,508; decoded 193,856). Selected- and ready-mismatch frames are zero. Both six-run aggregates are stable with `reasons=[]`. The attribution artifact certifies **equivalent instrumented work and identity**, not causal timing. **SEPARATE NON-INSTRUMENTED CAUSAL R6 — PASS / EXIT 0.** `Tools/visual-regression/output/performance/c11-205-causal-phase-prime-fixed-2026-08-10.json` (7,070,900 bytes; `generatedAt=2026-08-10T18:05:31.888Z`) uses `apiInstrumentation=false` and GPU timestamps off across six 600-frame pairs. All 12 runs pass cleanly/non-structurally with empty failures, valid measurement, aggregation eligibility, and zero page/device errors. Pair summary is valid/status `certified`, `certificationEligible=true`, `reasons=[]`: 6/6 eligible pairs, three in each order, no ready-set exclusions, exact fingerprint/all eight segments/ready identity, and no outcome differences. Both aggregates are stable with `reasons=[]`. Valid causal measurements show a material WebGPU deficit: CPU-p95 run median **9.2024999993 ms** (8.305–10.0) versus WebGL **4.6499999985 ms** (4.4–7.6); wall-p99 median **23.302 ms** (20.605–24.802) versus **20.3025 ms** (19.702–21.302); navigation-to-stable median **52,099.36 ms** versus **48,116.65 ms**. `validGpuRunCount=0`, so no GPU bottleneck may be inferred. C11-205's local measurement blocker is discharged, and its shared runner, route-prime policy, and attribution-quality changes landed in Batch 1032 (`be0683c60d`). The row remains **NOT COMPLETE** while performance remediation and row-close reconciliation remain open. The now-valid WebGPU CPU/wall deficit becomes C11-168/root-cause optimization work; no feature removal or speculative GPU fix is authorized. |
| `C11-206` | WEBGL-FINAL-SHADER-STRUCTURAL-REVISION-MEMO [cheap pass exclusions before selector work; do not invalidate settled shader-chain memo for ordinary per-frame globe command dirtiness] | build-boot / terrain-imagery | P2 | perf | S–M | G2/G9/G10 | **W1 TAIL — QUEUED / TRANSITION GATES REQUIRED** |
| `C11-207` | HIZ-LAZY-SOA-AND-UNSUPPORTED-BACKEND-ACTIVATION [allocate the 1.3125 MiB sphere SOA only after supported WebGPU activation; WebGL opt-in disables once and remains allocation-free] | scene-core / Hi-Z | P2 | perf/resource-lifetime | S | G10 | **W1 TAIL — QUEUED / DEFAULT MEMORY** |
| `C11-208` | WEBGPU-GLOBE-SPEC-FLOOR-REDUCED-EFFECTS-LAYOUT [globe-specific group-1 layout omits model-only edge textures; retain every globe effect and add a bounded four-imagery-slot tier so limit-16 adapters do not blend one layer per draw] | terrain-imagery / effects-layout | P1 | perf/architecture | M | G2/G6/G10 | **COMPLETE — IMPLEMENTED / LANDED (Batch 777, 2026-08-01); forced limit-16 one+five-layer probe green; four-slot tier + multipass overflow preserve every effect; exit gate confirmed and administrative close recorded 2026-08-09.** *(Close authority: `DEFERRED_WORK.md`, landed Batch 1063 `21c9489185`, 2026-08-20.)* |
| `C11-209` | WEBGPU-EFFECTS-PLACEHOLDER-SINGLE-INITIALIZATION-SUBMIT [record depth, four CSM-layer, and six cube-face clears in one initialization encoder; reuse the existing depth view; remove no clear or placeholder] | effects-layout / submit-residency | P2 | perf/startup | S | G6/G10 | **COMPLETE — IMPLEMENTED / VERIFIED / LANDED Batch 1026; DIAGNOSTIC STARTUP SHAPE ONLY / NO TIMING CLAIM.** The cache initializer preserves all **11** distinct clears (base depth + four CSM layers + six cube faces), reuses the cached base-depth view, and records them through exactly **one encoder / one finish / one command buffer / one `queue.submit`**. Focused Edge `WebGPUEffectsDeviceCache` is **5/5**. Batch 1025 added fail-closed source-map/served-bundle provenance. Final schema-2 Edge/WebGPU artifact `Tools/visual-regression/output/performance/c11-209-effects-placeholder-startup.json` (`runId=81b6febc-f488-4a0b-b975-71c1d058ff4d`, SHA-256 `E370643CEEEEA318585EF00D1B3865A9CFA4258DACE6C6E063EE416CFFB6BA02`) is **17/17 PASS, exit 0**: the exact initial target vector is `{textures:3, views:13, encoders:1, passes:11, finishes:1, commandBuffers:1, submits:1}`; base, CSM layers `[0,1,2,3]`, and cube faces `[0,1,2,3,4,5]` retain exact view provenance; and 24 visible manual steady frames produce exact zero deltas for all seven fields. Fourteen globe tiles plus 20.9036% nonblack pixels, 384 quantized colors, and luma standard deviation 52.7167 make the run non-vacuous; all error lanes are empty. The named schema-2 archive is byte-identical, the prior schema-1 pass remains preserved, and no first-red exists because the first browser invocation was green. Cache reuse, invalidation/re-creation, and exact-once destruction remain focused-test covered. This is submit-shape evidence, not measured startup-time, frame-time, or FPS credit. |
| `C11-210` | WEBGPU-COMPUTE-COMMAND-PASS-ENCODER-INTEGRATION [executeComputeCommands currently supplies WebGPUContext where WebGPUComputeCommand requires GPUComputePassEncoder; restore public command-list integration and add an end-to-end contract] | scene-core / compute | P1 | correctness/test-red | S–M | G3/G10 | **W1 TAIL — LOCAL IMPLEMENTATION + FOCUSED EDGE + REAL EDGE/WEBGPU BROWSER GREEN; LANDING/P2 ACCEPTANCE OWED — NOT COMPLETE / NO FPS CLAIM.** **[Landed Batch 1071 `806a7f2ce4`, 2026-08-20; the fresh-bundle rerun ran tonight in the machine lane at `d4fa0ecf48` — probe 30/30 PASS, focused Karma green; the P2 boundaries stay owed — row stays open.]** Scene dispatch now uses the frame-local context; WebGPU closes any render pass, filters only native compute commands, enlists exact active-encoder settlement before borrowed encoding, and records one compute pass without a private encoder or submit. `WebGPUComputeCommand` has a callback-free encode seam while public `execute` compatibility remains pre/encode/post; the engine owns preparation, complete source/module/entry/layout cache keys, command-owned generated-pipeline provenance across engines sharing a pooled device, device claims, and pass-finally cleanup. `preExecute` runs once; `postExecute` settles only after that encoder segment submits, while abandonment/re-entrant ownership loss cancels and refuses encoding. Focused Edge/Karma passes **43/43** with **17,817 skipped**; the first attempt ran **0 tests** only because `CHROME_BIN` was absent. Package/integrated TypeScript, full build, lint/format, and diff checks are green; independent review found **P0=0/P1=0**. Final artifact `Tools/visual-regression/output/performance/c11-210-compute-command-list.json` (`generatedAt=2026-08-11T04:50:09.165Z`) records `status=PASS`, `pass=true`, `exitCode=0`, `failures=[]`, and **30/30** checks. Real normal and pick lanes each use one shared frame encoder/pass/dispatch/submit; a real wrapped 2D lane uses the Scene encoder plus one continuation submit, with the command on the first segment. Every product encoder finishes/submits once; product submits are **4**, the explicit excluded readback submit is **1**, each lane reads count **1** plus sentinel `0x11210ace`, hooks are **1/1/0**, and render/WebGPU/device/browser/request errors are zero. The preserved first browser red is harness-only: it discriminated on generic pipeline label `command` instead of the named pass descriptor, and Rectangle camera candidates produced no 2D continuation. **P2/open:** landing; replacement-device/device-loss, pooled multi-context, WebVR and other offscreen variants; async validation from malformed/untrusted commands can poison the borrowed frame encoder; duplicate/cross-mutating `executeMultiple` command objects are not snapshot-isolated; first-use unstamped external prebuilt handles retain caller trust; `persists` semantics remain deferred. WebGL and non-native-command behavior are preserved. |
| `C11-211` | MODEL-SCENE-GRAPH-JOINT-MATRICES-ONCE-PER-ANIMATION [update every runtime-node transform, then update all skinned-node joint matrices once; preserve WebGL/WebGPU animation, TAA velocity, and shadow variants] | model-frontend / animation | P0 | perf/correctness | S | G4/G5/G10 | **W1 — IMPLEMENTED / LANDED (Batch 774, 2026-08-01) / SOURCE+BUILD GREEN / ANIMATED BROWSER GATE OPEN** |

**Upstream v1.144 parity rows (maintainer ruling 2026-08-01 — WebGPU implementations required, WebGL-only ruling rejected; supersedes the "or a documented maintainer ruling records the API as WebGL-only" acceptance alternatives in `DEFERRED_WORK.md` `UP144-SNAP-WEBGPU` / `UP144-VECTOR-LAYER-WGSL`):**

| `C11-212` | WEBGPU-SCENE-SNAP-PARITY [implement upstream v1.144's experimental `Scene.snap` snap-to-geometry picking on WebGPU with an exact RG32Uint payload variant in the WebGPU pick-pass family, honoring `passes.snap`, `command.snapId`, `GlobeDepth.snapping`, and snapless occlusion; WebGL retains upstream's RGBA32F payload] | picking / derived-commands | P1 | parity | M | G7 | **W7 — PARTIAL: surface lifecycle/provenance, both-backend multi-frustum correctness, projection math, compact WebGPU payload, and real-Edge two-frustum gate are green.** Copies use the active encoder and map after submission; immutable provenance includes exact sample and far plane; asymmetric perspective/orthographic + viewport/DPR mapping is shared; WebGPU scissored reset and WebGL snapless-occluder erase add no pass/submission. RG32Uint cuts the 4K target set 189.84→126.56 MiB; ordinary pick is unchanged. Combined Node 69/69; Edge `farVisible/nearOccludes/farReturns` is true on both backends with TAA and clean errors. **OPEN P1:** SCENE2D slice depth, genuinely moving camera/cursor DPR/projection/edge/RTE matrix, aperture/logical-padding fixes, transient pooling, classification checkpoints, and broader producers. The RG32Uint **edge payload** (`UP144-SNAP-WEBGPU-EDGES`) is IMPLEMENTED 2026-08-02 (LANDED Batch 821) — emitter snap entry + payload pipeline variant + `ensurePickId` plumb + tail admission into the payload phase without loosening the FORK-34 guard, plus the shared `captureSnapView` half-pixel fix; Node 25/25, but its own browser gate (silhouette snap returns `isEdge: true` on both backends) is OWED. See the 2026-08-02 rider in the overlay. Do not mark complete. |
| `C11-213` | WEBGPU-VECTOR-LAYER-DRAPING-PARITY [WGSL twin for upstream v1.144's terrain-draped vector polylines: port `VectorCommon.glsl`'s HAS_VECTOR_LAYER sampling into `GlobeTerrain.wgsl`, bind the five `u_vector*` tile textures through the globe surface layouts (mind the reduced low-limit layout from C11-208), and route `VectorTileData` texture creation through the backend-appropriate path; the shader-set flag bit is already assigned at `0x400000000` (upstream's `0x200000000` collides with the fork's eclipse flag); SHADER_PAIRS_LOCKSTEP row required at landing] | globe / imagery | P1 | parity | M | G2 | **W7 — PARTIAL. IMPLEMENTED + LANDED Batch 827, streak defect FIXED Batch 834, PIXEL-VERIFIED Batch 835 — but browser acceptance is NOT fully discharged; do NOT mark complete.** WGSL twin `GlobeTerrain.wgsl::vectorPolylineRender` composites draped polylines between the underground tint and the translucency ramp, mirroring `GlobeFS.glsl`'s `#ifdef HAS_VECTOR_LAYER` ordering. **The row's "bind the five `u_vector*` tile textures" instruction was NOT followed, and could not be:** the five GLSL `texelFetch` tables are WebGL2's stand-in for buffer reads, and adding five sampled textures takes the C11-208 reduced low-limit layout from exactly 16 to 21 — over the WebGPU spec floor — so the globe pipeline would fail to create on default-limit adapters. The WGSL reads ONE read-only storage buffer at `@group(2) @binding(11)` (zero sampled-texture budget), packed by the new `WebGPUVectorTileResources.packVectorTileWords`. Gate is a runtime header word (`gridWidth == 0` ⇒ early out on the shared 32-byte placeholder), not a per-tile define, so no globe pipeline variant forks. `VectorTileData` realization routes through the `GLOBE_SURFACE` feature renderer's new `prepareVectorTileData` hook — no `isWebGPU` test in `Core/VectorPipeline.js`. Node: `vector-layer-draping.spec.mjs` 21/21 (GLSL-oracle ↔ WGSL-reader equivalence over a real `packPolylineGrid` bake + 5 mutation tests + naga validation). **Acceptance status (2026-08-06, `probe-vector-draping.mjs`, Batch 830 — 6 gates, run twice on Edge):** Batch 831 first run VERIFIED the core claim — draping renders on WebGPU (22,714 changed px vs WebGL 22,401; centroid 0.4 px; count ratio 1.014; both colour classes with the blue:red ratio in band; grazing-view Jacobian 1.25 webgl / 1.30 webgpu; three pan churn cycles → 0 console errors, 0 destroyed-buffer errors, 0 re-bake drift). The pre-fix symptom was a blank WebGPU pane; it is decisively not that. That same run FAILED gate B on a **real WebGPU-only defect** — faint horizontal streaks at y≈260/650 that moved the count only 1.4% and the centroid not at all, but widened the nadir bbox from x 451..710 to 252..863 (a count- or centroid-only check would have passed the frame; the bbox is the only leg that sees this class). Root-caused and fixed at Batch 834 — `vectorInverse2x2` answered a SINGULAR UV Jacobian with the ZERO matrix, so `length(screenFromUv * offsetUv) < lineWidth` was TRUE for the first segment in the cell at any distance; every terrain SKIRT quad is singular because `HeightmapTessellator` derives skirt UV from the unmoved edge lat/lon. WebGL only looked clean because GLSL's `inverse()` divides by zero and NaN comparisons are false — undefined behaviour, so **both** backends now carry an explicit determinant guard and agree by construction (`GlobeTerrain.wgsl` + `VectorCommon.glsl`; spec 25/25, WebGL pixels unchanged). Batch 835 re-ran and VERIFIED the fix at pixels: gates A/C/D/E PASS, WebGPU nadir frame visually clean, counts 22398 vs 22401 with RED **exactly** 5625 vs 5625, centroid delta 0.0/0.0, oblique bboxes IDENTICAL. **STILL OWED (why this row stays PARTIAL) — CORRECTED 2026-08-07: item (1) is DISCHARGED, only (2) remains.** ~~(1) gate B still fails, now in the OPPOSITE direction — WebGL's nadir bbox is 103 px WIDER than WebGPU's and is byte-identical to the pre-fix run, i.e. a PRE-EXISTING WebGL artifact the parity gate can only now see; filed `NEW-WEBGL-VECTOR-DRAPING-RESIDUAL-EXTENT` (LOW).~~ ✅ **Gate B PASSED at Batch 842** after the Batch-841 rebuild: both backends measure the identical nadir bbox `[451,19,584,747]` (delta **0**), counts 22396 vs 22397, gates A/C/D/E all PASS. `NEW-WEBGL-VECTOR-DRAPING-RESIDUAL-EXTENT` is RESOLVED in `DEFERRED_WORK.md`. The bbox predicate is symmetric and was NOT loosened — it is what measured every step of 199 → 103 → 0. *(Note: the DEFERRED_WORK entry originally published that identical bbox as `[451,19,607,747]`; `output/vector-draping/manifest.json` records **584**, and 607 was the stale pre-841 WebGPU value. Corrected there 2026-08-07.)* (2) **gate F is STRUCTURAL and is now the ONLY thing between this row and a clean acceptance** — its in-build half measures 0 changed px on both backends, but its cross-build half needs a pre-change baseline that does not exist. |

**Existing-owner corrections from the same audit (no duplicate IDs):**

- `C11-62` must first repair `SceneOctree` plane-mask constants, conservative
  root containment, and sphere-only eligibility before persistence or automatic
  promotion. Globe terrain remains in its quadtree and 3D Tiles in its own
  traversal.
- `C11-30/54/87/94` are prerequisites/aliases for `C11-204`; the current
  post-PVS count-only GPU visibility path is not an architecture to optimize in
  place.
- `C11-187` remains the narrow conservative SOA fallback; `C11-207` owns lazy
  allocation/backend activation and `C11-204` owns identity/RTE/placement.
- `C11-76` must include active ComputeInstance, FlowField, and opt-in point-cloud
  GPU-LOD private submitters in addition to Ocean, Weather, and EntityCluster;
  all should record on the frame encoder and retain only an off-frame fallback.
- `C11-60` also owns per-frame bind-group/upload churn in user/library stages,
  motion blur, contact shadows, SSR, and NPR; genuinely dynamic uniforms remain
  dynamic. **CLOUD CACHE SLICE IMPLEMENTED / VERIFIED / LANDED Batch 1019
  (2026-08-11):** cloud primary + three cascade shadow bind groups use a bounded
  four-slot exact-identity cache keyed by layout, buffers/ranges, views and
  samplers; resource changes rebuild only the affected slot and teardown clears
  the cache (cache leaf 3/3; focused attachment-plus-cache union 45/45).
  **IBL SLICE IMPLEMENTED / VERIFIED / LANDED Batch 1022 (2026-08-11);
  moving-performance evidence owed:** image-based-lighting SH uses
  one 40-float buffer per live device generation, with zero allocation/upload
  on stable frames, one upload for an in-place mutation, and one zeroing upload
  on removal. Generation invalidation now detaches cache/published/cube ownership
  before native destruction and independently drains every stale handle, so one
  lost-device `destroy()` exception cannot block replacement generation. Focused
  Edge/Karma executes **3/3** with **17,876 skipped**, including the injected
  destroy-failure recovery. These close only the named churn slices;
  C11-60 remains PARTIAL and no FPS credit is claimed before the moving route.
- `C11-194`'s IBL recovery half **LANDED Batch 1022 (2026-08-11)** after the
  destroy-failure audit and focused Edge verification. Its cache requires exact
  `(owner, context, GPUDevice,
  resourceGeneration)` ownership, invalidates before duplicate-frame skipping,
  detaches old native and published ownership before best-effort sibling drain,
  and retains decoded KTX2 CPU data for re-upload. Focused Edge recovery is
  **3/3**. Nested clipping recovery and a real
  replacement-device browser run remain open, so C11-194 stays PARTIAL.
- `C11-213` has a **LOCAL 2026-08-09 ownership/recovery correction; landing
  owed.** **[Landed Batch 1073 (`59472891b9`), 2026-08-20; no browser lane
  claimed at landing.]** Both CPU grids are completed before one backend claim. WebGPU now
  realizes one storage buffer and zero WebGL textures; WebGL realizes each
  present family plus shared primitive tables once. The stage-2 CPU grids are
  retained and reconciled during pre-render preparation, so a new exact
  `(GPUDevice, resourceGeneration)` tuple destroys the old native buffer and
  repacks and uploads once rather than falling permanently to the placeholder. The
  draw/bind-group path performs no preparation. Node lifecycle/ownership is
  **31/31** and TypeScript is green. Gate F remains the row's terminal blocker,
  so C11-213 stays PARTIAL.
- `C11-165` also covers synchronous first-toggle pipelines in optional effects
  and Ocean compute, using generation-tagged async preparation while retaining
  the last complete pipeline.
- `C11-193` also owns the selected-consumer demand registry. Its narrow
  discarded-manager slice is implemented: tile models borrow the tileset
  manager at construction without taking or destroying tileset ownership;
  standalone models retain private ownership. C11-193C now collects exact
  manager ticks through the primitive phase and drains final same-frame
  DEMANDED/UNKNOWN work before PROVEN_NONE without dropping either class. A
  wrapped-2D first half holds NORMAL work for late second-half promotion; the
  bounded scheduler gives MANDATORY/escalated work a separate path from its
  one deferrable slot, and deferral always arms a lossless resume. Demand still
  must never gate a refresh — see the no-starvation contract in
  `WebGPUEnvironmentRefreshScheduler`'s module docs and
  `C11-REVIEW-2026-08-01` defect 3 — **that review lives at
  [`WEBGPU_DEBUGGING_LOG.md`](WEBGPU_DEBUGGING_LOG.md) §`C11-REVIEW-2026-08-01`
  ("eight defects fixed while landing the Codex C11 changeset as Batches
  772-781")**, not in a file of its own *(citation resolved 2026-08-09, handover
  audit FIX 22 — the bare id read like a missing document)*. The local browser
  gate certifies simultaneous-manager isolation and exact Scene submission;
  moving causal timing, landing, and broader recovery remain open. Regional
  and weather outputs remain manager-local rather than becoming a shared
  output cache. `C11-193` remains **PARTIAL**. *(The A/B/C packet landed 2026-08-12 at
  `b20234a16b`; of the remainder list above, "landing" is discharged — moving
  causal timing and broader recovery stay open.)*
- `C11-194`'s immutable defaults/layouts are device-generation shared, and the
  2026-08-02 recovery slice (landed Batch 819) now rejects/disposes stale model and
  compatibility resources by exact tuple; IBL generation recovery landed in
  Batch 1022 with focused Edge 3/3. Higher-level texture re-upload, nested
  clipping recovery, and live replacement-device evidence keep the
  row partial; no global decoded-source replay journal is authorized.
- `C11-205` must distinguish common traversal inputs from backend-dependent
  `Model3DTileContent` readiness and frame-rate-sensitive request cancellation;
  no SSE/hysteresis change is authorized until ready/request identities explain
  the resident mismatch.
- Consumer-driven MRT/G-buffer allocation remains `C9-10-CONSUMER-DRIVEN-MRT`
  / `FAR-403-C0`; do not create a second owner or hard-disable the attachment.
- `C11-27/29/77/94/185` feed `C11-202`; they do not independently authorize
  removal of shared Model processing.
- `C11-34` remains the owner for tying WebGPU terrain-buffer leases to quadtree
  lifetime and a submission-safe byte-budgeted grace LRU.
- `C11-77/194` must report logical versus per-device resident bytes without
  charging shared defaults once per tile.
- `C11-52` retains the legacy point/spot-light RTE follow-up: absolute ECEF f32
  light positions should use the camera-relative packing already used by
  clustered lighting.

**Append accounting:** +20 numbered (`C11-192..211`), zero seeds. Numbered
range is now contiguous `C11-01..211`; repository-wide collision search found
zero earlier uses before this append.

**2026-07-28 representative-route attribution note.** The first real-content
pair proved that equal frame counts do not imply equal streaming work:
WebGL generated 1,595 terrain tiles while WebGPU generated 1,784 (11.2%
symmetric delta). Timing from such a pair is not causal renderer evidence.
`C11-168` now owns two separate lanes:

- production-like streaming remains time-driven and invalidates both legs
  when terrain requests or generations differ by more than 5%, generated-tile
  key Jaccard is below 0.95, or measured frame counts differ by more than 5%;
  an r6 closure needs at least five surviving pairs with at least two AB and
  two BA;
- resident/high-cache attribution is fixed-frame, prewarms and convergence-
  checks the identical moving route, and rejects any measured terrain request,
  generation, or `globe.tilesLoaded === false` frame. This is renderer
  attribution, not a claim about production streaming behavior.

Both lanes record exact canvas/drawing-buffer/DPR/resolution scale, current
direct versus upsampled terrain LOD, validation-phase GPU errors, per-LOD
terrain work, and runner/helper/manifest/camera-track hashes. The canonical
1280×720 lane still does not satisfy the maintainer's actual split-session
capture requirement; isolated exact-pane and simultaneous split lanes remain
open.

### 1.30 CLOSE-OUT MINT (2026-08-07 — APPEND-ONLY, collision-verified)

Minted by the campaign close-out docs reconciliation (`CLOSEOUT_PLAN_2026-08-07.md` Lane A / CO-1).
**Append-only**: no existing ID was renumbered, reused or removed. `C11-214` was verified free
before minting — `grep -o 'C11-2[0-9][0-9]'` over this document returned `C11-200 … C11-213` with
no `C11-214`, and the only occurrence anywhere in `migration_doc/` was the close-out plan's own
instruction to mint it. The numbered range is now contiguous `C11-01 … C11-214`.

**Why it is being minted now.** §1.23's append accounting deliberately left this item unnumbered
("the B699 shared-cause diagnosis … remain **G5-owned** and are numbered when that diagnosis slice
is cut (G5 §G5.0) — deliberately NOT minted here"). The diagnosis slice has never been cut, so the
item has been carried for three weeks as prose in §4 point 7 with no row, no ledger entry and no
wave — invisible to every scoping pass over §1/§3.2. Minting the ID does **not** start the work; it
makes the work countable. Scope is copied from §4 point 7 unchanged.

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-214` | B699-SHARED-CAUSE-DIAGNOSIS [ONE instrumented diagnosis covering BOTH Batch-699 findings — `NEW-WEBGPU-TILE-FEATURE-TRANSLUCENT-COLOR-COMPOSITE` + `NEW-WEBGPU-B3DM-TILE-CONTENT-PICK-EMPTY` — whose recorded shared hypothesis is that `FLAG_HAS_FEATURE_ID_ATTRIBUTE` is never set for b3dm content. §4 point 7 requires the shared diagnosis to run BEFORE either finding is sliced] | tiles-model-parity | P1 | correctness/diagnosis | M | G5 §G5.0/§0 | W4 — sequenced **ahead of** `C11-82`/`C11-84` per §4 point 7 |

---

## 2. Rules (inherited verbatim from Campaign-9/10 §1 — do not weaken)

**★ GOVERNING PRINCIPLE (maintainer-ratified 2026-07-18, `C11-00B` sweep — binds every parity/defaults
slice in this campaign).** NEVER remove an additive WebGPU capability to reach parity — only change the
DEFAULT to match WebGL, keeping the enhancement reachable as a TOGGLE. **A parity fix that DELETES a
feature is WRONG.** This is the operative reading of rule 1 for the whole ratified parity family in
§1.23 / §7.0 (enhanced-ocean, night-lights, AutoExposure, sunBloom, sun-blend, `usePostProcessSelected`,
and the OIT-wiring lane): default classic/parity + preserve the enhancement behind a flag; land no slice
that reaches parity by amputation.

1. Never remove, hide, default-disable, bypass, or visually weaken a feature for a metric. Safety
   containment is correctness work, not a performance win.
2. Follow the WebGL globe architecture: WebGL and WebGPU consume the same backend-neutral
   `QuadtreePrimitive`/`GlobeSurfaceTileProvider` selected tiles. Never replace terrain quadtree,
   3D Tiles traversal, or voxel octree with the optional general `SceneOctree`; optimize their
   post-selection work and give non-PVS effects explicit owners.
3. Unknown attachment demand keeps MRT; unknown bounds execute the effect; unknown serial retains the
   resource; uncertain GPU visibility uses the correct fallback. Unknown demand stays conservative —
   never guess a skip.
4. No absolute planetary ECEF `f32` reconstruction before camera subtraction, including previous
   frames and GPU culling/LOD data.
5. Node/Playwright and Microsoft Edge only for browser automation. The moving multi-altitude camera
   track is mandatory; idle soak/FPS is not performance evidence.
6. Land one concern per slice. Roll back the optimization, never the feature. Tests and counters remain.

**Perf promotion rule (Campaign 9 §12.6, inherited verbatim).** An individual slice may raise a
promoted-optimization banner only when, versus its on/off/restored oracle on the moving-altitude
route, it improves a **named unsaturated stage p95 by ≥5%** OR exceeds **3× the measured run-to-run
noise**, with no route-segment p99 regression and no WebGL regression beyond the predeclared budget.
**A truthful miss with green mechanics (correctness oracles pass, structure changed as designed) is a
VALID, COMPLETE result** — record the honest number in the ledger and claim no banner. Structural
correctness/parity slices (the pick fleet, the frustum-count collapse to WebGL parity) land on their
own oracle regardless of the timing delta.

**Standing policy constraints carried into C11 (register §"Standing policy", C9 §3.3 record):**
WebGPU MRT-OIT default-off is RATIFIED FAR-003 containment (re-enable owner = FAR-003/T7, inactive
until post-Gate-F stop/go — do NOT flip it for a metric); `renderer:'webgpu'` graceful-fallback-
with-warn (strict via `strictRenderer`); the leave-dirty worker contract + orchestrator-only landing
(G10 §B2); machine-safety block verbatim in every brief (G10 §B3; ONE Edge at a time; 5-min watchdog;
scan generated scripts for unbounded loops; 32 GB RAM); push/commit as **kurtyoung-dev**.

---

## 3. Gates

Adapted from the C10 A/B/C/D set. Gate D is the C11 measured checkpoint; the **C8-upstream-contract
certification (`C11-137`) is the campaign EXIT gate** per G9 (§A.16 — "dead last").

| Gate | Required to pass | Stops promotion when |
| --- | --- | --- |
| A — launch seal / attribution | Fresh C11 launch seal on one clean hash; exact source/build identity; clean + API lanes on the moving-altitude route; deterministic offline boot; known-error ledger. **Anchor = the recorded `C9-30` clean-r5 artifact** (`campaign9-c9-30-checkpoint-clean-r5-2026-07-17.json`, WebGPU 5.20 / WebGL 5.31 ms whole-route CPU p95) or, if C10-30 recorded a fresher anchor, that — never re-derive a fresh baseline on the new tree; Gate-A `B8015811…` (WebGL 5.50 / WebGPU 7.51 ms) is the labelled fallback. | A route is incomplete, rendering pauses, hashes differ, clean/instrumented data mix, or device errors are unexplained. |
| B — bounded correctness / feature preservation | Every slice's own semantic + visual oracle green; the pick-fleet WebGL-parity matrix; frustum-count/env-pixel parity; byte-identical off-paths and kill switches. The standing reds (`C11-01` pickposition, `C11-11` spheres drift, bare-globe interior) tracked and **pre-attributed** via their W1 diagnoses. | A public result, feature, mode, depth/history contract, or visual is weakened; a standing red turns a NEW red. |
| C — default hot path | Per-slice on/off/restored evidence on the moving-altitude clean + API lanes; ≥5% named-stage p95 or >3× noise for any banner; no route-segment p99 regression; no WebGL regression beyond the predeclared budget. | Improvement is within noise, a route segment regresses, or an unknown consumer is skipped. |
| D — measured checkpoint (`C11-GATE-D-CHECKPOINT`) | The perf-tranche checkpoint on one rebuilt hash vs the anchor: **≥10% whole-route + ≥15% near-ground (seg 5+6) WebGPU CPU-p95 OR >3× noise**; feature-loss gate green (standing reds pre-attributed, NO new red); honest per-stage attribution + promote/iterate verdict recorded. A truthful MISS with green mechanics is VALID = record "iterate" + per-stage attribution + gated-tail recommendation. | A lane is absent, historical evidence is overwritten, the anchor is re-derived on the new tree, or a new visual red appears. |
| **EXIT — C8 upstream-contract certification (`C11-137`)** | **RATIFIED 2026-07-18: BOTH lanes** — the campaign CLOSES on the **deterministic `C11-137` C8-contract gate with truthful counts** (the focused/unit lane is the close bar); the **full real-scene suite additionally runs when a real adapter is available** and is a **recorded follow-up, NOT a close-blocker** (resolves G9 Q1/Q2, §7.0/§7.2). Full engine + widgets + complete-engine suite run on the **stabilized** launcher (`C11-133`), offline lane isolated (`C11-134`), spec bundle fresh (`C11-132`); truthful executed/passed/skipped/failed counts with every skip reasoned (WebGL2-only per Principle 4, requires-network per A.3, requires-adapter per A.4); zero unowned reds; the four owner items (`C11-138`/`C11-142`/`C11-143`/`C11-144`) landed; GraphicsCapabilities Renderer-triage re-asserted zero-attribution; committed certification report = the C11 exit evidence. | Any owner item is open, the environment is flaky, a skip is a silent pass, or a DataSources failure is unowned. The campaign does NOT certify — say so plainly (honest-partial). |

R0/R1 infra, counters, probes, and structural-correctness slices may land before Gate B. The gated
tail (§6) is not activated by any of these gates alone — it additionally requires the Gate-D verdict
AND fresh maintainer sign-off.

### 3.2 Live execution ledger (seeded — every C11-id NOT STARTED at launch)

> ⚠ **PRECEDENCE — READ THIS BEFORE TRUSTING ANY CELL IN THIS TABLE** *(added
> 2026-08-09, handover audit FIX 20; this collapses the §1-vs-§3.2 dual-ledger
> hazard).* This document carries **two** status surfaces: the §1 canonical ID
> table, whose last column has been updated in place as rows progressed, and
> this ledger, most of whose rows are still the **launch-time compressed RANGE
> rows** that seeded every id **NOT STARTED**. **On any disagreement the §1 row
> cell WINS, and a stamp with a higher BATCH NUMBER wins over a lower one
> regardless of printed date.** A range row here saying "NOT STARTED" is
> evidence of nothing except that nobody has carved that id out yet — it must
> never be read as a status claim about an individual id inside the range. When
> a row inside a range progresses, **carve it out into its own row here**
> mirroring §1's status + batch/hash (the `C11-149` row below is the pattern).

Status vocabulary (identical to C9/C10 §3.2): **IN PROGRESS · COMPLETE · PARTIAL / PAUSED · BLOCKED ·
DEFERRED · CONDITIONAL NOT TRIGGERED · NOT STARTED**. Every brief mandates: update your row here with
status + evidence, INCLUDED in your landed files. A missing ledger update is a landing defect. All
185 schedulable/gated/seed rows + the 3 intake rows below seed **NOT STARTED** with the guide pointer;
evidence-pending (**plus the 10 launch-reorder appends §1.23 — `C11-157..165` + `C11-SEED-27` — also
seeded NOT STARTED / DEFERRED below**). (Rendered compact — one line per id; the orchestrator expands a row to the C10-style
evidence paragraph as each slice lands.)

| Rows | Seeded status | Guide pointer | Evidence |
| --- | --- | --- | --- |
| `C11-00`, `C11-00B`, `C11-GATE-D-CHECKPOINT` | `C11-00` DEFERRED (orchestrator); **`C11-00B` COMPLETE (2026-07-18 fallout-intake + launch-reorder sweep — this doc)**; `C11-GATE-D-CHECKPOINT` NOT STARTED (anchor input = `C11-SEED-27` clean-env re-measure) | G10 §B6 / §B7 | C10 closed Batch 711 `9a52717cf2`; sweep output = §1.23 + §7.0 + §4 |
| `C11-01 … C11-10` (pick) | NOT STARTED | G1 §A/§0 | evidence-pending. **UPDATE 2026-08-21 (queue-truth pass): `C11-01` is carved OUT of this range — see its own row below.** |
| `C11-01` (NEW-WEBGPU-PICKPOSITION-CONVERGENCE-REGRESSION) | **pickPosition-convergence half CLOSED — fix landed Batch 1069 (`153e4bf010`, 2026-08-20: the unresolved-readback branch now calls `scene.requestRender()`, so request-render mode converges instead of stalling — exactly the `REVERSED_Z_MEASUREMENT_SPIKE_2026-07-19.md` §8.2 mechanism); behaviorally certified on real hardware Batch 1085 (`7194beb31f`, `ScenePickPositionConvergenceSpec.js` 4/4 on a real Edge GPUDevice, incl. the requested-frame-count discriminator). Two non-blocking residuals filed in `DEFERRED_WORK.md` (stale-on-arrival readbacks > 4 frames; global single-slot dedupe). The Batch-1069 message also REFUTES `PICKING_ARCHITECTURE_STATE_2026-08-17.md:407` finding LD-07 — `prePassesUpdate` clears the cache every frame, so the memo lives one frame and was kept deliberately. THE COMPANION HALF STAYS OPEN: the bimodal offline black-globe-interior repro (center avgRGB 2,2,2, flips per session; `WEBGPU_DEBUGGING_LOG.md:1380-1381`) is untouched by both commits.** | G1 §A/§0 | Batches 1069 + 1085 |
| `C11-IC-01` (pick-fleet log-depth intake check) | **DONE — completed in C10** (C10-11 flipped `_pickLogDepthWriteEnabled` fleet-wide, Batch 709; see §4 :744 and `QUEUE_2026-07-16_CAMPAIGN10.md:152`). *(Ledger drift fixed 2026-07-23 — the NOT STARTED seed shipped in the launch commit and survived Batch 718.)* | G1 §A/§0 | C10 evidence |
| `C11-12`, `C11-14 … C11-19`, `C11-21 … C11-25` (standing-reds) | NOT STARTED | G1 §B (C11-13 → G6 A1) | evidence-pending. **UPDATE 2026-08-12:** `C11-11`, `C11-13`, and `C11-20` are carved OUT of this range because each has progressed and carries its own row below. **UPDATE 2026-08-21 (Batch 1114):** `C11-14`, `C11-17`, `C11-19`, `C11-22`, and `C11-24` are carved OUT — the C11-P1 worker package landed fixes (or, for `C11-17`, exposed staleness); each carries its own row below. `C11-21`/`C11-25` were STALE-CLOSED and `C11-15`/`C11-16`/`C11-18`/`C11-23` re-scoped or untouched per `C11_PREMISE_DISPOSITIONS_2026-08-21.md` where applicable. |
| `C11-14` (NEW-WEBGL-ANISO-GLSL-BROKEN) | **LANDED-PARTIAL — Batch 1114 (2026-08-21).** `MaterialStageFS.glsl` anisotropy tangent selection split: the old unconditional `#else` called `computeTangent` with normal-texture UV derivatives that don't exist without `HAS_NORMAL_TEXTURE`; now `#elif defined(HAS_NORMAL_TEXTURE)` keeps the screen-space derivation and a new `#else` builds a stable frame from the geometry normal alone. Spec `c11-14-webgl-anisotropy-tangent-fallback` 3/3. **Owed:** browser leg (anisotropic model render, both backends). | G1 §B | Batch 1114 |
| `C11-17` (NEW-WEBGPU-CANVAS-BACKGROUND-COLOR-PARITY) | **RESOLVED-STALE — the symptom was already fixed at Batch 802; this queue row never recorded it.** Confirmed by the 2026-08-21 W2-D review (independent premise re-derivation, Principle 10). **Owed:** `probe-env-background-clear.mjs` browser leg remains un-run; run it before certifying. | G1 §B | Batch 802; review 2026-08-21 |
| `C11-19` (BUG-GLOBE-PIPELINE-NAME-AXES) | **LANDED-PARTIAL — Batch 1114 (2026-08-21).** Globe descriptor names now carry the full axis set (stride/mercator/geodetic/sample markers); the pick derivation forces `samples=1` via regex rewrite with a graceful console-error fallback (a marker-less name falls through unmodified, never throws); `selectPickPipeline` wiring is spec-executed against the real extracted source. Spec `c11-19-globe-pipeline-name-axes` 5/5; `pipeline-key-aliasing` 63/63. **Owed:** browser leg + the FLEET-AUDIT half (other renderers' descriptor-name axes — filed in `DEFERRED_WORK.md`). | G1 §B | Batch 1114 |
| `C11-22` (NEW-WEBGPU-DEBUG-DEPTH-PLANE-GATE-PARITY) | **LANDED-PARTIAL — Batch 1114 (2026-08-21).** `WebGPUContext` `environmentState.useDepthPlane` now honors `scene.debugSkipDepthPlane` (one-line gate parity with WebGL). Spec `c11-22-debug-depth-plane-gate-parity` 3/3. **Owed:** browser leg. | G1 §B | Batch 1114 |
| `C11-24` (NEW-WEBGPU-RENDERCOMMAND-STALE-PASS-SLOT) | **LANDED-PARTIAL — Batch 1114 (2026-08-21).** `RenderCommand._executeWebGPU` executed native commands against `context._currentRenderPass` (a stale/never-populated slot) instead of `context._currentRenderPassEncoder`. Spec `c11-24-render-command-pass-slot` 3/3. **Owed:** browser leg; also filed `WebGPUContext.buildRenderCommand` missing-override (Principle 9) in `DEFERRED_WORK.md`. | G1 §B | Batch 1114 |
| `C11-11` (NEW-HIGH-DENSITY-SPHERES-CROSS-BACKEND-DRIFT) | **RE-ATTRIBUTED — Batch 919 (orchestrator machine lane, 2026-08-07). The scene-level cross-backend red was THE INSTRUMENT, not the engine.** *(Carved out 2026-08-09, handover audit FIX 20 — it was covered by the `C11-11 … C11-25` NOT STARTED range while §1 recorded the re-attribution.)* `high-density-5k-spheres-setup.js` created its mulberry32 rng at MODULE scope and called `addInstances(webglViewer)` then `addInstances(webgpuViewer)` against the SAME stream, so WebGL consumed draws 1..15000 and WebGPU 15001..30000 — **the two backends never rendered the same sphere set, by construction, since Batch 224**, while the header comment promised seed-identical positions. One-line fix (re-seed per viewer): cross-backend diff **8.60% → 1.48% PASS**, residual is sphere-silhouette antialiasing rims on identical geometry (PNG read). **Row scope remaining:** decide whether the 1.48% residual is acceptable or needs its own repair. Unblocked `C11-139` in the same batch. | §1.2 / G1 §B | §1 row `C11-11` is the authority |
| `C11-20` (C-R12-PER-OBJECT-CACHES) | **PARTIAL — LANDED Batch 778 (2026-08-01).** *(Carved out 2026-08-09, handover audit FIX 20.)* Point/Label normal collection teardown is fixed; the **nested / device-loss walk remains open**. Wave W3. | §1.2 / G1 §B | §1 row `C11-20` is the authority |
| `C11-13` (NEW-VOXEL-INSIDE-CAMERA-BLACK) | **COMPLETE — IMPLEMENTED / LANDED Batch 1031 (`348063f48b`), 2026-08-12; PHYSICAL EDGE, FOCUSED KARMA, AND TEN-PROBE PRESERVATION ACCEPTED.** The proxy preserves the outside 36-index prefix byte-for-byte, appends its exact reversed winding, and selects `firstIndex=36` only for finite effective-model containment. Odd-reflection parity is XOR-correct; color/object-pick/cell-pick/velocity remain explicit `uint16`/36-index draws; lazy commands refresh each frame. Static policy/strict-slice/mutant gates were **6/6**, the adjacent fleet **84/84**, and focused `WebGPUVoxelRenderer` Karma **6/6**. The independently audited Edge artifact was **64/64**, with 14 PNGs, 28 command snapshots, the exact seven-waypoint `firstIndex` sequence `[0,36,36,36,36,0,0]` for all four variants, minimum IoU **0.993935**, and exact outside byte identity/return. Canonical equals immutable SHA-256 `40C4DE13F77B737064798E0A6F69EDFDBB3F18EA33941918EA1FAF04E87B4590`; first-red SHA-256 remains `7A735178E616AAC7646C0513E6116DF5C5C2109E245ECCC24AA7417BDD1D234C`; independent audit was **P0/P1/P2 = 0/0/0**. Preservation rows 1–6 passed; fresh row 7 proved exact republish `serial 1→3`, `generation 1→9`, eviction `16`, and byte-identical A1/A2 PNG SHA-256 `D728015E91AB205906A008BABDD94C91D38950D522730201B589E2BF7AB8ED4C`; rows 8–10 passed at IoU **0.986/1.000/0.994** with zero errors. ⚠ **CROSS-CAMPAIGN:** [`QUEUE_2026-08-09_CAMPAIGN18.md`](QUEUE_2026-08-09_CAMPAIGN18.md) §5 lists this row as a coordinated dependency it must not duplicate, re-file or renumber. | G1 §B / G6 A1 | Product `348063f48b`; acceptance harness/repairs `54c97766dc`, `1592ea290d`, `0db658197f`, `532cad5e1f`, `8a9178d99c`, `3b9f2027a7`, `3742a84b22`, `b93b012479`, `439ccb100a`, `f54d58cdd4`; physical + native legacy-probe evidence complete |
| `C11-26` (splat producer), `C11-IC-02` | NOT STARTED · BLOCKED-ON-MAINTAINER | G5 §G5.1 | evidence-pending |
| `C11-27 … C11-31` (model-frontend) | NOT STARTED | G4 §1 | evidence-pending |
| `C11-32 … C11-34`, `C11-36 … C11-42` (terrain-imagery) | NOT STARTED | G2 | evidence-pending |
| `C11-35` (ocean-normal per-call re-upload) | **COMPLETE-BY-ALIAS (2026-07-23 reconcile)** — same `DEFERRED_WORK` entry (`NEW-WEBGPU-OCEANNORMAL-PER-CALL-REUPLOAD`) as `C11-166` (§1.25), landed Batch 717 `a0ca50bea7`. G2 guide §1 scope verified identical to the landed fix (source-identity memo mirroring `_resolveOrUploadMaterialTexture`). Close here; do not double-schedule. | G2 | Batch 717 |
| `C11-43 … C11-50` (attachment-topology) | NOT STARTED | G3 | evidence-pending |
| `C11-51 … C11-57` (rte-taa) | NOT STARTED · **no cluster guide** | register §7 + PR §4/§8 | evidence-pending |
| `C11-58 … C11-59`, `C11-61 … C11-63`, `C11-SEED-01` (frame-delta) | NOT STARTED | G4 §2 | evidence-pending |
| `C11-60` (cache-hit-path allocation riders) | **PARTIAL — CLOUD CACHE SLICE LANDED Batch 1019; IBL SLICE LANDED Batch 1022; MOVING ROUTE OWED.** Cloud-shadow bind-group identity is bounded and IBL SH storage is stable per device generation; focused contracts and the 3/3 IBL Edge gate are green. Remaining user/library stage churn and moving-route allocation evidence keep the row open. | G4 §2 | Batch 1019 cache; Batch 1022 IBL |
| `C11-61` (NEW-CLUSTERED-ENABLED-ZERO-LIGHT-FRAME-ZERO-WORK) | **LANDED-PARTIAL — Batch 1124 (2026-08-21).** The dispatcher tracks the last-written (active, area) light counts and elides the params write when both are zero and the buffer already holds zeros (N→0 still writes exactly once); the scene hook hoists its light scratch to module scope (reset by `.length = 0`; the dispatcher copies inputs out synchronously and the hook has a single synchronous call site, so no interleave is possible), skips a settled zero-light frame BEFORE ending the render pass, and keys the buffers stash per dispatcher in a WeakMap so its identity is stable across the transition. Station-3 review re-derived the premise at HEAD, executed the hook against fakes (8/8), and killed all eight mutants incl. the inertness form and a skip-after-pass-end reorder; every consumer of the params buffer reads viewport/near/far only behind the active-light-count gate (traced through all 24 consumer shaders), so the elided write is safe — that invariant is now documented at the skip. Karma spec tightened (zero dispatches / zero params writes / zero end-resume rounds on a settled zero frame; exactly one write on the transition; stash identity exact); new Node spec extracts and executes the real dispatch body (3/3). **Owed, recorded rather than closed:** the ledger's stated evidence plan — an enabled-zero-light phase in `probe-clustered-zero-work-route.mjs` asserting zero per-frame work, and byte-identity on `probe-clustered-matsweep` / `probe-clustered-phong` after the scratch conversion — was substituted by the Node + Karma specs under the no-browser worker constraint; the probe phase stays owed to the machine lane, and the Karma spec has not run on hardware. | G4 §2 | Batch 1124 |
| `C11-151` (NEW-WGSL-STRING-COMMENT-STRIP) | **LANDED — Batch 1125 (2026-08-21). PREMISE CORRECTED AT LANDING:** HEAD already stripped WGSL comments under `minify` with a regex that deleted every `//>>` directive (1,510 of 1,510 across 84 gated shaders — the preprocessor became a no-op discriminator and 63/84 shaders failed naga parse), reachable only on `gulp build --minify` / `buildWatch --minify` and a dev-server staleness path; release and variant minified bundles never reconverted WGSL and shipped unstripped, correct modules. So this row is a correctness fix first, size win second. Landed: a line-oriented `stripWgslComments` (directive lines byte-exact, quote/escape and block-comment aware, unterminated quote leaves the line untouched, per-line terminators kept) behind a `wgslModuleContents(source, minify)` seam the spec proves both ways; `wgslToJavaScript` writes its state file on a minify-mode change; `buildCesium` regenerates the 324 WGSL modules per bundle (`packages/engine/Build/minifyWgslBundle.state`, gitignored) so release/variant bundles actually benefit. **Measured (buildAllVariants, six bundles, 142 s):** minified dual −1,285,259 B (11,440,920 → 10,155,661), minified WebGPU-only −1,285,259 B (10,718,914 → 9,433,655), minified WebGL-only +13,620 B (the 259 named-export shims that survive tree-shaking), unminified bundles content-equivalent (identical 2,111-module set; byte differences are esbuild ordering and identifier numbering — HEAD's own `gulp build` and `buildAllVariants` differ by 1,494 B, so byte identity across invocations was never a property of this pipeline). `Tools/variant-smoke-test.mjs` PASS on all three variants post-strip (stripped WGSL drives variant selection at runtime). Specs: `Tools/build-infra/wgsl-comment-strip.spec.mjs` 11/11 incl. the seam's unminified byte-identity and a real-shader directive check; inertness mutation of the seam caught. Review evidence: 103 adversarial fixtures, full-corpus 1,510/1,510 directives byte-exact, `preprocess(strip(s), D) === strip(preprocess(s, D))` over 496 define sets with a live negative control, naga byte-identical over 408 runs. **Follow-up filed:** `NEW-GLSL-STRING-MINIFY-REFRESH-ASYMMETRY` (GLSL gets no per-bundle refresh). | G9 §B.4 | Batch 1125 |
| `C11-152` (NEW-EMPTYMODULE-STUB-HARDENING) | **LANDED — Batch 1125 (2026-08-21). PREMISE CORRECTED AT LANDING:** `SharedContext.js` is not under the stubbed `Source/Renderer/WebGPU/` path and webgpu-only builds redirect nothing to `emptyModule.js` (only GLSL strings to `emptyShader.js`; the stub is reachable in webgl-only builds), so the register's `instanceof SharedContext` crash was never reachable — `Symbol.hasInstance` lands as prospective hardening for the leaf-strip seed `C11-SEED-20`, not a live fix. The get trap now whitelists `Symbol.hasInstance` (`() => false`), keeps `__esModule` / `Symbol.toStringTag` / `then` as the load-time introspection set, and throws at property READ for everything else (a contract inversion from HEAD's return-a-thrower form; probed empirically — typeof / keys / spread / for..in / getPrototypeOf / await / esbuild `__toESM` silent, prototype / constructor / default / coercion / call / construct loud; flagged as the surface to re-check when the leaf strip stubs more modules). The named-export gap is closed: `bundleVariantPlugin` resolves stubbed modules into a `cesium-empty-module` namespace whose onLoad parses the original with the TypeScript parser and binds default plus every runtime export to the one Proxy (proven against real esbuild; HEAD's plugin fails the same fixture seven times; all 259 stubbable modules / 1,094 exports generate valid shims). Live consumer: `ContextFactory.ts`'s destructured dynamic import now gets the Proxy and the explicit error instead of `undefined is not a constructor`. `Tools/build-infra/empty-module-stub.spec.mjs` 7/7 incl. the namespace/suffix/pluginData pins; the existing plugin spec keeps all 16 assertions. `npm run test-build-infra` (19) added. | G9 §B.5 | Batch 1125 |
| `C11-64 … C11-74`, `C11-SEED-02` (entity-scale) | NOT STARTED | G7 | evidence-pending |
| `C11-75 … C11-78` (submit-residency) | NOT STARTED | G2 §submit | evidence-pending |
| `C11-79 … C11-80` (celestial-env) | **TRANSFERRED to C12 (LD-1, 2026-07-23)** — IDs retained as aliases (C13 precedent); C12 `C12-04` sequences them (C11-80 before C11-79 retains star cmds). Close here; execute there. | G7 Item 12/13 | LD-1 |
| `C11-81 … C11-85`, `C11-87 … C11-89`, `C11-92 … C11-99`, `C11-SEED-03/04` (tiles-model-parity) | NOT STARTED | G5 | evidence-pending. **UPDATE 2026-08-09 (handover audit FIX 20):** `C11-90` and `C11-91` were carved OUT of this range (both progressed); `C11-86` stays in the range but is **coordinated with Campaign 18** — see its own row below. |
| `C11-90` (GLTF-POINTS-MODE-RESIDUALS / GLTF-PRIMITIVE-MODE-RESIDUALS) | **IMPLEMENTED — BROWSER GATE OPEN.** *(Carved out 2026-08-09, handover audit FIX 20 — covered by the `C11-81 … C11-99` NOT STARTED range while §1 recorded the implementation.)* Model-path topology realization landed as one enforceable home (`Renderer/WebGPU/WebGPUModelTopology.ts`): exhaustive 7-mode table, LINE_LOOP closure, TRIANGLE_FAN expansion, native line-list/line-strip/triangle-strip with exact `stripIndexFormat`, restart-capable-only uint8 `0xFF`→`0xFFFF` translation, non-indexed synthesis for every mode but TRIANGLES, topology+format threaded through all 12 model pipeline builders, capture records and the shadow/CSM cast key + descriptor. Triangle-list keys byte-identical. `model-primitive-topology.spec.mjs` 37/37; both `tsc` green. **STILL OPEN: rendered-pixel verification on both backends for the five modes** (probe checklist in the §1 cell) — the row does not close on the contract alone. Also promoted to a **P1 post-performance correctness tail** per the doc-top overlay. | §1.12 / G5 | §1 row `C11-90` is the authority |
| `C11-91` (WIRE-MODEL-SILHOUETTE-TRANSLUCENT-DIVERGENCE) | **DIRECTION RESOLVED 2026-07-18 (replicate WebGL body-wash); RE-SCOPED 2026-07-19 → `C11-157` Slice D — the only Slice of C11-157 still OPEN.** *(Carved out 2026-08-09, handover audit FIX 20.)* Model OIT reachability (C11-157 Slice C) landed, but the body-wash is **design-heavy — its own stencil/pass machinery, not a ride-along** — so it is deferred as Slice D with the recommended approach in `DEFERRED_WORK.md` (`NEW-WEBGPU-OIT-TRANSLUCENT-PRIMITIVE-WIRING` → Slice D). The Slice-C `getOITColorConfig` machinery is ready for it. ⚠ Do not schedule this as a small rider; and note MRT-OIT stays FAR-003 DEFAULT-OFF, so nothing here ships until that containment is lifted. | §1.12 / G5 | §1 row `C11-91` is the authority |
| `C11-86` (FEAT-3DT2-01 — styling expression → WGSL compiler) | NOT STARTED — P2, W7, L. *(C18-coordination stamp added 2026-08-09, handover audit FIX 19.)* ⚠ **CROSS-CAMPAIGN:** [`QUEUE_2026-08-09_CAMPAIGN18.md`](QUEUE_2026-08-09_CAMPAIGN18.md) §5 records this as the **third limb of the PNTS model-path composite loss**; `C18-P3`/`C18-P4` fix attenuation and EDL and **cross-reference only** — style expressions remain C11-86's. | G5 | evidence-pending |
| `C11-101 … C11-107` (classification-voxel) | NOT STARTED | G6 §A | evidence-pending. **UPDATE 2026-08-09 (handover audit FIX 19):** `C11-100` and `C11-108` carved out below for their C18 coordination stamps. The whole `C11-100 … C11-108` cluster is C18 §5's "voxel API cluster" entry (gap #8): clippingPlanes, time-dynamic keyframes, `levelBlendFactor`, ortho camera, vertical exaggeration, depthTest ray-clip, `stepSize`, events/statistics/debugDraw — per-feature coverage is confirmed **at C11 intake** against `FEATURE_INVENTORY.md`; no new IDs. |
| `C11-100` (PARITY-VOXEL-OCTREE-TRAVERSAL) | **PARTIAL — P1, W7, XL, sliced.** Static depth-3 traversal (585 slots) and dynamic level-2 residency/LRU already ship; the previous NOT STARTED label was stale. Remaining: levels beyond 3/general node-table or page-table traversal, level-3 paging/LRU, and re-upload pixel-drift triage. ⚠ **CROSS-CAMPAIGN:** [`QUEUE_2026-08-09_CAMPAIGN18.md`](QUEUE_2026-08-09_CAMPAIGN18.md) §5's brickmap/per-level page-table path is a candidate implementation vehicle, not a decided design. `C18-A2` (per-slot min/max empty-space skip) and `C18-A6` (ray-guided residency feedback) consume this output; schedule the remaining architecture with those rows. | G6 §A | implementation partial; A2-slice-0 triage + browser evidence pending |
| `C11-108` (VOXEL-USER-CUSTOMSHADER-RESIDUALS) | NOT STARTED — P2, W7, M. *(C18-coordination stamp added 2026-08-09, handover audit FIX 19.)* ⚠ **CROSS-CAMPAIGN:** [`QUEUE_2026-08-09_CAMPAIGN18.md`](QUEUE_2026-08-09_CAMPAIGN18.md) §5 lists it as "tracked and scoped in C11" — upstream GLSL, uniforms and colorMap all silently gray. C18 must not re-file it. | G6 §A | evidence-pending |
| `C11-109 … C11-112`, `C11-SEED-05` (shadows-lighting) | NOT STARTED | G8 | evidence-pending |
| `C11-113 … C11-114`, `C11-116`, `C11-SEED-06` (atmosphere-sky) | NOT STARTED | G8 | evidence-pending |
| `C11-115` (sun-blend ALPHA_BLEND — impl) | **TRANSFERRED to C12 (LD-1, 2026-07-23)** — direction stays RESOLVED per §7.0; the implementation feeds `C12-18`. ID retained as alias. ✅ **IMPLEMENTED 2026-08-07 inside the C12-18 batch (CO-6) — pending orchestrator landing + Edge run.** `WebGPUEnvironmentRenderer.js`'s sun pipeline now blends `src-alpha`/`one-minus-src-alpha` (colour) + `one`/`one-minus-src-alpha` (alpha), the exact twin of `BlendingState.ALPHA_BLEND`. Sequenced FIRST in that batch, per the ratified direction and because the C12-29 round-3 divergence (a black billboard is an exact identity under additive blending but darkens the sky by `a·dst` under ALPHA_BLEND) is the measured reason the flip exists. `Tools/visual-regression/sun-halo-composition.spec.mjs` pins the four factors AND asserts the additive `dstFactor: "one"` is gone. Read the C12-18 row for the acceptance numbers. | G8 | LD-1 |
| `C11-SEED-07` (sun-moon fidelity) | **FOLDED into `C11-179` (LD-2, 2026-07-23)** — duplicate scope; `C11-179` itself is deferred to C12 ownership per the 2026-07-23 audit ruling. | G8 | LD-2 |
| `C11-117 … C11-123`, `C11-SEED-08/09` (postprocess-effects) | NOT STARTED | G6 §B | evidence-pending |
| `C11-124 … C11-130`, `C11-SEED-10..18` (clouds-weather) | **HISTORICAL ALIASES / NOT SCHEDULABLE IN C11 — TRANSFERRED TO C13 (2026-07-23).** `C11-126` was COMPLETE; `C11-125` was PARTIAL; remaining truth continues only under the mapped C13 owners. | §1.17 + G12 + `QUEUE_2026-07-23_CAMPAIGN13.md` | **C13 ledger is the sole live authority; never double-schedule here.** |
| `C11-131`, `C11-SEED-19` (water) | NOT STARTED | G8 §water | evidence-pending |
| `C11-GT-01` (reversed-Z measurement spike) | **COMPLETE — NO-GO (2026-07-19, Batch 717)** | G10 §A1 / `REVERSED_Z_MEASUREMENT_SPIKE_2026-07-19.md` | **Verdict STAY-LOG-DEPTH**, adversarially verified (verifier independently recomputed the precision math and confirmed the format claim). Decisive fact: the scene depth attachment is `depth24plus-stencil8` (`WebGPUContext.ts:370`, `grep '_depthFormat *='` → zero reassignments; independently hardcoded at `WebGPUSceneFramebuffer.ts:330,341` and `WebGPUGlobeDepth.ts:300,310`). Reversed-Z's precision gain requires a FLOAT depth buffer — on a fixed-point format the code levels are uniformly spaced and reversing mirrors a uniform ladder, so the gain is **mathematically zero**. `depth32float-stencil8` is an OPTIONAL feature and is **absent from `DESIRED_FEATURES`** (`WebGPUFeatureFlags.ts:40-66`); worse, `depth24plus-stencil8` maps to D24_UNORM_S8 on D3D12 (gain 0×) vs D32_SFLOAT_S8 on Vulkan (~10×) with **no WebGPU query to tell them apart** — migrating today ships a driver-determined, untestable result. Multi-frustum contributes nothing either: reversed-Z NDC is `d≈n/z` so `Δz=ε_rel·z` and the slice near/far cancel. **Consequence: the log-depth pick fleet (82 WGSL `frag_depth` writers / 182 `csm_writeLogDepth` sites / ~24 pick producers) is CLEARED TO KEEP GROWING** — it is not a trap a later migration must rip out. Record in `C11-IC-01` + FAR-707 + `DEFERRED_WORK`. Stale-figure correction: `DEFERRED_WORK.md:5425-5426` cites a "71-file color surface"; measured is **82 WGSL + 28 Renderer files**. |
| `C11-GT-02 … C11-GT-03` (gated-reversed-z slice work) | DEFERRED (gated tail §6) — **gate CLOSED by `C11-GT-01` NO-GO** | G10 §A2–A3 | Do not open: the measurement spike these were gated behind returned NO-GO. Retain as historical/reopen-only if the depth format ever moves to `depth32float-stencil8`. |
| `C11-133` (Karma launcher completion truth / Edge profile cleanup) | **COMPLETE — IMPLEMENTED / VERIFIED / LANDED Batch 1018 (2026-08-11).** | G9 §A.1 | The completion bridge requires `run_complete`, nonempty valid counts, and register/start/terminal-complete for every browser; infrastructure failures remain fatal, and `failTaskOnError=false` suppresses only an ordinary exit 1 from a complete nonempty suite with failed tests. Exact selected `karma-edge-*` profiles are reaped with bounded retries; unrelated paths are refused. `node scripts/__tests__/karmaTestRun.spec.mjs` is green. Machine gate: **10/10** serial `EdgeHeadlessCI` runs on one unchanged bundle, each exit 0 with **15 executed / 17,794 skipped**, complete `SUCCESS`, and `NEW_PROFILES=0` after every run. Five unrelated pre-existing `karma-edge-*` directories were present at baseline and remained unchanged; the temp root was not globally empty. The launcher prerequisite is discharged. |
| `C11-135 … C11-139`, `C11-141 … C11-145`, `C11-147` (test-infra remainder) | NOT STARTED (`C11-137` = EXIT) | G9 §A | evidence-pending; the `C11-133` launcher dependency is discharged, but each row's other prerequisites and own gates remain. |
| `C11-132` (NEW-WORKSPACE-SPEC-BUNDLE-FRESHNESS, A.2) | **CODE LANDED / NOT COMPLETE (corrected 2026-08-21 — the COMPLETE lead-in overstated the state). Widgets Karma round-trip machine-green (351/351, exit 0); the engine-green round-trip is OWED — the full engine lane built a fresh bundle but exited 1 on 93 unrelated suite failures. See the §5 W1 UPDATE 2026-08-12 paragraph, which this cell now matches. CODE LANDED — Batch 903 (`d9a8e39eeb`), batch group CO-2** *(batch/hash stamped 2026-08-09, handover audit FIX 22 — the cell named only the CO-2 group)* | G9 §A.2 | **Premise VERIFIED at HEAD, not assumed:** `test()` in `gulpfile.js` called `buildCesium({iife:true})` (which writes ROOT `Specs/SpecList.js` → `Build/Specs`) unconditionally, while the workspace lane's Karma `files` list serves `packages/<ws>/Build/Specs/{karma-main,SpecList}.js` — produced ONLY by `buildEngine`/`buildWidgets`. The two never met, so a package spec could stay out of the served bundle and "pass" by never running. **Closure:** new `scripts/specBundleFreshness.js` (~380 lines) stamps `SpecList.meta.json` beside each built bundle with a **content digest** of the exact spec source set (content, not mtime — trap 4; POSIX-normalized paths so Windows and Linux manifests compare equal). `scripts/build.js` gains narrow `buildWorkspaceSpecBundle()` / `buildCombinedSpecBundle()` (trap 2: the spec bundle is refreshed WITHOUT a full `Build/CesiumUnminified` rebuild) and stamps at all three sites. `gulp test` now builds the workspace in the workspace lane and runs `ensureSpecBundleFresh()`: fresh → **no rebuild** (step 3, fast inner loop); stale → rebuild-and-re-verify; still stale → throw naming **added / removed / content-changed** files. Added AND removed both count (trap 1). Guard `scripts/__tests__/specBundleFreshness.spec.mjs` — 8/8 `node --test`, including the guide's Step-0 delta reproduced without Karma (a brand-new spec flips `fresh` false and is named) and its mirror (a deleted spec). Smoke-run on the real tree: engine 843 specs / combined 883, 241 ms warm. Workaround STRUCK in `CAMPAIGN9`/`CAMPAIGN10` guides (3 sites) + closure documented in `DEBUGGING_GUIDE.md`. **OWED (machine lane):** one `npx gulp test --workspace engine` round-trip to confirm the new build path end-to-end — the worker lane has no Karma/Edge. |
| `C11-134` (NEW-FULL-SUITE-OFFLINE-DEPENDENCY-ISOLATION, A.3) | **CODE LANDED / OFFLINE LEG GREEN / ONLINE LEG RED (environment) / NOT COMPLETE (corrected 2026-08-21). Offline targeted Edge 349/349 with five reasoned network skips and zero blocked requests (full offline engine lane reproduced both); the `--no-offline` coverage control failed 5/9 on live-service `Request has failed` (2026-08-12, `360d26f0a5`) — an honest external-service red, not offline-policy evidence; the online lane remains OWED in a valid live-service environment. Fail-closed repair Batch 1029 (`de04e70574`). See the §5 W1 UPDATE 2026-08-12 paragraph, which this cell now matches. CODE LANDED — Batch 903 (`d9a8e39eeb`), batch group CO-2** *(batch/hash stamped 2026-08-09, handover audit FIX 22 — the cell named only the CO-2 group)* | G9 §A.3 | **Premise VERIFIED at HEAD** via the guide's own grep: 12 files match, of which **4 genuinely reach a live service** (`Core/createWorldTerrainAsync`, `Core/TerrainPicker`, and the `createWorldTerrainAsync()` blocks in `Core/sampleTerrain` + `Core/sampleTerrainMostDetailed`); the other Ion-touching specs (`Core/IonResource`, `Scene/IonImageryProvider`, `Scene/createWorldImageryAsync`, `Core/GoogleGeocoderServices`) **mock their transport** and are already offline-safe — quarantining them would have deleted real coverage. **Closure:** new `Specs/networkPolicy.js` provides (a) `describeRequiresNetwork()` — offline it `xdescribe`s the suite and records `{name, reason:"requires network"}` on `window.__cesiumSkippedNetworkSuites` (a truthful SKIP, Principle 9), online it runs unchanged **preserving its existing `describe` category** (`Core/TerrainPicker` keeps `"WebGL"`); (b) a fetch/XHR guard that refuses any non-Karma-origin request, records it on `window.__cesiumBlockedNetworkRequests`, and throws naming the URL **and the remedy** — so a newly-added network dependency fails the day it lands. The classifier **fails closed** (unparseable/empty → external). `customizeJasmine.js` publishes the lane flag before any spec module evaluates (karma-main.js runs ahead of SpecList.js — the ordering is load-bearing and is asserted). **Offline is the DEFAULT**; `--no-offline` runs the online lane. Flag travels as a **token** (`args.includes("--offline")`), not a positional index, because the arg tail is shared with the jasmine adapter's `--grep` pair. Guard `Tools/visual-regression/spec-offline-isolation.spec.mjs` — 9/9 `node --test`, incl. the roster assertion that a NEW live-service spec must be declared. **OWED (machine lane):** the offline lane run (expect 4 reasoned skips, zero blocked requests) and one `--no-offline` run proving the quarantined coverage still passes with network. |
| `C11-140` (NEW-GPU-TIMESTAMP-UNIQUE-SAMPLE-ACCOUNTING, A.11) | **LOCAL MACHINE-CERTIFIED — accounting + drain landed; local probe bootstrap fix, strengthened guard, and certification artifact landing owed — NOT COMPLETE. CORE CODE LANDED — Batch 903 (`d9a8e39eeb`), batch group CO-2** *(batch/hash stamped 2026-08-09, handover audit FIX 22 — the cell named only the CO-2 group)* | G9 §A.11 | **Premise VERIFIED at HEAD and SHARPENED.** The implementation did exist, but two real defects made it uncertifiable, not merely unaccepted. **(1) Double-counting was being hidden, not avoided:** `coverageRatio` was `Math.min(1, profiledPassSum / frameSpan)` — a SUM over overlapping pass intervals divided by the span it sits inside, clamped so an overcount reports as 100% coverage with a zero remainder. Replaced by a **union fold** (new `packages/engine/Source/Renderer/WebGPU/WebGPUTimestampAccounting.ts`, ~210 lines): `coveredMs` = union of the timed intervals (each GPU nanosecond counted once), `overlapMs = summedPassMs − coveredMs` surfaced as a finding, and `coverageRatio + unprofiledRatio ≡ 1` by construction. Timestamps are folded **relative to a per-frame origin** — absolute device uptimes are not exactly representable in a `number`. **(2) Samples were silently lost:** submissions whose slot had been recycled hit an early `return` that neither counted them **nor cleared `readbackPending`** — permanently retiring that slot, so every later rotation onto it became a skip forever. Both fixed; the ledger now closes (`attempted == sampled + skipped + empty + failed + lost + pending`, asserted as `sampleLedgerBalanced`/`unaccountedSampleCount`). New bounded `drainPendingReadbacks(timeoutMs)` drains the capture tail (trap 2: a readback that will never complete resolves as `undrained`, never hangs). `CesiumDebug.gpuPassCost()` prints the accounting line and `console.error`s an unbalanced ledger; `DEBUGGING_GUIDE.md` updated per the CLAUDE.md sync rule. Guard `Tools/visual-regression/gpu-timestamp-unique-sample-accounting.spec.mjs` — 13/13 `node --test`, driving the REAL profiler against a fake `GPUDevice` (sampled/empty/skipped/lost/pending/drain-timeout all balance) plus a ledger negative control and a source anchor that the clamp does not return. `probe-gpu-timestamp-profiler.mjs` rewritten into the certification lane: 5 reps × 60 frames of a **bounded moving-altitude arc** (idle capture is invalid per charter), drains the tail, asserts the ledger and the ratio identity, and writes `gpu-timestamp-accounting-certification.json`. **LOCAL MACHINE CERTIFICATION 2026-08-10: GREEN.** The first invocation exposed deterministic `const URL` shadowing of Node's global `URL`; `VIEWER_URL` plus a non-regression assertion fixes bootstrap (`node --check` green). Real Node/Playwright Edge exits 0 with `certified=true`, `timestamp-query` available, 5 × 60 moving-altitude frames, all sample/coverage ledgers balanced, zero failed/lost/pending samples, drain 1/0 per repetition, and empty failure/structural/page/console/external-request arrays. Artifact: `Tools/visual-regression/gpu-timestamp-accounting-certification.json`. **OWED:** land the probe fix, strengthened guard, and artifact; the row is not complete, and no durable C11 GPU-lane citation is authorized until they land. **[Landed Batch 1074 `d36a835b82`, 2026-08-20 — probe fix + banked artifact in-tree (guard 13/13 at HEAD); the fresh-bundle route rerun ran tonight in the machine lane — exit 0, clean gates.]** |
> **LOCAL machine certification (2026-08-10; landing owed):** the first real invocation exposed a
> deterministic probe-bootstrap defect: module-local `const URL` shadowed Node's global `URL`
> constructor. Renaming it `VIEWER_URL` plus a non-regression assertion restores fail-closed offline
> boot; `node --check` is green and the focused accounting/probe contract is **13/13**. The repaired
> Node/Playwright Edge run exits **0** with `certified=true`, `timestamp-query` available, and five
> 60-frame moving-altitude repetitions. Every repetition's sample and coverage ledgers balance;
> failed/lost/pending counts are zero and each tail drain reports `drained=1`, `undrained=0`.
> `failures`, `structuralReasons`, `pageErrors`, `consoleErrors`, and `externalRequests` are all empty.
> Artifact: `Tools/visual-regression/gpu-timestamp-accounting-certification.json`. The probe fix,
> non-regression spec, and artifact are local/unlanded, so `C11-140` is **NOT COMPLETE**.
> **[Landed Batch 1074 (`d36a835b82`), 2026-08-20 — no longer local; the owed
> fresh-bundle machine-lane rerun ran tonight: exit 0, clean gates.]**
| `C11-146` (S8-7 settle-window attribution + first-complete-frame, A.14) | **COMPLETE — rule + metric landed and unit-certified; the route run is OWED to the machine lane. CODE LANDED — Batch 903 (`d9a8e39eeb`), batch group CO-2** *(batch/hash stamped 2026-08-09, handover audit FIX 22 — the cell named only the CO-2 group)* | G9 §A.14 | **Premise VERIFIED at HEAD:** the TTFF proxy is exactly `frameNumber > 0` (`run-performance-campaign.mjs`, the `waitForFunction` feeding `navigationToFirstObservedFrameMs`). **Closure:** new `Tools/visual-regression/lib/settle-attribution.mjs` carries the rule as a testable artifact — a settle window with **zero main-thread long tasks is GPU-submit bound and NOT creditable**; `classifySettleDelta()` makes a settle-time win bookable only when a main-thread long-task reduction accompanies it; unobservable windows resolve to `unknown` + **not creditable** (no evidence is not permission). The runner now records the settle window (drained via the same yield-then-`takeRecords()` handshake the measurement window uses, and captured **before** `longTasks.entries` is filtered down to the measurement range) and emits `settleAttribution`. **First-complete-frame** is defined honestly: a selected tile counts as complete only when it draws **its own loaded mesh** (`data.renderedMesh === data.mesh` — an upsampled fill mesh is a placeholder) with every imagery layer ready, held `FIRST_COMPLETE_FRAME_STABLE_FRAMES` frames (trap 3), reported as the run's FIRST frame. The scan early-outs on detection and its listener is removed **before the measured window opens**, so it cannot perturb the measurement. Node re-derives the metric from the recorded trace and records `agreesWithTrace` (null when truncated) rather than quietly reconciling — reference disagreement is an instrument defect. **Trap 1 honoured:** `navigationToFirstObservedFrameMs` and `navigationToStableMs` are byte-for-byte unchanged so the C9-30 / Gate-A anchors stay comparable; the new fields are purely additive. Guard `Tools/visual-regression/settle-attribution.spec.mjs` — 11/11 `node --test`, incl. the S8-7 scenario (settle improves 1700→1400 ms with no long-task reduction → **not bookable**) and a flicker case that a 1-frame rule would wrongly accept. **OWED (machine lane):** one moving-altitude route run to confirm the metric fires and to record the real first-complete-vs-first-frame lag. **Binding on the boot/TTFF cluster (§B.3/B.6): they may not claim a TTFF win without this metric and this attribution flag.** |
| `C11-148`, `C11-150 … C11-156`, `C11-SEED-20/21/22`, `C11-IC-03` (build-boot) | NOT STARTED | G9 §B | evidence-pending. **UPDATE 2026-08-07 (close-out docs reconciliation):** `C11-149` was carved OUT of this range — it LANDED at Batch 739 and now carries its own row immediately below (the `C11-35` precedent). The remainder of the range is unchanged. |
| `C11-149` (C10-08b — ShaderDefine define-width expansion) | **LANDED — Batch 739 (`bf7b20c6d3`, 2026-07-23)** *(corrected 2026-08-07, close-out docs reconciliation: this ID was covered by the `C11-148 … C11-156` **NOT STARTED** range row above, while `C11-158`'s own **COMPLETE** cell in this same table already described itself as the "FIRST ShaderDefineHi consumer" — two cells of one ledger contradicting each other.)* | G9 §B | **Stage 0** unfolded the bit-31 collision: `pipelineKeyWithDepthFlag` no longer squats on define bit 31, the no-depth-test flag became its own key dimension (`(defines >>> 0) * 2 + flag`), and lo-word bit 31 is genuinely reserved. **Stage 1** added the add-only `ShaderDefineHi` registry (hi bits 0-30; hi 31 reserved and runtime-enforced), branded `ShaderDefineHiMask` / `ShaderDefineLoMask` types (a hi bit passed to a lo parameter is a COMPILE error), `preprocess(source, defines, definesHi)`, and hi-word module-cache keying. **The "HARD PREREQ for any new define bit" is therefore DISCHARGED**, and hi bits are in production use at HEAD (`WebGPUShaderDefines.ts`): `ENHANCED_OCEAN` hi bit 1 (`C11-158`, Batch 746), `SPLAT_PACKED_WASM` hi bit 2 (`C15-G3`), `SPLAT_SPHERICAL_HARMONICS` hi bit 3 (`C15-G5`, Batch 894). Downstream framing corrected in the same pass: `DEFERRED_WORK.md` `NEW-WEBGPU-SHADERDEFINE-WIDTH-EXPANSION`. |
| `C11-SEED-23 … C11-SEED-26` (arch-seeds) | DEFERRED (seed) | G10 §A4–A7 | seed-pending |
| `C11-157` (OIT translucent-primitive wiring) | **COMPLETE — Slices A+B+C (PRIMITIVE + COLLECTION + MODEL families ALL reach MRT-OIT; Batches 713/714/715). Slice D (`C11-91` silhouette body-wash) REMAINS OPEN.** ⚠ "reachable" ≠ "shipped": FAR-003 keeps MRT-OIT DEFAULT-OFF, so none of this is user-visible yet. *(Label corrected 2026-07-19 — it read "PARTIAL (Slices A+B)" while the evidence cell below already carried the Slice-C paragraph landed by Batch 715.)* | §1.23 / G1/G3 | **TOP of W1**; absorbs `C11-91` body-wash; Batch-700 fallout. **Slice A (Batch 713)**: translucent PRIMITIVES (flat single-`@location` PrimitiveBasicColor + LIT `FragOutput`-struct PrimitivePhongColor via new `injectOITOutput` struct branch) REACH MRT-OIT — `_webgpuOITActiveThisFrame`=TRUE, WebGPU OIT-on now **1.33%** from WebGL OIT-on (was 10.33% @ Batch-700). **Slice B**: translucent COLLECTIONS (billboard / point / polyline color commands, all `FragOutput`-struct FS → the same struct branch) now REACH MRT-OIT too — `probe-oit-collection-reachable.mjs` point/polyline/billboard all PASS (`activeThisFrame`=TRUE was-always-false, 0 validation errors, non-degenerate WBOIT blend, restore 0px). Wiring: `WebGPU{Billboard,PointPrimitive,Polyline}Renderer.js` attach `_shaderCode` (non-LOG_DEPTH source) + `_pipelineConfig` (base pipeline's shared layout, single-sample) to each Pass.TRANSLUCENT color command. **Slice C (MODEL core)**: translucent MODELS now REACH MRT-OIT — both the natively-BLEND primary command AND the per-feature-styled TRANSLUCENT **twin** (C10-02 / Batch 699). `WebGPUModelPipelineCache` gained `getOITColorConfig` (extracted `_composeColorSource` — byte-identical module composition — + non-LOG_DEPTH preprocess + reused color descriptor); `WebGPUModelRenderer` attaches it to the primary (when `pass===TRANSLUCENT`, non-classifier, non-silhouette) + the twin (both inside the Batch-704 async ready-gate). Also fixed a latent `executeOITCommand` bug: it assumed the `{buffer}` wrapper and threw `setIndexBuffer: not a GPUBuffer` on models (raw GPUBuffer) — now `resolveOITBuffer` handles both (unblocks models; A/B unaffected). `probe-oit-model-reachable.mjs` twin+blend PASS (`activeThisFrame`=TRUE, 0 errors, model renders via composite, restore 0px; onVsOff≈0 is CORRECT — single-sided model geometry → WBOIT≡sorted-alpha). Model battery unregressed (instance-bg-cache, pbr-ibl-parity, standalone-model-pick). No-regression: primitive-reachable + collection-reachable + oit-transparency (parity 1.33%) + splat-sort + ellipsoidprim + globe-translucency + capture-and-diff all green. FAR-003 stays DEFAULT-OFF (reachable, not default-on). **Slice D REMAINS** = the C11-91 silhouette OIT "body wash" (design-heavy stencil/pass work, deferred + designed in DEFERRED_WORK). Runs at `msaaSamples=1` (MSAA×OIT = `NEW-WEBGPU-OIT-MSAA-RESOLVE-ORDERING`). Weight follow-up = `NEW-WEBGPU-OIT-WEIGHT-LINEAR-DEPTH` |
| `C11-158` (enhanced-ocean default-parity toggle) | **COMPLETE (Batch 746)** — FIRST ShaderDefineHi consumer (`ENHANCED_OCEAN` hi bit 1). Enhanced styling moved VERBATIM into `//>>ifdef ENHANCED_OCEAN`; `//>>else` = 1:1 port of `GlobeFS.glsl::computeWaterColor` classic look; shared wave march feeds BOTH branches (waves untouched per the Batch-716 premise correction). `Globe.enableEnhancedOcean` default true→false, runtime-flippable (idempotent per-frame applier wipes renderer-local caches; module cache dedupes via the hi word; central pipeline key gains `, enhOcean`). Edge-verified at default: brightness gpu/gl **0.996**, wave-detail 1.198, temporal 1.822 (animating). Enhanced path preserved verbatim — governing principle honoured. || W4; HARD PRED `C11-149`; with `water-bugs-2026-07-06`. **⚠ PREMISE CORRECTED by the 2026-07-19 ocean-waves audit** (`Tools/visual-regression/output/ocean-waves-perf-audit-2026-07-19.md`): (a) `globe.enableEnhancedOcean` does NOT gate the GPU wave path — it appears nowhere in `Renderer/WebGPU/**` or the WGSL; it only pushes CPU-side color params (deepColor/fresnel/foam/darkening), so defaulting it `false` restyles the ocean at **~0 GPU saving** (the 3-octave march still runs). (b) The ocean **WAVES are parity-preserving** — WebGL runs the SAME waves under the SAME default-true `globe.showWaterEffect`/`flags.z`; the genuine divergence is the enhanced STYLING (Fresnel/GGX-specular/foam/deep-color/SSS) at ~0 extra GPU beyond the shared march — a COSMETIC/shader-look difference, NOT a perf difference. So the parity toggle must gate the enhanced STYLING (default → WebGL-classic look, enhanced opt-in), NOT flip `enableEnhancedOcean` (no-op for GPU) nor `showWaterEffect` (would remove waves from BOTH backends = a real feature loss, forbidden by the governing principle). Cheap perf win filed separately: `OCEAN-WAVE-OCTAVE-LOD` (altitude-gate octaves 3→2→1). |
| `C11-159` (night-lights default-OFF parity) | LANDED Batch 1076 `01dfc84e73`, 2026-08-20 (default flipped, toggle kept, spec-pinned) | §1.23 / G8 | W1 cheap rider; keep toggle |
| `C11-160` (sunBloom → PP wiring) | **TRANSFERRED to C12 (LD-1, 2026-07-23)** — feeds `C12-18`; ID retained as alias. ✅ **IMPLEMENTED 2026-08-07 inside the C12-18 batch (CO-6) — pending orchestrator landing + Edge run.** ⚠ **The row was VACUOUS at HEAD in the strongest sense: `scene.sunBloom` had NO WebGPU consumer whatsoever.** `WebGPUContext.supportsLegacySunBloom` returns `false` so `FramebufferOrchestrator.js:52-64` skips the WebGL `SunPostProcess` allocation, and the comment claiming "sun bloom on WebGPU lives inside `WebGPUPostProcessPipeline` / Bloom or LensFlare" (`GraphicsContext.ts:955-965`, `WebGPUContext.ts:1866-1874`) was aspirational — `pipeline.addBloom` is driven ONLY by `postProcessStages.bloom.enabled` (default false) and no code path read `sunBloom`. Shipped: new `WebGPUSunHaloEffect.ts` + `Shaders/WebGPU/PostProcess/SolarHalo.wgsl`, added lazily by `configureWebGPUPostProcessPipeline` when `scene.sunBloom === true` AND `environmentState.isSunVisible !== false`, executed BEFORE Bloom so the halo participates in bloom/tonemap the way WebGL's `SunPostProcess` output does. **Deliberately NOT wired to the global `BloomEffect`:** that is a full-screen ContrastBias bloom, not a sun-localised halo, and C12-18 requires a non-terminating `1/rho^2` tail that no blur of a finite source can produce. | §1.23 / G6/G8 | LD-1 |
| `C11-161` (AutoExposure demand-gate) | **TRANSFERRED to C12 (LD-1, 2026-07-23)** — feeds `C12-19`; ID retained as alias. | §1.23 / G6/G8 | LD-1 |
| `C11-162` (usePostProcessSelected port) | NOT STARTED | §1.23 / G6 | W7 |
| `C11-163` (C11-CELESTIAL-WATER-REFLECTION epic) | NOT STARTED · Tier-4/gated | §1.23 / G8 + `CELESTIAL_WATER_REFLECTION_RESEARCH.md` | opt-in default-OFF; 4 sub-decisions §7.0 |
| `C11-164` (pick cold-sync-staleness race) | NOT STARTED | §1.23 / G1 | W2 pick fleet; C10-11 fallout |
| `C11-165` (deterministic-sync pipeline centralization) | NOT STARTED | §1.23 / G9 | W4 boot chain; C10-07 follow-on |
| `C11-166` (ocean-normal per-call re-upload) | **COMPLETE (2026-07-19, Batch 717)** | §1.25 / `DEFERRED_WORK` `NEW-WEBGPU-OCEANNORMAL-PER-CALL-REUPLOAD` | **This was the reported ~50% FPS deficit.** `uploadImageSource` never READS the cache Map it is handed (no `cache.get`/`cache.has` in the function); its only dedupe (`_sharedImageryRealizations`) is gated on `logicalOwner === "imagery"`, which neither call site passes — so callers must own the guard and the ocean-normal caller had none. Every `_createWaterOceanMaterialBindGroupInner` call therefore ran `copyExternalImageToTexture` + 9-level mip regen + `createView` **per tile per frame**, and since the group-2 bind-group cache keys on VIEW IDENTITY, a fresh view each call also forced `createBindGroup` every frame (self-perpetuating). **Fix:** source-identity memo `_oceanNormalMapSource`/`_oceanNormalMapView` mirroring the in-file `_materialTextureCache` idiom, reset alongside the texture destroys in teardown — exactly the fix sketch the Batch-685 filing wrote. **Measured** (static settled scene, 9 commands/6 tiles, `requestRenderMode=false` on BOTH): WebGPU `scene.render()` **10.5 ms → 0.9 ms (11.7×)**; ratio **17.5× → 1.5×**; as-shipped idle lane **1.1 ms vs WebGL 1.2 ms (WebGPU now FASTER)**. Profile: `copyExternalImageToTexture` **47% of all CPU self-time → absent from top-18**; WebGPU 68.7% idle ≈ WebGL 69.1%. **Correctness:** `probe-webgpu-ocean-waves` brightness gpu/gl 0.996, wave-detail 1.204, temporal delta **1.818** (>0.3 = animating; frozen-ocean is this fix's documented failure class), PNGs read clean. `tsc --noEmit` clean. |
| `C11-167` (uploadImageSource cache-contract audit) | **COMPLETE — Batch 721** | §1.25 | All production call sites were audited and guarded; the static ocean upload storm remains fixed. Follow-up from the 2026-07-22 audit: the module-global `reuploadWatch` detector is unbounded and counts before validation/physical realization. Scope and bound it as diagnostic hardening; do not repeat the completed call-site audit or label the sentinel as a current FPS lever. |
| `C11-168` (perf re-measure on a real workload) | **PARTIAL — globe control green; exact resident comparability blocked by C11-205; six-pair certification open** | §1.25 / G10 | The 2026-07-22 six-repetition moving route remains the historical steady-state anchor. A 2026-07-31 globe-only control passes near parity. Resident priming now dwells for two stable frames because the production `HeightmapTerrainData.createMesh` throttle advances five tasks at a time; no runtime cache/worker/gate was weakened. The earlier 5.716 ms WebGL versus 7.330 ms WebGPU average resident pair is directional history only because it predates exact workload identity. The fresh pair had exact 600-frame terrain identities and zero terrain work on both legs, but correctly failed: SF 3D Tiles readiness/selection was 710/15 WebGL versus 571/12 WebGPU. C11-205 must fingerprint ready/request identity and close that seam before any causal timing claim. Counterbalanced r6 certification, GPU timestamps/max-FPS, and the maintainer split-pane lane remain open. |
| `C11-169` (frame-cost accounting gap) | **PARTIAL — RESIDENT OWNER-ATTRIBUTION TOOLS LANDED Batch 1032 (`be0683c60d`); ACCOUNTING-SOURCE LANDING / REMEDIATION OPEN — NOT COMPLETE / DIAGNOSTIC ONLY / NO FPS OR GPU CLAIM** | §1.25 / G10 | The profiler now conserves exact whole-Scene CPU time across named passes plus a mutually exclusive fixed 11-phase ledger, with zero unattributed/overlap/residual in the final coarse run. Node is **31/31**; TypeScript and the **53 s** build are green; profiler Edge is **26/26** (**18,203 skipped**) and Viewport Edge is **2/2** (**18,227 skipped**). Coarse artifact `c11-169-whole-frame-phase-attribution.json` (`e07afdd3-67b6-41ab-aa09-a62ece40da6e`, SHA `A5A2B43CF606CFF11DF0EDC56C352556633113DEB77B43083CF659A613DA9839`) is exit 0 across **180/180** frames and **8/8** route segments; its preserved first red was only the paired-control named-occupancy overconstraint. The new first-green nested artifact `c11-169-primitive-traversal-breakdown.json` (`e60f18d2-fbc1-48ba-b499-4806481bf20f`, SHA `8C7F14B614C467C5686619731426062C7B435D3F4545BC6B9481D39D1373FDB0`) is PASS/exit 0 and has no physical first-red file; offline policy is **17/17**, combined Node is **48/48**, static gates are green, and independent review is P0=0/P1=0. On its **120/120**, **8/8** route, total median/mean/p95 is **9.0/13.5175/55.8 ms**, primitive is **2.3/4.6358/8.4 ms**, and globe render is **2.2/4.5692/8.2 ms**, or **98.56% of mean primitive time**; ground/ordinary/residual means are **0.0067/0.0008/0.0592 ms**. Four 12-pair controls have exact **24/12** seam/spin hits and bounded off-target medians. Because prime ended `globeTilesLoaded=false`, `pendingForegroundCount=3`, with only local Natural Earth II and no explicit asset, this is a streaming/default-globe diagnostic—not transferable C11-168/C11-205 evidence and not an optimization/FPS/causal claim. The exact resident San Francisco owner-attribution Tools packet landed in Batch 1032 (`be0683c60d`); final artifact `c11-169-resident-sf-owner-attribution.json` retains SHA-256 `C755784AEF33AA85DF8C8F0DD72C0E025BFF38AC54F441CF1349DB5E95774C1C`. This remains synchronous, instrumented, diagnostic/noncausal evidence—not a GPU, FPS, or uninstrumented performance claim. Accounting-source landing, evidence-led remediation, and uninstrumented causal confirmation remain open. |
| `C11-170` (perf regression guard) | **PARTIAL — FIRST ACQUIRE RUN EXECUTED 2026-08-25 AND CAME BACK `FAIL`; THE GATE'S OWN BASELINE-OVERWRITE DEFECT FOUND AND STRUCTURALLY REPAIRED; STILL CERTIFIES NOTHING** (Batch \<N\>) | §1.25 / G10 | **First acquire run (2026-08-25, `runId 63e71faa-8289-448f-b743-173937cb5610`, HEAD `34fb32c71a` + dirty tree, preflight HTTP 200).** All four children exited 0 and all four reports proved fresh, so the run is admissible. **FINAL `FAIL` / exit 1, on one signal: `A-webgpu` observed `0.534` against the frozen `0.193`.** The **sole carrier is `writeBuffer @ (native):-1`** (0.534 % self time, 13.151 ms of a 120-frame profile); **none of the Batch-717 texture signature is present** — `copyExternalImageToTexture`, `uploadImageSource`, `writeTexture`, `texImage2D/3D`, `texSubImage2D/3D` and every other `RESOURCE_WRITE_FAMILY` member are absent from BOTH published top lists. `A-webgl` 0 (PASS). `B` 0/90, `C` 0/90 + 0/90, `D` census 3 getContext calls / 1 live WebGPU / 0 live WebGL with producer `Q1` agreeing, `E-1` 1.067, `E-2` 1.111, `F` PASS passthrough, `G` NOT-PROVEN (`scannedMessages` 0). The run is a **detection, not a diagnosis**: the gate claims the re-upload/churn class, not a cause. **THE DEFECT THAT RUN EXPOSED.** The gate's *banked baseline* artifacts and its *live-run outputs* were **the same four paths** under the gitignored `Tools/visual-regression/output/`. Acquiring therefore overwrote all four banked reports — including `performance/c11-169-whole-frame-phase-attribution.json` — and the spec fell to **68 pass / 2 fail** (`banked artifacts keep every A-F subject green…` and `every frozen bar still equals the banked derivation it claims`) because the gate had **re-based its own negative controls**. Same class as a spec that certifies source text rather than liveness. A second, quieter face: those four tests carried a `skip` on absent evidence, so in **any clean checkout they were silently vacuous**. **REPAIR (maintainer ruling 2026-08-25 — no bar moves).** `0.193`, the Rule-of-Three `3/n`, `2.8737075`, the `0` census bar and `RESOURCE_WRITE_FAMILY` membership are **byte-unchanged**. (1) The derivation baseline is now an **immutable checked-in fixture**, `Tools/visual-regression/fixtures/c11-170/perf-gate-derivation-baseline.json`, outside the mutable output tree. All four banked reports were **recovered byte-exactly** from three independent, mutually agreeing mirrors; `cpu`/`request`/`backend` are embedded **RECOVERED-VERBATIM** (re-serializing each reproduces its recorded sha256) and the 838 KB frame report is embedded **RECOVERED-PROJECTED** — a lossy projection of exactly the nine field paths this gate reads, with its full-file sha256 recorded and explicitly marked **not** re-derivable. What is *not* recovered is named in the fixture itself. Independent confirmation: adjudicating the fixture reproduces the surviving 2026-08-24 artifact field-for-field (A–F PASS, G NOT-PROVEN, `scannedMessages` 12, `coverageRatioMax` 0.13513513502628807, STRUCTURAL). (2) The spec's derivation test now reads that fixture, and the derivation itself moved into the runner as the pure exported `derivationViolations(reports, bars, family)` so it can be mutated like any other predicate. (3) Overwriting a baseline is now **structurally impossible**: `LIVE_WRITE_PATHS` freezes the six paths the gate may write, `assertLiveWriteTarget` refuses every other destination, and `assertBaselineIsolation()` — the **first statement of `main()`, before the RUNNING artifact is written** — refuses to start the run if any live path is, contains, or is contained by the baseline. (4) The three network-dependent children are pinned to the viewer's deterministic `offline=true` scene via `PROBE_VIEWER_OFFLINE` (default-unset = historical online URL, byte for byte, for every other consumer); the fourth already self-pins. Ion World Terrain tile count moving with the network was a live confound on a signal that judges a share of self time against a frozen bar. **Spec is now 81/81, 0 skipped** (was 70 with 4 skipping in any clean checkout), and it stays green *after* a real gate run — verified by running `--adjudicate-only` and re-hashing the fixture unchanged. **RECORDED FOR THE HELD DECISION (instrument deliberately unchanged).** Signal A is a **presence** detector at this baseline, not a magnitude detector: `0.193` was the smallest pct the banked profile published, so any family member that appears in the published top-20 **at all** is ≥ the bar. The profiler's visibility floor also **moves per run** — banked 0.193, 2026-08-25 run 0.237 — so the frozen bar is at-or-below the live floor on some runs and therefore at least as strict as presence. Per ruling, **the semantics are not re-specified, the bar is not widened, and the clean control runs first.** **The banked set was measured ONLINE** (default Ion imagery + World Terrain); from now on the three children boot the offline scene, so the frozen bars are online measurements applied to offline runs and were deliberately **not** re-derived. That is what makes the offline clean control the right next measurement rather than a repeat. Two further honest notes: the B/C and D legs of the derivation are properties of the numerator and of the census argument, **not** of the banked reports (`2/n < 3/n` and `3/n < 3/n` hold for every positive `n`), so they are mutation-tested at the runner rather than pretended to be fixture-live; and `recordedContext().laneNotAdjudicated.reason` still asserts a split lane that is `ok:false` with `Q2` UNKNOWN, which was true of the banked report and is **not** true of the 2026-08-25 one — a recorded note, not a bar, left exactly as landed. **Still open:** the clean control acquire run behind the offline pin; the presence-versus-magnitude decision; and Signal G's collection blind spot (`NEW-C11-170-SENTINEL-UNOBSERVABLE-TO-GATE`, sequenced after `NEW-WEBGPU-UPLOADIMAGESOURCE-CACHE-CONTRACT-TRAP`). **Row stays OPEN.** |
| `C11-209` (effects placeholder single initialization submit) | **COMPLETE — IMPLEMENTED / VERIFIED / LANDED Batch 1026; DIAGNOSTIC STARTUP SHAPE ONLY / NO TIMING CLAIM** | §1.29 / G6/G10 | The initializer retains all **11** required depth clears—base depth, four CSM layers, and six cube faces—but records them through exactly **one encoder, one finish/command buffer, and one queue submission**, reusing the cached base-depth view. The focused `WebGPUEffectsDeviceCache` Edge suite is **5/5**. Batch 1025 landed fail-closed provenance; the final schema-2 Edge/WebGPU artifact (`runId=81b6febc-f488-4a0b-b975-71c1d058ff4d`, SHA-256 `E370643CEEEEA318585EF00D1B3865A9CFA4258DACE6C6E063EE416CFFB6BA02`) is **17/17 PASS, exit 0** and proves the exact `{3 textures, 13 views, 1 encoder, 11 passes, 1 finish, 1 command buffer, 1 submit}` startup vector, exact base/CSM/cube subresources, and an exact seven-field zero delta across 24 visible steady frames with every error lane empty. Its first invocation was green, so no first-red exists; the prior schema-1 pass remains archived. Browser startup acceptance and landing are discharged. No timing percentage or performance win has been banked. |
| `C11-171` (split-screen viewer init) | **RESOLVED-STALE / PREMISE REFUTED — the page was never broken; the probe lane never clicked launch.** `split-screen-comparison.html` deliberately builds nothing until `#btnLaunch` is pressed (listener `:445-447`; globals published `:562-563` at current tip — the `:553-554` cite drifted), and the probe's split lane navigated and waited 90 s for viewers that by design do not exist yet — which produced exactly the filed symptom, zero console errors included. Repair landed Batch 1079 (`c3c4709626`, 2026-08-20): `lib/backend-isolation-launch.mjs` + `launchSelector: "#btnLaunch"`, 5/5 mutation-controlled contract spec. **The browser run of the repaired lane is OWED to the machine lane**; the probe's exit-0-on-lane-failure gap is fleet-wide and owned by C18 Wave V. | §1.25 / G9 | Batch 1079 |
| `C11-172` (ocean-wave octave LOD — **SCOPE EXPANDED by maintainer 2026-07-24, screenshot evidence**) | **COMPLETE — Batch 757** (3-iteration orchestrator/worker cycle: v1 rejected — 15 adversarially-confirmed findings incl. tile-UV footprint being SSE-scale-invariant, i.e. the WGSL octaves were sub-pixel BY CONSTRUCTION at every altitude and the pre-existing "waves" were animated mip-0 aliasing; v2 physical-wavelength redesign accepted on Edge evidence — near-band noise variance 45.65→2.04 (22×), real animating waves, far field calm; v3 fixed the v2 f32-precision blocker with RTE-style per-tile f64 phase offsets + integer repeat counts + WebGL animation gate. Landed with the orchestrator's hardware-aniso footprint clamp. All three maintainer requirements delivered: footprint octave attenuation, camera-height-aware fade (subsumed by the footprint metric), hard far cutoff. Karma enhanced-ocean 5/5; probe-ocean-wave-lod GATE PASS; GLSL recalibrated by czm_getWaterNoise's internal divisors — WebGL near/mid look preserved. KNOWN RESIDUAL filed: `OCEAN-WAVE-HIGHLAT-HORIZON-BAND` in DEFERRED_WORK) | §1.25 / G8 / `DEFERRED_WORK` `OCEAN-WAVE-OCTAVE-LOD` | Maintainer screenshot (low camera, open ocean, WebGPU): waves read as uniform per-pixel NOISE to the horizon — "very noisy and not natural." Mechanism: the high-frequency wave-normal octaves (esp. the ×800 ripple layer) are sub-pixel beyond a short range and alias into sparkle; nothing fades them by pixel footprint, and the march runs to the horizon. NOTE: this is SHADING noise (the water-mask wave normals), not displaced geometry — the FFT ocean is opt-in/off. EXPANDED SCOPE, three maintainer requirements: (1) **more natural look** — pixel-footprint/mip-aware octave attenuation (fade each octave as its wavelength approaches pixel scale; analytic-derivative or distance LOD), not just altitude gating; (2) **stronger distance fade** — start the intensity fade far earlier than the current 70 km–1 Mm ramp at low cameras; (3) **hard far cutoff** — beyond a threshold do not evaluate the march at all (branch to flat normal; saves the fetches AND kills residual shimmer). Keep WGSL/GLSL lockstep (classic branch now default on both, Batch 746); enhanced branch gets the same LOD. Verify with a low-camera horizon probe measuring high-frequency luminance variance vs distance bands (the screenshot's failure metric) + the existing ocean probes (waves must still animate near camera — temporal delta gate). |
| `C11-173` (measured display refresh rate in frame pacing) | **COMPLETE (Batch 741)** — in-page rAF measurement (doubly bounded: 31-frame cap + 2 s deadline), median→Hz clamped [30,360], recorded in every artifact as `displayRefresh` + `framePacing.refreshHz`; non-finite guard falls back to 60. Call-site drift noted: was :2545, found at :2605. | §1.25 / G10 | XS (~10 LOC). `summarizeFramePacing()` (`lib/performance-campaign-utils.mjs:120-154`) already computes `droppedFramesAtRefreshRate`, but `refreshHz` is a **default parameter of 60** and `run-performance-campaign.mjs:2545` passes ONE argument — so every dropped-frame figure silently assumes 60 Hz. Measure the real display period with a no-op rAF spin and thread it in. **Do NOT build a new quantization probe** — this one works, it just assumes its input. |
| `C11-174` (WebGPU cache-stats exposure) | **COMPLETE (Batch 741)** — pipeline + bind-group cache counters exposed in `getRendererStatistics()` (csmShadows try/catch pattern; PP effects reached via a type-only `_postProcessCacheStatsSource` back-ref registered by EnsureResources, `isDestroyed`-guarded) + `CesiumDebug.cacheStats()` + DEBUGGING_GUIDE row. Zero new per-frame work — pure read-side exposure of counters that already existed. | §1.25 / G10 | S (~40 LOC). `WebGPURenderPipelineCache.ts:168-200` + `WebGPUBindGroupCache.ts:81-95` **already track hits/misses/hitRate**; they are simply absent from `WebGPUContext.getRendererStatistics()` (:5377-5497). Expose via the `csmShadows` try/catch pattern (:5473-5479) + add `CesiumDebug.cacheStats()`. **A churning bind-group cache is exactly the shape of the Batch-717 bug** — pure exposure of counters already paid for. |
| `C11-175` (WebGPU adapter-selection audit) | **TRANSFERRED to C12 (LD-1, 2026-07-23)** — folds into `C12-03`; ID retained as alias. Was: NOT STARTED. | §1.25 / G9 | Chrome can silently select a **weaker adapter** for WebGPU than for WebGL (notably on battery) — a "deficit" that no code change can fix. Pass `powerPreference: 'high-performance'` at adapter request and log `adapter.info` beside the WebGL `RENDERER` string, so every future perf comparison records which physical GPU each backend actually got. Directly relevant: the maintainer's own reports come from a machine whose adapter pairing has never been recorded. |
| `C11-176` (skybox star-map fade parity) | **COMPLETE — PROMOTED out of W9 and landed 2026-07-19 (Batch 722)** | §1.26 / G8 | **ROOT CAUSE — none of the five suspects originally listed here; all five were DISPROVEN at file:line by the research sweep** (tonemap: both backends gate identically on HDR; sRGB: SDR path is byte-passthrough on both; AutoExposure: default false on both; mips: not generated on the skybox path; "missing multiplier": INVERTED — there was an EXTRA one). The actual cause was a WebGPU-ONLY star-brightness modulation shipping ON by default: `AtmosphericConditions.js:368` set `enableStarBrightnessModulation: true` while the consuming renderer `WebGPUCubeMapPanoramaRenderer.js:539-548` documents the flag as "Default OFF for WebGL parity" and gates on `=== true` as a fail-safe against an ABSENT property — shipping it present-and-true defeated that fail-safe. Two files contradicted each other, which is why it survived. WebGL's `SkyBoxFS.glsl` is NINE LINES and applies no such term, so this was a pure unmatched divergence: star colour multiplied by `1 - smoothstep(0,1,clamp((skyBrightness-0.5)*1.0,0,1))`, which at `skyBrightness = 1.0` (sun ≥ ~23.6° above the camera's local horizon — most of the sunlit hemisphere for an orbital camera) equals exactly 0.5. **MEASURED** (new `probe-skybox-star-modulation.mjs`, camera placed ALONG the sun direction so `skyBrightness = 1.0`): before — WebGPU/WebGL mean **0.493**, contrast(stddev) **0.552**, top-0.1% **0.585**, and visible star pixels **21.06% → 4.01% (5× fewer stars)**. Runtime A/B of the flag alone moved it to 1.001 / 1.009 / 1.000, **proving causation without a source change**. After the one-line default flip: mean **1.001**, contrast **1.010**, starPct **21.20% vs 21.22%**. Predicted dim factor 0.500 vs measured 0.493 — a 1.4% match. **GOVERNING PRINCIPLE HONOURED:** only the DEFAULT changed; forcing the flag true still dims to 0.493× (probe asserts `capabilityPreserved`). **Also fixed:** the renderer's fallback curve was `{inflection:0.3, steepness:4.0}` while the shipped curve is `{0.5,1.0}` — at `skyBrightness=1.0` the 0.3/4.0 pair yields factor **0.0, a TOTAL blackout**, strictly worse than the bug being fixed; aligned to `{0.5,1.0}`. **Also surfaced:** `enableNightSkyDimming: true` (`AtmosphericConditions.js:369`) has **ZERO consumers** anywhere in `packages/engine/Source` — left in place per the scaffolding rule but explicitly annotated as reserved/unwired. **Gate:** `probe-skybox-star-modulation.mjs` now asserts BOTH default-parity AND opt-in-still-functions → currently PASS. **Note:** the fade is fixed, but the shipped cubemap asset remains far sparser than the maintainer's ISS reference — that is `C11-178`, still open. |
| `C11-177` (bright-star appearance model) | NOT STARTED | §1.26 / G8 | "White blobs" → real stars. Logarithmic magnitude→luminance (5 mag = exactly 100× flux; naive linear mapping is why bright stars clip to flat white); PSF = Gaussian core + wide power-law halo, matching the maintainer's Polaris reference (continuous falloff over many core radii, NOT a hard-edged disc); B−V colour index → blackbody RGB so the field is not monochrome; HDR energy driving bloom rather than a painted-on sprite glow. Note the reference image shows NO diffraction spikes — a naked-eye/window view would not have telescope vanes, so spikes are a stylistic choice, not realism. |
| `C11-178` (star-map asset upgrade) | **PARTIAL — mechanism LANDED + licence gate CLEARED (2026-07-23 reconcile)** | §1.26 / G8 | `SkyBox.Variant` T3/T5 enum + `defaultVariant` + `createEarthSkyBox(variant)` shipped Batch 728 (`86c895b0d2`), runtime-verified. Licence question CLOSED Batch 731 (`851ce64389`): §6f project-scope ruling in `QUEUE_2026-07-19_CAMPAIGN12.md` — reopen triggers are redistribution/commercial/third-party grant. REMAINING: acquire + bake the six t5 faces (`C12-10` owns the bake pipeline) and the one-line `SkyBox.defaultVariant` flip. Maintainer directive "Default to T5 for now" (Batch 728) is OUTSTANDING — flipping before the faces land would 404 the sky. **UPDATE 2026-08-07 (close-out docs reconciliation): the recorded REMAINDER is DISCHARGED by Campaign 12 — this row's own text has nothing left in it.** Verified at HEAD rather than inherited: (a) the six t5 faces ARE baked and bundled — `packages/engine/Source/Assets/Textures/SkyBox/tycho2t5_80_{px,mx,py,my,pz,mz}.jpg` plus a full `tycho2t5_80_diffuse_*` set, landed by `C12-10` at Batch 742 (`71070fb785`) and gate-verified on both backends at Batch 744 (`7531209e0f`); (b) the "one-line `SkyBox.defaultVariant` flip" has happened **twice** — to `TYCHO_T5` at Batch 742 and on to `TYCHO_T5_DIFFUSE` at Batch 833 (`a8864e7ff7`, `C12-11`, ruling DR-01) — `packages/engine/Source/Scene/SkyBox.js:361` reads `SkyBox.defaultVariant = SkyBox.Variant.TYCHO_T5_DIFFUSE` at HEAD, so the maintainer's "Default to T5 for now" directive is satisfied and then superseded by a later ruling, not outstanding; (c) **the ARCHITECTURAL call this row also carried is discharged too** — DR-01 is precisely the seam the row asked for (texture holds the diffuse Milky Way, bright stars come from a catalogue as point sprites): the default cube map now supplies the degrees-scale galactic band only while every *resolved* star comes from the `StarField` sprite catalogue at its actual RA/Dec (`Scene/StarField.js` + the `SkyBox.Variant` JSDoc), pixel-verified at Batch 837 (`4113ed8393`). **RECOMMENDATION: CLOSE.** The status label is left as PARTIAL for the orchestrator's close ruling rather than self-promoted; the live successors are C12 rows (the `C12-11` star-census live calibration and the owed `probe-stars-catalog` Edge run), not this one. Original row follows:  Denser Milky Way with dust lanes per the ISS reference. **LICENSING GATES THIS** — Apache-2.0 repo (this original-row copy corrected `R-2026-08-21-23`), so public-domain (NASA SVS Deep Star Maps) strongly preferred; share-alike or non-commercial sources are DISQUALIFIED regardless of quality. Carries the architectural call: texture holds the DIFFUSE Milky Way, bright stars come from a catalogue as point sprites — conflating both in one cubemap is a leading hypothesis for why bright stars read as blobs today. Must land on BOTH backends (Principle 5). |
| `C11-179` (sun + moon appearance) | NOT STARTED | §1.26 / G8 | **Sun:** correct ~0.53° angular diameter, limb darkening (cheap, high realism-per-effort), HDR-driven glare — and physically, in vacuum there is NO atmospheric scattering halo, so the glow is instrument/eye response. The sun is ~10⁵× brighter than anything else in frame, making it the extreme case for the HDR chain and AutoExposure. **Moon:** non-Lambertian reflectance (Hapke / Lommel-Seeliger — the full moon is far brighter and flatter than Lambertian predicts), opposition surge, earthshine on the dark limb, public-domain LROC/CGI-Moon-Kit albedo + normal maps, correct ~0.52° angular size. **Do NOT double-schedule:** `C11-160` (sunBloom PP wiring), `C11-115` (sun blend → ALPHA_BLEND), `C11-161` (AutoExposure demand-gate) are already queued; prior fork work exists on moon matte-not-sunlit + moon atmosphere extinction. |
| `C11-180` (WebGL async shader compile lifecycle + bounded final-program scheduling) | **PARTIAL — core lifecycle and measured bounded fog-companion slice integrated and verified (2026-07-28); LANDED (Batch 773, 2026-08-01)** | §1.27 / G9/G10 / `DEFERRED_WORK` `WEBGL-ASYNC-SHADER-COMPILE-LIFECYCLE` | Baseline lazy route: 7 programs / 14 shaders, 7 blocking `LINK_STATUS` waits totalling 753.9 ms, 7 long tasks. Rejected eager matrix: 28/56, the same 7 waits, and 21 unused async completions. Principal-review final bounded policy: 8/16, 7 drawn + 1 unused, 4 blocking waits totalling **403.0 ms**, 4 async completions, and 4 long tasks. It schedules the final log-depth/HDR executable and only the measured zero/one-texture fog companion; configured and currently renderable fog can prepare the transition without compiling every structural variant, while material/clipping compatibility, retry/deduplication, shadow/translucency, and WebGPU-isolation gates bind the policy. Fresh clean r3 median CPU p95 **5.5 ms** and wall p99 **21.178 ms**; moving visual track 9/9, mean diff 0.016%, worst 0.073%, no quality red; focused Edge **11/11 + 23/23**. **REMAINS:** four structural first-use stalls plus separately measured shadow/HDR/translucent companion work; no complete-lifecycle or campaign-close claim. |
| `C11-181` (globe shader variant eviction/reference correctness) | **COMPLETE — IMPLEMENTED / VERIFIED / LANDED (Batch 773, 2026-08-01; administrative close 2026-08-09)** *(Close authority: `DEFERRED_WORK.md`, landed Batch 1063 `21c9489185`, 2026-08-20.)* | §1.27 / G2 / `DEFERRED_WORK` `WEBGL-GLOBE-SHADER-VARIANT-EVICTION-REFERENCE` | Replacement acquires the new cache reference before releasing the displaced wrapper and poisons the shared stale wrapper so a culled tile cannot later return a released program. Focused material, clipping-state, eclipse active/inactive reuse, async-cache ownership, build/type, and moving visual gates are green. No named acceptance remains. |
| `C11-182` (model material exact-byte upload suppression) | **PARTIAL — IMPLEMENTED / ATTRIBUTION GREEN / TIMING CERTIFICATION OPEN** | §1.27 / G5/G10 | Exact-byte dirty suppression is wired for primary/silhouette/translucent material UBOs. The 1,093-frame API lane packed 22,324 material blocks and issued **zero** unchanged material uploads; persistent word views also remove transient `DataView` allocation. Multi-pair timing and focused browser coverage for changing materials remain open. |
| `C11-183` (water-mask single native realization) | **PARTIAL — IMPLEMENTED / DOUBLE-REALIZATION REMOVED / VISUAL CERTIFICATION OPEN** | §1.27 / G2/G10 | Same-device native compatibility textures are borrowed with cross-device and WebGL-orientation fallbacks retained. Historical API evidence contained 595 `GLStub_Texture` plus 385 `Globe water-mask fallback` realizations; current attribution retains the 488 logical/native stub owners and records zero globe fallback copies. This proves the architecture change, not a standalone timing percentage. Broad water-mask visual/device-loss coverage remains open. |
| `C11-184` (native model/globe shadow correctness architecture) | **IN PROGRESS; LANDED (Batches 775/780, 2026-08-01)** | §1.27 / G5/G10 | One-pass default ownership, unique caster collection, RTE cast matrices, single/CSM/point receive, topology/cull pipeline keys, stable bind-group owners, first-frame resource preparation, fitted-prefix refresh, CSM frame intent, and globe `ShadowMode` adaptation landed with the Codex C11 pass. The orchestrator review additionally fixed the WebGPU sun-shadow regression in this lane: `Scene` no longer passes `cascadesEnabled: false` on WebGPU, and `ShadowMap.update` publishes the fitted whole-frustum light camera through pass 0 (computing `_shadowMapMatrix` under `managesSceneShadowCascadesNatively`), so the receive path is no longer a zero matrix masked by a truthy logical-OR fallback. The 2026-07-31 review additionally fixed device-owned model shadow UBO recovery, reused existing camera high/low data instead of repeating matrix inverses, made terrain CSM globals renderer-owned/allocation-free, covered both terrain layouts, and conservatively retained stale/invalid command bounds. Canonical build and package TypeScript are green. Focused Edge/Karma, moving shadow pixels, Earth-scale motion, toggle transitions, strip-index-format topology completion, and settled allocation/upload evidence remain required. **UPDATE 2026-08-07 (close-out docs reconciliation) — the GLOBE SUN-SHADOW RECEIVE leg is DISCHARGED AT PIXELS, and this row never recorded it.** `Tools/visual-regression/probe-sun-shadow-gate.mjs` first ran at Batch 845 (`c5c5be0a4a`) and found WebGPU receiving **no** globe shadows at all (drop 0.00, 0 darkened px); Batch 849 (`c7365d80f7`) root-caused it as the cast depth being written and then WIPED plus a double-biased receive matrix; Batch 850 (`c178510469`) re-ran the probe on the post-849 rebuild and measured **DAY_UNLIT WebGPU drop 20.17 against WebGL 20.17 — ratio EXACTLY 1.00 — with 58,833 darkened pixels against a 4,000 floor**, DAY_LIT ratio 0.45 inside its [0.4, 2.5] band, and Gate E no longer STRUCTURAL but passing on BOTH backends (`darkness` public/effective 0.3/1, `outOfView` true), which also confirms the two filed divergences (unfaded darkness, ignored `outOfView`) are genuinely fixed rather than merely unobservable. **SCOPE OF THE DISCHARGE: the globe-RECEIVE leg only.** Everything else in this row's matrix stays open exactly as written above — focused Edge/Karma, moving shadow pixels on models, Earth-scale motion, toggle transitions, strip-index-format topology completion, and settled allocation/upload evidence. |
| `C11-185` (visibility-triggered model preparation) | **SLICES 1–3 IMPLEMENTED / LANDED (Batches 774/780, 2026-08-01) / ATTRIBUTION GREEN / TIMING CERTIFICATION OPEN (2026-07-31)** | §1.27 / G5/G10; FAR-303/FAR-309 | Slice 1 rejects only provably off-frustum standalone cullable models during ordinary SCENE3D colour rendering; its five-plane culling snapshot is cached once per Scene/frame, minimum-pixel-size models bypass early rejection, every uncertain/shadow/capture/tile/classifier/pick/2D/stereo case remains conservative, and readmission resets temporal history. Slice 2 skips absent/GLSL-only native custom-shader prep, removes transient material `DataView`s, and closes root/node 2D-IDL/custom-UB lifetime gaps. Slice 3 creates the root camera/RTE block only when the first pipeline-backed emitted command consumes it; cooking/non-emitting nodes create none, while transformed tile-owned nodes retain their exact node block. Current-bundle attribution: 53,821 candidates = 20,384 view + 1,597 conservative tile-owned + 31,840 frustum rejects; 21,981 admitted runs = 21,981 camera packs/writes/effects/material/light/commands, zero custom-shader prep, zero unchanged material uploads, exact conservation over 1,088 frames, clean teardown. This validates avoided work, not a timing percentage; focused browser and exact counterbalanced clean timing remain open. |
| `C11-186` (fresh-imagery upsample regression) | **NOT STARTED** | §1.27 / G2 | Focused red remains queued for diagnosis after the performance pass; no feature was removed or weakened. |
| `C11-187` (Hi-Z degenerate/over-capacity conservative fallback) | **IN PROGRESS; LANDED (Batch 778, 2026-08-01)** | §1.27 / G10; FAR-003/FAR-500/FAR-501/FAR-503 | Original-list identity/order pass-through is implemented for skipped, non-finite, degenerate, binary32-unrepresentable, and over-capacity entries; focused source cases and the canonical build are green. Focused Edge/Karma execution remains unavailable, so the row stays open. This narrow row does **not** bootstrap, populate, activate, or certify Hi-Z depth provenance, generations, RTE, readback ordering, or automatic consumption. |
| `C11-188` (styled translucent twin node matrix) | **LANDED-PARTIAL — Batch 1114 (2026-08-21).** The styled translucent twin's material-UB pack in `WebGPUModelRenderer` now receives `nodeModelMatrix` / `prevNodeModelMatrixForPack` instead of root `modelMatrix` / `cache.prevModelMatrix`, so articulated/non-identity nodes get node-correct fragment world reconstruction and motion. Spec `c11-188-translucent-twin-node-matrix` 2/2. **Owed:** browser leg with an articulated translucent styled model. | §1.27 / G5 | Batch 1114 |
| `C11-189` (style-aware shadow coverage) | **NOT STARTED** | §1.28 / G5/G10 | Dedicated visibility-equivalent caster; queued after the performance pass. |
| `C11-190` (combined skinning + instancing shadow) | **NOT STARTED** | §1.28 / G5/G10 | Animated-crowd native cast variant; queued after the performance pass. |
| `C11-191` (morph/custom-deformation shadow coverage) | **NOT STARTED** | §1.28 / G5/G10; C11-92 | Colour/cast silhouette parity; queued after the performance pass. |
| `C11-192 … C11-211` (post-attribution architecture tail) | **EXECUTING; `C11-192/199/200/201/209/211` + C11-193 ALLOCATION SLICE LANDED; C11-193A/B/C LANDED at `b20234a16b`; C11-196 + C11-202 BOUNDED GATE + C11-210 LOCAL/FOCUSED-EDGE/BROWSER GREEN; `C11-205` LOCAL MEASUREMENT GATES GREEN; REMAINING LANDING/REMEDIATION OPEN — NOT COMPLETE / NO FPS CLAIM** | §1.29 / G2/G3/G4/G5/G6/G8/G9/G10 | The prior demand-realized resource slices remain as recorded. C11-193A/B/C now retain transactional manager-local outputs, borrow the exact Scene encoder with submit-owned unique arena leases, and collect primitive-phase manager ticks for final same-frame DEMANDED/UNKNOWN-before-PROVEN_NONE drain. C11-193C retains coordinator jobs/scratch, pins context/generation, handles destroyed/error/reset cleanup, holds split-2D NORMAL work for late promotion, and keeps MANDATORY/escalated grants outside the one deferrable slot. Combined Node is 56/56, focused Edge is 31/31, package TypeScript and the fresh 79.7 s build are green. Final real-browser C artifact is 29/29: priority HIGH/NORMAL 44/0 on one Scene submit, resumed NORMAL 44 next frame, MANDATORY+HIGH 88 on one Scene submit, real split 2D 0 first-segment/44 continuation, stable repeats zero, exact pending/scope/commit/arena/buffer settlement, private encoders/submits 0/0, isolated manager outputs, and zero errors. The preserved first red is Tools-only (`needsUpdate===true` overconstraint); final identity gates are fail-closed. Moving/FPS attribution, broader recovery/HQ reuse, residual allocation cleanup, one-device/browser limits, and GPU-completion certification remain open; no performance percentage is earned. C11-196 locally defers native model pick IDs/lookup texture/pipeline/derived commands until exact pick demand while retaining ordinary styling and synchronous first-pick functionality. Node is 13/13, focused Edge 19/19, and the final browser artifact is `pass=true`, exit 0: cold native counts 0/0/0/0; first pick 1 generic + 30 dense IDs + one texture/pipeline; repeat/later color zero new pick-resource work; `allowPicking=false` returns no hit and native counts remain zero. That historical run exposes **30 legacy `BatchTexture` registry IDs before the allow-picking command gate**. The local bounded C11-202 gate now suppresses that legacy realization only when a non-classifier native MODEL renderer owns dense picking; WebGL/default callers, classifiers, post-process, styling, and synchronous exact feature picking remain. The final C11-202 diagnostic artifact is green: WebGPU cold/disabled legacy work is zero, first enabled pick creates only 1 generic + 30 native IDs and one native lookup texture, while WebGL still creates exactly 30 legacy IDs and one texture. Node is 16/16, final focused Edge is 23/23, integrated build is green, and exact retired texture/ID generations survive promotion failure and multi-primitive migration. This closes only the exposed legacy-allocation slice; mutable feature-label source invalidation, async readback settlement, landing, broad descriptors, moving measurement, and recovery remain open. C11-210 locally restores native compute-command-list execution on the exact active frame encoder, with callback settlement bound to that encoder's submit/abandon result and no private submission. Focused Edge is **43/43** with **17,817 skipped**; integrated TypeScript/build/diff gates are green; independent review is P0=0/P1=0; and the final hardened real-browser artifact passes **30/30** across normal, pick, and a real wrapped 2D split with exact sentinel/callback/submit/error gates. Its first 0-test Karma attempt (missing `CHROME_BIN`) and first browser structural red (generic pipeline-label discriminator plus Rectangle 2D search) are retained and attributed to their harnesses. C11-209's final schema-2 startup artifact passes **17/17** with exact `{3 textures, 13 views, 1 encoder, 11 passes, 1 finish, 1 command buffer, 1 submit}` initialization, exact source/build provenance, and exact zero repeat work across 24 visible steady frames; all error lanes are empty and its first browser invocation was green. C11-209 landed in Batch 1026; the remaining local items are unlanded architecture/correctness evidence, not measured FPS wins. C11-205 lifecycle and exact-work measurement gates remain green locally but the row is not complete until landing/remediation. C11-169 remains diagnostic; C11-208 and C11-209 are closed. C11-210 landed Batch 1071 (`806a7f2ce4`, 2026-08-20); the P2 recovery/multi-context/variant boundaries in its canonical row remain open. |
| `C11-212` (Scene.snap WebGPU parity) | **PARTIAL — surface baseline + both-backend real-Edge multi-frustum gate green; broader motion/architecture gates open** | §1 v1.144 parity rows / G7 | Batches 812/813 proved the frozen-view surface hit. The 2026-08-02 continuation (landed Batch 819) fixes active-encoder ordering, immutable rendered-view/sample/far provenance, CSS/DPR/Y and asymmetric-frustum math, bounded overlap, split loads, cleanup, and snap-only command realization. WebGPU scissored reset and WebGL snapless-occluder erase pass a forced distinct-slice Edge case with TAA; compact exact RG32Uint saves 63.28 MiB at 4K and leaves ordinary picking unchanged. Combined Node 69/69. Open: SCENE2D slice depth; moving camera/cursor across DPR/projection/viewport/edge/RTE; aperture/padding; transient pooling; classification/non-Model producers. The EDGE producer (`UP144-SNAP-WEBGPU-EDGES`) landed 2026-08-02 at Batch 821 with Node 25/25 and owes only its browser gate (an Edge snap at a model silhouette returning `isEdge: true` on BOTH backends). See the current overlay rider and `DEFERRED_WORK.md`; do not close the row. |
| `C11-213` (vector-layer draping WGSL twin) | **PARTIAL — IMPLEMENTED / LANDED Batch 827; streak defect FIXED Batch 834; PIXEL-VERIFIED Batch 835; acceptance NOT fully discharged, do NOT mark complete** | §1 v1.144 parity rows / G2 | The WGSL twin ships, but NOT in the shape the row specified. Binding "the five `u_vector*` tile textures" is impossible under the C11-208 low-limit layout: group 2 already charges 5 of the 12 non-imagery fragment sampled textures, and the reduced 4-slot imagery shape lands on exactly the 16-texture WebGPU spec floor — five more would make it 21 and fail pipeline creation on default-limit adapters. GLSL's `texelFetch` on those five is not sampling, it is WebGL2's only buffer-read primitive, so the WGSL twin uses ONE read-only storage buffer (`@group(2) @binding(11)`) packed by the new `WebGPUVectorTileResources.ts`; the sampled-texture budget (`GLOBE_NON_IMAGERY_FRAGMENT_TEXTURES` = 12) is unchanged. Per-tile gating is a runtime header word, not a shader define, so no globe pipeline variant forks (WebGL's `0x400000000` shader-set bit stays WebGL-only and untouched). Bake routing goes through a new `prepareVectorTileData` hook on the `GLOBE_SURFACE` feature-renderer descriptor. Node `vector-layer-draping.spec.mjs` 21/21 incl. a GLSL-oracle ↔ WGSL-reader equivalence proof over real `packPolylineGrid` output, 5 mutation tests, and naga validation of `GlobeTerrain.wgsl`. **Acceptance (Batches 830/831/834/835):** `probe-vector-draping.mjs` ran twice on Edge. Run 1 verified the core claim (draping renders on WebGPU, centroid 0.4 px, count ratio 1.014, colour + width correct, grazing Jacobian holds, 0 errors including destroyed-buffer across pan churn) and caught a real WebGPU-only streak defect on gate B; Batch 834 root-caused it to a singular UV Jacobian inverted to the ZERO matrix on terrain skirts (guarded in BOTH shaders — WebGL's prior correctness rested on GLSL `inverse()` dividing by zero, which the spec leaves undefined) and run 2 verified the fix at pixels (A/C/D/E pass, RED count exactly equal, centroid 0.0/0.0, oblique bboxes identical). **Still owed — CORRECTED 2026-08-07:** ~~gate B now fails on a PRE-EXISTING WebGL-side extent (`NEW-WEBGL-VECTOR-DRAPING-RESIDUAL-EXTENT`, LOW) and~~ ✅ **gate B PASSED at Batch 842** (post-Batch-841 rebuild; identical nadir bbox `[451,19,584,747]` on both backends, delta 0, counts 22396/22397), so **gate F is the ONLY thing still owed** — STRUCTURAL pending a pre-change cross-build baseline. **RESOLUTION PATH for gate F, so the row is actionable rather than parked** *(added 2026-08-09, handover audit FIX 22)*: the gate is structural because the pre-change baseline was never captured on a build comparable to the post-change one, and cross-build comparison is exactly the class the fork has ruled invalid. **Do not compare across builds.** Instead, build the pre-change engine state at a pinned commit **in one worktree**, capture the baseline and the post-change capture **from that same build in the same session**, and score the delta — i.e. reproduce the toggle in-tree (revert-the-hunk, or gate it behind a runtime flag) so both arms come from one binary. If the hunk cannot be toggled at runtime, the honest alternative is to declare gate F **unreachable as written** and replace it with a same-build A/B on the vector-draping flag, stated in this cell. Either way the row closes on a decision, not on an indefinite wait. `DEFERRED_WORK.md` `UP144-VECTOR-LAYER-WGSL`, `NEW-WEBGPU-VECTOR-DRAPING-HORIZONTAL-STREAKS` (fixed+verified), `NEW-WEBGL-VECTOR-DRAPING-RESIDUAL-EXTENT` (**RESOLVED at Batch 842**). |
| `C11-214` (B699 shared-cause diagnosis) | **NOT STARTED — MINTED 2026-08-07 (close-out docs reconciliation)** | §1.30 / §4 pt 7 / G5 §G5.0 | The item itself is not new: §4 point 7 (`C11-00B` launch intake, 2026-07-18) ruled that the two Batch-699 findings "plausibly share one cause" and must be "intake[d] as ONE shared instrumented diagnosis … before slicing either", and §1.23's append accounting deferred the ID to "when that diagnosis slice is cut". The slice was never cut, so no ID was ever assigned and the item appeared in neither §1 nor this ledger — the close-out inventory found it by reading §4, not by counting rows. Numbered here per the append-only rule (`C11-214` verified free across the whole `C11-*` namespace). **Scope unchanged:** one instrumented diagnosis of `NEW-WEBGPU-TILE-FEATURE-TRANSLUCENT-COLOR-COMPOSITE` + `NEW-WEBGPU-B3DM-TILE-CONTENT-PICK-EMPTY` under the `FLAG_HAS_FEATURE_ID_ATTRIBUTE`-for-b3dm hypothesis, sequenced ahead of `C11-82`/`C11-84`. |
| `C11-176a` (skybox-fade gate probe extension) | **TRANSFERRED to C12 (LD-2, 2026-07-23) — absorbed by `C12-01`** | §1.26 / G8 | Substance half-landed in `probe-skybox-star-modulation.mjs` (Batches 722/724: sunlit + night lanes, runtime A/B, contrast metrics, opt-in gate). Still owed: M1 source census, M2e sky floor, wiring `brightPct` + a default-pair assertion into `probe-env-skybox-stars.mjs`. **`QUEUE_2026-07-19_CAMPAIGN12.md` `C12-01` ABSORBS this** — if C12 launches (LD-2), close here as transferred. |
| `C11-176b` (moon `phaseGate` deletion) | **COMPLETE — Batch 755; targeted moon-phase browser gate PASS.** Gate deleted from `Moon.wgsl` (`var color = lit;`); `phaseFraction` UB member + `ud[67]` pack + `frameState.moonPhaseFraction` publication KEPT (C12-21 scaffolding + fog/sky scalar consumers). `probe-moon-phase-gate.mjs` covers three Simon1994-derived lanes (day-crescent blackout / crescent partial-dim / night-full control) with projected-ROI metrics and provenance SHA gating; `moon-phase-gate.spec.mjs` includes naga validation. **Batch-517 re-baseline finding: NOT needed** — its crescent lane runs at illumFrac ≈0.43 > 0.3 where the old gate was exactly 1.0, so the deletion is byte-identical there. Log: `WEBGPU_DEBUGGING_LOG.md` C11-176b entry. *(Was: TRANSFERRED to C12 W1 as rider, LD-2 2026-07-23.)* | §1.26 / G8 | `Moon.wgsl:345-346` was the third instance of the default-ON WebGPU-only celestial-multiplier class (`enableMoonPhase` defaults true, no GLSL consumer; also a physical double-count vs N·L). Root confirmed 2026-07-24: gate born in `8620f7c171` (2026-04-09) already alongside real `sunDirMC` N·L — an aesthetic double-count from birth, not scaffolding (Principle-7 check clean). |
| `C11-176c` (celestial stale-comment corrections) | **COMPLETE (Batch 741, as C12 W1 rider per LD-2)** — 6 files corrected incl. two additional stale sites found in-flight (`StarFieldMath.ts:132` HI comment, `SkyBox.js:62-64` getter JSDoc); generated `StarField.js` regenerated | §1.26 / G8 | Four comments assert an HDR/bloom path that is off by default (`StarField.wgsl:14-16,145-146`, `StarFieldFS.glsl:23-24`, `StarFieldMath.ts:118-119`); `StarField.js:63` "~0.34°" for 0.0042 rad (actual 0.2406°); `SkyBox.js:49-55` "inert no-op" falsified by `Renderer/Context.js:766-789`. `LICENSE.md` dead-URL sub-item DISCHARGED by Batch 730. XS, comment-only. |
| `C11-SEED-27` (C10-30 clean-env r5 re-measure) | DEFERRED (seed) | §1.23 / G10/G9 | Gate-D anchor input |

---

## 4. `C11-00B` launch intake (summary — full procedure in G10 §B6)

> **EXECUTED 2026-07-18 — `C11-00B` COMPLETE.** Campaign 10 CLOSED at **Batch 711 (`9a52717cf2`)**.
> Sweep results are folded below and into §1.23 (appended rows), §3.2 (seeded ledger), and §7.0
> (resolved decisions).
>
> - **C10-30 verdict:** green mechanics + deterministic **−33% render-passes/frame**; wall-clock
>   **env-confounded → iterate (no banner)**. The clean-environment r5 **re-measure is a C11 follow-up**,
>   seeded as **`C11-SEED-27`** (Gate-D reference). Gate A still anchors on the recorded `C9-30` clean-r5
>   artifact per §3 — the new tree is NOT re-baselined.
> - **Boot chain:** `C10-08` BLOCKED at C10 close (registry EXHAUSTED — bits 0–30 used; the fragile
>   sign-bit 31 was deliberately NOT consumed per the ruling) → **`C11-149` define-width is the HARD
>   PREREQUISITE, pulled to W1** to widen the registry; it unblocks the `C11-158` enhanced-ocean toggle. The `C10-07` follow-on
>   `NEW-WEBGPU-DETERMINISTIC-SYNC-PIPELINE-CENTRALIZATION` is seeded as **`C11-165`**.
> - **Pick fleet:** `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH` (`C11-IC-01`) DONE, but the **reversed-Z-convert-
>   back surface is noted** — read the `C11-GT-01` reconciliation record before treating the log-depth
>   conversion permanent (same 71-file surface). The C10-11 **cold-page async-pick-readback RACE** is
>   seeded as **`C11-164`** (distinct from the June-361 docs-only close of the same name).
> - **Batch-700 OIT NO-GO:** the real prerequisite `NEW-WEBGPU-OIT-TRANSLUCENT-PRIMITIVE-WIRING` is
>   intaken as **`C11-157`** — RESOLVED to **FULL primitive→collection→model wiring, TOP of W1** (§7.0);
>   silhouette body-wash (`C11-91`) folds in. MRT-OIT default-off stays FAR-003-contained (not a metric
>   flip).
> - **Splat** (`C10-04`) stays BLOCKED-ON-MAINTAINER (`C11-26` producer → `C11-IC-02`). **High-density
>   drift** = `C11-11` (diagnose-first, lean repair — §7.0).
> - **Reversed-Z** (`C11-GT-01`): its measurement-only spike is pulled into **W1** (slice work stays
>   gated §6). If C10 already ran it, its verdict is a `C11-00B` fact recorded in all three sinks.
> - A launch note + `git branch -a` inventory were presented to the maintainer before the first slice.

Run ONCE at launch, BEFORE the first slice. It converts everything still open when C10 closes into
owned C11 rows so nothing falls through the C10→C11 seam (the load-bearing bridge, exactly as
`C10-00B` was for C9→C10). **Re-sweep the LIVE C10 ledger** (`QUEUE_2026-07-16_CAMPAIGN10.md` §3.2) —
the register sweep was HEAD `aef553d592` (Batch 698); the tree has since moved (C10 landed Batches
693–699+). Absorb, as seeded ledger rows:

1. **The `C10-30` measured-checkpoint verdict.** If it MISSED, its per-stage attribution REORDERS C11
   waves (the stage carrying the most unrecovered cost names the highest C11 lever) and is the trigger
   input for the reserve levers (`C11-GT-03`) and the gated tail. If it PASSED (or never ran and
   `C11-GATE-D-CHECKPOINT` re-runs it), record the anchor per Gate A. Target unchanged: ≥10%
   whole-route + ≥15% near-ground WebGPU CPU-p95 OR >3× noise.
2. **The boot chain `C10-06` / `C10-07` / `C10-08`.** `C10-06` outcome determines whether `C11-153`
   (S8-4 FR-lazify) is absorbed or standalone; `C10-07` sequences `C11-150` (module granularity)
   after; **`C10-08` gates `C11-149` (C10-08b define-width)** — the ShaderDefine registry is EXHAUSTED
   (bits 0–30 used; C10-08 was BLOCKED because only the fragile sign-bit 31 remained and the ruling
   forbade consuming it), so `C11-149` is the HARD prereq for any new define bit
   (`C11-92` Q31 varyings, `C11-88` KHR gates, `C11-89`, `C11-81`, `C11-131` OCEAN_PLANAR_REFLECT).
3. **The pick fleet `C10-11` / `C10-12` + the 5 W4 riders.** `C10-11` owns `C11-IC-01`
   (NEW-WEBGPU-PICK-FLEET-LOG-DEPTH); `C10-12` closes `C9-02A` (`C11-06`) + audits `P0-1` + flips
   `PICK_DEPTH_PLANE_ENABLED`. C11 picks up only what W4 leaves: `C11-02`/`C11-03`/`C11-04`/`C11-05`/
   `C11-12` (each on its own oracle, no metric). **Verify the `C10-11` outcome AND its `C10-13`
   reversed-Z reconciliation record before treating the log-depth conversion permanent** (G10 §A1).
4. **The `C10-13` reversed-Z spike outcome (`C11-GT-01`).** Its GO/NO-GO redirects the entire
   `gated-reversed-z` cluster (`C11-GT-01/02`) AND the pick fleet (same 71-file surface, opposite
   directions). If it already ran in C10, its verdict is a C11-00B fact.
5. **The Batch-700 OIT NO-GO.** `M-OIT-COVERAGE-AND-FLIP-EVIDENCE` verdict = **NO-GO (flip nothing)**.
   WebGPU MRT-OIT is unreachable for standard translucency — the composite line has never executed
   (only Gaussian splats + opaque globe produce `_shaderCode`). The real prerequisite is
   **`NEW-WEBGPU-OIT-TRANSLUCENT-PRIMITIVE-WIRING`** (**intaken as `C11-157`, RESOLVED 2026-07-18 to
   FULL primitive→collection→model wiring, TOP of W1 — §7.0**) + the two live FAR-003 adjacencies
   (`C11-18`, `C11-23`). Also intake the pre-existing
   Batch-699 `NEW-WEBGPU-CUSTOMSHADER-TRANSLUCENCYMODE-ALPHA-UNDERAPPLIED`. MRT-OIT default-off stays
   RATIFIED FAR-003 containment — do NOT flip it for a metric.
6. **The defaults-parity runtime pass results.** `DEFAULT_PARITY_MATRIX_2026-07-18.md` catalogs 22
   backend default divergences (5 visible-visual) feeding G8 — enhanced-ocean #1, night-lights,
   AutoExposure, background-color (`C11-17`), the OIT flip (now NO-GO). Its runtime-verification
   results are C11-00B facts; each surviving flip candidate becomes a seeded row with the maintainer
   sign-off protocol attached (a default-visual flip is CLAUDE.md Rule 1 policy). **Enhanced-ocean is
   NOT a clean flip** (§7).
7. **The two Batch-699 findings that plausibly share one cause:**
   `NEW-WEBGPU-TILE-FEATURE-TRANSLUCENT-COLOR-COMPOSITE` + `NEW-WEBGPU-B3DM-TILE-CONTENT-PICK-EMPTY` —
   `FLAG_HAS_FEATURE_ID_ATTRIBUTE` never set for b3dm content. **Intake as ONE shared instrumented
   diagnosis (G5 §G5.0/§0) before slicing either** — seed a single new C11 row for the shared
   diagnosis, sequenced ahead of `C11-82`/`C11-84`.

**Output of `C11-00B`:** the seeded §3.2 ledger + a one-paragraph launch note ("C10 landed X/N;
fallout intaken as M rows; C10-30 verdict = pass|iterate; C11 wave order adjusted by <attribution>")
presented to the maintainer BEFORE the first slice, with a `git branch -a` inventory. Resolve any
LAND-INCOMPLETE unpushed commits first; launch on a clean tree (`tsc` green).

---

## 5. Waves

> **DISCHARGED-BLOCKER NOTICE (2026-08-21 queue-truth pass; every premise re-verified against git).** The wave prose below was authored before three blockers discharged and still cites them as pending in several places. Read those citations as historical: **(1) `C11-149` define-width LANDED Batch 739 (`bf7b20c6d3`)** — every "HARD PRED/PREREQ `C11-149`" clause (W1 early-define, W4 fan-out, §7.0, §7.2) is satisfied; `C11-158`, its named dependent, is itself COMPLETE (Batch 746). **(2) Campaign 10 CLOSED Batch 711 (`9a52717cf2`)** — every "intake-conditional on C10-xx" clause is discharged (C10-06 B702, C10-07, C10-11 B709, C10-12 B710; only `C10-04`/`C10-08` were blocked at close and `C10-08`'s successor is the landed `C11-149`). **(3) The `C11-GT-01` reversed-Z spike EXECUTED and returned NO-GO at Batch 717 (`a0ca50bea7`)** — W8's "if not already run" hedge is resolved; `C11-GT-02` will not activate, so §7.2's "may be throwaway if `C11-GT-02` activates" (`C11-48`) and its "if `C11-GT-01` recorded GO" strategic-hazard paragraph are both settled in the safe direction. Also corrected by this pass: item 5 below and §1.25 restate the `C11-171` premise that the split-screen page fails to init — that premise is REFUTED (the probe never clicked `#btnLaunch`; repair Batch 1079), and the W1 checkpoint pairing of `C11-01` + `C11-11` is stale on both halves (`C11-01` convergence half closed Batches 1069/1085; `C11-11` re-attributed Batch 919). The §1 cells and §3.2 ledger rows carry the per-row stamps.

Waves are executed **strictly sequentially inside the loop** — "wave" is a planning grouping, not
concurrency. Order within a wave is the `TASKS` order. `C11-00`/`C11-00B` run before W1. The wave
column of §1 is authoritative per item; the synthesis below states the rationale and the hard
constraints honored.

**Sequencing rationale (from the guides):** clear the standing reds + environment first so later waves
stop paying OFF-oracle costs against known-red gates (G1 Q9, G9 §6); land the cheap high-leverage
correctness/parity riders that gate nothing; run `C10-08b` define-width (`C11-149`) BEFORE any
new-define item (registry EXHAUSTED — G9 §0); keep the XL epics (MRT topology, terrain retention,
S10 arc, reversed-Z) in later waves behind their prereqs; the 3 maintainer-decision items are
BLOCKED-ON-MAINTAINER and do not open on an engineering default; measure, then certify.

### W1 — PERFORMANCE FRONT (TOP), then OIT-wiring, define-width, standing-reds, diagnosis, environment, cheap riders, reconciliation

**Re-fronted 2026-07-19 (maintainer-directed).** The performance lane §1.25 is inserted at the
**front of W1, ahead of everything else**, on the maintainer's instruction after Batch 717 root-caused
the reported ~50% FPS deficit. The prior W1 head (`C11-157` OIT wiring) is **already COMPLETE**, and
the reversed-Z spike is **already CLOSED NO-GO**, so the perf lane inherits the top slot cleanly
rather than displacing live work.

**2026-07-28 current overlay — supersedes stale status words in the historical
sequence below.** `C11-167` and `C11-172` are COMPLETE as recorded in §3.2.
The targeted lane resumed for `C11-181` (IMPLEMENTED / VERIFIED / LANDED,
Batch 773, 2026-08-01) and `C11-180` (PARTIAL; same batch).
The latter removes three of the seven measured blocking first-use waits with a
bounded final-executable/fog-companion policy; four structural stalls and the
broader shadow/HDR/translucent matrix remain. Campaign certification is still
held.

- **★★ TOP OF W1 — PERFORMANCE LANE `C11-166..172` (§1.25, maintainer-directed 2026-07-19).**
  Execution order within the lane:
  1. **`C11-166` ✅ COMPLETE (Batch 717)** — ocean-normal per-frame re-upload storm fixed.
     WebGPU `scene.render()` **10.5 ms → 0.9 ms (11.7×)**; ratio **17.5× → 1.5×**; WebGPU now *faster*
     than WebGL in the as-shipped `requestRenderMode` lane. Ocean-wave animation re-verified
     (temporal delta 1.818) — frozen-ocean is this fix's documented failure class.
  2. **`C11-167` — uploadImageSource cache-contract audit. THE highest-value open perf item.**
     Batch 717 fixed *one* caller. The underlying defect is a **contract trap**: `uploadImageSource`
     never reads the cache it is handed, so every caller must own its own guard, and nothing enforces
     that. Audit all call sites for the same missing-guard defect, then fix at the right altitude —
     honor the `cache` param internally, or make an unguarded call impossible — instead of patching
     callers one at a time (Principle 7/9: surface the missing mechanism, don't route around it).
  3. **`C11-168` — re-measure on a REAL workload.** The 11.7× was measured on a *static* default scene
     (9 draw commands, 6 tiles). Re-run on the canonical moving-altitude campaign plus a dense/tileset
     scene to confirm the win holds under load and to surface the next bottleneck. **Until this lands,
     treat the headline number as honest but narrow** — do not quote it as a general speedup.
  4. **`C11-169` / `C11-170` — close the tooling hole that let this hide.** `C11-169` now has a local,
     focused-Edge-green exact 11-phase CPU ledger and a green diagnostic browser artifact: 180/180
     moving frames across 8/8 route segments conserve total = named + coarse phases, with median
     **4.8 ms total / 0.3 ms named / 4.5 ms coarse** and exact zero unattributed/overlap/residual.
     The first-green nested artifact then splits `primitiveTraversal` over 120/120 frames: mean
     primitive/globe is **4.6358/4.5692 ms**, so globe render owns **98.56%** of that phase in this
     exact capture; four 12-pair 8 ms controls are exact and errors are zero. However, prime ended
     `globeTilesLoaded=false` with three foreground requests, using only local Natural Earth II and
     no explicit assets. This is a streaming/default-globe diagnostic, not transferable resident
     C11-168/C11-205 evidence and not a cause, optimization, or FPS verdict. Historical globe-only
     cross-backend work was near parity; land the checkpoint, then pivot to resident San Francisco/
     C11-205 phase attribution before remediation and an uninstrumented causal measurement.
     `C11-170` still owns the durable regression gate. *(The accounting source
     landed 2026-08-14 in `c404c3de04`; the resident owner-attribution Tools packet
     landed Batch 1032 `be0683c60d`.)*
  5. **`C11-171` — split-screen page viewer-init.** `split-screen-comparison.html` never exposed both
     viewers within 90 s, with no console errors. This blocks the maintainer's own A/B workflow and is
     how the original report was framed, so it is in-lane rather than deferred.
  - `C11-172` (ocean-wave octave LOD) stays in **W4** with `C11-158` — it is a real but small win
    (~0.1 ms) and shares the water-shader surface, so batching it there avoids double-touching.
  - **Absorbs pending findings:** the broader 7-lane perf investigation appends confirmed items here
    as `C11-173+`. Keep one perf lane, not scattered rows.

- **`C11-157` OIT translucent-primitive wiring — ✅ COMPLETE (Batches 713/714/715, Slices A+B+C).** FULL
  primitive→collection→model wiring landed; MRT-OIT is now *reachable* for all three translucent
  families (primitive parity 10.33% → 1.33%). The `C11-91` silhouette body-wash resolution folds in
  here and is **still open** as Slice D. **MRT-OIT default-off stays RATIFIED FAR-003 containment —
  "reachable" is NOT "shipped"; do NOT flip the metric.**
- **Reversed-Z measurement spike — `C11-GT-01` ✅ COMPLETE / NO-GO (2026-07-19, Batch 717).** Verdict
  **STAY-LOG-DEPTH**, adversarially verified. Decisive fact: the depth attachment is
  `depth24plus-stencil8` (`WebGPUContext.ts:370`, never reassigned) — a **fixed-point** format on
  D3D12, where reversed-Z's precision gain is **mathematically zero**; `depth32float-stencil8` is not
  even in `DESIRED_FEATURES`, and WebGPU exposes no query for the driver's actual backing. The
  log-depth pick fleet (82 WGSL `frag_depth` writers / 182 `csm_writeLogDepth` sites) is therefore
  **cleared to keep growing** — it is not a trap a later migration must rip out. Slice work
  `C11-GT-02` stays gated §6. Full analysis: `REVERSED_Z_MEASUREMENT_SPIKE_2026-07-19.md`.
- **Define-width EARLY — `C11-149` (C10-08b).** `C10-08` was BLOCKED at C10 close (registry exhausted;
  the sign-bit 31 deliberately left unconsumed), so define-width is the prerequisite and pulled into W1. It is the HARD PREREQ that unblocks the `C11-158` enhanced-ocean toggle
  (and later `C11-92`/`C11-88`/`C11-89`/`C11-81`/`C11-131`).
- **The cheap RATIFIED parity fixes (W1 cheap riders):** `C11-17` (empty-scene background-color FIX),
  `C11-159` (night-lights default-OFF, keep toggle). *(The remaining ratified parity fixes land later:
  `C11-158` enhanced-ocean toggle in W4 after define-width; `C11-160` sunBloom-wire, `C11-161`
  AutoExposure demand-gate, `C11-162` usePostProcessSelected port in W7 behind the `C11-117` effect
  audit — see §1.23 / §7.0.)*

Then the original W1 contents:

- **Two checkpoint-gating diagnoses (fable, diagnosis-only):** `C11-01` (pickPosition convergence) +
  `C11-11` (high-density-spheres cross-backend drift). Scheduling these in W1 pre-attributes the two
  reds so every later slice's feature-loss oracle is meaningful (G1 §A1/§B1, Q9). *If B1 traces to a
  contained GPU-cull path, the repair is BLOCKED-ON-MAINTAINER (charter forbids degrading the feature
  for the metric — §7).*
- **The G9 environment prerequisites (hard, W1):** `C11-133` (Karma launcher determinism), `C11-132`
  (spec-bundle freshness), `C11-134` (offline isolation). Until all three are COMPLETE, no spec/gate
  claim in the whole campaign is falsifiable (G9 §6). Two exit-gate owners (`C11-136`, `C11-144`) are
  paused specifically on them.
  **UPDATE 2026-08-12:** `C11-132` is complete in code and its widgets round-trip is
  machine-green (351/351, exit 0); the required engine-green round-trip remains open
  because the current-source full engine lane completed with a fresh bundle but exited
  1 on 93 unrelated suite failures. `C11-134`'s fail-closed offline repair landed in
  Batch 1029 (`de04e70574`): the exact targeted Edge lane passed 349/349 with five
  reasoned network skips and zero blocked requests, and the subsequent full offline
  engine lane again reported five reasoned skips and zero blocked requests. That full
  lane's unrelated 93 failures do not invalidate the isolation result and do not count
  as an engine-green result for `C11-132`. `C11-134`'s online `--no-offline` coverage
  control was attempted on the same source at 2026-08-12: the live terrain services
  returned `Request has failed`, producing five failures among nine selected tests.
  This is an honest external-service/environment red, not offline-policy evidence; the
  online lane remains owed in a valid live-service/token environment. This paragraph
  supersedes the older machine-debt wording in the §3.2 cells without falsely closing
  either row. `C11-133` tooling and its ten-run
  machine gate landed in Batch 1018, discharging only the launcher-specific
  prerequisite; `C11-136` and `C11-144` retain their remaining prerequisites and own
  gates.
- **Perf-claim prerequisite tooling (early):** `C11-140` (GPU-timestamp unique-sample cert), `C11-146`
  (first-complete-frame metric). An uncertified timer silently invalidates every later perf number
  (G9 Q7).
  **UPDATE 2026-08-10:** both accounting implementations landed with `node --test` guards (see §3.2),
  and `C11-146` is COMPLETE and **binding on the boot/TTFF cluster**. `C11-140` is now machine-certified
  on a `timestamp-query` adapter, but its bootstrap fix, strengthened guard, and certification artifact
  are local/unlanded. No durable C11 GPU-lane citation or completeness claim is authorized until they land.
  **[They landed Batch 1074 (`d36a835b82`), 2026-08-20, and the fresh-bundle
  machine-lane rerun ran tonight: exit 0, clean gates.]**
- **The cheap stale-premise RECONCILIATION slice (fable — the task's named W1 slice):** one pass that
  corrects the register/FEATURE_INVENTORY rows the guides flagged stale, so later briefs cut against
  truth: SHADOW-LAYOUT-QUANTIZED (`C11-109`, likely doc-close — G8 Q4), C-R10 receive-infra-present
  (`C11-111`), C9-14B fog-LUT-already-sampled (`C11-113`), `WebGPUComputePipelineCache` EXISTS →
  re-scope to routing (`C11-156` — G9 Q4a), `WebGPUModelRenderer` already `.ts` → strike from
  `C11-154`'s list (G9 Q4b), plus the G5 "cluster-12 reconciliation" and G8 "cluster-14/15/18
  reconciliation" premise-verify passes. Also re-point the C-R9 row (`C11-103`) at the object-pick
  footprint residual (G6 Q3) and note `scene.pickVoxel` no longer throws.
- **Cheap high-leverage riders (gate nothing):** `C11-17` (canvas-background parity), `C11-16`
  (point BlendOption sync), `C11-22` (debug-depth-plane gate parity), `C11-35` (oceanNormal per-call
  reupload cache), ~~`C11-79`/`C11-80` (celestial retained / starfield single-submission — instrument
  `C11-80` first, G7)~~, `C11-41` (F2a prompt-retire verification lane).
  ⚠ **`C11-79`/`C11-80` DO NOT SCHEDULE HERE — TRANSFERRED to C12 (LD-1,
  2026-07-23); IDs retained as aliases and `C12-04` owns the sequencing.**
  *(Stamped 2026-08-09, handover audit FIX 21 — this W1 prose still scheduled
  them as C11 riders.)* `C11-80` is **complete through Batch 770**; `C11-79`
  **remains partial** and its C12 gate membership is an **open maintainer ask**
  (`QUEUE_2026-07-19_CAMPAIGN12.md` §0). Read C12 for their status.
- **Self-contained P0/cheap correctness:** `C11-13` (voxel-inside-camera-black, G6 A1), `C11-51`
  (TAA custom-frustum jitter crash-fix, S), `C11-14` (WebGL aniso GLSL broken), `C11-15` (FR
  failed-state retry), `C11-19` (globe pipeline-name axes), `C11-24` (RenderCommand stale-pass-slot),
  `C11-25` (OPEN-1-DIAGNOSE verify-then-close).

### W2 — pick fleet closure + FAR-107 contract + pick correctness

The W4-riders C11 inherits from C10 (each on its own oracle, no metric): `C11-02`, `C11-03`, `C11-04`,
`C11-05`, `C11-06` (intake-conditional on `C10-12`), `C11-12` (MSAA-flip transition). Then the
foundations: `C11-07` (FAR-107 pick-query contract — needs maintainer public-API review, §7),
`C11-08` (multi-frustum packed depth — dep `C11-07`), `C11-09` (polyline-appearance pick remainder),
`C11-10` (main-scene depth blit), `C11-78` (pick-ID ownership model). **Read the `C10-11` outcome +
its `C10-13` reconciliation record before any depth-adjacent pick slice** (G10 §A1; the 71-file
surface hazard).

### W3 — bandwidth, attachment, terrain riders, model/frame-delta riders, submit timeline

The cheap-to-mid perf riders with no XL prereq. Attachment/MSAA: `C11-44`, `C11-45`, `C11-46`,
`C11-47`, `C11-48`, `C11-50` (payoff probe — MUST precede `C11-43`/`C11-49`, G3 Q4). Terrain riders:
`C11-34`, `C11-36`, `C11-37` (after `C11-33`), `C11-39`, `C11-40`, `C11-42`. Model-frontend riders:
`C11-28` (S9-2) → then `C11-30`, `C11-31`. Frame-delta: `C11-58` (S1-3 — land before entity `C11-65`
slice (d) to avoid double-churn, G7 Q4), `C11-59`, `C11-60`, `C11-61`, `C11-62`, `C11-72`. Submit
timeline (G2 §966): `C11-76` submitter-moves FIRST, then `C11-75` shadow-timeline authority. Latent
correctness: `C11-20`, `C11-21`. Route `C11-156` consumers through the (existing) compute-pipeline
cache. **Never run two of `C11-32`/`C11-33`/`C11-34` concurrently — same tile-buffer lifetime.**

### W4 — boot / compile chain + define-width + TS-debt

Intake-conditional on the C10 boot triad (`C10-06/07/08`). **2026-07-18: `C10-08` LANDED at C10 close,
so `C11-149` (C10-08b define-width) was pulled forward to W1 (§5 W1) — the rest of the boot chain stays
here.** `C11-149` remains **the HARD PREREQ for every new-define item** (`C11-92`, `C11-88`, `C11-89`,
`C11-81`, the `C11-131` OCEAN_PLANAR_REFLECT bit, **and the `C11-158` enhanced-ocean `ENHANCED_OCEAN`
gate**). Then `C11-150` (module granularity, after `C10-07`), `C11-148` (per-backend material source),
`C11-151`, `C11-152` (→ enables the leaf-strip seed), `C11-153` (S8-4, if `C10-06` didn't absorb it),
`C11-155`, `C11-154` (TS-convert, one renderer per batch — `WebGPUModelRenderer` already `.ts`, struck),
and **`C11-165`** (NEW-WEBGPU-DETERMINISTIC-SYNC-PIPELINE-CENTRALIZATION, the C10-07 follow-on).
`C11-81`/`C11-89`/`C11-92` open here once define-width lands; **`C11-158` (enhanced-ocean default-parity
toggle) also opens here after `C11-149`, landing jointly with the OPEN `water-bugs-2026-07-06` fix so the
ratified default isn't a buggy one.**

### W5 — RTE / TAA temporal contracts (no cluster guide — commission one first)

`C11-52` (C9-24 RTE producer/consumer inventory — R0 foundation) → `C11-53` (C9-25 previous-frame
RTE), `C11-54` (C9-26 GPU-visibility RTE closure), `C11-55` (C9-29 multi-frustum TAA depth
reprojection). Then the TAA-design tail `C11-56` → `C11-57`. **`C11-52` is the prerequisite for the
others + Gate E-class precision.** No dedicated guide exists for `rte-taa` — the orchestrator should
author a G-guide (or a detailed brief pack) before opening `C11-52`.

### W6 — XL epics (behind their prereqs)

- **MRT topology:** `C11-43` (C9-10 consumer-driven MRT) — its P0 prereq is the MRT-topology
  dimension in the pipeline-cache key of ALL 31 `makeSceneFBTargets` renderers (collection key is
  32/32 bits — widen); `CesiumDebug.attachmentDemand(false)` refuses until the key audit lands
  (G3 §1). Phase: P0 key-audit → P1 demand-wire → P2 default flip (`forceSceneMRT` flip is
  maintainer-gated, §7).
- **Terrain retention family (dedicated, do NOT open inside a normal wave):** `C11-33` (C9-11 retained
  descriptors) is the prereq store for `C11-32` (C9-12 static/dynamic upload split); `C11-38` (S6-3
  uniform-ring fan-out) extends the same WGSL+packer+BG-cache family; `C11-34` residency budget rides
  here. Multi-batch acceptance matrix required (water/clipping/shadow/exaggeration/2D-CV-morph/
  multi-view/device-loss).
- **Model-frontend heavy:** `C11-27` (C9-17 Slice D) — STOP-gated: opens ONLY if Gate-D / recorded
  C9-30 attribution names model-frontend allocation (G4 Q1); then `C11-29` (S9-3, sequence-locked
  after Slice D), and `C11-63` (revision-maintained caster sublist — blocked on the S1-6 tier seed
  `C11-SEED-23`).
- **Residency dedupe:** `C11-77` (geometry-residency dedupe — gated on a written typedArray-release
  policy that preserves documented readers, G10 §A7).

### W7 — parity + content + entity-at-scale arc + test-infra closure

The broad parity/feature wave, and the S10 arc:

- **Entity-at-scale (S10):** `C11-64` (10k-entity benchmark lane) is FIRST and gates every other S10
  finding (G7 §45); then `C11-65`, `C11-66` (dep the lane), `C11-67`, `C11-68`, `C11-69` (after
  FAR-107 `C11-07`), `C11-70`, `C11-71`, `C11-73`, `C11-74`. Whether the L-sized `C11-65/66` wait for
  the Gate-D attribution is a maintainer call (G7 Q6).
- **Post-process visibility:** `C11-117` (C9-23 effect-execution audit) opens the cluster FIRST (its
  consumer inventory feeds the AutoExposure gate, G6 §B1) → then `C11-118..123`. **The ratified PP
  parity wirings land behind `C11-117`:** ~~`C11-160` (sunBloom → WebGPU PP Bloom/LensFlare), `C11-161`
  (AutoExposure demand-gate — its "no consumer enabled" evidence comes from the `C11-117` inventory)~~,
  `C11-162` (usePostProcessSelected port). *(Default-pixel changes → the enhancement-preserving governing
  principle §2 applies; keep the WebGPU capability reachable.)*
  ⚠ **`C11-160` and `C11-161` DO NOT SCHEDULE HERE — TRANSFERRED to C12 (LD-1,
  2026-07-23); IDs retained as aliases.** *(Stamped 2026-08-09, handover audit
  FIX 21.)* `C11-160` shipped inside **`C12-18`, landed Batch 906
  (`ca964bc1da`)** — and was **VACUOUS at HEAD before that** (`scene.sunBloom`
  had no WebGPU consumer at all). `C11-161` feeds **`C12-19`, landed Batch 937
  (`794ece043a`)**, whose AE-on/AE-off lanes were the C12-side obligation. Same
  applies to **`C11-115`** wherever this section schedules it: RESOLVED as a
  direction here, but the IMPLEMENTATION landed inside `C12-18`, and **`C11-175`**
  folds into `C12-03`.
- **Tiles/model parity:** `C11-82`, `C11-83`, `C11-84`, `C11-85`, `C11-86`, `C11-87`, `C11-88`,
  `C11-90`, `C11-91` (maintainer decision), `C11-93`, `C11-94`/`C11-95` (behind `C11-27`/`C11-29`),
  `C11-96`, `C11-97`, `C11-98`, `C11-99`. `C11-26` splat-producer (BLOCKED-ON-MAINTAINER) unblocks
  `C11-18`, `C11-105`, `C11-IC-02`.
- **Classification/voxel:** `C11-100` (sliced; A2-slice-0 triage first), `C11-101` (.vctr fixture
  prereq), `C11-102`, `C11-103`, `C11-104`, `C11-105` (dep `C11-26`), `C11-106`, `C11-107`, `C11-108`.
- **Shadows/atmosphere/water:** `C11-110`, `C11-111`, `C11-112`; `C11-113` (gated on checkpoint
  attribution), `C11-114`, `C11-115` (**RESOLVED 2026-07-18: ALPHA_BLEND, §7.0**), `C11-116`; `C11-131`
  (after define-width / reversed-Z disposition). **Historical W7 note:** the original plan also listed
  `C11-124..130`; those cloud IDs later transferred to C13 and are not schedulable in C11. See §1.17
  for their alias mapping. `C11-126`'s option-A decision remains preserved history, not open work.
- **Celestial-water epic (Tier-4 / gated):** `C11-163` (C11-CELESTIAL-WATER-REFLECTION) — unified
  sun-by-day + moon/stars-by-night reflection on water + clouds, cloud-occluded via the EXISTING O(1)
  sun-view beer-shadow-map (no per-fragment raymarch), cloud-top specular fallback. **Opt-in
  default-OFF, byte-identical when off; runtime UBO enable-float (NO new define bit, NO `C11-149` dep);
  the cheap path does NOT touch depth (NOT reversed-Z-coupled).** Front-of-line S0 = day-sun-glint
  audit/unify (upgrade the existing `GlobeTerrain.wgsl:2441` sun glint to the same Cook-Torrance GGX
  lobe). Its **4 sub-decisions resolve when scheduled (§7.0)**. Full dossier:
  `CELESTIAL_WATER_REFLECTION_RESEARCH.md`.
- **Attachment future:** `C11-49` (Phase-8a normal G-buffer + depth prepass — maintainer-scoping gate).
- **Test-infra closure (exit-gate owners land here, mid-late):** `C11-138` (item 66, cheapest),
  `C11-142` (item 67), `C11-143` (item 69), `C11-144` (item 70), `C11-136` (item 64 broad-suite),
  `C11-135` (adapter matrix), `C11-141` (visibility manifest), `C11-139` (baseline promotion — after
  `C11-11` spheres repaired), `C11-145`, `C11-147` (after globe/HDR pixels settle).

### W8 — measured checkpoint + gated-tail evaluation

`C11-GATE-D-CHECKPOINT` (measurement-only; predeclare the anchor; clean then API lane; `--workload
moving-camera-altitude-track-3d --repetitions 6 --renderer both`; use the resolved even,
counterbalanced fresh-process schedule and never re-derive a fresh baseline).
Its verdict decides which gated-tail items get pulled (§6): the `C11-GT-01` reversed-Z spike verdict
(if not already run in C10) is recorded in all three sinks; `C11-GT-03` MSAA-default-flip reserve
triggers only on a MISS with bandwidth-attributed evidence + fresh sign-off.

### W9 — celestial appearance (star map, bright stars, sun, moon) — maintainer-queued to the END

**Added 2026-07-19 (maintainer-directed, §1.26).** Runs after the W8 checkpoint and before the exit
gate. Contents `C11-176..179`:

- **`C11-176` skybox star-map fade — the only true DEFECT in this wave, and PROMOTABLE.** WebGPU's star
  map reads significantly more faded than WebGL. This is a parity bug, not a preference. If the
  in-flight research returns a cheap anchored root cause — an sRGB-vs-linear cubemap format mismatch, a
  missing intensity multiplier, a tonemap-ordering divergence (WebGPU's mandatory PP blit puts tonemap
  between scene and canvas where WebGL can go direct), AutoExposure metering a bright limb and exposing
  the night side down, or mip-averaging stars into grey mush — **pull it forward out of W9**; do not
  make a small parity fix wait on a feature wave.
- **`C11-177` bright-star appearance model.** Replace the flat-disc look with: logarithmic
  magnitude→luminance (5 magnitudes = exactly 100× flux), a Gaussian core + wide power-law halo PSF
  (the maintainer's Polaris reference shape), B−V colour → blackbody RGB so the field is not
  monochrome, and HDR energy driving bloom instead of a painted-on sprite glow.
- **`C11-178` star-map asset upgrade.** Denser Milky Way with dust lanes. **Licensing gates this** —
  Apache-2.0 repo (corrected `R-2026-08-21-23` — the earlier "MIT repo" framing was wrong), so public-domain (NASA SVS Deep Star Maps) is strongly preferred and any share-alike or
  non-commercial source is disqualified regardless of quality. Carries the architectural call: let the
  texture hold the *diffuse* Milky Way while *bright* stars come from a catalogue as point sprites.
  Conflating both in one cubemap is a leading hypothesis for why bright stars read as blobs today.
- **`C11-179` sun + moon.** Sun: correct ~0.53° angular diameter, limb darkening, HDR-driven glare —
  remembering that in vacuum there is no atmospheric halo, so the glow is instrument/eye response.
  Moon: non-Lambertian reflectance (Hapke / Lommel-Seeliger), opposition surge, earthshine on the dark
  limb, public-domain LROC albedo/normal maps. **Do not double-schedule** `C11-160` (sunBloom PP
  wiring), `C11-115` (sun blend → ALPHA_BLEND) or `C11-161` (AutoExposure demand-gate) — already queued.

**Feature depth belongs to Campaign 12.** The 8-lane research sweep running as of 2026-07-19 produces a
C12 construction proposal. W9 carries the parity defect plus whatever cheap wins the research confirms;
the deep work (catalogue-driven star rendering, physically-based sun/moon) is C12 scope.

**Gate on measurements, not eyeballs** — see §1.26. A mean-luminance comparison would miss this bug
entirely, because a faded field can share the same mean with far lower variance.

### EXIT GATE — `C11-137` C8-upstream-contract certification (DEAD LAST)

**⚠ MAINTAINER RULING 2026-07-23: certification is HELD.** Presented with the minimal ~15-id certification path vs holding until the W2–W8 body executes, the maintainer chose **HOLD** — C11 does NOT certify on the minimal path; the body executes first (under the orchestrator pattern, interleaved with C12 and C13). The MUST-arc items (test-infra 132/133/134, Gate-B diagnoses, 140/146, owner items, Gate-D) remain the certification prerequisites when the campaign eventually closes.

The campaign closer (G9 §A.16). Full engine + widgets + complete-engine suite on the stabilized
launcher with truthful executed/skipped/failed counts, every skip reasoned, zero unowned reds, the
four owner items landed, GraphicsCapabilities Renderer-triage re-asserted. The committed certification
report IS the C11 exit evidence. If any owner item did not land, the gate stays **OPEN** and the
campaign does not certify — say so plainly (honest-partial). **RATIFIED 2026-07-18 (resolves G9 Q1/Q2):
the campaign CLOSES on the deterministic `C11-137` C8-contract gate with truthful counts (the
focused/unit lane is the close bar); the FULL real-scene suite ADDITIONALLY runs when a real adapter is
available and is a recorded follow-up, NOT a close-blocker.** "Campaign certifies" = "`C11-137` closes
green with truthful counts."

---

## 6. Gated tail + arch-seeds (from G10 Part A — do NOT auto-run)

Activated ONLY by the Gate-D verdict AND fresh maintainer sign-off. Not scheduled by the loop. Full
dossiers: **G10 §A1–A7.**

| C11-id | Item | Gate to open |
| --- | --- | --- |
| `C11-GT-01` | `C10-13-REVERSED-Z-EARLYZ-SPIKE` (measurement-only, openable) | **RATIFIED 2026-07-18: the measurement-only SPIKE runs EARLY in W1** · **EXECUTED: NO-GO, Batch 717 (`a0ca50bea7`)** (moved out of the gated tail — it changes no shipped behavior; only the reversed-Z SLICE `C11-GT-02` stays behind Gate-D + fresh sign-off). Cheap FAR-707 evidence gate; GO threshold ≥20–30% fragment-work reduction on weak-FPS views. **MUST record its GO/NO-GO in BOTH `C11-IC-01` (NEW-WEBGPU-PICK-FLEET-LOG-DEPTH) AND the FAR-707 brief AND `DEFERRED_WORK.md`** before the pick fleet's log-depth conversion is treated as permanent — the two streams pull the same 71-file surface opposite ways. If C10 already ran it, its verdict is a `C11-00B` fact. |
| `C11-GT-02` | `C10-GT-REVERSED-Z-SLICE-B` (DEFERRED — do not schedule) | All of: `C10-01` landed (done, B693); `C11-GT-01` GO (**unsatisfiable — the spike returned NO-GO at Batch 717; this gate is CLOSED**); the pick-fleet reconciliation decision recorded; a written `depth32float-stencil8` fallback story covering every adapter tier (any tier left behind = forbidden dual permanent architecture = NO-GO); Gate-D verdict + fresh sign-off. XL, all-or-nothing behind `_reversedZEnabled` (OFF = byte-identical). **Trap:** if GO, the RGBA8 pack ecosystem `C11-45`/`C11-46` optimize is slated for DELETION — land them near-term but sequence BEFORE any reversed-Z commitment and mark them superseded-by-design. |
| `C11-GT-03` | `C10-03R-MSAA-DEFAULT-FLIP-RESERVE` (CONDITIONAL NOT TRIGGERED) | Reserve lever. Pull ONLY on a Gate-D MISS WITH bandwidth-attributed evidence (GPU-timestamp + counters implicating attachment traffic, NOT CPU) AND fresh maintainer sign-off recorded here. Backend-conditional WebGPU default `msaaSamples` 4→1 (WebGL untouched, opt-in preserved). MSAA-4 default is visual policy (Rule 1) — any slice flipping it without recorded sign-off is reverted on sight. |

**Arch-seeds (`C11-SEED-23..26` + the cross-cluster seeds; G10 §A4–A7).** Recorded so the Gate-D
verdict can point at them; none C11-schedulable without its own gate: `C11-SEED-23` S1-6 frame-delta
retained-commandList tier (the register's contradiction #3 — without it backend wins cannot deliver
≥2× at p95 on CPU-bound hosts; unblocks `C11-63` and S1-1); `C11-SEED-24` worker-renderer
productization (the ONLY shipped mechanism that raises the main-thread CPU ceiling — benchmark lane
first); `C11-SEED-25` S5-2 WASM consume-or-retire (5/7 bridges dead, Principle-7 per-bridge
disposition, no silent deletion); `C11-SEED-26` NEW-VEGETATION-SYSTEM; plus the P3 content/perf seeds
`C11-SEED-01..22` in their clusters (§1). `C11-77` geometry-residency dedupe is dossiered as G10 §A7
(gated on the typedArray-release policy) though it carries a schedulable number in `submit-residency`.

---

## 7. The 3 maintainer decisions + consolidated cross-guide OPEN QUESTIONS

### 7.0 Maintainer decisions RESOLVED at the 2026-07-18 `C11-00B` sweep (maintainer-final)

These were ratified maintainer-final on 2026-07-18 and are now SCHEDULED (no longer
BLOCKED-ON-MAINTAINER). All are bound by the §2 ★ GOVERNING PRINCIPLE — never remove an additive WebGPU
capability for parity; change the default + keep a toggle.

- **OIT translucent-primitive wiring → FULL wiring** (`C11-157`, TOP of W1; primitive→collection→model).
  Silhouette body-wash (`C11-91`) → **replicate WebGL**, folds into `C11-157`. MRT-OIT default-off stays
  FAR-003-contained (7.1 #3 RESOLVED to "fund the wiring", not a metric flip).
- **Enhanced-ocean → TRUE PARITY** (`C11-158`): default **classic** water; the enhancement becomes an
  opt-in **TOGGLE** via a new `ENHANCED_OCEAN` define ⇒ **`C11-149` define-width is a HARD PREDECESSOR**;
  land jointly with the OPEN `water-bugs-2026-07-06` fix (7.1 #2 RESOLVED).
- **Parity sweep (default-parity + keep toggle, never remove):** night-lights → default **OFF**
  (`C11-159`, toggle stays); sunBloom → **WIRE** to WebGPU PP Bloom/LensFlare (`C11-160`); empty-scene
  background-color → **FIX** (`C11-17`); AutoExposure always-on compute → **DEMAND-GATE** the dispatch +
  **ratify the HDR altitude-gate** (`C11-161`); `usePostProcessSelected` hardwired false → **PORT** the
  selected path (`C11-162`).
- **Sun blend mode** (`C11-115`) → WebGPU **ALPHA_BLEND** (match WebGL).
- **Reversed-Z** → run the `C11-GT-01` measurement spike **EARLY in W1** (measurement-only; the slice
  work `C11-GT-02` stays gated §6).
- **Exit gate** → **BOTH**: certify/close on the deterministic `C11-137` C8-contract gate (truthful
  counts); ALSO run the full real-scene suite when a real adapter is available (recorded follow-up, not
  a close-blocker).
- **Orchestrator mode** → **DEFAULT** (G10 Q3 resolved; the ×5-hardened engine-script fallback stays a
  reserve).
- **`forceSceneMRT` default-flip** → requires an **EXPLICIT recorded maintainer sign-off** (like the
  `C11-GT-03` reserve-lever protocol), NOT standing DW-phasing approval (G3 Q3a resolved). Governs
  `C11-43` P2.
- **CLOUD-U4** (`C11-126`, historical alias → `C13-00`) → option **(A): Scene owns a managed default
  VOLUMETRIC CloudCollection** (re-point the 4 producers). This decision completed before C13; do not
  schedule implementation from C11.
- **High-density / `gpuCullingHint`** (`C11-11`) → **diagnose first** (W1 diagnosis), then a **lean
  repair** — do NOT degrade the feature for the metric; if it traces to the contained GPU-cull path,
  surface per the charter (§2 rule 1).

**Still-deferred after this sweep:** the splat-data-producer placement + offline asset (7.1 #1, still
BLOCKED-ON-MAINTAINER); FAR-107 public pick-API review (`C11-07`); declutter displacement-threshold
default (`C11-66`); C9-01 Gate-A closure (`C11-145`) + gate-F baseline refresh (`C11-147`); rte-taa
guide commissioning; benchmark-lane workload-file identity (`C11-64`); the absent 2D perf lane
(`C11-59`); **and the 4 CELESTIAL sub-decisions below.** The former clouds-weather guide gap is no
longer C11-deferred work because that cluster transferred to C13.

**The 4 `C11-163` CELESTIAL-WATER-REFLECTION sub-decisions (deferred to when the epic is scheduled):**

1. **Target ocean:** (A) globe water-mask "enhanced ocean" (`computeEnhancedOcean`, the default shipping
   path) vs (B) opt-in FFT `OceanSurface.wgsl` (cleaner prototype host). Dossier §1 recommends prototype
   in (B) → port to (A).
2. **Parity stance:** (i) declare it a WebGPU-only enhancement (`FEATURE_INVENTORY §B`, no GLSL twin —
   consistent with `ProceduralClouds` precedent) vs (ii) ship a reduced moonglade-only GLSL twin for the
   enhanced ocean. Dossier §6 recommends (i).
3. **Star source:** S3 (a) bake a star-catalog cubemap / (b) procedural hash star field / (c) reuse the
   atmosphere IBL cube / (d) expose the existing SkyBox Tycho cubemap. Dossier §4 favors (d) or (b) for a
   first cut.
4. **Cloud-occlusion fidelity:** S5a cheap (reuse the existing sun-view beer-shadow-map) vs S5b accurate
   (bake a second moon-view beer-shadow-map). Dossier §2.4 recommends S5a first, S5b as a follow-up.

### 7.1 The 3 named maintainer-decision items (BLOCKED-ON-MAINTAINER)

> **2026-07-18: #2 (enhanced-ocean) and #3 (OIT-wiring) are RESOLVED — see §7.0. Only #1 (splat) remains
> BLOCKED-ON-MAINTAINER.**

1. **Splat-data-producer (`C11-26`).** Placement — a WebGPU branch in `GaussianSplatPrimitive.update`
   pre-FR-return (scene-logic-extractor) vs inside the FR — AND the offline asset: vendor a
   license-clean `.spz`/glTF-splat tileset vs build a faithful synthetic builder. Both need a recorded
   maintainer decision before the producer brief is cut (G5 Q1). Blocks `C11-18`, `C11-105`,
   `C11-IC-02`.
2. **Enhanced-ocean default direction (defaults-parity D1, G8 — a `C11-00B` intake item, NOT a
   numbered register row).** NOT a clean flip: at HEAD it is uniform-driven with **no `ENHANCED_OCEAN`
   ShaderDefine**, so flipping the JS default does not yield WebGL parity. Two-part ask: **(A)** add a
   define-gated classic-vs-enhanced toggle with a verified GlobeFS `//>>else` (needs a free registry
   bit → `C11-149` define-width), then **(B)** ratify the default look. Must land jointly with (or
   after) the OPEN `water-bugs-2026-07-06` fix so the ratified default isn't a buggy one (G8 Q1).
3. **OIT translucent-primitive wiring (`NEW-WEBGPU-OIT-TRANSLUCENT-PRIMITIVE-WIRING` — Batch-700
   fallout, `C11-00B` intake item).** The real prerequisite the OIT NO-GO surfaced: no primitive/model/
   collection produces a `Pass.TRANSLUCENT` command carrying `_shaderCode`/`_oitPipeline`, so
   `hasOITPipelines` is always false and MRT-OIT is unreachable for standard translucency. Wiring
   translucent-primitive OIT pipeline variants is a multi-batch effort; MRT-OIT default-off stays
   RATIFIED FAR-003 containment — the maintainer decides whether to fund the wiring, not whether to
   flip a metric.

### 7.2 Consolidated cross-guide OPEN QUESTIONS (all G1–G10, deduped)

> **2026-07-18: several of the bullets below were RESOLVED at the `C11-00B` sweep — see §7.0**
> (`forceSceneMRT` sign-off protocol, sun-blend direction, sunBloom direction, HDR AutoExposure
> altitude-gate, CLOUD-U4, high-density `gpuCullingHint` policy, exit-gate criterion, orchestrator-mode).
> The bullets that REMAIN OPEN: FAR-107 public pick-API review, declutter displacement-threshold default,
> C9-01 Gate-A closure + gate-F baseline refresh, rte-taa guide commissioning,
> benchmark-lane workload identity, the absent 2D perf lane, define-width sequencing, the
> checkpoint-attribution gates, and the reversed-Z reconciliation read. Clouds-weather guide work is
> not open in C11 because the entire cluster transferred to C13.

**Maintainer decisions (beyond the 3 above):**

- **`gpuCullingHint='always'` policy (G1 Q4):** if the high-density-spheres drift (`C11-11`) traces to
  the contained GPU-cull path, the charter forbids degrading the feature for the metric — options are
  (a) repair the `'always'` path (possibly M–L, FAR-003-contained) or (b) re-scope the scene with an
  explicit coverage-loss note (needs sign-off). Flag early at B1 Step-2.
- **`probe-pickposition-webgpu` lane ruling (G1 Q2):** ratify `PROBE_BASE=http://localhost:8080` +
  `node server.js` + `Build/CesiumUnminified` as the supported reproduction of record for `C11-01`.
- **FAR-107 public pick-API review (G1 Q5):** `C11-07` requires maintainer approval on the public pick
  types before landing, or it stalls done-but-unlandable.
- **`forceSceneMRT` default-flip sign-off protocol (G3 Q3a):** does the maintainer want an explicit
  recorded sign-off like the `C11-GT-03` reserve-lever protocol, or does the DW-recorded phasing count
  as standing approval? Governs `C11-43` P2.
- **Stencil-less depth half of `C11-48` sub-slice (G3 Q3c)** — wanted before reversed-Z resolves? May
  be throwaway if `C11-GT-02` activates (same D24S8 surface).
- **S6-4 repair-vs-retire (G3 Q3b, Principle-7):** recommendation REPAIR (a genuine correctness bug in
  `C11-48`).
- **Model-silhouette translucent body-wash-vs-rim (`C11-91`, G5 Q2):** replicate WebGL's OIT-stencil
  body-wash artifact for byte-parity, or ratify WebGPU's documented rim-only intent.
- **Sun-blend-mode direction (`C11-115`, G8 §B3):** WebGPU flare → ALPHA_BLEND matching WebGL, or
  ratify additive + retune WebGL. Sequences ahead of the sunBloom parity question.
- **sunBloom parity direction (G6 Q2a / G8):** wire a WebGPU screen-space glare (default-pixel change,
  needs ratification) vs ratify the baked substitute.
- **HDR AutoExposure altitude-gate ratification (G6 Q2b):** behavior kept, policy record missing.
- **ADR accumulation complete-vs-retire (`C11-107`, G6 Q2d):** retire needs explicit Principle-7
  sign-off.
- **CLOUD-U4 historical decision (`C11-126` → `C13-00`):** RESOLVED as (A), Scene/Globe owns a
  managed default VOLUMETRIC CloudCollection. It is retained here for decision history only and is
  not an open C11 choice or schedulable row.
- **Declutter displacement-threshold default (`C11-66`, G7 Q2):** opt-in (default 0 = today) needs no
  approval; a nonzero default needs sign-off.
- **C9-01 Gate-A closure (`C11-145`, G9 Q5) + gate-F baseline refresh timing (`C11-147`)** are
  maintainer-decision rows.
- **Exit-gate criterion (G9 Q1/Q2):** confirm "campaign certifies = `C11-137` closes green with
  truthful counts"; and whether the "spec green" bar is the focused/unit lane (deterministic) with the
  real-scene lane truthfully counted, or the full real-scene suite must hold a headless session (may
  need a real adapter the sandbox lacks).

**Sequencing / dependency questions:**

- **C10 completion state at launch (G1 Q1, G2 Q1/Q2, G3 Q1, G5 Q3/Q4, G9 Q3):** the schedulable set of
  the pick cluster, the terrain family, the boot triad, and the define-width chain is indeterminate
  until `C11-00B` reads the live C10 `results[]`. Freeze wave assignments only after.
- **Reversed-Z reconciliation (G1 Q7, G3 Q1b, G6 §1001, G8 Q6):** if `C11-GT-01` recorded GO, every
  log-depth-expanding item (`C11-IC-01` pick fleet, `C11-131` planar-reflect ocean depth, the RGBA8
  pack optimizers `C11-45`/`C11-46`) needs the recorded reconciliation read first — the single biggest
  strategic hazard.
- **Define-width spend (G2 Q5, G5 Q3, G8 Q6):** `C11-149` (C10-08b) must sequence before ANY new
  define bit; several items (`C11-92`, `C11-88`, `C11-89`, `C11-81`, `C11-131`) fan out on it.
- **Checkpoint-attribution gates (G2 Q1, G4 Q1, G7 Q6, G8 Q5):** `C11-27` (C9-17 Slice D), the S10 L
  slices, and `C11-113` (atmosphere march) open only if Gate-D / recorded C9-30 attribution names their
  cost. Confirm the C9-30 PROMOTE attribution suffices, or wait for `C11-GATE-D-CHECKPOINT`.
- **2D perf lane absent (G4 Q4):** `C11-59` (S1-5/S7-6) cannot make route-p95 claims without a 2D
  moving lane in `run-performance-campaign.mjs` — add the lane (could ride `C11-64`) or accept
  counter-evidence-only landings.
- **Benchmark-lane workload-file identity (G7 Q1):** put the entity lane in a SEPARATE
  `performance-workloads-entity.json` with its own set id (preserves checkpoint comparability) vs a
  bumped id — decide before `C11-64`.
- **Guide gap:** `rte-taa` still needs a guide (or detailed brief pack) before opening `C11-52`
  (W5). The clouds-weather half is historical: `C11-124` and its siblings transferred to C13, so
  opening them in C11 is forbidden; use the §1.17 mapping and C13 planning artifacts.
- **Doc-hygiene reconciliations to fold into whatever lands first (G1 Q8, G5 Q7/Q8, G6 Q3, G8 Q4,
  G9 Q4):** `WebGPUComputePipelineCache` exists; `WebGPUModelRenderer` already `.ts`; `scene.pickVoxel`
  no longer throws; SHADOW-LAYOUT-QUANTIZED likely doc-close; KHR_materials_variants may be §D FUTURE
  not a parity gap (needs an upstream check). The W1 reconciliation slice owns these.
- **Orchestrator-mode vs engine-script (G10 Q3):** whether C11 runs in orchestrator mode (default) or
  forks the ×5-hardened engine script (G10 §B7) for an unattended run — a maintainer call depending on
  whether a human is at the wheel.

---

## 8. Pointers

- **Operating charter + takeover manual + salvage playbook + engine-script fallback:**
  `campaign11_planning/guides/G10-charter-mechanics.md` (authoritative for mechanics).
- **Execution index (cluster→guide→C11-id cross-map + read-your-guide instruction):**
  `CAMPAIGN11_EXECUTION_GUIDE.md`.
- **Item universe:** `campaign11_planning/CANDIDATE_REGISTER.md`. **Cluster guides:**
  `campaign11_planning/guides/G1..G10`. **Planning status:** `campaign11_planning/_PLANNING_STATUS.md`.
- **Defaults-parity feed:** `DEFAULT_PARITY_MATRIX_2026-07-18.md`. **C10 structure exemplar:**
  `QUEUE_2026-07-16_CAMPAIGN10.md`. **Runner:** `Tools/visual-regression/run-performance-campaign.mjs`
  (`moving-camera-altitude-track-3d`, 8 segments, near-ground idx 5+6).
