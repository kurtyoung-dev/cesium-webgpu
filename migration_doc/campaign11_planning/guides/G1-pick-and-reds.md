# C11 Cluster Guide G1 — Pick Fleet + pickPosition Correctness (11) & Standing Gate Reds (15)

**Author sweep HEAD: `5b98ab9698` (Batch 699, `main`).** Every anchor below marked "verified" was
re-grepped against `git show HEAD:` at that hash on 2026-07-18 — NOT against the working tree,
which is concurrently dirty under the running C10 workers. Line numbers are hints; anchor by
symbol. Register: `scratchpad/c11/C11_CANDIDATE_REGISTER.md` clusters 1 (`pick`) + 2
(`standing-reds`). House format per `migration_doc/CAMPAIGN10_EXECUTION_GUIDE_2026-07-16.md`
H1–H3. Items are referred to ONLY by their existing register names — the orchestrator assigns
C11 numbers at assembly.

**This is the W1 campaign-anchor guide.** The single highest-attention item is
`NEW-WEBGPU-PICKPOSITION-CONVERGENCE-REGRESSION` (+ its bimodal black-globe-interior companion) —
it gates the C10-30 and any C11 checkpoint feature-loss check, and it has survived THREE
independent attribution runs (C9-07 stash oracle, C9-13 V6, C10-01 OFF-oracle) without an owner.

---

## 0. MANDATORY INTAKE-CONDITIONAL — read before scheduling ANY pick-cluster item

C10 is running concurrently. As of `5b98ab9698`, batches 683–699 have landed
(C10-01/02/03/04-block/05/09/10 + C9-17 A/B + C9-12A + audit sweeps). **C10-11
(`PICK-FLEET-LOG-DEPTH`), C10-12 (`PICK-DEPTH-PLANE-GATE-FLIP`), C10-13 (reversed-Z spike), and
the C10 W4 correctness riders are NOT yet landed at this hash** (C10Q §3.2 rows 151–153 say NOT
STARTED at queue-write; W4 is later in the C10 wave order). By C11 launch they may be. The FIRST
action of whoever executes this cluster is the following deterministic intake check:

```bash
git log --oneline -40 | grep -iE "C10-1[123]|pick-fleet|depth-plane|W4"
grep -n "C10-11\|C10-12" migration_doc/QUEUE_2026-07-16_CAMPAIGN10.md   # ledger status rows
git show HEAD:packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererPickPass.ts | grep -n "PICK_DEPTH_PLANE_ENABLED"
node Tools/visual-regression/probe-depth-plane-horizon-oracle.mjs        # if runnable: on/off/restored
```

Decision table (apply per item):

| Observed at C11 intake | Consequence for this cluster |
| --- | --- |
| `PICK_DEPTH_PLANE_ENABLED = true` + C10-12 ledger COMPLETE | `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH`, `C9-02A` closure, and the P0-1 gate are CLOSED — drop them; re-verify the per-family pick probes listed in guide H6 stayed green; the packed-depth item (FAR-408) and main-scene depth blit must then consume the NEW log-encoded pick FBO contract (their premises change — see their sections). |
| C10-11 landed, C10-12 not | Fleet is log-converted but gate off. Only C10-12's own recipe remains — do NOT re-scope it here; it stays C10-owned unless C10 formally hands it over. |
| Neither landed, C10 still running | Do NOT open pick-fleet work in C11 — double-landing a 14-file WGSL fleet conversion against a concurrent C10 worker is the worst possible collision. Schedule only the items C10 W4 does NOT own (see per-item "C10 ownership" lines). |
| C10 W4 riders (buffer-primitive dispatch, MSAA-flip, compute-instance mirror, async readiness, 2DCV key parity) landed | Each has a ledger row + probe; verify probe-green and drop the item. C10Q §4 line 186 lists exactly these five as W4 riders — **the register schedules them into C11 only as "pick up what W4 leaves".** |
| C10-13 spike recorded GO for reversed-Z | ALL log-depth-conversion work in this cluster is provisional — the reconciliation decision (C10Q §3.2 C10-GT row) must be read before landing anything that adds MORE log-depth surface. |

Also verify the two standing reds' freshest re-confirmation: C10-01's gate run (B693, C10Q §3.2
row 140) re-confirmed BOTH `probe-pickposition-webgpu` FAIL (via OFF-oracle — fails identically
with the frustum fix neutralized) and `high-density-5k-spheres` 8.62%. If a C10 batch after 699
closed either, this guide's two biggest items shrink to verification tasks.

**Landed-batch interaction map (B683–699) for this cluster:**

| Landed change | Interaction |
| --- | --- |
| B693 C10-01 1-frustum default | The 2026-07-14 pickPosition root-cause note (empty near frustum overwrites packed depth, `WEBGPU_DEBUGGING_LOG.md:13305`) describes a mechanism that CANNOT occur on a 1-frustum default frame — yet the probe still fails. Treat that old root cause as UNPROVEN for the current failure (see §1 protocol). `pickFromRay`-style offscreen frames also dropped 2→1. |
| B697 C10-03 demand resolve | Scene-COLOR resolves are demand-driven; `_ensureSceneColorResolved` (`WebGPUSceneRenderer.ts:2012`, verified) fires before consumers. The OIT×MSAA resolve-ordering red (`NEW-WEBGPU-OIT-MSAA-RESOLVE-ORDERING`) is a PRE-EXISTING adjacency C10-03 documented, not caused. Kill switch `_sceneColorResolveElisionEnabled` exists for A/B isolation in any pick/black-globe diagnosis. |
| B699 C10-02 translucent-twin gate | Unstyled tile commands halve; any pick probe counting tile commands must not assert pre-B699 counts. |
| B694 C10-09 prev-buffer revision-skip | Velocity prev-buffer re-uploads gone in 3 renderers; irrelevant to pick correctness but its probe (`probe-c10-09-prev-buffer-upload.mjs`) is a cheap regression canary when touching collection renderers. |
| B687/688 C9-17 A/B | Model group-1 bind-group caching + geometry revision tokens. Any pick fix touching `WebGPUModelRenderer`/`WebGPUModelPipelineCache` must keep `settledGeometryRevisionHits` green (`probe-model-instance-bg-cache.mjs`). |
| B695 C10-10 shadow single-sweep | Backend-agnostic PVS walk change; pick mini-frames share the walk — run one pick probe after any PVS-adjacent edit. |

---

## PART A — `pick` cluster (11 items)

---

### A1. NEW-WEBGPU-PICKPOSITION-CONVERGENCE-REGRESSION — THE W1 ANCHOR (P0, fable)

**+ companion: bimodal offline black-globe interior (same register row).**

#### What + why (evidence trail)

- **C9Q §3.2 L134 (primary):** standing gate `probe-pickposition-webgpu.mjs` run against
  `PROBE_BASE=http://localhost:8080` FAILS: the WebGPU leg NEVER converges to a Cartesian3 from
  `scene.pickPosition` — frames 0–7 all `undefined`, `cachedDepth=0 pending=true`, ZERO console
  errors — while the WebGL leg passes. Attributed PRE-existing during C9-07 (byte-identical with
  the demand-open changes stashed). The probe's default port is **8134** (verified at HEAD:
  `probe-pickposition-webgpu.mjs:22` `PROBE_BASE || "http://localhost:8134"`) — its last green run
  may have used a dedicated server/build; **the lane decision (is :8080 the supported repro?) is
  itself part of this item.**
- **Companion (same C9Q row):** on `http://localhost:8080/Apps/CesiumViewer/?renderer=webgpu&offline=true`
  the WebGPU globe INTERIOR renders black (center avgRGB 2,2,2, `tilesLoaded=true`, zero
  console/device errors, deterministic within a session) while WebGL renders the blue ellipsoid —
  and it is **BIMODAL across sessions** (the C9-07 impl's own pre-change capture shows the blue
  globe on the same route). An unrendered globe is consistent with `cachedDepth=0`.
- **Re-confirmations:** C9-13 V6 (C9Q L152: FAILs byte-identically); C10-01 gate (C10Q row 140:
  FAIL confirmed via OFF-oracle — fails identically with the frustum fix neutralized); C10-03
  observation (C10Q row 142: black-interior "flips between shipped/eager randomly per session" —
  i.e. INDEPENDENT of the resolve-elision kill switch, observed both ways).
- **Older adjacent root cause (do NOT assume it):** `WEBGPU_DEBUGGING_LOG.md:13305` (2026-07-14)
  isolated a pre-existing pickPosition defect — "in a two-frustum view every `PickDepth` instance
  references the same packed texture, and the final empty near frustum overwrites the far-frustum
  globe depth before asynchronous readback, returning `undefined`" — queued as
  `NEW-PICK-WEBGPU-MULTIFRUSTUM-PACKED-DEPTH`. **Post-B693 the default 3D frame is ONE frustum, so
  this exact mechanism cannot explain a failure at HEAD defaults.** It may still explain the
  8134-lane history or multi-frustum views; it is a hypothesis to TEST, not the answer.
- **Why it gates everything:** C10Q §4 line 187 marks this row "Highest-attention … gates `C10-30`
  feature-loss check". Every campaign gate that runs `probe-pickposition-webgpu` inherits this red;
  until it is diagnosed, every landing slice must OFF-oracle against it (as C10-01 correctly did).

#### Architecture today (verified at HEAD `5b98ab9698`)

- `Tools/visual-regression/probe-pickposition-webgpu.mjs` — verified mechanics: forces
  EllipsoidTerrainProvider + local NaturalEarthII imagery (deterministic offline), camera straight
  down at (−75, 40, 2,000 km), `tilesLoaded`-gated warmup (cap 600 frames) + 60 settle frames,
  then 8 per-frame `scene.pickPosition(center)` samples reading
  `scene._picking.getPickDepth(scene, 0)` → `_lastDepthValue` / `_pendingReadback` /
  `_updateCount`. It also records `numFrustums` (`scene._view.frustumCommandsList.length`),
  `pickDepthFullFrustumLogEncode`, `useLogDepth` — the diagnosis dimensions are already plumbed.
  Escape hatch: `PROBE_DISABLE_DEPTH_BINDING_CACHE=1` forces GlobeDepth to rebuild its depth-copy
  bind group per copy (cache-lifetime isolation).
- `packages/engine/Source/Scene/PickDepth.js` — verified: `_lastDepthValue` initialized
  `undefined` (:111), sync read at :211/:254, async readback writes it at :308. **The probe
  reporting `cachedDepth=0` (not `undefined`) means at least one readback COMPLETED and returned
  depth 0.0** — i.e. the packed depth texture read as zeros (the WebGPU pack's no-surface sentinel:
  `WebGPUGlobeDepth.ts:63-123` maps cleared/far depth to `(0,0,0,0)` ≡ "no globe here", verified).
  `pending=true` on all 8 frames = another readback perpetually in flight. So the depth CHAIN is
  alive; the packed texture CONTENT says "no globe" — which is exactly what a black (unrendered)
  globe interior produces. The two symptoms are one suspect.
- `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeDepth.ts` — pack/copy machinery (packed
  RGBA8 depth-as-color, :30/:159/:314 verified).
- `Tools/visual-regression/probe-demand-canvas-pass.mjs` — case 1 now gates the canvas CENTER
  region specifically (C9Q L134: "a case-1 center FAIL with zero errors and dark avgRGB is THIS
  bug, not a demand-open regression") — a second, cheaper repro instrument.

#### Diagnostic protocol (this is a DIAGNOSIS slice, not a fix slice — one concern per slice)

**Step 0 — lane ruling + rep discipline (the bimodality trap).** The failure is bimodal
PER SESSION. Any single-run observation is worthless; any bisect step on single runs will chase
noise. Fix the protocol constants FIRST: N=8 sessions per configuration (fresh browser process
each), classify each session {globe-blue, globe-black} × {pick-converged, pick-undefined}, and
require 8/8 agreement before labeling a revision GREEN, ≥1/8 failure = RED. Record the 2×2
contingency: **if pick-undefined occurs ONLY in globe-black sessions, this is ONE bug (globe
doesn't render → packed depth = no-surface sentinel → pickPosition undefined) and the black
interior is the real target; if pick-undefined occurs in globe-blue sessions too, there are TWO
bugs — split the item immediately** (Principle: one concern per slice). Simultaneously make the
lane ruling explicit for the orchestrator: the supported repro is proposed to be
`PROBE_BASE=http://localhost:8080` against the standard `node server.js` + `Build/CesiumUnminified`
(the lane every gate run actually uses); the 8134 default in the probe should be re-pointed in the
same batch that closes this item (do not change it during diagnosis — historical comparability).

**Step 1 — build the repro-classifier probe (new): `probe-pickposition-bimodal-classifier.mjs`.**
Wraps the existing probe body in the N-session loop; per session records: center avgRGB, globe
draw-command count for `Pass.GLOBE` in the (single) frustum (`frustumCommandsList[0].indices`),
`numFrustums`, `tilesLoadedAt`, `_updateCount` progression, `_lastDepthValue` per frame,
`sceneColorResolveOpens` (C10-03 counter), and `CesiumDebug.snapshot()` extracts. Bounded loops
only (memory rule: pre-run loop scan; background Edge probes have crashed this machine before —
keep headless, keep session count fixed). This probe is the item's permanent regression gate and
SURVIVES the eventual fix.
**Priority hypothesis to kill first (cheap):** in black sessions, is `Pass.GLOBE` command count 0
(selection/upload problem — tiles selected but commands never compiled) or >0 (commands issued but
produce no fragments — pipeline/pass/attachment problem)? This single bit halves the search space.

**Step 2 — differential instrumentation on ONE black session vs ONE blue session.** Compare:
`CesiumDebug.pipelineStatus()` (async pipelines still compiling? — ties to
`NEW-WEBGPU-ASYNC-PICK-PIPELINE-READINESS-CONTRACT`'s cold-compile class), `CesiumDebug.postProcess()`
(is the scene→canvas blit sourcing the right target?), `CesiumDebug.canvasPixels()`,
`globeBindGroups()` stats, and the C10-03 kill switch A/B (`_sceneColorResolveElisionEnabled=false`
→ does bimodality persist? C10-03's observation says yes — re-confirm on the current tree).
Because the state is deterministic WITHIN a session, one good black-session capture is fully
inspectable — get one and read everything.

**Step 3 — bisect ONLY after Steps 1–2 bound the mechanism.** Bisect axes in preference order:
(a) git bisect over `main` using the classifier probe's 8-session verdict as the test (expensive:
~10 min/revision × ~10 revisions — budget a day; use `git bisect run` with the probe exiting
non-zero on RED); last-known-green candidates: the probe was green ("dH 4.1 m") in the Batch-274-era
standing-gate list (`WEBGPU_DEBUGGING_LOG.md:12841`) — but note that green may have been the 8134
dedicated lane; the earliest ledgered :8080 FAIL is 2026-07-16 (C9-07 attribution). If the 8134
lane still passes at HEAD, the "regression" is (at least partly) a LANE property — test that
before bisecting at all (start `node server.js` however the 8134 lane was started; check
`Tools/visual-regression/README.md` + git history of the probe for the lane setup).
(b) If git bisect is impractical (bimodality noise), bisect the CONFIG space instead:
`offline=true/false`, `requestRenderMode`, HDR on/off, msaa 1/4, imagery provider — a config-keyed
failure is faster to localize than a revision-keyed one.

**Step 4 — hand off.** Output of this slice is a pinned root cause + a named fix item (which the
orchestrator schedules; do not fix-in-place unless the fix is S-effort and fully in-scope), the
classifier probe landed as a standing gate, and the lane ruling recorded in the ledger +
`DEBUGGING_GUIDE.md` (keep the guide in sync — CLAUDE.md).

#### Traps

1. **Bimodality defeats naive bisect** — 8-session discipline or the bisect converges on noise.
   A "green" bisect step on 1 run has ~50% false-negative rate if the black mode is ~50/50.
2. **Do not trust the 2026-07-14 multifrustum-overwrite root cause** — B693 made defaults
   1-frustum and the OFF-oracle proved the failure is frustum-fix-independent. Verify
   `numFrustums===1` in the probe output before reasoning about frustum interactions at all.
3. **The probe's cold-cache contract**: frame-0 undefined is EXPECTED (async readback arming);
   the failure is non-convergence by frame 3+. Don't "fix" the cold frame.
4. **`cachedDepth=0` ≠ uninitialized** — `_lastDepthValue` inits to `undefined`; 0 is the
   completed-readback no-surface sentinel (verified `WebGPUGlobeDepth.ts:63-123`). Any theory
   claiming "readback never runs" must explain the 0.
5. **requestRenderMode / idle-soak rules**: the probe drives `scene.render()` explicitly and sets
   `requestRenderMode=false` — keep it that way; never diagnose via idle FPS (charter).
6. **Concurrent C10 workers are editing renderer files** — diagnose against a pinned commit
   (worktree at `5b98ab9698` or later landed batch), never against the shared dirty tree.
7. **Don't widen into the black-globe FIX inside the diagnosis slice** if Step 1 proves one bug —
   surface the fix as its own named item (Principle 9); the diagnosis slice's deliverable is truth,
   not code.
8. **Machine safety:** headless Edge + WebGPU probes have historically spiked this machine
   (2026-07-06 crash note in memory) — keep N-session loops sequential, never parallel browsers.

#### Verification recipe

| # | Check | PASS means |
| --- | --- | --- |
| 1 | `probe-pickposition-bimodal-classifier.mjs` (new) at pinned HEAD | reproduces the red with recorded session statistics (baseline before any fix) |
| 2 | 2×2 contingency recorded | one-bug vs two-bug question answered with data |
| 3 | Lane ruling | :8080-vs-:8134 behavior difference measured and ledgered |
| 4 | After the (separately scheduled) fix | classifier 8/8 sessions globe-blue + pick-converged on WebGPU; WebGL unchanged; `probe-pickposition-webgpu` PASS on the supported lane; `probe-demand-canvas-pass` case-1 center PASS; PNGs read |
| 5 | OFF oracle for the fix | fix reverted → red returns (proves causality, not coincidence) |

**Model tier: fable** (ambiguous, bimodal, bisect-heavy — exactly the fable profile). Effort:
M–L for diagnosis alone. **Do not assign opus/sol to the diagnosis.** The follow-on fix tier is
decided by what the diagnosis finds.

---

### A2. NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (P0, XL) — **C10-11 OWNS THIS. Intake-conditional only.**

**Do not author a C11 brief for this item while C10 is live.** Full analysis:
`DEFERRED_WORK.md:5241` (read in full — verified present at HEAD); execution design: C10 guide H6
(`CAMPAIGN10_EXECUTION_GUIDE_2026-07-16.md:3601` — cohort A/B split, INV-2 all-or-nothing on the
shared pick FBO, kill switch `_logDepthWriteEnabled`, compute-instance as the already-converted
reference pattern, fleet = ~14 entries). Verified at HEAD: `WebGPUSceneRendererPickPass.ts:69`
`const PICK_DEPTH_PLANE_ENABLED = false;` + :496 gate — i.e. C10-11/12 had NOT landed at
`5b98ab9698`. The two 2026-07-16 oracle runs proved: (1) a log depth plane over-occludes every
hyperbolic pick (~0.999+) globally; (2) consistent hyperbolic can never discriminate at 5,000 km
(Δz ≈ 1.7e-8 < f32 ULP 6e-8). Whole-fleet-or-nothing.

**C11 disposition:** apply §0's decision table. If C10 closes it → verification-only row (re-run
H6's per-family probe list + `probe-collections-far-camera` + `probe-logdepth-globe`). If C10
ends WITHOUT landing it (blocked/reverted) → C11 inherits the H6 guide as-is (opus-or-sol
execution, fable audit per C10-00's own recommendation, XL, one commit for the whole fleet) and
MUST first read the C10 ledger row for why it stopped, plus the C10-13 reversed-Z GO/NO-GO record
(the two streams pull the same 71-file surface in opposite directions — landing log-depth pick
conversion after a reversed-Z GO is recorded would be wasted/contradictory work).
**Premise status: VERIFIED at HEAD (gate still false; DW entry live).**

---

### A3. NEW-WEBGPU-BUFFER-PRIMITIVE-PICK-DISPATCH-PARITY (P0, M) — C10 W4 rider; pick up what W4 leaves

#### What + why

C9Q §3.2 L123 (verified quote): WebGPU `scene.pickAsync` over BufferPoint/BufferPolyline/
BufferPolygon (`allowPicking: true`) returns `undefined` in EVERY mode including settled SDR 3D,
while WebGL returns the user `pickObject`. Reproduced on the pre-B672 tree — independent of the
HDR pick-format closure; formats are now consistent and the pick pass raises ZERO validation
errors, "so the pick draw never lands or never covers the pixel". Second gap in the same fix:
WebGPU builds its own `{collection, index, primitive}` pick object and ignores
`BufferPrimitiveCollection._pickObjects[index]` (`options.pickObject`).

#### Architecture today (verified at HEAD)

- `packages/engine/Source/Scene/BufferPrimitiveCollection.js` — `_pickObjects` array real and
  populated: init :156, cleared :348, WebGL consumption :571 (`this._pickObjects[i] || {…}`),
  write :651 (`this._pickObjects[index] = options.pickObject`). The WebGL fallback consumes it;
  the WebGPU renderers (`WebGPUBufferPointRenderer.ts` / `WebGPUBufferPolylineRenderer.ts` /
  `WebGPUBufferPolygonRenderer.ts` / `WebGPUBufferPrimitiveRenderer.ts`, all present at HEAD)
  do not — parity gap 2 confirmed structurally.
- Repro instrument: `Tools/visual-regression/probe-hdr-pick-format-closure.mjs` (verified
  present) — its buffer families are recorded as pre-existing FAILs with a WebGL-vs-WebGPU
  one-liner in the header.

#### Implementation walkthrough

0. **Intake:** did C10 W4 land this? (§0). If yes → verify probe families green, close.
1. **Premise re-verify:** run the hdr-pick-closure probe's buffer families at your tree; confirm
   `pickedDefined:false` on WebGPU / true on WebGL, zero validation errors.
2. **Diagnose "never lands vs never covers":** with zero validation errors the candidate causes
   are (a) pick command never enqueued (FR pick path gated off / pickCommands empty — compare the
   polyline-appearance case A10 where `pickCommands.length = 0` is deliberate), (b) pick pipeline
   resolves async and the draw is skipped cold (readiness class — overlaps A4; distinguish by
   warm retry: A4's signature is cold-fail/warm-pass, this item is fail-always), (c) draw lands
   but geometry misses the pixel (viewport/mirror class — compare A5's canvas-Y mirror and A10's
   pick-viewport root cause; buffer primitives are screen-covering triangles/lines, so a
   viewport-scale bug shows as systematic offset — probe a 3×3 grid of query pixels around the
   primitive to distinguish miss from absence). Instrument: pick-pass command count for the buffer
   FR + a one-shot pick-FBO readback dump (`WebGPUPickFramebuffer.ts` has center-readback
   machinery, :769 verified).
3. **Fix both gaps in one slice** (they are the same fix surface): dispatch the pick draw
   correctly AND thread `collection._pickObjects[index]` into the returned pick object (WebGL
   parity shape: the user object wins over the synthesized `{collection, index, primitive}`).
4. **Do not touch** the shared `buildPickPipelineDescriptor` authority (B672 contract: pickFormat
   REQUIRED) — any change there re-opens the HDR closure certification.

#### Verification recipe

`probe-hdr-pick-format-closure.mjs` all phases: buffer families flip to exact-owner green in
SDR/ms1, SDR/ms4, HDR/ms4, resize, HDR/ms1, SDR-restore (the probe already runs this matrix);
WebGL leg unchanged; returned owner is IDENTICAL (===) to the registered `pickObject`; zero
validation errors; `probe-point-pick-webgpu` + `probe-collections-regression` green (adjacent
collections untouched); on/off oracle: revert → undefined returns. Spec: add a focused
BufferPrimitive pickAsync spec if the Karma real-scene lane is runnable (note the C9 broad-suite
row's honest record: headless-Edge real-scene suites die early in some sandboxes — probe evidence
is the primary oracle).

**Traps:** (1) `pickAsync` cold-compile false-undefined (A4) can mask a REAL fix — always warm
retry before declaring red/green; (2) don't conflate with A5's Y-mirror — buffer primitives have
their own convention; (3) HDR closure certification (B672) is a regression surface — rerun its
full probe, not just the buffer rows. **Model tier: fable for step 2 if the 3-way diagnosis is
ambiguous after one instrumented run; otherwise opus.** Effort M.

---

### A4. NEW-WEBGPU-ASYNC-PICK-PIPELINE-READINESS-CONTRACT (P0, M) — C10 W4 rider

#### What + why

C9Q §3.2 L126 + item 74 (verified quotes): the physical Edge matrix (C9-02A) proved the first
public `pickAsync` can return a false `undefined` while an async pick pipeline is still compiling
— reproduced on cold SDR, HDR generation change, and invalidation; warmed retries return the
exact point. Contract to define: generation-tagged awaitable readiness OR bounded replay/
cancellation that (item 74 acceptance, verbatim constraints) preserves latest-wins hover, never
blocks normal rendering, creates NO never-picked resources, and returns exact owner/undefined
semantics across cold start, format change, eviction, recovery. Blocks final C9-02A acceptance.

#### Architecture today (verified at HEAD)

- `Scene.js:4387` `async pickAsync(windowPosition, width, height)` — public entry (verified).
- Central pipeline cache already has the needed primitive: `WebGPURenderPipelineCache`
  `pendingPipelines` map + `NEW-WEBGPU-PIPELINE-READY-SIGNAL` monitor (`monitor.begin` fanout,
  verified ~:352-380) — a readiness subscription mechanism EXISTS; the pick executor just doesn't
  consume it.
- Collection pick pipelines resolve through per-collection caches
  (`cache.pickPipelineEntries`, e.g. `WebGPUBillboardRenderer.js:1429`) + `tryResolveBillboardPipeline`
  — the "resolve returned null → skip draw → undefined result" shape.

#### Implementation walkthrough

0. Intake per §0 (W4 rider). Also: if FAR-107 (A8) has landed a query contract by execution time,
   implement readiness AS FAR-107 semantics (`PickResult` pending/cancellation), not as a
   parallel ad-hoc mechanism — sequencing note for the orchestrator.
1. Premise re-verify: cold-SDR first `pickAsync` over any collection returns undefined; second
   returns owner. (The depth-plane pick-matrix probe `probe-depth-plane-pick-matrix.mjs` exists —
   its artifact documented the cold path.)
2. Design decision (write it down BEFORE code): awaitable readiness (query waits, bounded, on the
   pending pipeline promise generation-tagged to the pick identity) vs bounded replay (executor
   re-runs the mini-frame when the pipeline lands, superseded by newer hover queries). H6's
   pattern + item-74 wording lean awaitable-readiness with a generation tag: on generation change
   mid-wait, resolve honest-undefined-with-reason or re-issue once — NEVER silently return a
   stale-generation hit (FAR-107's "delete stale substitution" clause binds).
3. The contract must be per-FAMILY (object pick, position, metadata, voxel) even if only object
   pick is implemented now — leave the others as documented unsupported states, not silent
   undefineds (no-shortcuts memory rule).
4. Keep the cold result DISTINCT from warmed depth-plane certification (L126's explicit caveat).

**Traps:** (1) do not create eager pick resources on never-picked frames — the whole C9 economics
work forbids it (item 74's "no never-picked resources"); (2) do not block the render loop awaiting
compilation (hover storms); (3) latest-wins hover means an awaited older query must be
supersede-cancellable, or a slow compile turns hover into a queue; (4) device-loss during the
await (C9-04 owns physical loss — your generation tag must make the await resolve honestly, not
hang); (5) interaction with A3: land A3 first or its "fail-always" signature becomes untestable
behind readiness retries. **Verification:** new `probe-async-pick-readiness.mjs` — cold-start
first-query-returns-owner (the fix's headline), HDR flip mid-hover, invalidation replay, hover
latest-wins under forced-slow compile (deterministic invalidation hook exists per C9-02A row),
zero new resources on a no-pick route (API-counter lane). **Model tier: opus-or-sol** (contract
is well-specified by item 74; the risk is design discipline, not ambiguity). Effort M.

---

### A5. NEW-WEBGPU-COMPUTE-INSTANCE-PICK-INDEX-MIRROR (P0, S–M, fable)

#### What + why

C9Q §3.2 L125 (verified): standing gate `probe-compute-instance-pick.mjs` FAILS at the current
tree: instance 0 ↔ instance 2 vertically SWAPPED (middle correct, zero errors) — the canvas-Y
mirror convention between the probe's expectation and
`computePickingDrawingBufferRectangle`/readback drifted. PRE-existing (byte-identical with B672
stashed; none of those changes touch ComputeInstance or readback). Needs bisect vs the probe's
last green run.

#### Architecture today (verified at HEAD)

- `Tools/visual-regression/probe-compute-instance-pick.mjs` — present; historically documented
  the "WebGPU pick-Y mirror" convention (Batch 286 notes, `WEBGPU_DEBUGGING_LOG.md:12894-12896`:
  the mirror is applied per-backend IN THE PROBE, and a 12-pick settle diagnostic once proved
  engine picks 0→0,1→1,2→2 WITH the mirror — that was the green state).
- `Scene/Picking.js:1463` `computePickingDrawingBufferRectangle` (verified) — the rectangle
  producer both backends share; `WebGPUPickFramebuffer.ts` readback consumes it (:769 comment).
- ComputeInstance is ALSO the fleet's only log-depth-converted pick producer (H6 correction) —
  if C10-11 lands between now and execution, re-run this probe FIRST; the fleet conversion
  touches its shader's siblings.

#### Implementation walkthrough

0. Premise re-verify at your tree (2 runs — this probe has settle-phase nondeterminism history,
   see Batch-286's false-alarm note: first-read staleness at a new pixel is EXPECTED; the bug is
   the SETTLED swap).
1. **Determine which side drifted** — this is the whole item. Three-way truth check: (a) the
   probe's expectation (mirror applied in-probe), (b) `computePickingDrawingBufferRectangle`'s Y
   convention, (c) the WebGPU readback's row order. Use ground truth that cannot lie: place
   instance 0 at a KNOWN screen position (project it CPU-side), `scene.pickAsync` at exactly that
   pixel, and dump the pick-FBO center readback. If engine returns instance 2 there → engine
   regression (bisect the engine); if engine returns 0 and only the probe misdecodes → probe drift
   (fix the probe, but then find WHICH batch changed the convention and check ALL other consumers
   of the rectangle for the same drift — billboard/point/polyline pick probes pass, so a global Y
   flip is unlikely; something compute-instance-specific moved).
2. Bisect: probe was green in the Batch-286-era standing-gate lists (log :12896) and in later
   lists (:12882). `git bisect` with the probe as test between the newest ledgered green and HEAD
   — this probe is deterministic-per-tree (no bimodality recorded), so single-run bisect is
   acceptable with a 2-run confirm at the flip point.
3. Fix on the side that drifted; the OTHER side's convention is the contract — document it in the
   probe header AND `DEBUGGING_GUIDE.md`.

**Traps:** (1) middle-instance-correct proves it's a MIRROR (axis flip about center), not an
index-order bug — resist off-by-one theories; (2) the settle-phase staleness false alarm
(Batch 286) — always settle before reading; (3) if C10-11 landed, its cohort-A shader edits are
adjacent — OFF-oracle vs the pre-C10-11 commit before blaming the fleet conversion.
**Verification:** probe PASS ×3 consecutive runs both backends; `probe-compute-instance-pickposition.mjs`
(exists per log) PASS (0.00 m deltas were the green baseline); pick-FBO dump matches CPU
projection at 3 instars. **Model tier: fable** (bisect + convention archaeology). Effort S–M.

---

### A6. NEW-COLLECTION-PICK-2DCV-PIPELINE-KEY-PARITY (P1, M) — C10 W4 rider

#### What + why

C9Q §3.2 L127 + item 75 (verified): Billboard COLOR pipeline entries include the 2D/CV no-depth
bit while PICK lookup uses defines alone; PointPrimitive and Polyline build hard-coded
depth-tested pick variants despite no-depth color variants. Repair 3D/2D/CV/morph pick cache
identity + depth behavior; prove visible/coplanar/elevated hit/miss and depth occlusion per mode
without changing settled 3D output or adding non-pick work.

#### Architecture today (VERIFIED at HEAD — premise CONFIRMED structurally)

- `WebGPUCollectionRendererBase.ts:208-213` (verified): `NO_DEPTH_TEST_PIPELINE_KEY_BIT = 0x80000000`
  (bit 31, "above every ShaderDefine bit") + `pipelineKeyWithDepthFlag(defines, noDepthTest)`;
  `computeNoDepthTest(frameState)` = `morphTime === 0 && mode !== SCENE3D` — the single source of
  truth.
- `WebGPUBillboardRenderer.js` (verified): COLOR path keys
  `pipelineKeyWithDepthFlag(defines, noDepthTest)` (:1024) and the descriptor NAME carries
  `/noDepth` (:440); the PICK path keys `cache.pickPipelineEntries.get(pickDefines)` (:1429) —
  **defines alone, no depth flag. Confirmed live gap.**
- `WebGPUPointPrimitiveRenderer.js:1031` colors key with the flag; pick pipelines at
  `cache.pickPipelines` (:1023, :1339) — worker must verify the pick descriptor's
  `depthStencil.depthCompare` is the hard-coded depth-tested variant claimed by the audit (the
  audit says yes for Point + Polyline).
- Cross-item interaction (register note): C9-10's P0 prerequisite says the collection key is
  32/32 bits FULL — **bit 31 is the last one and it's taken by noDepthTest.** If the eventual
  C9-10 MRT-topology key-widening lands first, the key may become non-bitmask (tuple/string) —
  coordinate; do not invent a second ad-hoc widening here. This fix needs NO new bit (it reuses
  bit 31 on the pick key), so it is safe to land BEFORE any widening.

#### Implementation walkthrough

1. Probe FIRST (`probe-collection-pick-2dcv.mjs`, new): billboard + point + polyline in
   3D / 2D / CV / mid-morph; per mode assert (a) pick hit on the visible sprite, (b) pick MISS
   where a nearer opaque occludes it in 3D (depth-tested), (c) pick HIT for coplanar/decluttered
   content in 2D/CV where color uses no-depth (today's expected FAILs — record the exact per-mode
   baseline; some 2D cases may accidentally pass when depth writes happen to be equal — record,
   don't assume).
2. Fix = key parity: pick entry key becomes `pipelineKeyWithDepthFlag(pickDefines, noDepthTest)`
   and the pick pipeline DESCRIPTOR mirrors the color variant's depth state (billboard), and
   Point/Polyline pick builders take `noDepthTest` instead of hard-coding depth-on. The
   central-cache name must also stay distinct per variant (mirror the `/noDepth` name suffix on
   pick descriptors — the central cache keys name+structural fields; depthCompare via variant is
   NOT passed on these paths, so the NAME is load-bearing — same lesson as the standing-red
   BUG-GLOBE-PIPELINE-NAME-AXES, §B9).
3. Settled-3D byte-identity gate: in 3D `noDepthTest=false` → key and descriptor byte-identical
   to today — zero 3D churn by construction. Assert it (pipeline-cache stats: no new 3D misses).

**Traps:** (1) morph is not 2D — `computeNoDepthTest` is false during morph (`morphTime===0`
required); test mid-morph explicitly, expect depth-tested; (2) `probe-collections-2dcv-morph.mjs`
(exists, ledgered green historically) is the color-side regression canary — keep it green; (3)
label glyphs route through the billboard pick path (B672 note) — include a label in the probe.
**Verification:** new probe per-mode matrix green both backends; `probe-collections-regression` +
`probe-collections-2dcv-morph` + `probe-billboard-pick` green; on/off oracle (revert → 2D/CV pick
depth wrong again). **Model tier: opus-or-sol** (premise verified here; execution well-bounded).
Effort M.

---

### A7. C9-02A-WEBGPU-PICK-DEPTH-PLANE-PIPELINE-PARITY (P1, M) — closure rider, mostly owned elsewhere

C9Q §3.2 L120 (verified, full row read): the depth-plane-specific architecture already PASSES the
physical Edge matrix (shared shader/layout/geometry, cached scene-MRT/MSAA + single-target/
sample-1 pick pipelines, SDR/HDR, MSAA1/4, resize, deterministic invalidation; artifact
`campaign9-c9-02a-depth-plane-pick-matrix-2026-07-16.json`; per-phase frustum/offset reservations
exact). It is PAUSED, not incomplete: the matrix exposed two systemic findings now owned by
`NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE` (landed B672, residue ledgered) and A4 (readiness). Physical
device loss is C9-04's. **C11 disposition: this is a CLOSURE row, not a work row** — when A4
lands (and C10-12 flips the gate, if C10 delivered), re-run `probe-depth-plane-pick-matrix.mjs`
(exists, verified) + the horizon oracle and mark COMPLETE in whatever ledger C11 uses; if A4
slips, this row stays paused — do NOT re-implement any of the passed architecture.
**Model tier: opus** (mechanical re-verification + ledger). Effort S–M. PREMISE VERIFIED (probe +
artifact + ledger row all present).

---

### A8. FAR-107-PICKQUERY-CONTRACT (P1, M) — contract-approval slice

**What/why (verified):** C9Q §5 item 12: approve immutable query/result, generation,
cancellation, output demand, honest sync/async semantics for EVERY pick family; NO executor
authority change in this slice. Full contract definition verified at
`FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md:455-465`: `PickQuery` (source window-pos/ray,
mode hover|precise|drill, width/limit/exclusions, requested output channels, exact
context/device/scene/view/camera/resource generations), `PickResult`, cancellation/supersession,
"a WebGPU synchronous call may return only an already-complete result whose entire
query/generation identity matches; otherwise a documented, feature-detectable unsupported state.
Delete stale prior-frame/location/property/pass substitution." Audit-confirmed defects it must
answer are enumerated there (one depth lifetime across frustums, ray helpers reading sync cache
pre-submit, shared staging buffer reuse, ALL `PickDepth` objects observing one overwritten packed
texture, full-viewport readbacks, eager pick-ID realization).

**Walkthrough:** this is a WRITTEN-ARTIFACT slice (types + doc + acceptance oracle skeleton), not
a migration: (1) author the TS types (backend-neutral, no `any` — charter) + the semantics doc;
(2) enumerate every current public pick API and classify against the contract (sync WebGL
unchanged — hard invariant); (3) define the acceptance matrix verbatim from FAR-107's acceptance
paragraph (cold first query, repeat, moved cursor, changed metadata at same coordinate, scene
mutation, resize, request-render pause, multi-frustum, concurrent/cancelled/superseded, destroyed
context, device-generation change); (4) obtain maintainer approval — FAR-107 says "public-API
review required" → **STOP-AND-CONFIRM with the maintainer before landing the public types.**
**Traps:** (1) scope discipline — no executor changes, however tempting (A9 consumes this
contract next); (2) do not weaken WebGL sync behavior in the types ("Preserve exact WebGL
synchronous behavior"); (3) A4's readiness design must be expressible in these types — write A4's
scenario into the contract's examples so they can't diverge. **Verification:** `npx tsc --noEmit`;
contract doc cross-referenced from DEFERRED_WORK + FEATURE_INVENTORY; the acceptance-matrix
skeleton committed as a spec file (pending implementation) — tests/counters outlive the slice.
**Model tier: opus-or-sol** (well-specified authoring; sol-class judgment useful for API taste).
Effort M. **Sequencing: before A9 (hard dep), ideally before A4 lands its mechanism.**

---

### A9. NEW-PICK-WEBGPU-MULTIFRUSTUM-PACKED-DEPTH / FAR-408-C0 (P1, L) — perf + the old convergence suspect

**What/why (verified):** C9Q §5 item 13: capture requested pick pixels at each exact
natural-frustum depth-version boundary on the MAIN encoder; generation-tagged batch resolves
near-to-far; NO private submit, NO no-query work. Deps: items 12 (FAR-107) + 12A (FAR-200-S1
serial authority). Merged PR rows S4-5 + S7-4: the globe-depth RGBA8 pack chain runs up to
3×/frustum (up to 9 fullscreen packs + 18 boundary crossings/frame vs WebGL's 1–2 copies) —
demand-drive via monotone depth-VERSION tracking, coalesce to 1 pack/frustum. **Correctness trap
recorded in the register verbatim: naive zero-command gating changes pick semantics — S7-4
depth-version tracking is REQUIRED before gating the DP-H45 re-pack** (a frustum with zero globe
commands still has a defined depth state that pickPosition may legitimately read).

**Architecture today (verified):** `WebGPUGlobeDepth.ts` packed-RGBA8-depth-as-color machinery
(:30/:63-123 no-surface sentinel/:159/:314); `PickDepth.js` one-frame-stale sync cache
(:108-:308); post-B693 the DEFAULT frame is 1 frustum — the headline waste (9 packs) was a
2-frustum figure; **re-measure at your tree before sizing the win** (C10-01 + C10-03 already
deleted much of the boundary traffic this row was priced on; S7-2's remainder row also overlaps).
The FAILING probe of A1 reads exactly this chain — **do not open A9 while A1 is undiagnosed**:
changing pack economics under an undiagnosed bimodal red both destroys the repro and invites
blaming/crediting the wrong change.

**Walkthrough (when opened):** (0) A1 diagnosed + FAR-107 + FAR-200-S1 landed — three hard gates;
(1) instrument current pack count/frame + boundary crossings (API-instrumented lane, labeled);
(2) introduce monotone depth-version per (frustum, depth-producing pass) bumped on any
depth-writing segment close; pack ONLY on version change AND registered pick demand
(C9-09 attachment-demand registry is the demand-record precedent, verified landed B681);
(3) capture requested pixels at natural boundaries on the main encoder (no private submit —
FAR-200 family rule); (4) `PickDepth` consumers key on (frustum, version) — this is the durable
fix for the 13305-class overwrite; (5) moving-altitude-only perf evidence, promotion rule ≥5%
named-stage or >3× noise; the structural claim (packs/frame ↓) is the landing bar.
**Verification:** `probe-pickposition-webgpu` + A1 classifier stay green (the load-bearing gate);
`probe-depth-plane-horizon-oracle` unchanged; pack-count counter on/off/restored;
`capture-and-diff` full battery; multi-frustum forced view (custom near/far or 2D) exercises >1
frustum explicitly since defaults no longer do. **Model tier: opus-or-sol** with fable audit
(depth-semantics risk). Effort L. PREMISE PARTIALLY RE-SCOPED at HEAD (1-frustum default shrinks
the prize; the correctness half — per-version depth identity — is undiminished).

---

### A10. NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU — pick remainder (P1, M)

**What/why (verified):** DW ~4830 (read in full): COLOR + MATERIAL + 2D/CV/morph + log-depth +
Image-material slices all SHIPPED (Batches 343/344/381/382/383); **deferred (a) = picking: both
slices clear `pickCommands`.** Register: pick attempted + REVERTED in Batch 380, root cause
PINNED — "screen-space ribbon expansion uses main-canvas viewport under the narrow pick frustum —
thread pick-FBO viewport dims into `writeRTEUniformsPolyline` (or full-canvas pick frustum)".

**Architecture today (verified at HEAD):**
- `WebGPUPrimitiveCommands.ts` — `writeRTEUniformsPolyline` (:1271; call sites :1594/:2099/:2601)
  writes projection/viewport/modelViewRTE EVERY frame for polyline appearance commands; both
  appearance builders still clear pick: ":2148 `pickCommands.length = 0`" and ":2674" with
  explicit comments "Pick is not wired in this slice (color-only)" (:1830/:2306).
- Batch-380 commit `7814a1c832` ("polyline appearance pick — attempted, reverted, root cause
  pinned") — the recoverable pick VS/FS + wiring diff. `git show 7814a1c832` is the starting
  material.
- RED gate probe committed and verified present: `Tools/visual-regression/probe-polyline-appearance-pick.mjs`
  (header documents intent; asserts `scene.pick` returns the Primitive on both backends; WebGL is
  the sanity reference). It currently FAILS on WebGPU by construction.

**Walkthrough:** (1) re-run the probe — confirm RED on WebGPU, GREEN on WebGL (premise); (2)
recover the B380 diff; the fix beyond B380 is the pinned root cause: the pick mini-frame renders
into the pick FBO with a NARROW pick frustum, but the ribbon expansion divides by viewport dims —
thread the PICK-pass viewport (pick-FBO dims) into `writeRTEUniformsPolyline` when writing UBOs
for pick commands (or adopt the alternative the register allows: full-canvas pick frustum for
this family — choose the one that matches how billboard/point pick handles the narrow-frustum
convention, for fleet consistency; inspect `computePickingDrawingBufferRectangle` usage in the
collection picks first); (3) pick UBO writes must NOT disturb the per-frame color UB (the
`_isPolylineAppearance` shared write-path — give pick its own UB slot or write-after-color); (4)
2D/CV: the shipped 376b modes must pick too — extend the probe with a 2D leg (cheap).
**Traps:** (1) C10-11 interplay — if the fleet log-depth conversion landed, the recovered B380
pick shaders must write log frag_depth like every other family (add the cohort-B pattern from H6)
— check BEFORE resurrecting the old hyperbolic pick FS; (2) `pickCommands` array identity is
consumed by `WebGPUPrimitiveCommands` valid-command compaction (:3841-3843) — populate, don't
replace; (3) do not touch the material/color slices' verified probes (`probe-polyline-appearance-primitive`,
`probe-polyline-material-primitive` — ratio-1.000 baselines). **Verification:**
probe-polyline-appearance-pick GREEN both backends ×2 runs; the two color/material probes
unchanged; `probe-hdr-pick-format-closure` polyline family unchanged; on/off oracle.
**Model tier: opus-or-sol** (root cause pinned, recoverable diff, RED gate ready — the ideal
well-specified execution). Effort M.

---

### A11. BACKLOG-§4 Picking 6.1 — main-scene depth blit (P2, M) — dossier paragraph

FI §C.5 row (verified present): main-scene depth-blit shader for picking still pending — the
globe half is done; `pickPosition` depth over NON-globe content (models/tiles/primitives) lacks
the blit path the globe has. **PREMISE-UNVERIFIED at behavioral level:** the fork has since
grown per-family alternatives (model pickPosition converges via its own path per
`WEBGPU_DEBUGGING_LOG.md` Batch-286 notes; compute-instance has object-pick position). A worker
must FIRST probe what `scene.pickPosition` returns today over (a) a glTF model off-globe, (b) a
3D-tiles surface, (c) a primitive — on both backends. If WebGPU already matches WebGL via those
per-family paths, this row is CLOSED-BY-EVOLUTION; if a gap remains (most likely: generic
primitives + tiles), scope the blit as a consumer of the post-C10-11 pick depth encoding (log)
and behind FAR-107 semantics. Do not build a pre-C10-11 hyperbolic blit. **Model tier: opus**
(verify-first, bounded). Effort M if real.

---

## PART B — `standing-reds` cluster (15 items)

---

### B1. NEW-HIGH-DENSITY-SPHERES-CROSS-BACKEND-DRIFT (P0, unknown–M, fable)

#### What + why (evidence trail)

C9Q §3.2 L135 (verified): `capture-and-diff.mjs` scene `high-density-5k-spheres` FAILS
cross-backend 8.69% (threshold 2%) AND ~92% vs historical baselines on BOTH backends. Attributed
PRE-existing during C9-07 (byte-identical stashed: 8.69%/92.61%/91.70%). Other 6 scenes pass at
0.45–1.04%. Re-confirmed 8.62% at C9-30 close-out AND at C10-01's gate (B693). C10Q §4 line 188
adds the decisive fact: **the stored baselines are DEGENERATE (fully black), and `--update`
promotion was auto-blocked 2026-07-18 because the backends disagree — repair the drift FIRST,
then recapture.** Gates C10-30.

#### Architecture today (verified at HEAD)

- `Tools/visual-regression/scenes.json:55-70`: scene = Batch 224 procedural 5K-sphere instance
  scene, `setupFile: scenes/high-density-5k-spheres-setup.js` (present), camera SF at 300 km,
  pitch −0.7. Description (verbatim, load-bearing): "crosses the gpuCuller activation threshold
  (HI=384) and HiZ threshold (HI=2400) … **Uses `Scene.gpuCullingHint = 'always'` on WebGPU** so
  the eager warm-up amortizes pipeline-compile cost into the load frame."
- `Scene.js:471` `this._gpuCullingHint = "never"` default; getter/setter :2926-2932 (verified) —
  the hint still exists and `'always'` is still accepted. But the ENTIRE gpu-cull/Hi-Z/sort
  auto-path went through FAR-003 containment during C8/C9 (`highDensityCull()` debug command;
  C9-26's row records GPU visibility as unsafe-precision, "restoring auto GPU cull/Hi-Z/sort/
  indirect" is a FUTURE item) — **prime suspect: the scene's `gpuCullingHint='always'` now
  exercises a contained/half-alive path only THIS scene uses**, which would explain why exactly
  this scene diverges while 6 siblings pass.
- Baselines: `Tools/visual-regression/baseline/high-density-5k-spheres.{webgl,webgpu}.png` — both
  EXACTLY 2,404,392 bytes, dated May 13 (verified `ls -la`) — identical byte size is consistent
  with the "degenerate fully-black" record (two same-encoder black frames).

#### Diagnostic protocol

0. **Read the PNGs first** (Principle 8 step 4 in reverse): open both baselines + fresh captures
   of both backends. The ~92%-vs-history on BOTH backends + black baselines most plausibly means
   **history was black (broken capture at baseline time) and today's scenes RENDER** — i.e. the
   vs-history number carries zero signal and the ONLY real red is the live 8.62% cross-backend
   delta. Confirm visually, then ignore vs-history for the rest of the item.
1. Localize the 8.62%: run `capture-and-diff.mjs --scene high-density-5k-spheres --headed`, read
   the diff PNG. Classify: (a) missing/extra spheres (culling divergence → gpuCullingHint
   suspect), (b) color/lighting delta on all spheres (material/tonemap parity), (c) spatial
   offset (camera/jitter). Each class has a different owner.
2. A/B the suspect: edit a LOCAL copy of the setup to `gpuCullingHint='never'` on WebGPU and
   re-diff. If the delta collapses → the red is the contained GPU-cull path; per the charter
   (performance containment must not degrade features) the fix is either repairing the
   `'always'` path or — with maintainer sign-off — re-scoping the scene config, WITH a ledger
   note that the `'always'` lane lost its only gate. **Do not silently flip the scene config to
   make the gate green — that is baseline-weakening** (rule: drift repair MUST precede recapture).
3. If not culling: bisect. The scene was green when the 6-scene battery last fully passed —
   search `WEBGPU_DEBUGGING_LOG.md` for the last ledgered `high-density` PASS, bisect with the
   single-scene diff as the test (deterministic per revision — no bimodality recorded; 2-run
   confirm at the flip).
4. Only after cross-backend <2%: recapture baselines with `--update` (the auto-block lifts when
   backends agree), read the new PNGs, and note the recapture in the ledger + README.

**Traps:** (1) do NOT `--update` first — explicitly forbidden by the C10Q row; (2) the scene is
the ONLY gate coverage for threshold-crossing instance counts + `gpuCullingHint='always'` —
losing it un-gates B209-218 dispatcher parity (feature-preservation rule); (3) sphere count 5,000
spans the HI=384 and HI=2400 thresholds by design — any fix touching thresholds changes which
dispatchers arm; keep `CesiumDebug.highDensityCull()` stats in the diagnosis record; (4) TAA/
auto-exposure adaptation can drift captures — check the scene's settle discipline against the
B634 harness lessons before blaming the renderer. **Verification:** cross-backend ≤2% (band
target: the 6-scene 0.45–1.04% norm); baselines recaptured non-black; on/off oracle for whatever
fix lands; `probe-gpu-sort-consume.mjs` (exists, verified in ledger) green if the cull path was
touched. **Model tier: fable** (diagnosis + bisect + policy judgment). Effort unknown→M.

---

### B2. NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION (P0, M) — C10 W4 rider

**What/why (verified, C9Q L124):** runtime `scene.msaaSamples` flips leave scene-FB COLOR
pipelines (Voxel color — 50 occurrences on the pre-change baseline; GroundPrimitive
depthSampleColor on other runs; race is load/timing dependent and HOPS renderers) bound for 1–2
frames with stale baked `multisample.count` → "Attachment state … not compatible" + invalid
command buffer + a `GlobeDepth-DepthCopy` destroyed-texture follow-on under resize. Root cause
named: per-renderer `_scenePipelineFormatGeneration` guards rebuild ONE FRAME LATE relative to
the scene-pass swap. NOT pick-related (pick pipelines single-sample by construction).

**Architecture today (verified):** `_scenePipelineFormatGeneration` appears at **64 sites** under
`Renderer/WebGPU/` at HEAD — the guard pattern is fleet-wide; the fix must be CENTRAL (the
generation bump vs pass swap ordering), not 64 local patches. Repro: `probe-hdr-pick-format-closure.mjs`
gate log / diag variant with msaa 4→1→4→1 under multi-primitive load (probe verified present).
**Interaction with landed work:** C10-03 (B697) added `_sceneColorResolvePending` + demand
resolve on the SAME pass-open hook (`_activePassTarget`); B234 TAA forces samples→1
(`WebGPUSceneRenderer.ts:1402-1411` per C10-03 row) — a TAA toggle IS an msaa flip; test that
path too. **Walkthrough:** (1) reproduce with the diag variant; count validation errors as the
metric; (2) find the frame timeline: who recreates the scene pass (frame N) vs who bumps the
generation the renderers compare (frame N+1) — the fix shape is either bump-before-swap in the
same frame, or a scene-pass epoch stamped on the pass descriptor that renderers compare at BIND
time (reject-and-rebuild synchronously on mismatch — rule-3 conservative: never bind a
mismatched pipeline, even at the cost of a skipped draw for one frame — a one-frame missing
primitive beats an invalid command buffer, but ledger the skip honestly); (3) the GlobeDepth
destroyed-texture follow-on under resize is the SECOND assert of the probe — both must go to
zero. **Traps:** (1) renderer-hopping means any per-renderer fix just moves the race — fix the
ordering once, centrally; (2) do not serialize pipeline creation onto the render thread to "fix"
the race (TTFF regression); (3) MSAA flip × OIT ordering is B13's separate item — keep concerns
split. **Verification:** flip battery (1→4→1→4 ×3, with voxel + groundPrimitive + model loaded)
zero validation errors, zero destroyed-texture errors, canvas non-black through every flip
frame ×5 runs (race = repetition required); TAA on/off flip leg; resize-during-flip leg;
`probe-taa-jitter` + capture-and-diff unchanged. **Model tier: opus-or-sol** (root cause named;
ordering fix). Effort M.

---

### B3. NEW-VOXEL-INSIDE-CAMERA-BLACK (P0→P1 correctness, M)

**What/why (verified, DW :3456 read in full):** camera INSIDE the voxel proxy volume
(0.55R–0.9R on the diagonal of the Earth-radius box) renders BLACK on WebGPU while WebGL renders
the interior at every tested depth; just outside (1.05R) both render. Suspects (DW, verbatim):
proxy-cube rasterization with `cullMode:"front"` vs the camera-inside case (near-plane/RTE
vertex path), or scene-level culling of the WebGPU draw command — NOT the march
(`tStart = max(tr.x, 0)` handles interior origin). Repro: probe-voxel-megatexture PART-3 harness
with `setCorner` destinations scaled to 0.55R. C9 W1 item 18 acceptance: correct
proxy-face/cull/ray interval through outside/boundary/inside/center/exit while preserving color,
object/cell pick, velocity/depth, octree, megatexture, custom shaders.

**Architecture today (verified):** `WebGPUVoxelRenderer.ts` — `cullMode: "front"` on ALL voxel
pipelines (:2643/:2676/:2707/:2732 + pick variants). Front-face culling draws BACK faces —
correct for outside AND inside a closed box (back faces exist behind the camera-interior in every
direction)… **unless the back faces are near-plane-clipped or the RTE vertex path degenerates at
interior camera distances** — which is why the near-plane/RTE suspect is listed. WebGL renders
the same geometry — so the divergence is WebGPU-specific vertex/clip/cull state, not concept.

**Walkthrough:** (1) probe first: extend probe-voxel-megatexture PART-3 with the 0.55R leg (per
DW) → RED baseline; (2) trisect the suspects cheaply: (a) scene-level cull — count the voxel draw
command in the frustum bins at 0.55R (if absent: BV/cull test rejects an inside-camera view —
check the command's BV + `cull` flag); (b) rasterization — force `cullMode:"none"` in a local
build; if the interior appears, the issue is winding/clip of back faces (check the depthClamp /
near-plane: an interior camera's back faces are FAR, they should survive; but the PROXY box at
Earth radius under RTE — vertex precision at 0.55R eye distance — is the RTE suspect); (c) if
neither, dump `tStart/tEnd` via a debug output lane. (3) Fix per finding; the acceptance matrix
(item 18) demands outside/boundary/inside/center/exit continuity — sweep the camera through the
face in the probe and assert no pop/flash frame. **Traps:** (1) do not change the march's
interval math to compensate a raster bug (two wrongs); (2) preserve pick/velocity/custom-shader
variants — they share the pipeline table you're editing (all the `cullMode` sites); (3)
`depthCompare`/log-depth interplay: voxel writes log depth as a scene producer — if C10-13/GT
reversed-Z work started, coordinate. **Verification:** extended PART-3 probe green both backends
(inside AND outside legs); `pickVoxel` cell parity at an interior view (the C-R9 resolution in DW
is the reference); capture-and-diff voxel scenes unchanged; on/off oracle.
**Model tier: opus with fable escalation** if the trisect is inconclusive after one instrumented
pass. Effort M.

---

### B4. NEW-WEBGL-ANISO-GLSL-BROKEN (P1, S)

**What/why (verified, FI :801-:804):** the **WebGL** model FS fails to COMPILE for
KHR_materials_anisotropy assets — `ERROR 0:366 'normalTexCoords' undeclared` +
`'computeTangent' no matching overloaded function` — error dialog halts rendering. Pre-existing
(found Batch 210), NOT a WebGPU issue; blocks all WebGL-vs-WebGPU anisotropy pixel diffs (the
WebGPU side shipped its IBL anisotropic bent-normal in B210 and is waiting on this to certify
parity). Likely cause (FI): the anisotropy GLSL stage references a normal-texture
varying/function absent in the anisotropy-WITHOUT-normal-texture permutation.

**Architecture today (verified):** `Shaders/Model/MaterialStageFS.glsl:26`
`vec3 computeTangent(in vec3 position, in vec2 normalTexCoords)` with call sites :55/:112/:151 —
at least one call site (per FI, the anisotropy one, ~:151) uses `normalTexCoords` which is only
declared inside `HAS_NORMAL_TEXTURE`-guarded code. Fix shape: guard the anisotropy tangent path
for the no-normal-texture permutation (use the anisotropy texcoords or a defined fallback —
mirror what the WebGPU port does at `ModelPBRComplete.wgsl:1356-1392`, which documents the
byte-for-byte computeTangent port and ALREADY handles the permutation).

**Walkthrough:** (1) probe first: load `TestKhrAnisotropy.gltf` (the FI-named asset) on WebGL —
RED = error dialog + no render; capture the exact GLSL error; (2) fix the permutation in
`MaterialStageFS.glsl` (upstream-shared file — keep the diff minimal, upstream-merge-sensitive);
(3) with WebGL compiling, run the deferred WebGPU-vs-WebGL aniso pixel diff (this un-blocks
B210's parity claim — record it in FEATURE_INVENTORY: move the blocked note). **Traps:** (1)
this is upstream GLSL — check upstream CesiumGS for an existing fix first (`git log upstream/main
-- .../MaterialStageFS.glsl`, or the upstream issue tracker) — importing the upstream fix beats
inventing one (sync procedure exists); (2) permutation explosion: fix must not break
aniso+normal-texture assets (both permutations in the probe); (3) WebGL-only change — WebGPU
bytes untouched (off-gate: any WebGPU probe unchanged). **Verification:** new
`probe-model-aniso-parity.mjs` — both permutations × both backends, compile-clean + pixel diff
recorded (parity number is INFORMATIONAL first run — B210's WGSL is certified only against
itself until now); existing model probes (`probe-model-pbr-audit`) green.
**Model tier: opus.** Effort S.

---

### B5. NEW-FEATURE-RENDERER-FAILED-STATE-RETRY (P1, M)

**What/why (verified, C9Q §9 item 81):** the FR readiness state machine's `failed` state is
terminal per generation — ONE transient chunk-fetch failure permanently disables a feature for
the session. Add bounded retry and/or public `retryFeatureRenderer(key)`; prove
transient-failure recovery, permanent-failure stability, no stale-generation self-install
regression.

**Architecture today (verified at HEAD):** `GraphicsContext.ts` — `kind: "failed"` readiness
(:365), terminal check `_featureRendererStatus[key]?.kind === "failed"` (:2007, :2020), failure
install path :2063-:2068 with the comment (:2036) that load errors and dynamic-import rejection
funnel to the same stable failed state. The register's ":2010" drifted slightly (now :2007/:2020)
— symbol anchors hold.

**Walkthrough:** (1) spec-first (this is core infra — Jasmine over probes): simulate dynamic-
import rejection (injectable loader or spy), assert current terminal behavior (RED expectation);
(2) design: bounded retry with attempt cap (e.g. 3) + backoff keyed to the FR generation, PLUS
public `retryFeatureRenderer(key)` for app-driven recovery; a PERMANENT failure (module truly
absent, e.g. webgl-only variant stub Proxy throw) must stay stable after cap — do not hot-loop
import attempts every frame (that is the BUG-12 clear-loop shape — add the loop-guard sentinel
per CLAUDE.md permanent-sentinel rules); (3) the stale-generation hazard named in the acceptance:
a retry resolving AFTER a device-generation bump must not self-install into the new generation —
the existing generation tagging (:1952 "Returns undefined for unsupported, failed, or invalidated
generations") is the contract to preserve; (4) context-ID logging on every transition (charter
§3). **Traps:** (1) the webgl-only build variant deliberately aliases WebGPU modules to a
throwing Proxy — retries there must terminate at cap, not spam (variant smoke test covers); (2)
`getFeatureRenderer` is THE hot path — retry checks must be zero-cost when not failed (single
enum compare); (3) multi-context: per-context status table, no cross-context retry storms.
**Verification:** new `GraphicsContextSpec` cases (transient-recovers / permanent-stays-failed /
generation-bump-invalidates-pending-retry / retry-API); `node Tools/variant-smoke-test.mjs`
green; one probe run with network offline→online toggle if cheap (else spec-only, ledgered).
**Model tier: opus.** Effort M.

---

### B6. NEW-WEBGPU-POINT-BLENDOPTION-SYNC (P1, M)

**What/why (verified, C9Q L141 + code):** the native WebGPU PointPrimitive branch returns before
synchronizing collection `_blendOption` — even `BlendOption.OPAQUE` can emit commands labeled
`Pass.TRANSLUCENT`. Repair exact opaque/translucent/both classification, batching, order, depth,
pick, mutation, 2D/CV/morph, cross-backend parity without dropping either blend cohort.

**Architecture today (VERIFIED — premise CONFIRMED structurally at HEAD):**
`Scene/PointPrimitiveCollection.js` — FR dispatch + `return` at :501-:513 (verified block:
`fr.update(...); return;`), while `_blendOption` sync + derived render-state updates live BELOW
at :669-:690 (`blendOptionChanged` etc.) — the WebGPU path structurally never executes the sync.
The scene-logic-extractor rule (CLAUDE.md: shared scene-level logic MUST run BEFORE the branch
point) is violated here; note `syncCollectionCommandOrdering(this)` at :497 shows the
already-correct pattern for OTHER state — `_blendOption` sync just never joined it.

**Walkthrough:** (1) probe first (`probe-point-blendoption.mjs`, new): OPAQUE / TRANSLUCENT /
OPAQUE_AND_TRANSLUCENT collections on both backends; assert per-command pass classification
(inspect `frustumCommandsList[i].indices[Pass.OPAQUE/TRANSLUCENT]` deltas), draw order vs a
overlapping translucent reference, depth behavior (opaque points occlude), pick in each mode,
and a runtime blendOption MUTATION leg; (2) fix = hoist the blendOption snapshot into the shared
pre-branch packet (extend `syncCollectionCommandOrdering` or sibling), and make the WebGPU
renderer consume the synced value for command pass labeling + pipeline blend state; (3) verify
the WebGL path is byte-identical (the hoist must be a pure move for WebGL — same values computed
in the same frame). **Traps:** (1) pass-label changes interact with OIT (translucent pass
consumption) and with the B699 translucent-twin gate for tiles — points are not tiles, but run
the OIT probe anyway; (2) 2D/CV: `computeNoDepthTest` (A6's flag) intersects blend state — run
the collections-2dcv-morph probe; (3) don't drop a cohort: OPAQUE_AND_TRANSLUCENT emits TWO
command sets (WebGL :737) — WebGPU must too. **Verification:** new probe green both backends +
mutation leg; `probe-collections-regression`, `probe-point-pick-webgpu`,
`probe-collections-2dcv-morph` green; capture-and-diff unchanged; on/off oracle.
**Model tier: opus.** Effort M.

---

### B7. NEW-WEBGPU-CANVAS-BACKGROUND-COLOR-PARITY (P1, S)

**What/why (verified, DW :5298-:5304):** WebGPU context `_clearColor` is `(0,0,0,0)` from the
constructor (VERIFIED at HEAD: `WebGPUContext.ts:989`) and is never fed `scene.backgroundColor`;
the background `_clearColorCommand` targeting the default framebuffer is swallowed → an EMPTY
WebGPU scene presents transparent black while WebGL clears to `scene.backgroundColor`. C9-07
deliberately preserved these bytes (empty-scene byte-identity gate). Fix = adopt `cmd.color`
into the C9-07 deferred first-open clear — **a VISIBLE behavior change needing its own
WebGL-vs-WebGPU background probe first** (register blocker, honored here).

**Walkthrough:** (1) probe FIRST (`probe-canvas-background-color.mjs`, new): empty scene (no
globe/skybox/atmosphere) with `scene.backgroundColor = Color.CORNFLOWERBLUE` (and a second leg
with alpha<1 over a colored page background — the transparency semantics differ!) on both
backends; readback canvas pixels; RED baseline = WebGPU black/transparent vs WebGL blue; (2) fix
at the C9-07 deferred first-open clear site: the first-open clear value adopts the background
`_clearColorCommand.color` instead of constructor `(0,0,0,0)`; (3) empty-scene byte-identity
gate RETIRES BY DESIGN here — this is the sanctioned behavior change; note it explicitly in the
ledger so the C9-07 gate's history isn't misread as a regression. **Traps:** (1)
`probe-demand-canvas-pass.mjs` asserts today's bytes (24/24 both backends at C10-03) — it WILL
red; update its expectation IN THE SAME COMMIT with a comment, don't weaken it silently; (2)
alpha semantics: WebGL canvas composites `backgroundColor.alpha` against the page — decide and
TEST the WebGPU alphaMode ('premultiplied'/'opaque' surface config) rather than only rgb; (3)
post-process blit overwrites the canvas every frame — verify the background survives via the
blit path, not just the clear (usePostProcess always true on WebGPU). **Verification:** new
probe green both backends both legs; demand-canvas-pass updated + green; capture-and-diff
battery unchanged (all scenes have content covering the background — verify none regress);
on/off oracle. **Model tier: opus.** Effort S.

---

### B8. NEW-WEBGPU-OIT-DEFERRED-SPLAT-CANVAS-RESUME (P1, S)

**What/why (verified, DW :5305-:5311):** `WebGPUSceneRendererTranslucentPass.ts` resumes the
DEFAULT (canvas) pass after the OIT composite mid-frustum-loop and draws deferred Gaussian
splats inline there; the comment says "resumed scene pass" but the target is the CANVAS, and the
post-process blit later overwrites the canvas → likely invisible splats under OIT+splats.
Behavior unchanged by C9-07 (identical bytes). Needs a splats+OIT visual probe BEFORE
redirecting to `_resumeScenePass`.

**Architecture today (verified at HEAD):** the resume is now
`context.resumeDefaultRenderPass?.()` at `WebGPUSceneRendererTranslucentPass.ts:283` (DW's
"~L348" drifted; file is 314 lines) with :285-286 comment "draw them inline on the resumed scene
pass rather than dropping them" — the mislabeled canvas target. The C7-SPLAT-DEPTH-COMPOSE
never-drop seatbelt (:80-:85, `_splatOITDeferral` opt-in default OFF) bounds exposure: default
paths don't defer splats.
**HARD DEPENDENCY / PREMISE CAVEAT:** the register's own splat cluster (C10-04 block, B696)
records that the WebGPU splat FR has NO production data producer — **no real splat pixels can
render until `NEW-WEBGPU-SPLAT-DATA-PRODUCER` lands.** A visual probe today can only exercise
the pass-plumbing with a synthetic/scaffold draw. Disposition: (a) if the splat producer lands in
C11, schedule this AFTER it, with a real .spz asset + OIT on (`_webgpuOITEnabled` +
`_splatOITDeferral` armed); (b) until then this is a DOSSIER row — the fix (redirect to
`_resumeScenePass` so the composite target chain is scene-FB → post-process, matching C10-03's
`_ensureSceneColorResolved` consumer ordering) is 5 lines, but landing it UNVERIFIABLE violates
probe-first. Flag: **PREMISE-VERIFIED (code path), ORACLE-BLOCKED (no producer)**.
**Model tier: opus** when unblocked. Effort S.

---

### B9. BUG-GLOBE-PIPELINE-NAME-AXES (P1, S) — **PREMISE PARTIALLY STALE, verify-first**

**What/why:** DW :5099 (read in full, 2026-07-02): the globe descriptor NAME
(`Globe terrain (…labels)`) doesn't encode strideBytes/hasWebMercatorT, geodetic normals,
LOG_DEPTH/IMAGERY_REDUCED defines, `_sampleCount` — Bug-487-class silent race-decided
wrong-pipeline binds. Suggested fix: fold axes into the name or pass a `variant`; audit other
name-keyed central caches.

**Architecture today (VERIFIED at HEAD — the premise has SHRUNK):**
`WebGPURenderPipelineCache.generateCacheKey` (:664-:755, read in full) keys
`descriptor.name` PLUS structural descriptor fields: **`ms:` multisample count, `df:`
depth/stencil format, `tg:` per-target format/writeMask/blend, `vx:` full vertex-buffer
signature (arrayStride + stepMode + per-attribute location@offset/format)** — present since
commit `ba5a18bf47` (2026-04-25, PRE-dating the DW entry; the entry under-modeled the key).
Globe resolves through this exact path (`resolveGlobePipelineEntry` →
`getPipelineSync(entry.descriptor)` / `getPipeline(entry.descriptor)`, verified
`WebGPUGlobeSurfacePipelines.ts:586-:604`, no variant). Name template verified at :456 with
labels quant/norm/blend/debug/cd/dob/dof/tbf/nc/img/cap; `imgLabel` (:393) covers
IMAGERY_REDUCED.
**Residual live axes at HEAD (the real item):**
1. **Shader-module identity is NOT in the key** — two descriptors identical in name + structure
   but built from different modules (defines that change code, not vertex layout: LOG_DEPTH,
   and any future content-only define) alias. LOG_DEPTH is session-uniform on WebGPU today
   (master switch), so exposure is latent — but C10-13/reversed-Z or per-view log toggles would
   detonate it.
2. **`primitive.*` (cullMode/frontFace/topology) from the DESCRIPTOR is not keyed** (only via
   `variant`, which globe never passes) — Bug 487's class survives for any NEW primitive-state
   variant whose author forgets a name label. The `, noCull` label was the point fix, not the
   class fix.
3. **The fleet audit half** (other name-keyed central-cache users) was never done.
**Walkthrough:** (1) verify-first: reproduce the key for two live globe variants
(`CesiumDebug.pipelineStatus()` + a debug dump of `generateCacheKey` inputs) and CONFIRM which
axes still collide at your tree; re-scope the DW entry to the residual list (fix the doc — a
drifted DEFERRED_WORK analysis is itself a bug per the doc-sync rules); (2) fix the CLASS: add
`pm:${topology}/${cullMode}/${frontFace}` and a module-identity component (module label or a
monotonically assigned module id — the module cache key `(sourceId, defines)` is the natural
identity, thread it onto the descriptor as `moduleKey`) into `generateCacheKey` — descriptor-side,
so every renderer inherits it, no name-label discipline needed; (3) audit: grep central-cache
`getPipeline(Sync)` callers for name-only reliance; ledger findings. **Traps:** (1) key-shape
change = one-time cache-wide re-miss on first frame — harmless (same pipelines re-created) but
perf lanes will show a first-frame blip; never ship mid-measurement of another slice; (2) do NOT
remove existing name labels "because the key now covers it" — names are also devtools/debug
identity; add-only; (3) keep the key builder allocation-light (it runs per resolve; hits are
cached by key string — building the string IS the cost; measure before/after on the globe-heavy
route). **Verification:** unit spec for `generateCacheKey` axis coverage (two descriptors
differing ONLY in each axis → distinct keys — table-driven, add the axes that were missing);
capture-and-diff battery + underground-camera scene (Bug 487's symptom view) green;
`probe-globe-bindgroup-cache` / `CesiumDebug.globeBindGroups()` stats unchanged hit rates.
**Model tier: opus** (premise re-scope + mechanical fix). Effort S.

---

### B10. C-R12-PER-OBJECT-CACHES (P1, S–M) — premise verified, scope sharpened

**What/why:** FI §C.8 (:883): device-loss invalidation walk doesn't reach
`model._webgpuCache`/`clippingPlanes._webgpuCache` — stale GPU resources after device recovery.
NOTE: FI §B (:723) simultaneously claims Batch 197 CLOSED C-R12 via `clearPerObjectCaches` — the
two rows contradict; HEAD code resolves it:

**Architecture today (VERIFIED at HEAD):** `WebGPUSceneRendererEnsureResources.ts:558-:609`
(read in full): `clearPerObjectCaches(scene)` walks `scene.primitives` + `scene.groundPrimitives`
(duck-typed `{length, get(i)}` recursion) clearing each node's OWN `_webgpuCache`, plus
singletons `scene.shadowMap` + `scene.postProcessStages`. **What it does NOT reach (the live
residual):** (a) NESTED owners — `model.clippingPlanes._webgpuCache`
(`WebGPUClippingPlaneCollection.ts` attaches per-collection cache), clipping POLYGONS, per-model
IBL (`WebGPUImageBasedLighting.ts`); the walk clears the model's own slot but never descends into
non-collection children; (b) NON-primitive scene singletons that carry `_webgpuCache` at HEAD
(grep verified 40+ owner files): `StarField.js`, sky atmosphere renderer state, environment/sun/
moon (`WebGPUEnvironmentRenderer.js`), `WebGPUGlobeTranslucencyState.ts`,
`FlowFieldWindLayer.js`, ocean, dynamic env manager, BRDF LUT, invert-classification; (c) 3D-Tile
CONTENT internals (`Vector3DTilePrimitive/Polylines/ClampedPolylines` live inside tileset
content, not `.get(i)`-enumerable children).
**Walkthrough:** (1) inventory-first: from the verified grep list, classify every `_webgpuCache`
owner as {walk-reachable, nested, singleton, tile-content} — this table IS the deliverable's
first half and fixes the FI contradiction; (2) extend `clearPerObjectCaches`: known nested slots
explicitly (clippingPlanes/clippingPolygons/imageBasedLighting on model-shaped nodes), the
singleton list from `scene` (each guarded, duck-typed), and a tileset hook (tileset exposes its
content primitives — or clear via the tile-content visitor the voxel/vector renderers already
use); (3) spec with a mock device-loss (deterministic invalidation exists — C9-02A machinery)
asserting every registered owner's cache is undefined post-recovery — table-driven from the
inventory so a NEW owner failing to register fails the spec (add a registration convention or a
debug-build scene-walk validator). **Traps:** (1) clearing must be idempotent + safe mid-frame
(recovery happens between frames — assert ordering); (2) do NOT clear caches the renderers
rebuild lazily anyway in a way that breaks in-flight async builds (generation-tag checks on
rebuild are the existing pattern — preserve); (3) tile-content walk can be expensive — loss-path
only, never per-frame. **Verification:** new/extended spec (real-context if runnable, else
logic-harness with mocked owners); `probe`-level: force `CesiumDebug`-triggered invalidation on a
scene containing model+clipping+starfield+voxel, assert recovery renders correctly (canvas
non-black, no destroyed-texture errors) ×3; existing recovery probes green.
**Model tier: opus.** Effort S–M.

---

### B11. BACKLOG-§Material UBO field-name alignment audit (P1, M)

**What/why:** FI §C.8 (:886, verified): JS-pack vs WGSL-struct name/offset audit incomplete
across ~25 material types — silent data-corruption risk (wrong values, zero validation errors —
WebGPU cannot catch a semantically wrong float at a valid offset). This is an AUDIT slice.

**Walkthrough:** (1) build the checker as a Node tool (`Tools/audit-material-ubo-alignment.mjs`),
not a one-off: parse each WGSL material struct (fields, offsets per WGSL layout rules incl.
vec3 padding) and the corresponding JS packer's write offsets (the packers follow recognizable
`floatBase + N` patterns; where parsing is ambiguous, emit UNVERIFIED rows, don't guess);
(2) diff field-by-field; every mismatch gets: repro scene, severity (visible vs latent), fix;
(3) fix mismatches in rule-3-conservative slices (one material family per commit if any are
found); (4) the tool joins the repo permanently (runs in CI-ish fashion via a spec that fails on
NEW drift — this is the durable win; the polyline material slice's "byte-locked per-material
struct" convention in DW ~4830 is the model). **Traps:** (1) WGSL implicit padding (vec3 →16B)
is where manual audits die — compute offsets from WGSL rules, never from field order alone; (2)
`_pad` lanes get repurposed over time (fog scalar took `_pad4`, point-size took `_pad2` — both
ledgered precedents) — a pad-name in WGSL with a live JS write is a finding, not noise; (3)
scope: MATERIAL UBOs only (~25 types per FI) — camera/tile UBOs have their own contracts
(IMAGERY_PROJECTION doc etc.), don't boil the ocean. **Verification:** tool output table
committed with the audit; zero CONFIRMED mismatches unfixed at close (or each ledgered with
owner); spot visual probes per fixed family (existing material probes:
`probe-polyline-material-primitive`, model PBR audits). **Model tier: opus-or-sol** (systematic,
script-assisted; sol-class thoroughness ideal). Effort M.

---

### B12. NEW-WEBGPU-DEBUG-DEPTH-PLANE-GATE-PARITY (P2, S) — dossier

C9Q L140 + item 79 (verified): `Scene.updateEnvironment` honors `debugSkipDepthPlane`
(VERIFIED at HEAD: `Scene.js:956` flag, `Scene.js:3791` gate: `this.debugSkipDepthPlane !==
true` in the useDepthPlane computation) but `WebGPUContext.updateAndClearFramebuffers`
recomputes `environmentState.useDepthPlane` WITHOUT the gate (VERIFIED:
`WebGPUContext.ts:4079-:4082` — `clearGlobeDepth && mode===SCENE3D && translucency` only, no
`debugSkipDepthPlane` term). `CesiumDebug.js:245` sets the flag — so the debug command is a
no-op on WebGPU. Fix: add `scene.debugSkipDepthPlane !== true` to the WebGPU recompute (1 line)
+ prove true→false→true (depth plane visibly toggles at a horizon view — the horizon oracle's
diagnostic-skip phase machinery in `probe-depth-plane-horizon-oracle.mjs` is exactly this
proof; reuse it). Trap: the pick-side depth plane is gated OFF anyway until C10-12 — this item
is about the SCENE depth plane; don't conflate. Off-gate: default path has the flag false →
byte-identical. **Premise VERIFIED. Model tier: opus. Effort S.**

---

### B13. NEW-WEBGPU-OIT-MSAA-RESOLVE-ORDERING (P2, M) — dossier, FAR-003 lane

DW :5395-:5412 (verified, filed at C10-03, 2026-07-18): under MSAA a later frustum's scene-FB
re-dirty + demand resolve overwrites the mid-frame OIT composite in `_sceneColorView` — exactly
as the OLD eager resolve already did (pre-existing FAR-003 adjacency, NOT a C10-03 regression;
OIT contained OFF at defaults → zero default-path impact). Fix options recorded: (a) dedicated
non-multisampled OIT accum-composite target surviving later resolves, or (b) defer the OIT
composite post-frustum. **Belongs to the FAR-003 OIT×MSAA lane** — schedule only as part of that
lane, never as a drive-by. NOTE post-B693: default 3D is 1 frustum, so "a subsequent frustum"
requires multi-frustum content (custom near/far, 2D bands, sky-only fallback) — the repro probe
must FORCE ≥2 frusta AND arm `_webgpuOITEnabled` + MSAA4. Cross-item: B8 (deferred splats) sits
in the same file; if both are ever scheduled, sequence B13's target decision first — option (a)
changes where B8's redirect should point. **Premise VERIFIED (doc fresh at HEAD; code paths
confirmed by C10-03's own row). Model tier: opus when the lane opens. Effort M.**

---

### B14. NEW-WEBGPU-RENDERCOMMAND-STALE-PASS-SLOT (P2, S) — dossier

DW :5292-:5297 + VERIFIED at HEAD: `Renderer/WebGPU/RenderCommand.js:345`
`cmd.execute(context._currentRenderPass || passState)` — `_currentRenderPass` does not exist on
`WebGPUContext` (real slot `_currentRenderPassEncoder`), so the immediate-mode WebGPU path
always falls through to `passState`. Latent — NO current caller exercises the branch on the
default route (DW's own note). Per Principle 7/9 this is scaffolding with a typo, not dead code:
the fix is one identifier, but it MUST ship with a consumer probe that actually drives the
immediate-mode path (a minimal RenderCommand user through the backend-agnostic API), else the
"fix" is unverifiable. Suggested pairing: fold into whatever first C11 slice adopts
`RenderCommand` for a new feature (charter: new scene features SHOULD use RenderCommand), or a
tiny spec that instantiates the path headlessly. **Premise VERIFIED. Model tier: opus. Effort S
(fix) + S (consumer probe).**

---

### B15. OPEN-1-DIAGNOSE (P2, unknown) — dossier, probably moot; verify-then-close

FI §C.7 (:860): "sky atmosphere shader compile failure root cause TBD". Origin verified:
`WEBGPU_DEBUGGING_LOG.md:2797` (OPEN-1: if `createPipeline()` throws, `cache.pipeline` stays
undefined; a `_pipelineFailed` latch + permanent console.error were added; "actual shader/format
issue requires browser debugging") and :5547 (the original "missing horizon glow" symptom) —
BOTH from early sessions. Since then the ENTIRE sky-atmosphere path was rebuilt (skybox-over-
atmosphere fix, B214/504 fixes, fullscreen-sky variant, C10-01's celestial battery green:
atmosphere-orbit 0.42%, atmo-moon-438 errs=0 at B693). **Verify-then-close protocol:** boot the
default viewer + the fullscreen-sky variant + one HDR leg; grep console for the OPEN-1 latch
error and `pipelineStatus()` for failed sky pipelines; run `probe-atmosphere-orbit`. If clean ×3
sessions → close OPEN-1 in FI §C.7 with the evidence trail (doc-only commit). If the latch still
fires anywhere → THAT capture is the diagnosis this item always lacked; file the real bug with
the shader error text. **PREMISE-UNVERIFIED (likely stale — closure requires the check above,
not assumption). Model tier: fable-cheap (one verification session) or fold into any celestial
slice's gate run. Effort S.**

---

## OPEN QUESTIONS FOR THE ORCHESTRATOR

1. **C10 completion state at C11 launch (hard sequencing input).** §0's decision table needs the
   actual C10 outcome for C10-11/C10-12 and the five W4 riders (A3/A4/A5/A6/B2). Until the C10
   run's `results[]` is read, this cluster's schedulable set is indeterminate — request the C10
   close-out sweep BEFORE freezing C11 wave assignments. If C10 W4 landed everything, this
   cluster shrinks to: A1 (anchor), A7-close, A8, A9, A10, A11 + the B-side reds minus B2.
2. **Lane ruling for `probe-pickposition-webgpu` (maintainer decision).** Is
   `PROBE_BASE=http://localhost:8080` + `node server.js` + `Build/CesiumUnminified` the supported
   reproduction of record (my recommendation — it's what every gate run uses), with the probe's
   8134 default re-pointed at fix time? A1's protocol needs this ratified.
3. **A1 diagnosis-vs-fix split.** I have scoped A1 as diagnosis-only (fable) with the fix as a
   follow-on named at diagnosis close. If the orchestrator wants a single diagnose+fix slice,
   budget L and keep fable through landing — but the one-concern rule argues for the split.
4. **`gpuCullingHint='always'` policy (B1, potential maintainer decision).** If the
   high-density-spheres drift traces to the contained GPU-cull path, the charter forbids
   degrading the feature for the metric: the options are (a) repair the `'always'` path
   (possibly M–L, touching FAR-003-contained code), or (b) re-scope the scene with an explicit
   coverage-loss note. (b) needs maintainer sign-off — flag early if B1's Step-2 A/B implicates
   the cull path.
5. **FAR-107 public-API review.** A8 requires maintainer approval on public pick types before
   landing (the FAR plan says so explicitly). Schedule the review touchpoint, or A8 stalls at
   done-but-unlandable.
6. **B8 oracle-block.** The OIT-splat resume fix is unverifiable until
   `NEW-WEBGPU-SPLAT-DATA-PRODUCER` (splat cluster, other guide) lands. Cross-cluster dependency:
   sequence B8 after the producer, or accept it as dossier-only this campaign.
7. **Reversed-Z reconciliation.** If C10-13's spike recorded GO, every log-depth-expanding item
   here (A2 if inherited, A10's pick shaders, A11's blit) needs the recorded reconciliation
   decision read first. The two streams pulling the 71-file surface in opposite directions is the
   single biggest strategic hazard in this cluster.
8. **FI §C.8 / §B contradiction on C-R12 (doc hygiene).** B10's inventory will resolve which row
   is true; whichever slice lands first should fix FEATURE_INVENTORY in the same commit (the
   inventory is load-bearing for impact analysis — CLAUDE.md Principle 6).
9. **Checkpoint gating.** A1 (pickposition) + B1 (spheres) are the two reds gating C10-30-style
   feature-loss checks. If C11 runs its own checkpoint, schedule A1/B1 in W1 so later waves
   aren't landing against known-red gates with OFF-oracles forever (each OFF-oracle rep costs
   every landing slice real time).

---

*Anchor tally: 34 distinct file:symbol anchor clusters verified against `git show
HEAD:` at `5b98ab9698` for this guide (each marked "verified" inline). Items whose premise could
not be fully verified at HEAD are flagged: A11 (behavioral premise unverified), B8
(oracle-blocked), B9 (premise partially stale — key already covers ms/vx/tg/df axes), B15
(likely moot — verify-then-close). All other items' premises were re-confirmed structurally at
HEAD.*
