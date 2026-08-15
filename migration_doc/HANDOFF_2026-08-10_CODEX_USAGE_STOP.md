# Handoff 2026-08-10 — Codex usage stop

## 2026-08-11 continuation — portfolio wave and C11-169 recovery

The source-freeze snapshot below remains historical evidence. Current dispatch
is governed by [`CAMPAIGN_PORTFOLIO_QUEUE.md`](CAMPAIGN_PORTFOLIO_QUEUE.md), and
the dirty tree has now been partitioned read-only into 25 non-overlapping landing
buckets covering all 175 pre-recovery paths with no omissions or duplicates.
Nine shared engine files require hunk-level integration; never stage those files
wholesale.

The resident-San-Francisco owner-attribution continuation belongs to `C11-169`,
using the already-green `C11-205` workload. Its r2x600 run
`6499611d-66b6-4072-ab1f-7ef47791045a` is a retained harness-only FAIL, not a
product red: the old cursor repeated progress zero, omitted endpoint one, and one
leg captured 601 route observations. Before another invocation could overwrite
the mutable output, it was archived as
`Tools/visual-regression/output/performance/c11-169-resident-sf-owner-attribution.run-6499611d-harness-red.json`,
SHA-256
`8BF47C39AF3FEAE842B32AD5B30F5E2E47D5F2F83662BF9FE8D067D02690B897`.
The older write-once r2x240 structural first red remains unchanged at SHA-256
`185E606881B04EFDA75B10EC559BECAACBAEF4CECBB2EACF09E33CC7A38231D7`.

The corrected runner is SHA-256
`8045B6462EF498B290DC5965C0013715BCA34A0E0C1EEA269F22349ED137AE12`;
Node syntax, owner/workload policy 73/73, Prettier, ESLint, and scoped diff
hygiene are green. The one authorized serialized recovery is now complete:

- final run `63c4806e-83cb-4ac3-bddd-8a28d1dcdca7`, `PASS`, exit `0`;
- four passing 600-frame legs in AB/BA order and 2/2 valid attribution-only
  pairs, with exact progress `0→1`, eight 75-frame segments, 55 exact owner hits
  per frame, and no out-of-parent calls;
- both WebGPU legs have exact sequences `1..600`, 571/600 and 570/600
  named-pass-positive frames, all 11 phases populated, and zero conservation,
  attribution, overlap, or unattributed residual error;
- final artifact SHA-256
  `C755784AEF33AA85DF8C8F0DD72C0E025BFF38AC54F441CF1349DB5E95774C1C`
  over 8,453,346 bytes, binding frozen bundle SHA-256
  `7B42F00D0135C28CE5D9CC90486966EBA21B452B8974A6293381FE8761BFCBDA`;
- write-once and archived reds remain byte-stable at `185E6068…31D7` and
  `8BF47C39…B897`, and the exclusive lock is absent.

Across 1,200 WebGPU diagnostic frames, `primitiveTraversal` mean/median/p95 is
4.715/4.3/9.4 ms; nested mean shares are direct models 47.668%, globe 43.246%,
tilesets 4.954%, ordinary non-asset residual 3.243%, primitive residual 0.825%,
and ground 0.064%. This is synchronous attribution-only evidence: it does not
reopen C11-205's lifecycle/exact-work/causal gates and earns no FPS, GPU, or
uninstrumented performance claim. The next action is landing the corrected
Tools packet, then an evidence-led uninstrumented C11-168 discriminator; do not
rerun this unchanged green artifact.

## Stop condition

This is a deliberate source-freeze boundary, not a campaign close. The active
engine edits are internally buildable and the focused offline contracts are
green. The C12-37 Moon Node/Playwright Edge gate is now green on both WebGL and
WebGPU, and both focused Moon Jasmine/Karma suites are green. C11-193A/B/C,
C11-196, and the bounded C11-202 legacy-pick-tax fix now also have focused and
real Edge/WebGPU evidence; C11-193C closes the local same-frame demand-priority
slice without earning a timing claim. Point-cloud/EDL, voxel-pick, cloud-U2, and the
remaining Campaign-11 acceptance lanes remain owed.
C11-133's ten-run launcher machine gate is also green. Do not call any of this local work
`LANDED`, `COMPLETE`, or performance-certified beyond the exact browser artifact
named below.

- Base `HEAD`: `cff0b76a2fe8063bf8c939bc78873f25278729b1`.
- Worktree: deliberately dirty; no staging, commit, push, stash, reset, or
  cleanup was performed.
- Point-in-time stop snapshot after the reviewed C11-193A/B/C, C11-196,
  C11-202, and C11-169 primitive-breakdown checkpoints: **166**
  `git status --short` entries (**126 tracked, 40 untracked**); the tracked diff
  reports **126 files, 17,196 insertions, and 3,172 deletions**,
  with no cached/staged diff entries. Those numbers include the whole current
  multi-session work wave, not only these lanes.
- Python was not used. Browser work remains Node/Playwright or Node/Karma.

## Current goal

Preserve all WebGL and WebGPU functionality while completing the fork's
performance/correctness architecture: backend-neutral CPU descriptors and
scene decisions, renderer-owned device-generation resources, no WebGL object
tax on WebGPU, work prepared outside draw hot paths, truthful moving-camera
performance evidence, and explicit browser gates before claims. The immediate
next goal is to certify the frozen high-priority fixes, then take the smallest
sound remaining Campaign 11 slice rather than starting another broad rewrite.

## Frozen high-priority work

### C12-37 Moon/globe physical depth ordering — LOCAL + BROWSER/KARMA GATES GREEN

The defect is real on both backends. Historically the Moon is an always-
background environment draw, so the later globe draw wins even if the lunar
surface is physically nearer. The local fix preserves the byte-identical
environment path for ordinary Earth-near cameras and conditionally emits one
bounded `Pass.OPAQUE` Moon command only when a shared binary64 Moon-near versus
Earth-far test requires physical ordering.

The physical route has:

- one backend-neutral f64 decision with one-lunar-radius exit hysteresis and
  prewarm margin;
- exactly one ENVIRONMENT or OPAQUE owner, never both;
- real lunar bounds, RTE coordinates, depth test/write, current-slice
  ownership, and canonical logarithmic/hyperbolic depth;
- packed current-frustum globe-depth comparison when the normal
  `clearGlobeDepth` policy erased native terrain depth before OPAQUE;
- normal native depth ordering against tiles, models, voxels, and other opaque
  content;
- conservative exclusion from the Earth-sized scene octree and from CPU/GPU
  occlusion rejection without disabling either producer globally;
- WebGPU lazy prewarm, terminal-per-device/generation pipeline failure with
  the legacy route as fallback, distinct per-execution uniform slots, and no
  render bundle on the late-bound physical route;
- one-frame WebGPU TAA history invalidation when the *actual emitted route*
  changes.

No public API was added. A temporary `MoonDepthRoute.js` helper was removed;
the generated engine barrel contains no `MoonDepthRoute` export.

Important evidence correction: the user's exact screenshot query/time is not
a valid visible-Moon fixture at this source snapshot. At
`2026-08-10T15:45:30Z`, current-head ICRF/TEME evaluation puts the entire Moon
behind that recorded camera. The bug remains source-proven, but that exact
record is retained as a `STRUCTURAL / REPORTED-REPRO-INVALID` negative control.
The certifying probe derives real Moon-near, Earth-near, camera-inside
multi-frustum, and hysteresis-crossing fixtures from the pinned ephemeris.

Primary files:

- `packages/engine/Source/Scene/Moon.js`
- `packages/engine/Source/Scene/Scene.js`
- `packages/engine/Source/Scene/EllipsoidPrimitive.js`
- `packages/engine/Source/Scene/SceneOctree.js`
- `packages/engine/Source/Scene/OcclusionCulling.js`
- `packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js`
- `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts`
- `packages/engine/Source/Shaders/EllipsoidFS.glsl`
- `packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl`
- `packages/engine/Specs/Scene/MoonDepthRouteSpec.js`
- `packages/engine/Specs/Renderer/WebGPU/WebGPUMoonDepthRoutingSpec.js`
- `Tools/visual-regression/moon-globe-depth-routing.spec.mjs`
- `Tools/visual-regression/probe-moon-globe-depth-occlusion.mjs`

Offline evidence at the stop:

- Moon source/math/Naga contract: 12/12 PASS.
- Probe syntax and targeted lint/format: PASS.
- Engine TypeScript: PASS.
- Full repository `npm run build`: PASS before browser work, then PASS twice
  more after the two browser-found corrections; the final build completed in
  77.0 seconds.
- `git diff --check`: PASS.

The first browser run was intentionally treated as evidence, not relaxed. It
found three reds: two WebGL HDR Moon-near lanes had physical-versus-legacy
color mismatch (`p95=149` and `184`), and WebGPU reported zero TAA resets. The
HDR issue was a real route-transition regression: the newly binned physical
command selected Scene's HDR-derived shader while the historical directly
executed ENVIRONMENT Moon never does. Its log-depth clone also dropped the
private route marker. The fix preserves the byte-identical legacy appearance,
propagates the marker to the log clone, and prevents both HDR creation and
selection for the physical Moon command. The TAA red was a harness timing bug:
the probe read the effect before WebGPU's lazy prepare pass created it. The
probe now establishes a legacy-route baseline, settles TAA construction, proves
the effect exists, and only then hooks `resetHistory`.

Final browser evidence is
`Tools/visual-regression/output/performance/campaign12-c12-37-moon-globe-depth-occlusion.json`
(`mtime 2026-08-10T16:24:47.462Z`): `pass=true`, `failures=[]`, requested and
actual backend identities match, and both backends have zero console/page
errors. Each backend ran ten combined/Earth-only/Moon-only overlap lanes; every
lane has `winnerCloserFraction=1` and `winnerErrorP95=0`. Every Moon-near lane
emits exactly one unique physical command. The camera-inside oracle exercises
four active frusta with three physical-frustum executions on each backend.
WebGPU reports `taaEffectAvailable=true`, a ready/nonfailed prewarmed pipeline,
and exactly two route-transition history resets. The recorded screenshot view
remains the expected structural/behind-camera negative.

The same unchanged build then passed both focused EdgeHeadlessCI/Karma suites:
`Scene/MoonDepthRoute` executed 4/4 successfully and
`Renderer/WebGPU/WebGPUMoonDepthRouting` executed 1/1 successfully. Both were
nonempty runs with exit code 0. Still owed for C12-37: mechanical landing and
authoritative campaign-ledger reconciliation. Neither the Playwright nor the
focused Karma browser gate should be described as owed.

### Point cloud, EDL, voxel, and picking

The current local point-cloud/EDL and voxel/pick sources are frozen after the
latest adversarial pass. Important closures include shared CPU point formats
and Draco ordering; real renderer readiness; local/RTE point coordinates and
previous-frame velocity history; conservative exact bounds; owner-scoped GPU
LOD streams; projected-error LOD; translucent/EDL preservation; shared
physical-device layouts; pass-local EDL replay; submit-safe EDL uniform-arena
slots; exact-frame zero-cost-off gating; owner/context lifetime; capped
indirect counts and 128-lane ballot support; exact device/generation resource
retirement; voxel content exact-once disposal; typed pick-cache provenance;
same-encoder draw/copy ordering; selected-owner admission; all-255 voxel
no-fragment sentinel; and zero-frustum clear-only passes.

The independent combined rerun at this stop passed 43/43:

```text
node --test Tools/visual-regression/webgpu-pick-center-identity.spec.mjs Tools/visual-regression/webgpu-voxel-resource-lifecycle.spec.mjs Tools/visual-regression/pointcloud-voxel-public-correctness.spec.mjs
```

No browser probe was launched. Dominant PNTS/Model EDL remains separate
Campaign-18 work. Known P2 follow-ups remain documented: active EDL grouping
complexity, exact fractional-radius encoded-depth parity, bounded EDL target
grace/pooling, cross-context compilation sharing, and point-cloud CPU/GPU
retention/accounting.

### Other local high-value closures in this worktree

These were reviewed and focused-test green earlier in the same work wave, but
remain local until the final integrated/browser evidence is reconciled:

- vector-tile CPU bake completes before one backend ownership claim; WebGPU
  creates no WebGL textures, exact device/generation recovery re-realizes from
  retained CPU bake, and a negative cache removes unchanged WebGL registry
  lookups;
- exact pipeline-cache blend/write-mask/depth semantics and metadata descriptor
  typing;
- stable IBL spherical-harmonic buffer plus exact device/generation recovery;
- cloud zero-alpha reconstruction sentinel and bounded four-slot shadow bind-
  group cache;
- paired default-zero terrain terminator-glow control;
- C13 U2 fibrous cloud morphology using the exact constant-pivot law;
- visual-baseline setup-content identity and stable promotion provenance;
- current-GPUWeb C11-213 fragment-storage compatibility correction and focused
  layout/device-limit hardening.

### C11-133 Karma completion truth

Local tooling now requires a real `run_complete`, nonempty valid counts, and a
register/start/terminal-complete lifecycle for every reported browser.
Disconnect, browser, process, restart, empty, malformed-count, and unexplained
exit failures remain fatal. `failTaskOnError=false` suppresses only an ordinary
exit-1 from a fully completed nonempty suite with actual failed tests. Exact
per-run `karma-edge-*` temp profiles are reaped on success and failure with
bounded Windows retries; unrelated paths are never deleted.

`node scripts/__tests__/karmaTestRun.spec.mjs` passes at this stop. C11-133 is
**LOCAL TOOLING + MACHINE GATE GREEN — LANDING OWED**, not complete. Ten
consecutive serial EdgeHeadlessCI runs used one unchanged build. Every run
exited 0 with 15 executed successes and 17,794 intentional skips, completed the
browser lifecycle, reported no infrastructure failure, and left zero new
selected `karma-edge-*` profiles. Five unrelated profile directories existed
before the measurement and remained outside this run's ownership; the result
therefore claims exact per-run cleanup, not that the global temp root was
empty.

### C11-140 GPU timestamp accounting — LOCAL ADAPTER CERTIFICATION GREEN

The first certification launch found a deterministic probe bootstrap defect,
not an adapter failure: a string constant named `URL` shadowed Node's global
`URL` constructor before Playwright launched. The probe now uses `VIEWER_URL`,
and the focused source contract permanently rejects reintroducing that shadow.
`node --check` passes and
`gpu-timestamp-unique-sample-accounting.spec.mjs` passes 13/13.

The corrected Node/Playwright Edge lane produced
`Tools/visual-regression/gpu-timestamp-accounting-certification.json` with
`certified=true`, `timestamp-query` available, and five repetitions of the
60-frame moving-altitude route. Every repetition closed its sample ledger and
coverage-ratio identity; failed, lost, pending, inverted, and unaccounted
samples were all zero. Each tail drain reported one drained and zero undrained
or abandoned samples. The first repetition honestly recorded two bounded busy-
slot skips; the remaining four recorded none. There were no structural
reasons, page/console errors, or external requests. The probe fix and artifact
are local and require mechanical landing before repository completion.

### C11-205 — LIFECYCLE + ATTRIBUTION + CAUSAL GATES GREEN; LANDING/REMEDIATION OWED

The real multiple-content lifecycle v2 browser lane is green in both backends.
Each resolved the requested renderer, observed two content slots and two ready
models on one ready tile, issued two requests with zero left open, held the
ready signature for 12 frames, advanced each state-packet mutation exactly
once, propagated every value to both slots, preserved dynamic per-tile state
without a packet bump, and reported no console/page errors. WebGL and WebGPU
produced the same lifecycle ledger signature `1bf0f7c3-b152437e`.

The first full six-pair attribution command reached its external 20-minute
ceiling during the last leg and produced no artifact. The bounded rerun did
complete all 12 legs and wrote the 167,908,005-byte
`Tools/visual-regression/output/performance/c11-205-attribution-2026-08-10-rerun.json`,
then correctly exited 1. All 12 runs found the same benchmark camera-phase
error: the timed window rendered `[1/599 ... 1, 1]` while the causal replay
rendered `[0 ... 1]`, so zero of six pairs were admitted. The comparator and
evidence recorder were correct; both convergence and measurement had activated
their action loop at index 1 even though their pre-applied zero camera had not
rendered inside those windows.

Both activations now start at zero. The strict raw-sequence comparator,
tolerance, endpoints, and fail-closed behavior are unchanged. Node syntax is
green and `performance-workloads.spec.mjs` passes 56/56. A one-renderer,
one-repetition, 60-frame browser discriminator wrote
`c11-205-phase-discriminator-webgl.json`: its run itself passes, measured and
replay arrays are identical, first divergence is null, maximum difference is
zero, and the full route endpoints are present. Its overall campaign exit 1 is
expected because that deliberately reduced diagnostic has no WebGL/WebGPU pair.

C11-205 remains partial, but the apparent backend request divergence is now
also explained and locally corrected at its real owner. The old full artifact
reported stable WebGL 15-request/`27b1e7d0-dd48cecb` versus WebGPU
12-request/`268fe338-d3839698` ledgers because the untimed resident prime used
normal wall-clock-sensitive request admission. `camera.timeSinceMoved`, the
0.2-second foveated delay, and moving-request culling allowed slower WebGL
content realization to dwell long enough to admit three peripheral siblings;
faster WebGPU advanced after two `tilesLoaded` frames, while `tilesLoaded`
cannot see requests suppressed before admission. This was benchmark preload
nondeterminism, not renderer traversal/SSE evidence.

Only during the untimed resident route prime, the harness now snapshots each
tileset's policy, sets `foveatedTimeDelay=0` and
`cullRequestsWhileMoving=false`, and restores both in `finally` before
convergence or measurement. It records the exact scope, originals, and
restoration. No engine behavior, measured feature, traversal rule, or SSE was
changed. Contracts now pass 57/57. The paired one-repetition/60-frame/API
discriminator `c11-205-prime-admission-discriminator-pair.json` has two passing
runs and one valid attribution-only pair with no reasons: measured/replay phase
matches exactly, all eight segment fingerprints match, both ledgers contain 20
requests with signature `aa38af59-4b01a371`, chronology and byte totals match,
and selected/ready mismatch frames are both zero. Its overall exit 1 is only
because a reduced one-pair API lane cannot certify the campaign.

The full corrected r6 attribution then passed. Artifact
`Tools/visual-regression/output/performance/c11-205-attribution-phase-prime-fixed-2026-08-10.json`
is 171,308,539 bytes, generated `2026-08-10T17:43:59.849Z`, and exits 0. All
12 runs pass non-structurally with empty failures. The summary admits all 6/6
attribution-only pairs, balanced three per order, with no reasons or ready-set
exclusions. Every pair has exact workload fingerprint, all eight segments, and
ready identity; both ledgers contain 20 requests/signature
`aa38af59-4b01a371`, exact chronology, zero mismatches, and identical byte totals
(20,127 transfer / 56,508 encoded / 193,856 decoded). Selected/ready mismatch
frames are zero, and both six-run aggregates are stable with no reasons. This
certifies equivalent instrumented work and identity, **not causal timing**.

The separate non-instrumented causal r6 also passed. Artifact
`Tools/visual-regression/output/performance/c11-205-causal-phase-prime-fixed-2026-08-10.json`
is 7,070,900 bytes, generated `2026-08-10T18:05:31.888Z`, and exits 0 with API
instrumentation and GPU timestamps both off. All 12 runs are clean,
non-structural, measurement-valid, and aggregation-eligible. All 6/6
certification-eligible 600-frame pairs pass, balanced three per order, with no
ready-set exclusions or outcome differences and exact fingerprints/all eight
segments/ready identity. Both aggregates are stable with no reasons.

The valid causal result exposes a material WebGPU deficit: CPU-p95 run median
9.2024999993 ms (8.305–10.0) vs WebGL 4.6499999985 ms (4.4–7.6); wall-p99
median 23.302 ms (20.605–24.802) vs 20.3025 ms (19.702–21.302); and
navigation-to-stable median 52,099.36 ms vs 48,116.65 ms. There are no GPU
samples (`validGpuRunCount=0`), so do not call this GPU-bound. C11-205's local
measurement gates are green, but it remains NOT COMPLETE until the local
harness/evidence lands. Root-cause optimization of the valid CPU/wall deficit
continues under C11-168 without removing features.

## C11-169 whole-Scene phase attribution — LOCAL + FOCUSED EDGE + DIAGNOSTIC BROWSER GREEN

**Unlanded, NOT COMPLETE, and no FPS claim.** The local profiler preserves
exact normal-Scene/named-pass accounting and adds a mutually exclusive fixed
11-phase CPU ledger. Named pass begin/end suspends and resumes the active phase
at one timestamp; repeated multi-frustum, WebVR, and split-2D visits accumulate
into one logical Scene record. Both `total + overlap = named + unaccounted` and
`total + attributionOverlap = named + phases + unattributed` remain exact.
Suppression, re-entry, replacement, disable, and error paths fail closed;
standalone pick is isolated. Disabled mode performs no accounting clock read or
Map/record allocation.

Focused evidence is green: Node **31/31**, package TypeScript, integrated build
**53 s**, profiler Edge **26/26** with **18,203 skipped**, and Viewport Edge
**2/2** with **18,227 skipped**. Preserve two earlier reds: the combined Karma
substring-filter command selected 0 tests (harness red), while the first
separate Viewport run was 1/2 because the extracted helper lacked the new
frame-local renderer pin (real helper-compatibility defect, fixed before 2/2).

Final artifact
`Tools/visual-regression/output/performance/c11-169-whole-frame-phase-attribution.json`
is `runId=e07afdd3-67b6-41ab-aa09-a62ece40da6e`, generated
`2026-08-11T09:28:44.566Z`, SHA-256
`A5A2B43CF606CFF11DF0EDC56C352556633113DEB77B43083CF659A613DA9839`,
PASS/exit 0. All **14 serialized `.pass` booleans** are true; do not call the
browser artifact 31/31. Failures and console/page/local-request/GPU/device-loss
errors are empty.

- Route: **180/180** unique frames, **8/8** segments, all 11 phases positive;
  median total/named/coarse **4.8/0.3/4.5 ms**, additive mean
  `6.7506 = 0.3144 + 6.4361 ms`, and zero unattributed/overlap/residual.
- `primitiveTraversal` is **45.72% of total mean**, median/p95 **1.5/8.9 ms**.
  That justified the nested diagnostic below; it was not itself an optimization
  verdict.
- Four 24-pair 8 ms controls move only primitive/PVS/renderer/after-render
  target phases, with exact 48/24 seam/spin hits and positive named work in
  both arms. Suppression, four-frustum, wrapped-2D two-execute, isolated-pick,
  conservation, and every error negative are green.

The first-green nested artifact is
`Tools/visual-regression/output/performance/c11-169-primitive-traversal-breakdown.json`,
`runId=e60f18d2-fbc1-48ba-b499-4806481bf20f`, generated
`2026-08-11T10:22:11.412Z`, SHA-256
`8C7F14B614C467C5686619731426062C7B435D3F4545BC6B9481D39D1373FDB0`,
PASS/exit 0. Its first browser invocation was green, so the write-once first-red
path is physically absent. Offline policy is **17/17**, combined Node is
**48/48**, static gates are green, and independent review is P0=0/P1=0.

- Route: **120/120** unique normal frames, **8/8** segments, and named-profiler
  work in **118/120** frames. Total median/mean/p95 is
  **9.0/13.5175/55.8 ms**; primitive is **2.3/4.6358/8.4 ms**.
- Globe render median/mean/p95 is **2.2/4.5692/8.2 ms**, or **98.56% of mean
  primitive time**. Ground-primitives update, ordinary-primitives update, and
  primitive-residual means are **0.0067/0.0008/0.0592 ms**; environment drain
  is **0.0067 ms** in the separate compute/shadows phase.
- Four 12-pair 8 ms controls have exact **24/12** seam/spin hits. Off-target
  medians are at most **0.3 ms** across phases and **0.1 ms** across details;
  all error lanes are empty.

The nested result is not resident-workload evidence. Prime ended
`globeTilesLoaded=false` with `pendingForegroundCount=3`; the viewer used the
default local Natural Earth II globe and no explicit model or tileset. Preserve
it as a streaming/default-globe control. It is not transferable to C11-168 or
the resident C11-205 San Francisco workload and earns no optimization, FPS, or
causal claim. Historical globe-only cross-backend evidence was already near
parity, so resident San Francisco/C11-205 phase attribution is the next pivot.

The write-once first red remains
`c11-169-whole-frame-phase-attribution.first-red.json`,
`runId=5e013ea8-648c-49f3-8ac2-f3a5a3ee715d`, SHA-256
`2219C3F1EE85BE33802A8084421E32C8DE7C84AB054D94353A5605815741D176`.
Only PVS 43/48 and after-render 40/48 failed an invalid 90% named-pass-positive
rule copied from the moving route onto repeated paired controls, where real
sub-0.1 ms named work can quantize to zero. The repair keeps strict moving-route
non-vacuity and requires named buckets plus positive named work independently
in both control arms.

This is synchronous, instrumented `diagnostic-noncausal` CPU evidence;
asynchronous GPU execution is excluded. Landing, resident San Francisco/
C11-205 phase attribution, any evidence-led remediation, and a separate
uninstrumented causal measurement are owed before performance credit or
closure.

## C11-209 placeholder-clear submit consolidation — LOCAL + FOCUSED EDGE + REAL BROWSER GREEN

The local effects-cache initializer preserves all **11** depth clears—base
depth, four CSM layers, and six cube faces—but records them through exactly
**one encoder, one finish/command buffer, and one `queue.submit`**, reusing the
cached base-depth view. The focused Edge `WebGPUEffectsDeviceCache` suite is
**5/5** and covers exact pass count/layer targeting, cache reuse,
invalidation/re-creation, and destruction.

The hardened real Edge/WebGPU startup artifact
`Tools/visual-regression/output/performance/c11-209-effects-placeholder-startup.json`
is **16/16 PASS, exit 0** (`schemaVersion=1`,
`runId=aecc0347-0c79-4c33-b48c-c964c53dc397`,
`generatedAt=2026-08-11T06:52:23.336Z`). All eight native hooks were live
before the sole device request. The exact startup vector is **3 textures / 13
views / 1 encoder / 11 passes / 1 finish / 1 command buffer / 1 submit**, with
the base default view, CSM layers `[0,1,2,3]`, and cube faces `[0,1,2,3,4,5]`
traced to their exact texture subresources. Twenty-four visible steady frames
advance frame 6 → 30 with an exact seven-field zero delta. Fourteen globe tiles,
20.90% nonblack pixels, and 393 quantized colors prove non-vacuity; validation,
device-loss, render, page, console, and local-request gates are empty. The first
browser invocation was green, so no first-red artifact exists. The probe now
writes a unique `RUNNING` marker before launch and fails closed to explicit
`ERROR`/exit 2 plus write-once first-red on timeout/outer error.

Browser startup/device acceptance is discharged. This is startup-submit shape
evidence by construction, not a measured startup-time, frame-time, FPS, or
percentage win. Mechanical landing remains owed.

## C11-193B dynamic-IBL shared Scene submission — LOCAL + FOCUSED EDGE + REAL BROWSER GREEN

The local C11-193B path borrows the exact active Scene command encoder and
holds each manager's unique writable parameter-arena lease and provisional
output graph through that encoder segment. Exact submitted/abandoned callbacks
publish or roll back output, temporal state, fairness, and leases only at the
real submit boundary. The off-frame private fallback remains available.

The exact-encoder `unsafe default containment` seam is **16/16 SUCCESS** with
**17,813 skipped**, package TypeScript is green, and independent review found
P0=0/P1=0. The final named Edge/Karma
`WebGPUDynamicEnvironmentMapManager` suite is **25/25 SUCCESS** with **17,816
skipped**, exit 0; eight Phase-2 cases extend the prior 17. The integrated build
is green. There is no separate Node count.

The first real Node/Playwright Edge/WebGPU invocation passed on its first run;
there is no C11-193B browser-red history. Artifact
`Tools/visual-regression/output/performance/c11-193b-dynamic-ibl-shared-submit.json`
exits 0 with **19/19** checks. Two independent managers each encode the exact
44-pass sequence (sky + 6 irradiance + 36 radiance + SH), so all **88** passes
share one `Scene Frame Command Encoder` and one submit matching the no-refresh
control. A topology replacement encodes 44 passes on one Scene submit, stays
fail-closed through native submit, publishes afterward, isolates the untouched
manager, and consumes one clean zero-pass follow-up. Same-topology identities
are stable, writable arenas/outputs remain distinct, and private dynamic-
environment encoders/submits are **0/0**. Browser, request, validation, OOM, and
device-loss gates are zero.

This is local/unlanded architecture and correctness evidence, not an FPS win or
Campaign 11 completion. C11-193C below supplies the local same-frame priority
drain and correct mandatory-versus-deferrable budget law. Landing, moving-camera
performance, persistent HQ reuse, broader device-loss/replacement,
multi-context/multiview acceptance, the inherited raw-cubemap exceptional-
recovery gap, and short-lived descriptor cleanup remain open.

## C11-193C same-frame dynamic-IBL demand priority — LOCAL + FOCUSED EDGE + REAL BROWSER GREEN

The local context now collects exact dynamic-environment manager ticks through
the Scene primitive phase and drains final same-frame `DEMANDED`/conservative
`UNKNOWN` work before `PROVEN_NONE`. A wrapped-2D first half holds NORMAL jobs
so second-half demand can promote them before the continuation encoder. Budget
1 applies only to deferrable work; MANDATORY unpublished resources and anti-
starvation escalation bypass that slot. A deferral arms one lossless
`afterRender` resume, while C11-193B's exact submitted callback remains the only
authority that advances fairness and publishes output.

The implementation is allocation- and lifecycle-conscious. Coordinator entries,
jobs, and HIGH/NORMAL scratch arrays are retained, with no closure/maps/drain
arrays on the empty path. Recovery preflight remains synchronous; queued jobs
pin the exact frame context and resource generation, reject destroyed managers
and invalid collection/context state, release captured references after
drain/reset/error, and leave thrown updates level-triggered for retry. WebGL,
the off-frame private fallback, manager-local regional/weather output, and
unique writable arenas are unchanged.

Focused evidence is **56/56** across the Node priority and drain/lifecycle
suites, **31/31** in named Edge/Karma, green package TypeScript, independent
P0=0/P1=0 review, and a fresh integrated build passing in **79.7 s**. The final
real Edge/WebGPU artifact
`Tools/visual-regression/output/performance/c11-193c-dynamic-ibl-demand-priority.json`
is `schemaVersion=1`, `runId=6c895a6d-d808-4397-8981-0cb2df6d3acc`, SHA-256
`7CB3D70DAD06DCCCED6E6DE0BC3A0A73699AAF294393C09513CEB970F4FB3BE3`,
**29/29**, exit 0.

- Priority HIGH/NORMAL is **44/0** passes on one Scene encoder/submit;
  scheduler requests/granted/deferrable/deferred/resume/submissions/pending is
  **2/1/1/1/1/1/1**, demand is demanded/proven-none **1/1**, and the
  coordinator drains to zero.
- Deferred NORMAL resumes on the next requested frame for exact **44** with
  **1/1/1/0/1/0** requests/granted/deferrable/deferred/submissions/pending;
  stable repeat work is zero.
- MANDATORY plus UNKNOWN-HIGH encodes **44 + 44 = 88** passes on one Scene
  encoder/submit; scheduler requests/granted/mandatory/deferrable/deferred/
  submissions/pending is **2/2/1/1/0/2/0**. Its repeat is zero.
- Real split 2D encodes 0 dynamic passes on the first submit and exact **44**
  on `Secondary Viewport Continuation Encoder`; telemetry is
  **1/1/1/0/1/0**, and the split repeat is zero.

All active managers retain exact non-null pending/scope/commit/arena/buffer and
encoder identities through native submit with `commitReady=true`,
`encodingFailed=false`, and arena locked. Their prior `lastSubmitFrameId`
survives through submit, then changes to the current frame only after pending,
scope, and commit clear and the arena unlocks. Manager graphs remain distinct
and stable; private encoders/submits are **0/0**; the 1000×720 control renders
one globe tile; every browser/request/Scene/WebGPU/device error gate is empty.

The preserved first red is
`Tools/visual-regression/output/performance/c11-193c-dynamic-ibl-demand-priority.first-red.json`,
`runId=5cd791e0-9c4e-4c66-b2a2-061045134bac`, SHA-256
`B2C4DD55D50A4C65643BA694707B666BB62ACFBE0AFE9CD75EE2BF4308E93452`.
It was Tools-only: a predicate required `needsUpdate === true`, but valid sun-
dirty deferrable work has `needsUpdate=false` while its explicit pending
transaction is live. The repair replaced that representation assumption with
exact transaction/arena/encoder identities and a strict pre-submit-to-post-
frame scheduler transition; no product gate was waived.

This is one Edge/browser/adapter/device/context and native-submit-return, not
GPU-completion or FPS evidence. The browser resume lane does not sustain
contention; Node owns alternation/escalation. Reentrant manager lifecycle,
invalid cross-context manager sharing, malformed custom Scene/frame-state
invariants, and broad device-loss/replacement/multiview recovery remain open.
Telemetry snapshot getters allocate and stay diagnostic. Land this exact slice,
then perform moving causal attribution; do not rerun unchanged evidence.

## C11-196 native model pick-demand realization — LOCAL + FOCUSED EDGE + DIAGNOSTIC BROWSER GREEN

The local renderer keeps feature/style resources live during ordinary color
rendering but leaves native generic/dense pick IDs, the feature lookup texture,
pick pipeline, and derived pick command cold. Exact `passes.pick === true`
demand for a non-classifier with `allowPicking !== false` synchronously promotes
the complete native pick block. Publication is atomic and retryable; feature-
count replacements retire old textures through submit-safe scheduling; and
same-frame model capture publication upserts instead of replaying stale entries.
WebGL, styling, classifiers, all pick variants, teardown/recovery, and first-
pick synchrony remain intact.

Node contracts pass **13/13**. Named Edge/Karma `WebGPUModelFeatureId` passes
**19/19** with **17,823 skipped**, exit 0; package TypeScript is green and
independent review found P0=0/P1=0. Final artifact
`Tools/visual-regression/output/c11-196-model-lazy-pick-demand.json`
(`generatedAt=2026-08-11T04:19:57.165Z`) records `pass=true`, `exitCode=0`,
`failures=[]`, and zero page/WebGPU/render errors. Its 30-feature fixture proves
cold native generic/dense/lookup/pipeline counts **0/0/0/0** while styling stays
live. First pick realizes **1/30/1/1**, performs one byte-40 enable and one
merged-bind-group rebuild, and returns `_Cesium3DTileFeature` 28 with readable
hierarchy properties. Repeat pick and four later color frames produce zero new
pick IDs/textures/pipelines/bind groups and preserve the relevant identities. A
fresh `allowPicking=false` lane returns no hit, no derived command, and native
**0/0/0/0**.

Both browser reds are retained. The first was a harness precondition error: it
assigned the readonly `allowPicking` accessor and treated existing WebGPU debug
warnings as failures. The corrected second run exposed a separate shared-
frontend tax: `Model.update -> updateFeatureTables -> BatchTexture.update`
created **30 backend-neutral legacy tile-feature registry IDs** before
`submitDrawCommands` applied `allowPicking=false`. The native C11-196 lane stayed
allocation-free and returned no hit; the final artifact reports these calls,
and `.first-red.json` plus `.legacy-frontend-red.json` preserve the history. This
is the historical C11-202 handoff evidence and must not be hidden or credited
as a C11-196 win. The bounded C11-202 checkpoint below now suppresses it for
regular native models. C11-196 remains local/unlanded and has no moving-route
FPS claim.

## C11-202 bounded legacy BatchTexture demand gate — LOCAL + FOCUSED EDGE + DIAGNOSTIC BROWSER GREEN

The exact 30 legacy IDs exposed by C11-196 are now suppressed for regular
native WebGPU models without removing picking or borrowing/relabeling the
legacy map. `Model.update` snapshots the MODEL feature renderer once before
feature-table work and reuses that owner for build and submit. The explicit law
retains legacy realization for post-process and whenever a native
non-classifier model does not own dense picking. Omitted demand preserves the
old pass-derived default, so WebGL, classic `Cesium3DTileBatchTable`,
classifiers, styling, and synchronous first-pick behavior remain intact.

Same-count replacement now keys native dense resources by exact `BatchTexture`
identity and dimensions. A retired lookup texture and its superseded PickIds
live as one `_retiredFeaturePickGenerations` entry until every primitive marker
migrates. Scheduler failure retains the whole generation for retry; IDs release
only after submit-safe texture scheduling succeeds; teardown deduplicates
current and retired owners. This closes the premature-PickId-destruction P1
caught by the first re-audit. Final independent review is P0=0/P1=0 for this
bounded slice.

Node behavior/source/mutant contracts pass **16/16**. Edge/Karma passes
`BatchTexture` **25/25** (18,192 skipped), `ModelFeatureTable` **11/11**
(18,206 skipped), and final `WebGPUModelFeatureId` **23/23** (17,845 skipped).
Package TypeScript, targeted format/diff checks, and final integrated
`npm run build` (**83.2 s**) are green.

Final diagnostic artifact
`Tools/visual-regression/output/c11-202-batchtexture-pick-demand.json`
(`generatedAt=2026-08-11T05:44:02.186Z`) records `pass=true`, `exitCode=0`,
`failures=[]`, all source/lane checks true, and zero page/device errors. The
visible 30-feature fixture stays legacy/native pick-cold during WebGPU color.
First enabled pick creates zero legacy IDs/textures/uploads and exactly one
generic + 30 native dense IDs + one native lookup texture/upload, then returns
exact feature 28 and all eight expected properties. Repeat/later color creates
nothing new. Fresh `allowPicking=false` remains all-zero/no-hit. WebGL control
preserves exactly 30 legacy IDs and one 120-byte texture/upload on first pick,
the exact feature, and stable repeat/later color. The post-artifact source fix
changes replacement/failure lifetime only, so this steady-state artifact
remains valid without rerun.

The write-once first red
`c11-202-batchtexture-pick-demand.first-red.json`
(`generatedAt=2026-08-11T05:40:05.977Z`, exit 2) is harness-owned: its brittle
source substring missed a formatted forwarding call, and WebGL `pickAsync`
timed out. The final probe accepts the formatted source and uses synchronous
WebGL `scene.pick`; product allocation, feature, stability, and error gates were
not weakened.

This is still local/unlanded and not broad C11-202 completion. Adjacent **P1**:
mutable `featureIdLabel` / `instanceFeatureIdLabel` selection can retain stale
native feature entries/instancing buffers across descriptor reset and needs a
submit-safe rebuild. **P2:** paired IDs release after texture scheduling rather
than after an overlapping issued `pickAsync` readback settles; async owner
replacement/destruction remains uncertified. **P2:** an unbound retired
generation without later promotion drains only at another ensure/promotion or
final teardown. Broad descriptors, remaining legacy CPU objects, moving-route
measurement, edge-emitter RTE, post-process ownership, and recovery remain open.

## Campaign 11 next-work audit

The earlier audit's demand-priority defects are now closed locally by C11-193C,
not merely documented. The primitive-phase coordinator supplies the missing
two-phase offer/drain; HIGH/UNKNOWN runs before NORMAL, split-2D can promote a
held NORMAL job, MANDATORY does not consume the ordinary slot, deferral resumes
losslessly, and fairness advances only after submission. Regional/weather
outputs remain manager-local and the browser discriminator proves simultaneous
manager isolation rather than creating a shared-output cache.

**C11-193A/B/C are safe local/partial checkpoints: LOCAL IMPLEMENTATION +
FOCUSED EDGE + C11-193B/C REAL BROWSER GREEN; LANDING/PERF ATTRIBUTION/BROADER
RECOVERY OWED — NOT COMPLETE.** A retains the transactional IBL graph, B closes
the unsafe shared-submission/lease boundary, and C closes same-frame priority
and budget semantics. B's first real browser gate is 19/19; C's final gate is
29/29 after 56/56 Node, 31/31 focused Edge, TypeScript, and the 79.7 s build.
The dedicated sections carry exact pass, telemetry, identity, artifact, and
first-red evidence.

Do not overread those gates. Moving causal performance, persistent HQ reuse,
broader device-loss/replacement, reentrant and cross-context manager lifetime,
multi-context/multiview acceptance, inherited raw-cubemap exceptional recovery,
short-lived descriptors/lookups, and GPU-completion proof remain open. The
browser resume lane proves next-frame service without sustained contention;
the Node suite owns alternation/escalation. These are completion boundaries,
not grounds to undo the local architecture or claim an FPS win.

**C11-196 is likewise a local/partial checkpoint: LOCAL IMPLEMENTATION +
FOCUSED EDGE + DIAGNOSTIC BROWSER GREEN; LANDING/MOVING-PERFORMANCE OWED — NOT
COMPLETE.** Native pick resources stay cold through ordinary color work and
promote synchronously and atomically on first pick. Its historical 30
`BatchTexture` registry IDs in the disabled fixture remain preserved as the
evidence that motivated C11-202, not native C11-196 work.

**The bounded C11-202 gate is now also a local/partial checkpoint: LOCAL
IMPLEMENTATION + FOCUSED EDGE + DIAGNOSTIC BROWSER GREEN; LANDING/BROAD
DESCRIPTORS/MOVING-PERFORMANCE OWED — NOT COMPLETE.** It closes those legacy
IDs for regular native models while preserving WebGL/classifier/post-process
ownership and styling. It does not close mutable feature-label source
invalidation, async readback settlement, broad descriptors, or recovery.

At resume, land the frozen local checkpoints before expanding scope; do not
rerun unchanged green browser evidence. Do not combine C11-193 with traversal/
SSE changes or claim an FPS win from C11-193A/B/C, C11-196, or C11-202.
C11-205's lifecycle, attribution,
and causal measurement gates are green locally. C11-169 exact whole-frame and
default-globe nested attribution are local and diagnostic-browser green; land
that checkpoint, then apply the phase/sub-phase instrument to C11-205's
resident San Francisco workload before choosing remediation. Keep the default
globe as a control and verify any result with an uninstrumented causal lane. Do
not call either instrument a performance win. Zero GPU timing samples in the C11-205
causal run mean no GPU-bottleneck
inference is available. C11-140 now has a green
supported-adapter timestamp artifact, so later GPU-lane measurements may cite
that accounting contract once the local probe fix/artifact is landed. C11-214 is
still an instrument-first shared-cause diagnosis, not authorization to patch
feature-ID handling speculatively.

After the frozen local work lands, the Campaign 11 implementation ranking is:

1. **C11-169 landing and resident-workload attribution** — land the exact
   11-phase ledger, nested default-globe diagnostic, and both green artifacts.
   Then attribute the resident C11-205 San Francisco route with the default
   globe as a control, select only an evidence-led remediation, and run an
   uninstrumented causal measurement.
2. **C11-193A/B/C cohesive landing** — land the frozen source/spec/probe/
   evidence set without broadening it. B and C browser gates are green; do not
   spend another run on the unchanged build.
3. **C11-193 moving causal attribution** — run the canonical moving workload
   only after landing and compare exact work plus CPU/GPU/wall evidence. Assign
   no credit from pass-count/submission shape alone.
4. **C11-196/C11-202 bounded landing and C11-202 continuation** — land both
   frozen slices, then close mutable feature-label/table-source
   invalidation with submit-safe native resource retirement, then measure the
   remaining frontend tax on the moving route before selecting another broad
   descriptor optimization.
5. **C11-193 broader continuation** — address recovery/HQ reuse and residual
   descriptor/lookup churn only after attribution identifies value.
6. **C11-209 landing** — land the frozen local source, focused spec, hardened
   probe, and green 16/16 artifact together. Browser startup/device acceptance
   is already discharged; preserve all eleven clears and assign no timing
   credit without measurement.

## Exact resume order

1. Confirm no agent or command is still running, then preserve the dirty tree.
2. Re-run the focused offline/build gates if the tree changed:

   ```powershell
   node --test Tools/visual-regression/moon-globe-depth-routing.spec.mjs
   node --test Tools/visual-regression/webgpu-pick-center-identity.spec.mjs Tools/visual-regression/webgpu-voxel-resource-lifecycle.spec.mjs Tools/visual-regression/pointcloud-voxel-public-correctness.spec.mjs
   node --test Tools/visual-regression/cpu-frame-accounting.spec.mjs Tools/visual-regression/webgpu-frame-accounting-policy.spec.mjs Tools/visual-regression/cpu-scene-phase-integration.spec.mjs
   node --test Tools/visual-regression/environment-refresh-priority.spec.mjs Tools/visual-regression/environment-refresh-drain.spec.mjs
   node --test Tools/visual-regression/model-lazy-pick-demand.spec.mjs
   node scripts/__tests__/karmaTestRun.spec.mjs
   npm run tsc --workspace @cesium/engine
   npm run build
   git diff --check
   ```

3. Start the Node dev server hidden, verify `http://localhost:8080`, and keep
   the same frozen `Build/CesiumUnminified` for all certifying runs.
4. C12-37 Playwright is green on the current frozen build. Re-run it only if
   that build or its source changes:

   ```powershell
   $env:PROBE_BASE='http://localhost:8080'
   node Tools/visual-regression/probe-moon-globe-depth-occlusion.mjs
   ```

   Accept only a true WebGL+WebGPU pass. A structural result for the supplied
   record is expected; a structural derived overlap or forced-multifrusta lane
   is not. The current artifact meets this gate.

5. The new Moon Jasmine specs are green on this build (4/4 + 1/1), and the
   C11-133 ten-run EdgeHeadlessCI gate is green (10/10 serial runs, 15 executed
   successes per run, zero new selected profiles). Re-run either only if its
   source, launcher policy, or frozen build changes. Do not hide launcher
   failures behind `failTaskOnError=false`.
6. C11-140's supported-adapter timestamp probe and all three C11-205 browser
   gates are green on this frozen build: lifecycle v2, full exact-work API
   attribution, and separate non-instrumented causal r6. Do not rerun them unless
   the harness, renderer source, or frozen build changes. Land their local
   changes/evidence together with the reviewed C11-193A/B/C, C11-196, and bounded C11-202
   checkpoints, then begin C11-168 attribution with C11-169; do not assume a GPU
   bottleneck. C11-193B shared-submit and C11-193C demand-priority browser gates
   are green. Do not rerun either on this unchanged build; land them, then use
   the moving route for causal attribution. Broader recovery/HQ reuse and
   multi-context/multiview acceptance remain open. C11-196 and C11-202 likewise
   still owe landing and moving-route measurement; broad C11-202 remains open.
   Remaining browser acceptance also includes point-cloud EDL parity and voxel
   pick/parity.

   Never reuse one output filename. Exit 3 means residency/instrumentation is
   incomplete; exit 1 with ready-set divergence is a real finding and must not
   be relaxed.
7. C11-169's coarse and nested browser artifacts are green on the frozen build.
   Do not rerun them unchanged. If Scene, the WebGPU renderer/profiler, or the
   relevant probe changes, rerun:

   ```powershell
   node Tools/visual-regression/probe-webgpu-frame-breakdown.mjs
   node Tools/visual-regression/probe-c11-169-primitive-breakdown.mjs
   ```

   Accept only 180/180 conserved moving samples across all 8 route segments,
   all 11 fixed phases positive, exact target movement in all four 8 ms paired
   controls with named work in both arms, exact suppression/multi-frustum/2D/
   pick negatives, zero unattributed/overlap/residual, and zero errors. The
   nested acceptance requires 120/120 samples over 8/8 segments, exact
   primitive/detail equations, and all four 12-pair 8 ms detail controls. Its
   current `globeTilesLoaded=false` / three-pending-request result is a valid
   streaming/default-globe diagnostic, not resident-scene performance evidence.
   Land the source, focused tests, probes, and evidence together, then use the
   resident C11-205 San Francisco route for the next attribution. Keep both
   `diagnostic-noncausal`; asynchronous GPU work is excluded and neither timing
   may become an FPS claim.
8. C11-193B/C, C11-196, and bounded C11-202 are green on the current frozen
   build. Land each exact source/spec/probe/evidence set cohesively; rerun only
   if its source, probe, or build changes. **Do not spend another browser run on
   C11-193C before landing/performance attribution:**

   ```powershell
   node Tools/visual-regression/probe-c11-193b-shared-submit.mjs
   node Tools/visual-regression/probe-c11-193c-demand-priority.mjs
   node Tools/visual-regression/probe-c11-196-lazy-pick-demand.mjs
   node Tools/visual-regression/probe-c11-202-batchtexture-pick-demand.mjs
   ```

   C11-193B requires 19/19, two 44-pass manager sequences on one Scene
   encoder/submit, one 44-pass topology replacement on one Scene submit, zero
   private submissions, and zero error gates. C11-193C requires 29/29: HIGH/
   NORMAL 44/0 under budget 1, resumed NORMAL 44, MANDATORY+HIGH 88 sharing one
   Scene submit, wrapped-2D 0 then 44 on the continuation encoder, stable zero-
   work repeats, exact pending/scope/commit/arena/buffer settlement, isolated
   outputs, no private submit, and zero errors. Preserve its Tools-only first
   red and final schema/run/hash. C11-196 requires explicit
   `pass=true`/`exitCode=0`, cold native 0/0/0/0, synchronous first-pick
   1/30/1/1, stable zero-delta repeat/later-color lanes, and a native-zero/no-hit
   `allowPicking=false` lane. Preserve its historical 30 legacy
   `BatchTexture` calls as the evidence that motivated C11-202; do not rewrite
   the old artifact. C11-202 requires WebGPU cold/disabled legacy+native zero,
   enabled first pick with zero legacy and exact 1+30 native IDs/one native
   texture, WebGL exact 30 legacy IDs/one texture, exact feature 28/properties,
   stable repeat/later color, and zero error gates. Its focused retirement
   suite is 23/23; do not call broad C11-202 complete while mutable selected-
   source invalidation and async readback settlement remain open.
9. C11-209's focused Edge suite is green **5/5** and its hardened real-browser
   startup/device artifact is green **16/16** with all eleven clears, one
   encoder/finish/command buffer/submit, exact subresource provenance, exact
   zero repeat work over 24 visible frames, and zero error gates. Land its
   frozen source, focused spec, probe, and evidence together. Do not infer a
   timing win from submit shape.
10. Run the C13 U2 frozen cross-build A/B exactly as preregistered in
   `probe-cloud-u2-perf.mjs`: final local snapshot versus the same snapshot
   with only `ProceduralClouds.wgsl` restored pre-U2, two rounds with reversed
   order, BAKED and LIVE routes, default CUMULUS identity and CIRRUS affected-
   pass performance. Do not substitute a same-bundle cloud-type toggle.
11. Only after artifacts are read, update queue canonical rows and ledger mirrors
   consistently. Use `LOCAL` until mechanical landing; use `COMPLETE` only when
   the campaign's actual exit gate is met.

## Documentation reconciliation owed

- Campaign 12: change C12-37 from implementation-in-flight to
  `LOCAL + BROWSER/KARMA GATES GREEN`; only landing remains owed. Update its
  bottom ledger mirror consistently.
- Campaign 11: C11-133, C11-140, and C11-205 still require the previously
  recorded landing/remediation work. C11-193A/B/C, C11-196, and bounded C11-202
  reconciliation is now current in this handoff, the queue canonical row and
  aggregate mirror, `DEFERRED_WORK.md`, and the dated debugging log. Preserve their `LOCAL`
  status. C11-193B has focused and 19/19 shared-submit evidence; C11-193C has
  56/56 Node, 31/31 focused Edge, TypeScript/build, and final 29/29 real-browser
  demand-priority evidence. C11-193 still owes landing, moving causal
  performance, and broader recovery/HQ reuse. C11-196 has focused and diagnostic-browser
  evidence but still owes landing and moving performance. Its historical 30
  disabled-lane legacy `BatchTexture` calls remain explicit C11-202 evidence,
  not a hidden pass and not native renderer work. The bounded C11-202 gate now
  removes them from regular native WebGPU while preserving WebGL; it still owes
  landing/moving evidence, mutable selected-source P1 work, async-readback and
  idle-retirement P2 work, and broad descriptors. Do not close C11-193,
  C11-196, C11-202, or C11-205.
- Campaign 11 C11-169/C11-209 reconciliation is also current in this handoff,
  the queue canonical rows and mirrors, `DEFERRED_WORK.md`, and the dated
  debugging log. Preserve their `LOCAL` status: C11-169 still owes landing,
  resident San Francisco/C11-205 phase attribution, evidence-led remediation,
  and an uninstrumented causal measurement; its default-globe nested split is
  green but streaming-contaminated. C11-209 has focused and real-browser
  startup acceptance green and now owes only landing. Neither row has earned a
  measured performance-win claim.
- Campaign 13: U2 source/model is local and green, but browser visual and
  cross-build performance gates remain mandatory.
- Keep the point-cloud `165 KB` statement as source-geometry/eviction
  accounting, not total WebGPU residency; the expanded GPU/CPU buffers are not
  yet included in the cap.
- Do not rewrite historical handoffs to describe unlanded work. Update the
  authoritative queue row, its ledger mirror, `DEFERRED_WORK.md`, and a dated
  `WEBGPU_DEBUGGING_LOG.md` implementation note together after evidence.

## Non-negotiable cautions

- Do not remove or silently disable EDL, clouds, Moon, globe, picking, TAA,
  bloom, logarithmic depth, multi-frustum rendering, or WebGL parity to make a
  performance number green.
- Do not put conversion, resource creation, pipeline compilation, or private
  submission back into a draw hot path.
- Do not use idle soak FPS as evidence; use the existing moving-camera/
  altitude route because Cesium pauses unchanged scenes.
- Do not use Python for browser automation or benchmarking.
- Do not stage, commit, push, stash, reset, or clean this tree without an
  explicit maintainer request.
