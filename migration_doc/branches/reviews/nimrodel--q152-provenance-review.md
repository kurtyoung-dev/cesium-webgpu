# Q-152 Provenance and Fail-Closed Safety Review

- Reviewer: Nimrodel
- Date: 2026-08-29
- Role: independent read-only provenance/security reviewer
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
- Dirty boundary: exactly two modified paths:
  - `Tools/wave-end-gate.mjs`
  - `Tools/wave-end-gate.spec.mjs`

Frozen file tuple:

| Path | Bytes | SHA-256 | Diff numstat |
| --- | ---: | --- | --- |
| `Tools/wave-end-gate.mjs` | 54,992 | `CDB2AFE98834A6D380156C8D2BD81A5755D49FD16CB86D9E7A8A90303591BFD0` | `1468/354` |
| `Tools/wave-end-gate.spec.mjs` | 38,090 | `3F1A331378D83B5998C102154170E0CAC905D296054D9C6835B744DEA67BA8AA` | `1126/74` |

Opening and terminal hashes, sizes, HEAD, tree, dirty paths, and numstat matched. `git diff --check` reported no whitespace defects; it emitted only the existing LF-to-CRLF warning for both working-copy files.

The audited fraction is the complete current content and complete HEAD diff of both candidate files: 2/2 candidate files, 3,163/3,163 current source lines, and all diff lines. Governing and transitive files were reviewed through the exact relevant excerpts listed below. No runtime artifact or browser evidence was reviewed or created.

## Verdict boundary

This GO means only that the repaired tuple safely prevents the currently unbindable canonical wave-end plan from spawning children or publishing PASS, including through the previously exploitable injected-executor seam.

It does not mean that Q-152 can certify a wave. The gate remains intentionally noncertifying and must return STRUCTURAL until the disclosed child, provenance, served-subject, status, lifecycle, baseline-review, runner, handoff, and ledger blockers are repaired and independently reviewed on a new frozen tuple.

## Decisive B1 re-review

### Prior blocker

The preceding tuple placed the pre-spawn bindability barrier only inside the default `executeStepPlan`. Because `main` exported an injectable `dependencies.executePlan`, an importer could bypass the barrier with a full-length forged all-PASS result and cause a PASS receipt.

### Current source facts

- The canonical plan marks `capture-and-diff` unbindable in the pre-spawn phase at `Tools/wave-end-gate.mjs:399-420`.
- `buildStepPlan` freezes the plan, its steps, arguments, environment, and bindability records at `Tools/wave-end-gate.mjs:422-432`.
- `main` validates an offered plan and then discards it in favor of a newly generated canonical plan at `Tools/wave-end-gate.mjs:1851-1855`.
- Planned child paths are checked before execution at `Tools/wave-end-gate.mjs:1857-1864`.
- Dry run returns STRUCTURAL before execution at `Tools/wave-end-gate.mjs:1866-1875`.
- The main-level bindability barrier now executes at `Tools/wave-end-gate.mjs:1877-1881`.
- Only after that barrier can `dependencies.executePlan` or the default executor be called at `Tools/wave-end-gate.mjs:1883-1889`.
- The barrier’s nonexecution result supplies a STRUCTURAL receipt for every planned step, with `spawned:false`, at `Tools/wave-end-gate.mjs:1166-1207`.
- The new adversarial specification offers a complete all-PASS executor and a child spy, then requires STRUCTURAL, zero executor calls, and zero child calls at `Tools/wave-end-gate.spec.mjs:424-490`.
- The production-source mutant disables the bindability predicate and expects the mutated gate to PASS after invoking every planned child adapter at `Tools/wave-end-gate.spec.mjs:1178-1220`.

### Disposition

**B1: FIXED by static inspection; runtime NOT-RETESTED.**

Inference from the reviewed source: with the current canonical plan and absent source mutation, exported `main` cannot reach an injected executor or child. The main-level barrier therefore closes the identified false-certification path.

## Carry-forward findings

### Direct gate findings

| Finding | Status | Evidence and consequence |
| --- | --- | --- |
| Canonical four-tier verdict table | FIXED | The gate imports the frozen status table at `Tools/wave-end-gate.mjs:10-16`. The authoritative meanings and exits are PASS 0, FAIL 1, ERROR 2, STRUCTURAL 3 in `Tools/visual-regression/lib/verdict-exit-gate.mjs`. |
| Empty result set could PASS | FIXED | `foldStatuses([])` returns STRUCTURAL at `Tools/wave-end-gate.mjs:109-126`. |
| Dry run could be treated as success | FIXED | Dry run returns named STRUCTURAL before execution at `Tools/wave-end-gate.mjs:1866-1875`. |
| Missing or altered child plan | FIXED | Exact cardinality, order, duplicate-name, and byte-shape comparison are enforced at `Tools/wave-end-gate.mjs:648-685`. |
| Missing planned child paths | FIXED | Missing/not-file paths are STRUCTURAL; unexpected stat failures are ERROR at `Tools/wave-end-gate.mjs:687-727`. |
| Served MD5 receipt was incomplete | FIXED for the two declared artifacts | Nested disk/served status, length, MD5, URL, and match fields are validated at `Tools/wave-end-gate.mjs:521-565`; exact two-record preflight cardinality and order are enforced at `Tools/wave-end-gate.mjs:568-645`. |
| Raw child evidence was collapsed into a summary | FIXED | Receipt steps retain raw process result, cleanup, quiescence, normalized result, and typed result at `Tools/wave-end-gate.mjs:477-490`. |
| Runtime failures could be mistaken for product failures | FIXED in the gate adapter; NOT-RETESTED | Spawn error, timeout, cleanup failure, signal, null exit, and unknown exit normalize to ERROR at `Tools/wave-end-gate.mjs:872-913`. |
| Typed-result freshness and binding | FIXED in the normalizer; NOT-RETESTED | Schema, step name, status/exit, run ID, chronology, source tuple, served subject, descendant quiescence, and raw/typed exit agreement are checked at `Tools/wave-end-gate.mjs:928-1047`. |
| Fixed-report freshness | FIXED in source; NOT-RETESTED | A report must be within the raw child time window and differ from the predecessor bytes at `Tools/wave-end-gate.mjs:1049-1151`. |
| Main-level injected-executor bypass | FIXED in this tuple; NOT-RETESTED | Main-level barrier precedes the injection seam at `Tools/wave-end-gate.mjs:1877-1889`; adversarial all-PASS executor and child spy are present at `Tools/wave-end-gate.spec.mjs:424-490`. |
| Caller-supplied source provenance | OPEN — certification blocker | `--source-commit`, `--source-dirty`, and `--source-identity` are syntax-checked at `Tools/wave-end-gate.mjs:305-323` and copied at `Tools/wave-end-gate.mjs:1153-1163`, but the gate does not independently derive or verify them. The identity algorithm and authoritative root receipt remain undefined in this runbook. |
| Whole-plan served-subject preflight | OPEN — certification blocker | The preflight covers only `Build/CesiumUnminified/Cesium.js` and `packages/engine/Build/Unminified/index.js` at `Tools/wave-end-gate.mjs:508-519`. It does not bind all transitive served dependencies consumed by the three child tools. |
| Final trust boundary for injected execution results | OPEN — future certification blocker | `isExecutionResultContract` checks ordered shape and shallow normalized fields at `Tools/wave-end-gate.mjs:1592-1675`; it does not independently rerun typed provenance/freshness normalization. The current main barrier makes this unreachable, but it must be sealed or re-normalized before any plan becomes bindable. |
| Publication lifecycle | OPEN — certification blocker | `writeReceiptFiles` directly overwrites fixed `receipt.json` and `summary.md` paths at `Tools/wave-end-gate.mjs:1429-1450`. There is no UUID archive, authoritative RUNNING state, atomic final publication, ownership lock, retry receipt, predecessor preservation, foreign-successor protection, or crash recovery. |
| Baseline review provenance | OPEN — certification blocker | Baseline promotion automatically supplies `--reviewed-by wave-end-gate:<wave>` at `Tools/wave-end-gate.mjs:399-410`. This is synthetic self-attestation, not independent review identity. It is unreachable in the current zero-spawn plan. |
| Current canonical plan | OPEN by design | `capture-and-diff` remains pre-spawn unbindable at `Tools/wave-end-gate.mjs:399-420`; therefore the current gate must remain STRUCTURAL and cannot close a wave. This is accepted only for the narrow fail-closed landing. |

### Transitive served-subject and child-adapter findings

#### Variant smoke test

Status: **OPEN — transitive certification blocker**

- It consumes three bundles:
  - `Build/Cesium/Cesium.js`
  - `Build/CesiumWebGL/Cesium.js`
  - `Build/CesiumWebGPU/Cesium.js`

  See `Tools/variant-smoke-test.mjs:52-69`.

- Those three exact served artifacts are not included in the gate’s two-artifact preflight.
- The child emits no canonical current-run typed result carrying root source, served-subject identity, freshness, and descendant-quiescence proof.
- It exits 0/1 for product summary, 2 for setup/argument failures, and 99 for an uncaught runtime error at `Tools/variant-smoke-test.mjs:643-695`.
- The parent correctly discloses this adapter as post-spawn unbindable at `Tools/wave-end-gate.mjs:363-375`.

#### Sandcastle2 sweep

Status: **OPEN — transitive certification blocker**

- The parent now selects the actual child and correct flags/environment at `Tools/wave-end-gate.mjs:378-397`.
- The fixed report contains renderer, total, passed, failures, and timeouts but no canonical status, run ID, root-supplied source tuple, served-subject identity, freshness binding, or quiescence proof at `Tools/visual-regression/sandcastle-smoke.mjs:702-726`.
- Timeout and device-loss outcomes are folded into the child’s ordinary failure path and return 1, although harness timeout and device loss require ERROR.
- Origin refusal returns 2 at `Tools/visual-regression/sandcastle-smoke.mjs:672-675`, while inability to establish the required served subject is STRUCTURAL.
- The parent correctly discloses this adapter as post-spawn unbindable at `Tools/wave-end-gate.mjs:378-397`.

#### Capture-and-diff

Status: **OPEN — pre-spawn transitive blocker**

- `Tools/visual-regression/scenes.json` fixes the capture page to `http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html`.
- The wave-end gate forbids 8080 and preflights 8094/8095, so it cannot bind capture to the preflighted served subject.
- The child derives source commit and dirty state using its own Git calls at `Tools/visual-regression/capture-and-diff.mjs:145-155`, rather than consuming and verifying the root tuple.
- NON_CERTIFYING exits 1, and exceptions exit 99 at `Tools/visual-regression/capture-and-diff.mjs:1084-1131`.
- Device loss is folded into the child’s FAIL result at `Tools/visual-regression/capture-and-diff.mjs:1009-1031`; the charter classifies device loss as ERROR.
- A `tilesLoaded` timeout is caught and capture continues at `Tools/visual-regression/capture-and-diff.mjs:596-616`.
- The child has no served-origin argument and no canonical typed current-run receipt.
- The parent correctly treats this as a pre-spawn blocker at `Tools/wave-end-gate.mjs:399-420`, which makes the entire current plan STRUCTURAL with zero spawns.

## Required status semantics

The following classification remains mandatory:

- **STRUCTURAL / exit 3**
  - missing, stale, malformed, or unverifiable provenance;
  - absent or malformed typed child contract;
  - missing child/prerequisite/subject;
  - served-subject mismatch;
  - missing readiness or measurement witness;
  - unproven required quiescence;
  - an unbindable canonical plan.

- **ERROR / exit 2**
  - import or spawn failure;
  - browser or adapter failure;
  - device loss;
  - operation timeout;
  - cleanup deadline or teardown failure;
  - result-read failure;
  - unexpected runtime exception;
  - malformed data returned by a trusted runtime dependency seam.

- **FAIL / exit 1**
  - only a complete, valid, provenance-bound measurement in which a registered product or expectation predicate misses.

- **PASS / exit 0**
  - only when every exact planned step has a fresh canonical typed result bound to the same root source and preflighted served subject, all registered predicates pass, cleanup/quiescence is proven, and no result is unscored, structural, or erroneous.

The governing definitions are at `migration_doc/EXECUTOR_LANE_CHARTER_2026-08-14.md:105-141` and the fleet watchdog requirements at `migration_doc/EXECUTOR_LANE_CHARTER_2026-08-14.md:194-215`.

## Runner, handoff, and ledger blockers

### Package runner

Status: **OPEN**

`package.json:199` defines:

`"wave-end-gate": "node Tools/wave-end-gate.mjs"`

This runner home exists, but it does not derive or supply the required source tuple.

### Handoff command

Status: **OPEN / SUPERSEDED by the repaired CLI contract**

`migration_doc/CODEX_HANDOFF_2026-08-29.md:101` still instructs:

`npm run wave-end-gate -- --wave wave1`

That command omits all three mandatory source arguments and therefore returns STRUCTURAL before child execution. This is fail-closed, but the runbook is not operational until the authoritative root invocation supplies and verifies the source tuple.

### Ledger

Status: **OPEN / stale historical description**

`migration_doc/FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md:198` describes the prior landed implementation as PASS/FAIL/REFUSED with exits 0/2/3, Git tip, shallow served MD5 fields, and captured child exit codes. The repaired gate now uses PASS/FAIL/ERROR/STRUCTURAL, exits 0/1/2/3, explicit source/served-subject records, and a zero-spawn STRUCTURAL boundary.

The ledger must not be treated as evidence for the repaired tuple. It needs a later orchestrator-owned update after landing, authorized validation, and independent review. No ledger mutation was authorized or performed in this review.

The governing maintainer requirement remains `R-2026-08-29-2` at `migration_doc/MAINTAINER_RULINGS_2026-08-28.md:261-265`: a wave does not close without a banked wave-end receipt. The current repaired tuple safely refuses; it does not yet provide such a closing receipt.

## Acceptance checklist

### Satisfied for this fail-closed landing

- [x] Exact two-file tuple frozen by path, byte length, and SHA-256.
- [x] Opening and terminal tuple hashes match.
- [x] HEAD, tree, dirty boundary, and numstat match the dispatch.
- [x] Only the two leased candidate files are modified.
- [x] Complete candidate files and complete HEAD diffs reviewed.
- [x] Canonical verdict vocabulary and exit mapping used.
- [x] Empty status fold is STRUCTURAL.
- [x] Dry run is STRUCTURAL.
- [x] Exact plan cardinality/order/content validated.
- [x] Canonical frozen plan regenerated after validating an injected plan.
- [x] All unique planned child paths checked before execution.
- [x] Capture-and-diff is truthfully marked pre-spawn unbindable.
- [x] Main-level bindability barrier precedes every executor seam.
- [x] Current blocked plan produces full nonexecution STRUCTURAL step receipts.
- [x] Full-length injected all-PASS executor is statically unreachable.
- [x] Injected child spy is statically unreachable.
- [x] Adversarial all-PASS and production-source barrier mutants are present.
- [x] No source path reviewed can certify the current canonical plan.
- [x] Verdict is explicitly limited to fail-closed landing safety.

### Required before certification

- [ ] Authoritative root derivation and verification of source commit, dirty state, and identity.
- [ ] Defined source-identity algorithm and immutable provenance receipt.
- [ ] Preflight and binding for every transitive served artifact used by all three child tools.
- [ ] Variant child canonical typed current-run result.
- [ ] Sandcastle child canonical typed current-run result.
- [ ] Capture child served-origin argument and canonical typed current-run result.
- [ ] Child freshness, source, served-subject, frame/readiness, and quiescence binding.
- [ ] Final parent trust boundary independently re-normalizes typed child results.
- [ ] Child timeout/device-loss/runtime classifications conform to ERROR.
- [ ] Missing prerequisite/provenance classifications conform to STRUCTURAL.
- [ ] Valid measured product misses remain FAIL.
- [ ] Baseline promotion carries externally attributable independent review.
- [ ] UUID run archive and authoritative RUNNING/latest lifecycle.
- [ ] Atomic final publication and crash recovery.
- [ ] Locks, ownership, retries, and foreign-successor preservation.
- [ ] Stale predecessor PASS cannot remain authoritative during RUNNING.
- [ ] Package runner and handoff supply the complete authoritative source tuple.
- [ ] Ledger describes the repaired contract rather than the predecessor.
- [ ] Authorized specs and mutants executed on the final tuple.
- [ ] Authorized build/server/browser/real-gate run produces complete retained evidence.
- [ ] New exact tuple is frozen and independently reviewed after any further change.

## Recommended adversarial mutants

- Offer a complete all-PASS `executePlan` plus a child spy; require STRUCTURAL and zero calls.
- Disable only the main-level barrier; require the mutant to reach the executor and demonstrate why the guard is load-bearing.
- Forge source, served subject, run identity, and typed PASS together while retaining stale report bytes.
- Rewrite an identical fixed report with only a fresh mtime.
- Alter both preflight hashes consistently while serving different child-consumed bytes.
- Make capture nominally bindable without adding a served-origin argument or typed result.
- Remove one variant bundle while preserving the two existing preflight records.
- Return an empty Sandcastle gallery census as green-looking metadata.
- Convert timeout or device loss from ERROR to FAIL.
- Return a genuine complete product miss and verify it remains FAIL rather than STRUCTURAL.
- Race two publishers for the same wave ID.
- Crash between JSON and Markdown publication.
- Leave a predecessor PASS visible while a replacement run is active.
- Attempt cleanup after a foreign successor has acquired authority.
- Preserve a green summary while mutating or deleting the underlying typed result.

## Files reviewed

Fully read:

- `.agents/skills/audit-cesium-certification/SKILL.md`
- `AGENTS.md`
- `Tools/wave-end-gate.mjs`
- `Tools/wave-end-gate.spec.mjs`
- Complete HEAD diff for `Tools/wave-end-gate.mjs`
- Complete HEAD diff for `Tools/wave-end-gate.spec.mjs`
- `Tools/visual-regression/lib/verdict-exit-gate.mjs`
- `Tools/visual-regression/scenes.json`

Relevant exact excerpts read:

- `migration_doc/EXECUTOR_LANE_CHARTER_2026-08-14.md`
- `migration_doc/MAINTAINER_RULINGS_2026-08-28.md`
- `migration_doc/FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md`
- `migration_doc/CODEX_HANDOFF_2026-08-29.md`
- `package.json`
- `Tools/visual-regression/capture-and-diff.mjs`
- `Tools/visual-regression/sandcastle-smoke.mjs`
- `Tools/variant-smoke-test.mjs`

## Read-only commands used

Command families used during the review and terminal freeze verification:

- `Get-Content -LiteralPath <path> -Raw`
- line-numbered `Get-Content` chunk loops
- `Get-FileHash -Algorithm SHA256 -LiteralPath <candidate paths>`
- `Get-Item -LiteralPath <candidate paths>`
- `rg -n -C <context> <patterns> <files>`
- `git -C <clone> rev-parse HEAD`
- `git -C <clone> rev-parse 'HEAD^{tree}'`
- `git -C <clone> status --short --untracked-files=all`
- `git -C <clone> diff --numstat -- Tools/wave-end-gate.mjs Tools/wave-end-gate.spec.mjs`
- chunked complete `git -C <clone> diff --no-ext-diff --unified=3 -- <candidate>`
- `git -C <clone> diff --check -- Tools/wave-end-gate.mjs Tools/wave-end-gate.spec.mjs`

The separate repair clone required escalated read-only shell access because it is outside the writable workspace boundary. That accommodation did not grant or perform mutation.

## Source, inference, and uncertainty statement

Confirmed facts in this report come from the exact frozen source tuple, its complete diff, terminal hashes/status, and the cited governing/transitive source lines.

The conclusion that the injected all-PASS executor is unreachable is a static inference from the main-level control-flow ordering at `Tools/wave-end-gate.mjs:1877-1889` and the immutable canonical plan. It was not dynamically executed in this review.

All runtime behavior is **NOT-RETESTED**. No claim is made that the specification suite passes, that a server can serve the required builds, that any child can currently produce a valid typed result, that browser/device cleanup works dynamically, or that a real gate receipt exists.

This review does not certify the repaired gate, a wave, any child tool, any served build, or any future/unfrozen patch.

## Explicit action statement

I made no edits and performed no Git writes, tests, builds, browser activity, server activity, real gate execution, child execution, network access, installation, evidence publication, push, branch or name change, or other external-state action.

At report delivery, this review lane is complete and has no running reviewer-owned command, browser, server, gate, child process, publication, or external action. This reviewer-lane quiescence does not establish descendant-process quiescence for any future gate execution; that remains untested and open.
