# Campaign-11 Cluster Guide G9 — Test Infrastructure / Suites / Certification (16) + Build Variants / TS-Debt / Define-Width / Boot-TTFF (13)

**Anchors verified 2026-07-18 against committed HEAD `9204647535` (Batch 701, `main`).** The
working tree is concurrently edited by a C10 worker (engine boot files — C10-06 is landing now);
every anchor below was grepped against the COMMIT (`git show HEAD:<path>` / `git grep <pat> HEAD`),
NOT against the tree. **Line numbers are hints keyed to that hash; the symbol name is the
contract — re-grep by symbol before editing.** Several register rows were written at the earlier
sweep HEAD `aef553d592` (Batch 698) and have drifted or gone stale; every item below carries a
mandatory premise-verify Step 0, and the two register rows that are **factually wrong at HEAD**
(`WebGPUComputePipelineCache` "doesn't exist"; `WebGPUModelRenderer` "JS, 3802 LOC") are flagged
PREMISE-DRIFT with the corrected scope.

**Sources:** `migration_doc/campaign11_planning/CANDIDATE_REGISTER.md` clusters 20 (`test-infra`)
+ 21 (`build-boot`); house format per `migration_doc/CAMPAIGN10_EXECUTION_GUIDE_2026-07-16.md`
H1–H3 + QUICK START; style siblings `G1-pick-and-reds.md` + `G4-model-frame-delta.md`; charter
`CLAUDE.md` (repo root). Items are referred to ONLY by their existing register names — the
orchestrator assigns C11 numbers at assembly. **No C11-XX number is invented anywhere in this
guide.**

**Model-tier legend:** `fable` = diagnostic / ambiguous / bisect / environment-archaeology work;
`opus-or-sol` = well-specified execution against this guide (sol-class judgment noted where API
taste or public-contract discipline matters).

**Charter rules restated (never weaken):** premise-verify-first (mandatory Step 0 every item);
probe-first per Principle 8 for any visually-verifiable change (no "reload and check" round-trips);
one concern per slice; no feature removal / default-disable / degradation for a metric; RTE
precision rules; Playwright+Edge only (no Firefox — no WebGPU); perf evidence ONLY from the moving
multi-altitude route (idle soak invalid); ShaderDefine registry is **add-only, never reorder /
renumber / remove**; promotion bar ≥10% whole-route / ≥15% near-ground WebGPU CPU-p95 vs the
predeclared anchor OR >3× measured noise — a truthful miss with green mechanics is VALID COMPLETE.

> **This is the campaign's PLUMBING guide.** Almost nothing here renders pixels; it builds the
> environment, gates, and toolchain that *every other C11 cluster's evidence depends on*. Two
> consequences: (1) the three environmental fix-first items (Karma launcher, spec-bundle
> freshness, offline isolation) should be scheduled in **W1 of Campaign-11**, because until the
> full suite can hold a headless session every "spec green" claim campaign-wide is unfalsifiable;
> (2) the `C8-SHARED-UPSTREAM-CONTRACT-GATE` (item 72) is the **intended Campaign-11 EXIT GATE** —
> it is the campaign closer, designed as such in §A.16, and it cannot close until its four owner
> items (66/67/69/70) land and the environment is stable.

---

## 0. MANDATORY INTAKE — C10 dependencies + the exhausted-registry prerequisite (read before scheduling ANY item)

A C10 worker is running concurrently. As of `9204647535` (Batch 701) the boot/compile wave is
in motion. The first action of whoever executes either cluster is this deterministic intake check:

```bash
git log --oneline -30 | grep -iE "C10-0[678]|TTFF|boot|prewarm|async.*pipeline|specialization|define-width"
grep -nE "C10-0[678]" migration_doc/QUEUE_2026-07-16_CAMPAIGN10.md   # §3.2 ledger status rows
git branch -a                                                        # branch-transparency (CLAUDE.md)
```

Decision table (apply per affected item):

| C10 task | Sweep state (register UNKNOWNS §, Batch 698) | Intake consequence for these clusters |
| --- | --- | --- |
| **C10-06** (TTFF boot concurrency + prewarm) | LANDING NOW at Batch 701 | Determines whether `S8-4` (FR-registration lazify) is **absorbed** into C10-06 or becomes the standalone `build-boot` remainder (§B.6). Read its ledger row + the `WebGPUFeatureRenderers.ts` diff FIRST. |
| **C10-07** (async model pipelines) | NOT STARTED at sweep | Interacts with `S8-5/S3-7` module granularity (§B.3): a per-pass entry-point split changes what "one pipeline compile" costs. Sequence S8-5 AFTER C10-07. Also gates the batch-texture define-flip async-compile fallback (see model-frontend guide S11-1). |
| **C10-08** (model runtime-flag specialization, banks the **ONE free ShaderDefine slot** = bit 31) | NOT STARTED at sweep | **HARD PREREQUISITE for `C10-08b` (§B.2).** C10-08 proves the specialization mechanism and consumes bit 31 (`1 << 31`, the last Uint32 slot). Until it lands, `C10-08b` (define-width expansion) has no proven mechanism to widen. After it lands, the registry is **fully exhausted** and `C10-08b` is the hard blocker for *any* further define bit (Q31 varyings, KHR bits, skinning/morph/instancing/IBL/velocity axes). |
| **boot/TTFF remainder** beyond C10-06/07/08 | conditional | **INTAKE-CONDITIONAL** (§B "boot remainder" preamble). The remaining boot items (`S8-4`, `S8-5/S3-7`, `NEW-C9-01-COUNTER-PRAGMA-STRIP`, leaf-strip) are written *conditionally on the C10-06/07/08 outcomes* — do not open any of them until the three C10 boot rows are marked COMPLETE/PARTIAL and their residuals are swept. |

**The exhausted-registry fact (verified at HEAD, load-bearing for §B.2):** `ShaderDefine`
(`packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts`) occupies bits **0–30** —
verified highest live entry `MODEL_METADATA_MAT_TRANSPORT: 1 << 30` (:848). Bit 31 (`1 << 31`,
the Uint32 sign bit) is the single remaining slot, which **C10-08 banks**. The module-cache key
math `numericKey = (defines >>> 0) * 0x100 + sourceId` (`WebGPUShaderModuleCache.ts:108-113`,
verified, `sourceId` range-checked `0..0xff` at :97-98) reserves the low 8 bits for `sourceId` and
represents the full Uint32 define mask exactly as a safe integer. **Any 33rd define bit requires
`C10-08b` to widen both the registry representation AND this key math first** — this is not
optional, it is a build-break otherwise (§B.2 designs it).

---
---

## PART A — `test-infra` cluster (16 items)

The cluster theme: the fork's spec suites, visual-regression gates, GPU-timing tooling, and the
upstream-contract certification are the substrate every other cluster's evidence rests on. The
substrate has three cracks — a flaky headless-Edge launcher, a stale-spec-bundle trap, and
network-dependent specs that die in the sandbox — and one un-closed exit gate. **Fix the three
cracks first; then land the four broad-suite owner correctness items; then close the exit gate.**

**Intra-cluster sequencing (hard):**
`Karma-launcher` + `NEW-WORKSPACE-SPEC-BUNDLE-FRESHNESS` + `NEW-FULL-SUITE-OFFLINE-DEPENDENCY-ISOLATION`
(the environment, W1) → `item 66` (cheapest owner) · `item 67` · `item 69` · `item 70` (the four
`item 72` owners, any order) → `item 64` remainder → **`item 72` = EXIT GATE**. The certification
tooling (`C9-03`, `C9-04`, `C9-05`, `C9-02`) rides alongside; `C9-01`/`S8-7`/`gate-F-refresh` are
independent S-class riders.

---

### A.1 Karma headless-Edge launcher environmental flakiness (no ID) — P1 · unknown · **FIX-FIRST INFRA** · fable

#### What + why (evidence trail)

Register cluster-20 row (verbatim intent): "Real-scene suites kill headless Edge within seconds;
focused runs carry trailing exit-1 / 'Chrome failed' artifacts; **B693 session launcher outright
broken** (C10-01 spec verification skipped). Stabilization multiplies the value of items 64/70/4A."
Cross-confirmed by the C10 guide QUICK START #9 ("a trailing 'Chrome failed' after SUCCESS is a
launcher artifact — trust the exit code") and the C10-01/C9-17/C9-16 ledger rows that each recorded
skipped or aborted Karma spec verification. This is the single highest-leverage item in the cluster:
**every "spec green" claim in Campaign-11 is unfalsifiable until this is certified**, and the exit
gate (A.16) literally cannot run.

#### Architecture today (verified at HEAD `9204647535`)

- `Specs/karma.conf.cjs` — the launcher contract is DOCUMENTED IN THE FILE, which is the starting
  material:
  - `EdgeHeadlessCI` custom launcher (:112) uses **`base: "Chrome"`** (not `"ChromeHeadless"`) so
    the flag set is controlled fully (:113-118 comment); flags include `--headless=new` (:119) and
    "mirror the Playwright probe args (channel msedge + headless)" (:124).
  - The invocation contract (:8-12 comment): run with BOTH `--browsers=EdgeHeadlessCI` AND
    `CHROME_BIN=<path to msedge.exe>` — "Karma's Chrome launcher honors CHROME_BIN; Edge is
    Chromium so it runs the same launcher; without CHROME_BIN it falls back to Chrome, which isn't
    installed" (the `feedback_gulp_test_edge` memory).
  - **The exact flakiness root cause is already written down** (:16 comment): "surviving Edge
    owning an old profile is the real back-to-back 'Chrome failed'…"; and (:142) "Edge consolidates
    into a single process; concurrent launches collide." Default `browsers: ["Chrome"]` (:145).
  - Serves ROOT `Build/Specs/karma-main.js` + `Build/Specs/SpecList.js` (:64-66) via `proxies`
    (:69-72).
- `scripts/karmaTestRun.js` — the gulp `test` task's Karma driver (imported by `gulpfile.js:22`).
- `Specs/karma-main.js` — sets `window.CESIUM_BASE_URL` to `base/Build/CesiumUnminified` (:25).

#### Diagnostic protocol (this is a FIX-FIRST INFRA slice — one concern: make the launcher deterministic)

**Step 0 — reproduce the three distinct failure modes separately (they are NOT one bug).** Fix the
protocol before touching config: run a focused suite (`--includeName ShaderBuilder`) and a
real-scene suite (`--includeName Scene/`) each ×5, headless Edge, recording per-run:
{exit code, TOTAL_SUCCESS-vs-not, trailing "Chrome failed" present, wall time to first-disconnect}.
Classify into the three documented modes: **(M1)** profile-collision back-to-back launch (:16) —
a surviving Edge process owns the profile → the next launch's "Chrome failed"; **(M2)** the
**shutdown-disconnect-after-TOTAL-SUCCESS artifact** — Karma reports `TOTAL: N SUCCESS` then the
browser disconnect races the process exit, yielding a spurious exit-1 the harness must ignore
(this is the "trust the exit code / trust the SUCCESS line" case); **(M3)** real-scene suites
killing headless Edge within seconds (a genuine crash — likely GPU/resource, ties to A.4's
sandbox real-GPU instability cluster). Each mode has a different fix; conflating them is why prior
sessions "skipped verification" instead of fixing it.

**Step 1 — M1 (profile collision): serialize + isolate profiles.** Give each launch a unique
`--user-data-dir` (temp, cleaned per run) and ensure the prior Edge process is reaped before the
next launch (`browserDisconnectTimeout` / `browserNoActivityTimeout` tuning + an explicit
pre-launch pkill of stray `msedge --headless` on the CI path). The (:142) single-process
consolidation is the mechanism — a per-run profile dir breaks the collision.

**Step 2 — M2 (post-SUCCESS disconnect): make the exit code truthful.** The harness fix is to key
success on the **Jasmine TOTAL line**, not the process exit code, when a disconnect follows a
recorded TOTAL_SUCCESS. Prefer fixing `scripts/karmaTestRun.js` to resolve on Karma's
`run_complete` result object (`results.failed === 0 && results.exitCode`-independent) rather than
the child-process exit — so downstream automation (the exit gate, every campaign spec run) gets a
truthful boolean. Document the contract in the file header + `DEBUGGING_GUIDE.md`.

**Step 3 — M3 (real-scene crash): quarantine, don't mask.** If real-scene suites genuinely crash
headless Edge, that is A.4 (physical-adapter) + A.3 (offline isolation) territory — do NOT paper
over it by excluding suites silently (Principle 9). Split the suite lanes: a **focused/unit lane**
(deterministic, headless, the common case) and a **real-scene lane** (may need `--headed`, a real
adapter, or the offline fixtures from A.3). Record which suites are in which lane. The exit gate
(A.16) then runs the focused lane green + reports the real-scene lane's executed/skipped counts
truthfully.

**Step 4 — hand off.** Deliverable: a launcher that produces a **deterministic exit code** on the
focused lane ×10 consecutive runs, the M2 truth-contract documented, and the M3 quarantine lane
enumerated. Ledger it + update `DEBUGGING_GUIDE.md` (keep the guide in sync — CLAUDE.md) and the
`feedback_gulp_test_edge` memory conventions.

#### Traps (these ARE the known environmental issues — carry them into EVERY test-infra item)

1. **Trust the SUCCESS line, not the exit code** (M2). A trailing "Chrome failed" / exit-1 AFTER
   `TOTAL: N SUCCESS` is the launcher artifact — never re-run or re-diagnose on it.
2. **`--concurrent 1` during merges** (`feedback_lint_staged_large_commit`): large merge commits
   OOM-kill the pre-commit hook — serialize lint-staged with `--concurrent 1` (NOT `--concurrency`)
   locally, revert after; NEVER `--no-verify`. This is a commit-time env trap that bites any
   test-infra batch that also lands doc/spec churn.
3. **`CHROME_BIN` must point at the Edge binary** or Karma falls back to Chrome (not installed) —
   the "Chrome failed" you get without it is a different failure from M1's profile collision.
4. **Concurrent C10 worker** is editing boot files — run Karma against a pinned commit / clean
   tree, never the shared dirty tree; `git status --short` and attribute every dirty file first.
5. **Machine safety** (`feedback_review_scripts_for_loops` + the 2026-07-06 crash note): headless
   Edge + WebGPU probes have spiked this machine; keep launch loops sequential, never parallel
   browsers, and pre-scan any generated runner for unbounded loops.

#### Verification recipe

| # | Check | PASS means |
| --- | --- | --- |
| 1 | Focused lane (`ShaderBuilder` + `ShaderStruct`) ×10 consecutive | 10/10 deterministic exit code; zero M1 collisions |
| 2 | M2 truth-contract | a post-SUCCESS disconnect resolves the run as PASS with a logged note |
| 3 | Real-scene lane enumerated | every suite classified focused-vs-real-scene; no silent exclusion |
| 4 | Handoff | `DEBUGGING_GUIDE.md` + memory updated with the invocation contract |

**Model tier: fable** (environment archaeology + three-mode disambiguation is exactly the fable
profile). Effort: unknown — timebox the M3 chase; M1+M2 alone (the launcher determinism) is the
minimum viable deliverable and unblocks the rest of the cluster. **This item is worth scheduling
even if only M1+M2 land** — it converts every downstream spec claim from unfalsifiable to trustworthy.

---

### A.2 NEW-WORKSPACE-SPEC-BUNDLE-FRESHNESS (item 4A) — P1 · S · **FIX-FIRST INFRA** · opus-or-sol

#### What + why

Register cluster-20 (verbatim): "`gulp test --workspace engine` rebuilds ROOT specs while Karma
serves `packages/engine/Build/Specs` — new package specs can silently stay stale. Make the
workspace task rebuild/await the exact served bundle with a sentinel. Recurring trap worth closing
permanently." This is the trap the C10 guide QUICK START #9 works around by hand ("
`npm run build --workspace @cesium/engine` FIRST") and G4's C9-17 verification recipe repeats
("confirm the new spec NAMES appear in Karma output"). Every guide copies the workaround into its
recipe because the trap is never closed — that is exactly the recurring-cost pattern the register
flags. **Close it once.**

#### Architecture today (verified at HEAD)

- `gulpfile.js` `build` task (:110-135): `--workspace @cesium/engine` → `buildEngine(buildOptions)`
  (:122-124). The spec bundle (`SpecList.js`, `karma-main.js`) is produced by the engine build /
  spec-list generation, but the gulp `test` task and the `build --workspace` task are **separate
  invocations** with no freshness handshake between them.
- `Specs/karma.conf.cjs:64-66` serves ROOT `Build/Specs/karma-main.js` + `Build/Specs/SpecList.js`.
  **The drift:** a package-local spec added under `packages/engine/Specs/**` is only reflected in
  the served ROOT bundle after the spec-list regen runs — the workspace `test` task can serve a
  stale `SpecList.js` that omits it, so a brand-new spec "passes" by never running.
- `scripts/karmaTestRun.js` is the driver — the sentinel handshake belongs here or in the gulp
  `test` task that calls it.

#### Implementation walkthrough

**Step 0 (premise):** add a brand-new trivial spec (`expect(true).toBe(false)` in a fresh file
under `packages/engine/Specs/`), run `gulp test --workspace engine` WITHOUT a prior
`npm run build --workspace @cesium/engine`, and confirm it does NOT fail (i.e. is not in the served
`SpecList.js`) — that reproduces the trap. Then confirm it DOES fail after the manual build. That
delta is the bug and the acceptance oracle.
1. **Sentinel:** have the spec-list generation stamp a content hash / manifest of the source spec
   set it built from (e.g. a `SpecList.meta.json` with a sorted-filename+mtime digest). The
   `test`/`karmaTestRun` path computes the same digest from the on-disk `packages/*/Specs/**` set
   and **rebuilds-and-awaits** the served bundle if they differ (or fails loudly with the exact
   stale filenames — "typos fail loudly, not silently", the preprocessor's own principle).
2. **Await the exact served bundle:** the workspace `test` task must depend on the spec-bundle
   build completing (gulp series, not parallel) — the current gap is the missing dependency edge.
3. **Preserve the fast inner loop:** when the digest matches, skip the rebuild (do not force a full
   rebuild every `test` invocation — that regresses the dev loop; the sentinel's whole value is
   rebuild-ONLY-on-staleness).

#### Traps

1. The digest must include **added AND removed** spec files (a deleted spec that lingers in a stale
   `SpecList` is the mirror failure).
2. Do not couple this to the full engine build — the spec bundle is a narrower artifact; rebuilding
   `Build/CesiumUnminified` on every `test` is the sledgehammer the QUICK START workaround already
   is. The sentinel targets `Build/Specs/*` freshness only.
3. **Karma-launcher interaction (A.1):** verify the "new spec NAMES appear in Karma output" check
   ONLY on the stabilized launcher — a flaky launcher can make a fresh spec *look* absent (M1/M2)
   when it is present. Land A.1 first, or at minimum use the focused lane.
4. Windows path-case + mtime granularity: use content hash, not mtime alone (mtime is coarse and
   git checkouts reset it).

#### Verification recipe

- The premise spec (Step 0) now FAILS on a bare `gulp test --workspace engine` (proving the served
  bundle is fresh); remove it after.
- A removed-spec case: delete a spec, run without manual build, confirm it is gone from the served
  set.
- Run the closure across BOTH workspaces (`engine`, `widgets`) — the widgets lane has the same
  shape and item 72 needs both green.
- Document the closure in `DEBUGGING_GUIDE.md` and **strike the manual workaround from the QUICK
  START pattern** so future guides stop copying it (that is the "close it permanently" deliverable).

**Model tier: opus-or-sol** (well-specified, bounded, mechanical). Effort **S** (1 batch). **High
schedule priority** — it is the cheapest of the three environment fixes and removes a footgun from
every other spec-touching item.

---

### A.3 NEW-FULL-SUITE-OFFLINE-DEPENDENCY-ISOLATION — P1 · M · **FIX-FIRST INFRA** · opus-or-sol

#### What + why

Register cluster-20 (C9Q §4 W0-8): "Isolate Ion / world-terrain / network spec cases into
deterministic local fixtures or an explicit online lane — direct unblocking dependency for the open
broad-suite items (64, 72)." The dev sandbox has no reliable outbound network (memory
`project_campaign7` + the `Live EDR network confirm` row's "no outbound network" note), so any spec
that reaches Ion / Cesium World Terrain / an arbitrary tile server is nondeterministic — it either
times out (contributing to A.1's M3 crashes) or passes only when the network happens to be up.
Item 72 (the exit gate) can never report truthful executed/skipped counts while network specs
randomly time out.

#### Architecture today (verified at HEAD)

- The specs live throughout `packages/engine/Specs/**`; the network dependencies surface as `Ion`
  token usage, `createWorldTerrainAsync` / `IonResource`, and hardcoded provider URLs. (Grep the
  spec tree at intake: `git grep -lnE "IonResource|createWorldTerrain|assets.cesium.com|ion.cesium" HEAD -- packages/engine/Specs`
  to enumerate the exact offenders — the register does not pin the list and it drifts.)
- `Specs/karma-main.js` sets `CESIUM_BASE_URL` to `Build/CesiumUnminified` (:25) — local assets are
  already served; the gap is external hosts.

#### Implementation walkthrough

**Step 0 (premise + enumeration):** run the grep above; classify each hit as (a) fixture-able
(a fixed small asset that can live under `Specs/Data/`), (b) mockable (intercept the request with a
local fixture response), or (c) genuinely-online (needs a real service — belongs in the explicit
online lane). Record the count in each bucket; that IS the scope.
1. **Local fixtures for (a):** snapshot the minimal asset (a single terrain tile, a small imagery
   tile) into `Specs/Data/`, repoint the spec. Deterministic, offline, fast.
2. **Request interception for (b):** the fork already mocks network in places (KML uses fixtures
   per A.14) — extend the pattern; assert the spec runs with the network *disabled* (a fetch guard
   that throws on any unmocked external host makes leakage loud, not silent).
3. **Explicit online lane for (c):** tag these specs (`--includeName`-selectable or a describe-block
   marker) and EXCLUDE them from the default/focused lane; the exit gate reports them as SKIPPED
   with the reason "requires network" — a truthful skip, not a silent pass (Principle 9).
4. **Fetch guard:** in the offline lane, install a global guard that fails any request to a
   non-`base/` host, so a newly-added network spec fails loudly the day it lands (the freshness
   principle again).

#### Traps

1. Do not delete online-only coverage — quarantine it (Principle 9 / feature-preservation). The
   deliverable is an explicit lane, not fewer tests.
2. Fixtures must be **byte-stable** — a re-downloaded "same" tile with different bytes reintroduces
   nondeterminism; commit the exact bytes.
3. **A.1 interaction:** M3 real-scene crashes partly ARE network timeouts — landing A.3 shrinks A.1's
   M3 set. Sequence A.3 alongside A.1's Step 3 (the real-scene lane split).
4. License / attribution on snapshotted assets — use NaturalEarthII-class already-in-tree assets
   where possible (the probes already do, e.g. `probe-pickposition-webgpu`'s local imagery).

#### Verification recipe

- Offline lane runs with the fetch guard armed: zero external requests, deterministic pass/fail.
- The (c) online lane, run once WITH network, still passes (coverage preserved).
- Exit-gate dry run (A.16) reports non-zero SKIPPED with truthful reasons.
- `capture-and-diff` / probe lanes unaffected (they already use local assets).

**Model tier: opus-or-sol** (enumerate-then-fixture, bounded). Effort **M** (1–2 batches). Land in
W1 with A.1/A.2.

---

### A.4 C9-04-PHYSICAL-ADAPTER-CONTRACT-MATRIX — P1 · L · opus-or-sol (+ fable for instability triage)

#### What + why

Register cluster-20 (C9Q §4 W0-7): "Real-adapter matrix: WGSL validation, attachment/load-store
combos, HDR/MSAA, resize, multi-context, physical device loss, GC/lifetime plateaus, strict error
scopes. Owns the physical-loss half C9-02A deferred + the sandbox real-GPU instability cluster.
Was required by Gate G." This is the physical counterpart to the headless launcher work: A.1 makes
the *launcher* deterministic; A.4 characterizes what a *real adapter* does under the full matrix,
and owns the "real-scene suites kill headless Edge" (A.1 M3) crash triage on physical hardware.

#### Architecture today (verified at HEAD)

- `C9-04` is a NOT-STARTED tooling item — the deliverable is a **matrix harness**, not a code
  migration. The physical-loss surface it owns is referenced by `C9-02A` (pick guide A7) and
  `C-R12-PER-OBJECT-CACHES` (standing-reds — device-loss invalidation walk). The strict-error-scope
  machinery lives in `WebGPUContext.ts` (`pushErrorScope`/`popErrorScope` — grep `ErrorScope` at
  intake); the device-loss path in `ContextFactory.ts` + `WebGPUContext.ts` (`device.lost`).
- Existing physical-adapter probes to build on: `Tools/visual-regression/probe-*.mjs` run on Edge
  (real adapter) already — the matrix is a *structured sweep* over them, not a from-scratch build.

#### Implementation walkthrough

**Step 0 (premise + Gate-G status):** confirm with the orchestrator whether Gate G is still a C11
requirement (register says "was required by Gate G" — past tense; verify it is not obsoleted). Then
enumerate the matrix axes from the register row into a checklist; each axis is a probe or spec.
1. **WGSL validation lane:** every shader compiles clean on the real adapter with error scopes
   armed (zero validation errors across the shader fleet) — this is the strict-error-scope
   acceptance.
2. **Attachment / load-store / HDR / MSAA / resize combos:** a parameterized probe sweeping
   {SDR,HDR} × {MSAA1,MSAA4} × {resize} asserting no "attachment state not compatible" (ties to the
   standing-red `NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION`) — coordinate, do not fix that red
   here, just cover it.
3. **Multi-context:** two live contexts (split-screen page) — per CLAUDE.md Principle 3, each has a
   unique id; assert no cross-context resource bleed.
4. **Physical device loss:** the half C9-02A deferred and C9-04 explicitly owns — force a device
   loss (adapter reset / `device.destroy()`), assert the recovery walk reaches `model._webgpuCache`
   / `clippingPlanes._webgpuCache` (the `C-R12` gap) and no stale-resource crash. **This is the one
   axis with real correctness stakes** — the rest are characterization.
5. **GC / lifetime plateaus:** the residency-plateau assertions (byte-slope plateau over altitude
   loops) — shared shape with `C9-15` terrain residency; reuse its methodology.

#### Traps

1. **Sandbox may not survive the full matrix** (A.1 M3) — run the matrix on the stabilized launcher
   (A.1) and split into a headless lane (what survives) + a `--headed`/manual lane (device-loss,
   which some headless configs can't force). Report truthfully which axes ran where.
2. Device-loss is **destructive and machine-risky** — the recovery probe must be bounded, sequential,
   and pre-scanned for loops (memory rule); never loop device-loss in the background.
3. This is a **tooling/characterization** item — most axes produce a report, not a fix. Where an
   axis surfaces a real bug (device-loss stale cache = C-R12; MSAA-flip = the standing red), file it
   as a named item (Principle 9), do NOT fold the fix into the matrix.
4. Do not claim Gate G "passed" — claim the matrix ran and report each axis's result honestly.

#### Verification recipe

- Each matrix axis has a probe/spec with a recorded pass/skip + the adapter string.
- Device-loss recovery: `probe`-driven loss → recover → render one frame → no stale-resource error;
  `C-R12` gap either closed or filed.
- The matrix report is committed as an artifact (JSON) the exit gate can cite.

**Model tier: opus-or-sol** for the harness; **fable** for the M3 instability triage (ambiguous,
hardware-dependent). Effort **L** (2–3 batches). Sequence after A.1 (needs the stable launcher).

---

### A.5 NEW-SCENE-BROAD-SUITE-FAILURE-CLOSURE (item 64 / C8-30) — P1 · L · fable→opus-or-sol

#### What + why

Register cluster-20 (C9Q §9-64, PARTIAL/PAUSED, 3 of 5 product clusters fixed B674): "Remaining
owned clusters: WebGL1 async-pick routing (L), GLSL100 additional-light generation (L), env-map
irradiance oracle, renderer-neutral fixture contracts for real-scene suites, afterAll teardown."
This is the **broad-suite failure closure that feeds the exit gate** — item 72 cannot close while
item 64's remaining clusters fail. Note the WebGL1/GLSL100 clusters: the fork targets **WebGL2 only**
(CLAUDE.md Principle 4) — so "WebGL1 async-pick routing" and "GLSL100 additional-light generation"
are almost certainly **upstream spec cases exercising a path the fork does not maintain**; the
closure for those is likely a *documented skip*, not a fix (verify — Principle 9).

#### Architecture today (verified at HEAD)

- Item 64 is a spec-failure ledger, not a single symbol. The remaining clusters map to:
  - WebGL1 async-pick + GLSL100 additional-light → upstream `Scene/` + shader-generator specs that
    assume WebGL1/GLSL100 codegen. Grep the failing suite names at intake.
  - env-map irradiance oracle → `WebGPUDynamicEnvironmentMapManager.ts` (a `WebGPUComputePipelineCache`
    consumer, verified at HEAD) — the oracle asserting the irradiance/SH output is correct.
  - renderer-neutral fixture contracts + `afterAll` teardown → the real-scene suite hygiene that
    A.1 M3 and A.3 also touch.

#### Implementation walkthrough

**Step 0 (premise + classify):** run the item-64 suites on the STABILIZED launcher (A.1 must land
first — this item was PAUSED partly because the launcher couldn't hold the session). Classify each
remaining failure: **real fork bug** (fix), **WebGL1/GLSL100 unmaintained path** (documented skip
per Principle 4), or **fixture/teardown hygiene** (A.3-adjacent). Do not fix a WebGL1 codegen path
the fork deliberately dropped.
1. **WebGL2-only skips:** for the WebGL1/GLSL100 clusters, add explicit, reasoned skips (
   `xit`/`pending` with a comment citing Principle 4) — a truthful skip the exit gate counts, not a
   silent pass and not a fake fix.
2. **env-map irradiance oracle:** define the numeric oracle (SH coefficients / irradiance sample vs
   a reference) — this is a real correctness deliverable; wire it against `WebGPUDynamicEnvironmentMapManager`.
3. **Fixture contracts + teardown:** renderer-neutral fixtures (work on both backends) + `afterAll`
   teardown that releases GPU resources (prevents A.1 M3 resource-exhaustion crashes on long
   suites) — shared work with A.3/A.4.

#### Traps

1. **Principle 4 discipline:** the fork is WebGL2-only. Resist "fixing" WebGL1/GLSL100 specs —
   that re-adds a maintenance path the fork deleted. Skip-with-reason is correct.
2. **A.1/A.3 hard dependency:** this item was PAUSED because the environment couldn't hold the
   session — do NOT re-attempt it before A.1 (launcher) and A.3 (offline) land, or you repeat the
   pause.
3. The env-map oracle is the one real correctness deliverable — do not let the skip-classification
   work crowd it out; it is the input item 72's DataSources-classification depends on.
4. `afterAll` teardown that over-releases can crash later suites (shared context) — release per-suite
   resources, not the shared device.

#### Verification recipe

- Every remaining item-64 cluster is either GREEN (fixed) or SKIPPED-with-reason (documented) — zero
  RED, zero silent pass.
- The skip list is enumerated in the ledger with Principle-4 citations.
- env-map irradiance oracle committed + green.
- Run twice on the stable launcher for M2-artifact immunity.

**Model tier: fable** for the classify step (ambiguous real-bug-vs-unmaintained-path judgment),
**opus-or-sol** for the env-map oracle + fixture work. Effort **L** (2–3 batches). Sequence: after
A.1/A.3, before A.16.

---

### A.6 NEW-SHADER-GENERATOR-UPSTREAM-CONTRACT-PARITY (item 66) — P1 · S · opus-or-sol

#### What + why

Register cluster-20 (C9Q §9-66): "10 standing spec failures (ShaderBuilder 5 / ShaderFunction 3 /
ShaderStruct 2 — missing addLines validation + trailing empty line, pre-existing since B243).
Cheap, well-scoped; directly unblocks item 72." This is the **cheapest exit-gate owner** — a
tightly-bounded correctness fix that removes 10 standing reds from the upstream contract suite.

#### Architecture today (verified at HEAD)

- `packages/engine/Source/Renderer/ShaderBuilder.js` — `_functions` map (:67);
  `addFunctionLines`/`addFunction` build `new ShaderFunction(signature)` (:210) and call
  `this._functions[functionName].addLines(lines)` (:248). The register's "missing addLines
  validation" points here: `addLines` accepts input without the upstream validation (e.g. array-vs-
  string / defined-check) the upstream spec asserts.
- `packages/engine/Source/Renderer/ShaderFunction.js` + `ShaderStruct.js` — the "trailing empty
  line" divergence is in their `generateGlslLines`/`toString`-class emit (the fork drops/adds a
  trailing blank line vs upstream).
- The three spec files exist and are the oracle: `packages/engine/Specs/Renderer/ShaderBuilderSpec.js`,
  `ShaderFunctionSpec.js`, `ShaderStructSpec.js` — run them at intake to see the exact 10 assertions.

#### Implementation walkthrough

**Step 0 (premise):** run the three specs on the stabilized launcher; confirm exactly 5/3/2
failures with the addLines-validation + trailing-empty-line messages. If the count differs, the
register is stale (B243 is ~450 batches old) — re-read the actual failures and re-scope.
1. **addLines validation (ShaderBuilder 5):** add the upstream validation `addLines` is missing
   (the spec messages name the exact check — `Check.typeOf`-class guards on the `lines` argument).
   Match upstream's error text if the spec asserts it.
2. **Trailing empty line (ShaderFunction 3 / ShaderStruct 2):** align the emit's trailing-newline
   behavior with upstream — the spec asserts the exact generated string; make the fork byte-match.
3. **Do NOT touch the WGSL twin** (`WGSLShaderBuilder.js`) — this is the GLSL/upstream contract
   surface only. A WGSL-side change re-opens the WebGPU shader-gen and is out of scope (one concern).

#### Traps

1. This is an **upstream-parity** fix — the oracle is byte-match to upstream's expected string, not
   the fork's taste. Do not "improve" the output; match the spec.
2. The trailing-empty-line change touches string emit consumed by real shader generation — run a
   render probe after (`capture-and-diff` globe/model) to prove the generated shaders still compile
   and render byte-identically (a stray newline in GLSL is usually harmless but prove it).
3. Pre-existing since B243 means long-settled code — grep for other callers of the emit before
   changing trailing-newline behavior (models, materials, appearances all use ShaderBuilder).

#### Verification recipe

- The three specs GREEN (10/10 previously-failing assertions pass) on the stable launcher.
- `capture-and-diff.mjs` globe-default + a model scene: generated-shader render unchanged
  (byte-band).
- No WGSL twin touched (`git diff` scope = the 3 source files + maybe test data).

**Model tier: opus-or-sol** (well-specified, the specs ARE the contract). Effort **S** (1 batch).
**Schedule early among the exit-gate owners** — it is the cheapest and directly banks 10 green
assertions toward item 72.

---

### A.7 NEW-RESOURCE-URL-SEMANTIC-PARITY (item 67) — P2 · L · fable→opus-or-sol

#### What + why

Register cluster-20 (C9Q §9-67): "WHATWG `new URL` lowercases the host in `Resource.js`
reconstruction (2× CzmlDataSource failures) — preserve authority/credentials/protocol-relative/
file/opaque/data/blob/path-case/query/fragment semantics. 'L, not bounded' per triage." An
exit-gate owner: two CzmlDataSource specs fail because the fork's `Resource` URL reconstruction lost
semantics upstream's did not, and the full ramification (all the URL forms listed) is unbounded
until enumerated.

#### Architecture today (verified at HEAD)

- `packages/engine/Source/Core/Resource.js` — `new URL(url, getAbsoluteUri(baseUrl))` (:205) +
  `new URL(url, "https://placeholder.invalid/")` (:207) — the WHATWG-URL reconstruction path. WHATWG
  `URL` normalizes (lowercases) the host and applies other transforms upstream's older parser did
  not; the reconstruction re-serializes with the normalized host, breaking case-sensitive
  authorities and the other listed forms.
- The two failing specs: `packages/engine/Specs/DataSources/CzmlDataSourceSpec.js` (grep the URL
  assertions at intake).

#### Implementation walkthrough

**Step 0 (premise + enumeration — this is why it is "L, not bounded"):** run the CzmlDataSource
specs, pin the 2 failures. Then enumerate every URL FORM the register lists (authority, credentials,
protocol-relative `//host`, `file:`, opaque, `data:`, `blob:`, path-case, query, fragment) as a spec
case each — the enumeration IS the scope, and it is the fable-class judgment call (how much
semantic surface must be preserved).
1. **Preserve original host case:** capture the host substring BEFORE `new URL` normalization and
   re-splice it on reconstruction (or use a reconstruction path that does not round-trip through
   WHATWG normalization for the parts that must stay verbatim). Upstream's behavior is the oracle.
2. **Cover each URL form** with a spec asserting round-trip fidelity; fix the reconstruction until
   all pass. Some forms (`data:`, `blob:`, opaque) must pass through untouched — assert that.
3. **Do not regress the normalization that IS wanted** (relative-resolution, `..` collapsing) —
   the fix is surgical: preserve authority/case/credentials, keep path resolution.

#### Traps

1. **Unbounded surface** — timebox the enumeration; the 2 CzmlDataSource failures are the acceptance
   floor, the full form-matrix is the ceiling. Land the floor + as much of the matrix as the timebox
   allows, ledger the remainder (Principle 9).
2. `Resource` is used EVERYWHERE (imagery, terrain, tiles, models, datasources) — a URL-semantics
   change is high-blast-radius; run a broad probe sweep (any tile/imagery/model load) after.
3. Security: path-case + traversal semantics overlap A.14 (KMZ) — do not weaken traversal
   normalization (a `..` that should be blocked must stay blocked).
4. This is upstream-parity — match upstream's `Resource` semantics, not a new design.

#### Verification recipe

- The 2 CzmlDataSource specs GREEN + the enumerated URL-form specs GREEN (or ledgered).
- Broad load probe: CZML + a tileset + imagery load unaffected.
- `npx tsc --noEmit` (Resource has a `.d.ts`? — verify no type drift).

**Model tier: fable** for the enumeration/semantic-judgment step, **opus-or-sol** for the
reconstruction fix. Effort **L** (2–3 batches, timeboxed). Exit-gate owner — sequence before A.16.

---

### A.8 NEW-ENTITY-BULK-CLUSTER-TRANSITION-PARITY (item 69) — P2 · M · opus-or-sol

#### What + why

Register cluster-20 (C9Q §9-69): "EntityCluster spec fails via BulkBillboardVisualizer 'primitives
is required' through the PUBLIC `defaultVisualizersCallback` contract — reclassify bulk point/
billboard/label across cluster-flag transitions with no duplicates/stale listeners." An exit-gate
owner: a public-contract spec failure where toggling `cluster.enabled` routes entities between the
bulk visualizer and the legacy per-entity path incorrectly.

#### Architecture today (verified at HEAD)

- `packages/engine/Source/DataSources/DataSourceDisplay.js` — `defaultVisualizersCallback`
  (:617-…) constructs `new BulkBillboardVisualizer(...)` (:624) and the static-lane fast path
  (:655 comment). The spec failure "primitives is required" means the bulk visualizer is
  constructed without the `primitives` collection argument on some transition path.
- `BulkBillboardVisualizer` (`DataSourceDisplay.js:13` import) — the bulk path; the cluster-flag
  transition (`EntityCluster.enabled` flip) reroutes between it and the per-entity visualizers.
- Cross-item: this is the **spec/contract** half of the perf item `S10-2/S10-3` (entity-scale
  cluster) — that cluster owns the *performance* rebuild; this item owns the *correctness/spec*
  transition. Do not solve the GPU-merge perf here (Principle 9 — separate item).

#### Implementation walkthrough

**Step 0 (premise):** run the EntityCluster spec, pin the "primitives is required" failure and the
exact transition (enabled→disabled or disabled→enabled) that triggers it.
1. **Thread `primitives` through the transition:** the bulk visualizer needs the primitives
   collection on every construction path; the failing path constructs it without. Fix the
   `defaultVisualizersCallback` / cluster-transition wiring so the argument is always present.
2. **No duplicates / no stale listeners:** on a cluster-flag flip, the old visualizer's entities
   must be fully de-registered before the new one registers (the "no duplicates/stale listeners"
   acceptance) — assert entity counts and listener counts across a flip cycle.
3. **Public-contract discipline:** `defaultVisualizersCallback` is PUBLIC API — the fix must not
   change its signature/behavior for existing callers (backward compat, CLAUDE.md Principle 1).

#### Traps

1. **Do not absorb S10-2/S10-3** (entity-scale perf) — this is the spec/transition correctness fix
   only. The GPU-merge / declutter-rebuild perf is a separate cluster's item.
2. Listener leaks are silent — assert listener counts before/after a flip cycle, not just entity
   render output.
3. `BulkBillboardVisualizer` also handles points/labels per the register ("bulk point/billboard/
   label") — cover all three in the transition spec, not just billboards.
4. Public-API change → the exit gate's DataSources classification depends on this; a regression
   here re-opens item 72.

#### Verification recipe

- The EntityCluster spec GREEN on the stable launcher.
- A flip-cycle spec (enabled→disabled→enabled) asserts stable entity + listener counts, no
  duplicates.
- `capture-and-diff` / a clustering probe: clustered scene renders identically across a flip.

**Model tier: opus-or-sol** (bounded, the spec is the oracle). Effort **M** (1–2 batches).
Exit-gate owner.

---

### A.9 NEW-KMZ-ARCHIVE-URI-RESOLUTION-PARITY (item 70) — P2 · L · fable→opus-or-sol

#### What + why

Register cluster-20 (C9Q §9-70): "KMZ embedded/nested archive asset+link resolution with
normalization/encoding/case/traversal security so archive entries never fall through to HTTP.
KmlDataSource suite can't hold a headless session in this sandbox — partly dependent on the
Karma-environment item." Exit-gate owner AND the clearest A.1-dependency case: the KML suite is
one of the real-scene suites that kills headless Edge (A.1 M3), so this item is **double-blocked on
A.1 + A.3**.

#### Architecture today (verified at HEAD)

- `packages/engine/Source/DataSources/KmlDataSource.js` — the KMZ archive path (zip entry
  resolution, embedded/nested archive asset+link lookup). The bug class: an archive-relative link
  that should resolve to a zip ENTRY instead "falls through to HTTP" (a network fetch — which in the
  offline sandbox times out and crashes the session, tying to A.1 M3 / A.3).
- The suite: `packages/engine/Specs/DataSources/KmlDataSourceSpec.js` + KMZ fixtures under
  `Specs/Data/KML/` (grep at intake).

#### Implementation walkthrough

**Step 0 (HARD prerequisite):** A.1 (launcher) + A.3 (offline isolation) must land first — the
register explicitly says the suite "can't hold a headless session in this sandbox". Do NOT attempt
this item before them, or the whole item is untestable. Then run the KML suite, pin the archive-
resolution failures.
1. **Archive-entry resolution:** ensure archive-relative links resolve against the zip's entry map
   FIRST, only falling through to HTTP for genuinely-external absolute URLs. The register's list —
   normalization / encoding / case / traversal — each needs a case.
2. **Traversal security:** a `../` in a KMZ entry link must not escape the archive (path-traversal
   guard); overlaps A.7's traversal semantics — share the normalization helper if one is factored.
3. **Encoding/case:** percent-encoded + mixed-case entry names must match archive entries per the
   zip spec's case semantics.
4. **Offline fixtures:** the KMZ test archives must be local (A.3) so "never falls through to HTTP"
   is assertable with the fetch guard armed.

#### Traps

1. **A.1 + A.3 hard dependency** — sequence-locked after both. Attempting earlier = the exact
   session-crash the register records.
2. Path-traversal is a **security** boundary — a resolution fix that opens traversal is worse than
   the original bug. Test the escape cases explicitly.
3. Nested archives (KMZ referencing KMZ) are the deep case — cover them; the register says
   "embedded/nested".
4. The fetch guard (A.3) is the oracle for "never falls through to HTTP" — a passing test WITHOUT
   the guard armed proves nothing.

#### Verification recipe

- KmlDataSource suite GREEN on the stable launcher WITH the offline fetch guard armed (zero HTTP for
  archive-internal links).
- Traversal escape cases: assert blocked.
- Nested-archive case: green.

**Model tier: fable** for the archive-semantics enumeration, **opus-or-sol** for the resolution fix.
Effort **L** (2–3 batches). Sequence-locked after A.1 + A.3; exit-gate owner.

---

### A.10 C9-03-CERTIFYING-VISUAL-BASELINE-PROMOTION — P1 · M · opus-or-sol (+ fable if a scene fights it)

#### What + why

Register cluster-20 (C9Q §4 W0-6, NOT STARTED, partial repair rode C9-30 globe-default only):
"Historical VR rows remain NON_CERTIFYING campaign-wide — every scene except globe-default needs
manual inspection + manifest population (hash, renderer, camera, flags, adapter, oracle, tolerance)
so visual gates certify instead of merely diff." A visual gate that only pixel-diffs is not a
certification — it cannot distinguish "matches a KNOWN-GOOD baseline captured under recorded
conditions" from "matches a degenerate baseline" (the exact failure mode of the standing-red
`high-density-5k-spheres`, whose baselines are degenerate fully-black). This item makes the visual
gate *certify*.

#### Architecture today (verified at HEAD)

- `Tools/visual-regression/capture-and-diff.mjs` + `scenes.json` + `baseline/*.png` — the current
  gate diffs a fresh capture against a stored baseline with a tolerance. The **manifest** (hash,
  renderer, camera, flags, adapter, oracle, tolerance per scene) is the missing certification
  metadata.
- `README.md` in `Tools/visual-regression/` documents the flow; `--update` recaptures baselines.
- Blocker (register): the `high-density-5k-spheres` drift (standing-reds cluster B1) must be
  REPAIRED before that scene's baseline can promote — `--update` is auto-blocked when backends
  disagree (2026-07-18).

#### Implementation walkthrough

**Step 0 (premise):** read the current `baseline/` PNGs (Principle 8) — confirm which are
degenerate (the spheres pair is known-black; check others). A degenerate baseline must NOT be
certified; it must be repaired-then-recaptured (its owning cluster's item), not blessed.
1. **Manifest schema:** define a per-scene manifest record (JSON) with the register's fields (source
   hash the baseline was captured at, renderer, camera params, scene flags, adapter string, the
   oracle used, tolerance). Populate it per scene during a **manual-inspection pass** — a human (or
   fable) reads each baseline PNG and certifies it depicts the correct scene.
2. **Gate consumes the manifest:** `capture-and-diff` asserts the manifest's oracle/tolerance and
   records the adapter/renderer of the fresh capture — a mismatch (wrong adapter, missing manifest)
   is NON_CERTIFYING, not silently passing.
3. **Certify scene-by-scene:** globe-default rode C9-30 already; do the remaining scenes. A scene
   whose baseline is degenerate (spheres) stays NON_CERTIFYING until its drift item repairs it —
   record that dependency, do not force-certify.

#### Traps

1. **Never `--update` a degenerate baseline into certification** — that launders a broken capture
   into a "certified" one. Repair-then-recapture is the only path (the standing-red B1 rule).
2. This item does NOT fix any rendering — it fixes the *gate's honesty*. A scene that renders wrong
   should stay RED; certification is about provenance, not making reds green.
3. Adapter-string recording matters: a baseline captured on adapter X, verified on adapter Y, must
   surface the mismatch (visual output is adapter-sensitive) — the exit gate + A.4 both need this.
4. Coordinate with the standing-reds cluster: their drift-repair items (spheres) unblock specific
   scenes' promotion; sequence-aware.

#### Verification recipe

- Every non-degenerate scene has a populated manifest + certifies; degenerate scenes are
  NON_CERTIFYING with a named repair dependency.
- A deliberately-wrong capture (edit a scene) is caught as NON_CERTIFYING, not passed.
- `README.md` documents the manifest + certification contract.

**Model tier: opus-or-sol** for the schema + gate wiring; **fable** for the manual-inspection
certification pass (judgment — does this PNG depict the right scene). Effort **M** (1–2 batches).
Feeds the exit gate's visual half.

---

### A.11 NEW-GPU-TIMESTAMP-UNIQUE-SAMPLE-ACCOUNTING — P1 · S · opus-or-sol

#### What + why

Register cluster-20 (C9Q §3.2 + §4 W0-5, PARTIAL/PAUSED, implementation exists; audit-corrected
under-claim): "Open acceptance: readback-tail drain + covered/uncovered span reporting certified on
the moving route — prerequisite-grade tooling for ANY C11 GPU-timing performance claim." Any C11
perf item that wants a GPU-lane number (S11-1 fragment-cost, S9-4, C10-08b compile timing) needs
this certified — an uncertified GPU timer under-reports and invalidates the claim.

#### Architecture today (verified at HEAD — implementation EXISTS)

- `packages/engine/Source/Renderer/WebGPU/WebGPUTimestampProfiler.ts` — the implementation is real:
  query-set management + readback buffering + statistics (:11 doc). The certification surface is
  present in the types: `coveredFraction` (":71 fraction of the latest frame span covered by named
  pass timings"), the **unprofiled frame-span remainder** (:67-69 "latest frame span not attributed
  to a named timed pass" + "rolling average"), `readbackSkipCount` (:83 "frames not sampled because
  a readback slot was still in use"), and readback rejection accounting (:85). The **readback-tail
  drain** (the open acceptance) is the "resolves queries, issues readback" step (:25 comment) — the
  tail frames whose readback completes after capture stops must be drained and counted, not dropped.
- `Tools/visual-regression/probe-gpu-timestamp-profiler.mjs` — the existing probe; extend it.
- Spec: `packages/engine/Specs/Renderer/WebGPU/WebGPUTimestampProfilerSpec.js`.
- `CesiumDebug.gpuPassCost(t/f)` is the debug command (CLAUDE.md catalog) — keep DEBUGGING_GUIDE
  in sync if its output changes.

#### Implementation walkthrough

**Step 0 (premise):** the implementation exists and was under-claimed per audit — run the probe on
the moving route, confirm `coveredFraction` + `readbackSkipCount` report; the gap is CERTIFICATION
(the acceptance was paused), not building it.
1. **Readback-tail drain:** at capture end, drain in-flight readback slots (the frames counted in
   `readbackSkipCount`) so the final report includes them or explicitly accounts for them — no
   sample silently lost.
2. **Covered/uncovered span certification:** assert on the moving route that
   `coveredFraction + unprofiled-remainder-fraction ≈ 1.0` (every GPU nanosecond is either
   attributed to a named pass or explicitly in the unprofiled remainder) — that IS the "unique
   sample accounting" the name demands. No double-counting, no gap.
3. **Certify on the canonical moving-altitude route** (idle-soak invalid — charter). Record the
   adapter + the covered fraction as the certification artifact.

#### Traps

1. This is **prerequisite tooling** — its acceptance gates other items' perf claims. Do not let a
   perf item claim a GPU number citing an UNCERTIFIED timer (circular).
2. Readback is async — the tail drain must be bounded (don't hang waiting for a readback that will
   never complete on device loss); resolve honestly with a "N tail samples undrained" note.
3. Do not change `CesiumDebug.gpuPassCost` output without updating `DEBUGGING_GUIDE.md` (CLAUDE.md).
4. moving-route only for the certification; a single-frame or idle number is meaningless.

#### Verification recipe

- Probe on the moving route: `coveredFraction + unprofiled ≈ 1.0`, `readbackSkipCount` drained or
  accounted, over ≥5 reps.
- Spec asserts the accounting invariant (no gap, no double-count).
- Certification artifact (JSON) committed for other items to cite.

**Model tier: opus-or-sol** (implementation exists; this is disciplined acceptance closure). Effort
**S** (1 batch). **Schedule early** — it unblocks every GPU-lane perf claim in the campaign.

---

### A.12 C9-02-VISIBILITY-EXECUTION-OWNERSHIP-MANIFEST — P1 · L · opus-or-sol

#### What + why

Register cluster-20 (C9Q §3.2 + §4 W0-2, PARTIAL/PAUSED, terrain cohort fully certified): "Remaining:
strict runtime owner/selection/consumer/execution assertions for all 14 non-terrain cohorts (3D
Tiles, voxels, PVS/octree, fullscreen/compute, shadow/capture, cloud/weather/ocean/flow/environment)
— 6 partial + 6 gap cohorts recorded." This is the **execution-ownership certification** that
underwrites the whole feature-visibility family (`C9-23` effect-execution audit, the standing-red
`NEW-WEBGPU-OIT-DEFERRED-SPLAT-CANVAS-RESUME`, etc.) — every renderable cohort must have a runtime
assertion that names its owner, selection signal, consumer, and execution site, so a silently-dead
or silently-double-executed pass is caught.

#### Architecture today (verified at HEAD)

- The terrain cohort is certified (the template). The 14 remaining cohorts map to the renderer
  fleet: `WebGPUModelRenderer.ts` (tiles/model), voxel renderers, `SceneOctree.js` + PVS
  (`View.js`), fullscreen/compute (`WebGPUPostProcessPipeline`, the compute dispatchers), shadow/
  capture (`WebGPUShadowMapRenderer.js`, `runSceneCapture`), cloud/weather/ocean/flow/environment
  FRs.
- The manifest is a runtime-assertion harness (spec + debug snapshot extract), not a code migration.
  `CesiumDebug.snapshot()` / `getDebugSnapshot()` is the introspection surface to extend.

#### Implementation walkthrough

**Step 0 (premise):** re-read the C9-02 ledger for the 6-partial + 6-gap cohort list; confirm the
terrain template's shape. Each cohort's manifest entry asserts: **owner** (which FR/system emits it),
**selection** (the demand/enable signal), **consumer** (who reads its output), **execution** (the
pass/dispatch site) — all as runtime assertions.
1. **Per-cohort assertion:** for each of the 14, add the four assertions (owner/selection/consumer/
   execution) as a spec or a debug-snapshot invariant. A cohort with no consumer (an effect that
   renders to a target nobody reads) is a FINDING — file it (this is exactly the
   `NEW-WEBGPU-OIT-DEFERRED-SPLAT-CANVAS-RESUME` / dead-pass class; Principle 7 — do not delete,
   surface).
2. **Gap cohorts first:** the 6 recorded as "gap" have no assertions at all — highest value.
3. **Coordinate with C9-23** (effect-execution audit, postprocess cluster): C9-02 is the ownership
   *manifest*, C9-23 is the effect-execution *audit* — shared methodology, do not duplicate; if
   C9-23 lands first, C9-02 consumes its execution counters.

#### Traps

1. **Principle 7 (dead-code audit):** a cohort that appears to have no consumer may be scaffolding
   for an unfinished feature (the origin story is `WebGPUTranslucentTileClassification`). The
   manifest's job is to DOCUMENT the ownership gap, not to delete the pass. Cross-reference the
   file's docstring + `DEFERRED_WORK.md` before recording "no consumer" as a bug vs scaffolding.
2. This is certification/tooling — most cohorts produce assertions, not fixes. Real findings get
   filed as named items.
3. Multi-context (Principle 3): assertions must hold per-context; a manifest keyed to a single
   context misses split-screen bugs.
4. Do not widen into fixing the visibility bugs the manifest surfaces (one concern) — the manifest
   is truth; fixes are the postprocess/standing-reds clusters' items.

#### Verification recipe

- All 14 non-terrain cohorts have owner/selection/consumer/execution assertions (green or
  filed-finding).
- The 6 gap cohorts move to partial/full; findings filed with Principle-7 cross-references.
- `CesiumDebug.snapshot()` exposes the manifest state; `DEBUGGING_GUIDE.md` updated.

**Model tier: opus-or-sol** (methodical, terrain template exists). Effort **L** (2–3 batches).
Feeds the exit gate's execution-correctness half.

---

### A.13 C9-01-REGRESSION-ATTRIBUTION remainder (Gate-A closure) — P2 · S · fable

Register cluster-20 (C9Q §3.2 + §4 W0-1, PARTIAL/PAUSED, Gate A formally IN PROGRESS on this sole
remainder): "Exact-current attribution complete; the historical replay half of acceptance is
characterization-only. Close by maintainer gate amendment or bundle recovery." Needs a recorded
Gate-A amendment OR a recovered binary of the week-old dirty bundle (`B8015811` never retained).

**C11 disposition: this is a CLOSURE row gated on a maintainer decision, not a work row.** The
exact-current attribution is done; the historical-replay half is blocked on an artifact that was
never retained. Two paths, both maintainer-owned: **(a)** the maintainer amends Gate A to accept
characterization-only for the historical half (recording that the `B8015811` bundle is unrecoverable
— the `feedback_git_stash` "prefer git show over stash" lesson is the cautionary tale here); **(b)**
recover the bundle if any worktree/reflog still holds it (`git reflog` + `Build/CesiumUnminified`
recovery per the `feedback_audit_subagent_git_revert` memory — a long shot at ~week-old). **Step 0
for whoever picks this up: try the reflog/Build recovery ONCE (cheap), and if it fails, escalate the
Gate-A amendment to the maintainer — do not fabricate a historical replay.** **Model tier: fable**
(archaeology). Effort **S**. **PREMISE:** verified — Gate A is IN PROGRESS on this sole remainder;
the blocker is an artifact, not code.

---

### A.14 S8-7 — settle-window attribution rule + first-complete-frame metric — P2 · S · opus-or-sol

#### What + why

Register cluster-20 (PR §9 S8-7 + §16.6): "WebGPU's +1.3–1.7 s tile-stable is GPU-submit-traffic
bound (zero main-thread long tasks) — closure/churn fixes must not book stable-time credit; add a
first-complete-frame metric (tiles rendered == selected) to `run-performance-campaign.mjs`
(frameNumber>0 under-reports perceived TTFF)." A measurement-honesty tooling item: the current TTFF
proxy (`frameNumber > 0`) fires when the FIRST frame renders, not when the scene is actually
COMPLETE — so a fix that shrinks main-thread work can appear to improve TTFF while the perceived
time-to-stable is unchanged (GPU-submit bound). This protects the boot/TTFF cluster (§B) from
booking false credit.

#### Architecture today (verified at HEAD)

- `Tools/visual-regression/run-performance-campaign.mjs` — the perf runner; the TTFF/settle metric
  lives here. It measures frame timings on the moving-altitude route.
- The signal `tiles rendered == selected` requires reading the globe/tileset selection vs render
  state — `scene.globe._surface` tile counts / `Cesium3DTileset` statistics.

#### Implementation walkthrough

**Step 0 (premise):** confirm the current TTFF proxy is `frameNumber > 0` and that WebGPU's
tile-stable lags it by ~1.3–1.7 s on the route (reproduce the gap).
1. **First-complete-frame metric:** add a metric that fires when `renderedTileCount == selectedTileCount`
   (the scene is visually complete, not just non-empty) — this is the perceived-TTFF the boot items
   must move to claim a win.
2. **Settle-window attribution rule:** a closure/churn fix (the model-frontend + frame-delta
   clusters) that reduces allocation must NOT book "tile-stable-time" credit if the stable-time is
   GPU-submit bound (zero main-thread long tasks) — the rule: attribute stable-time improvements
   ONLY when a main-thread long-task reduction accompanies them. Encode this as an attribution flag
   in the runner output.
3. **Both metrics side-by-side:** keep `frameNumber>0` (backward comparability with the C9-30/Gate-A
   anchors — never re-derive a baseline) AND add first-complete-frame; report both.

#### Traps

1. **Do not overwrite historical artifacts** (C10 QUICK START #11) — add the metric, keep the old
   one; the C9-30 anchor comparison must stay valid.
2. moving-altitude route only; ≥5 counterbalanced reps for any timing claim.
3. `renderedTileCount == selectedTileCount` can flicker during streaming — require it stable for N
   frames before declaring complete (avoid a false-early complete).
4. This item is the GUARD against the boot cluster (§B) claiming TTFF wins it didn't earn — land it
   BEFORE the boot items make TTFF claims.

#### Verification recipe

- The runner reports first-complete-frame + `frameNumber>0` + the settle-attribution flag on the
  moving route.
- A synthetic main-thread-only fix shows first-complete-frame unchanged (proving the metric
  distinguishes GPU-submit-bound settle).
- Old metric unchanged (comparability preserved).

**Model tier: opus-or-sol** (bounded runner change). Effort **S** (1 batch). **Schedule before the
boot/TTFF cluster (§B.3/B.6)** so their claims are honest.

---

### A.15 probe-hdr-pp-math gate F baseline refresh — P2 · S · opus-or-sol

Register cluster-20 (LQ §4.7/§5.2, OPEN — stranded): "Stored pre-B506 SDR baseline still fails gate
F on intentional B506 pixel changes — a known-stale baseline masking real regressions. Refresh only
once in-flight globe pixel changes settle (C9/C10 landed many)." **PREMISE-VERIFIED at HEAD:**
`Tools/visual-regression/probe-hdr-pp-math.mjs` exists. A stale baseline that fails on an
INTENTIONAL change is worse than no gate — it trains everyone to ignore gate F, so a REAL regression
slips. The fix is a baseline refresh, but with a hard sequencing rule: **refresh ONLY after the
in-flight globe/HDR pixel changes settle**, else you re-freeze a moving target. **Step 0:** confirm
with the orchestrator that C9/C10 globe-pixel work has settled (grep the ledger for open
globe/HDR-touching rows); if any are open, DEFER this refresh and say so. Once settled: read the
current probe output PNGs (Principle 8), confirm the B506 pixel changes are the INTENDED ones (not a
regression), recapture the gate-F baseline, and note the recapture + the settling-precondition in
the ledger + README. **Traps:** (1) never recapture over an unsettled target — that is the exact
`--update`-a-degenerate-baseline error class (A.10 trap 1); (2) read the PNGs to confirm the diff is
intended, do not blind-`--update`; (3) coordinate with A.10 (certification) — the refreshed baseline
should carry a manifest entry. **Model tier: opus-or-sol.** Effort **S** (1 batch, gated on settle).

---

### A.16 C8-SHARED-UPSTREAM-CONTRACT-GATE (item 72) — P1 · L · **THE CAMPAIGN-11 EXIT GATE** · opus-or-sol (sol judgment)

#### What + why (this is the campaign closer)

Register cluster-20 (C9Q §3.2 L156 + §9-72, PARTIAL/PAUSED — "gate stays open (natural C11 exit
gate)"): "Broad upstream-suite green gate: Renderer triage complete (zero failures attribute to the
GraphicsCapabilities migration), DataSources classified with owners — **cannot close until the four
owner items land and full-suite runs are achievable.** Items 66/67/69/70 + a stable full-suite
environment; Widgets + complete-engine lanes untouched." The task framing names this **the intended
Campaign-11 EXIT GATE** — the certification that Campaign-11's work did not regress the upstream
contract, run as a full-suite certification with **truthful executed/skipped counts**. It owns the
item-64-71 broad-suite family.

#### Architecture today (verified at HEAD)

- `packages/engine/Source/Renderer/GraphicsCapabilities.js` (+ `.d.ts`) — the migration whose
  Renderer-triage the gate certifies "zero failures attribute to". Verified present at HEAD.
- The gate is a **full-suite run**: engine (`packages/engine/Specs/**`) + widgets
  (`packages/widgets/Specs/**`) + the complete-engine lane, on the stabilized launcher, with the
  offline lane isolated and the online lane explicit.
- **Owner items** (all in this cluster): item 66 (A.6, shader-gen — cheapest), item 67 (A.7,
  Resource URL), item 69 (A.8, EntityCluster), item 70 (A.9, KMZ), plus item 64 (A.5, broad-suite
  remainder). The environment prerequisites: A.1 (launcher), A.2 (spec freshness), A.3 (offline).

#### Implementation walkthrough (the exit-gate design)

**This item is a GATE, not a migration — it is the LAST thing scheduled in Campaign-11.** Its
design:

**Phase 0 — environment ready (W1 prerequisites).** A.1 (launcher deterministic), A.2 (spec bundle
fresh), A.3 (offline isolated). Until all three are COMPLETE, the gate cannot produce truthful
counts — a flaky launcher or stale bundle makes "green" meaningless.

**Phase 1 — owner items land (mid-campaign).** Items 66/67/69/70 (A.6–A.9) each remove standing
reds from the upstream suite; item 64 (A.5) closes the broad-suite remainder with WebGL2-only skips
documented. Each is verified GREEN-or-SKIPPED-with-reason on the stable launcher before the gate
runs.

**Phase 2 — the certification run (campaign close).**
1. **Full-suite run, truthful counts:** run engine + widgets + complete-engine lanes; report
   **executed / passed / skipped / failed** with the skip REASONS enumerated (WebGL2-only per
   Principle 4, requires-network per A.3, requires-physical-adapter per A.4). A skip is a truthful
   accounting line, never a silent pass (Principle 9). The M2 shutdown-disconnect artifact (A.1)
   must be handled — trust the TOTAL SUCCESS line.
2. **Renderer triage assertion:** zero failures attribute to the GraphicsCapabilities migration
   (the already-complete half — re-assert it holds after the campaign's renderer churn).
3. **DataSources classification:** every DataSources failure has a named owner (items 67/69/70) that
   has landed — no unowned red.
4. **Widgets + complete-engine lanes:** the register notes these are "untouched" — the gate must
   actually RUN them (not just engine), which requires the environment to hold a full session (A.1).
5. **Verdict artifact:** a committed certification report (executed/skipped/failed counts +
   skip-reason ledger + adapter string) that IS the Campaign-11 exit evidence. If any owner item did
   NOT land, the gate stays OPEN and the campaign does not certify — say so plainly (honest-partial).

#### Traps

1. **Do not close the gate on a flaky environment** — A.1/A.2/A.3 are hard prerequisites; a "green"
   run on a launcher that skipped suites (the B693 mode) is a false certification. The whole point of
   this cluster is to make this gate trustworthy.
2. **Truthful skips, never silent passes** (Principle 9): a WebGL1/GLSL100 skip is legitimate
   (Principle 4); a network-timeout that "passes by not running" is a LIE the offline isolation
   (A.3) exists to prevent.
3. **All four owner items must land** — the gate cannot certify with an owner item open. If one
   slips, the gate is a truthful "OPEN, blocked on item X", not a partial green.
4. **This is the LAST item scheduled** — it depends on nearly the whole cluster. Sequencing it early
   wastes the run (nothing to certify).
5. `--concurrent 1` on the landing commit if it carries doc/ledger churn (lint-staged OOM memory).

#### Verification recipe

- Full engine + widgets + complete-engine suite runs on the stable launcher with truthful
  executed/skipped/failed counts + skip-reason ledger.
- Zero unowned reds; every skip reasoned.
- GraphicsCapabilities Renderer-triage re-asserted zero-attribution.
- Certification report committed as the Campaign-11 exit artifact.

**Model tier: opus-or-sol** with **sol-class judgment** on the skip-classification honesty (the
Principle-4 vs real-bug call). Effort **L** (the run + verdict; most cost is in the owner items).
**Sequence: DEAD LAST in Campaign-11 — it is the exit gate.**

---
---

## PART B — `build-boot` cluster (13 items)

The cluster theme: the build variants, TypeScript-debt conversion, the **exhausted ShaderDefine
registry**, and the boot/TTFF chain. Two structural facts dominate: (1) the ShaderDefine registry
is FULL (bits 0–30 used, bit 31 banked by C10-08) so `C10-08b` (define-width expansion) is the hard
prerequisite for any new specialization axis; (2) the boot/TTFF remainder is INTAKE-CONDITIONAL on
C10-06/07/08.

> **BOOT/TTFF REMAINDER — INTAKE-CONDITIONAL (read before B.3, B.6, B.11).** The register lists
> `S8-4` (FR-lazify), `S8-5/S3-7` (module granularity), and the counter-pragma-strip / leaf-strip
> items as build-boot work, but **their scope depends on what C10-06 (landing now), C10-07, and
> C10-08 actually deliver.** C10-06 may absorb `S8-4`; C10-07 changes what `S8-5` optimizes; C10-08
> exhausts the last define slot making `C10-08b` mandatory. **Do not open any boot item until the
> C10-06/07/08 ledger rows are COMPLETE/PARTIAL and their residuals are swept** (§0 intake). Each
> boot item below is written with an explicit "if C10-0X did/didn't do Y" branch.

**Intra-cluster sequencing (hard):**
`C10-08` (C10-owned, banks bit 31) → **`C10-08b`** (define-width — unblocks all new axes) →
[`S8-5/S3-7`, Q31 varyings, KHR axes]. Independent of the define chain: `NEW-MATERIAL-PER-BACKEND-SHADER-SOURCE`
· `NEW-WGSL-STRING-COMMENT-STRIP` · `NEW-EMPTYMODULE-STUB-HARDENING` → `NEW-WEBGPUONLY-RENDERER-LEAF-STRIP`
· `Q35` decomp · `WebGPUComputePipelineCache` (PREMISE-DRIFT) · `NEW-TS-CONVERT-JS-RENDERERS`
(PREMISE-DRIFT). Boot: `S8-4` (C10-06 rider). P3 tail: pragma-strip, subgroup-finish, engine-handoff.

---

### B.1 NEW-MATERIAL-PER-BACKEND-SHADER-SOURCE — P1 · M · opus-or-sol

#### What + why

Register cluster-21 (DW ~187): "Give Material per-backend virtual methods
(`material.getShaderSource(context)` / `getUniformMap(context)`) so WGSL/GLSL selection lives inside
the material abstraction (`ViewportQuad.js:144` branch retired). ~1 session incl. the ~3 built-in
material pairs; the last blocker for `NEW-CAPABILITY-GETTER-CODIFY` closure." This is **the last
sanctioned `isWebGPU` branch** in scene code — CLAUDE.md Principle 2 forbids scene code checking
`isWebGPU`, and this one branch (`ViewportQuad.js`) is the documented exception whose retirement
closes the capability-getter codification.

#### Architecture today (verified at HEAD)

- `packages/engine/Source/Scene/ViewportQuad.js:142-144` — the branch: `if (context.isWebGPU)`
  (:144) with a comment "…the `isWebGPU` check here picks the correct shader" (:142); it selects
  `this._material.shaderSource` (:173, `sources: [this._material.shaderSource, ViewportQuadFS]`) —
  a SINGLE `shaderSource` field, so the backend selection happens at the call site, not in Material.
- `packages/engine/Source/Scene/Material.js:287` — `this.shaderSource = undefined` — Material carries
  ONE `shaderSource`; there is no `getShaderSource(context)` / `getUniformMap(context)` virtual.
- The ~3 built-in material pairs (register) are the GLSL/WGSL twin materials that would move their
  selection inside the abstraction.

#### Implementation walkthrough

**Step 0 (premise):** confirm the `ViewportQuad.js:144` branch is still the ONLY `isWebGPU` in scene
material code (`git grep -n "isWebGPU" HEAD -- packages/engine/Source/Scene/` to enumerate — if
others exist, the register's "last exception" is stale, re-scope).
1. **Virtual methods:** add `material.getShaderSource(context)` + `material.getUniformMap(context)`
   to `Material.js` — default returns the existing `shaderSource`/uniform map; per-backend built-ins
   override to return WGSL or GLSL by `context.rendererType` (queried INSIDE the material abstraction,
   which is the sanctioned place per Principle 2 — the renderer layer knows the backend; the getter
   is on the material, not scene code).
2. **Retire the ViewportQuad branch:** `ViewportQuad.js` calls `material.getShaderSource(context)`
   — the `if (context.isWebGPU)` at :144 disappears.
3. **The ~3 built-in pairs:** move their WGSL/GLSL twin selection into their material definitions'
   `getShaderSource` override.
4. **Closes `NEW-CAPABILITY-GETTER-CODIFY`:** note in the ledger that this retirement completes the
   capability-getter codification (the register's stated payoff).

#### Traps

1. **Principle 2 nuance:** the getter queries `context.rendererType`/`isWebGPU` INSIDE the material
   abstraction — that is allowed (the material IS the abstraction boundary); scene code (ViewportQuad)
   must NOT branch, which is exactly what this retires. Do not move the branch elsewhere in scene
   code.
2. **Backward compat (Principle 1):** `Material.shaderSource` is public-ish — keep it working;
   `getShaderSource` DEFAULTS to it, so existing custom materials with a `shaderSource` still work
   unchanged.
3. Custom user materials (fabric) must not break — the default getter preserves their behavior;
   test a fabric material.
4. Both backends: the retirement is renderer-agnostic scene code — WebGL byte-identical rendering is
   the oracle.

#### Verification recipe

- `git grep isWebGPU packages/engine/Source/Scene/` no longer shows the ViewportQuad branch (and no
  new scene-code branch appeared).
- `capture-and-diff.mjs` scenes using ViewportQuad materials (any material-on-quad scene) byte-band
  both backends.
- A custom fabric material renders unchanged.
- `npx tsc --noEmit` (Material `.d.ts` if present — add the virtuals).

**Model tier: opus-or-sol** (well-specified, ~1 session). Effort **M** (1 batch). Independent of the
define chain — schedulable anytime.

---

### B.2 C10-08b — ShaderDefine define-width expansion — P1 · M · **HARD PREREQUISITE FOR ANY NEW DEFINE BIT** · opus-or-sol (sol judgment)

#### What + why (design this — it is the campaign's define-slot unblock)

Register cluster-21 (C10Q §6 + §5 C10-08 row; PR §4 S3-4/S3-5): "Widen the ShaderDefine register
past Uint32 (bits 0–30 occupied) incl. the module-cache key math `((defines>>>0)*0x100)+sourceId` —
unblocks the remaining 6–7 model uber-shader specialization axes (KHR bits, HAS_SKINNING/MORPH/
INSTANCING, IBL mode, MODEL_HAS_VELOCITY) and the parked Q31 varyings unblock." Blocker line:
"C10-08 proves the mechanism + banks the ONE free slot first; add-only/never-renumber registry
rules; bit-31 sign hazard; material-mask bits ≤28." **This is the structural unblock for a whole
family of parked model features** — until the registry can hold a 33rd bit, `NEW-MODEL-WGSL-CUSTOM-SHADER`
(Q31 varyings, tiles-model cluster) and every new specialization axis are hard-blocked.

#### Architecture today (verified at HEAD — the exhaustion is REAL)

- `packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts` — `ShaderDefine = Object.freeze({...})`
  (:38); bits **0–30 fully occupied**, verified highest live entry `MODEL_METADATA_MAT_TRANSPORT: 1 << 30`
  (:848) with the adjacent :831 comment documenting bit 30 as a sticky-state slot. **Bit 31 (`1 << 31`)
  is the single free Uint32 slot — banked by C10-08.** After C10-08, the registry is FULL.
- `packages/engine/Source/Renderer/WebGPU/WebGPUShaderModuleCache.ts` — the key math (verified):
  `unsignedDefines = defines >>> 0` (:108), `numericKey = unsignedDefines * 0x100 + sourceId` (:112),
  `key = keySalt === 0 ? numericKey : "${numericKey}#${keySalt>>>0}"` (:113); `sourceId` range-checked
  `0..0xff` (:97-98). The comment (:20) states the contract: `((defines >>> 0) * 0x100) + sourceId`,
  "retains the complete 32-bit define mask while reserving eight low bits for the validated source ID;
  JavaScript represents every resulting 40-bit key exactly." **This math CANNOT represent a 33rd
  define bit** — `defines >>> 0` truncates to Uint32, and `numericKey` would exceed 2^53 (safe-integer
  limit) if `defines` grew to 33+ bits (`(2^33)*256 ≈ 2^41` is still safe, but `defines >>> 0` has
  already truncated the 33rd bit to zero — silent aliasing).
- The preprocessor `WebGPUShaderPreprocessor.ts` takes `defines: number` and resolves `//>>ifdef FLAG`
  against the registry bit — it too assumes a Number mask.

#### Implementation walkthrough (the design)

**Step 0 (HARD gate):** C10-08 must be COMPLETE (banked bit 31). Verify at intake:
`git grep -n "1 << 31\|1<<31\|0x80000000" HEAD -- packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts`
— if bit 31 is NOT yet a registry entry, C10-08 has not landed; **do not open C10-08b** (its
mechanism is unproven). Reproduce the exhaustion: attempt to add a 33rd define and observe the
silent aliasing (`(1 << 32) === 1` in JS — the new bit aliases bit 0).

**Design decision (write it down BEFORE code — this is the sol-judgment call):** three representations,
pick one:
- **(A) BigInt mask.** `ShaderDefine` values become `1n << 31n`, etc.; the mask is `bigint`. Key math
  becomes a string: `key = "${mask.toString(16)}#${sourceId}"` — loses the allocation-free numeric
  fast path (measure the cost; the cache is per-device and hit-heavy, so a string key on every
  getOrCreate may matter). **Cleanest, but perf-sensitive.**
- **(B) Two-Uint32 `{hi, lo}` mask.** Preserves a numeric fast path when `hi === 0` (the common case —
  most shaders use only low bits): `key = hi === 0 ? (lo >>> 0) * 0x100 + sourceId : "${hi>>>0}:${lo>>>0}#${sourceId}"`.
  **Keeps the fast path for existing shaders; adds a slow path only for hi-bit consumers.** Preferred
  unless the BigInt cost measures negligible.
- **(C) Fixed byte-array mask.** Most general, most churn. Avoid unless >64 bits are foreseeable.

1. **Registry representation:** migrate `ShaderDefine` values to the chosen type. **Bits 0–30 keep
   their EXACT numeric identity** (add-only rule — bit N stays `1<<N` / `{hi:0, lo:1<<N}` / low-word
   bit N). Never renumber.
2. **Module-cache key math:** update `WebGPUShaderModuleCache.ts:108-113` for the new type, preserving
   the sourceId-low-8-bits contract and the fast path for hi===0 (option B). Update the :20 docstring.
3. **Preprocessor:** `WebGPUShaderPreprocessor.ts` `defines` param + `//>>ifdef` resolution handle the
   wider type; unknown-flag-throws behavior preserved.
4. **All define-mask consumers:** grep every site that does bitwise ops on a define mask
   (`git grep -nE "defines? [&|]|ShaderDefine\." HEAD -- packages/engine/Source`) and migrate the ops
   to the new type. **The `material-mask bits ≤28` constraint (register):** some subsystem packs
   material defines into a sub-mask assuming ≤28 bits — find it (grep `materialDefines` / material
   mask) and ensure the widening does not overflow its assumption.
5. **bit-31 sign hazard:** `1 << 31` is negative in JS; `>>> 0` normalizes it. The new representation
   must handle bit 31 correctly (option A/B sidestep it cleanly).

#### Traps

1. **Add-only / never-renumber (CLAUDE.md WGSL pipeline rules):** reordering silently aliases cached
   modules; removal breaks any pipeline referencing the bit. Bits 0–30 are FROZEN in identity — the
   widening MUST preserve them numerically. This is the single most important invariant.
2. **Cache-key collision on migration:** if the key format changes, existing cached modules key
   differently — that is fine for a fresh build (no persistent cache) but verify no in-session cache
   assumes the old key format.
3. **material-mask ≤28 (register):** the material sub-mask overflow is a real hazard — a widened
   define bit that lands in the material mask region corrupts material selection silently. Enumerate
   the material-mask packing before widening.
4. **C10-08 dependency:** without C10-08's banked bit 31 and proven specialization mechanism, this
   item has nothing to widen FOR — it is gated, not standalone.
5. **Perf of the key path:** option A's string key is on the hot getOrCreate path — measure it
   (prewarm + settled-frame cache-hit count); if it regresses compile-time or hit-path CPU, choose
   option B.

#### Verification recipe

- A 33rd define bit can be added and resolves correctly in a `//>>ifdef` (add a test bit, gate a
  test shader, confirm the two variants differ) — the headline capability.
- Bits 0–30 produce BYTE-IDENTICAL module-cache keys + preprocessed output vs pre-widening (the
  freeze invariant) — a golden test over the existing define sets.
- `WebGPUShaderModuleCacheSpec.js` + `WGSLShaderPreprocessorSpec.js` green; add cases for hi-bit
  masks.
- `capture-and-diff.mjs` full scene set byte-band (no shader selection changed for existing content).
- Compile-timing (via A.11's certified GPU timer or a prewarm counter) unchanged for existing shaders.
- Cross-reference: note in `DEFERRED_WORK.md` that `NEW-MODEL-WGSL-CUSTOM-SHADER` (Q31 varyings) +
  the model KHR/skinning/morph/instancing/IBL/velocity axes are now UNBLOCKED.

**Model tier: opus-or-sol** with **sol-class judgment** on the representation choice (A/B/C tradeoff).
Effort **M** (1–2 batches). **Sequence: strictly after C10-08; it is the hard prereq for every new
specialization axis in the model path.**

---

### B.3 S8-5 / S3-7 — WGSL module granularity + globe imagery layout tranches — P2 · L · **INTAKE-CONDITIONAL on C10-07** · opus-or-sol

#### What + why

Register cluster-21 (PR §9 S8-5 + §4 S3-7): "Every define-variant of the 239KB GlobeTerrain /
215KB ModelPBRComplete re-tints end-to-end (~30–80 ms; compile scales with total surface,
structurally eroding TTFF) — per-pass entry-point split, dead-function elimination,
compilationHints; plus globe imagery layout shaped for the 16-layer worst case on all devices —
scene-keyed 1/4/16 tranches or texture_2d_array. Feeds C9-11/12A descriptor narrowing." Blocker:
"Compounds with C10-06/C10-07 — sequence after." A TTFF item: the monolithic WGSL modules recompile
their WHOLE surface per define variant, so compile time scales with total module size, not the used
subset.

#### Architecture today (verified at HEAD)

- The large WGSL modules live in `packages/engine/Source/Shaders/WebGPU/` (GlobeTerrain.wgsl,
  ModelPBRComplete/ModelPBR*.wgsl) and are compiled to JS string modules by `wgslToJavaScript`
  (`scripts/build.js`, invoked `gulpfile.js:105`).
- The globe imagery layout (16-layer worst case) is in the globe surface UBO/bind-group
  (`WebGPUGlobeSurfaceTextures.ts` + the imagery-projection chain per `IMAGERY_PROJECTION.md`).
- `compilationHints` is a WebGPU shader-module creation hint — the module cache
  (`WebGPUShaderModuleCache.ts`) is where it would be threaded.

#### Implementation walkthrough

**Step 0 (INTAKE-CONDITIONAL premise):** C10-07 (async model pipelines) changes WHEN/HOW pipelines
compile — read its ledger row + diff FIRST. If C10-07 landed a per-pass compile scheduler, the
"per-pass entry-point split" here must build on it, not duplicate it. Reproduce the compile-time
scaling: measure GlobeTerrain/ModelPBR compile time per define variant (via A.11's timer or a
prewarm counter).
1. **Per-pass entry-point split (S8-5):** split the monolithic modules so a variant compiles only
   its used passes' entry points — dead-function elimination + `compilationHints` so the driver
   skips unused code. This is where C10-07 interplay matters most (sequence after).
2. **Globe imagery layout tranches (S3-7):** shape the imagery bind-group layout for the common
   layer count (scene-keyed 1/4/16 tranches or `texture_2d_array`) instead of always the 16-layer
   worst case — feeds C9-11/12A descriptor narrowing (terrain-imagery cluster; coordinate).
3. **TTFF evidence (A.14):** claim the win via A.14's first-complete-frame metric, NOT the stale
   `frameNumber>0` proxy (compile-time savings are perceived-TTFF, and A.14 exists to make that
   honest).

#### Traps

1. **INTAKE-CONDITIONAL on C10-07** — do not open before C10-07's ledger row settles; its
   async-compile scheduler is the substrate.
2. **Byte-identical output:** a per-pass split must produce the SAME rendered output — the split is a
   compile-organization change, not a shader-logic change. `capture-and-diff` byte-band is the oracle.
3. **The imagery-layout change touches the projection chain** — `IMAGERY_PROJECTION.md` MUST be kept
   in sync (CLAUDE.md — it is the single source of truth for imagery projection); a drift there is
   worse than the perf bug.
4. **compilationHints portability:** not all adapters honor them — the split must not DEPEND on hints
   for correctness (they are a hint, not a contract).
5. TTFF claims use A.14's metric + the moving route; a single-load number is noise.

#### Verification recipe

- Compile-time per define variant drops measurably (A.11 timer); first-complete-frame (A.14) improves
  on the route.
- `capture-and-diff.mjs` globe + model + a 16-layer-imagery scene byte-band both backends.
- `IMAGERY_PROJECTION.md` updated in the same commit as any imagery-layout change.
- C9-11/12A descriptor-narrowing coordination noted.

**Model tier: opus-or-sol** (bounded once C10-07 is known). Effort **L** (2–3 batches).
**INTAKE-CONDITIONAL: sequence after C10-07.**

---

### B.4 NEW-WGSL-STRING-COMMENT-STRIP — P2 · S · opus-or-sol

#### What + why

Register cluster-21 (LQ §6.5(c) incr. 1, PLANNED, never implemented): "Strip comments/blank lines
from the 305 bundled WGSL string modules in minified/variant builds — measured ~330 KB (15.2% of raw
WGSL) off EVERY variant at near-zero risk." Blocker: "Stripper MUST preserve `//>>` directive
families." A pure download-size win: the WGSL shaders ship as JS string modules with all their
comments; stripping them shrinks every bundle variant.

#### Architecture today (verified at HEAD)

- `scripts/build.js` `wgslToJavaScript` (invoked `gulpfile.js:105` / minify path :101) — converts
  `packages/engine/Source/Shaders/WebGPU/**/*.wgsl` to JS string modules. This is where the strip
  hooks in, gated on `minify`.
- The `//>>` directive families (CLAUDE.md WGSL pipeline): `//>>ifdef` / `//>>else` / `//>>endif`
  (preprocessor) AND `//>>includeStart('debug', ...)` / `//>>includeEnd('debug')` (pragma stripping)
  — the strip must PRESERVE these (they are load-bearing directives, not comments).

#### Implementation walkthrough

**Step 0 (premise):** confirm the ~305 WGSL string modules ship with comments intact in a minified
variant build (`npx gulp buildRelease`, inspect a WGSL string module in the output). Measure the
current WGSL byte total.
1. **Strip in `wgslToJavaScript` under `minify`:** remove `//` line comments and blank lines EXCEPT
   lines matching the `//>>` directive prefix (ifdef/else/endif/includeStart/includeEnd). Preserve
   in-string content (WGSL has no block comments issue, but guard against `//` inside string literals
   if any exist).
2. **Preserve directives byte-exact:** the preprocessor + pragma stripper run on the shipped strings,
   so a stripped-away `//>>ifdef` breaks variant selection — the strip's whitelist is the whole risk.
3. **Unminified builds unchanged:** strip only in `minify`/variant builds (dev debugging needs the
   comments).

#### Traps

1. **`//>>` directive preservation is the whole risk** — a regex that strips `//` comments must
   NEGATIVE-match the `//>>` prefix. Test with a shader that has both a real comment AND a directive
   on adjacent lines.
2. Do not strip in unminified builds (dev loop needs comments + the pragma system needs
   `//>>includeStart('debug')` visible for the debug build).
3. **`//` inside a WGSL string/char literal** — unlikely in WGSL but guard; a naive strip could
   corrupt a shader. Prefer a line-oriented strip that respects the directive whitelist.
4. Measure the actual byte savings across ALL THREE variants (dual/webgl-only/webgpu-only) — the
   register's 330 KB is the raw-WGSL figure; the per-variant win differs.

#### Verification recipe

- `npx gulp buildRelease` + variant builds: WGSL string modules have no comments except `//>>`
  directives; measured byte drop recorded per variant.
- `node Tools/variant-smoke-test.mjs` green (each variant boots + renders a frame — the directive
  preservation is exercised by real shader selection).
- `capture-and-diff.mjs` byte-band (shaders still compile + render identically).
- A shader with adjacent comment+directive: directive survives.

**Model tier: opus-or-sol** (bounded, near-zero risk with the whitelist). Effort **S** (1 batch).
Independent — schedulable anytime.

---

### B.5 NEW-EMPTYMODULE-STUB-HARDENING — P2 · S · opus-or-sol

#### What + why

Register cluster-21 (LQ §6.5(c) incr. 2, PLANNED, stranded): "Harden `scripts/stubs/emptyModule.js`:
whitelist `Symbol.hasInstance` in the Proxy get-trap (today `instanceof SharedContext` would THROW at
Scene construction on pure-WebGPU) + named-export-aware stub mechanism. Prerequisite for leaf-strip
(B.10)." The variant plugin redirects WebGL-only modules to `emptyModule.js` (a throwing Proxy) in
webgpu-only builds — but an `instanceof` check against a stubbed class triggers the Proxy's get-trap
for `Symbol.hasInstance`, which THROWS, crashing Scene construction. Hardening the stub is the
prerequisite for stripping more leaves (B.10).

#### Architecture today (verified at HEAD)

- `scripts/stubs/emptyModule.js` — `const _stub = new Proxy(...)` (:23) with a `get(_target, prop)`
  trap (:30) that whitelists introspection symbols (`prop === Symbol.toStringTag ||` at :36 — the
  "without throwing — those happen at module-load time" comment :33) and THROWS otherwise (:16 error).
  **`Symbol.hasInstance` is NOT in the whitelist** (verified — the whitelist shows `toStringTag` but
  the grep did not surface `hasInstance`), so `x instanceof StubbedClass` throws.
- `scripts/bundleVariantPlugin.js` — redirects `Source/Renderer/WebGPU/**` (webgl-only) or
  WebGL-only leaves (webgpu-only) to the stub; `WEBGPU_COMPAT_EXEMPTIONS` (:134) is the exempt list.

#### Implementation walkthrough

**Step 0 (premise):** confirm a pure-webgpu build's `instanceof SharedContext` (or the exact class the
register names) path exists and would throw — grep for `instanceof` against a stubbable class in the
Scene-construction path; reproduce with a webgpu-only build if the smoke test doesn't already catch it.
1. **Whitelist `Symbol.hasInstance`:** add it to the get-trap whitelist so `instanceof` returns
   `false` (the stub is not an instance of anything) instead of throwing. The trap returns a function
   `() => false` for `hasInstance`, so `x instanceof Stub === false` — correct for a stubbed-out
   backend.
2. **Named-export-aware stub:** the current default-export Proxy doesn't cleanly handle named imports
   (`import { Foo } from stubbed`) — add a mechanism so named exports also resolve to the stub (or a
   per-name stub) without throwing at import time.
3. **Keep module-load-time introspection non-throwing** (the existing contract — :33 comment) while
   keeping RUNTIME access throwing (a genuine call to a stubbed API on the wrong variant SHOULD throw
   loudly).

#### Traps

1. **Runtime access must still throw** — the stub's value is that using a WebGL-only API in a
   webgpu-only build fails LOUDLY (not silently returns undefined). Only add introspection symbols
   (`hasInstance`) to the whitelist, never real methods.
2. `instanceof` returning `false` (not throwing) is correct — a stubbed backend genuinely is not an
   instance; the bug is the throw, not the answer.
3. This is the **prerequisite for B.10 (leaf-strip)** — land it first, then B.10 can strip more
   leaves knowing `instanceof` won't crash.
4. `WEBGPU_COMPAT_EXEMPTIONS` (bundleVariantPlugin:134) modules are NOT stubbed — the hardening is
   for the stubbed set only.

#### Verification recipe

- `node Tools/variant-smoke-test.mjs` green for webgpu-only AND webgl-only (each boots + renders) —
  the `instanceof` path is exercised by Scene construction.
- A deliberate `stubbed instanceof Class` returns `false`, does not throw.
- A deliberate runtime call to a stubbed API STILL throws (loud-failure preserved).
- `scripts/__tests__/bundleVariantPlugin.spec.mjs` green (+ add a hasInstance case).

**Model tier: opus-or-sol** (bounded, clear contract). Effort **S** (1 batch). **Prerequisite for
B.10.**

---

### B.6 S8-4 — feature-renderer registration lazify — P2 · S · **C10-06 RIDER (INTAKE-CONDITIONAL)** · opus-or-sol

#### What + why

Register cluster-21 (PR §9 S8-4, §16 fix 4; C10Q §5 C10-06 row): "41 eager vs 11 lazy FR
registrations put ~91% of the 6.6MB renderer source on the boot chunk regardless of scene content;
convert ~15 cold registrations to `registerFeatureRendererLoader` (biggest single win = lazifying
Model); also shrinks the webgpu-only variant." Blocker: "Verify C10-06 outcome first — if it lands
without the rider, this is the standalone remainder." **INTAKE-CONDITIONAL:** C10-06 (landing now)
may absorb this.

#### Architecture today (verified at HEAD)

- `packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts` — **41 `registerFeatureRenderer`
  calls** (verified `git grep -c` = 41) + `registerFeatureRendererLoader` (the lazy variant, ~11-13
  calls). The eager registrations pull ~91% of the renderer source onto the boot chunk.
- `packages/engine/Source/Renderer/FeatureRendererKey.js` — the enum key authority (O(1) lookup per
  CLAUDE.md "Enumerated Keys"); `GraphicsContext.ts` holds the registry.
- The lazy path `registerFeatureRendererLoader` uses `await import(...)` so the renderer's source
  lands in a separate chunk, downloaded only when the feature is used.

#### Implementation walkthrough

**Step 0 (INTAKE-CONDITIONAL premise):** read the C10-06 ledger row + `git log -- WebGPUFeatureRenderers.ts`.
**If C10-06 lazified these, this item is CLOSED — verify + drop.** If C10-06 landed without the
rider, this is the standalone remainder. Reproduce: measure the boot-chunk size + which FR sources
are eagerly pulled.
1. **Convert ~15 cold registrations to `registerFeatureRendererLoader`:** the biggest win is lazifying
   **Model** (the largest renderer source). Identify the cold FRs (not needed for a bare globe boot) —
   Model, voxel, cloud/weather, splat, etc. — and convert their `registerFeatureRenderer` to the
   loader variant.
2. **Keep hot FRs eager:** globe surface + the always-present renderers stay eager (lazifying them
   just adds a first-frame await). The judgment is cold-vs-hot per scene content.
3. **Variant interaction:** lazifying also shrinks the webgpu-only variant boot chunk (the
   `await import` chunk-splits per CLAUDE.md build-variant wiring).

#### Traps

1. **INTAKE-CONDITIONAL** — do not duplicate C10-06's work; verify its outcome first.
2. **First-use latency:** a lazified FR incurs a chunk-download on first use — for a cold FR that is
   fine (amortized), for a hot one it stalls the first frame. Only lazify genuinely-cold FRs.
3. **The FeatureRendererKey enum is the O(1) lookup** — lazification must not break the key→loader
   mapping (the loader registers under the same key, resolves on first `getFeatureRenderer(key)`).
4. **`FeatureRenderer failed-state` interaction** (standing-red `NEW-FEATURE-RENDERER-FAILED-STATE-RETRY`):
   a lazified FR whose chunk-fetch fails hits the terminal-failed-state bug — coordinate; a transient
   chunk-fetch failure must be retryable (that standing red owns the retry; this item must not make it
   worse).
5. **TTFF claim honesty (A.14):** boot-chunk shrink is a download-size + parse-time win — claim it via
   A.14's metric, not the stale proxy.

#### Verification recipe

- Boot-chunk size drops (Model + ~15 cold FRs off the boot chunk); webgpu-only variant shrinks.
- `node Tools/variant-smoke-test.mjs` green (lazy FRs still load on first use).
- A scene using each lazified FR renders correctly (the loader resolves).
- `capture-and-diff.mjs` byte-band (no rendering change, only load timing).
- First-complete-frame (A.14) unchanged-or-better; no first-frame stall from a lazified hot FR.

**Model tier: opus-or-sol** (bounded). Effort **S** (1 batch, IF C10-06 didn't absorb it).
**INTAKE-CONDITIONAL on C10-06.**

---

### B.7 NEW-TS-CONVERT-JS-RENDERERS — P2 · XL · **PREMISE-DRIFT (Model already .ts)** · opus-or-sol

#### What + why

Register cluster-21 (DW ~81, IN PROGRESS): "Convert the substantial JS WebGPU renderers to TS with
ZERO behavior change (no `any`): WebGPUModelRenderer (3802 LOC), GroundPolyline/GroundPrimitive,
WebGPUPrimitiveCommands, collection renderers, Vector3DTile trio, Environment/ShadowMap/SkyAtmosphere,
WebGPUEffectsBindGroup — one substantial renderer per batch."

**PREMISE-DRIFT (verified at HEAD — flag to orchestrator):** `WebGPUModelRenderer` is **already
`.ts`** (`packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts`, ~6193-LOC-class-era per
G4's 6950-line note) — the register's "WebGPUModelRenderer (3802 LOC)" JS target is **STALE; that
entry is DONE.** Likewise `WebGPUPrimitiveCommands` is `.ts` (referenced as `.ts` in G4). **The real
remaining JS targets** (verified `git ls-files`, 125 JS files still in the WebGPU dir) include:
`WebGPUBillboardRenderer.js`, `WebGPUPolylineRenderer.js`, `WebGPUPointPrimitiveRenderer.js`,
`WebGPULabelRenderer.js`, `WebGPUGroundPolylineRenderer.js`, `WebGPUGroundPrimitiveRenderer.js`,
`WebGPUVector3DTile{Polylines,ClampedPolylines,Primitive}Renderer.js`, `WebGPUEnvironmentRenderer.js`,
`WebGPUShadowMapRenderer.js`, `WebGPUSkyAtmosphereRenderer.js`, `WebGPUEffectsBindGroup.js`.

#### Architecture today (verified at HEAD)

- 125 `.js` + 204 `.ts` files under `Renderer/WebGPU/`. The conversion is one-substantial-renderer-per-
  batch, ZERO behavior change, no `any` (CLAUDE.md TS `any` ban — use `unknown`/interfaces/generics).
- Co-located `.d.ts` interop pattern (CLAUDE.md "Session 29 pattern") is the template for JS-class
  interop during conversion.

#### Implementation walkthrough

**Step 0 (premise — re-enumerate the list):** `git ls-files | grep 'Renderer/WebGPU/.*\.js$'` and
strike the already-converted entries (Model, PrimitiveCommands) from the register's list. Prioritize
by size/hot-path: the collection renderers (Billboard/Polyline/Point/Label) are the biggest cluster;
GroundPolyline/GroundPrimitive + Vector3DTile trio are classification-adjacent; Environment/ShadowMap/
SkyAtmosphere are the celestial/env family.
1. **One renderer per batch, ZERO behavior change:** convert `.js` → `.ts`, add types (no `any`),
   preserve every runtime path byte-identically. The oracle is byte-identical rendering + green specs.
2. **Co-located `.d.ts` for interop:** where a converting renderer imports an untyped JS sibling, add
   a `.d.ts` (CLAUDE.md template) rather than converting the sibling in the same batch (scope
   discipline).
3. **`@private` vs TS `private`** (CLAUDE.md): a JS method called cross-module needs `@internal` or a
   `.d.ts` public declaration, not TS `private` — do not break cross-module calls.

#### Traps

1. **PREMISE-DRIFT:** do not "convert" Model/PrimitiveCommands — they are done. Re-verify the list at
   Step 0.
2. **ZERO behavior change** — this is a mechanical type-add; any logic change is out of scope (one
   concern). A behavior change hidden in a TS conversion is the worst kind of regression (looks like a
   type edit).
3. **No `any`** (charter) — including `.d.ts`; use `unknown`/interfaces. WIP-module forward-looking
   interfaces (CLAUDE.md `feedback_interface_pruning`) must NOT be trimmed during conversion.
4. **XL / multi-batch** — this is a long tail, one renderer per batch; do not batch multiple large
   renderers (review + regression surface explodes).
5. Concurrent C10 worker edits renderer files — coordinate; do not convert a file C10 is mid-editing
   (check `git status` + the C10 ledger).

#### Verification recipe

- Per converted renderer: `npx tsc --noEmit` clean (no `any`, no new errors); the renderer's probe +
  `capture-and-diff` scene byte-band; its spec green.
- Full smoke test (`variant-smoke-test.mjs`) green.
- `git diff` scope = one renderer + its `.d.ts` interop shims.

**Model tier: opus-or-sol** (mechanical, disciplined). Effort **XL** (many batches, one renderer
each). Independent; low priority relative to the environment + define work.

---

### B.8 Q35-WEBGPUCONTEXT-DECOMP-REMAINDER — P2 · M · opus-or-sol

#### What + why

Register cluster-21 (LQ C5 #20 + §4.8, PARTIAL, culler-pool cluster landed B609): "WebGPUContext.ts /
WebGPUSceneRenderer.ts decomposition remainder: the SceneRenderer pass-family free-function
extraction is the last named cluster; both files far over the 1000-LOC guideline." CLAUDE.md's file-
size rule: files over ~1000 lines SHOULD be decomposed into focused modules.

#### Architecture today (verified at HEAD)

- `WebGPUContext.ts` = **6193 LOC**, `WebGPUSceneRenderer.ts` = **5044 LOC** (verified `wc -l` on the
  HEAD blobs) — both far over the 1000-LOC guideline. The register says the SceneRenderer **pass-family
  free-function extraction** is the last named decomposition cluster.
- Prior decomposition companions already exist: `WebGPUSceneRendererFrustumLoop.ts`,
  `WebGPUSceneRendererPickPass.ts`, `WebGPUSceneRendererClusteredLighting.ts` (per G1/G4 anchors) —
  the pattern is established; this extends it.

#### Implementation walkthrough

**Step 0 (premise):** confirm the LOC counts + identify the pass-family cluster in
`WebGPUSceneRenderer.ts` (the render-pass orchestration free functions). Do NOT decompose
performance-critical math or pure enum/data (CLAUDE.md exception).
1. **Extract the pass-family free functions** into a companion `WebGPUSceneRendererPasses.ts` (or the
   established naming), each with a clear single responsibility, keeping the extracted functions
   pure/free where possible (the register says "free-function extraction").
2. **WebGPUContext.ts:** identify a cohesive sub-responsibility (resource lifecycle? error scopes?
   pipeline plumbing?) and extract to a `*Helpers.ts`/domain companion — ZERO behavior change.
3. **Preserve JSDoc** (CLAUDE.md comment rules) on moved symbols; add no new boilerplate.

#### Traps

1. **ZERO behavior change** — extraction is a code-organization refactor; the oracle is byte-identical
   rendering + green specs. A behavior change hidden in a move is a stealth regression.
2. **Do not decompose the hot math/data** (CLAUDE.md exception) — only the pass-family orchestration.
3. Concurrent C10 worker edits `WebGPUContext.ts`/`WebGPUSceneRenderer.ts` heavily (G4 noted +350/+300
   LOC growth from C10 batches) — **HIGH collision risk.** Coordinate; do this AFTER the C10 boot wave
   settles, or the merge is brutal.
4. Multi-context (Principle 3): extracted free functions must not introduce module-level state that
   breaks multi-context (per-context state stays on the instance).

#### Verification recipe

- Both files under (or much closer to) 1000 LOC via extraction; companions each single-responsibility.
- `capture-and-diff.mjs` full scene set byte-band; the renderer probe sweep green.
- `npx tsc --noEmit` clean.
- `git diff` = pure move (extracted functions identical to their originals).

**Model tier: opus-or-sol** (mechanical). Effort **M** (1–2 batches). **Sequence AFTER the C10 boot
wave** (collision risk on the two hottest files).

---

### B.9 BACKLOG-§Recent — WebGPUComputePipelineCache — P2 · S · **PREMISE-DRIFT (cache EXISTS)** · opus-or-sol

#### What + why

Register cluster-21 (FI §C.8, WIP): "WebGPUModelRenderer + WebGPUAutoExposure don't route through a
central compute-pipeline cache **because it doesn't exist** — redundant compiles on hot init paths."

**PREMISE-DRIFT (verified at HEAD — flag to orchestrator):** `WebGPUComputePipelineCache` **EXISTS**
(`packages/engine/Source/Renderer/WebGPU/WebGPUComputePipelineCache.ts`, landed **Batch 76** per
`git log`, with a `WebGPUComputePipelineCacheSpec.js`). It has MANY consumers at HEAD
(AsyncResourceMonitor, WebGPUBrdfLutGenerator, WebGPUClippingPolygonCollection, WebGPUComputeEngine,
WebGPUDynamicEnvironmentMapManager, WebGPUGPUSortKeysDispatcher, WebGPUHiZOcclusionDispatcher, …).
**The real gap:** `WebGPUAutoExposure.ts` takes a `computePipelineCache` PARAM (:206, `= null`) and
holds a `_computePipelineCache` field (:72) but **still calls `device.createComputePipeline` DIRECTLY**
at :442 and :447 — it BYPASSES the cache it was handed. So the item is NOT "build the cache" — it is
"route the bypassing consumers (AutoExposure, and any others found) THROUGH the existing cache."

#### Architecture today (verified at HEAD)

- `WebGPUComputePipelineCache.ts` — exists, `getOrCreate`-style cache, per-device.
- `WebGPUAutoExposure.ts:442/:447` — `device.createComputePipeline({...})` direct calls (`_pass1Pipeline`,
  `_pass2Pipeline`) despite `_computePipelineCache` being available (:72, :206).
- Model: verify at intake whether `WebGPUModelRenderer.ts` has any direct `createComputePipeline`
  (the initial grep showed none — Model may already route through the cache or not use compute
  pipelines directly; re-verify).

#### Implementation walkthrough

**Step 0 (premise — CORRECT THE REGISTER):** confirm the cache exists (it does) and enumerate the
BYPASSING consumers: `git grep -n "device.createComputePipeline\|\.createComputePipeline" HEAD -- packages/engine/Source/Renderer/WebGPU`
and cross-check which of those hold a `_computePipelineCache` but call directly. AutoExposure is the
confirmed one; find the rest.
1. **Route AutoExposure through the cache:** replace the `device.createComputePipeline` calls (:442/447)
   with `this._computePipelineCache.getOrCreate(...)` (matching the cache's API — read it). The pass1/
   pass2 pipelines dedupe across instances/init paths.
2. **Route any other bypassing consumers** found in Step 0.
3. **Re-scope the ledger:** update the register/DEFERRED_WORK row from "cache doesn't exist" to "route
   bypassing consumers through the existing cache" (the premise correction is a deliverable).

#### Traps

1. **PREMISE-DRIFT** — the cache exists; do NOT build a second one. The whole item is re-scoped to
   routing.
2. The cache is per-device — AutoExposure's cache param may be `null` on some construction paths (:206
   default) — handle the null case (fall back to direct create, or ensure the cache is always passed).
   Rule-3 conservatism: if the cache can be null, keep a direct-create fallback rather than crash.
3. Compute-pipeline identity must match (same layout/entry-point) for the cache to dedupe — verify the
   pass1/pass2 descriptors are cache-key-stable.
4. Init-path only — this is a redundant-compile-on-init fix, not a per-frame path; claim it as an init
   savings, not a route-p95 win.

#### Verification recipe

- AutoExposure (+ other consumers) route through `WebGPUComputePipelineCache`; a counter shows compute-
  pipeline creates dedupe (2 instances → 1 compile per unique descriptor).
- `probe-stars-hdr-autoexposure-parity.mjs` + `diag-stars-hdr-autoexposure.mjs` green (AutoExposure
  output unchanged).
- `WebGPUComputePipelineCacheSpec.js` green (+ an AutoExposure-routing case).
- `capture-and-diff.mjs` HDR scene byte-band.

**Model tier: opus-or-sol** (bounded, mechanical routing). Effort **S** (1 batch). Independent.

---

### B.10 NEW-WEBGPUONLY-RENDERER-LEAF-STRIP — P3 · S · opus-or-sol

Register cluster-21 (LQ §6.5(c) incr. 3, PLANNED, stranded): "Add the 11 measured WebGL-only leaves
to `bundleVariantPlugin` for webgpu-only builds (−46 KB) + extend `variant-smoke-test` to boot-check
webgpu-only." Blocker: **`NEW-EMPTYMODULE-STUB-HARDENING` (B.5)** — the leaf-strip redirects more
modules to the stub, so the stub must first handle `instanceof` without throwing. **Architecture:**
`scripts/bundleVariantPlugin.js` (`WEBGPU_COMPAT_EXEMPTIONS` :134 is the exempt list; the strip adds
the 11 WebGL-only leaves to the redirect set for webgpu-only). **Walkthrough:** (Step 0) B.5 must
land first (verify the hardened stub handles `instanceof`); enumerate the 11 WebGL-only leaves
(measured −46 KB); add them to the webgpu-only redirect; extend `Tools/variant-smoke-test.mjs` to
boot-check the webgpu-only variant (currently under-covered). **Traps:** (1) hard-blocked on B.5 —
a leaf that gets `instanceof`-checked crashes without the hardening; (2) a leaf on the compat-exempt
list (backend-neutral) must NOT be stripped — cross-check `WEBGPU_COMPAT_EXEMPTIONS`; (3) the strip
must be webgpu-only (the leaves are WebGL's own code, needed in webgl-only/dual). **Verification:**
`variant-smoke-test.mjs` green including the new webgpu-only boot-check; −46 KB measured; dual +
webgl-only unaffected. **Model tier: opus-or-sol.** Effort **S**. **Sequence after B.5.**

---

### B.11 NEW-C9-01-COUNTER-PRAGMA-STRIP — P3 · S · **INTAKE-CONDITIONAL (boot remainder)** · opus-or-sol

Register cluster-21 (DW ~5353): "The C9-01 logical-counter blocks (23 sites across 4 files) are
runtime-gated not pragma-stripped — wrap in `//>>includeStart('debug')` keeping declarations outside
pragmas + permanent sentinels unwrapped; verify with `gulp buildRelease`." **PREMISE-VERIFIED at
HEAD:** the C9-01 counter blocks live in exactly **4 files** (`WebGPUGlobeSurfaceRenderer.ts`,
`WebGPUGlobeSurfaceTextures.ts`, `WebGPUGlobeSurfaceTileBuffers.ts`,
`Scene/GlobeSurfaceTileProviderRendering.js` — verified `git grep -l`). A release-build refinement:
runtime-gated counters cost even in production; wrapping them in `//>>includeStart('debug', pragmas.debug)`
strips them at zero runtime cost (CLAUDE.md logging/pragma rules). **Walkthrough:** (Step 0) confirm
the 23 sites are runtime-gated not pragma-wrapped; for each, wrap the COUNTER LOGIC in the debug
pragma while KEEPING the field declarations OUTSIDE the pragma (so the class shape is stable in
production) and **leaving permanent sentinels (loop guards, null-target, size-validation) UNWRAPPED**
(CLAUDE.md — real errors must always reach the console); verify with `npx gulp buildRelease` that the
counter blocks are gone from the minified output. **Traps:** (1) declarations OUTSIDE pragmas (the
CLAUDE.md pattern — a stripped declaration breaks the class); (2) NEVER wrap a permanent sentinel
(loop detector, null-target guard, device-lost) — only the informational counters; (3) the pragma
plugin handles `.ts` + `.js` (CLAUDE.md) — all 4 files covered. **INTAKE-CONDITIONAL:** these files
are globe-surface renderers the C10 boot wave may touch — verify no C10 collision first.
**Verification:** `gulp buildRelease` strips the counters (grep the minified output = 0); `gulp build`
(debug) keeps them; `capture-and-diff` byte-band. **Model tier: opus-or-sol.** Effort **S**.

---

### B.12 C6-SUBGROUP-COMPUTE-FINISH — P3 · S · opus-or-sol

Register cluster-21 (LQ C7 §4, DOWNGRADED narrow leftover, stranded): "FrustumCull + PointCloudLOD
subgroup variants wired; leftover = subgroup bucket-scan variant for PointCloudSort/DecoupledLookbackScan
(+ `WebGPUSubgroupUtils.ts` may be unused)." A narrow compute leftover: two subgroup variants are
wired, the bucket-scan variant for PointCloudSort/DecoupledLookbackScan is not. **PREMISE-UNVERIFIED —
flag:** the register says `WebGPUSubgroupUtils.ts` "may be unused" — this is a Principle-7 dead-code
question. **Step 0:** verify whether `WebGPUSubgroupUtils.ts` has consumers (`git grep -l WebGPUSubgroupUtils HEAD`)
and whether the bucket-scan leftover is still wanted (it depends on PointCloudSort/DecoupledLookbackScan
having consumers — the register's `FORK-41`/`FEAT-SURVEY-06` rows note those dispatchers ship WITHOUT
consumers, so a subgroup variant of an unconsumed dispatcher is speculative). **If the parent
dispatchers have no consumers, this leftover is NOT schedulable until they do** (Principle 7 — do not
build a subgroup variant of dead code; surface as gated). **If they gain consumers:** add the subgroup
bucket-scan variant behind subgroup feature detection with the non-subgroup path as fallback (CLAUDE.md
WASM/feature-detection pattern). **Model tier: opus-or-sol** (if unblocked). Effort **S**. **Likely
GATED on PointCloudSort/DecoupledLookbackScan consumer wiring — flag to orchestrator.**

---

### B.13 C10-00-ENGINE-HANDOFF-AND-SCRIPT-GEN — P3 · S · **GATED (orchestrator-mode)** · opus-or-sol

Register cluster-21 (C10Q §3.2 + §5, DEFERRED — orchestrator mode active): "Fork `campaign-9-resume.js`
→ campaign engine (fix stale 24-bit charter sentence to 40-bit; byte-identical schemas/safeAgent/loop;
splice TASKS + hard-rules block)." Blocker: "Only needed if C10/C11 reverts from orchestrator to
autonomous engine mode." **C11 disposition: this is a GATED infra item, not schedulable under
orchestrator mode.** The campaign is currently run by an orchestrator (this planning effort), not the
autonomous `campaign-N.js` engine. This item only matters if C11 execution reverts to the autonomous
engine (Fable-driven loop). **If that happens:** the C10 guide H7 Part B is the authoritative
handoff-mechanics reference (fork the script, keep CHARTER/schemas/`safeAgent`/loop byte-identical,
fix the stale "24-bit"→"40-bit" charter sentence per CLAUDE.md's current module-cache reality, splice
the C11 TASKS + hard-rules block, run the four validation gates, `RESEARCH=[]`). **The one concrete
deliverable even under orchestrator mode:** the CHARTER's "24-bit" sentence IS stale (the 40-bit
full-define key landed Batch 658; C10-08b will widen it further) — if the engine is ever regenerated,
fix it; but per the C10 guide's own note, editing CHARTER nukes the module cache, so for a FRESH
launch it is harmless and for a resume it is deliberately left. **Model tier: opus-or-sol** (if
triggered). Effort **S**. **GATED — orchestrator decision (see OPEN QUESTIONS).**

---
---

## Cross-cluster interaction matrix (this guide's items × landed/known state)

| Item(s) | Interacts with | Nature |
| --- | --- | --- |
| A.1 Karma launcher | A.4, A.5, A.9, A.16 + EVERY spec claim campaign-wide | Hard prerequisite — no truthful spec run without it; A.5/A.9 PAUSED specifically on it |
| A.2 spec freshness | every spec-touching item + G4's C9-17 recipe | Closes the workaround every guide copies by hand (QUICK START #9) |
| A.3 offline isolation | A.5 (M3 crashes), A.9 (KMZ fall-through), A.16 (truthful skips) | Isolates network specs so counts are honest |
| A.6/A.7/A.8/A.9 (items 66/67/69/70) | **A.16 (exit gate)** | The four owner items the exit gate cannot close without |
| A.11 GPU-timestamp cert | B.2 (define compile timing), B.3, B.6, S8-7, every GPU-lane perf claim | Prerequisite tooling — an uncertified timer invalidates the claim |
| A.14 first-complete-frame | **B.3, B.6 (boot TTFF claims)** | Guards the boot cluster from booking false stable-time credit |
| A.10 baseline cert + A.15 gate-F | standing-reds spheres drift; imagery/HDR settle | Certification honesty; never `--update` a moving/degenerate target |
| B.2 define-width | **C10-08 (banks bit 31, hard prereq)**, Q31 varyings, all model KHR/skinning/IBL/velocity axes | THE unblock for every new specialization axis; add-only freeze on bits 0-30 |
| B.3 module granularity | **C10-07 (async pipelines)**, C9-11/12A descriptor narrowing, `IMAGERY_PROJECTION.md` | INTAKE-CONDITIONAL on C10-07; keep projection doc in sync |
| B.5 stub hardening | **B.10 (leaf-strip prereq)** | `instanceof` must not throw before more leaves are stripped |
| B.6 FR-lazify | **C10-06 (may absorb)**, standing-red FR-failed-state-retry | INTAKE-CONDITIONAL on C10-06 |
| B.8 Q35 decomp | concurrent C10 worker on WebGPUContext/SceneRenderer | HIGH collision — sequence after the boot wave |
| B.9 compute-cache | (PREMISE-DRIFT) AutoExposure bypass | Cache exists; re-scope to routing bypassing consumers |
| B.1 material per-backend | `NEW-CAPABILITY-GETTER-CODIFY` closure | Retires the last sanctioned scene-code `isWebGPU` branch |
| commit-time (all) | lint-staged OOM on merges | `--concurrent 1` locally, never `--no-verify` |

---

## OPEN QUESTIONS for the orchestrator

1. **Is `C8-SHARED-UPSTREAM-CONTRACT-GATE` (item 72, A.16) the Campaign-11 EXIT GATE?** The task
   framing and the register both name it "natural C11 exit gate." This guide DESIGNS it as the
   campaign closer (§A.16): a full-suite certification with truthful executed/skipped/failed counts,
   gated on its four owner items (66/67/69/70) landing AND the environment (A.1/A.2/A.3) being stable.
   **Confirm this is the exit gate and that "campaign certifies" = "item 72 closes green with truthful
   counts."** If the maintainer wants a different exit criterion (e.g. C10-30-style perf checkpoint),
   say so — it changes what "done" means.

2. **How does the Karma environment get certified (A.1)?** This is the load-bearing question for the
   whole cluster. The launcher has three distinct failure modes (M1 profile collision, M2 post-SUCCESS
   disconnect artifact, M3 real-scene crash). M1+M2 are fixable determinism/truth-contract work; M3 is
   partly A.3 (offline) + A.4 (physical adapter). **Decide: is the Campaign-11 "spec green" bar the
   focused/unit lane (deterministic, headless) with the real-scene lane reported as executed/skipped
   counts, or must the full real-scene suite hold a headless session (which may need a real adapter
   the sandbox lacks)?** The exit gate's honesty depends on this ruling. Recommendation: focused lane
   is the hard gate; real-scene lane is truthfully counted, not required-green, until A.4 certifies
   the adapter.

3. **C10-06/07/08 outcomes (INTAKE-CONDITIONAL boot items).** B.6 (FR-lazify) may be absorbed by
   C10-06; B.3 (module granularity) sequences after C10-07; **C10-08 is the HARD PREREQUISITE for
   B.2 (define-width) — it banks bit 31 and exhausts the registry.** Please confirm the C10 boot wave's
   landing order and mark the residuals so these boot items open with the right scope (each is written
   conditionally). Until C10-08 lands, B.2 cannot start; until it lands, NO new define bit is possible
   (Q31 varyings + the model KHR/skinning/morph/instancing/IBL/velocity axes are all hard-blocked).

4. **Two PREMISE-DRIFT re-scopes (register is factually wrong at HEAD):**
   (a) `WebGPUComputePipelineCache` (B.9) **EXISTS** (Batch 76) — the item re-scopes from "build the
   cache" to "route bypassing consumers (AutoExposure :442/447) through it." (b) `WebGPUModelRenderer`
   (B.7) is **already `.ts`** — strike it from the TS-convert list; the real targets are the 125
   remaining JS files (collection renderers, GroundPolyline/Primitive, Vector3DTile trio, Environment/
   ShadowMap/SkyAtmosphere, EffectsBindGroup). **Should I file register corrections, or will the
   orchestrator amend the rows at assembly?**

5. **PREMISE-UNVERIFIED / GATED items to rule on:** `C6-SUBGROUP-COMPUTE-FINISH` (B.12) is likely
   gated on PointCloudSort/DecoupledLookbackScan gaining consumers (building a subgroup variant of an
   unconsumed dispatcher is speculative, Principle 7); `C10-00-ENGINE-HANDOFF` (B.13) is gated on
   reverting to autonomous engine mode (dead under orchestrator mode). `A.13` (C9-01 Gate-A closure)
   and `A.15` (gate-F refresh) are **maintainer-decision** rows: A.13 needs a Gate-A amendment OR the
   unrecoverable `B8015811` bundle; A.15 must wait until in-flight globe/HDR pixel changes settle.
   Please rule on all four.

6. **Sequencing constraint (W1 of Campaign-11):** the three environment fixes (A.1 launcher, A.2 spec
   freshness, A.3 offline isolation) should land FIRST — every downstream spec/gate claim in the whole
   campaign is unfalsifiable until they do, and two exit-gate owners (A.5, A.9) are PAUSED specifically
   on them. Confirm they get W1 priority over feature work in other clusters.

7. **A.11 (GPU-timestamp cert) + A.14 (first-complete-frame metric) are prerequisite TOOLING for
   perf claims across clusters** (B.2/B.3/B.6 here; S9-4/S11-1 in the model guide; every GPU-lane
   claim). Should they be scheduled as early tooling rows with their own register entries, or folded
   into the first perf item that needs them? Recommendation: schedule both early — an uncertified
   timer or a stale TTFF proxy silently invalidates every perf number that cites it.

---

*Guide ends. 29 items covered (16 test-infra, 13 build-boot). All anchors verified against
`9204647535` (Batch 701); drift from the Batch-698 register noted inline (two PREMISE-DRIFT
re-scopes flagged: WebGPUComputePipelineCache exists; WebGPUModelRenderer already .ts). No C11-XX
numbers assigned — register names only. The C8-SHARED-UPSTREAM-CONTRACT-GATE is designed as the
Campaign-11 EXIT GATE (§A.16); the boot/TTFF remainder is written INTAKE-CONDITIONAL on C10-06/07/08;
the exhausted-ShaderDefine-registry define-width expansion (C10-08b) is designed as the hard
prerequisite for any new define bit (§B.2).*
