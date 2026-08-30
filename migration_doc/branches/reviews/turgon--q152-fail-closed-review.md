# Q-152 Fail-Closed Safety Landing Review

- Reviewer: Turgon
- Date: 2026-08-29
- Role: independent read-only review lead
- Candidate: repaired Q-152 wave-end gate tuple
- Review scope: fail-closed safety landing only
- Certification scope: explicitly excluded
- Verdict: **GO for fail-closed safety landing only — NOT certification**

## Exact reviewed tuple

Repository clone:

`F:\Dev\GH\cesium-lane-tuor-q152-20260829`

Git boundary:

- HEAD: `a64954b94507fa29762964f3d410517ddd765e9e`
- Tree: `3247f590e9613b34320e6a9abbb676a132d00cd4`
- Branch: `sol/q-152-wave-end-gate-repair-ba64954b945-2026-08-29`
- Dirty boundary: exactly two modified paths:
  - `Tools/wave-end-gate.mjs`
  - `Tools/wave-end-gate.spec.mjs`

Frozen file tuple:

| Path | Bytes | SHA-256 | Diff numstat |
| --- | ---: | --- | --- |
| `Tools/wave-end-gate.mjs` | 54,992 | `CDB2AFE98834A6D380156C8D2BD81A5755D49FD16CB86D9E7A8A90303591BFD0` | `1468/354` |
| `Tools/wave-end-gate.spec.mjs` | 38,090 | `3F1A331378D83B5998C102154170E0CAC905D296054D9C6835B744DEA67BA8AA` | `1126/74` |

Opening and terminal byte counts, hashes, HEAD, tree, dirty paths, and numstat matched. `git diff --check` found no whitespace errors and emitted only the existing LF-to-CRLF working-copy warning.

The complete current contents and complete HEAD diff of both candidate files were reviewed: 2/2 candidate files and 3,163/3,163 current source lines.

## Verdict boundary

This GO establishes only that the exact frozen tuple safely prevents the currently unbindable canonical plan from spawning children or publishing PASS, including through the previously identified injected-executor bypass.

It does not certify Q-152, any child adapter, a served build, a browser run, a wave, or a future patch. The canonical gate remains deliberately STRUCTURAL until the disclosed provenance, served-subject, child-result, status, lifecycle, baseline-review, runner, handoff, and ledger defects are repaired and independently reviewed on a new frozen tuple.

## Prior blocking finding B1

### Prior defect

The preceding tuple applied `decidePreSpawnBindability` only inside the default `executeStepPlan`. Exported `main` accepted `dependencies.executePlan`, so an importer could supply a full-length all-PASS execution, bypass the default executor’s barrier, and let the real receipt writer publish PASS.

### Current source trace

1. `buildStepPlan` still marks `visual-regression` unbindable during the pre-spawn phase at `Tools/wave-end-gate.mjs:399-420`.
2. The plan, step objects, arguments, environment, and bindability records are frozen at `Tools/wave-end-gate.mjs:422-432`.
3. `main` validates any offered plan and then replaces it with a newly generated canonical plan at `Tools/wave-end-gate.mjs:1851-1855`.
4. Planned files are statted before execution at `Tools/wave-end-gate.mjs:1857-1864`.
5. Dry run returns STRUCTURAL before execution at `Tools/wave-end-gate.mjs:1866-1875`.
6. The main-level pre-spawn barrier now runs at `Tools/wave-end-gate.mjs:1877-1881`.
7. Only after that barrier can `dependencies.executePlan` or the default executor be consulted at `Tools/wave-end-gate.mjs:1883-1889`.
8. The blocked plan produces one nonexecution STRUCTURAL receipt per canonical step, all with `spawned:false`, through `Tools/wave-end-gate.mjs:1166-1207`.
9. The new adversarial specification supplies a complete typed all-PASS executor and child spy and requires STRUCTURAL, zero executor calls, and zero child calls at `Tools/wave-end-gate.spec.mjs:424-490`.
10. The production-source mutant disables the bindability predicate and expects PASS plus one adapter call per planned child at `Tools/wave-end-gate.spec.mjs:1178-1220`.

### Disposition

**B1: FIXED by static inspection; runtime NOT-RETESTED.**

With the exact canonical plan and absent source mutation, exported `main` reaches the main-level barrier before any executor seam. The offered all-PASS executor and child spy are therefore inert, and the gate publishes a full-plan STRUCTURAL result rather than PASS.

The main-level adversarial case specifically catches moving the barrier back inside only the default executor. The production-source mutant separately demonstrates that the predicate remains load-bearing and that disabling it can expose the future execution path.

## Safety-landing acceptance matrix

| Requirement | Disposition |
| --- | --- |
| Exact frozen two-file tuple | PASS |
| Opening and terminal hashes match | PASS |
| Only leased candidate paths modified | PASS |
| Canonical four-tier status table | PASS |
| Empty result set cannot PASS | PASS |
| Dry run cannot PASS | PASS |
| Exact plan cardinality, ordering, arguments, environment, and bindability | PASS |
| Mutable offered plan discarded after validation | PASS |
| Canonical replacement plan frozen | PASS |
| All unique child paths statted before execution | PASS |
| Capture blocker represented as pre-spawn STRUCTURAL | PASS |
| Main-level barrier precedes every executor seam | PASS |
| Full-length injected all-PASS executor remains inert | PASS by static source trace; NOT-RETESTED dynamically |
| Injected child spy remains at zero calls | PASS by static source trace; NOT-RETESTED dynamically |
| Full nonexecution receipt covers every planned step | PASS |
| No current canonical path can publish PASS | PASS for the reviewed source boundary |
| Wave certification | EXCLUDED and not achieved |

## Carry-forward findings

### Fixed in this tuple

| Prior finding | Status |
| --- | --- |
| Private and divergent exit-code table | FIXED: imports the frozen PASS 0 / FAIL 1 / ERROR 2 / STRUCTURAL 3 table |
| Empty plan folded to PASS | FIXED: empty fold is STRUCTURAL |
| Dry run could look successful | FIXED: named STRUCTURAL nonexecution result |
| Missing or wrong Sandcastle child wiring | FIXED: actual `sandcastle-smoke.mjs`, `--sandcastle2`, `--renderer=<backend>`, and correct environment |
| Incorrect repeated-run topology | FIXED: unique interleaved WebGL/WebGPU step identities |
| Shallow served-MD5 extraction | FIXED for the two declared preflight artifacts |
| Missing exact-plan validation | FIXED |
| Missing planned-file preflight | FIXED |
| Raw exit alone could carry a verdict | FIXED on the normal adapter path: canonical typed result required |
| Runtime error/signal/timeout/null/unknown-exit classification | FIXED statically; NOT-RETESTED |
| Typed-result source, served-subject, freshness, chronology, and quiescence checks | FIXED statically in the normalizer; NOT-RETESTED |
| Fixed-report predecessor freshness check | FIXED statically; NOT-RETESTED |
| Missing direct-child watchdog | PARTIALLY FIXED statically; descendant process-tree proof remains open |
| Injected all-PASS executor bypass | FIXED by the main-level barrier; NOT-RETESTED |

### Open direct-gate blockers

1. **The canonical plan remains intentionally noncertifying.**
   `capture-and-diff` is pre-spawn-unbindable, so the current gate must return STRUCTURAL and cannot close a wave.

2. **Source provenance is caller supplied.**
   `--source-commit`, `--source-dirty`, and `--source-identity` are syntax-checked and recorded, but not independently derived or verified. The identity algorithm, subject boundary, and authoritative root receipt remain undefined.

3. **The served-subject preflight is incomplete.**
   It covers only:
   - `Build/CesiumUnminified/Cesium.js`
   - `packages/engine/Build/Unminified/index.js`

   It does not cover every transitive bundle, asset, page, or browser-consumed response used by all child tools.

4. **The final injected-execution trust boundary remains shallow.**
   `isExecutionResultContract` checks ordering and receipt shape but does not independently rerun typed provenance, freshness, served-subject, and quiescence normalization. The main barrier makes this unreachable now; it must be repaired or sealed before any plan becomes bindable.

5. **Publication lifecycle is noncertifying.**
   `writeReceiptFiles` directly overwrites fixed `receipt.json` and `summary.md`. Missing lifecycle properties include:
   - UUID/archive identity;
   - authoritative RUNNING/latest state;
   - atomic final publication;
   - ownership and locking;
   - complete invocation ledger;
   - retry and crash recovery;
   - predecessor preservation;
   - foreign-successor protection;
   - first-red preservation.

6. **Baseline-review provenance is synthetic.**
   The capture command automatically supplies `--reviewed-by wave-end-gate:<wave>`. This is self-attestation rather than independently attributable review. It is presently unreachable.

7. **Descendant process-tree quiescence is unproven.**
   The parent records direct-child close and truthfully reports that this does not prove descendant quiescence. The current zero-spawn boundary avoids runtime exposure, but future certification requires a complete quiescence contract.

8. **Runtime behavior remains NOT-RETESTED.**
   No test, mutant, watchdog, child, build, server, browser, or real gate was executed during this review.

### Open transitive child blockers

#### Variant smoke test

- Consumes three variant bundles not all covered by the parent’s two-artifact preflight.
- Emits no canonical typed current-run result.
- Does not bind root source, exact served responses, freshness, and descendant quiescence.
- Uses noncanonical setup/exception exit behavior.
- Correctly remains declared post-spawn-unbindable.

#### Sandcastle2 sweep

- Fixed report lacks canonical status, current run ID, root source, served subject, freshness, and quiescence proof.
- Timeout and device-loss paths collapse into ordinary failure rather than ERROR.
- Origin refusal uses ERROR’s exit rather than STRUCTURAL.
- Correctly remains declared post-spawn-unbindable.

#### Capture-and-diff

- `scenes.json` targets hardcoded port 8080 while the gate forbids 8080 and preflights 8094/8095.
- Derives Git metadata internally rather than verifying the root-supplied tuple.
- Has no served-origin CLI contract or canonical typed current-run receipt.
- NON_CERTIFYING and exception paths use noncanonical exit topology.
- Device loss is folded into product FAIL rather than ERROR.
- A `tilesLoaded` timeout can continue into capture.
- Baseline promotion uses synthetic reviewer identity.
- Correctly remains the pre-spawn blocker that makes the whole plan STRUCTURAL.

## Required status topology

- **STRUCTURAL / exit 3:** missing, stale, malformed, or unverifiable provenance; missing subject or prerequisite; served-subject mismatch; absent typed contract; missing readiness or measurement witness; required quiescence unproven; unbindable canonical plan.
- **ERROR / exit 2:** import, spawn, browser, adapter, device-loss, timeout, cleanup, result-read, or unexpected runtime failure.
- **FAIL / exit 1:** only a valid, complete, provenance-bound measurement with a registered product or expectation miss.
- **PASS / exit 0:** only when every exact planned step has a fresh canonical typed result bound to the same source and served subject, all registered predicates pass, lifecycle is sound, and nothing is unscored, structural, or erroneous.

## Runner, handoff, and ledger blockers

### Package runner

`package.json` provides the runner home:

`"wave-end-gate": "node Tools/wave-end-gate.mjs"`

It does not derive or supply the required authoritative source tuple.

### Handoff

`migration_doc/CODEX_HANDOFF_2026-08-29.md` still shows:

`npm run wave-end-gate -- --wave wave1`

That command omits all mandatory source arguments and therefore fails closed as STRUCTURAL. It is not an operational certification command.

### Ledger

`migration_doc/FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md` still describes the predecessor implementation and its former PASS/FAIL/REFUSED topology. It cannot support or validate this repaired tuple.

The ledger needs an orchestrator-owned update after authorized landing and validation. No ledger edit was authorized or performed here.

## Required before any certification claim

- Authoritative derivation and verification of source commit, dirty state, and source identity.
- Defined source-identity algorithm and immutable root provenance receipt.
- Exact preflight of every child-consumed served artifact and browser response.
- Canonical typed current-run results from variant, Sandcastle, and capture children.
- Same-run source, served-subject, freshness, readiness/frame, and quiescence binding.
- Final parent-side independent renormalization of child evidence.
- Canonical ERROR handling for timeouts, device loss, cleanup failures, and exceptions.
- STRUCTURAL handling for absent prerequisites, provenance, or subject.
- Preservation of genuine measured product misses as FAIL.
- Independently attributable baseline-review approval.
- UUID run archives and authoritative RUNNING/latest lifecycle.
- Atomic finalization, locks, ownership, retries, crash recovery, predecessor preservation, and foreign-successor protection.
- Updated package/runbook invocation carrying the complete source tuple.
- Updated ledger describing the repaired contract.
- Authorized execution of specs and mutants on the final tuple.
- Authorized build, server, browser, and real-gate evidence.
- A new freeze and independent review after any further byte change.

## Files reviewed

Fully read:

- `.agents/skills/audit-cesium-certification/SKILL.md`
- `AGENTS.md`
- `Tools/wave-end-gate.mjs`
- `Tools/wave-end-gate.spec.mjs`
- Complete HEAD diff for both candidate files
- `Tools/visual-regression/lib/verdict-exit-gate.mjs`

Relevant governing and campaign context read:

- `migration_doc/CAMPAIGN_STATE.md`
- `migration_doc/EXECUTOR_LANE_CHARTER_2026-08-14.md`
- `migration_doc/MAINTAINER_RULINGS_2026-08-28.md`
- `migration_doc/FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md`
- `migration_doc/QUEUE_2026-08-29_RESEARCH_DISPATCH.md`
- `migration_doc/CODEX_HANDOFF_2026-08-29.md`
- `package.json`

Nimrodel independently reviewed the transitive provenance/security boundary, including:

- `Tools/visual-regression/scenes.json`
- `Tools/visual-regression/capture-and-diff.mjs`
- `Tools/visual-regression/sandcastle-smoke.mjs`
- `Tools/variant-smoke-test.mjs`

## Read-only commands used

- `Get-Content -LiteralPath`
- line-numbered `Get-Content` chunk loops
- `Get-Item -LiteralPath`
- `Get-FileHash -Algorithm SHA256`
- `rg --files`
- `rg -n -C`
- `git rev-parse HEAD`
- `git rev-parse 'HEAD^{tree}'`
- `git branch --show-current`
- `git status --short --branch`
- `git diff --stat`
- `git diff --numstat`
- chunked complete `git diff --no-ext-diff --unified=3`
- `git diff --check`

The separate repair clone required escalated read-only shell access because it is outside the writable workspace boundary. No mutation authority was requested or exercised.

## Source, inference, and uncertainty statement

Confirmed facts derive from the exact frozen source tuple, its complete diff, terminal identity checks, the canonical verdict table, and cited governance/source lines.

The zero-call result for the offered all-PASS executor and child spy is a static control-flow conclusion. It was not dynamically executed by this reviewer.

All runtime behavior is **NOT-RETESTED**. No claim is made that the specification suite passes, any child currently produces a valid typed result, a server can serve the required build, browser/device cleanup works dynamically, or a real wave-end receipt exists.

This report does not certify the repaired gate, any child, a served build, a wave, or an unfrozen future patch.

## Explicit action and quiescence declaration

I made no edits and performed no Git writes, tests, builds, browser activity, server activity, real gate execution, child execution, network access, installation, evidence publication, push, branch or name change, or other external-state action.

At report delivery, this review lane has no running reviewer-owned command, browser, server, gate, child process, publication, or external action. Nimrodel’s reused review lane has completed and delivered its separate report. This reviewer-lane quiescence does not prove descendant-process quiescence for any future gate execution; that remains untested and open.
