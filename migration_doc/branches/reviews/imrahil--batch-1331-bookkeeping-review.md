# Imrahil independent bookkeeping review — Batch 1331 final

**Reviewer:** Imrahil, existing independent reviewer identity
**Status:** COMPLETE
**Verdict:** UNCONDITIONAL GO FOR LOCAL BATCH 1331 ONLY
**Push authority:** None; local landing only

## Supersession

This report supersedes the earlier Imrahil bookkeeping review at this path.

The earlier report is non-authoritative for final closure because it reviewed the predecessor Faramir handoff at 5,504 bytes with SHA-256 `E5AE7D6E343B1CCD094F6653BF235C921C401F2C05C43EB4DA1FDA805ADAF9DF`.

This replacement reviews the current 6,082-byte handoff and the exact five-file tuple below. It intentionally contains no byte count or SHA-256 for itself. Such a self-reference would be circular and cannot be part of the reviewed tuple.

## Exact reviewed tuple

| Path | Bytes | SHA-256 |
| --- | ---: | --- |
| `Tools/verify-worker-handoff.mjs` | 11,179 | `2A3CA3C56E1E825298D5208DDFBE241B25F0A09E34B1AD64C230C74CFD6EDE2B` |
| `Tools/verify-worker-handoff.spec.mjs` | 7,447 | `05C9D3BC5473DA6E7C6C9EE7E2AA7B15E44E71F668238DC8036338F02E9E610D` |
| `package.json` | 10,629 | `C2575461545E96164CABDF8CEFF3BD87E79106733ADD6879316E8B49C44EFFFC` |
| `migration_doc/branches/faramir--handoff-verifier-explicit-lease.md` | 6,082 | `1F253A4530624477E79CCFA6822FD0708F031CF9A75517349DDE1762FEBD181F` |
| `migration_doc/branches/reviews/aragorn--handoff-verifier-review.md` | 3,911 | `5C72F8C7C9BD749DA1A7B1E12FBB9A0DEE28E1F43E25C1E0933E8BDFD5A67889` |

Opening and terminal byte counts and SHA-256 values matched for all five files. No tuple drift occurred.

## Scope and method

The review covered every current input completely:

- the complete tracked `HEAD`-to-working-tree diffs for `Tools/verify-worker-handoff.mjs`, `package.json`, and the Faramir handoff;
- all bytes of the new/untracked `Tools/verify-worker-handoff.spec.mjs` as added content;
- all bytes of the new/untracked Aragorn report as added content; and
- the complete current contents of all five paths.

Stable anchors reviewed included:

- `const authored = changed.filter((p) => !PROVISIONED.has(p) || inLease(p));`
- `test("a moved worker branch is a violation despite valid authored work", ...)`
- the `test-landing-rules` script in `package.json`;
- `## Validation authority correction` and `## Frozen tuple, review, and root validation` in the Faramir handoff; and
- `## Moved-HEAD negative control` and `## Quiescence and prohibited-action declaration` in Aragorn’s report.

This review makes no cleanliness or approval claim about unrelated checkout paths.

## Prior blockers and closure

### 1. Moved worker HEAD lacked a direct control — CLOSED

The eighth test creates a fixture-owned `worker` branch, commits `fixture-commit.txt`, records distinct `mainSha` and `headSha`, and separately leaves leased `Tools/ordinary.mjs` work dirty.

It invokes the real verifier with `--base main` and asserts:

- `headSha !== mainSha`;
- exit code 1;
- status `VIOLATIONS`;
- authored paths exactly `["Tools/ordinary.mjs"]`; and
- exactly one moved-branch violation containing the measured HEAD/main prefixes and complete no-worker-Git violation grammar.

The test is non-vacuous. Valid leased authored work remains present while branch movement independently stays red.

### 2. Literal source-review report and reviewer quiescence were missing — CLOSED

The current handoff names and hashes the literal report:

`migration_doc/branches/reviews/aragorn--handoff-verifier-review.md`

The report exists at 3,911 bytes with SHA-256:

`5C72F8C7C9BD749DA1A7B1E12FBB9A0DEE28E1F43E25C1E0933E8BDFD5A67889`

It binds the final three-file source tuple, records matching opening and terminal hashes, re-derives the moved-HEAD control, returns unconditional source GO, and states that Aragorn was quiescent with no live child process. Root banked the report without reviewer-authored file writes.

### 3. Push authority was unstated — CLOSED

The Faramir handoff states:

`Push authority: none; local landing only.`

Neither the handoff, Aragorn report, nor this review grants push, remote, publication, or other external authority.

## Source, specification, and runner findings

The production change is narrow and correct. It moves the existing segment-aware lease predicate before provisioned-path classification and treats a provisioned path as authored only when explicitly exact- or prefix-leased.

Unleased provisioned drift remains excluded. Authored ordinary paths continue through lease, conflict, header, comment-marker, and spec checks.

The eight-test specification covers:

- an exact lease over an untracked provisioned path;
- a directory lease over a tracked provisioned path;
- the explicit lease as a load-bearing control;
- suppression of unleased provisioned drift beside real leased work;
- established `READY_FOR_REVIEW` and “not CORRECT” vocabulary;
- rejection of unexpected ordinary outside-lease work;
- missing-lease structural exit 3; and
- moved worker HEAD remaining a violation despite valid leased authored work.

`package.json` adds the specification to the existing `test-landing-rules` runner home.

No source, specification, or runner-home finding remains.

## Handoff and authority findings

The current handoff accurately records its state as:

`FROZEN / SOURCE REVIEWED / FINAL BOOKKEEPING REVIEW OWED`

The writer is recorded as quiescent. The worker branch remains at the dispatch base. Clone reset, restore, retirement, deletion, and reuse remain prohibited until local landing is tracked and final quiescence is confirmed.

The line-ending/materialization account is coherent. Root identified matching filtered object identities with LF main materialization and CRLF provisioned-clone materialization, applied the reviewed semantic patch instead of copying raw files, and rehashed the LF destination tuple.

The worker authority incident remains visible:

- Samwise executed a temporary-Git-fixture test before the corrected authority boundary reached the lane;
- that worker-produced 7/7 result is not bankable;
- the interrupted broader run remains `ABORTED`, never green; and
- workers are now explicitly forbidden from executing Git-writing fixture tests.

Earlier exact tuples are not silently reused:

- the initial semantic tuple was invalidated when Prettier found the spec nonconforming;
- the formatted successor was later rejected because the moved-HEAD control, literal report, and push boundary were missing; and
- the final source tuple adds the moved-HEAD control and carries fresh exact-source review and root-authorized validation claims.

The handoff correctly marks the earlier Imrahil report as superseded advisory evidence because it reviewed the predecessor handoff. It states that the replacement report at this same path must bind the exact tuple it reviewed and deliberately avoids a self-hash.

No factual, provenance, lifecycle, or authority inconsistency remains within the reviewed handoff.

## Validation record

Root reported the following results against the final source and bookkeeping state:

- `node --check Tools/verify-worker-handoff.mjs`: exit 0;
- `node --check Tools/verify-worker-handoff.spec.mjs`: exit 0;
- focused verifier specification: 8/8 passed;
- `npm run test-landing-rules`: 179/179 passed;
- Prettier check: exit 0;
- `git diff --check`: exit 0;
- `verify-no-doc-shred`: exit 0, 203 files clean;
- Théoden positive integration: exit 0, `READY_FOR_REVIEW`; and
- temporary fixture cleanup: zero matching leftovers.

This review did not rerun those commands. It verified the exact current files, their recorded bindings, the substantive source and test behavior, and the consistency of the reported validation chronology.

`READY_FOR_REVIEW` remains mechanical readiness vocabulary. It is explicitly not correctness or certification.

## Verdict boundary

**UNCONDITIONAL GO FOR LOCAL BATCH 1331 ONLY** on the exact five-file tuple above.

This verdict does not certify product behavior, campaign completion, queue closure, or evidence sufficiency beyond this local source and bookkeeping scope.

It grants no push, remote, credential, network, evidence-publication, branch-change, name-allocation, reset, restore, retirement, deletion, reap, clone-reuse, or external-system authority.

Any later byte change invalidates this exact-tuple review and requires a new freeze and review.

## Reviewer quiescence and prohibited-action declaration

Imrahil’s terminal rehash matched the opening tuple. Imrahil is quiescent and has no live child process.

Existing Imrahil identity was reused. No new name or child was allocated.

The review used read-only file inspection, hashing, and path-limited read-only Git status/diff inspection solely to establish complete scope.

It performed no edits, Git writes, tests, builds, browser or server actions, network access, evidence publication, branch changes, name changes, credential actions, or external actions.

Imrahil did not create or edit this report file.
