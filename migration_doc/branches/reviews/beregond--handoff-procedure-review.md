# Beregond independent review — Théoden worker-handoff procedure correction

**Status:** COMPLETE

**Verdict:** UNCONDITIONAL GO FOR DOCUMENTATION LANDING ON THE EXACT FROZEN TUPLE

## Frozen subject

| Field | Opening measurement | Terminal measurement |
| --- | --- | --- |
| HEAD | `a64954b94507fa29762964f3d410517ddd765e9e` | identical |
| HEAD tree | `3247f590e9613b34320e6a9abbb676a132d00cd4` | identical |
| Porcelain | ` M migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md` | identical |
| Candidate bytes | 47,773 | 47,773 |
| Candidate SHA-256 | `ED02F2906D1FACA0C79311352DF7A1A2E7FB5CD31F5764D6B7D6560B85BF3F07` | identical |
| Numstat | `+40/-23` | identical |

No tuple drift occurred.

## Scope and exact audited fraction

The review read:

- the complete candidate file;
- the complete tracked `HEAD`-to-working-tree diff;
- all routed governance required for the review;
- the controlling `R-2026-08-18-28` ruling;
- the tracked Théoden lease and review history; and
- the tracked Faramir handoff, source-review, and bookkeeping records.

Exact candidate coverage was:

- **1/1 candidate path (100%)**;
- **686/686 current logical lines (100%)**; and
- **63/63 changed lines (100%): 40 additions and 23 deletions**.

This verdict is limited to the exact documentation tuple above. It does not certify unrelated repository state or grant landing, push, publication, cleanup, or external authority.

## Authority reconciliation

The candidate now consistently implements the root-only Git boundary established by `R-2026-08-18-28`:

- worker `HEAD` remains at the dispatch base;
- workers perform no commit, stash, checkout, restore, reset, merge, or rebase;
- authored leased paths remain dirty;
- handoff reports include verbatim `git status --porcelain -uall`;
- the orchestrator runs the handoff verifier with the explicit lease and base;
- the orchestrator reads and materializes the verified dirty authored tuple;
- review and clean-clone validation operate on that materialized tuple rather than an unchanged worker-branch diff;
- staged paths and bytes must equal the frozen reviewed tuple; and
- any authorized safety tag resolves to the orchestrator-authored landing commit.

Historical branch-commit and worker-rebase rationale remains visible but is explicitly marked superseded and cannot reasonably be read as current worker instruction.

## Prior finding carry-forward

The first 46,987-byte tuple at SHA-256 `99383D5D7FC59B8527A7CC7F644292742844BD80FA31EC9E0FE80918E83BCC28` remains immutable **NO-GO / SUPERSEDED** history. Its findings carry forward as follows:

| Prior finding | Current disposition |
| --- | --- |
| Operative worker rebase/merge instructions remained | **FIXED** — `4.6 marks the old rules historical and superseded; current worker rules prohibit merge/rebase and require unchanged `HEAD`. |
| Landing still depended on an unchanged worker-branch diff | **FIXED** — the procedure now verifies, reads, materializes, reviews, and stages the dirty authored tuple. |
| Merge/tag steps could not carry the dirty authored tuple | **FIXED** — landing materializes and stages the exact frozen tuple, and tagging targets the orchestrator-authored landing commit. |

The provisional 47,711-byte tuple at SHA-256 `5759DD7B24EF265F2E61292391C83F9A714B52086DE14400F692EC2B84319D27` is **SUPERSEDED** by the reviewed `ED02F2…` tuple and is not reused as approval evidence.

No prior finding remains OPEN, ACCEPTED-RISK, or NOT-RETESTED for the current candidate.

## Separate Faramir verifier dependency

The separate verifier repair is now frozen and independently source-reviewed. The normalized tracked dependency records read during this pass were:

- `migration_doc/branches/faramir--handoff-verifier-explicit-lease.md`: 6,082 bytes, SHA-256 `1F253A4530624477E79CCFA6822FD0708F031CF9A75517349DDE1762FEBD181F`;
- `migration_doc/branches/reviews/aragorn--handoff-verifier-review.md`: 3,911 bytes, SHA-256 `5C72F8C7C9BD749DA1A7B1E12FBB9A0DEE28E1F43E25C1E0933E8BDFD5A67889`.

Those records bind the repaired verifier source tuple, Aragorn’s unconditional source GO, and root-authorized validation of:

- focused verifier specification: **8/8 passed**;
- `test-landing-rules`: **179/179 passed**; and
- positive integration against this exact Théoden clone and lease: **exit 0, `READY_FOR_REVIEW`**, with the procedure path reported as authored.

The pre-repair exit-1 result with an empty authored set remains preserved history. `READY_FOR_REVIEW` is correctly treated as mechanical readiness, not certification. This review did not rerun any Faramir validation.

During the pass, root concurrently performed authorized Markdown whitespace normalization and exact hash-binding updates on the out-of-scope Faramir records. That activity did not touch the Théoden clone or candidate path and does not affect this verdict.

## Findings and verdict

No current candidate finding remains.

**UNCONDITIONAL GO FOR DOCUMENTATION LANDING** on the exact 47,773-byte `ED02F290…` tuple.

Any byte, HEAD, tree, porcelain, or numstat change invalidates this review and requires a new freeze and independent review. Root still owns durable report banking, final lane-wide quiescence confirmation, and any authorized landing action.

## Quiescence and prohibited-action declaration

The terminal rehash matched the opening tuple. Beregond is quiescent, started no background process, spawned no agent, and has no live child process.

This review performed no edits or report-file creation, Git writes, tests, builds, browser or server actions, network access, evidence publication, branch or name creation, credential action, cleanup, or external action. All repository and Git operations were read-only.

This whitespace-clean body is the authoritative bankable Beregond report.
