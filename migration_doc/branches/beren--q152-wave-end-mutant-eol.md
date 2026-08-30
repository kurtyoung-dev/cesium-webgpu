# Beren — Q-152 wave-end mutant EOL harness repair

- Status: **FROZEN / INDEPENDENT TESTER GO / READY FOR ROOT DESTINATION REVIEW / NOT LANDED**
- Scope: runner-harness repair only; not Q-152 certification, H1/H0 acceptance, or product evidence.
- Lead: Beren
- Sole code writer: Celebrimbor
- Independent reproducer/tester: Idril
- Clone: `F:/Dev/GH/cesium-lane-beren-q152-mutant-eol-20260830`
- Branch: `sol/q152-wave-end-mutant-eol-806fc36ca4-2026-08-30`
- Base and clone HEAD: `806fc36ca4486f41046baf1175153910707ce6b6`
- Code lease: `Tools/wave-end-gate.spec.mjs` only
- Lead handoff lease: `migration_doc/branches/beren--q152-wave-end-mutant-eol.md` only, after source freeze
- Landing and every Git write: root only
- Push authority: **none**

## Provisioned boundary

The provisioner reported READY before dispatch. Opening branch and HEAD matched the values above. Opening status contained exactly the expected provisioner-owned modifications:

- `migration_doc/MAINTAINER_RULINGS_2026-08-17.md`
- `migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`

Those two paths are foreign provisioning material. No worker authored, staged, restored, reformatted, cleaned, or otherwise changed them. Root must exclude them from any Q-152 staging unless a separate authority explicitly owns them.

Opening relevant tuple:

| Path | Bytes | SHA-256 |
| --- | ---: | --- |
| `Tools/wave-end-gate.mjs` | 56,606 | `51F84DC8BA039714BCE980C8736BCC5286DE9C2DB7080822D6F6EC122F7F7E1A` |
| `Tools/wave-end-gate.spec.mjs` | 39,394 | `786804650822D73ED4AAFB60BA1B0936260C91C38A409322C0CDC7C810D43CB8` |

`Tools/wave-end-gate.mjs` remained outside the lease and unchanged throughout this lane.

## Preregistered defect reproduction

Before any edit, Idril ran exactly:

```text
node --test Tools/wave-end-gate.spec.mjs
```

Result: exit 1; TAP 29 total, 25 passed, 4 failed, zero cancelled/skipped/todo; duration 429.173 ms.

All four failures began in tests declared near spec lines 1085, 1132, 1149, and 1203 and converged on the shared `importBarrierMutant()` assertion at spec line 203:

```text
pre-spawn barrier mutation must apply
```

The raw TAP expanded to 15,732 lines / 127,042 tokens because Node repeated the full production source as the failed assertion payload four times; the tool display truncated that repeated payload. The retained primitive is unambiguous: the LF-only multiline literal did not occur in the provisioned CRLF source, so the production-source mutant never applied.

Observed production EOL boundary before repair: 1,936 CRLF sequences, zero bare LF. The semantic predicate `step?.bindability?.phase === "pre-spawn"` occurred exactly once.

## Implemented repair

Only `importBarrierMutant()` changed. The logical diff is:

```diff
-    const barrier =
-      'step?.bindability?.phase === "pre-spawn" &&\n      step.bindability.bindable !== true,';
-    let mutant = sourceText.replace(barrier, `false &&\n      ${barrier}`);
-    assert.notEqual(
-      mutant,
-      sourceText,
-      "pre-spawn barrier mutation must apply",
-    );
+    const barrier = 'step?.bindability?.phase === "pre-spawn"';
+    assert.equal(
+      sourceText.split(barrier).length - 1,
+      1,
+      "shared pre-spawn predicate mutation must have exactly one target",
+    );
+    let mutant = sourceText.replace(barrier, "false");
```

The repair is newline-independent, counts the mutation target before replacement, and refuses unless exactly one semantic predicate exists. Replacing that unique condition with `false` makes the real shared pre-spawn predicate inert for both the main and default-executor paths. The existing executed production-source mutant still has to reach the adapters and PASS, while the unmodified gate remains STRUCTURAL with zero adapter calls. No test was removed, weakened, skipped, or replaced with a source-only assertion.

Logical HEAD numstat for the final spec is `6/7`. The production gate, H1/H0 subjects, package runner, and every other test or source file are unchanged.

## Retained repair chronology

Trustworthy reds remain part of this handoff:

1. **Prerequisite red:** opening tuple, direct spec exit 1, 25/29, four failures at the shared non-applying mutant assertion.
2. **First repair NO-GO:** spec 39,364 bytes / `6C3D7C18D3C723E6A99ABA20B936C6647C73356E51A9BDCEFDF634D47439BDE5`. Syntax 0; direct spec exit 1, 28/29. The sole failure expected PASS 0 but observed STRUCTURAL 3 because mutating only `main` left the default executor's shared barrier active. ESLint 0, C16 0, diff check 0, Prettier 1, survivor census zero.
3. **Shared-predicate semantic repair:** the target moved to the unique shared predicate so the actual main/default barrier behavior was bypassed without newline dependence.
4. **Formatting red retained:** the behavior-green tuple at 39,356 bytes / `A857D55D5B0AD68709EAAFEDF2FD6FCEF4364A7BB9D606D813A567F9CF907432` passed syntax and 29/29 but Prettier remained exit 1 because the incremental patch lines had mixed EOL materialization.
5. **Exact-path formatting:** the existing local Prettier wrote only the leased spec, exit 0, output `Tools/wave-end-gate.spec.mjs 311ms`. In-memory pre/post line-content comparison reported `logical_changed_lines=0`; only patch-line EOL materialization changed.

No product red occurred: the only executed subject was the harness specification, and the production gate source never changed or ran.

## Final frozen tuple and identity

| Path | Bytes | SHA-256 | CRLF | Bare LF | Git-filtered working blob |
| --- | ---: | --- | ---: | ---: | --- |
| `Tools/wave-end-gate.spec.mjs` | 39,365 | `8B3A631D792EF2EBA3245691E6460F54B96A488F9FDA1430751B833EA839AEE9` | 1,244 | 0 | `4544db37820f75157b03f7548fb626aae1866706` |

The raw SHA-256 binds the Windows checkout bytes. The filtered Git blob binds the logical content after the repository's EOL filter. Opening and terminal hashes matched during the independent tester pass.

## Final validation

Idril independently validated the exact frozen tuple:

| Check | Exit / result |
| --- | --- |
| `node --check Tools/wave-end-gate.spec.mjs` | 0 |
| `node --test Tools/wave-end-gate.spec.mjs` | 0; 29/29 passed; zero fail/cancelled/skipped/todo; 363.476 ms |
| `.\\node_modules\\.bin\\eslint.cmd Tools/wave-end-gate.spec.mjs --no-cache --quiet` | 0 |
| `.\\node_modules\\.bin\\prettier.cmd --check Tools/wave-end-gate.spec.mjs` | 0 |
| `node Tools/c16/comment-marker-guard.mjs Tools/wave-end-gate.spec.mjs` | 0; Tools spec is outside the guard's engine/widget scope |
| `git diff --check -- Tools/wave-end-gate.spec.mjs` | 0 |
| Node survivor census for this spec/clone | 0 matching processes |

Independent tester verdict: **GO**. Idril re-read the logical diff and confirmed that the mutation is EOL-robust, exact-one-target, behaviorally bypasses the real shared pre-spawn predicate, retains the load-bearing executed mutant, and weakens or removes no test.

Pre-handoff terminal status contained exactly:

```text
 M Tools/wave-end-gate.spec.mjs
 M migration_doc/MAINTAINER_RULINGS_2026-08-17.md
 M migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md
```

The two migration-document modifications are the expected provisioner dirt. This handoff is the sole additional lead-authored path.

## Landing and clone protections

- Root must arrange the destination reviewer and perform every Git operation.
- Stage or transfer only `Tools/wave-end-gate.spec.mjs` plus this handoff if separately desired; never sweep the two provisioner-owned migration documents.
- Rehash the raw destination and filtered logical object after any EOL conversion or materialization. A changed logical blob requires fresh tests and review.
- This repair changes only the mutation harness. It does not certify Q-152, H1, H0, the landed gate, a served subject, a child contract, a wave, or evidence.
- The landed Q-152 safety boundary remains deliberately STRUCTURAL / exit 3 with zero real child spawns. No real gate or child was executed here.
- Do not assign a landing stamp, commit SHA, or push claim before root actually lands the reviewed destination.
- Do not reset, restore, clean, delete, reuse, or retire the clone until the handoff is repatriated, the destination review is complete, and root confirms no worker/reviewer processes remain.

## Negative-action and quiescence declaration

No worker performed a Git write, commit, stash, checkout, reset, clean, push, dependency install, build, browser, Playwright, server, network, evidence, deletion, product execution, or source/package/H1/H0 edit. Read-only Git commands were limited to branch/status, worktree, diff, diff-check, numstat, and filtered-object inspection.

Celebrimbor and Idril are complete. Terminal Node process census found zero process whose command line named this clone or `wave-end-gate.spec.mjs`. No worker-owned command, test, formatter, linter, gate, child, browser, server, publication, or external action remains.
