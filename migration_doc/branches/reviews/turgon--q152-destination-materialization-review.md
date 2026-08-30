# Turgon Q-152 Destination-Materialization Review

- Reviewer: Turgon
- Date: 2026-08-30
- Role: tier-2 independent read-only review lead
- Intended bank path: `migration_doc/branches/reviews/turgon--q152-destination-materialization-review.md`
- Verdict: **GO for fail-closed safety landing only — explicitly NOT certification**
- Runtime disposition: **NOT-RETESTED**

## Exact final destination boundary

Terminal rehash at `2026-08-30T00:31:18.0545306-04:00`:

- HEAD: `8406dc80f0875881977e0ec61a75a02e6442a55e`
- HEAD tree: `b88c04b7dc1af38a3934dbe446b277186cb8e9d7`

| Path | Lines | Bytes | SHA-256 | HEAD numstat |
| --- | ---: | ---: | --- | ---: |
| `Tools/wave-end-gate.mjs` | 1,936 | 54,670 | `F900CF8BE5B0242DED847D1FA6878E55D51E0EF263B03F707CED738C7C2C294B` | `1475/368` |
| `Tools/wave-end-gate.spec.mjs` | 1,245 | 38,149 | `3EA2BF304DBCF829C570C2B61140E494F7A3B842255C3D75B12367630D897A23` | `1154/77` |

Opening and terminal HEAD, tree, scoped statuses, sizes, hashes, and numstats matched. The two candidate paths remained exactly modified.

The main worktree is not isolated. Opening status had 71 entries and terminal status had 73: tracked modifications remained 11 while unrelated untracked paths increased from 60 to 62. That concurrent dirt was observed, left untouched, and excluded from this exact two-path verdict. Root must continue path-exact collision and staging discipline.

## Prior-review and materialization binding

This addendum incorporates the banked full Turgon review:

- Path: `migration_doc/branches/reviews/turgon--q152-fail-closed-review.md`
- Bytes: 16,196
- SHA-256: `2C39186678843A88CF16DDC08183603875CA99AAB5F4BCD1C03401485CF86B28`

That report reviewed the clone tuple:

- `Tools/wave-end-gate.mjs`: 54,992 bytes, `CDB2AFE98834A6D380156C8D2BD81A5755D49FD16CB86D9E7A8A90303591BFD0`
- `Tools/wave-end-gate.spec.mjs`: 38,090 bytes, `3F1A331378D83B5998C102154170E0CAC905D296054D9C6835B744DEA67BA8AA`

Root reported that it semantically applied that reviewed patch and first proved both Git-filtered working objects matched the clone. Mandatory Prettier then produced the LF destination and invalidated the clone’s raw-byte tuple. Complete clone-to-destination comparisons show wrapping, indentation, and line-ending normalization only, except for the final spec cleanup described next; no production identifier, literal, operator, branch, status mapping, plan entry, receipt field, assertion, or control-flow change was found.

The immediately preceding destination spec was 38,178 bytes at `DAB06346CB21EEE7D2FAA11E8D68F621787DEEB6A35604F8963AD13607C67B66`. The final spec removes exactly the unused 29-byte named-import line `  decidePreSpawnBindability,` plus LF. The complete final file and complete final HEAD diff were reread. No test body, helper, mutant, executable import, or production source changed. The 38,178-byte destination tuple and the clone tuple are therefore **SUPERSEDED** by the exact final tuple above.

## Validation chronology

Reported by root, not rerun by this reviewer, after the final import cleanup:

- Prettier: exit 0
- `git diff --check`: exit 0
- ESLint: exit 0
- syntax checks: 0/0
- focused specification: 29/29

These are narrow source/test validations. They are not a gate run, browser run, child run, served-subject measurement, evidence publication, receipt, or certification.

## Decisive B1 re-derivation

**B1 — injected all-PASS executor bypass: FIXED by static inspection; runtime NOT-RETESTED.**

- `capture-and-diff` is truthfully pre-spawn unbindable at `Tools/wave-end-gate.mjs:396-417`.
- The canonical plan and nested records are frozen at `Tools/wave-end-gate.mjs:419-429`.
- `main` validates any offered plan and rebuilds the canonical plan at `Tools/wave-end-gate.mjs:1844-1848`.
- Planned child paths are statted at `Tools/wave-end-gate.mjs:1850-1857`.
- Dry run returns STRUCTURAL before execution at `Tools/wave-end-gate.mjs:1859-1868`.
- The main-level bindability barrier returns STRUCTURAL at `Tools/wave-end-gate.mjs:1870-1874`.
- Only after that barrier can the injected or default executor be selected at `Tools/wave-end-gate.mjs:1876-1885`.
- The shared nonexecution builder emits every ordered planned step with `spawned:false` and STRUCTURAL at `Tools/wave-end-gate.mjs:1171-1213`.
- The final spec retains the full-length injected all-PASS executor plus child spy and requires zero executor/child calls at `Tools/wave-end-gate.spec.mjs:445-510`.
- Its production-source mutant removes the barrier, reaches all adapters, and would falsely PASS at `Tools/wave-end-gate.spec.mjs:1203-1245`, establishing that the control is load-bearing.

Static conclusion: the exact current canonical plan is unbindable, so the reviewed source cannot invoke either executor seam, spawn a child, or certify. Its truthful result is **STRUCTURAL / exit 3** with the full ordered zero-spawn nonexecution receipt. Removing an unused spec import does not alter that boundary.

## Finding disposition and carry-forward blockers

Fixed for this safety landing:

- Canonical `PASS` / `FAIL` / `ERROR` / `STRUCTURAL` topology and exits 0/1/2/3 are imported from `Tools/visual-regression/lib/verdict-exit-gate.mjs`.
- Empty folds are STRUCTURAL; exact ordered plan shape and child paths are validated; raw process evidence remains separate from normalized typed results.
- The two declared preflight artifacts have nested disk/served status, byte length, MD5, URL, ordering, and equality checks.
- Spawn, timeout, signal, null/unknown exit, cleanup, typed freshness/source/served-subject/exit/quiescence, and fixed-report freshness paths are fail-closed in source; runtime behavior remains NOT-RETESTED.
- The main-level barrier closes the injected-executor bypass and preserves ordered zero-spawn receipts.

All certification and operational blockers remain open:

1. **Caller-supplied provenance:** `--source-commit`, `--source-dirty`, and `--source-identity` are syntax-checked caller inputs, not independently derived against an authoritative root. The identity algorithm, subject boundary, and immutable provenance receipt remain undefined.
2. **Incomplete served subject:** preflight covers only two artifacts, not every transitive bundle, import, page, asset, or child-consumed response. The variant child consumes three additional bundles, and no same-run browser-response identity binds the whole plan.
3. **Variant child contract/status:** no canonical fresh typed current-run result binds root source, complete served subject, freshness, readiness, and descendant quiescence; an exception exits 99. Its adapter remains post-spawn unbindable.
4. **Sandcastle2 contract/status:** its fixed report lacks canonical status, run/source/served/freshness/quiescence fields; timeout and device loss enter ordinary FAIL; origin refusal returns 2 even though failure to establish the subject is STRUCTURAL. Its adapter remains post-spawn unbindable.
5. **Capture-and-diff contract/status:** `scenes.json` remains on forbidden port 8080 rather than 8094/8095; the child derives Git state internally; `tilesLoaded` timeout can continue; device loss becomes FAIL; NON_CERTIFYING exits 1 and exceptions 99; no parent-bound served-origin argument or canonical typed result exists. This remains the decisive pre-spawn blocker.
6. **Future final trust boundary:** `isExecutionResultContract` checks ordered shape only and does not re-normalize provenance, freshness, served subject, or quiescence after an injected executor returns. It is unreachable now but must be sealed before any plan becomes bindable.
7. **Quiescence:** direct-child close does not prove descendant process-tree quiescence.
8. **Baseline provenance:** `--reviewed-by wave-end-gate:<wave>` is synthetic, not an externally attributable independent baseline review.
9. **Publication lifecycle:** fixed `receipt.json` and `summary.md` are overwritten directly. UUID archive, authoritative RUNNING/latest state, atomic finalization, ownership locking, retry identity, crash recovery, predecessor preservation, and foreign-successor protection are absent.
10. **Runner/runbook/ledger:** the package runner does not derive or supply the source tuple; the handoff invocation omits all three mandatory provenance arguments; the ledger still describes the predecessor PASS/FAIL/REFUSED and 0/2/3 topology. The stale invocation now safely refuses but is not operational.
11. **No certification evidence:** no real gate, child, server, browser, Edge, capture, build, publication, or evidence run occurred; no canonical receipt was banked; Wave 1 is not closed. Any later bindability repair or runtime claim requires a newly frozen tuple and independent review.
12. **Accepted risk for this landing only:** the current plan deliberately remains unbindable and always STRUCTURAL. That is the safety property being landed, never a certification result.

## Acceptance matrix

| Claim | Result |
| --- | --- |
| Exact final destination tuple is frozen and fully reviewed | **YES** |
| Final lint-only import removal changes behavior or test coverage | **NO** |
| Canonical plan returns STRUCTURAL / 3 before either executor seam | **YES, static inspection; runtime NOT-RETESTED** |
| Full-length injected all-PASS executor and child spy remain inert | **YES, static inspection; root reports focused 29/29** |
| Landing this exact tuple improves fail-closed safety | **GO** |
| The gate or Wave 1 is certified | **NO** |
| A wave-end receipt or evidence run exists | **NO** |
| Any changed byte, path, HEAD, or numstat inherits this verdict | **NO — re-freeze and re-review required** |

## Evidence basis

Fully read in this review lane:

- `.agents/skills/audit-cesium-certification/SKILL.md`
- `Tools/wave-end-gate.mjs`
- `Tools/wave-end-gate.spec.mjs`
- complete HEAD diffs for both candidate files
- complete prior-clone-to-destination comparisons
- `Tools/visual-regression/lib/verdict-exit-gate.mjs`
- the banked Turgon and Nimrodel full reports and the Tuor handoff
- governing charter, current state, latest maintainer ruling, and relevant Q-152 ledger/runbook sections

Relevant current transitive source excerpts were reread from the variant, Sandcastle2, capture-and-diff, scenes, and package-runner files. Read-only command families were `Get-Content`, `Get-Item`, `Get-FileHash`, `rg`, `git rev-parse`, `git status`, `git diff --numstat`, complete chunked `git diff`, and complete `git diff --no-index`.

## Explicit action and quiescence statement

Turgon made no edits and created no report file. No Git write, test, formatter, ESLint, build, browser, server, real gate, real child, network, install, evidence publication, push, branch/name change, credential action, or other external-state action occurred in this review lane. The process sandbox helper failed during setup, so escalation was used only for read-only local inspection.

Turgon and Nimrodel are quiescent at delivery. No reviewer-owned command, browser, server, gate, child, publication, or external action remains. Reviewer quiescence does not prove descendant-process quiescence for a future gate run.
