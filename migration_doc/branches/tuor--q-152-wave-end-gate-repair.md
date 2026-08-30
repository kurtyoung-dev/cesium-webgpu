# Tuor — Q-152 wave-end gate repair lease

- Status: **LOCAL FAIL-CLOSED SAFETY LANDED (Batch 1332) / NOT CERTIFIED / Q-152 OPEN / POSTCOMMIT PROCESS VIOLATION RECORDED**
- Lane identity: Tuor — unchanged for dispatch, review, landing, and retirement.
- Tier-2 owner: Beren
- Final writer: Celebrimbor
- Prior writer: Tuor — `PARTIAL`, no authored bytes.
- Clone base and HEAD: `a64954b94507fa29762964f3d410517ddd765e9e`
- Clone base tree: `3247f590e9613b34320e6a9abbb676a132d00cd4`
- Clone branch: `sol/q-152-wave-end-gate-repair-ba64954b945-2026-08-29`
- Clone: `F:/Dev/GH/cesium-lane-tuor-q152-20260829`
- Final destination: shared main checkout `F:/Dev/GH/cesium-webgpu`
- Destination review snapshot: HEAD `8406dc80f0875881977e0ec61a75a02e6442a55e`, tree `b88c04b7dc1af38a3934dbe446b277186cb8e9d7`.
- Landing commit and stamp: Batch 1332, `fff7e02072adf95f88e23a43bec113f214e3e05b`; detailed stamp below.
- Landing authority: root orchestrator only, limited to the exact reviewed fail-closed safety destination.
- Push authority: **none**.
- Reap when: a later tracked disposition explicitly authorizes retirement and root verifies lane and review quiescence; target 2026-09-05.
- Disk budget: 2 GiB.

The destination-review HEAD and tree identify the pre-landing inspection boundary. They are not the landing commit; the exact local safety landing is recorded below.

## Declared path set

- `Tools/wave-end-gate.mjs`
- `Tools/wave-end-gate.spec.mjs`

The declared set was clean in the main checkout at dispatch and did not overlap another open lease. Celebrimbor was the sole implementation writer after the incremental resume and wrote only these paths in the isolated clone. Root alone materialized the reviewed change into main. Workers never owned Git, commit, landing, push, build, browser, server, evidence, installation, or external-state authority.

## Exact landed main safety destination

This is the exact locally landed fail-closed safety source tuple:

| Path | Lines | Bytes | SHA-256 | Destination-review HEAD numstat |
| --- | ---: | ---: | --- | ---: |
| `Tools/wave-end-gate.mjs` | 1,936 | 54,670 | `F900CF8BE5B0242DED847D1FA6878E55D51E0EF263B03F707CED738C7C2C294B` | `1475/368` |
| `Tools/wave-end-gate.spec.mjs` | 1,245 | 38,149 | `3EA2BF304DBCF829C570C2B61140E494F7A3B842255C3D75B12367630D897A23` | `1154/77` |

The destination addenda recorded matching opening and terminal hashes, sizes, HEAD, tree, candidate statuses, and numstats. Terminal `git diff --check` exited 0. The shared worktree was not isolated: terminal status contained 73 entries, comprising 11 tracked modifications and 62 untracked paths. Reviewers left that concurrent dirt untouched and excluded it from this exact two-path verdict. Root must retain path-exact collision and staging discipline.

## Clone-to-destination materialization chronology

The banked full reviews originally bound the following clone working-copy tuple:

| Clone path | Bytes | SHA-256 | Clone diff numstat |
| --- | ---: | --- | --- |
| `Tools/wave-end-gate.mjs` | 54,992 | `CDB2AFE98834A6D380156C8D2BD81A5755D49FD16CB86D9E7A8A90303591BFD0` | `1468/354` |
| `Tools/wave-end-gate.spec.mjs` | 38,090 | `3F1A331378D83B5998C102154170E0CAC905D296054D9C6835B744DEA67BA8AA` | `1126/74` |

That clone tuple is preserved as reviewed chronology but is **SUPERSEDED as a raw destination materialization**.

Root semantically applied the reviewed clone patch to the main destination and proved both Git-filtered working objects matched the reviewed clone objects. Mandatory Prettier then produced the LF destination form, invalidating the clone raw-byte hashes without changing the reviewed production behavior. The immediately preceding formatted destination was:

- gate: 54,670 bytes, `F900CF8BE5B0242DED847D1FA6878E55D51E0EF263B03F707CED738C7C2C294B`;
- spec: 38,178 bytes, `DAB06346CB21EEE7D2FAA11E8D68F621787DEEB6A35604F8963AD13607C67B66`.

ESLint then identified exactly one unused spec import. Root removed the 29-byte LF line `  decidePreSpawnBindability,`. A byte-level reconstruction in the destination provenance review reinserted that exact line at byte offset 502 and recovered the 38,178-byte intermediate spec hash exactly. No test body, assertion, helper, mutant, executable import, production identifier, literal, operator, branch, status mapping, plan entry, receipt field, or control flow changed. The intermediate LF tuple and clone raw tuple are both superseded by the exact final main tuple above.

## Final destination validation

Root reported the following validation after the final unused-import cleanup:

| Check | Exit / result |
| --- | --- |
| Mandatory Prettier | 0 |
| Destination diff check | 0 |
| ESLint | 0 |
| `node --check Tools/wave-end-gate.mjs` | 0 |
| `node --check Tools/wave-end-gate.spec.mjs` | 0 |
| `node --test Tools/wave-end-gate.spec.mjs` | 0; 29/29 passed |

These are narrow formatting, static, syntax, and behavioral-spec validations. The destination reviewers verified their retained source facts and hashes but did not rerun Prettier, ESLint, syntax, or the focused suite. No real wave-end gate, child, build, server, browser, Edge, network, capture, publication, or evidence run occurred.

## Review chain and verdict boundary

### Banked full clone reviews

| Review | Bytes | SHA-256 | Verdict |
| --- | ---: | --- | --- |
| `migration_doc/branches/reviews/turgon--q152-fail-closed-review.md` | 16,196 | `2C39186678843A88CF16DDC08183603875CA99AAB5F4BCD1C03401485CF86B28` | GO for fail-closed safety landing only; not certification |
| `migration_doc/branches/reviews/nimrodel--q152-provenance-review.md` | 21,478 | `BC8C17489C523AB8C7FE4498AE12267E741ADED3D0AE6F09517BD3784496A18D` | GO for fail-closed safety landing only; not certification |

### Banked final destination addenda

| Addendum | Bytes | SHA-256 | Verdict |
| --- | ---: | --- | --- |
| `migration_doc/branches/reviews/turgon--q152-destination-materialization-review.md` | 11,129 | `1AE59D6FC5A1FAE2ED40CE8D33B3948E84C880A15F5DA346C4AD8025320A78E8` | GO for exact final destination, fail-closed safety landing only; not certification |
| `migration_doc/branches/reviews/nimrodel--q152-destination-provenance-review.md` | 16,707 | `714BBE54E53917DF4F5FF1267BF2208FFF598AFFAD2BF45A42A06FEB93394345` | GO for exact final destination, fail-closed safety landing only; not certification |

The base reports establish the complete source/diff review of the clone tuple. The destination addenda bind that reasoning through the filtered-object proof, mandatory formatting, exact lint-only import removal, complete destination files, complete destination diffs, and terminal destination hashes. Together they establish only that the exact final main tuple safely prevents the currently unbindable canonical plan from spawning children or publishing PASS, including through the formerly exploitable injected-executor seam.

The verdict does **not** certify Q-152, a child adapter, a served build, a browser, Edge, a wave, a receipt lifecycle, or any future, changed, committed, or pushed tuple.

## Current fail-closed behavior

- The gate imports canonical PASS 0 / FAIL 1 / ERROR 2 / STRUCTURAL 3 and folds `STRUCTURAL > ERROR > FAIL > PASS`.
- Empty and dry-run execution cannot PASS.
- Root-supplied source commit, dirty state, and 64-hex identity are mandatory; missing or malformed values fail closed.
- Ports 8080 and 8081 are forbidden, and the main and bucket ports must differ.
- The canonical plan uses the real variant and Sandcastle2 runners, exact renderer flags, unique repeated steps, and `PROBE_BASE` / `PROBE_SANDCASTLE_BASE`.
- Offered plans are validated, discarded, and rebuilt as a frozen canonical plan. All unique planned child paths are statted before execution.
- `capture-and-diff` remains unbindable in the pre-spawn phase. `main` applies that barrier after canonical validation and stat and before every default or injected executor seam.
- The complete canonical plan is recorded as ordered STRUCTURAL nonexecution receipts with `spawned:false`; the current plan performs **zero child spawns**.
- A complete apparently valid injected all-PASS executor and child spy remain inert. The negative control requires STRUCTURAL, zero executor calls, and zero child calls.
- Raw exits alone do not create a verdict. The dormant adapter path requires a fresh typed current-run result bound to source, served subject, chronology, and claimed descendant quiescence; runtime failures normalize to ERROR.

The required current outcome is **STRUCTURAL / exit 3 with zero spawns**. PASS from this tuple would be a defect, not a wave-closing result.

## Chronology and authority record

1. Tuor received the original two-file lease. A single full-file patch transport failed before process creation with Windows error 206. Tuor authored no retained bytes and ran no validation.
2. The unchanged clone at that handoff contained the predecessor files: gate 21,021 bytes / `F00844A01862B191875FAE0BCF7C838488B310597A4AD99FA9CF96138C8C41BC`; spec 5,213 bytes / `47FC378BB6C8CBD6A7D77E065DDF3AA5669F98670645AEB66744A4A4CE6AB8D0`.
3. Beren resumed the same lane with Celebrimbor as sole writer. Root explicitly authorized bounded direct patch-engine invocations because the ordinary writer sandbox could not reach the isolated clone. Personnel and transport changed; lane identity, lease, base, branch, and Git authority did not.
4. Initial root-authorized validation produced syntax exits 0/0 but focused tests at exit 1 with 23 passed and 3 failed. That tuple received NO-GO and was superseded; the red result remains disclosed.
5. After those defects and the strict injected-result finding were repaired, a later tuple passed syntax 0/0 and focused tests 28/28.
6. Turgon and Nimrodel then found that `main` could accept an injected all-PASS executor before the default executor's pre-spawn barrier. Their verdict on that tuple was NO-GO.
7. Celebrimbor reopened only for that finding. The barrier moved to `main` before every executor seam, full ordered nonexecution receipts became shared behavior, and the all-PASS injection/child-spy negative control was added.
8. The final clone tuple passed root-authorized syntax checks and 29/29 focused tests. Turgon and Nimrodel independently reviewed it and returned GO limited to fail-closed safety landing.
9. Root alone performed semantic destination materialization and proved filtered-object identity to the clone review subject.
10. Mandatory Prettier produced the LF intermediate destination. ESLint then required removal of exactly the unused `decidePreSpawnBindability` spec import.
11. Root validated the final destination with Prettier, diff check, ESLint, syntax 0/0, and 29/29 focused tests.
12. Turgon and Nimrodel independently reviewed the final main materialization and exact lint-only delta and banked the destination addenda above.
13. No worker acquired Git, commit, push, certification, browser, build, evidence, ledger, runbook, or retirement authority. Root later assigned the Batch 1332 commit and stamp recorded below after the exact reviewed packet landed; that assignment conferred no worker authority.

## Open certification and operational blockers

All blockers below remain open. The destination safety GO neither resolves nor waives them.

### Source provenance

- Source commit, dirty state, and identity are caller-supplied and syntax-checked, not independently derived or verified.
- The source-identity algorithm, exact subject boundary, immutable root provenance receipt, and authoritative derivation procedure remain undefined.
- The package runner does not derive or supply the mandatory source tuple.

### Served subject

- Preflight covers only `Build/CesiumUnminified/Cesium.js` and `packages/engine/Build/Unminified/index.js`.
- It does not cover all transitive bundles, assets, pages, or browser-consumed responses used by the three children.
- Variant smoke consumes three variant bundles not bound by the two-artifact parent preflight.
- No same-run browser-response identity proves that a child consumed the bytes preflighted by the parent.

### Child result contracts and status topology

- Variant smoke emits no canonical typed current-run result bound to root source, served subject, freshness, and descendant quiescence; an exception exits 99.
- Sandcastle's report lacks canonical status, run ID, root source, served subject, freshness, and quiescence proof. Timeout and device loss enter ordinary FAIL, while origin refusal uses exit 2 rather than STRUCTURAL.
- Capture-and-diff has no parent-bound served-origin CLI contract or canonical typed current-run receipt. It derives Git metadata internally, uses noncanonical exits, can fold device loss into FAIL, and can continue after a `tilesLoaded` timeout.
- Parent-side `isExecutionResultContract` checks ordered shape but does not independently rerun typed provenance, freshness, served-subject, and quiescence normalization. The current barrier makes it unreachable; it must be sealed or re-normalized before any plan becomes bindable.
- Direct-child close does not establish descendant process-tree quiescence.

### Capture and baseline review

- `Tools/visual-regression/scenes.json` targets hardcoded port 8080 while the parent forbids 8080 and preflights 8094/8095.
- Capture remains the decisive pre-spawn blocker for the whole plan.
- Baseline promotion supplies synthetic `--reviewed-by wave-end-gate:<wave>` self-attestation instead of independently attributable approval.

### Publication lifecycle

- Receipt publication directly overwrites fixed `receipt.json` and `summary.md` paths.
- There is no immutable run UUID/archive, authoritative RUNNING/latest state, atomic finalization, ownership lock, retry/crash recovery, predecessor preservation, foreign-successor protection, or first-red preservation contract.

### Runbook, ruling, and ledger

- `package.json` invokes only `node Tools/wave-end-gate.mjs`; it does not derive or supply the authoritative source tuple.
- `migration_doc/CODEX_HANDOFF_2026-08-29.md` now marks the predecessor `npm run wave-end-gate -- --wave wave1` invocation blocked because it omits all three mandatory source arguments. It fails closed as STRUCTURAL and is not an operational certification invocation.
- `migration_doc/FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md` preserves the predecessor PASS/FAIL/REFUSED and 0/2/3 entry as history and records Batch 1332 only as a partial fail-closed safety landing.
- `R-2026-08-29-2` still requires a banked canonical wave-end receipt before wave closure. This repair safely refuses and has produced no such receipt.
- Runner and operational runbook repairs require separate orchestrator authority.

### Missing runtime and evidence scope

- No real gate or child was run on the final destination.
- No build, server, browser, Edge, network, capture, artifact publication, or wave-end evidence was produced.
- No served subject, device lifecycle, browser cleanup, descendant quiescence, canonical receipt, or wave closure was observed.

## Local fail-closed safety landing stamp

- Local batch and commit: Batch 1332; `fff7e02072adf95f88e23a43bec113f214e3e05b`.
- Main destination tuple: `Tools/wave-end-gate.mjs` — 54,670 bytes / `F900CF8BE5B0242DED847D1FA6878E55D51E0EF263B03F707CED738C7C2C294B`; `Tools/wave-end-gate.spec.mjs` — 38,149 bytes / `3EA2BF304DBCF829C570C2B61140E494F7A3B842255C3D75B12367630D897A23`.
- Assembly: root collision-audited current main, reconciled the line-ending/materialization difference, applied the reviewed semantic patch through root-owned Git discipline, removed one exact unused spec import after ESLint, and rehashed the final destination. No raw-file-copy authority is implied.
- Precommit validation and review: Prettier, diff check, ESLint, and syntax checks exited 0; the focused specification passed 29/29; Turgon and Nimrodel returned GO only for the exact fail-closed safety tuple; Elrond and Imrahil returned GO for the exact seven-path source/review landing packet. All committed source and review hashes survived the hook.
- Postcommit validation: `node Tools/verify-tracked-references.mjs --rev HEAD` passed with zero violations or advisories. The index was empty, pre-existing user work was restored, and the two pre-existing safety stashes remained unchanged.
- Scope: fail-closed safety only. Required behavior remains STRUCTURAL / exit 3 / zero child spawns. No real gate or child ran, no wave-end evidence was produced, and no receipt exists. Every certification and operational blocker listed above remains open.
- Authority: no certification, Wave 1 closure, push, reset, retirement, deletion, reap, clone reuse, evidence publication, browser/server/network, or external authority.

### Postcommit process finding

`npm run verify-landing -- --last 1` exited 1 because Batch 1332 omitted the standing `Co-Authored-By: Name <email>` trailer. That was the sole reported commit-rule violation; the marker guard was clean. Per R-2026-08-14-4, the landed commit is not amended, rebased, reset, or otherwise rewritten. The verifier is not weakened or allowlisted, the red remains visible for every range containing Batch 1332, and the next commit restores the established `Co-Authored-By: OpenAI Codex <noreply@openai.com>` process. This attribution failure neither changes the landed bytes nor reinterprets the independent safety verdict.

## Landed safety boundary and resume protocol

The exact final main tuple is landed only as a **fail-closed safety repair**. It must not be described as Q-152 completion, wave certification, an operational runbook, or an evidence receipt. Any future source byte, path, behavior, provenance contract, or executable plan change requires a new freeze and independent review.

Certification must resume through separately authorized child, provenance, served-subject, lifecycle, runbook, ledger, build, browser, and evidence lanes, followed by a new freeze and independent certification review. The local clone and branch remain protected until tracked disposition explicitly authorizes retirement and root confirms quiescence. Push remains unauthorized unless the maintainer separately grants it.

## Quiescence and negative-action declaration

Celebrimbor, Idril, Turgon, and Nimrodel completed their Q-152 work and reported no running reviewer-owned or worker-owned command, browser, server, gate, child process, publication, or external action. Reviewer and lane quiescence is not descendant-process proof for a future gate execution; that remains open.

Workers performed no Git writes, commits, pushes, dependency installation, builds, browser or Edge activity, server activity, real gate or child execution, network access, evidence publication, ledger mutation, current CODEX handoff mutation, branch/name change, or clone retirement. Root-owned semantic materialization, mandatory formatting/lint cleanup, and validation are recorded above and did not confer worker authority.
