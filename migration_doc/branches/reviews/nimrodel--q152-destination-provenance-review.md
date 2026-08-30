# Q-152 Destination Materialization Provenance Review

- Reviewer: Nimrodel
- Date: 2026-08-30
- Role: independent read-only provenance/security reviewer
- Scope: final destination materialization in `F:\Dev\GH\cesium-webgpu`
- Verdict: **GO for fail-closed safety landing only — explicitly NOT certification**
- Runtime status: **NOT-RETESTED**

## Exact terminal tuple

- HEAD: `8406dc80f0875881977e0ec61a75a02e6442a55e`
- HEAD tree: `b88c04b7dc1af38a3934dbe446b277186cb8e9d7`

| Path | Lines | Bytes | SHA-256 | HEAD numstat |
| --- | ---: | ---: | --- | ---: |
| `Tools/wave-end-gate.mjs` | 1,936 | 54,670 | `F900CF8BE5B0242DED847D1FA6878E55D51E0EF263B03F707CED738C7C2C294B` | `1475/368` |
| `Tools/wave-end-gate.spec.mjs` | 1,245 | 38,149 | `3EA2BF304DBCF829C570C2B61140E494F7A3B842255C3D75B12367630D897A23` | `1154/77` |

Opening and terminal hashes, sizes, HEAD, tree, candidate statuses, and numstats matched. Terminal `git diff --check` exited 0.

The worktree is not isolated: terminal status contained 73 entries—11 tracked modifications and 62 untracked paths. The two Q-152 files were modified as expected; unrelated dirty state was observed, left untouched, and excluded from this path-scoped verdict.

## Final lint-only delta

The immediately preceding reviewed destination tuple was:

- Gate: 54,670 bytes, `F900CF8BE5B0242DED847D1FA6878E55D51E0EF263B03F707CED738C7C2C294B`
- Spec: 38,178 bytes, `DAB06346CB21EEE7D2FAA11E8D68F621787DEEB6A35604F8963AD13607C67B66`

The gate is byte-identical.

The final spec contains zero occurrences of `decidePreSpawnBindability`. A read-only in-memory reconstruction inserted exactly:

`  decidePreSpawnBindability,`

plus its LF newline at byte offset 502, after the first 20 lines. That reconstruction produced exactly 38,178 bytes and SHA-256 `DAB06346CB21EEE7D2FAA11E8D68F621787DEEB6A35604F8963AD13607C67B66`.

This proves that the final 38,149-byte spec differs from the previously reviewed spec solely by removal of that 29-byte unused named-import line. No test body, assertion, helper, mutant, executable import, or production source changed. All substantive findings and the fail-closed verdict therefore remain unchanged.

## Prior-review binding

The prior full provenance/security review is:

`migration_doc/branches/reviews/nimrodel--q152-provenance-review.md`

- Bytes: 21,478
- SHA-256: `BC8C17489C523AB8C7FE4498AE12267E741ADED3D0AE6F09517BD3784496A18D`

It reviewed the earlier clone tuple:

- Gate: `CDB2AFE98834A6D380156C8D2BD81A5755D49FD16CB86D9E7A8A90303591BFD0`
- Spec: `3F1A331378D83B5998C102154170E0CAC905D296054D9C6835B744DEA67BA8AA`

The complete destination files, complete destination-to-HEAD diffs, and complete prior-clone-to-destination comparisons were reviewed in this same audit lane. Prior-to-destination changes were formatting, wrapping, indentation, line-ending normalization, and now removal of one unused spec import. No production identifier, literal, operator, branch, status mapping, plan entry, receipt field, assertion, or control-flow change was found.

The prior clone tuple and the stale 38,178-byte destination addendum are **SUPERSEDED** by the exact terminal tuple above.

## Validation chronology

Reported by the landing root, not rerun by this reviewer:

- syntax checks: `0/0`
- focused specification: `29/29`
- Prettier: exit `0`
- diff check: exit `0`
- ESLint: exit `0`

Independently confirmed here:

- 29 static top-level test declarations remain present;
- the removed import has zero occurrences;
- terminal candidate `git diff --check`: exit `0`;
- terminal hashes and sizes match the asserted final tuple;
- byte-level reconstruction exactly recovers the previously reviewed spec hash.

Syntax execution, specification execution, Prettier, and ESLint remain **NOT-RETESTED** by this reviewer.

## Decisive fail-closed boundary

**B1 — full-length injected all-PASS executor bypass: FIXED by static inspection; runtime NOT-RETESTED.**

- `capture-and-diff` remains truthfully pre-spawn unbindable at `Tools/wave-end-gate.mjs:396-417`.
- The canonical plan and nested records are frozen at `Tools/wave-end-gate.mjs:419-429`.
- `main` validates an offered plan and regenerates the canonical plan at `Tools/wave-end-gate.mjs:1844-1848`.
- Planned child paths are checked at `Tools/wave-end-gate.mjs:1850-1857`.
- Dry run returns STRUCTURAL before execution at `Tools/wave-end-gate.mjs:1859-1868`.
- The main-level bindability barrier executes at `Tools/wave-end-gate.mjs:1870-1874`.
- Only afterward can the injected or default executor be selected at `Tools/wave-end-gate.mjs:1876-1885`.
- Nonexecution receipts preserve every planned step as `spawned:false` and STRUCTURAL at `Tools/wave-end-gate.mjs:1171-1213`.
- The specification supplies a full-length all-PASS executor plus child spy and requires STRUCTURAL with zero calls at `Tools/wave-end-gate.spec.mjs:445-510`.
- The production-source mutant establishes that removing the barrier would reach every adapter and falsely PASS at `Tools/wave-end-gate.spec.mjs:1203-1245`.

Static inference: for the exact unmodified terminal tuple, no current `main` path can execute the injected executor, spawn a child, or publish PASS for the canonical plan. Runtime execution was forbidden and remains unproven.

## Finding disposition

### Fixed in the parent gate

- **FIXED:** canonical PASS/FAIL/ERROR/STRUCTURAL mapping is imported at `Tools/wave-end-gate.mjs:10-16`; the frozen meanings and exits are defined at `Tools/visual-regression/lib/verdict-exit-gate.mjs:12-34`.
- **FIXED:** an empty status fold is STRUCTURAL at `Tools/wave-end-gate.mjs:108-123`.
- **FIXED:** exact plan cardinality, ordering, contents, and planned child paths are checked at `Tools/wave-end-gate.mjs:655-750`.
- **FIXED for the two declared artifacts:** nested served/disk status, size, MD5, URL, ordering, and equality are checked at `Tools/wave-end-gate.mjs:504-652`.
- **FIXED:** receipts retain both raw process evidence and normalized/typed child results at `Tools/wave-end-gate.mjs:432-501`.
- **FIXED in source; NOT-RETESTED:** spawn, timeout, signal, null exit, unknown exit, and cleanup failures normalize to ERROR at `Tools/wave-end-gate.mjs:752-920`.
- **FIXED in source; NOT-RETESTED:** typed result schema, freshness, source, served subject, exit agreement, and quiescence are checked at `Tools/wave-end-gate.mjs:935-1052`.
- **FIXED in source; NOT-RETESTED:** fixed-report time-window and predecessor-byte freshness checks occur at `Tools/wave-end-gate.mjs:1054-1156`.
- **FIXED:** dry run and the current unbindable canonical plan return STRUCTURAL without spawning.
- **FIXED:** the main-level injected-executor bypass is closed.

### Open direct certification blockers

- **OPEN — provenance:** `--source-commit`, `--source-dirty`, and `--source-identity` are caller-supplied and syntax-checked at `Tools/wave-end-gate.mjs:302-321`, then copied into the receipt at `Tools/wave-end-gate.mjs:1158-1169`. The gate does not independently derive them, verify them against an authoritative root, or define the source-identity algorithm.
- **OPEN — whole-plan served-subject binding:** preflight covers only two declared artifacts at `Tools/wave-end-gate.mjs:504-516`, not every transitive bundle, import, page, asset, or child-consumed served dependency.
- **OPEN — future final child trust boundary:** `isExecutionResultContract` performs an ordered but shallow final shape check at `Tools/wave-end-gate.mjs:1588-1670`; it does not independently rerun typed provenance/freshness normalization after an injected executor returns. This is unreachable under the current barrier but must be sealed before any plan becomes bindable.
- **OPEN — publication lifecycle:** fixed `receipt.json` and `summary.md` destinations are directly overwritten at `Tools/wave-end-gate.mjs:1425-1447`. There is no UUID archive, authoritative RUNNING state, atomic final publication, ownership lock, retry identity, predecessor preservation, foreign-successor protection, or crash recovery.
- **OPEN — baseline-review provenance:** baseline promotion supplies synthetic `--reviewed-by wave-end-gate:<wave>` at `Tools/wave-end-gate.mjs:396-410`, rather than externally attributable independent review.
- **ACCEPTED-RISK for this landing only:** the canonical plan is deliberately unbindable and therefore always STRUCTURAL. It cannot close or certify a wave.

### Open transitive child and served-subject blockers

**Variant smoke test — OPEN**

- It consumes three bundles not represented by the gate’s two-artifact preflight: `Build/Cesium/Cesium.js`, `Build/CesiumWebGL/Cesium.js`, and `Build/CesiumWebGPU/Cesium.js` at `Tools/variant-smoke-test.mjs:52-69`.
- It has no canonical current-run typed result carrying root source, complete served-subject identity, freshness, and descendant-quiescence proof.
- Product summary exits 0/1, setup failures exit 2, and an uncaught exception exits 99 at `Tools/variant-smoke-test.mjs:643-695`.
- The parent truthfully marks the adapter post-spawn unbindable at `Tools/wave-end-gate.mjs:356-373`.

**Sandcastle2 sweep — OPEN**

- Its fixed report contains renderer, totals, passed, failures, and timeouts, but no canonical status, run identity, root source tuple, served-subject identity, freshness binding, or quiescence proof at `Tools/visual-regression/sandcastle-smoke.mjs:702-726`.
- Timeout and device loss enter the ordinary failure path, although harness timeout and device loss require ERROR.
- Origin refusal returns 2 at `Tools/visual-regression/sandcastle-smoke.mjs:660-676`, although inability to establish the required subject is STRUCTURAL.
- The parent truthfully marks the adapter post-spawn unbindable at `Tools/wave-end-gate.mjs:375-394`.

**Capture-and-diff — OPEN, decisive pre-spawn transitive blocker**

- The configured page remains fixed to port 8080 at `Tools/visual-regression/scenes.json:4`, while the parent’s served-subject plan uses the guarded 8094/8095 topology.
- The child independently calls Git for commit and dirty state at `Tools/visual-regression/capture-and-diff.mjs:145-160`, instead of consuming and verifying the authoritative root tuple.
- A `tilesLoaded` timeout can continue to capture at `Tools/visual-regression/capture-and-diff.mjs:596-616`.
- Device loss is folded into FAIL at `Tools/visual-regression/capture-and-diff.mjs:1009-1031`.
- NON_CERTIFYING exits 1 and exceptions exit 99 at `Tools/visual-regression/capture-and-diff.mjs:1084-1131`.
- It has no parent-bound served-origin argument or canonical typed current-run result.
- The parent correctly blocks the entire plan before spawn at `Tools/wave-end-gate.mjs:396-417`.

## Required status boundary

- **STRUCTURAL / 3:** missing, stale, malformed, or unverifiable provenance; absent/malformed typed contract; missing prerequisite or subject; served-subject mismatch; missing readiness witness; unproven required quiescence; or any unbindable canonical plan.
- **ERROR / 2:** import, spawn, browser, adapter, device-loss, timeout, cleanup, result-read, or unexpected runtime failure, including malformed values returned through a trusted runtime dependency seam.
- **FAIL / 1:** only a complete, valid, provenance-bound product measurement whose registered expectation misses.
- **PASS / 0:** only after every exact planned step supplies a fresh typed result bound to the same authoritative source and complete served subject, every predicate passes, cleanup/quiescence is proven, and nothing is unscored, structural, or erroneous.

The frozen status table is at `Tools/visual-regression/lib/verdict-exit-gate.mjs:12-34`.

## Runner, handoff, ruling, and ledger blockers

- **OPEN — package runner:** `package.json:199` invokes only `node Tools/wave-end-gate.mjs`; it does not derive or supply the authoritative source tuple.
- **OPEN / SUPERSEDED command contract:** `migration_doc/CODEX_HANDOFF_2026-08-29.md:101` still instructs `npm run wave-end-gate -- --wave wave1`. The repaired CLI requires all three source arguments, so this stale command safely returns STRUCTURAL but is not operational.
- **OPEN — stale ledger:** `migration_doc/FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md:194-198` describes the predecessor’s PASS/FAIL/REFUSED vocabulary, exits 0/2/3, shallow served MD5s, and child exit summaries. It is not evidence for this repaired tuple.
- **OPEN — no closing receipt:** `R-2026-08-29-2` requires canonical gate output to be banked and cited before wave closure at `migration_doc/MAINTAINER_RULINGS_2026-08-28.md:261-265`. This repair safely refuses and has produced no such receipt.

## Acceptance checklist

Satisfied for the narrow landing:

- [x] Exact final tuple frozen by HEAD, tree, path, size, SHA-256, and numstat.
- [x] Opening and terminal tuple match.
- [x] Complete destination files and complete HEAD diffs reviewed in this lane.
- [x] Final lint delta reconstructed byte-for-byte against the prior reviewed spec.
- [x] Canonical status vocabulary and exit mapping retained.
- [x] Exact immutable plan and child paths validated before execution.
- [x] Capture-and-diff remains truthfully pre-spawn unbindable.
- [x] Main-level barrier precedes all injected/default executor seams.
- [x] Full-length injected all-PASS executor and child spy remain zero-call STRUCTURAL controls.
- [x] Raw and typed child evidence remain distinct in receipts.
- [x] No reviewed source path can certify the current canonical plan.
- [x] Verdict is limited to fail-closed safety landing.

Still required before certification:

- [ ] Authoritative root derivation and verification of commit, dirty state, and source identity.
- [ ] Defined source-identity algorithm and immutable provenance receipt.
- [ ] Whole-plan preflight for every transitive served dependency.
- [ ] Canonical typed current-run results from all three child tools.
- [ ] Child freshness, source, served subject, readiness, and descendant-quiescence binding.
- [ ] Final parent-side re-normalization of returned typed results.
- [ ] Correct STRUCTURAL/ERROR/FAIL classifications inside child adapters.
- [ ] Externally attributable independent baseline review.
- [ ] UUID archive, RUNNING/latest lifecycle, atomic publication, locking, recovery, and successor protection.
- [ ] Operational package runner and handoff with authoritative provenance arguments.
- [ ] Corrected ledger and a retained banked wave-end receipt.
- [ ] Authorized runtime specifications, mutants, servers, browsers, children, and real gate execution on a newly frozen tuple.
- [ ] Independent review of any later or unfrozen patch.

## Evidence basis, commands, and uncertainty

Fully read in this review lane:

- `.agents/skills/audit-cesium-certification/SKILL.md`
- `Tools/wave-end-gate.mjs`
- `Tools/wave-end-gate.spec.mjs`
- complete HEAD diffs for both candidate files
- complete prior-clone-to-destination comparisons
- the banked Nimrodel provenance review identified above
- `Tools/visual-regression/lib/verdict-exit-gate.mjs`

Relevant current excerpts reread:

- `Tools/variant-smoke-test.mjs`
- `Tools/visual-regression/sandcastle-smoke.mjs`
- `Tools/visual-regression/capture-and-diff.mjs`
- `Tools/visual-regression/scenes.json`
- `package.json`
- `migration_doc/CODEX_HANDOFF_2026-08-29.md`
- `migration_doc/FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md`
- `migration_doc/MAINTAINER_RULINGS_2026-08-28.md`

Read-only command families used:

- `Get-Content -LiteralPath`
- `Get-Item -LiteralPath`
- `Get-FileHash -Algorithm SHA256`
- `Select-String`
- `rg`
- `git rev-parse HEAD`
- `git rev-parse HEAD^{tree}`
- `git status --short --untracked-files=all`
- `git diff --numstat`
- chunked complete `git diff`
- complete `git diff --no-index`
- `git diff --check`
- read-only in-memory UTF-8 byte reconstruction and SHA-256 calculation

Confirmed source facts are those directly read from the exact terminal tuple and cited files. The zero-spawn/noncertification conclusion is a static control-flow inference from the immutable unbindable plan and barrier ordering. Runtime behavior, child cleanup, browser/device behavior, publication races, and actual receipt creation remain **NOT-RETESTED**.

## Explicit action and quiescence statement

I made no edits and performed no Git writes, tests, formatters, ESLint, builds, browser activity, server activity, real gate execution, child execution, network access, installation, evidence publication, push, branch or name change, or other external-state action.

At delivery, this reviewer lane has no running reviewer-owned command, browser, server, gate, child, publication, or external action. Reviewer quiescence does not prove descendant-process quiescence for any future gate run.
