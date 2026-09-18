# The Gemini codebase audit, verified — result, backlog and plan (2026-09-17)

**Measured at `91a7a8c9ff` (Batch 1496).** An external model produced a ~3 MB codebase audit across six
fleets and sixty sub-agents. This document is what survived verification: sixteen domain passes, each
with an independent refutation pass applied, then a synthesis, an adversarial critic over the
synthesis, and a finalisation. It is the tracked result; the sixteen domain files and their refutations
are banked verbatim at `cesium-webgpu-worker-archive/audit-gemini-2026-09-17/`.

**Record.** Verification ran 2026-09-17 under the Fable seat; the rulings taken on it are
[`MAINTAINER_RULINGS_2026-09-17.md`](MAINTAINER_RULINGS_2026-09-17.md) (`R-2026-09-17-1` … `-8`), which
is their authority. §g below is the argument those rulings were taken on, reproduced as it stood; where
a ruling differs from the recommendation, the ruling wins. Every `file:line` in this document was
re-opened at `91a7a8c9ff` by the lane that wrote it; the handful that could not be is named in §h.

**The corpus itself is not tracked and must not be cited as a premise.** Reading it is governed by the
do-not-execute list in the rulings file.

---

## (a) The corpus in numbers

Measured over the sixteen domain result files, not quoted from the audit.

| quantity | value | note |
| --- | --- | --- |
| domains | 16 | |
| finding rows given to verification | 3,333 | |
| substantive rows (behaviour, test, build, dependency, security, public API) | 662 | |
| style-only rows (comment / JSDoc / naming) | 2,250 | not verified individually — sampled five-by-blame per domain |
| items after intra-domain dedup | 355 | |
| cross-domain merges applied | 19 | |
| distinct items | **336** | |
| verdicts (on 355) | 198 TRUE · 98 PARTLY · 57 FALSE · 1 STALE · 1 UNVERIFIABLE | |
| authorship (on 355) | 185 UPSTREAM · 153 FORK · 17 MIXED | |
| priorities after refutation and merge | **3 P0 · 24 P1 · 136 P2 · 172 P3 · 1 REFUTED** | |
| the audit's own remedy wrong or absent | 151 of 355 (146 false, 5 null) | |
| effort on the 27 surviving P0+P1 rows | 22 S · 4 M · 1 L | |
| change class on those 27 | engine 9 · docs 14 · build 2 · shader 1 · tools 1 | |
| refutation outcomes | 79 UPHELD · 1 REFUTED · 15 DOWNGRADED · 1 UPGRADED | 34 FALSE verdicts re-checked, 0 overturned |
| **genuinely-new reachable code defects at P1 or above** | **6** | plus one parity decision |

**The audit's own numbers do not survive.** It claimed 2,637 findings, 1,576 confirmed, 934 refuted,
"40 Critical P0 Defects" and "100% COMPLETE". Measured: the corrected scope is ≈ 3,011 rows, of which
**2,339 (77.7%) carry no verdict at all**; the "40 P0" roster is 33 rows; one fleet's 283 findings were
excluded and never adversarially reviewed; a second fleet's adversarial pass survives only as a
truncated read-transcript, leaving 668 findings unadjudicated; and **2,304 of 3,585 tracked files (64%)
are never named anywhere in the corpus**, including five of the fork's largest WebGPU renderers, about
19,000 lines between them.

---

## (b) The five questions

### 1. Are they valid?

The quotations are; the classifications largely are not. Fifteen of sixteen domain passes found no
fabricated quote, and **two line-number errors** were found across the 662 substantive rows. One row is
worse than a misclassification: its line numbers exist only in an uncommitted working copy and not at
the commit the corpus's own header claims, so part of the audit ran against a dirty tree.

By verdict, 198 of 355 items are TRUE (56%), 98 PARTLY (28%), 57 FALSE (16%). PARTLY almost always
means the observation is real and the consequence, the severity or the proposed fix is wrong. **The
proposed remedy is wrong or missing on 151 of 355 items (43%)**, and six of them must never be
executed — see the do-not-execute list in the rulings file. The last of the six is the corpus's only
security-class row and its Phase-0 head: the dependency range `^1.19.7` admits **1.19.11, the last
version that package ever published**, the installed version is 1.19.11, and `ThirdParty.json:220`
records 1.19.11. There is no security action here.

### 2. Are they new?

Rarely, and never at the top. 299 of 355 items are marked NEW, but the audit has **no "already
tracked" axis**: it never greps the deferred-work inventory, the campaign queues or the debugging log.
Its comment phase restates a live campaign as a discovery; its `new-cap` finding was ruled the day
before it was filed; its top shader finding has named all six of its sites since 2026-07-15.

Two of the three P0s were already rulings of 2026-09-16. Of the 24 P1s, **seven are tracked**, two of
them only found by the adversarial critic:

- the `TaskProcessor` defect is `ARCHITECTURE_REVIEW_2026-09-02.md:594`, row `1390-10 [shaderasync]`,
  **unowned** — which names the missing `error` / `onmessageerror` listener, the 404, the
  `maximumActiveTasks` cap and the silent stop, in those words;
- the mapped-buffer readback defect is `ARCHITECTURE_REVIEW_2026-09-02.md:991`, row `H-R9`, marked
  RESOLVED at Batch 213 **for `WebGPUGPUCuller.ts` alone** — which is exactly why the refutation pass
  found that one file already correct. It belongs to the same class as
  `NEW-CAMERA-JSDOC-RESTORE`: closed narrower than its closure sentence reads.

**Net yield of six fleets and sixty sub-agents: six genuinely-new reachable code defects plus one
parity decision.** Three of the six are in `packages/engine/Source/Core` and `packages/engine/Specs/Core`,
where no instrument points at all — 34 of 36 items in that domain are NEW. That is the real signal
about where the guard fleet is not looking.

### 3. Easily fixable, or larger?

Overwhelmingly small: across the 27 surviving P0 and P1 rows, 22 S, 4 M, 1 L. The three P0s are four
characters twice plus a scoped lint exception, one comment-only pass, and one sentence declining to
execute a row. The six new P1 defects, in order of diff size: a `String(value).padStart(...)`; a
`.finally(deleteFromCache).catch(() => {})`; a `typeof left.equals === "function"` guard; one private
flush called from `finally`; three `wrapFunction` calls copied from an existing mixin; and hoisting one
plugin push above an `if`.

The larger items are the **decisions the defects sit on**: the WGSL chunk stack (D10), the
previous-frame RTE convention across six renderers (the only L), `DrawCommand` parity (D7), and
in-fork-versus-upstream (D1). Five of the six new P1s are on upstream-authored lines.

### 4. Can they be prioritised?

Not from the audit's own labels: its categories encode kind, no row carries a disposition — so its
1,576/934 confirmed/refuted split is unexecutable for any individual row — and it published seven rows
its own refutation pass had marked REFUTED. **Of the 33-row P0 roster, zero rows meet this fork's P0
bar on merit.**

Yes from this workflow, and the ordering is unusually clean because the top of the list is three
commands' exit codes, re-measured at the tip. One correction to a premise carried through several
drafts: **only the lint gate is red on every push.** `.github/workflows/prod.yml:28` runs
`npm run eslint` and carries no comment-marker and no C16 step, so the second P0's blast radius is
`dev.yml` alone (`:79` and `:83`).

The clearest illustration of why the corpus cannot be read as a ranking: a comment-token-driven audit
**inverts the reachability ordering**. It filed eleven allocation rows against one visualizer file and
missed the unbounded `while` loop in that same file which hangs the tab — already tracked as `AR-760`.

### 5. Do they expose larger issues?

Yes, and consistently one class: **the fork states rules it does not instrument, and the instruments
that exist are scoped to the wrong subtree.** Fourteen signals are in §e.

---

## (c) The survivors — 3 P0 and 24 P1

Proof bar per `R-2026-08-29-1`: engine and shader take the full bar; tools take a spec where there is
logic and a runner home; docs take review plus one capture where the change is visual. The named leg
for a non-visual engine change is settled by `R-2026-09-17-4`.

### P0 — three rows

**P0-1 — the eslint `new-cap` gate is red on every push.**
Sites, all re-read: `packages/engine/Source/Scene/PrimitiveGeometryHelpers.js:227` and `:252` (fork),
`packages/engine/Source/Core/clone.js:17`, `packages/engine/Source/Core/PixelFormat.js:479`,
`packages/engine/Source/Scene/Vector3DTilePrimitive.js:810` and `:830` (upstream-verbatim). Each is a
`new <lowercase>.constructor(...)` or `new constructor(...)`.
Failure: `npm run eslint` exits 1 with six `new-cap` errors, and it is the first lint step of both
`.github/workflows/dev.yml:23` **and** `.github/workflows/prod.yml:28`.
Authorship MIXED · tracked as `R-2026-09-16-9`, "Executed: pending" · effort S · class build · sync
exposure none · acceptance: exit 0.
Fix: `.slice()` at the two fork sites; a scoped `eslint-disable` at the four upstream-verbatim sites.
Upstream carries the identical code, the identical rule and the identical dependency range, so a
floating lint upgrade reddens upstream the same way — see `R-2026-09-17-8`.
Adjacent but separate: the prototype-pollution reading of `clone.js:17` is refuted as a security claim
and stands alone at P3. Its residue is `Object.hasOwn`, and it records that `clone.js` is
upstream-identical — an edit there would be a first-time divergence in a decade-stable file, which is
why the scoped disable is the right shape.

**P0-2 — the C16 comment-marker gate is red on `dev.yml`.**
**Re-measured in this lane at `91a7a8c9ff`:** `node Tools/c16/comment-marker-guard.mjs --verify-cleanlist`
exits 1 with **53 REGRESSED findings in 8 clean-listed files** — 23 in
`packages/engine/Source/Renderer/WebGPU/WebGPUCloudTierPresets.ts`, 13 in
`packages/engine/Source/Scene/CloudVolumetrics.js`, 10 in
`packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`, and one or two each in
`WebGPUContext.ts`, `WebGPUSceneRendererPickPass.ts`, `WebGPUSceneRendererPostFrustumChain.ts`,
`cesium-js-types.d.ts` and `Scene/Weather/MetarWeatherSource.ts`. The gate is `dev.yml:79`
(`npm run lint-comment-markers`); `dev.yml:83` (`npm run test-c16`) fails with it.
Authorship FORK — 33 markers from Batch 1493, 2 from Batch 1494, both 2026-09-16 · tracked as
`R-2026-09-16-8`, which scoped 18 regressions in 6 files and is now 53 in 8 · effort S–M · class docs ·
sync exposure none, all eight files fork-only.
**The prerequisite is answerable without touching a held file.** The mechanism was traced at the tip
from unheld artifacts only: `.husky/pre-commit:7` runs `node_modules/.bin/lint-staged || exit 1`;
`lint-staged.config.js:91-98` applies `node Tools/c16/comment-marker-guard.mjs` to
`packages/*/Source/**/*.{js,mjs,cjs,ts,tsx,wgsl,glsl}`, which covers all eight files;
`Tools/c16/comment-marker-guard.mjs:267-283` (`classifyFindings`) makes a finding in a clean-listed file
an **ERROR unless the exact file-and-rule pair is grandfathered**, and the entry point returns 1 when
any error exists; `WebGPUCloudTierPresets.ts` has been on `Tools/c16/comment-marker-cleanlist.txt:53`
since Batch 986 and has **no** grandfather row. So the guard, the clean list and the hook glob are all
correct at the tip, and the question reduces to which bypass occurred — `--no-verify` (a precedent is
recorded at `Tools/landing-rules.mjs:7`), a landing performed in a clone whose hooks were never
installed, or a commit path that does not run the hook. **Only if the answer turns out to be an
assertion missing from `Tools/verify-landing-compliance.mjs` does the fix land in a held file**, and in
that case it is a maintainer item rather than a lane's.
The `dev.yml` step for the already-existing `verify-comment-cleanlist` script (`package.json:154`) is
missing; adding it is part of the same batch. Sequencing: the three cloud files holding 46 of the 53
regressions are the files the L4/L5 cloud lanes will edit.

**P0-3 — do not execute the `Globe.destroy()` remedy.**
A stop, not work. The proposed fix calls a `TerrainProvider.destroy()` that does not exist on
`TerrainProvider`, `CesiumTerrainProvider` or `EllipsoidTerrainProvider`. The site,
`packages/engine/Source/Scene/GlobeSurfaceTileProvider.js:1391-1394`, is upstream-authored; the HEAD
blame is the fork's prototype-to-class conversion. Effort S · class docs.
The residue is real and small — nothing releases `_terrainProvider` on teardown, here or upstream — and
it is carried at P2, beginning with `this._terrainProvider = undefined;` plus an upstream issue.

### P1 — fork-authored (five blocks)

**`renderer-infra-01` — mapped-buffer readbacks are not exception-safe.** At
`packages/engine/Source/Renderer/WebGPU/WebGPUEntityClusterDispatcher.ts:361-377`, three **persistent**
readback buffers are mapped together and decoded through three `new Uint32Array(getMappedRange(...)).slice()`
copies **before any `unmap()`**; the three `unmap()` calls follow with no `try`/`finally`. A throw in any
decode leaves all three mapped for the lifetime of the renderer, every later `copyBufferToBuffer` fails
validation, and GPU entity clustering degrades to the CPU path permanently with a per-frame retry. The
same shape is at `WebGPUComputeInstanceRenderer.ts:1427-1436`.
Scope is **two files, not eight sites**: `WebGPUGPUCuller.ts` and `WebGPUHiZOcclusionDispatcher.ts`
already chain a `catch` that unmaps, four other cited sites map transient per-call buffers (one leaked
buffer, no wedge), and `BufferMapper` has no consumer. The "destroy a buffer while in flight"
reproduction is blocked by an in-flight early return; the surviving non-teardown trigger is an
allocation failure inside the three `slice()` copies.
**Tracked, not new — attaches to `H-R9`** (`ARCHITECTURE_REVIEW_2026-09-02.md:991`), which is RESOLVED
at Batch 213 for `WebGPUGPUCuller.ts` only.
Effort M · class engine · fix: one `mapAndRead(buffer, range, fn)` helper that unmaps per buffer in
`finally`. Acceptance: a stub buffer whose decoder throws must still end unmapped — **no device needed.**

**`renderer-infra-06` — `DrawCommand` ↔ `WebGPUDrawCommand` parity.** `orientedBoundingBox`, `snapId`,
`pickMetadataAllowed` and `pickedMetadataInfo` exist on the upstream command and are absent from the
WebGPU twin. **No reachable failure**: `packages/engine/Source/Scene/Scene.js:3596-3601` returns early
on `command.isWebGPUDrawCommand === true` before every reader. A literal violation of the parity rule
with no symptom. The four properties are upstream-authored; the gap is fork-side. Effort S · class
engine.
**A decision, not a patch (D7) — and partly ruled already:** `DEFERRED_WORK.md:7590`
(`NEW-CAPABILITY-GETTER-CODIFY`, residual 2) rules the `isWebGPUDrawCommand` checks non-violations —
"a COMMAND property, not a context branch" — which is the same argument for recording substitutes
rather than adding dead fields. Half the exemption text is already written in
`WebGPUSnapFramebuffer.ts`.

**P1-RTE — previous-frame velocity abandons RTE.** **Seven sites in six shader files, each re-read:**
`Shaders/WebGPU/Model/ModelPBRComplete.wgsl:1038-1040`,
`Shaders/WebGPU/Collections/BillboardCollection.wgsl:750-751`,
`Shaders/WebGPU/Collections/BillboardCollectionSDF.wgsl:617-618`,
`Shaders/WebGPU/Collections/PointPrimitiveColor.wgsl:424-425`,
`Shaders/WebGPU/Collections/PolylineCollection.wgsl:373-376`,
`Shaders/WebGPU/Compute/ComputeInstanceRender.wgsl:269-270`, plus
`Renderer/WebGPU/WebGPUCloudRenderer.ts:464-467`. Five of the seven read literally
`vec4<f32>(prevPosHigh + prevPosLow, 1.0)` followed by `camera.previousViewProjection * prevWorldPos`.
The current-frame clip position is exact via RTE; the previous-frame one sums high and low in f32 and
multiplies a full-magnitude world-space matrix. The reconstruction floor is about 0.25 m per component
near the Earth's radius, before the matrix's own cancellation. Not P0 because
`Scene.js:1324` defaults `taaEnabled` to false.
**Tracked since 2026-07-15**, naming all six shader sites: `C9-25-PREVIOUS-FRAME-RTE` / `FAR-306`
(`QUEUE_2026-07-15_CAMPAIGN9.md:244`), carried into `AR-049`
(`QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md:195`, P1, fix unowned). The audit contributes nothing new.
Effort L · class shader · full proof bar plus a **named Edge leg**; acceptance is a measurement (a
static scene under a static camera must produce a velocity of about zero), not a rule citation.
The remedy is directionally right and understates the scope: no camera-uniform struct on any of the six
paths carries a previous RTE matrix or an encoded previous camera, so six renderers must add and pack
uniform lanes under the `previousViewProjection` tail rule. **Two in-tree precedents, both re-read:**
`WebGPUPointCloudRenderer.ts:327` declares `previousMvpRelativeToEye`, `:339` declares
`previousEncodedCameraHigh`, and `:510-514` computes the previous position relative to the previous
encoded camera before multiplying; and for the cloud site specifically,
`Shaders/WebGPU/Environment/CloudTemporalResolve.wgsl:45` declares
`previousViewProjectionRelativeToEye`, consumed at `:363-365`.

**`webgpu-scene-fr-03` — public JSDoc stripped from `ScreenSpaceCameraController.js`.** From `:153`
onward, public properties keep only `@type` and `@default` with no description, and nine have no
docblock at all. Because the published typings are generated from these blocks, this is a **typings**
regression rather than a comment row, and it violates "Preserve ALL existing JSDoc comments when
modernizing files". Tracked but mis-scoped: `NEW-CAMERA-JSDOC-RESTORE` (`DEFERRED_WORK.md:7667`) is
RESOLVED at Batch 299 and its own closure sentence covers, for this file, only `maximumTiltAngle` plus
`isDestroyed`/`destroy` — three members of twenty-seven. Effort S · class docs · fix: restore verbatim
from the merge base exactly as Batch 299 did for `Camera.js`, and amend the closure note. Restoring
upstream text **reduces** conflict surface.

**`methodology-13` — the audit cites unlanded work as the tip.** One row's line numbers exist only in
an uncommitted working copy; at the tip the calls sit elsewhere in the file. **Settled:** at the tip
both sites named by the underlying temp-directory claim already clean up on every path the claim
names — one removes the directory in its own `catch` while its sole caller removes it in a `finally`,
and the other removes it in its `catch` and registers an idempotent `process.once("exit", …)`.
Therefore **the P1 is the citation defect only**, and the code residue is a P3 naming nit: the
directories are created at the temp root rather than under a per-lane subdirectory. The file is held;
nothing here is briefable until it is released.

### P1 — upstream-authored (eight)

Each carries the question `R-2026-09-17-1` turns on: is the fix one hunk in a file the fork already
diverges in?

**`core-02` — the event-raising flag latches on a throwing listener.**
`packages/engine/Source/Core/Event.js:121-151`: `raiseEvent()` sets `_invokingListeners = true` at
`:122`, iterates the listeners with no `try`, clears the flag at `:134` and only then drains the
pending add and remove maps. Corrected failure mode: subscribers are **not** silently dropped — the
next completing raise drains both maps. The real harm is worse. While the flag is latched,
`removeEventListener` parks the listener in the pending-removal map, returns `true` and decrements the
listener count **while the listener stays in `_listeners` and keeps firing** — so a listener that
throws on every raise cannot be unsubscribed, and `Scene.js:6777-6789` (`tryAndCatchError`) swallows
the throw, so the application runs on latched with nothing reaching the user.
Fix: **one private flush — flag reset plus both drains and clears — called from `finally`.** The
minimal variant leaves the pending-add map populated with the flag cleared, so a re-add drifts the
listener count permanently high. Effort S · class engine · **already diverges, 275 lines** — zero
marginal sync exposure. Acceptance seams are missing: the event spec has no throwing-listener case, and
there is no `EventHelperSpec.js` anywhere in the repository.

**`datasources-02` — `Property.equals` calls `equals` without checking it exists.**
`packages/engine/Source/DataSources/Property.js:73-74` is
`return left === right || (defined(left) && left.equals(right));`. Two `TimeIntervalCollectionProperty`
instances with identical boundaries and primitive data therefore throw a `TypeError` from the
per-frame material-batching path; reproduced under Node against the fork's own modules, directly and
through a material property's `equals`, with CZML reachability in `CzmlDataSource.js`. Lineage 2013.
Fix: `typeof left.equals === "function" ? left.equals(right) : left === right`. The same guard **shape**
is already upstream-verbatim two files away —
`packages/engine/Source/DataSources/TimeIntervalCollectionProperty.js:66` reads
`if (defined(value) && typeof value.clone === "function")`, on `clone` rather than `equals`. Effort S ·
class engine · **byte-identical with upstream** — so under `R-2026-09-17-1` it is fixed in fork on
severity and filed upstream.

**`datasources-15` — the GeoJSON CRS-name table has no prototype guard.**
`packages/engine/Source/DataSources/GeoJsonDataSource.js:1011` indexes a plain object with a
document-supplied string. **Close as a duplicate of `AR-016`**
(`QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md:110`), which is rated **P0** there, sized XS, has its
acceptance already written, and is coupled to two other rows. Do not open a lane.

**`globe-terrain-04` — `new Array(-1)` in URL zero-padding.**
`packages/engine/Source/Scene/UrlTemplateImageryProvider.js:643` tests `value.length >= paddingTemplateWidth`
where `value` is a number, so `value.length` is `undefined`, the ternary always takes the padding
branch, and `new Array(paddingTemplateWidth - value.toString().length + 1)` at `:645-647` reaches `-1`
and throws a `RangeError` as soon as the number has two more digits than the template's width. The
abort is a per-frame render abort caught by `tryAndCatchError`, not a one-shot provider abort. Fix:
`String(value).padStart(paddingTemplateWidth, "0")`. Effort S · **already diverges.**

**`globe-terrain-05` — a rejected availability promise is cached for the layer's life.**
`packages/engine/Source/Core/CesiumTerrainProvider.js:1343-1344` stores the request promise in the
layer's availability cache and then registers `requestPromise.then(deleteFromCache)` — `onFulfilled`
only. One transient 404, 500 or abort therefore leaves the rejected promise in the cache for the
layer's lifetime, and terrain under that availability tile never refines again for the session. Fix:
`.finally(deleteFromCache).catch(() => {})`. Effort S · **already diverges.**

**`widgets-10` — three inspector mixins leak a live panel into the caller's page.** Upgraded P2 → P1 by
the refutation pass. `viewerCesiumInspectorMixin.js:29`, `viewerCesium3DTilesInspectorMixin.js:23` and
`viewerVoxelInspectorMixin.js:23` each append a panel to `viewer.container` and never wrap
`viewer.destroy`; `Viewer.destroy()` removes only its own element, so after teardown the user is left
with a dead inspector panel in their own page, bindings still applied, on **every** extend-then-destroy.
**The only deterministic user-visible symptom in the corpus.** Fix: mirror the existing precedent at
`viewerDragDropMixin.js:217-220`, which wraps `viewer.destroy` for exactly this reason. Effort M ·
class engine · **byte-identical with upstream for all three** — fixed in fork on severity under
`R-2026-09-17-1`, and filed upstream.

**`workers-wasm-01` (with `build-thirdparty-01`) — release workers ship debug code.**
`scripts/build.js:703` opens the IIFE worker branch; `:751` assigns the worker plugin list and
`:752-754` pushes the pragma-stripping plugin **inside that branch**; the `else` at `:755` builds every
ESM worker bundle without it. So every `Build/<variant>/Workers/*.js` ships with all developer-error
blocks live, including the fork's own WebGPU debug diagnostics. Blast radius: 146 of 230 worker entry
files. Fix: hoist the push above the branch. The acceptance must grep the **assert text**, not the
pragma marker, because minification removes the markers. Effort S · class build · **already diverges.**

**`workers-wasm-02` (absorbing `core-04`) — a failed worker never settles.**
`packages/engine/Source/Core/TaskProcessor.js:357-360` subscribes only to `message`; the removal at
`:342` is likewise message-only. A 404, a CSP block or a top-level throw fires the `error` event,
nothing rejects, the active-task count is never decremented, and after `maximumActiveTasks` such events
terrain and geometry loading stop silently. The same defect is in the WebAssembly-module initialiser,
whose cached never-settling promise stalls every Draco, KTX2 and splat load with neither a ready nor an
error flag. **Tracked: `ARCHITECTURE_REVIEW_2026-09-02.md:594`, row `1390-10 [shaderasync]`, unowned —
attach there.** Fix: a per-task `error`/`messageerror` listener rejecting with a `RuntimeError`,
removed alongside the message listener. Effort M · **already diverges, 272 lines.**

### P1 — process and record (eleven, all docs class, effort S)

Eleven findings about the audit rather than the code, each of which must be on the record so the corpus
is not re-read as authoritative: an invented code-freeze doctrine that deleted seven real defects from
the roadmap; that same doctrine not applied to eight equally-upstream rows; **every** upstream-versus-fork
verdict in the corpus asserted with zero git operations; seven rows published although the audit's own
refuter marked them REFUTED, with that refuter's census rewritten; one fleet's adversarial pass
surviving only as a truncated transcript; no finding row carrying a disposition; the arithmetic (≈ 3,011
rows, 2,339 without a verdict, one fleet's 283 excluded); "40 Critical P0 Defects" being 33 rows with
zero at this fork's bar; "100% COMPLETE" against 64% never named; one row demonstrably FALSE; and zero
of the nine corrections required by `R-2026-09-16-11` applied as of 2026-09-17.

One of the eleven is **settled against its sibling**: `Scene.render()` opens with an explicit recursion
sentinel and runs every phase under `tryAndCatchError`, so the stranding the audit describes does not
occur on the default configuration (`Scene.js:590` defaults `rethrowRenderErrors` to false) and the
prescribed latch would duplicate an existing guard. The surviving residue is **P3**: the fork added two
calls unwrapped inside the credit window. The second half of that remedy must not be adopted — moving
the after-render functions into a `finally` would run them on the no-render path and reorder them
against post-render, changing request-render-mode semantics.

---

## (d) The P2 backlog — 136 rows by class

Not individual rows. Each class below is a shard a future lane can be cut from; the per-row evidence is
in the archived domain files, which resolve by the `<domain>-NN` ids.

| class | n | the rows worth cutting first |
| --- | --- | --- |
| test gap — no spec exists | 12 | `datasources-18` write `Specs/DataSources/PropertySpec.js`; it does not exist and it is the acceptance for two P1s and two P2s · `workers-wasm-13` `packages/engine/Specs/Workers/` does not exist at all, and **both** worker P1s belong there · `tiles-models-12` a 1,200-line batch-table spec is `xdescribe`d |
| leak (engine) | 8 | `globe-terrain-19` an imagery layer's `destroy()` never cancels its reprojections · `webgpu-scene-fr-06` a failed pick-depth readback leaks its staging buffer · `widgets-04` the animation widget inserts a style node and never removes it — **no refcounting needed**, each instance inserts its own, so this is S, not M |
| test hygiene / isolation | 11 | `widgets-16` an inner `const` shadows the suite variable so `afterEach` sees `undefined` — four green-path leaks, one-character edits · `core-23` six suites mutate global state and restore on the last line of the `it` body · `datasources-22` a clock uninstalled only inside a `.then`. **Cross-cutting correction: spec-on-expectation-failure stopping is `false` repository-wide**, so these are **throw-path** defects, not assertion-failure defects — which also corrects `webgpu-scene-fr-12`, whose stated failure mode carries the refuted premise |
| tooling contract — exit codes, temp, scope | 11 | `tools-probes-02` with `-01`, `-09` and `-10` as **one lane**: give the wave-end child protocol an ERROR tier (3 is free) and derive the child map from the existing status-code table — that closes three rows and makes the do-not-execute `BUG-14` unnecessary rather than merely harmful · `tools-probes-04` re-scope the probe-fleet contract from filename prefix to behaviour (44 escapees, 37 with no watchdog) · `tools-probes-06` a temp-allocation source-anchor spec |
| perf / allocation | 9 | `workers-wasm-08` three decoders never populate their transferable-object lists · `datasources-01` a helper passes the undefined value to `clone()` · `core-27` a `Cartesian3` allocated per triangle in normal computation |
| robustness / untrusted input | 6 | `datasources-13` a bare `hasOwnProperty` call on parsed CZML and GeoJSON · `datasources-14` a KML data name written into a plain object without prototype sanitising · `workers-wasm-16` typed-array views taken from arbitrary byte offsets |
| renderer lifecycle / validation | 7 | `renderer-infra-04` the WebGPU context's `destroy()` omits both pipeline caches — **a pooled device is released, not destroyed, so the retained pipelines are live GPU objects under the fork's multi-view model** · `renderer-infra-03` the performance manager calls a mapper method that **does not exist**, hidden by a structural interface · `collections-primitives-05` indirect-dispatch sentinels whose branch has no producer |
| scheduler / frame loop | 2 | **`camera-scene-loop-08` — `JobScheduler.resetBudgets()` never clears the executed-this-frame array.** Re-verified at the tip: `packages/engine/Source/Scene/JobScheduler.js:114-125` touches only the budget fields and the total, `:132` reads the array, `:185` writes it, and nothing resets it — so from frame 2 the documented guaranteed-progress allowance is inoperative. The ceiling is one extra texture job and one buffer job on an exhausted frame, because **`JobType.PROGRAM` has zero producers**: the identifier appears exactly twice in the engine, both inside `JobScheduler.js:83-84` allocating its own budget. **The obvious fix is not safe as written:** `disableThisFrame()` (`:109-112`) enforces "no jobs this frame" only through the `:134` gate, and pick passes never call `resetBudgets`, so resetting the array alone would let a synchronous upload run inside a pick. Reset in `resetBudgets` **and** set a flag in `disableThisFrame`. All four existing multi-frame specs pass either way, so the lane must add a frame-boundary case — which doubles as its inertness mutant |
| shader correctness / duplication | 8 | `shaders-08` a window-coordinate helper with **three** defects — halved x/y scale, a z re-biased although WebGPU's NDC z is already in [0,1], and `w` destroyed; zero callers, latent · `shaders-13` a metres-per-pixel helper that drops the 2D and orthographic branches and **has a live consumer**, so it must not ride on the AR-090 ruling · `shaders-17` 41 non-chunk orphan `.wgsl` files whose live twins are template literals, with in-tree comments citing them as authority |
| build / packaging | 6 | `build-thirdparty-04` the engine package's `files` array omits a module the published entry deep-imports eight times · `build-thirdparty-20` with `workers-wasm-21` a WASM artifact with zero callers, 30.6 KB in every build and in the tarball · `build-thirdparty-13` the Slang compiler stamps a timestamp into every generated shader |
| demo / sandcastle | 8 | `sandcastle-05` internal campaign markers in the **rendered UI text** of a public gallery demo · `sandcastle-02` two edge demos load from the spec-data tree; the deployed symptom is a silently blank globe · `sandcastle-04` nine fork-owned sites read a `@private` context property (five of the fourteen cited sit in upstream-verbatim files, where an edit buys only divergence) · `sandcastle-09` a `.catch` handler calls a method on an undefined `this` |
| instrument scope | 5 | `webgpu-scene-fr-20` clean-listed files carry banned markers **inside WGSL template literals the guard cannot see** · `build-thirdparty-18` the debug-pragma lint scans 278 of about 1,508 engine files · `webgpu-scene-fr-21` a live bind-group-layout label carrying an internal batch number ships to devtools |
| WASM alignment | 2 | `globe-terrain-02` and `globe-terrain-03` — an odd vertex count and a 65×65 heightmap both give a byte count ≡ 2 (mod 4), so the output view's offset is unaligned, the typed-array constructor throws and the decode silently falls back to JS. Both bridges come from one commit and both are gated behind `S5-2-WASM-CONSUME-OR-RETIRE` (`DEFERRED_WORK.md:7383`, OPEN), so fixing alignment first is work on provisional code. The audit's own arithmetic overruns the arena by up to three bytes; the correct shape grows the total allocation by the pad |
| remainder | 41 | `core-06` a query-parameter lookup throws when a key is `hasOwnProperty` · `core-18`, `-19`, `-20` three specs that assert nothing · `collections-primitives-08` hoist a stage removal above the feature-renderer early return and delete the 12-line WebGPU mirror — **S, not M** |

**Settled and moved out of the P2 backlog.** The dependency row becomes P3 with no security action (§b.1).
An RTE row against the ellipsoid primitive renderer is withdrawn: two domains reached opposite verdicts
on the same line and **both agree the code is correct** — the vertex stage does RTE in model space and
the unit cube is exact in f32 — so the residue is that the exemption is written nowhere, which is
already `AR-092`'s acceptance text (`QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md:329`). Fold it there
rather than open a row. The temp-directory residue of the landing verifier becomes P3 (§c).

**All 172 P3 rows are comment, JSDoc and naming rows and belong to the C16 instruments, not to a lane.**

---

## (e) Architecture signals

Fourteen patterns, each with the mechanism that would prevent the class rather than the instance.

| # | pattern | mechanism that prevents the class | exists today? |
| --- | --- | --- | --- |
| A1 | Instruments exist and are scoped to the wrong subtree — the comment-marker guard is blind to `packages/engine/Specs`, `packages/sandcastle`, `Apps/Sandcastle`, WGSL template literals and box-drawing dividers; the debug-pragma lint scans 278 of about 1,508 engine files; the probe-fleet contract globs by filename so 44 browser-launching scripts escape, including both wave-end children; the string-literal scanner is not in `dev.yml` | widen the grammar, add scope roots, wire the third scanner behind its own ratchet, select the probe contract by behaviour | **yes — only scope and CI wiring are missing** |
| A2 | Rules stated in the governance file with no instrument — `DrawCommand` parity (and the rule's text does not cover a property arriving through an **upstream sync**), backend agnosticism, RTE, the Scene Logic Extractor | a Node guard per rule with an exemption table **read from source**, plus a fork-authored RTE spec | no |
| A3 | Mapped-buffer and flag lifetime is an idiom with no helper — the same shape on GPU and CPU; 25 map-async sites in 14 files, and the correct `try`/`finally` exists exactly where the buffer is transient | one `mapAndRead()` helper plus a spec whose decoder throws | no |
| A4 | No teardown contract, and one `catch` makes it untestable: the scene swallows every owned `destroy()` exception and routes about twenty owned resources through it | a destroy-releases-everything spec helper **plus one permanent `console.error` inside that catch** | no |
| A5 | Upstream authorship used as a disposition on a measurably false premise — zero git operations in 3 MB, while `Event.js` is +255 lines against upstream, 37 of 47 widget sources diverge, and conversely 103 of 143 substantive sandcastle rows target files with zero divergence | require an inline `git diff --numstat upstream/main HEAD -- <path>` and a `git blame -L` in any brief proposing an upstream-file edit | only in this workflow's brief |
| A6 | WGSL has no composition mechanism on the live path — 3 of 325 shaders use the import directive, 6 of 105 chunks are reachable via a hand-written table, 41 non-chunk orphans, 85 hand-copied camera-uniform structs | rule AR-090 either way; a generator; a ~20-line importer guard; a duplicate binding-slot scan | the stack exists and is unreached |
| A7 | Spec coverage is absent exactly where the P1s live, and specs on unwired code produce false greens — the WebGPU shader cache has a full spec and zero engine instantiations | write the four missing spec files; add a wiring assertion that every renderer class with a spec has an engine construction site | no |
| A8 | Dead surface is the audit's highest-value by-product, and it collides with the dead-code principle — the shader cache; two zero-caller copies of a bind-group-layout helper; a buffer mapper; a method that does not exist; **a job type with no producer**; a 30.6 KB WASM artifact; 41 orphan shaders | a per-item retire-or-wire ruling; the architecture review already rules RETIRE for the shader cache | partly — rulings exist, rows unowned |
| A9 | The status-to-exit-code vocabulary has forked four ways inside `Tools/` | a source-anchor spec forbidding a second table — a pattern this repository has shipped four times | the pattern exists; this instance does not |
| A10 | External-model audit lanes inherit no fork doctrine and fabricate the axes they may not measure | a dispatch template mandating a per-row verdict, a severity, an inline blame, an explicit revision per cited line and a ledger grep | only in this workflow's brief |
| A11 | `as unknown as` appears 517 times across 58 of the 277 WebGPU renderer TypeScript files. This is the mechanism behind `renderer-infra-03` — a method call typechecks although the method does not exist — and it is the sibling hole in the `any` ban | declare the members, then a lint budget that ratchets down | no rule, no budget |
| A12 | A destructive sweeper's protect list is machine-specific: the temp-hygiene tool's protected-path list ends in a hardcoded drive root, so on any other machine the repository root is unprotected, and twelve `Tools` files carry the absolute repository path. This is the fork's own "destructive scripts take a positive list" class | derive the protected root from `git rev-parse --show-toplevel`, with a spec asserting the repository root is protected under a synthetic root | no |
| A13 | Shadowed-variable linting is configured nowhere — the one-line mechanism for the four green-path spec leaks in `widgets-16` | enable it for `Specs/**` behind a seatbelt ratchet | no |
| A14 | Tools default to writing non-gitignored paths inside the worktree, so a crashed probe dirties the tree the landing guards then read — adjacent to the dirty-tree finding and to P0-2's prerequisite | route every tool output through the lane-temp helper; the source-anchor spec in `tools-probes-06` is the natural home | the helper exists, five adopters of 75 sites |

Lower weight, recorded so they are not re-derived: five modules inside `packages/engine/Source` import
the engine's own package root, cycling through the barrel; `FAR-308` already owns "no automated
Scene-boundary guard exists", so A2 must attach to it rather than duplicate it; and `AR-092` is the
cheapest single fix that stops every future auditor re-deriving the RTE carve-outs — three domains
named it independently.

---

## (f) The plan, in waves

Standing constraints applied: quiet hours; one Edge job at a time, with the cloud legs holding the
queue (`R-2026-09-17-5`); a fan-out of at most five tier-3 lanes per lead; the held files untouchable;
doc archival held, so corrections are dated and in place; and every P3 comment row going to the C16
instruments rather than to a lane (`R-2026-09-17-6`).

**Wave 0 — green the CI gates.** One lane under `R-2026-09-17-3`: execute the lint ruling with the
`overrides` pin (`R-2026-09-17-8`); then, in this order, record which bypass let the two cloud batches
past the hook, bank the rationale, sanitise the eight files, and add the missing `dev.yml` step for the
already-existing clean-list script. Acceptance: `npm run eslint` exit 0; `npm run lint-comment-markers`
exit 0; the C16 subtest green.

**Wave 1 — the record and the ledger.** This document, the rulings file, the rows in §c and §d, the
attachments in §c, the one new C16 row, and the campaign-state line. No Edge.

**Wave 2 — the one-line engine bundle.** Five independent S/M lanes, each fix plus the missing spec
plus an inertness mutant plus review: the event flush; the property-equals guard with `PropertySpec.js`
written **first**; the two terrain and imagery one-liners; the worker settle with the pragma hoist and
a first `Specs/Workers/` spec; and the three inspector mixins. None has a visual surface, so
`R-2026-09-17-4` governs the leg. One lead to settle before the widgets lane: whether the karma
configuration's `client` block is replaced rather than deep-merged, because if it is replaced the
coverage run executes specs in random order — the exact condition that turns throw-path leaks into
intermittent unrelated reds.

**Wave 3 — renderer and shader.** The mapped-buffer helper, routing **two** files through it, with a
stub-buffer spec and **no device**, so it does not queue behind the cloud legs; the previous-frame RTE
work, the only L, which takes a named Edge leg and does queue; and the two shader latents, which need
review and a spec but no capture.

**Wave 4 — decision-gated.** `DrawCommand` parity (D7); AR-090 (D10), one ruling that disposes of five
shader rows; the two WASM alignment rows behind `S5-2-WASM-CONSUME-OR-RETIRE`; the retire-or-wire
rulings of A8; and D1 for the upstream-authored P1s, now ruled as `R-2026-09-17-1`.

**Wave 5 — instrument scope**, the highest leverage per line and no Edge: the C16 grammar and scope row
(`C16-21`); wiring the string-literal scanner behind its own ratchet; selecting the probe contract by
behaviour; the exit-code reconciliation; extending the static-build import check to the fork's own
WGSL entry key, which is the only build-time mechanism that would have caught the packaging row; and
the two one-line mechanisms of A12 and A13. Blocked from this wave: anything touching the held landing
verifier.

**Wave 6 — the P2 shards**, one per class from §d, each sized to a single reviewed batch and folded
into the existing campaigns rather than opened as new ones. Sequence: the spec-authoring shard first,
because it is the acceptance for several fixes, then leaks, tooling contracts, the scheduler lane,
demos, and perf.

---

## (g) The decisions, as argued

Reproduced as they stood when the rulings were taken. Where a ruling differs, the ruling wins;
`MAINTAINER_RULINGS_2026-09-17.md` is the authority.

**D1 — upstream-authored bug policy.** Severity first, divergence as the tiebreak, with the in-fork
hunk recorded in the sync plan's conflict census. The rejected alternative has no severity term and
would carry the corpus's only deterministic user-visible defect purely because its file is
byte-identical. **Ruled `R-2026-09-17-1`.**

**D2 — does the audit document land?** Supersede and archive was argued, because the nine corrections
do not repair the three structural defects — an unmeasured authorship axis, no per-row disposition, and
a coverage claim against 64% never named — and correcting the arithmetic buys a tidier wrong document.
**The maintainer kept the nine corrections: ruled `R-2026-09-17-2`.** Either way the corpus is archived
and the do-not-execute list binds its readers.

**D3 — the P3 comment mass.** Fold into the existing C16 rows plus exactly one new row for instrument
scope, because the existing rows own marker hygiene and none owns scope. **Ruled `R-2026-09-17-6`.**

**D4 — a targeted second pass on the coverage gaps.** One targeted pass after wave 5, in the order
given in the rulings file. A full re-audit is not worth it: the marginal yield was six reachable
defects per 3,011 findings. **Open.**

**D5 — how the external model is used from here.** Bounded docs now, fleets later behind a mandated
template. The failure was structural, not a failure of reading. **Ruled `R-2026-09-17-7`.**

**D6 — clear the CI-red gates now?** Yes, with the ordering above, and with the premise corrected:
only the lint gate is red on every push. **Ruled `R-2026-09-17-3`.**

**D7 — `DrawCommand` parity.** Record an exemption table naming the WebGPU substitute per property,
build a guard that **reads the table from source**, and amend the upstream-sync post-merge checklist.
The guard must read from source because the fork's existing exemption table has already drifted against
its prose copy. The rule's text says "when adding a property to `DrawCommand`", which does not cover a
property arriving through an upstream sync — that is where the gap enters, so the sync checklist is the
durable half. **Open.**

**D8 — the lint dependency.** Apply the existing ruling plus a root `overrides` pin rather than editing
the upstream range. **Ruled `R-2026-09-17-8`.**

**D9 — the named leg for non-visual engine changes.** The karma suite per lane, and the wave-end gate
as the wave's single closing discharge, stated as one ruling so lanes do not re-litigate it per batch.
**Ruled `R-2026-09-17-4`.**

**D10 — AR-090, the WGSL chunk stack.** An existing row to rule, not a new decision. On the merits,
retirement is cheapest for the preprocessor and builder stack and labelling is right for the chunk
files; they are separable. The constraint either way is that a decided rule presumes the shared
camera-uniform chunk file survives, and one shader row has a live consumer and must be fixed
regardless. **Open.**

---

## (h) Gaps left open

What could not be settled, and what would settle it.

| id | gap | what would settle it |
| --- | --- | --- |
| G-01 | **Sandcastle census.** The domain report states 143 substantive rows reduced to 29 distinct claims, but its item list holds 19, four of which are class aggregates. No row-to-item map for roughly ten claims. All are P2 or P3, so nothing at P0 or P1 is affected | enumerate the ten from the domain worker reports; worth doing only when the sandcastle P2 shard is briefed |
| G-02 | **Atmosphere census inconsistency.** The domain census reports 6 substantive rows beside twelve items, six of which are cross-domain imports and process rows | the domain's own row-to-item mapping; cosmetic — both its P0 and its P1 are among the six substantive rows |
| G-03 | **One process row has no blame sha**, carrying a pointer to a table instead, so a lane generated from the domain file alone has no authorship for it | copy the per-row table into the ledger row when that lane is cut |
| G-04 | **Which bypass let the two cloud batches past both gates.** The guard, the clean list and the hook glob are all correct at the tip, so the cause is a bypass, not a guard defect — but one candidate answer, a missing assertion in the landing verifier, lives in a held file | wave 0's first step, from `git` history and the landing script's invocation. If the answer is in the held file it becomes a maintainer item, not a lane |
| G-05 | **Whether the karma configuration's `client` block is replaced or deep-merged.** If it is replaced, the coverage run executes specs in random order — which is what turns throw-path spec leaks into intermittent unrelated reds | one karma run at debug log level; no agent in this workflow was permitted to run it |
| G-06 | **The real-world trigger rate of the mapped-buffer defect.** The teardown reproduction is blocked by an early return; the surviving trigger is an allocation failure inside three `slice()` copies, and nobody could measure how often that happens | not worth measuring — the fix is small and the consequence is permanent. Recorded so the lane does not over-claim urgency |
| G-07 | **One shader row's device-level disjointness** was closed with banked probe images rather than a live capture | it rides the shader lane's Edge leg if one is ever run; currently P3 |
| G-08 | **One fleet's 668 findings were never adjudicated by any surviving artifact**, so whatever it found is neither confirmed nor refuted by anyone, including this workflow | only a re-run would settle it; D4 deliberately re-audits by subsystem instead, which is cheaper and better targeted |
| G-09 | **The 2,250 style rows were never verified individually** — sampled five-by-blame per domain. The 172 P3 rows are a characterised mass, not a verified list | the C16 instruments after wave 5 regenerate this set mechanically with a per-row disposition; that is the correct settlement, not more reading |
| G-10 | **Whether the ~19,000 lines of never-named WebGPU renderers contain anything at P0 or P1** | D4 |
| G-11 | **Two instrument measurements did not reproduce in this lane at `91a7a8c9ff`** and the record carries the re-derived figures, not the inherited ones. The string-literal scanner reports **266 marker-bearing literal lines in 24 files of 1,508 scanned** at the scope its npm script actually uses, against an inherited figure of 340 in 57; and `Batch Q23` appears **10 times in 2 in-scope source files** (7 and 3), plus once in a Tools probe that is out of scope, against an inherited 15. The box-drawing measurement reproduced exactly (999 runs in 99 of 2,217 files under the two scope roots) | nothing further — the re-derived figures are the ones in `C16-21`'s acceptance |
| G-12 | **The generated typings could not be opened.** The public-JSDoc regression is a typings regression because the published declarations are generated from those blocks, but `packages/engine/index.d.ts` is build output and absent from a fresh clone, so the specific member list could not be re-read at the tip. The source-side loss at `ScreenSpaceCameraController.js:153` onward was verified directly | regenerate the typings in a built tree, or verify during the fix lane, which builds anyway |
